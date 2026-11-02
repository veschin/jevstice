/**
 * Autonomous supervisor (FR-57..FR-66).
 *
 * Starts or resumes one committed autonomous run and keeps the actual OMP RPC child alive. The
 * supervisor never manufactures owner turns: the child gets the checkout extension explicitly, a
 * private RPC stdin/stdout pair and the run locators in its environment. Consequential lifecycle
 * transitions after process loss are judged through the same TypeSafe adapter as normal Jev work.
 */
import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { memoizedApiKeyResolver } from "../src/apikey.js";
import {
	answerOf,
	createTypeSafeJudge,
	type Judge,
	type JudgeOutcome,
	type JudgeQuestion,
} from "../src/judge.js";
import {
	lifecycleIntentIsFenced,
	openAutonomyStore,
	processAlive,
	processIdentity,
	type AutonomyIntent,
	type AutonomyPolicy,
	type AutonomyRun,
	type AutonomyStatus,
	type AutonomyStore,
	type AutonomyWait,
	type ProcessIdentity,
} from "./store.js";
import {
	autonomyLaunchUnloaded,
	checkAutonomyScopeCapability,
	fenceAutonomyScope,
	makeAutonomyScopeLaunch,
	observeAutonomyScope,
	observeCommittedAutonomyScope,
	autonomyBootId,
	autonomyScopeCommand,
	autonomyScopeEmpty,
	type AutonomyScope,
	type AutonomyScopeFence,
	type AutonomyScopeLaunch,
} from "./scope.js";
import { asRecord, POLICY } from "../src/types.js";

const STORE_ENV = "JEVSTICE_AUTONOMY_STORE";
const RUN_ENV = "JEVSTICE_AUTONOMY_RUN";
const STORE_RELATIVE_PATH = [".omp", "agent", "jevstice", "autonomy.sqlite"] as const;
const READY_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 15_000;
const ABORT_TIMEOUT_MS = 1_000;
/** Bound on the actual bound-runtime bootstrap acknowledgment after bindSession. */
const STARTUP_ACK_TIMEOUT_MS = 15_000;
const STARTUP_ACK_POLL_MS = 100;
const SCOPE_OBSERVE_TIMEOUT_MS = 5_000;
const SCOPE_OBSERVE_POLL_MS = 50;
const MAX_RPC_LINE_CHARS = 16 * 1024 * 1024;
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
/** A fence receipt write can fail while the store is still settling; retry before fail-closed. */
const FENCE_RECEIPT_RETRY_ATTEMPTS = 3;
const FENCE_RECEIPT_RETRY_MS = 50;
/** A transient scope may release its cgroup while systemd still reports it loaded; bound the retry. */
const FENCE_PROOF_TIMEOUT_MS = 5_000;
const FENCE_PROOF_POLL_MS = 50;
/** Decoder shared by the complete selected bodies; the aggregate JSON still obeys owner policy. */
const exactUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** The typed choice the supervisor lifecycle decision uses. */
export const AUTONOMY_RECOVERY_QUESTION = "supervisor_recovery";

/** Injectable seams. Production uses the real judge, clock and timers; tests may observe them. */
export interface DriverDependencies {
	judge?: Judge;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
	signal?: AbortSignal;
	/** Test seam for the read-only scope capability probe; production uses the real helper. */
	scopeCapability?: () => Promise<void>;
	/** Test seam for the bounded runtime bootstrap acknowledgment deadline. */
	startupAckTimeoutMs?: number;
	/**
	 * Deterministic interleavings for lifecycle safety regressions. Production leaves these unset;
	 * they never change a decision, they only run between an observation and its authoritative read.
	 */
	lifecycleRace?: {
		afterLaunchSpawned?: () => void | Promise<void>;
		afterChildExit?: () => void | Promise<void>;
		beforeRecoverRead?: () => void | Promise<void>;
	};
}

/** Files the start command reads before creating a run. */
export interface StartAutonomyOptions {
	store?: string;
	objectiveFile: string;
	policyFile: string;
	omp?: string;
	model?: string;
}

/** Options for attaching a supervisor to an existing committed run. */
export interface ResumeAutonomyOptions {
	store?: string;
	run: string;
	omp?: string;
	model?: string;
}

/** One status projection; the stored checkpoint and objective are not printed. */
export interface AutonomySummary {
	id: string;
	status: AutonomyStatus;
	objectiveChars: number;
	roots: string[];
	effects: string[];
	epoch: number;
	generation: number;
	createdAt: number;
	updatedAt: number;
	sequence: number;
	judgeCalls: number;
	executorCalls: number;
	childPid?: number;
	childGroup?: number;
	childAlive?: boolean | "unknown";
	sessionId?: string;
	sessionFile?: string;
	pending: string[];
	waiting?: AutonomyWait;
	scopeUnit?: string;
	scopeBootId?: string;
	fences: number;
}

/** What the CLI reports after one supervisor or control command. */
export interface DriverResult {
	runId: string;
	status: AutonomyStatus;
	exitCode: number;
	message?: string;
	durableCancellation?: boolean;
}

interface CliArguments {
	command: "start" | "resume" | "status" | "stop";
	store?: string;
	run?: string;
	objective?: string;
	policy?: string;
	omp?: string;
	model?: string;
	reason?: string;
	help: boolean;
}

interface ChildTarget {
	executable: string;
	entry: string;
	args: string[];
	cwd: string;
	model?: string;
}

interface RpcChannel {
	send(command: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
	waitReady(timeoutMs?: number): Promise<{
		protocolVersion: number;
		supportedProtocolVersions: number[];
		maxFrameBytes: number;
	}>;
	close(reason: Error): void;
}

interface ActiveChild {
	identity: ProcessIdentity;
	channel: RpcChannel;
	exit: Promise<number>;
}

interface RpcWriter {
	write(data: string): unknown;
	flush(): unknown;
	end(): unknown;
}

/** Accept only the actual writable pipe Bun returns for `stdin: "pipe"`; fail closed otherwise. */
function writablePipe(value: unknown): RpcWriter {
	if (value === null || typeof value !== "object") throw new Error("the child stdin is not a writable pipe");
	const write = "write" in value ? value.write : undefined;
	const flush = "flush" in value ? value.flush : undefined;
	const end = "end" in value ? value.end : undefined;
	if (typeof write !== "function") throw new Error("the child stdin has no write method");
	if (typeof flush !== "function") throw new Error("the child stdin has no flush method");
	if (typeof end !== "function") throw new Error("the child stdin has no end method");
	return {
		write: data => write.call(value, data),
		flush: () => flush.call(value),
		end: () => end.call(value),
	};
}

function readablePipe(value: unknown): ReadableStream<Uint8Array> {
	if (!(value instanceof ReadableStream)) throw new Error("the child stdout/stderr is not a readable pipe");
	return value;
}

type LaunchResult =
	| { ok: true; run: AutonomyRun; child: ActiveChild }
	| { ok: false; run: AutonomyRun; error: string };

type RecoveryResult =
	| { kind: "launched"; run: AutonomyRun; child: ActiveChild }
	| { kind: "terminal"; run: AutonomyRun }
	| { kind: "stopped"; run: AutonomyRun }
	| { kind: "lost"; run: AutonomyRun }
	| { kind: "wait"; run: AutonomyRun; attempts: number; retryAt: number }
	| { kind: "blocked"; run: AutonomyRun; reason: string };

interface SupervisorConfig {
	storePath: string;
	now: () => number;
	sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
	judge: Judge;
	startupAckTimeoutMs: number;
	lifecycleRace?: DriverDependencies["lifecycleRace"];
}

/** The dedicated user-local store path from the deployment design. */
export function defaultAutonomyStorePath(): string {
	return join(homedir(), ...STORE_RELATIVE_PATH);
}


function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	const code = asRecord(error)?.["code"];
	return typeof code === "string" ? code : undefined;
}

function canonicalDirectory(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must contain a non-empty canonical directory path`);
	}
	let canonical: string;
	try {
		canonical = realpathSync(value);
	} catch {
		throw new Error(`${field} contains a path that does not exist: ${value}`);
	}
	let stat: Stats;
	try {
		stat = statSync(canonical);
	} catch {
		throw new Error(`${field} contains an unreadable path: ${value}`);
	}
	if (!stat.isDirectory()) throw new Error(`${field} contains a path that is not a directory: ${value}`);
	return canonical;
}

/** Validate the owner's explicit initial policy; the store performs the final reservation checks. */
export function parseAutonomyPolicy(value: unknown): AutonomyPolicy {
	const policy = asRecord(value);
	if (policy === undefined) throw new Error("the policy must be a JSON object");
	const rootsValue = policy["roots"];
	if (!Array.isArray(rootsValue) || rootsValue.length === 0) {
		throw new Error("policy.roots must contain at least one directory");
	}
	const roots = rootsValue.map((root, index) => canonicalDirectory(root, `policy.roots[${index}]`));
	if (new Set(roots).size !== roots.length) throw new Error("policy.roots must be unique after canonicalization");

	const effectsValue = policy["effects"];
	if (!Array.isArray(effectsValue) || effectsValue.length === 0) {
		throw new Error("policy.effects must list at least one authorized effect");
	}
	const effects = effectsValue.map((effect, index) => {
		if (effect === "project" || effect === "publication") return effect;
		throw new Error(`policy.effects[${index}] must be 'project' or 'publication'`);
	});
	if (new Set(effects).size !== effects.length) throw new Error("policy.effects must not repeat an effect");

	const integer = (name: keyof AutonomyPolicy): number => {
		const raw = policy[name];
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
			throw new Error(`policy.${name} must be a positive finite integer`);
		}
		return raw;
	};
	return {
		roots,
		effects,
		maxJudgeCalls: integer("maxJudgeCalls"),
		maxExecutorCalls: integer("maxExecutorCalls"),
		maxRuntimeMs: integer("maxRuntimeMs"),
		maxContextBytes: integer("maxContextBytes"),
		maxArtifactBytes: integer("maxArtifactBytes"),
	};
}

/** Read the immutable objective before opening the store. */
export function readObjectiveFile(file: string, maxBytes: number): string {
	const objective = readFileSync(file, "utf8");
	if (objective.trim().length === 0) throw new Error("the objective file is empty");
	const bytes = Buffer.byteLength(objective, "utf8");
	if (bytes > maxBytes) throw new Error(`the objective is ${bytes} bytes; the policy allows ${maxBytes}`);
	return objective;
}

function readPolicyFile(file: string): AutonomyPolicy {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`the policy file is not valid JSON: ${messageOf(error)}`);
	}
	return parseAutonomyPolicy(parsed);
}

function requireLinuxProcessModel(): void {
	if (process.platform !== "linux") {
		throw new Error("autonomous supervision requires Linux /proc identity and detached process groups");
	}
}

/** Validate and build the only process the supervisor may launch. */
function childTarget(policy: AutonomyPolicy, omp: string | undefined, model: string | undefined): ChildTarget {
	const cwd = policy.roots[0];
	if (cwd === undefined) throw new Error("the policy has no authorized project root");
	const checkout = resolve(import.meta.dir, "..");
	const entry = realpathSync(join(checkout, "autonomy", "index.ts"));
	if (!statSync(entry).isFile()) throw new Error(`the checkout entry is not a file: ${entry}`);
	const executable = omp?.trim() ?? "";
	const command = executable.length > 0 ? executable : "omp";
	const args = [command, "--mode", "rpc", "--no-extensions", "-e", entry];
	const nativeModel = model?.trim();
	if (nativeModel !== undefined && nativeModel.length > 0) args.push("--model", nativeModel);
	return {
		executable: command,
		entry,
		args,
		cwd,
		...(nativeModel !== undefined && nativeModel.length > 0 ? { model: nativeModel } : {}),
	};
}

/**
 * A unique run-private native session directory, chosen before the lifecycle judgment. The exact
 * path enters the judged argv and the actual spawn leaves it unchanged; it is never a global
 * setting or profile mutation. The unit's random segment makes each launch candidate unique.
 */
function launchSessionDirectory(storePath: string, runId: string, launch: AutonomyScopeLaunch): string {
	const directory = join(dirname(storePath), "autonomy-sessions", runId, launch.unit.replace(/\.scope$/, ""));
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return directory;
}

function stopReason(signal: AbortSignal): string {
	const reason = signal.reason;
	if (typeof reason === "string" && reason.length > 0) return reason;
	if (reason instanceof Error && reason.message.length > 0) return reason.message;
	return "operator stop";
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
	if (ms <= 0) return Promise.resolve(!signal.aborted);
	if (signal.aborted) return Promise.resolve(false);
	return new Promise<boolean>(resolveDelay => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolveDelay(true);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolveDelay(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | "stopped"> {
	if (signal.aborted) return "stopped";
	let onAbort: (() => void) | undefined;
	const stopped = new Promise<"stopped">(resolveStopped => {
		const handler = (): void => resolveStopped("stopped");
		onAbort = handler;
		signal.addEventListener("abort", handler, { once: true });
	});
	try {
		return await Promise.race([promise, stopped]);
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

function backoffMs(attempts: number): number {
	const exponent = Math.max(0, Math.min(12, attempts - 1));
	return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** exponent);
}

function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function newIntent(
	kind: AutonomyIntent["kind"],
	payload: unknown,
	revision: number,
	taskFingerprint: string | undefined,
	now: number,
): AutonomyIntent {
	return {
		id: crypto.randomUUID(),
		kind,
		payload,
		revision,
		createdAt: now,
		...(taskFingerprint === undefined ? {} : { taskFingerprint }),
	};
}

function updateRun(
	store: AutonomyStore,
	run: AutonomyRun,
	mutator: (current: AutonomyRun) => void,
	events: Array<{ kind: string; data: unknown }>,
): AutonomyRun {
	return store.update(run.id, { epoch: run.epoch }, mutator, events);
}

function isTerminal(status: AutonomyStatus): boolean {
	return status === "completed" || status === "cancelled" || status === "infeasible";
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return left.pid === right.pid && left.start === right.start && left.bootId === right.bootId;
}

/** A process identity is only signallable when the recorded kernel boot is the current one. */
function currentBoot(identity: ProcessIdentity): boolean {
	try {
		return identity.bootId === autonomyBootId();
	} catch {
		return false;
	}
}

function processState(identity: ProcessIdentity): boolean | "unknown" {
	try {
		return processAlive(identity);
	} catch {
		return "unknown";
	}
}

function summaryOf(run: AutonomyRun): AutonomySummary {
	const childAlive = run.child === undefined ? undefined : processState(run.child);
	return {
		id: run.id,
		status: run.status,
		objectiveChars: run.objective.length,
		roots: [...run.policy.roots],
		effects: [...run.policy.effects],
		epoch: run.epoch,
		generation: run.generation,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		sequence: run.sequence,
		judgeCalls: run.judgeCalls,
		executorCalls: run.executorCalls,
		...(run.child === undefined ? {} : { childPid: run.child.pid, childGroup: run.child.group }),
		...(childAlive === undefined ? {} : { childAlive }),
		...(run.session === undefined ? {} : { sessionId: run.session.id, sessionFile: run.session.file }),
		...(run.scope === undefined ? {} : { scopeUnit: run.scope.unit, scopeBootId: run.scope.bootId }),
		fences: run.fences.length,
		pending: Object.keys(run.pending),
		...(run.waiting === undefined ? {} : { waiting: { ...run.waiting } }),
	};
}

/**
 * Newline-delimited RPC channel. Protocol v1 is not negotiated, so every logical frame is one line;
 * a malformed line, an oversized line or stdout closure fails all outstanding commands.
 */
function createRpcChannel(stdout: ReadableStream<Uint8Array>, stdin: RpcWriter): RpcChannel {
	const pending = new Map<
		string,
		{ resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	let nextId = 0;
	let closed = false;
	let closeError: Error | undefined;
	let resolveReady:
		| ((data: { protocolVersion: number; supportedProtocolVersions: number[]; maxFrameBytes: number }) => void)
		| undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	const ready = new Promise<{ protocolVersion: number; supportedProtocolVersions: number[]; maxFrameBytes: number }>(
		(resolvePromise, rejectPromise) => {
			resolveReady = resolvePromise;
			rejectReady = rejectPromise;
		},
	);
	const chunks = new Map<
		string,
		{ count: number; byteLength: number; next: number; parts: Buffer[]; received: number }
	>();

	const close = (reason: Error): void => {
		if (closed) return;
		closed = true;
		closeError = reason;
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.reject(reason);
		}
		pending.clear();
		chunks.clear();
		rejectReady?.(reason);
		try {
			stdin.end();
		} catch {
			// The child may already have closed its input.
		}
	};

	const handleFrame = (frame: Record<string, unknown>): void => {
		if (frame["type"] === "ready") {
			const protocolVersion = frame["protocolVersion"];
			const maxFrameBytes = frame["maxFrameBytes"];
			const supportedValue = frame["supportedProtocolVersions"];
			const supportedProtocolVersions = Array.isArray(supportedValue)
				? supportedValue.filter((value): value is number => typeof value === "number")
				: [];
			if (typeof protocolVersion !== "number" || typeof maxFrameBytes !== "number") {
				close(new Error("RPC ready frame is malformed"));
				return;
			}
			resolveReady?.({ protocolVersion, supportedProtocolVersions, maxFrameBytes });
			resolveReady = undefined;
			rejectReady = undefined;
			return;
		}
		if (frame["type"] === "response" && typeof frame["id"] === "string") {
			const item = pending.get(frame["id"]);
			if (item !== undefined) {
				pending.delete(frame["id"]);
				clearTimeout(item.timer);
				if (frame["success"] === true) {
					item.resolve(frame);
				} else {
					const command = typeof frame["command"] === "string" ? frame["command"] : "unknown";
					const code = typeof frame["code"] === "string" ? ` (${frame["code"]})` : "";
					item.reject(new Error(`RPC ${command} failed${code}`));
				}
				return;
			}
		}
	};

	const handleLogical = (frame: Record<string, unknown>): void => {
		if (frame["type"] !== "rpc_chunk") {
			handleFrame(frame);
			return;
		}
		const chunkId = frame["chunkId"];
		const index = frame["index"];
		const count = frame["count"];
		const byteLength = frame["byteLength"];
		const data = frame["data"];
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			typeof index !== "number" ||
			!Number.isSafeInteger(index) ||
			typeof count !== "number" ||
			!Number.isSafeInteger(count) ||
			count <= 0 ||
			count > 1_024 ||
			index < 0 ||
			index >= count ||
			typeof byteLength !== "number" ||
			!Number.isSafeInteger(byteLength) ||
			byteLength <= 0 ||
			byteLength > MAX_REASSEMBLED_FRAME_BYTES ||
			typeof data !== "string"
		) {
			close(new Error("RPC chunk frame is malformed"));
			return;
		}
		let entry = chunks.get(chunkId);
		if (entry === undefined) {
			if (index !== 0 || chunks.size >= 8) {
				close(new Error("RPC chunk stream is out of order or over the reassembly bound"));
				return;
			}
			entry = { count, byteLength, next: 0, parts: [], received: 0 };
			chunks.set(chunkId, entry);
		}
		if (entry === undefined) {
			close(new Error("RPC chunk stream could not be allocated"));
			return;
		}
		if (entry.count !== count || entry.byteLength !== byteLength || entry.next !== index) {
			close(new Error("RPC chunk stream is inconsistent"));
			return;
		}
		let part: Buffer;
		try {
			part = Buffer.from(data, "base64");
		} catch {
			close(new Error("RPC chunk payload is not base64"));
			return;
		}
		entry.received += part.length;
		if (entry.received > entry.byteLength) {
			close(new Error("RPC chunk stream exceeds its declared byte length"));
			return;
		}
		entry.parts.push(part);
		entry.next += 1;
		if (entry.next !== entry.count) return;
		chunks.delete(chunkId);
		if (entry.received !== entry.byteLength) {
			close(new Error("RPC chunk stream ended short of its declared byte length"));
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.concat(entry.parts).toString("utf8"));
		} catch {
			close(new Error("the reassembled RPC frame is not JSON"));
			return;
		}
		const reassembled = asRecord(parsed);
		if (reassembled === undefined) {
			close(new Error("the reassembled RPC frame is not an object"));
			return;
		}
		handleFrame(reassembled);
	};

	const readLoop = async (): Promise<void> => {
		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (!closed) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					let line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.endsWith("\r")) line = line.slice(0, -1);
					if (line.trim().length > 0) {
						if (line.length > MAX_RPC_LINE_CHARS) {
							close(new Error("RPC frame exceeded the supervisor limit"));
							return;
						}
						let parsed: unknown;
						try {
							parsed = JSON.parse(line);
						} catch {
							close(new Error("RPC stdout carried a malformed JSON frame"));
							return;
						}
						const frame = asRecord(parsed);
						if (frame === undefined) {
							close(new Error("RPC stdout carried a non-object frame"));
							return;
						}
						handleLogical(frame);
					}
					newline = buffer.indexOf("\n");
				}
				if (buffer.length > MAX_RPC_LINE_CHARS) {
					close(new Error("RPC frame exceeded the supervisor limit"));
					return;
				}
			}
			close(new Error("RPC stdout closed"));
		} catch (error) {
			close(new Error(`RPC stdout failed: ${messageOf(error)}`));
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// Already released.
			}
		}
	};
	void readLoop();

	const send = async (command: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<Record<string, unknown>> => {
		if (closed) throw closeError ?? new Error("RPC channel is closed");
		const id = `driver-${++nextId}`;
		const frame = `${JSON.stringify({ ...command, id })}\n`;
		const result = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				rejectPromise(new Error(`RPC ${String(command["type"])} timed out`));
			}, timeoutMs);
			pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
		});
		try {
			stdin.write(frame);
			await stdin.flush();
		} catch (error) {
			const item = pending.get(id);
			if (item !== undefined) {
				clearTimeout(item.timer);
				pending.delete(id);
				item.reject(new Error(`RPC write failed: ${messageOf(error)}`));
			}
		}
		return result;
	};

	return {
		send,
		waitReady: timeoutMs => {
			const timer = setTimeout(() => {
				rejectReady?.(new Error("RPC ready frame timed out"));
				rejectReady = undefined;
				resolveReady = undefined;
			}, timeoutMs);
			return ready.finally(() => clearTimeout(timer));
		},
		close,
	};
}

/** Discard diagnostic output; it is never printed or interpreted as control text. */
async function drainStream(stream: ReadableStream<Uint8Array> | undefined): Promise<void> {
	if (stream === undefined) return;
	const reader = stream.getReader();
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) return;
		}
	} catch {
		// The pipe closed with the child.
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Already released.
		}
	}
}

function signalVerifiedProcess(identity: ProcessIdentity, signal: NodeJS.Signals): boolean {
	if (!currentBoot(identity)) {
		throw new Error("the recorded process belongs to a different kernel boot; refusing to signal a reused pid");
	}
	const observed = processIdentity(identity.pid);
	if (observed === null) return false;
	if (observed.start !== identity.start || observed.bootId !== identity.bootId) {
		throw new Error("the recorded process identity no longer matches its live process");
	}
	try {
		process.kill(identity.pid, signal);
		return true;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return false;
		throw error;
	}
}

interface FenceOutcome {
	run: AutonomyRun;
	scope?: AutonomyScope;
	intentIds: string[];
	observedAt: number;
	recorded: boolean;
}

interface FenceProof {
	scope: AutonomyScope;
	observedAt: number;
	method: "systemd-scope";
	empty: true;
}

interface FenceCandidate {
	scope: AutonomyScope;
	intentIds: string[];
	child?: ProcessIdentity;
	recorded: boolean;
}

function sameScopeIdentity(left: AutonomyScope, right: AutonomyScope): boolean {
	return left.unit === right.unit && left.invocationId === right.invocationId && left.controlGroup === right.controlGroup;
}

/**
 * The same native process after a crash may have been reparented. Start time, process group and
 * kernel boot are the stable identity; the mutable parent id is not part of the fencing proof.
 */
function refreshedChildIdentity(recorded: ProcessIdentity): ProcessIdentity | undefined {
	const live = processIdentity(recorded.pid);
	if (live === null) return undefined;
	if (live.start !== recorded.start || live.group !== recorded.group || live.bootId !== recorded.bootId) return undefined;
	return live;
}

function launchMatchesScope(launch: AutonomyScopeLaunch, scope: AutonomyScope): boolean {
	return (
		launch.runId === scope.runId &&
		launch.epoch === scope.epoch &&
		launch.unit === scope.unit &&
		launch.bootId === scope.bootId
	);
}

/**
 * Positive, bounded quiescence proof. A transient scope may already have released its cgroup while
 * systemd still reports the unit loaded; that state is neither empty nor a hard failure. Retry the
 * fence until the unit is positively gone or the bound expires. An empty scope is only containment
 * evidence; it never proves that an effect succeeded.
 */
async function proveScopeEmptyBounded(scope: AutonomyScope): Promise<FenceProof> {
	const deadline = Date.now() + FENCE_PROOF_TIMEOUT_MS;
	while (true) {
		try {
			if (autonomyScopeEmpty(scope)) {
				await Bun.sleep(FENCE_PROOF_POLL_MS);
				if (autonomyScopeEmpty(scope)) {
					return { scope, observedAt: Date.now(), method: "systemd-scope", empty: true };
				}
			}
			return await fenceAutonomyScope(scope);
		} catch (error) {
			const reason = messageOf(error);
			const transient = reason.includes("no control group while its unit is") || reason.includes("ENOENT");
			if (!transient || Date.now() >= deadline) throw error;
		}
		await Bun.sleep(Math.min(FENCE_PROOF_POLL_MS, Math.max(1, deadline - Date.now())));
	}
}

async function recordFencedScope(store: AutonomyStore, run: AutonomyRun, scope: AutonomyScope): Promise<AutonomyRun> {
	let lastError: unknown;
	for (let attempt = 0; attempt < FENCE_RECEIPT_RETRY_ATTEMPTS; attempt += 1) {
		try {
			return store.recordFence(run.id, run.epoch, scope);
		} catch (error) {
			lastError = error;
			if (attempt + 1 < FENCE_RECEIPT_RETRY_ATTEMPTS) {
				// Wait for the store to settle instead of reporting quiescence without a receipt.
				await Bun.sleep(FENCE_RECEIPT_RETRY_MS);
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error("the scope fence receipt was not committed");
}

/**
 * Record a durable launch-quiescence receipt when the launch never yielded an observed scope. Only
 * two actual adapter facts qualify: the unit is positively absent in this boot, or the launch
 * belongs to a previous kernel boot. The second is a local-only boot difference: it says the old
 * boot's local effects cannot execute here; it never claims a remote or migrated effect was fenced.
 * A loaded committed unit is not quiescent and must be fenced by its exact observed scope instead.
 */
function recordLaunchQuiescence(
	store: AutonomyStore,
	run: AutonomyRun,
	entry: { id: string; launch?: AutonomyScopeLaunch; child?: ProcessIdentity },
): { run: AutonomyRun; method: "unit-unloaded" | "boot-difference" } | undefined {
	const launch = entry.launch;
	if (launch === undefined) return undefined;
	if (launch.bootId !== autonomyBootId()) {
		return { run: store.recordLaunchFence(run.id, run.epoch, launch, "boot-difference"), method: "boot-difference" };
	}
	if (autonomyLaunchUnloaded(launch)) {
		return { run: store.recordLaunchFence(run.id, run.epoch, launch, "unit-unloaded"), method: "unit-unloaded" };
	}
	return undefined;
}

/**
 * Positively fence every distinct recorded launch scope, then record one receipt per scope. The
 * bound scope and every lifecycle launch are separate containment candidates: an older
 * bound-but-empty scope never covers a newer pre-bind launch. A launch whose recorded leader is
 * gone is fenced through its committed unit; a launch whose unit is positively absent (or from a
 * previous boot) gets the distinct durable launch-quiescence receipt. Any unobservable candidate
 * keeps its intent pending and its roots reserved; no receipt is fabricated from emptiness alone.
 */
async function fenceRunScope(
	store: AutonomyStore,
	run: AutonomyRun,
	options: { terminal: boolean; capability: () => Promise<void>; now: number; requireReceipt?: boolean },
): Promise<FenceOutcome> {
	await options.capability();
	let current = run;
	const candidates: FenceCandidate[] = [];
	const launchProofs: Array<{ id: string; method: "unit-unloaded" | "boot-difference"; child?: ProcessIdentity }> = [];
	const failures: string[] = [];
	const addCandidate = (scope: AutonomyScope, intentIds: string[], child?: ProcessIdentity): void => {
		const existing = candidates.find(candidate => sameScopeIdentity(candidate.scope, scope));
		if (existing !== undefined) {
			for (const intentId of intentIds) if (!existing.intentIds.includes(intentId)) existing.intentIds.push(intentId);
			if (existing.child === undefined && child !== undefined) existing.child = child;
			return;
		}
		candidates.push({ scope, intentIds: [...new Set(intentIds)], ...(child === undefined ? {} : { child }), recorded: false });
	};
	if (run.scope !== undefined) {
		const boundScope = run.scope;
		const boundIntents = Object.entries(run.pending).flatMap(([intentId, intent]) => {
			if (intent.kind !== "lifecycle") return [intentId];
			const launch = scopeLaunchValue(asRecord(intent.payload)?.["launch"]);
			return launch !== undefined && launchMatchesScope(launch, boundScope) ? [intentId] : [];
		});
		addCandidate(boundScope, boundIntents, run.child);
	}
	for (const entry of lifecycleLaunches(run)) {
		if (entry.launch === undefined) {
			failures.push(`launch ${entry.id} has no recorded launch identity; its scope stays unproven`);
			continue;
		}
		const precommitted = candidates.find(
			candidate => candidate.scope.unit === entry.launch?.unit && candidate.scope.bootId === entry.launch?.bootId,
		);
		if (precommitted !== undefined) {
			addCandidate(precommitted.scope, [entry.id], entry.child);
			continue;
		}
		const observedIdentity = entry.child === undefined ? undefined : refreshedChildIdentity(entry.child);
		if (observedIdentity !== undefined && entry.child !== undefined) {
			try {
				const observed = await observeAutonomyScope(entry.launch, observedIdentity);
				addCandidate(observed, [entry.id], entry.child);
			} catch (error) {
				failures.push(`launch ${entry.id} could not be observed for fencing: ${messageOf(error)}`);
			}
			continue;
		}
		// The recorded leader is gone, or no child identity was ever recorded. The committed unit is
		// still the exact container: fence it when loaded, otherwise record the distinct proof.
		try {
			const recordedRun = recordLaunchQuiescence(store, current, entry);
			if (recordedRun !== undefined) {
				current = recordedRun.run;
				launchProofs.push({
					id: entry.id,
					method: recordedRun.method,
					...(entry.child === undefined ? {} : { child: entry.child }),
				});
				continue;
			}
			const observed = await observeCommittedAutonomyScope(entry.launch);
			addCandidate(observed, [entry.id], entry.child);
		} catch (error) {
			failures.push(
				`launch ${entry.id} could not be observed or proved quiet by its committed unit: ${messageOf(error)}`,
			);
		}
	}
	if (candidates.length === 0 && launchProofs.length === 0) {
		throw new Error(
			failures.length > 0
				? failures.join("; ")
				: "no observed scope or launch identity exists; the pre-bind launch stays a durable unknown wait",
		);
	}
	const proofs: FenceProof[] = [];
	for (const candidate of candidates) {
		if (!options.terminal && (current.scope === undefined || !sameScopeIdentity(current.scope, candidate.scope))) {
			// A nonterminal receipt must match the currently bound scope. Bind the observed candidate
			// while its cgroup identity is still present; the previous candidate is already fenced.
			try {
				current = store.bindScope(current.id, current.epoch, candidate.scope);
			} catch (error) {
				failures.push(`scope ${candidate.scope.unit} could not be bound before fencing: ${messageOf(error)}`);
			}
		}
		let proof: FenceProof;
		try {
			proof = await proveScopeEmptyBounded(candidate.scope);
			proofs.push(proof);
		} catch (error) {
			failures.push(`scope ${candidate.scope.unit}: ${messageOf(error)}`);
			continue;
		}
		try {
			current = await recordFencedScope(store, current, proof.scope);
			candidate.recorded = true;
		} catch (error) {
			failures.push(`scope ${proof.scope.unit} was fenced but its receipt was not committed: ${messageOf(error)}`);
		}
	}
	if (!options.terminal) {
		for (const candidate of candidates) {
			const childIdentity = candidate.child;
			if (!candidate.recorded || childIdentity === undefined) continue;
			let alive = true;
			try {
				alive = processAlive(childIdentity);
			} catch {
				alive = true;
			}
			if (alive) continue;
			// Only the child whose own scope was positively fenced is resolved. Tool intents and
			// effects remain unknown; this event claims containment, never effect success.
			current = resolveLifecycleSpawns(store, current, [childIdentity], ["systemd-scope"], options.now);
		}
		for (const proof of launchProofs) {
			if (proof.child === undefined) continue;
			const quiescence =
				proof.method === "boot-difference"
					? "launch belongs to a previous kernel boot; local effects are dead and no remote effect is claimed"
					: "launch producer never started and its unit is positively absent";
			try {
				current = resolveLifecycleSpawns(
					store,
					current,
					[proof.child],
					[`launch-${proof.method}`],
					options.now,
					quiescence,
				);
			} catch {
				// The durable launch receipt stands; deleting the intent is a projection.
			}
		}
	}
	const recorded = candidates.every(candidate => candidate.recorded) && failures.length === 0;
	if (!recorded && options.requireReceipt === true) {
		throw new Error(failures.join("; ") || "a scope fence receipt was not committed");
	}
	if (!options.terminal) {
		for (const proof of proofs) {
			try {
				const candidate = candidates.find(item => sameScopeIdentity(item.scope, proof.scope));
				current = updateRun(store, current, () => {}, [
					{
						kind: "driver.fence",
						data: {
							scope: proof.scope,
							bootId: proof.scope.bootId,
							epoch: current.epoch,
							generation: current.generation,
							intentIds: candidate?.intentIds ?? [],
							observedAt: proof.observedAt,
							method: proof.method,
							empty: proof.empty,
							aliveAfter: false,
							signals: ["systemd-scope"],
							...(current.child === undefined ? {} : { pid: current.child.pid, group: current.child.group }),
							at: options.now,
						},
					},
				]);
			} catch {
				// The physical fence and durable receipt stand; the projection event is best-effort.
			}
		}
	}
	const firstProof = proofs[0];
	const firstScope = firstProof?.scope ?? candidates[0]?.scope ?? run.scope;
	const intentIds = [...new Set([...candidates.flatMap(candidate => candidate.intentIds), ...launchProofs.map(proof => proof.id)])];
	return {
		run: current,
		...(firstScope === undefined ? {} : { scope: firstScope }),
		intentIds,
		observedAt: firstProof?.observedAt ?? Date.now(),
		recorded,
	};
}

/**
 * The shared terminal invariant: a terminal status is not containment proof. Every supervisor exit
 * reached from a terminal re-read fences all recorded candidates and requires the receipt.
 */
async function fenceTerminalRun(
	store: AutonomyStore,
	run: AutonomyRun,
	capability: () => Promise<void>,
	now: number,
): Promise<{ run: AutonomyRun; error?: string }> {
	if (run.scope === undefined && lifecycleLaunches(run).length === 0) return { run };
	try {
		const fenced = await fenceRunScope(store, run, { terminal: true, capability, now, requireReceipt: true });
		return { run: fenced.run };
	} catch (error) {
		return { run, error: messageOf(error) };
	}
}

/**
 * Stop the child this supervisor owns through its whole scope. The direct process signal is only a
 * best-effort leader stop when the scope fence itself is unavailable; it never replaces containment.
 */
async function stopActiveChild(
	store: AutonomyStore,
	run: AutonomyRun,
	child: ActiveChild,
	capability: () => Promise<void>,
	now: number,
): Promise<{ quiet: boolean; run: AutonomyRun; error?: string }> {
	void child.channel.send({ type: "abort" }, ABORT_TIMEOUT_MS).catch(() => {
		// The abort request is best-effort; the safety stop must not wait for the child or Jev.
	});
	let quiet = false;
	let current = run;
	let error: string | undefined;
	try {
		const fenced = await fenceRunScope(store, run, { terminal: isTerminal(run.status), capability, now });
		current = fenced.run;
		// Physical quiescence without a durable receipt is not a proven stop: report it as not quiet.
		quiet = fenced.recorded;
		if (!fenced.recorded) error = "the scope fence receipt was not committed";
	} catch (fenceError) {
		error = messageOf(fenceError);
		try {
			signalVerifiedProcess(child.identity, "SIGTERM");
			signalVerifiedProcess(child.identity, "SIGKILL");
		} catch (signalError) {
			error = `${error}; the direct child could not be stopped: ${messageOf(signalError)}`;
		}
	}
	child.channel.close(new Error("supervisor stopped the child"));
	try {
		await child.exit;
	} catch {
		// The exit code is observed by the caller when available.
	}
	return { quiet, run: current, ...(error === undefined ? {} : { error }) };
}

function runtimeBudgetExhausted(run: AutonomyRun, now: number): boolean {
	return now >= run.createdAt + run.policy.maxRuntimeMs;
}

function markWaiting(
	store: AutonomyStore,
	run: AutonomyRun,
	kind: string,
	reason: string,
	attempts: number,
	retryAt: number | undefined,
	now: number,
): AutonomyRun {
	const waiting: AutonomyWait = {
		kind,
		reason,
		attempts,
		...(retryAt === undefined ? {} : { retryAt }),
	};
	return updateRun(
		store,
		run,
		current => {
			current.status = "waiting";
			current.waiting = waiting;
			delete current.wake;
		},
		[
			{
				kind: "driver.wait",
				data: {
					kind,
					reason,
					attempts,
					...(retryAt === undefined ? {} : { retryAt }),
					at: now,
				},
			},
		],
	);
}

interface MaterialObservation {
	path: string;
	source: "artifact" | "workspace";
	exists: boolean;
	kind?: "file" | "directory" | "other";
	size?: number;
	modifiedAt?: number;
	digest?: string;
	encoding?: "utf-8" | "base64";
	content?: string;
	complete: boolean;
	required?: boolean;
	note?: string;
}

interface LifecycleObservations {
	entries: MaterialObservation[];
	pending: Array<Record<string, unknown>>;
	incomplete: Array<{ path: string; reason: string }>;
}

function insideAuthorizedRoot(candidate: string, roots: string[]): boolean {
	return roots.some(root => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

/** One exact full body. Partial bodies are never emitted; oversized required material is incomplete. */
function observeMaterialBytes(path: string, source: "artifact" | "workspace", bytes: Uint8Array, limit: number): MaterialObservation {
	const size = bytes.byteLength;
	const digest = sha256Bytes(bytes);
	if (size > limit) {
		return {
			path,
			source,
			exists: true,
			kind: "file",
			size,
			digest,
			complete: false,
			required: true,
			note: `selected file is ${size} bytes; the exact body exceeds the ${limit}-byte context policy and was not truncated`,
		};
	}
	try {
		return { path, source, exists: true, kind: "file", size, digest, encoding: "utf-8", content: exactUtf8.decode(bytes), complete: true };
	} catch {
		return {
			path, source, exists: true, kind: "file", size, digest, encoding: "base64",
			content: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
			complete: true,
		};
	}
}

function observeWorkspacePath(declared: string, roots: string[], cwd: string, limit: number): MaterialObservation {
	const absolute = declared.startsWith("/") ? resolve(declared) : resolve(cwd, declared);
	let real: string;
	try {
		real = realpathSync(absolute);
	} catch {
		return { path: declared, source: "workspace", exists: false, complete: true };
	}
	if (!insideAuthorizedRoot(real, roots)) {
		return {
			path: declared,
			source: "workspace",
			exists: true,
			complete: false,
			required: false,
			note: "path is outside the authorized roots; its body was not read",
		};
	}
	let stats: Stats;
	try {
		stats = statSync(real);
	} catch {
		return { path: declared, source: "workspace", exists: false, complete: true };
	}
	if (stats.isDirectory()) {
		return {
			path: declared,
			source: "workspace",
			exists: true,
			kind: "directory",
			modifiedAt: stats.mtimeMs,
			complete: true,
			note: "directory metadata only; no listing is included",
		};
	}
	if (!stats.isFile()) {
		return { path: declared, source: "workspace", exists: true, kind: "other", complete: true };
	}
	if (stats.size > limit) {
		return {
			path: declared,
			source: "workspace",
			exists: true,
			kind: "file",
			size: stats.size,
			modifiedAt: stats.mtimeMs,
			complete: false,
			required: true,
			note: `selected file is ${stats.size} bytes; the exact body exceeds the ${limit}-byte context policy and was not truncated`,
		};
	}
	let bytes: Buffer;
	try {
		bytes = readFileSync(real);
	} catch (error) {
		return {
			path: declared,
			source: "workspace",
			exists: true,
			kind: "file",
			size: stats.size,
			modifiedAt: stats.mtimeMs,
			complete: false,
			required: true,
			note: `selected file could not be read: ${messageOf(error)}`,
		};
	}
	const observation = observeMaterialBytes(declared, "workspace", bytes, limit);
	observation.modifiedAt = stats.mtimeMs;
	return observation;
}

function selectedMaterialPaths(run: AutonomyRun): string[] {
	// The approved plan body itself is already supplied verbatim as `approvedPlan.content`; observing
	// it again would duplicate it and could turn its size into a false "unobservable" durable wait.
	const planUrl = run.checkpoint.plan?.planUrl;
	const paths: string[] = [];
	for (const topic of run.checkpoint.planTopics ?? []) {
		for (const path of topic.paths) if (path !== planUrl) paths.push(path);
	}
	return [...new Set(paths)];
}

/**
 * Truthful read-only observations for the paths the approved plan already selects. Exact bodies are
 * included only when complete and small enough; digests never stand in for content. Missing paths
 * are reported as missing. A selected body that cannot be fully represented leaves the run waiting
 * rather than submitting a truncated or digest-only substitute.
 */
function observeLifecycleMaterial(store: AutonomyStore, run: AutonomyRun, cwd: string): LifecycleObservations {
	const entries: MaterialObservation[] = [];
	const incomplete: LifecycleObservations["incomplete"] = [];
	const plan = run.checkpoint.plan;
	if (plan !== undefined) {
		try {
			const bytes = store.artifact(run.id, plan.planUrl);
			let planObservation: MaterialObservation;
			if (bytes === null) {
				planObservation = { path: plan.planUrl, source: "artifact", exists: false, complete: true };
			} else {
				planObservation = {
					path: plan.planUrl,
					source: "artifact",
					exists: true,
					kind: "file",
					size: bytes.byteLength,
					digest: sha256Bytes(bytes),
					complete: true,
					note: "The approved plan body is supplied verbatim as approvedPlan.content; it is not duplicated here.",
				};
			}
			entries.push(planObservation);
		} catch (error) {
			incomplete.push({ path: plan.planUrl, reason: `stored plan artifact could not be read: ${messageOf(error)}` });
		}
	}
	for (const path of selectedMaterialPaths(run)) {
		let observation: MaterialObservation;
		if (path.startsWith("local://")) {
			let bytes: Uint8Array | null = null;
			try {
				bytes = store.artifact(run.id, path);
			} catch (error) {
				incomplete.push({ path, reason: `stored artifact could not be read: ${messageOf(error)}` });
				continue;
			}
			observation =
				bytes === null
					? { path, source: "artifact", exists: false, complete: true }
					: observeMaterialBytes(path, "artifact", bytes, run.policy.maxContextBytes);
		} else {
			observation = observeWorkspacePath(path, run.policy.roots, cwd, run.policy.maxContextBytes);
		}
		entries.push(observation);
		if (observation.required === true && !observation.complete) {
			incomplete.push({ path, reason: observation.note ?? "selected body is not fully observable" });
		}
	}
	const pending = Object.values(run.pending).map(intent => {
		const payload = asRecord(intent.payload);
		const recordedCwd = payload?.["cwd"];
		const cwdValue = typeof recordedCwd === "string" && recordedCwd !== "" ? recordedCwd : null;
		let cwdExists: boolean | null = null;
		if (cwdValue !== null) {
			const absolute = cwdValue.startsWith("/") ? resolve(cwdValue) : resolve(cwd, cwdValue);
			try {
				const real = realpathSync(absolute);
				cwdExists = insideAuthorizedRoot(real, run.policy.roots) ? statSync(real).isDirectory() : null;
			} catch {
				cwdExists = false;
			}
		}
		return {
			intentId: intent.id,
			kind: intent.kind,
			recordedCwd: cwdValue,
			cwdExists,
			note: "The recorded payload and invocation are reproduced verbatim in pendingUnknownEffects; output paths are not guessed.",
		};
	});
	return { entries, pending, incomplete };
}

function lifecycleContext(
	store: AutonomyStore,
	run: AutonomyRun,
	target: ChildTarget,
	launch: AutonomyScopeLaunch,
	command: string[],
	reason: string,
	fencing: { proven: boolean; scope: AutonomyScope | undefined; intentIds: string[]; prior: ProcessIdentity | undefined; receipts: AutonomyScopeFence[] },
	observations: LifecycleObservations,
	pending: AutonomyIntent[],
	attempt: number,
): Record<string, unknown> {
	const plan = run.checkpoint.plan;
	const planBytes = plan === undefined ? null : store.artifact(run.id, plan.planUrl);
	const consequentialEffectsBlocked = pending.length > 0;
	return {
		purpose: "supervisor lifecycle launch",
		reason,
		run: {
			id: run.id,
			objective: run.objective,
			status: run.status,
			epoch: run.epoch,
			generation: run.generation,
			createdAt: run.createdAt,
			sequence: run.sequence,
			audience: run.audience ?? null,
			policyDigest: run.policyDigest,
			judgeCalls: run.judgeCalls,
			executorCalls: run.executorCalls,
			callBudget: run.policy.maxJudgeCalls,
			executorBudget: run.policy.maxExecutorCalls,
			runtimeBudgetMs: run.policy.maxRuntimeMs,
			contextBudgetBytes: run.policy.maxContextBytes,
		},
		policy: run.policy,
		checkpoint: { ...run.checkpoint, refusedCalls: Array.from(run.checkpoint.refusedCalls) },
		artifacts: run.artifacts,
		manifest: run.manifest,
		topicManifests: run.topicManifests,
		approvedPlan: plan === undefined ? null : {
			...plan,
			content: planBytes === null ? null : exactUtf8.decode(planBytes),
		},
		fencing: {
			proven: fencing.proven,
			scope: fencing.scope ?? null,
			intentIds: fencing.intentIds,
			prior: fencing.prior ?? null,
			// `proven` is the driver's conclusion; these are the committed receipts behind it. They
			// are the exact records a replacement's reconciliation is authorized by, so the judge
			// decides on the observed receipt rather than on an assertion alone.
			receipts: fencing.receipts,
		},
		pendingUnknownEffects: pending,
		observations: {
			selectedPaths: observations.entries,
			pending: observations.pending,
			policy: {
				readOnly: true,
				maxContextBytes: run.policy.maxContextBytes,
				exactBodiesOnly: true,
				note: "Exact complete bodies only; small non-UTF8 bodies are exact base64. Digests are metadata, never a substitute for body content. These observations are diagnostics and never payload approval.",
			},
		},
		candidate: {
			operation: run.generation === 0 ? "spawn initial child" : "spawn replacement child",
			executable: target.executable,
			arguments: target.args.slice(1),
			entry: target.entry,
			cwd: target.cwd,
			model: target.model ?? null,
			environmentLocators: { store: STORE_ENV, run: RUN_ENV },
			scope: launch,
			command,
			effectPolicy: consequentialEffectsBlocked
				? {
						mode: "observation_and_reconciliation_only",
						consequentialEffectsBlocked: true,
						allowed: ["read-only observation", "typed reconciliation decision"],
						basis: "any pending intent blocks all consequential effects in the replacement runtime",
					}
				: { mode: "normal_development", consequentialEffectsBlocked: false },
		},
		attempt,
	};
}

function recoveryQuestion(): JudgeQuestion {
	return {
		name: AUTONOMY_RECOVERY_QUESTION,
		mode: "choice",
		instructions:
			"Decide the supervisor's next developmental transition for this autonomous run, including the exact precommitted systemd scope launch and its complete child invocation. Choose launch only when any recorded prior execution is positively fenced and any pending unknown effects can be handled by the replacement without blindly repeating an external effect. When pendingUnknownEffects is non-empty the replacement runtime is observation-and-reconciliation-only: consequential effects stay blocked, so launch may only gather read-only evidence and submit typed reconciliation decisions. Choose wait when evidence is insufficient or the previous material must change. Choose infeasible only when the run cannot safely continue within the frozen policy.",
		options: {
			launch:
				"Launch the exact replacement candidate in the precommitted scope. Native detached work inside that scope is proven empty. With pending intents, the replacement is observation-and-reconciliation-only: consequential effects remain blocked, it gathers read-only evidence and submits typed reconciliation decisions, and nothing is replayed.",
			wait:
				"Do not launch. Preserve the run in a durable waiting state with this reason; a different material state is required before trying again.",
			infeasible:
				"Stop attempting development: the run cannot safely continue under its frozen objective, policy and observed state.",
		},
	};
}

function audienceQuestion(): JudgeQuestion {
	return {
		name: "deliverable_audience",
		mode: "choice",
		instructions:
			"Classify the intended audience of the immutable owner objective. External means an actual deliverable intended for recipients outside the project; internal development, analysis, documentation and verification do not become external merely because they produce files or reports. Use unclear when the objective and its context do not settle this. This classification grants no permission to publish or expand the frozen effect policy.",
		options: {
			external: "The objective includes an actual deliverable intended for an audience outside the project.",
			internal: "The objective concerns the project's own development, analysis, documentation or verification.",
			unclear: "The intended audience cannot be established from this objective and the submitted context.",
		},
	};
}

function recordDecision(
	store: AutonomyStore,
	run: AutonomyRun,
	purpose: string,
	context: Record<string, unknown>,
	questions: readonly JudgeQuestion[],
	contextDigest: string,
	outcome: JudgeOutcome,
	now: number,
): { run: AutonomyRun; stale: boolean; decisionId: string } {
	const decisionId = sha256Text(JSON.stringify({ purpose, context, questions, outcome }));
	const data = { decisionId, purpose, context, questions, contextDigest, outcome, at: now, stale: false };
	const audience = answerOf(outcome, "deliverable_audience");
	const updated = updateRun(store, run, current => {
		data.stale = current.sequence !== run.sequence;
		if (
			!data.stale && current.audience === undefined &&
			audience?.mode === "choice" && audience.confidence >= POLICY.minConfidenceToApprove &&
			(audience.label === "external" || audience.label === "internal")
		) {
			current.audience = {
				external: audience.label === "external",
				objectiveDigest: sha256Text(current.objective),
				decisionId,
			};
		}
	}, [{ kind: "driver.recovery_decision", data }]);
	return { run: updated, stale: data.stale, decisionId };
}

function identityValue(value: unknown): ProcessIdentity | undefined {
	const record = asRecord(value);
	const pid = record?.["pid"];
	const start = record?.["start"];
	const group = record?.["group"];
	const parent = record?.["parent"];
	const bootId = record?.["bootId"];
	if (
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		typeof start !== "string" ||
		start.length === 0 ||
		typeof group !== "number" ||
		!Number.isSafeInteger(group) ||
		group <= 0 ||
		typeof parent !== "number" ||
		!Number.isSafeInteger(parent) ||
		parent < 0 ||
		typeof bootId !== "string" ||
		bootId.length === 0
	) {
		return undefined;
	}
	return { pid, start, group, parent, bootId };
}

function scopeLaunchValue(value: unknown): AutonomyScopeLaunch | undefined {
	const record = asRecord(value);
	const runId = record?.["runId"];
	const epoch = record?.["epoch"];
	const unit = record?.["unit"];
	const bootId = record?.["bootId"];
	if (
		typeof runId !== "string" ||
		runId.length === 0 ||
		typeof epoch !== "number" ||
		!Number.isSafeInteger(epoch) ||
		epoch < 0 ||
		typeof unit !== "string" ||
		unit.length === 0 ||
		typeof bootId !== "string" ||
		bootId.length === 0
	) {
		return undefined;
	}
	return { runId, epoch, unit, bootId };
}

/** Every launch intent's precommitted scope launch and observed child identity, when present. */
function lifecycleLaunches(
	run: AutonomyRun,
): Array<{ id: string; launch?: AutonomyScopeLaunch; child?: ProcessIdentity }> {
	return Object.values(run.pending).flatMap(intent => {
		if (intent.kind !== "lifecycle") return [];
		const payload = asRecord(intent.payload);
		if (payload?.["operation"] !== "spawn") return [];
		const launch = scopeLaunchValue(payload["launch"]);
		const child = identityValue(payload["child"]);
		return [
			{
				id: intent.id,
				...(launch === undefined ? {} : { launch }),
				...(child === undefined ? {} : { child }),
			},
		];
	});
}

/**
 * A lifecycle spawn intent is resolved once its child process has been positively fenced and
 * observed dead. Tool intents remain unknown and are never swept here.
 */
function resolveLifecycleSpawns(
	store: AutonomyStore,
	run: AutonomyRun,
	children: ProcessIdentity[],
	signals: string[],
	now: number,
	outcome = "prior child scope positively fenced and observed empty",
): AutonomyRun {
	const resolved = Object.values(run.pending).filter(intent => {
		if (intent.kind !== "lifecycle") return false;
		const payload = asRecord(intent.payload);
		if (payload?.["operation"] !== "spawn") return false;
		const child = identityValue(payload["child"]);
		if (child === undefined) return false;
		return children.some(candidate => sameIdentity(candidate, child));
	});
	if (resolved.length === 0) return run;
	return updateRun(
		store,
		run,
		current => {
			for (const intent of resolved) delete current.pending[intent.id];
		},
		[
			{
				kind: "driver.lifecycle_resolved",
				data: {
					intentIds: resolved.map(intent => intent.id),
					outcome,
					prior: children.length === 1 ? children[0] : children,
					signals,
					at: now,
				},
			},
		],
	);
}

/** A rotation request is acted on only while the bound child reports itself settled and idle. */
async function childIsSettled(child: ActiveChild): Promise<boolean> {
	try {
		const frame = await child.channel.send({ type: "get_state" }, 2_000);
		const state = asRecord(frame["data"]);
		return state?.["isSettled"] === true && state?.["isStreaming"] !== true;
	} catch {
		return false;
	}
}

function recordJudgeAttempt(
	store: AutonomyStore,
	run: AutonomyRun,
	purpose: string,
	context: Record<string, unknown>,
	questions: readonly JudgeQuestion[],
	contextDigest: string,
	attempt: number,
	now: number,
): AutonomyRun {
	if (run.judgeCalls >= run.policy.maxJudgeCalls) return run;
	return updateRun(
		store,
		run,
		current => {
			current.judgeCalls += 1;
		},
		[{ kind: "driver.judge_attempt", data: { purpose, context, questions, contextDigest, attempt, at: now } }],
	);
}

async function judgeOutcome(
	judge: Judge,
	context: Record<string, unknown>,
	questions: readonly JudgeQuestion[],
	signal: AbortSignal,
): Promise<JudgeOutcome | "stopped"> {
	if (signal.aborted) return "stopped";
	return new Promise<JudgeOutcome | "stopped">(resolveJudge => {
		let settled = false;
		const finish = (value: JudgeOutcome | "stopped"): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolveJudge(value);
		};
		const onAbort = (): void => finish("stopped");
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		Promise.resolve()
			.then(() => judge(context, questions))
			.then(
				value => finish(value),
				error => {
					finish({ ok: false, kind: "unavailable", problem: messageOf(error) });
				},
			);
	});
}

async function cancellationResult(
	store: AutonomyStore,
	run: AutonomyRun,
	reason: string,
	active: ActiveChild | undefined,
	capability: () => Promise<void>,
): Promise<DriverResult> {
	let durable = false;
	let cancelFailure: string | undefined;
	const me = processIdentity();
	let current: AutonomyRun | undefined;
	try {
		current = store.read(run.id);
	} catch (error) {
		cancelFailure = `could not read the run before cancellation: ${messageOf(error)}`;
	}
	const ownerNow = current?.owner;
	const ownsRun = ownerNow !== undefined && me !== null && sameIdentity(ownerNow, me);
	if (current !== undefined && !isTerminal(current.status) && (ownerNow === undefined || ownsRun)) {
		try {
			current = store.cancel(run.id, reason);
			durable = true;
		} catch (error) {
			cancelFailure = `the cancellation was not committed: ${messageOf(error)}`;
		}
	} else if (current !== undefined && isTerminal(current.status)) {
		durable = current.status === "cancelled";
		if (!durable) cancelFailure = `the run is already ${current.status}`;
	} else if (current !== undefined) {
		cancelFailure = "the run is owned by another live supervisor; this process did not commit cancellation";
	}
	let quiet = true;
	if (active !== undefined) {
		const stopped = await stopActiveChild(store, current ?? run, active, capability, Date.now());
		current = stopped.run;
		quiet = stopped.quiet;
		if (stopped.error !== undefined) cancelFailure = `${cancelFailure ?? "the active scope could not be fenced"}: ${stopped.error}`;
	} else if (current !== undefined) {
		const unresolved = lifecycleLaunches(current).some(entry => entry.child === undefined);
		if (current.scope !== undefined || lifecycleLaunches(current).some(entry => entry.child !== undefined)) {
			try {
				const fenced = await fenceRunScope(store, current, {
					terminal: isTerminal(current.status),
					capability,
					now: Date.now(),
				});
				current = fenced.run;
				if (!fenced.recorded) {
					quiet = false;
					cancelFailure = `${cancelFailure ?? "the scope fence receipt was not committed"}; physical quiescence was observed`;
				}
			} catch (error) {
				quiet = false;
				cancelFailure = `${cancelFailure ?? "the stored scope could not be positively fenced"}: ${messageOf(error)}`;
			}
		}
		if (unresolved) {
			quiet = false;
			cancelFailure = `${cancelFailure ?? "a lifecycle launch intent has no observed child identity"}; its executor could not be fenced`;
		}
	}
	let finalStatus: AutonomyStatus = durable ? "cancelled" : (current ?? run).status;
	try {
		finalStatus = store.read(run.id).status;
	} catch {
		// Keep the last durable or readable projection.
	}
	const ok = durable && quiet;
	const message = cancelFailure ?? (quiet ? undefined : "the child scope could not be proven empty");
	return {
		runId: run.id,
		status: finalStatus,
		exitCode: ok ? 0 : 1,
		durableCancellation: durable,
		...(message === undefined ? {} : { message }),
	};
}

/** The user manager registers the transient scope asynchronously; observation is bounded, not assumed. */
async function observeScopeBounded(
	launch: AutonomyScopeLaunch,
	child: ProcessIdentity,
	config: SupervisorConfig,
	signal: AbortSignal,
): Promise<AutonomyScope> {
	const deadline = config.now() + SCOPE_OBSERVE_TIMEOUT_MS;
	while (true) {
		if (signal.aborted) throw new Error("launch cancelled during scope observation");
		try {
			return await observeAutonomyScope(launch, child);
		} catch (error) {
			const remaining = deadline - config.now();
			if (remaining <= 0) throw error;
			if (!processAlive(child)) throw new Error("the child exited before its scope was observed");
			await config.sleep(Math.min(SCOPE_OBSERVE_POLL_MS, remaining), signal);
		}
	}
}

/** Wait for the actual bound runtime's bootstrap acknowledgment, never for ready/get_state alone. */
async function awaitStartupAck(
	store: AutonomyStore,
	run: AutonomyRun,
	child: ProcessIdentity,
	session: { id: string; file: string },
	bindSequence: number,
	config: SupervisorConfig,
	signal: AbortSignal,
): Promise<boolean> {
	const deadline = config.now() + config.startupAckTimeoutMs;
	while (true) {
		if (signal.aborted) return false;
		// The committed acknowledgment is durable evidence in its own right. Scan it before any
		// liveness check: a child may exit immediately after committing the receipt, and losing
		// that evidence to an intervening poll would misreport a completed startup as a timeout.
		let acknowledged = false;
		try {
			acknowledged = store.events(run.id).some(event => {
				if (event.kind !== "autonomy.restore" || event.sequence <= bindSequence) return false;
				const data = asRecord(event.data);
				return (
					data?.["epoch"] === run.epoch &&
					data?.["generation"] === run.generation &&
					data?.["sessionId"] === session.id
				);
			});
		} catch {
			return false;
		}
		if (acknowledged) {
			// A cancellation observed in the same poll wins over the acknowledgment.
			if (signal.aborted) return false;
			return true;
		}
		// Without a committed receipt a dead child can never produce one: fail closed now.
		let alive: boolean;
		try {
			alive = processAlive(child);
		} catch {
			return false;
		}
		if (!alive) return false;
		const remaining = deadline - config.now();
		if (remaining <= 0) return false;
		const slept = await config.sleep(Math.min(STARTUP_ACK_POLL_MS, remaining), signal);
		if (!slept) return false;
	}
}

async function launchChild(
	store: AutonomyStore,
	run: AutonomyRun,
	target: ChildTarget,
	launch: AutonomyScopeLaunch,
	command: string[],
	config: SupervisorConfig,
	signal: AbortSignal,
	capability: () => Promise<void>,
): Promise<LaunchResult> {
	if (signal.aborted) return { ok: false, run, error: "launch cancelled" };
	if (run.executorCalls >= run.policy.maxExecutorCalls) {
		return { ok: false, run, error: "the executor call budget is exhausted" };
	}
	if (launch.runId !== run.id || launch.epoch !== run.epoch) {
		return { ok: false, run, error: "the precommitted scope launch does not match the current run and epoch" };
	}
	try {
		await capability();
		if (launch.bootId !== autonomyBootId()) {
			return { ok: false, run, error: "the precommitted scope launch belongs to a different kernel boot" };
		}
	} catch (error) {
		return { ok: false, run, error: `the scope capability is unavailable: ${messageOf(error)}` };
	}
	const now = config.now();
	const intent = newIntent(
		"lifecycle",
		{
			operation: "spawn",
			epoch: run.epoch,
			launch,
			command,
			executable: target.executable,
			arguments: target.args.slice(1),
			entry: target.entry,
			cwd: target.cwd,
			model: target.model ?? null,
			locators: { store: STORE_ENV, run: RUN_ENV },
			spawnStarted: false,
		},
		run.sequence + 1,
		run.checkpoint.task?.fingerprint,
		now,
	);
	let current = updateRun(
		store,
		run,
		r => {
			r.pending[intent.id] = intent;
			r.executorCalls += 1;
		},
		[
			{
				kind: "driver.launch_intent",
				data: {
					intentId: intent.id,
					operation: "spawn",
					epoch: run.epoch,
					launch,
					command,
					executable: target.executable,
					entry: target.entry,
					cwd: target.cwd,
					model: target.model ?? null,
					at: now,
				},
			},
		],
	);

	let childProcess: Subprocess | undefined;
	let identity: ProcessIdentity | undefined;
	let channel: RpcChannel | undefined;
	let scope: AutonomyScope | undefined;
	let boundScope = false;
	let stage = "spawn";
	try {
		// Durable causal marker before the producer exists. An intent without it provably never
		// started one; with it and no recorded child, a possibly-live producer stays unproved.
		current = updateRun(
			store,
			current,
			r => {
				const existing = r.pending[intent.id];
				if (existing === undefined) return;
				r.pending[intent.id] = {
					...existing,
					payload: { ...(asRecord(existing.payload) ?? {}), spawnStarted: true },
				};
			},
			[{ kind: "driver.spawn_started", data: { intentId: intent.id, at: config.now() } }],
		);
		childProcess = Bun.spawn(command, {
			cwd: target.cwd,
			env: { ...process.env, [STORE_ENV]: config.storePath, [RUN_ENV]: run.id },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
		void drainStream(readablePipe(childProcess.stderr));
		const observed = processIdentity(childProcess.pid);
		if (observed === null) throw new Error("the child exited before its identity could be read");
		identity = observed;
		const childIdentity = observed;
		if (childIdentity.parent !== process.pid) throw new Error("the child was not parented by this supervisor");
		if (childIdentity.bootId !== launch.bootId) throw new Error("the child boot identity does not match the precommitted launch");
		stage = "record_child";
		current = updateRun(
			store,
			current,
			r => {
				const existing = r.pending[intent.id];
				if (existing === undefined) return;
				r.pending[intent.id] = {
					...existing,
					payload: { ...(asRecord(existing.payload) ?? {}), child: childIdentity },
				};
			},
			[{ kind: "driver.launch_spawned", data: { intentId: intent.id, child: childIdentity, at: config.now() } }],
		);
		if (config.lifecycleRace?.afterLaunchSpawned !== undefined) {
			await config.lifecycleRace.afterLaunchSpawned();
		}
		stage = "observe_scope";
		const observedScope = await observeScopeBounded(launch, childIdentity, config, signal);
		scope = observedScope;
		stage = "bind_scope";
		current = store.bindScope(run.id, current.epoch, observedScope);
		boundScope = true;
		stage = "bind_child";
		current = store.bindChild(run.id, current.epoch, childIdentity);
		stage = "ready";
		const rpc = createRpcChannel(readablePipe(childProcess.stdout), writablePipe(childProcess.stdin));
		channel = rpc;
		const firstSignal = await raceAbort(
			Promise.race([
				rpc.waitReady(READY_TIMEOUT_MS).then(data => ({ kind: "ready" as const, data })),
				childProcess.exited.then(code => ({ kind: "exit" as const, code })),
			]),
			signal,
		);
		if (firstSignal === "stopped") throw new Error("launch cancelled during RPC ready");
		if (firstSignal.kind === "exit") {
			throw new Error(`the child exited with code ${firstSignal.code} before RPC ready`);
		}
		const ready = firstSignal.data;
		if (ready.supportedProtocolVersions.includes(2)) {
			try {
				const negotiated = await raceAbort(
					rpc.send({ type: "negotiate_protocol", protocolVersion: 2 }, READY_TIMEOUT_MS),
					signal,
				);
				if (negotiated === "stopped") throw new Error("launch cancelled during protocol negotiation");
			} catch (error) {
				if (signal.aborted) throw error;
				// A host that refuses v2 still runs protocol v1; the get_state bound is checked below.
			}
		}
		stage = "get_state";
		const stateFrame = await raceAbort(rpc.send({ type: "get_state" }, READY_TIMEOUT_MS), signal);
		if (stateFrame === "stopped") throw new Error("launch cancelled during get_state");
		const state = asRecord(stateFrame["data"]);
		const sessionId = state?.["sessionId"];
		const sessionFile = state?.["sessionFile"];
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new Error("get_state returned no session id");
		}
		if (typeof sessionFile !== "string" || sessionFile.length === 0) {
			throw new Error("get_state returned no session file");
		}
		stage = "bind_session";
		const bound = store.bindSession(run.id, current.epoch, { id: sessionId, file: sessionFile });
		stage = "bootstrap_ack";
		const acknowledged = await awaitStartupAck(
			store,
			bound,
			childIdentity,
			{ id: sessionId, file: sessionFile },
			bound.sequence,
			config,
			signal,
		);
		if (!acknowledged) {
			throw new Error("the bound runtime produced no matching bootstrap acknowledgment before the startup deadline");
		}
		// The committed receipt proves the bound runtime acknowledged startup. It is not liveness:
		// a child that already exited must not be handed to the supervisor as a running process.
		let aliveAfterAck = false;
		try {
			aliveAfterAck = processAlive(childIdentity);
		} catch {
			aliveAfterAck = false;
		}
		if (typeof childProcess.exitCode === "number" || !aliveAfterAck) {
			current = updateRun(
				store,
				bound,
				() => {},
				[
					{
						kind: "driver.session_bound",
						data: { sessionId, sessionFile, generation: bound.generation, at: config.now() },
					},
					{
						kind: "driver.bootstrap_ack",
						data: { epoch: bound.epoch, generation: bound.generation, sessionId, at: config.now() },
					},
				],
			);
			throw new Error("the child exited after its bootstrap acknowledgment before supervision could begin");
		}
		const exit = childProcess.exited;
		const active: ActiveChild = { identity: childIdentity, channel: rpc, exit };
		const running = updateRun(
			store,
			bound,
			r => {
				r.status = "running";
				delete r.waiting;
				delete r.wake;
				delete r.pending[intent.id];
			},
			[
				{
					kind: "driver.ready",
					data: { protocolVersion: ready.protocolVersion, maxFrameBytes: ready.maxFrameBytes, at: config.now() },
				},
				{
					kind: "driver.session_bound",
					data: { sessionId, sessionFile, generation: bound.generation, at: config.now() },
				},
				{
					kind: "driver.bootstrap_ack",
					data: { epoch: bound.epoch, generation: bound.generation, sessionId, at: config.now() },
				},
				{
					kind: "driver.launch_result",
					data: { intentId: intent.id, operation: "spawn", stage: "bound", result: "bound", at: config.now() },
				},
			],
		);
		return { ok: true, run: running, child: active };
	} catch (error) {
		channel?.close(new Error(`launch failed at ${stage}`));
		const spawned = childProcess !== undefined;
		let fenced = false;
		let fenceScope = scope;
		if (fenceScope === undefined && identity !== undefined) {
			try {
				fenceScope = await observeAutonomyScope(launch, identity);
			} catch {
				// An unobservable pre-bind scope stays unknown; it is never assumed empty.
			}
		}
		if (fenceScope !== undefined) {
			try {
				// A child that acknowledged and immediately died can outlive its cgroup. Prove the
				// transient unloading state empty with a bounded retry instead of an assert-first fence.
				const proof = await proveScopeEmptyBounded(fenceScope);
				// The observation is slow enough for an operator transition to commit. The decision
				// must use the authoritative current status, not the pre-transition snapshot.
				let authoritative = current;
				try {
					authoritative = store.read(current.id);
				} catch {
					// Keep the last committed snapshot when the store cannot answer.
				}
				if (!boundScope && !isTerminal(authoritative.status)) {
					try {
						authoritative = store.bindScope(current.id, current.epoch, proof.scope);
						boundScope = true;
					} catch {
						// A concurrent terminal transition may refuse the bind; re-read that status.
						try {
							authoritative = store.read(current.id);
						} catch {
							// Keep the last read snapshot.
						}
					}
				}
				current = authoritative;
				if (boundScope || isTerminal(current.status)) {
					try {
						current = await recordFencedScope(store, current, proof.scope);
						fenced = true;
					} catch {
						// Physical quiescence without a receipt is not a proven fence.
					}
				}
			} catch {
				// The launch stays unknown; the caller records the failed stage.
			}
		}
		if (identity !== undefined) {
			if (!fenced) {
				try {
					signalVerifiedProcess(identity, "SIGKILL");
				} catch {
					// The direct leader may already be gone; detached work stays unknown.
				}
			}
			try {
				await childProcess?.exited;
			} catch {
				// Exit is observed by process state, not by this message.
			}
		}
		const reason = messageOf(error);
		try {
			current = updateRun(
				store,
				current,
				r => {
					if (!spawned || fenced) delete r.pending[intent.id];
				},
				[
					{
						kind: "driver.launch_failed",
						data: {
							intentId: intent.id,
							operation: "spawn",
							stage,
							unknownEffect: spawned && !fenced,
							fenced,
							reason,
							at: config.now(),
						},
					},
				],
			);
		} catch {
			// A storage failure propagates through the supervisor's safety path.
		}
		return { ok: false, run: current, error: `launch failed at ${stage}: ${reason}` };
	}
}

/**
 * The decision material that a refusal actually consumed. It deliberately excludes the fresh
 * candidate scope unit, epoch, attempt and volatile status so a new random launch never re-asks the
 * same refusal, while changed checkpoint, artifact, pending or fencing evidence still does.
 */
function refusalMaterialDigest(
	store: AutonomyStore,
	run: AutonomyRun,
	fencing: { scope: AutonomyScope | undefined; intentIds: string[]; prior: ProcessIdentity | undefined },
	observations: LifecycleObservations,
): string {
	const plan = run.checkpoint.plan;
	const planBytes = plan === undefined ? null : store.artifact(run.id, plan.planUrl);
	return sha256Text(
		JSON.stringify({
			objective: run.objective,
			policy: run.policy,
			policyDigest: run.policyDigest,
			audience: run.audience ?? null,
			checkpoint: { ...run.checkpoint, refusedCalls: Array.from(run.checkpoint.refusedCalls) },
			artifacts: run.artifacts,
			manifest: run.manifest,
			topicManifests: run.topicManifests,
			approvedPlan:
				plan === undefined
					? null
					: {
							...plan,
							content:
								planBytes === null ? null : exactUtf8.decode(planBytes),
						},
			fencing: {
				scope: fencing.scope ?? null,
				intentIds: fencing.intentIds,
				prior: fencing.prior ?? null,
			},
			pending: Object.values(run.pending),
			observations: observations.entries.map(entry => ({
				path: entry.path,
				source: entry.source,
				exists: entry.exists,
				kind: entry.kind ?? null,
				size: entry.size ?? null,
				digest: entry.digest ?? null,
				encoding: entry.encoding ?? null,
				content: entry.content ?? null,
				complete: entry.complete,
				required: entry.required ?? false,
				note: entry.note ?? null,
			})),
			pendingObservations: observations.pending,
		}),
	);
}

/**
 * The latest durable refusal and whether a later actual decision superseded it. Waiting.kind is
 * ephemeral: a capability or fencing wait may overwrite it without changing the refused material.
 */
function refusalHoldState(
	store: AutonomyStore,
	runId: string,
): { hold?: Record<string, unknown>; active: boolean } {
	let hold: Record<string, unknown> | undefined;
	let active = false;
	for (const event of store.events(runId)) {
		if (event.kind === "driver.refusal_hold") {
			const data = asRecord(event.data);
			if (data !== undefined) {
				hold = data;
				active = true;
			}
			continue;
		}
		if (event.kind === "driver.recovery_decision") active = false;
	}
	return { hold, active };
}

function recordRefusalHold(
	store: AutonomyStore,
	run: AutonomyRun,
	materialDigest: string,
	reason: string,
	decisionId: string,
	now: number,
): AutonomyRun {
	return updateRun(
		store,
		run,
		() => {},
		[{ kind: "driver.refusal_hold", data: { materialDigest, reason, decisionId, at: now } }],
	);
}

async function recoverRun(
	store: AutonomyStore,
	run: AutonomyRun,
	target: ChildTarget,
	config: SupervisorConfig,
	signal: AbortSignal,
	attempts: number,
	reason: "initial startup" | "process loss recovery" | "rotation",
	capability: () => Promise<void>,
): Promise<RecoveryResult> {
	const now = config.now();
	if (signal.aborted) return { kind: "stopped", run };
	if (config.lifecycleRace?.beforeRecoverRead !== undefined) {
		await config.lifecycleRace.beforeRecoverRead();
	}
	let current = store.read(run.id);
	if (isTerminal(current.status)) return { kind: "terminal", run: current };
	if (current.epoch !== run.epoch) return { kind: "lost", run: current };
	try {
		await capability();
	} catch (error) {
		const waiting = markWaiting(
			store,
			current,
			"capability",
			`autonomous scope capability is unavailable: ${messageOf(error)}`,
			attempts,
			undefined,
			now,
		);
		return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? "scope capability unavailable" };
	}

	const launches = lifecycleLaunches(current);
	let fencingScope: AutonomyScope | undefined;
	let intentIds: string[] = [];
	if (current.scope !== undefined || launches.length > 0) {
		try {
			const fenced = await fenceRunScope(store, current, {
				terminal: false,
				capability,
				now: config.now(),
				requireReceipt: true,
			});
			current = fenced.run;
			fencingScope = fenced.scope;
			intentIds = fenced.intentIds;
		} catch (error) {
			const waiting = markWaiting(
				store,
				current,
				"fencing",
				`the previous execution could not be positively fenced: ${messageOf(error)}`,
				attempts + 1,
				undefined,
				config.now(),
			);
			return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? "fencing failed" };
		}
	}
	if (signal.aborted) return { kind: "stopped", run: current };
	const remaining = lifecycleLaunches(current);
	const priorChild = current.child ?? remaining.find(entry => entry.child !== undefined)?.child;
	const heldWait = current.waiting;
	if (remaining.some(entry => entry.child === undefined)) {
		const waiting = markWaiting(
			store,
			current,
			"fencing",
			"a lifecycle launch intent has no observed child identity; no process can be positively fenced, so no replacement may be launched",
			attempts,
			undefined,
			now,
		);
		return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? "orphan launch intent" };
	}
	if (heldWait?.kind === "judge" && heldWait.retryAt !== undefined && heldWait.retryAt > config.now()) {
		return { kind: "wait", run: current, attempts: heldWait.attempts, retryAt: heldWait.retryAt };
	}
	if (current.judgeCalls >= current.policy.maxJudgeCalls) {
		const waiting = markWaiting(
			store,
			current,
			"resource",
			"the judge call budget is exhausted; no developmental transition may be attempted",
			attempts,
			undefined,
			now,
		);
		return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? "judge budget exhausted" };
	}
	if (current.executorCalls >= current.policy.maxExecutorCalls) {
		const waiting = markWaiting(
			store,
			current,
			"resource",
			"the executor call budget is exhausted; no replacement child may be launched",
			attempts,
			undefined,
			now,
		);
		return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? "executor budget exhausted" };
	}
	if (runtimeBudgetExhausted(current, config.now())) {
		const waiting = markWaiting(
			store,
			current,
			"resource",
			"the run runtime budget is exhausted; the run remains unapproved and resumable",
			attempts,
			undefined,
			config.now(),
		);
		return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? "runtime budget exhausted" };
	}
	// Exact read-only evidence for the paths the approved plan selects. No body is truncated, and a
	// selected body that cannot be represented completely leaves the run waiting instead of guessing.
	const observations = observeLifecycleMaterial(store, current, target.cwd);
	if (observations.incomplete.length > 0) {
		const reason = `the selected read-only material is not fully observable: ${observations.incomplete
			.map(item => `${item.path}: ${item.reason}`)
			.join("; ")}`;
		const waiting = markWaiting(store, current, "context", reason, attempts + 1, undefined, config.now());
		return { kind: "blocked", run: waiting, reason };
	}
	// The committed receipts that cover the intents still pending are decision material for the
	// lifecycle decision: they are what a replacement's reconciliation is authorized by.
	const receipts = current.fences.filter(fence => fence.intentIds.some(id => current.pending[id] !== undefined));
	// A refusal is material, not a random launch identity. The same durable material must not buy a
	// new judge call through resume; changed checkpoint, artifact, pending or observed body may.
	const refusal = refusalHoldState(store, current.id);
	if (
		refusal.active &&
		refusal.hold !== undefined &&
		refusal.hold["materialDigest"] ===
			refusalMaterialDigest(store, current, { scope: fencingScope, intentIds, prior: priorChild }, observations)
	) {
		const reason = typeof refusal.hold["reason"] === "string" ? refusal.hold["reason"] : "Jev chose to wait";
		const heldAttempts = heldWait?.kind === "judge" ? heldWait.attempts : attempts;
		const waiting = markWaiting(store, current, "judge", reason, heldAttempts, undefined, config.now());
		return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? reason };
	}

	const launch = makeAutonomyScopeLaunch(current.id, current.epoch);
	// The session directory is part of the exact judged argv, so approval covers the actual spawn.
	const sessionDirectory = launchSessionDirectory(config.storePath, current.id, launch);
	const launchTarget: ChildTarget = {
		...target,
		args: [...target.args, "--session-dir", sessionDirectory],
	};
	const command = autonomyScopeCommand(launch, launchTarget.executable, launchTarget.args.slice(1));
	const pending = Object.values(current.pending);
	const context = lifecycleContext(
		store,
		current,
		launchTarget,
		launch,
		command,
		reason,
		{ proven: true, scope: fencingScope, intentIds, prior: priorChild, receipts },
		observations,
		pending,
		attempts + 1,
	);
	const serialized = JSON.stringify(context);
	if (serialized === undefined) throw new Error("the lifecycle context is not JSON serializable");
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > current.policy.maxContextBytes) {
		const waiting = markWaiting(
			store,
			current,
			"context",
			`the supervisor decision context is ${bytes} bytes; the policy allows ${current.policy.maxContextBytes}`,
			attempts + 1,
			undefined,
			config.now(),
		);
		return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? "decision context too large" };
	}
	const contextDigest = sha256Text(serialized);
	const questions = current.audience === undefined ? [recoveryQuestion(), audienceQuestion()] : [recoveryQuestion()];
	let judged: AutonomyRun;
	try {
		judged = recordJudgeAttempt(store, current, `supervisor ${reason}`, context, questions, contextDigest, attempts + 1, config.now());
	} catch {
		return { kind: "wait", run: current, attempts: attempts + 1, retryAt: config.now() + backoffMs(attempts + 1) };
	}
	if (judged.judgeCalls === current.judgeCalls) {
		const waiting = markWaiting(
			store,
			judged,
			"resource",
			"the judge call budget is exhausted; no developmental transition may be attempted",
			attempts,
			undefined,
			config.now(),
		);
		return { kind: "blocked", run: waiting, reason: waiting.waiting?.reason ?? "judge budget exhausted" };
	}
	const outcome = await judgeOutcome(config.judge, context, questions, signal);
	if (outcome === "stopped") return { kind: "stopped", run: judged };
	let decided: AutonomyRun;
	let decisionId = "";
	try {
		const recorded = recordDecision(store, judged, `supervisor ${reason}`, context, questions, contextDigest, outcome, config.now());
		decided = recorded.run;
		decisionId = recorded.decisionId;
		if (recorded.stale) {
			const retryAt = config.now() + backoffMs(attempts + 1);
			const waiting = markWaiting(
				store, decided, "stale",
				"the persisted run changed while its lifecycle decision was in flight; a fresh decision is required",
				attempts + 1, retryAt, config.now(),
			);
			return { kind: "wait", run: waiting, attempts: attempts + 1, retryAt };
		}
	} catch {
		return { kind: "wait", run: judged, attempts: attempts + 1, retryAt: config.now() + backoffMs(attempts + 1) };
	}
	if (!outcome.ok) {
		const nextAttempt = attempts + 1;
		const retryAt = config.now() + backoffMs(nextAttempt);
		const waiting = markWaiting(
			store,
			decided,
			"judge",
			`the lifecycle decision was unavailable (${outcome.kind}): ${outcome.problem}`,
			nextAttempt,
			retryAt,
			config.now(),
		);
		return { kind: "wait", run: waiting, attempts: nextAttempt, retryAt };
	}
	const answer = answerOf(outcome, AUTONOMY_RECOVERY_QUESTION);
	const label = answer?.mode === "choice" ? answer.label : undefined;
	const confidence = answer?.mode === "choice" ? answer.confidence : 0;
	const decisive = confidence >= POLICY.minConfidenceToApprove;
	if (label === "launch" && decisive) {
		if (decided.audience === undefined) {
			const retryAt = config.now() + backoffMs(attempts + 1);
			const waiting = markWaiting(
				store, decided, "audience",
				"the objective's deliverable audience is unsettled; launch approval does not replace its required decision",
				attempts + 1, retryAt, config.now(),
			);
			return { kind: "wait", run: waiting, attempts: attempts + 1, retryAt };
		}
		const latest = store.read(current.id);
		if (isTerminal(latest.status)) return { kind: "terminal", run: latest };
		if (latest.epoch !== current.epoch) {
			try {
				updateRun(store, latest, () => {}, [
					{ kind: "driver.decision_stale", data: { contextDigest, epoch: latest.epoch, at: config.now() } },
				]);
			} catch {
				// The supervisor will stop on the next read or storage error.
			}
			return { kind: "lost", run: latest };
		}
		if (latest.generation !== current.generation) {
			const waiting = markWaiting(
				store,
				latest,
				"stale",
				"the lifecycle decision was taken for a different session generation; a fresh decision is required",
				attempts + 1,
				config.now() + backoffMs(attempts + 1),
				config.now(),
			);
			return { kind: "wait", run: waiting, attempts: attempts + 1, retryAt: waiting.waiting?.retryAt ?? 0 };
		}
		const launched = await launchChild(store, latest, launchTarget, launch, command, config, signal, capability);
		if (launched.ok) return { kind: "launched", run: launched.run, child: launched.child };
		const nextAttempt = attempts + 1;
		const retryAt = config.now() + backoffMs(nextAttempt);
		const waiting = markWaiting(
			store,
			launched.run,
			"launch",
			`replacement launch failed: ${launched.error}`,
			nextAttempt,
			retryAt,
			config.now(),
		);
		return { kind: "wait", run: waiting, attempts: nextAttempt, retryAt };
	}
	if (label === "infeasible" && decisive) {
		const terminal = updateRun(
			store,
			decided,
			r => {
				r.status = "infeasible";
				delete r.waiting;
				delete r.wake;
			},
			[{ kind: "driver.infeasible", data: { contextDigest, confidence, outcome, at: config.now() } }],
		);
		return { kind: "terminal", run: terminal };
	}
	const reasonText =
		label === "wait" && decisive
			? "Jev chose to wait; the same lifecycle material must not be resent"
			: "Jev did not decisively approve the lifecycle transition";
	const waiting = markWaiting(store, decided, "judge", reasonText, attempts + 1, undefined, config.now());
	try {
		const held = recordRefusalHold(
			store,
			waiting,
			refusalMaterialDigest(store, waiting, { scope: fencingScope, intentIds, prior: priorChild }, observations),
			reasonText,
			decisionId,
			config.now(),
		);
		return { kind: "blocked", run: held, reason: reasonText };
	} catch {
		// The refusal itself is durable; without a hold event a later resume may ask again.
		return { kind: "blocked", run: waiting, reason: reasonText };
	}
}

async function waitForChild(
	child: ActiveChild,
	signal: AbortSignal,
	maxMs: number,
): Promise<{ kind: "exit"; code: number } | { kind: "stopped" } | { kind: "deadline" } | { kind: "poll" }> {
	if (signal.aborted) return { kind: "stopped" };
	return new Promise<{ kind: "exit"; code: number } | { kind: "stopped" } | { kind: "deadline" } | { kind: "poll" }>(resolveWait => {
		let finished = false;
		const finish = (
			value: { kind: "exit"; code: number } | { kind: "stopped" } | { kind: "deadline" } | { kind: "poll" },
		): void => {
			if (finished) return;
			finished = true;
			signal.removeEventListener("abort", onAbort);
			clearTimeout(timer);
			resolveWait(value);
		};
		const onAbort = (): void => finish({ kind: "stopped" });
		const pollMs = Math.min(1_000, Math.max(0, maxMs));
		const timer = setTimeout(
			() => finish(maxMs <= 1_000 ? { kind: "deadline" } : { kind: "poll" }),
			pollMs,
		);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		child.exit.then(
			code => finish({ kind: "exit", code }),
			() => finish({ kind: "exit", code: -1 }),
		);
	});
}

async function superviseRun(
	store: AutonomyStore,
	initial: AutonomyRun,
	target: ChildTarget,
	config: SupervisorConfig,
	mode: "start" | "resume",
	signal: AbortSignal,
	capability: () => Promise<void>,
): Promise<DriverResult> {
	let run = initial;
	let active: ActiveChild | undefined;
	// A resumed wait keeps its durable attempt count, so backoff does not restart from zero.
	let waitAttempts = mode === "resume" ? (initial.waiting?.attempts ?? 0) : 0;
	let exitCode = 0;
	let reason: "initial startup" | "process loss recovery" | "rotation" =
		mode === "start" ? "initial startup" : "process loss recovery";
	// Every path that observes a terminal status exits through the same fence and receipt invariant.
	const terminalExit = async (terminal: AutonomyRun): Promise<DriverResult> => {
		const fenced = await fenceTerminalRun(store, terminal, capability, config.now());
		if (fenced.error !== undefined) {
			return {
				runId: fenced.run.id,
				status: fenced.run.status,
				exitCode: 1,
				message: `the terminal scope fence was not proved: ${fenced.error}`,
			};
		}
		return { runId: fenced.run.id, status: fenced.run.status, exitCode: 0 };
	};
	try {
		while (true) {
			if (signal.aborted) {
				const result = await cancellationResult(store, run, stopReason(signal), active, capability);
				active = undefined;
				return result;
			}
			run = store.read(run.id);
			if (isTerminal(run.status)) {
				if (active !== undefined) {
					const stopped = await stopActiveChild(store, run, active, capability, config.now());
					active = undefined;
					if (!stopped.quiet) {
						return {
							runId: run.id,
							status: run.status,
							exitCode: 1,
							message: stopped.error ?? "the child scope could not be proven empty",
						};
					}
				}
				const exited = await terminalExit(run);
				if (exited.exitCode !== 0) return exited;
				run = store.read(run.id);
				if (lifecycleLaunches(run).some(entry => !lifecycleIntentIsFenced(run, entry.id))) {
					return {
						runId: run.id,
						status: run.status,
						exitCode: 1,
						message: "a lifecycle launch intent is not covered by a positive fence receipt; its executor stays unknown",
					};
				}
				return exited;
			}
			const deadline = run.createdAt + run.policy.maxRuntimeMs;
			const remaining = deadline - config.now();
			if (remaining <= 0) {
				if (active !== undefined) {
					const stopped = await stopActiveChild(store, run, active, capability, config.now());
					active = undefined;
					if (!stopped.quiet) {
						return {
							runId: stopped.run.id,
							status: stopped.run.status,
							exitCode: 1,
							message: stopped.error ?? "the child scope could not be proven empty",
						};
					}
					run = stopped.run;
				} else if (run.scope !== undefined || lifecycleLaunches(run).length > 0) {
					// The budget blocks development, not containment: fence every stored candidate first.
					try {
						const fenced = await fenceRunScope(store, run, {
							terminal: false,
							capability,
							now: config.now(),
							requireReceipt: true,
						});
						run = fenced.run;
						if (!fenced.recorded) {
							return {
								runId: fenced.run.id,
								status: fenced.run.status,
								exitCode: 1,
								message: "the runtime budget is exhausted and a prior scope receipt was not committed",
							};
						}
					} catch (error) {
						const waiting = markWaiting(
							store,
							run,
							"fencing",
							`the runtime budget is exhausted; the prior execution could not be positively fenced: ${messageOf(error)}`,
							waitAttempts,
							undefined,
							config.now(),
						);
						return { runId: waiting.id, status: waiting.status, exitCode: 4, message: waiting.waiting?.reason };
					}
				}
				const waiting = markWaiting(
					store,
					run,
					"resource",
					"the run runtime budget is exhausted; the run remains unapproved and resumable",
					waitAttempts,
					undefined,
					config.now(),
				);
				return {
					runId: waiting.id,
					status: waiting.status,
					exitCode: 3,
					message: waiting.waiting?.reason ?? "runtime budget exhausted",
				};
			}

			if (active !== undefined) {
				const observation = await waitForChild(active, signal, remaining);
				if (observation.kind === "stopped") {
					const child = active;
					active = undefined;
					const result = await cancellationResult(store, run, stopReason(signal), child, capability);
					return result;
				}
				if (observation.kind === "poll") {
					run = store.read(run.id);
					if (isTerminal(run.status)) {
						const stopped = await stopActiveChild(store, run, active, capability, config.now());
						active = undefined;
						return {
							runId: run.id,
							status: run.status,
							exitCode: stopped.quiet ? 0 : 1,
							...(stopped.quiet ? {} : { message: stopped.error ?? "the child scope could not be proven empty" }),
						};
					}
					if (run.waiting?.kind === "rotation_requested") {
						if (!(await childIsSettled(active))) continue;
						const child = active;
						active = undefined;
						const stopped = await stopActiveChild(store, run, child, capability, config.now());
						if (!stopped.quiet) {
							const waiting = markWaiting(
								store,
								stopped.run,
								"fencing",
								`rotation could not prove the current scope empty: ${stopped.error ?? "quiescence unavailable"}`,
								waitAttempts,
								undefined,
								config.now(),
							);
							return { runId: waiting.id, status: waiting.status, exitCode: 4, message: waiting.waiting?.reason };
						}
						const code = await child.exit.catch(() => -1);
						run = updateRun(
							store,
							stopped.run,
							current => {
								current.status = "recovering";
								delete current.waiting;
								delete current.wake;
							},
							[
								{
									kind: "driver.rotation",
									data: {
										pid: child.identity.pid,
										group: child.identity.group,
										code,
										settled: true,
										at: config.now(),
									},
								},
							],
						);
						reason = "rotation";
						continue;
					}
					continue;
				}
				if (observation.kind === "deadline") {
					const stopped = await stopActiveChild(store, run, active, capability, config.now());
					active = undefined;
					if (!stopped.quiet) {
						return {
							runId: stopped.run.id,
							status: stopped.run.status,
							exitCode: 1,
							message: stopped.error ?? "the child scope could not be proven empty",
						};
					}
					const waiting = markWaiting(
						store,
						stopped.run,
						"resource",
						"the run runtime budget is exhausted; the run remains unapproved and resumable",
						waitAttempts,
						undefined,
						config.now(),
					);
					return {
						runId: waiting.id,
						status: waiting.status,
						exitCode: 3,
						message: waiting.waiting?.reason ?? "runtime budget exhausted",
					};
				}
				const child = active;
				active = undefined;
				exitCode = observation.code;
				child.channel.close(new Error("child exited"));
				if (config.lifecycleRace?.afterChildExit !== undefined) {
					await config.lifecycleRace.afterChildExit();
				}
				run = store.read(run.id);
				if (isTerminal(run.status)) return await terminalExit(run);
				try {
					run = updateRun(
						store,
						run,
						current => {
							current.status = "recovering";
							delete current.waiting;
							delete current.wake;
						},
						[
							{
								kind: "driver.child_exit",
								data: {
									pid: child.identity.pid,
									group: child.identity.group,
									code: observation.code,
									at: config.now(),
								},
							},
						],
					);
				} catch (error) {
					const latest = store.read(run.id);
					if (isTerminal(latest.status)) return await terminalExit(latest);
					throw error;
				}
				reason = "process loss recovery";
				if (signal.aborted) {
					return await cancellationResult(store, run, stopReason(signal), undefined, capability);
				}
				run = store.read(run.id);
				if (isTerminal(run.status)) return await terminalExit(run);
			}

			const recovery = await recoverRun(
				store,
				run,
				target,
				config,
				signal,
				waitAttempts,
				reason,
				capability,
			);
			if (recovery.kind === "launched") {
				run = recovery.run;
				active = recovery.child;
				waitAttempts = 0;
				reason = "process loss recovery";
				continue;
			}
			if (recovery.kind === "terminal") {
				// A terminal result produced by recoverRun's first read can race a concurrent cancel;
				// it is not containment proof. Fence, then require every lifecycle intent receipt.
				const exited = await terminalExit(recovery.run);
				if (exited.exitCode !== 0) return exited;
				const latest = store.read(recovery.run.id);
				if (lifecycleLaunches(latest).some(entry => !lifecycleIntentIsFenced(latest, entry.id))) {
					return {
						runId: latest.id,
						status: latest.status,
						exitCode: 1,
						message: "a lifecycle launch intent is not covered by a positive fence receipt; its executor stays unknown",
					};
				}
				return exited;
			}
			if (recovery.kind === "stopped") {
				return await cancellationResult(store, recovery.run, stopReason(signal), undefined, capability);
			}
			if (recovery.kind === "lost") {
				return {
					runId: recovery.run.id,
					status: recovery.run.status,
					exitCode: 2,
					message: "ownership was lost to another supervisor",
				};
			}
			if (recovery.kind === "blocked") {
				return {
					runId: recovery.run.id,
					status: recovery.run.status,
					exitCode: 4,
					message: recovery.reason,
				};
			}
			waitAttempts = recovery.attempts;
			reason = "process loss recovery";
			const sleepMs = Math.max(0, Math.min(recovery.retryAt - config.now(), deadline - config.now()));
			if (sleepMs > 0 && !(await config.sleep(sleepMs, signal))) {
				return await cancellationResult(store, recovery.run, stopReason(signal), undefined, capability);
			}
		}
	} catch (error) {
		if (active !== undefined) {
			await stopActiveChild(store, run, active, capability, config.now()).catch(() => undefined);
			active = undefined;
		}
		let status: AutonomyStatus = "recovering";
		try {
			const latest = store.read(run.id);
			status = latest.status;
			if (isTerminal(status)) return await terminalExit(latest);
		} catch {
			// Keep the last known status.
		}
		return {
			runId: run.id,
			status,
			exitCode: exitCode === 0 ? 1 : exitCode,
			message: messageOf(error),
		};
	}
}

/** Open the store and turn the produced run into the CLI result shape. */
function dependenciesOf(deps: DriverDependencies | undefined): {
	judge: Judge;
	now: () => number;
	sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
	signal: AbortSignal;
} {
	const controller = new AbortController();
	return {
		judge:
			deps?.judge ??
			createTypeSafeJudge({
				resolveKey: memoizedApiKeyResolver(process.env),
				model: POLICY.defaultModel,
			}),
		now: deps?.now ?? Date.now,
		sleep: deps?.sleep ?? delay,
		signal: deps?.signal ?? controller.signal,
	};
}

/** Create, claim and supervise a fresh run. The objective and policy are read before any side effect. */
export async function startAutonomyRun(
	options: StartAutonomyOptions,
	deps?: DriverDependencies,
): Promise<DriverResult> {
	requireLinuxProcessModel();
	const storePath = resolve(options.store ?? defaultAutonomyStorePath());
	const policy = readPolicyFile(options.policyFile);
	const objective = readObjectiveFile(options.objectiveFile, policy.maxContextBytes);
	const dependencies = dependenciesOf(deps);
	const capability = deps?.scopeCapability ?? checkAutonomyScopeCapability;
	if (dependencies.signal.aborted) throw new Error("start was cancelled before any run was created");
	try {
		await capability();
	} catch (error) {
		throw new Error(`autonomous scope capability is unavailable: ${messageOf(error)}`);
	}
	const store = openAutonomyStore(storePath);
	try {
		const me = processIdentity();
		if (me === null) throw new Error("the supervisor identity is unavailable");
		const created = store.create(objective, policy);
		const run = store.claim(created.id, me);
		// One committed canonical policy decides cwd, so the initial launch matches every resume and
		// replacement that reads the stored run. The parsed file order is not a second authority.
		const target = childTarget(run.policy, options.omp, options.model);
		return await superviseRun(
			store,
			run,
			target,
			{
				storePath,
				now: dependencies.now,
				sleep: dependencies.sleep,
				judge: dependencies.judge,
				startupAckTimeoutMs: deps?.startupAckTimeoutMs ?? STARTUP_ACK_TIMEOUT_MS,
				lifecycleRace: deps?.lifecycleRace,
			},
			"start",
			dependencies.signal,
			capability,
		);
	} finally {
		store.close();
	}
}

/** Claim an existing nonterminal run and supervise recovery without changing its objective or policy. */
export async function resumeAutonomyRun(
	options: ResumeAutonomyOptions,
	deps?: DriverDependencies,
): Promise<DriverResult> {
	requireLinuxProcessModel();
	const storePath = resolve(options.store ?? defaultAutonomyStorePath());
	if (!existsSync(storePath)) throw new Error(`the autonomy store does not exist: ${storePath}`);
	const dependencies = dependenciesOf(deps);
	const capability = deps?.scopeCapability ?? checkAutonomyScopeCapability;
	const store = openAutonomyStore(storePath);
	try {
		const me = processIdentity();
		if (me === null) throw new Error("the supervisor identity is unavailable");
		const current = store.read(options.run);
		if (isTerminal(current.status)) {
			return { runId: current.id, status: current.status, exitCode: 0, message: "the run is already terminal" };
		}
		const target = childTarget(current.policy, options.omp, options.model);
		const claimed = store.claim(current.id, me);
		return await superviseRun(
			store,
			claimed,
			target,
			{
				storePath,
				now: dependencies.now,
				sleep: dependencies.sleep,
				judge: dependencies.judge,
				startupAckTimeoutMs: deps?.startupAckTimeoutMs ?? STARTUP_ACK_TIMEOUT_MS,
				lifecycleRace: deps?.lifecycleRace,
			},
			"resume",
			dependencies.signal,
			capability,
		);
	} finally {
		store.close();
	}
}

/** Read one run or the run list without creating a store or touching the checkpoint. */
export function statusAutonomy(options: { store?: string; run?: string }): AutonomySummary[] {
	const storePath = resolve(options.store ?? defaultAutonomyStorePath());
	if (!existsSync(storePath)) throw new Error(`the autonomy store does not exist: ${storePath}`);
	const store = openAutonomyStore(storePath);
	try {
		if (options.run !== undefined) return [summaryOf(store.read(options.run))];
		return store.list().map(summaryOf);
	} finally {
		store.close();
	}
}

/**
 * Operator stop: commit cancellation first (when possible), then positively fence the whole owned
 * scope and stop a live separate supervisor. A storage failure is reported and never acknowledged
 * as durable; safety control never consults Jev.
 */
export async function stopAutonomy(
	options: {
		store?: string;
		run: string;
		reason?: string;
	},
	deps?: { scopeCapability?: () => Promise<void> },
): Promise<DriverResult> {
	const storePath = resolve(options.store ?? defaultAutonomyStorePath());
	const reason = options.reason?.trim() || "operator stop";
	const capability = deps?.scopeCapability ?? checkAutonomyScopeCapability;
	if (!existsSync(storePath)) throw new Error(`the autonomy store does not exist: ${storePath}`);
	const store = openAutonomyStore(storePath);
	let run: AutonomyRun;
	try {
		run = store.read(options.run);
	} catch (error) {
		store.close();
		throw error;
	}
	let durable = false;
	let cancelFailure: string | undefined;
	let stoppedChild = true;
	const alreadyTerminal = isTerminal(run.status);
	try {
		if (!alreadyTerminal) {
			try {
				run = store.cancel(run.id, reason);
				durable = true;
			} catch (error) {
				cancelFailure = `the cancellation was not committed: ${messageOf(error)}`;
			}
		} else {
			durable = run.status === "cancelled";
			if (!durable) cancelFailure = `the run is already ${run.status}`;
		}
		if (run.scope !== undefined || lifecycleLaunches(run).length > 0) {
			try {
				const fenced = await fenceRunScope(store, run, {
					terminal: isTerminal(run.status),
					capability,
					now: Date.now(),
				});
				run = fenced.run;
				if (!fenced.recorded) {
					stoppedChild = false;
					cancelFailure = `${cancelFailure ?? "a complete containment receipt was not committed"}; the stored scope is not fully proved`;
				}
			} catch (error) {
				stoppedChild = false;
				cancelFailure = `${cancelFailure ?? "the stored scope could not be positively fenced"}: ${messageOf(error)}`;
			}
		}
		const unresolved = lifecycleLaunches(run).some(entry => !lifecycleIntentIsFenced(run, entry.id));
		if (unresolved) {
			stoppedChild = false;
			cancelFailure = `${cancelFailure ?? "a lifecycle launch intent is not covered by a positive fence receipt"}; its executor stays unknown`;
		}
		if (!alreadyTerminal && run.owner !== undefined) {
			const me = processIdentity();
			if (me !== null && !sameIdentity(run.owner, me)) {
				try {
					if (processState(run.owner) === true) signalVerifiedProcess(run.owner, "SIGTERM");
				} catch {
					// The supervisor observes the committed terminal state and stops itself.
				}
			}
		}
	} finally {
		store.close();
	}
	let finalStatus = (durable ? "cancelled" : run.status) as AutonomyStatus;
	try {
		finalStatus = storeStatus(options.run, storePath);
	} catch {
		// Keep the last committed or readable projection.
	}
	return {
		runId: run.id,
		status: finalStatus,
		exitCode: (durable || alreadyTerminal) && stoppedChild ? 0 : 1,
		durableCancellation: durable,
		...(cancelFailure === undefined ? {} : { message: cancelFailure }),
	};
}

function storeStatus(runId: string, storePath: string): AutonomyStatus {
	const store = openAutonomyStore(storePath);
	try {
		return store.read(runId).status;
	} finally {
		store.close();
	}
}

function usage(): string {
	return [
		"usage:",
		"  bun autonomy/driver.ts start --objective <file> --policy <file> [--store <db>] [--omp <exe>] [--model <id>]",
		"  bun autonomy/driver.ts resume --run <id> [--store <db>] [--omp <exe>] [--model <id>]",
		"  bun autonomy/driver.ts status [--run <id>] [--store <db>]",
		"  bun autonomy/driver.ts stop --run <id> [--reason <text>] [--store <db>]",
	].join("\n");
}

function parseCli(argv: readonly string[]): { ok: true; args: CliArguments } | { ok: false; error: string } {
	const command = argv[0];
	if (command === "--help" || command === "-h" || command === "help") {
		return {
			ok: true,
			args: { command: "status", help: true },
		};
	}
	if (command !== "start" && command !== "resume" && command !== "status" && command !== "stop") {
		return { ok: false, error: command === undefined ? "missing command" : `unknown command: ${command}` };
	}
	const result: CliArguments = { command, help: false };
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === undefined) continue;
		if (token === "--help" || token === "-h") {
			result.help = true;
			continue;
		}
		if (!token.startsWith("--")) return { ok: false, error: `unexpected argument: ${token}` };
		const equals = token.indexOf("=");
		const name = equals >= 0 ? token.slice(0, equals) : token;
		const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
		const takeValue = (): string | undefined => {
			if (inline !== undefined) return inline;
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) return undefined;
			index += 1;
			return next;
		};
		switch (name) {
			case "--store": {
				const value = takeValue();
				if (value === undefined) return { ok: false, error: "--store requires a value" };
				result.store = value;
				break;
			}
			case "--run": {
				const value = takeValue();
				if (value === undefined) return { ok: false, error: "--run requires a value" };
				result.run = value;
				break;
			}
			case "--objective": {
				const value = takeValue();
				if (value === undefined) return { ok: false, error: "--objective requires a value" };
				result.objective = value;
				break;
			}
			case "--policy": {
				const value = takeValue();
				if (value === undefined) return { ok: false, error: "--policy requires a value" };
				result.policy = value;
				break;
			}
			case "--omp": {
				const value = takeValue();
				if (value === undefined) return { ok: false, error: "--omp requires a value" };
				result.omp = value;
				break;
			}
			case "--model": {
				const value = takeValue();
				if (value === undefined) return { ok: false, error: "--model requires a value" };
				result.model = value;
				break;
			}
			case "--reason": {
				const value = takeValue();
				if (value === undefined) return { ok: false, error: "--reason requires a value" };
				result.reason = value;
				break;
			}
			default:
				return { ok: false, error: `unknown option: ${name}` };
		}
	}
	if (result.help) return { ok: true, args: result };
	if (result.command === "start") {
		if (result.objective === undefined) return { ok: false, error: "start requires --objective" };
		if (result.policy === undefined) return { ok: false, error: "start requires --policy" };
	}
	if (result.command === "resume" && result.run === undefined) {
		return { ok: false, error: "resume requires --run" };
	}
	if (result.command === "stop" && result.run === undefined) {
		return { ok: false, error: "stop requires --run" };
	}
	return { ok: true, args: result };
}

function attachOperatorControl(controller: AbortController): () => void {
	const disposeInput = (() => {
		if (!process.stdin.isTTY) return () => {};
		const lines = createInterface({ input: process.stdin, terminal: false });
		const onLine = (line: string): void => {
			const command = line.trim().toLowerCase();
			if (command === "stop" || command === "abort" || command === "q" || command === "quit" || command === "exit") {
				controller.abort("operator stop");
			}
		};
		lines.on("line", onLine);
		lines.on("close", () => controller.abort("operator terminal closed"));
		return () => lines.close();
	})();
	const onSignal = (signal: NodeJS.Signals): void => controller.abort(`operator stop (${signal})`);
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) process.once(signal, onSignal);
	return () => {
		for (const signal of signals) process.removeListener(signal, onSignal);
		disposeInput();
	};
}

/** CLI entry point used by `bun autonomy/driver.ts`; also callable from tests. */
export async function runAutonomyCli(argv: readonly string[], deps?: DriverDependencies): Promise<number> {
	const parsed = parseCli(argv);
	if (!parsed.ok) {
		process.stderr.write(`${parsed.error}\n\n${usage()}\n`);
		return 2;
	}
	if (parsed.args.help) {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}
	const args = parsed.args;
	try {
		if (args.command === "status") {
			const rows = statusAutonomy({ ...(args.store === undefined ? {} : { store: args.store }), ...(args.run === undefined ? {} : { run: args.run }) });
			process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
			return 0;
		}
		if (args.command === "stop") {
			if (args.run === undefined) throw new Error("stop requires --run");
			const result = await stopAutonomy({
				...(args.store === undefined ? {} : { store: args.store }),
				run: args.run,
				...(args.reason === undefined ? {} : { reason: args.reason }),
			});
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			if (result.message !== undefined) process.stderr.write(`${result.message}\n`);
			return result.exitCode;
		}
		const controller = new AbortController();
		const disposeControl = attachOperatorControl(controller);
		try {
			const signal = deps?.signal ?? controller.signal;
			if (args.command === "start") {
				if (args.objective === undefined || args.policy === undefined) throw new Error("start requires --objective and --policy");
				const result = await startAutonomyRun(
					{
						...(args.store === undefined ? {} : { store: args.store }),
						objectiveFile: args.objective,
						policyFile: args.policy,
						...(args.omp === undefined ? {} : { omp: args.omp }),
						...(args.model === undefined ? {} : { model: args.model }),
					},
					{ ...(deps ?? {}), signal },
				);
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				if (result.message !== undefined) process.stderr.write(`${result.message}\n`);
				return result.exitCode;
			}
			if (args.run === undefined) throw new Error("resume requires --run");
			const result = await resumeAutonomyRun(
				{
					...(args.store === undefined ? {} : { store: args.store }),
					run: args.run,
					...(args.omp === undefined ? {} : { omp: args.omp }),
					...(args.model === undefined ? {} : { model: args.model }),
				},
				{ ...(deps ?? {}), signal },
			);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			if (result.message !== undefined) process.stderr.write(`${result.message}\n`);
			return result.exitCode;
		} finally {
			disposeControl();
		}
	} catch (error) {
		process.stderr.write(`${messageOf(error)}\n`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await runAutonomyCli(process.argv.slice(2)));
}
