#!/usr/bin/env bun
/**
 * Real-host autonomy smoke for the strict autonomous coordinator.
 *
 * Unlike `live-smoke.ts` this never runs the model inside the harness process. It drives the real
 * `autonomy/driver.ts` CLI as a Bun subprocess - the same `omp --mode rpc --no-extensions -e
 * autonomy/index.ts` path a deployment uses - against a temporary private SQLite store and a temporary
 * workspace, and reads the committed run, journal and artifacts back through the real
 * `openAutonomyStore`. Every scenario asserts status, ledger, bytes, process and admission facts;
 * nothing is faked, and a missing real host/provider is a stated prerequisite (exit 78), never a
 * pass. The deterministic storage/driver/coordinator behavior lives in the unit tests; this file
 * only exercises what needs a real omp, a real judge and real processes.
 *
 *   bun tools/autonomy-smoke.ts [--scenario all|list|name,...] [--model ID] [--omp PATH]
 *                               [--deadline SECONDS] [--out DIR] [--keep] [--list]
 *
 * Evidence (summary, observed transitions, bounded journal, CLI output, final state) is persisted
 * under the output directory and printed with the matrix. The crash kills only the supervisor and
 * the OMP leader and leaves detached native work alive; the production driver must fence the whole
 * observed systemd scope before any reconciliation or new effect. Manual descendant/group kills are
 * final cleanup only, and are recorded as such. No secret, no publication and no write into the
 * user's project.
 */
import { accessSync, appendFileSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { memoizedApiKeyResolver } from "../src/apikey.js";
import {
	assertAutonomyScope,
	autonomyBootId,
	autonomyScopeEmpty,
	fenceAutonomyScope,
	type AutonomyScope,
	type AutonomyScopeFence,
} from "../autonomy/scope.js";
import {
	openAutonomyStore,
	processAlive,
	processGroupAlive,
	processIdentity,
	type AutonomyEvent,
	type AutonomyPolicy,
	type AutonomyRun,
	type AutonomyStore,
} from "../autonomy/store.js";
import { acceptanceAt } from "../src/state.js";
import {
	exactCommandCalls,
	exactTargetRecords,
	receiptCovering,
	sameScope,
	scopeBrief,
	terminalScopeProof,
} from "./autonomy-smoke-oracles.js";

/* -------------------------------------------------------------------------------------------------
 * Constants and fixture bytes
 * ---------------------------------------------------------------------------------------------- */

const CHECKOUT = resolve(import.meta.dir, "..");
const DRIVER = join(CHECKOUT, "autonomy", "driver.ts");
const ENTRY = join(CHECKOUT, "autonomy", "index.ts");
const BUN = process.execPath;

const COMPLETION_BYTES = "jev-autonomy-smoke-v1\n";
const CRASH_MARKER_BYTES = "jev-autonomy-crash-marker-v1\n";
const CRASH_EFFECT_BYTES = "jev-autonomy-crash-effect-v1\n";
const NOTES_BYTES = "startup-context-ok\n";
const CANCEL_BYTES = "jev-autonomy-cancel-v1\n";
const ASYNC_BYTES = "jev-autonomy-async-v1\n";

const DEFAULT_DEADLINE_SECONDS = 1200;
const MAX_EVIDENCE_STRING = 8000;
const MAX_EVIDENCE_ARRAY = 100;
const MAX_EVIDENCE_DEPTH = 6;
const MAX_EVIDENCE_LINE = 32 * 1024;
const SECRET_KEY = /(^|[-_.])(api[-_]?key|key|token|secret|password|passphrase|authorization|credential|cookie)/i;
const LAUNCH_KINDS: Record<string, true> = {
	"driver.launch_intent": true,
	"driver.launch_spawned": true,
	"driver.ready": true,
	bind_child: true,
	bind_session: true,
	claim: true,
};
/** The store's terminal statuses: the driver has already fenced the whole executor scope. */
const TERMINAL_RUN_STATUS: Record<string, true> = { completed: true, cancelled: true, infeasible: true };

/* -------------------------------------------------------------------------------------------------
 * Small typed helpers
 * ---------------------------------------------------------------------------------------------- */

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Compact JSON text for a comparison or a check detail; never undefined. */
function show(value: unknown): string {
	return JSON.stringify(value ?? null) ?? "null";
}

/** Indented JSON text for a persisted fixture; never undefined. */
function showPretty(value: unknown): string {
	return JSON.stringify(value ?? null, null, 2) ?? "null";
}

/** Bound one JSON-shaped value for evidence: short strings, short arrays, shallow objects. */
function bound(value: unknown, depth = 0): unknown {
	if (depth > MAX_EVIDENCE_DEPTH) return "[max-depth]";
	if (typeof value === "string") {
		if (value.length <= MAX_EVIDENCE_STRING) return value;
		return `${value.slice(0, MAX_EVIDENCE_STRING)}...[truncated ${value.length - MAX_EVIDENCE_STRING} chars]`;
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_EVIDENCE_ARRAY).map(item => bound(item, depth + 1));
		if (value.length > MAX_EVIDENCE_ARRAY) items.push(`...[truncated ${value.length - MAX_EVIDENCE_ARRAY} items]`);
		return items;
	}
	const record = asRecord(value);
	if (record === undefined) return String(value);
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		result[key] = SECRET_KEY.test(key) ? "[redacted]" : bound(entry, depth + 1);
	}
	return result;
}

/** Append one bounded JSON line, never letting a single line exceed the evidence cap. */
function appendBoundedLine(file: string, value: unknown): void {
	const line = show(bound(value));
	if (line.length <= MAX_EVIDENCE_LINE) {
		appendFileSync(file, `${line}\n`, "utf8");
		return;
	}
	appendFileSync(
		file,
		`${show({ truncatedLine: true, chars: line.length, preview: line.slice(0, MAX_EVIDENCE_LINE - 512) })}\n`,
		"utf8",
	);
}

function writeBoundedJson(file: string, value: unknown): void {
	writeFileSync(file, `${showPretty(bound(value))}\n`, "utf8");
}

function fileHex(file: string): string | undefined {
	try {
		return sha256Hex(readFileSync(file));
	} catch {
		return undefined;
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** A stored intent payload's scope, validated field by field before it is compared. */
function payloadScope(value: unknown): AutonomyScope | undefined {
	const record = asRecord(value);
	if (record === undefined) return undefined;
	const { runId, epoch, unit, bootId, controlGroup, device, inode, invocationId } = record;
	if (
		typeof runId !== "string" ||
		typeof epoch !== "number" ||
		typeof unit !== "string" ||
		typeof bootId !== "string" ||
		typeof controlGroup !== "string" ||
		typeof device !== "string" ||
		typeof inode !== "string" ||
		typeof invocationId !== "string"
	) {
		return undefined;
	}
	return { runId, epoch, unit, bootId, controlGroup, device, inode, invocationId };
}

/* -------------------------------------------------------------------------------------------------
 * CLI options and scenario registry
 * ---------------------------------------------------------------------------------------------- */

interface Options {
	scenarios: string;
	model?: string;
	omp?: string;
	deadlineSeconds: number;
	out?: string;
	keep: boolean;
	list: boolean;
}

interface ScenarioDefinition {
	name: string;
	purpose: string;
	run: (ctx: ScenarioContext) => Promise<void>;
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = { scenarios: "all", deadlineSeconds: DEFAULT_DEADLINE_SECONDS, keep: false, list: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		const value = (): string => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
			index += 1;
			return next;
		};
		if (arg === "--scenario") {
			options.scenarios = value();
			continue;
		}
		if (arg === "--model") {
			const model = value().trim();
			if (model.length === 0) throw new Error("--model must not be empty");
			options.model = model;
			continue;
		}
		if (arg === "--omp") {
			const omp = value().trim();
			if (omp.length === 0) throw new Error("--omp must not be empty");
			options.omp = omp;
			continue;
		}
		if (arg === "--deadline") {
			const raw = value();
			const seconds = Number(raw);
			if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("--deadline must be a positive whole number of seconds");
			options.deadlineSeconds = seconds;
			continue;
		}
		if (arg === "--out") {
			options.out = value();
			continue;
		}
		if (arg === "--keep") {
			options.keep = true;
			continue;
		}
		if (arg === "--list") {
			options.list = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			options.list = true;
			continue;
		}
		throw new Error(`unknown argument '${arg}'`);
	}
	return options;
}

function usage(): string {
	return [
		"usage: bun tools/autonomy-smoke.ts [options]",
		"  --scenario all|list|name,...  scenarios to run (default all)",
		"  --model ID                    native model id passed to the driver",
		"  --omp PATH                    real omp executable (no fallback)",
		"  --deadline SECONDS            per-scenario wall clock budget (default 1200)",
		"  --out DIR                     evidence root (default a fresh temp directory)",
		"  --keep                        also copy the real omp session file into evidence",
		"  --list                        list scenarios and the deterministic matrix, run nothing",
	].join("\n");
}

/** Deterministic coverage that this live harness deliberately does not repeat. */
const DETERMINISTIC_ROWS: Array<{ scenario: string; coverage: string; evidence: string }> = [
	{
		scenario: "SQLite transaction, checksum, rollback, reservation and access fencing",
		coverage: "deterministic",
		evidence: "tests/autonomyStore.test.ts",
	},
	{
		scenario: "rpc frame bounds, launch/ready/session binding, fencing, judge recovery and lifecycle",
		coverage: "deterministic",
		evidence: "tests/autonomyDriver.test.ts",
	},
	{
		scenario: "context origin, stale results, wake loss, artifact restore and bounded stop",
		coverage: "deterministic",
		evidence: "tests/autonomy.test.ts",
	},
	{
		scenario: "exactly-once external effects",
		coverage: "not claimed",
		evidence: "the crash scenario claims unknown-effect containment and exact local bytes only",
	},
];

/* -------------------------------------------------------------------------------------------------
 * Evidence recording
 * ---------------------------------------------------------------------------------------------- */

interface CheckEntry {
	name: string;
	ok: boolean;
	detail?: string;
}

interface Recorder {
	snapshots: string;
	cliDir: string;
	cliCount: number;
}

interface SupervisorHandle {
	command: string;
	display: string;
	pid: number;
	result: Promise<CommandResult>;
	finished: boolean;
	recorded: boolean;
}

interface ScenarioContext {
	dir: string;
	workspace: string;
	storePath: string;
	policy: AutonomyPolicy;
	policyFile: string;
	objectiveFile: string;
	options: Options;
	deadlineMs: number;
	rec: Recorder;
	checks: CheckEntry[];
	supervisors: SupervisorHandle[];
	childGroups: Set<number>;
	trackedProcesses: ObservedProcess[];
}

function createRecorder(dir: string): Recorder {
	const cliDir = join(dir, "cli");
	mkdirSync(cliDir, { recursive: true });
	return { snapshots: join(dir, "snapshots.jsonl"), cliDir, cliCount: 0 };
}

function recordSnapshot(ctx: ScenarioContext, snapshot: Snapshot): void {
	appendBoundedLine(ctx.rec.snapshots, {
		at: Date.now(),
		sequence: snapshot.run.sequence,
		status: snapshot.run.status,
		epoch: snapshot.run.epoch,
		generation: snapshot.run.generation,
		child: snapshot.run.child ?? null,
		sessionId: snapshot.run.session?.id ?? null,
		wake: snapshot.run.wake ?? null,
		waiting: snapshot.run.waiting ?? null,
		pending: Object.keys(snapshot.run.pending),
		artifacts: Object.keys(snapshot.run.artifacts),
		judgeCalls: snapshot.run.judgeCalls,
		executorCalls: snapshot.run.executorCalls,
		checkRevision: snapshot.run.checkpoint.revision,
		checkActions: snapshot.run.checkpoint.actions?.length ?? 0,
	});
}

function recordCli(ctx: ScenarioContext, result: CommandResult): void {
	ctx.rec.cliCount += 1;
	const file = join(ctx.rec.cliDir, `${String(ctx.rec.cliCount).padStart(2, "0")}-${result.command.replace(/[^a-z0-9]+/gi, "-")}.json`);
	writeBoundedJson(file, {
		command: result.command,
		display: result.display,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		durationMs: result.durationMs,
		stdout: result.stdout,
		stderr: result.stderr,
	});
}

function check(ctx: ScenarioContext, name: string, condition: boolean, detail?: string): void {
	const entry: CheckEntry = { name, ok: condition, ...(detail === undefined ? {} : { detail: bound(detail) as string }) };
	ctx.checks.push(entry);
	if (!condition) throw new Error(`check failed: ${name}${detail === undefined ? "" : ` - ${detail}`}`);
}

/* -------------------------------------------------------------------------------------------------
 * Processes: driver CLI, supervisor, kill groups
 * ---------------------------------------------------------------------------------------------- */

interface CommandResult {
	command: string;
	display: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	durationMs: number;
}

interface SpawnedProcess {
	pid: number;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}

function spawnProcess(args: string[], cwd: string): SpawnedProcess {
	const proc = Bun.spawn(args, {
		cwd,
		env: { ...process.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	return {
		pid: proc.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited: proc.exited,
	};
}

/** SIGKILL a process group (falling back to the leader pid). The leader must be a group leader. */
function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 1) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}

/** A group whose liveness cannot be read is treated as alive, so cleanup still tries to kill it. */
function groupAliveForCleanup(group: number): boolean {
	try {
		return processGroupAlive(group);
	} catch {
		return true;
	}
}

async function awaitGroupGone(group: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (!processGroupAlive(group)) return true;
		} catch {
			return false;
		}
		await Bun.sleep(100);
	}
	return false;
}

async function runProcess(
	args: string[],
	options: { cwd: string; timeoutMs: number; command: string; display: string },
): Promise<CommandResult> {
	const startedAt = Date.now();
	const proc = spawnProcess(args, options.cwd);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(proc.pid);
	}, options.timeoutMs);
	try {
		const [stdout, stderr, exitCode] = (await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])) as [string, string, number];
		return {
			command: options.command,
			display: options.display,
			stdout,
			stderr,
			exitCode,
			timedOut,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		clearTimeout(timer);
	}
}

async function runCli(ctx: ScenarioContext, command: string, extra: string[], timeoutMs: number): Promise<CommandResult> {
	const args = [BUN, DRIVER, command, "--store", ctx.storePath, ...extra];
	const result = await runProcess(args, {
		cwd: CHECKOUT,
		timeoutMs,
		command,
		display: args.map(part => (part.includes(" ") ? show(part) : part)).join(" "),
	});
	recordCli(ctx, result);
	return result;
}

function nativeArgs(ctx: ScenarioContext): string[] {
	const args: string[] = [];
	if (ctx.options.omp !== undefined) args.push("--omp", ctx.options.omp);
	if (ctx.options.model !== undefined) args.push("--model", ctx.options.model);
	return args;
}

function spawnSupervisor(ctx: ScenarioContext, command: "start" | "resume", extra: string[], hardTimeoutMs: number): SupervisorHandle {
	const args = [BUN, DRIVER, command, "--store", ctx.storePath, ...extra];
	const display = args.map(part => (part.includes(" ") ? show(part) : part)).join(" ");
	const startedAt = Date.now();
	const proc = spawnProcess(args, CHECKOUT);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(proc.pid);
	}, hardTimeoutMs);
	const result: Promise<CommandResult> = (
		Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]) as Promise<[string, string, number]>
	).then(
		([stdout, stderr, exitCode]) => ({
			command,
			display,
			stdout,
			stderr,
			exitCode,
			timedOut,
			durationMs: Date.now() - startedAt,
		}),
		error => ({
			command,
			display,
			stdout: "",
			stderr: messageOf(error),
			exitCode: -1,
			timedOut,
			durationMs: Date.now() - startedAt,
		}),
	);
	const handle: SupervisorHandle = { command, display, pid: proc.pid, result, finished: false, recorded: false };
	const markFinished = (): void => {
		handle.finished = true;
		clearTimeout(timer);
	};
	void result.then(markFinished, markFinished);
	ctx.supervisors.push(handle);
	return handle;
}

async function awaitResult(result: Promise<CommandResult>, timeoutMs: number, label: string): Promise<CommandResult> {
	const outcome = await Promise.race([
		result.then(value => ({ value })),
		Bun.sleep(timeoutMs).then(() => undefined),
	]);
	if (outcome === undefined) throw new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)}s`);
	return outcome.value;
}

/* -------------------------------------------------------------------------------------------------
 * Store observation
 * ---------------------------------------------------------------------------------------------- */

interface Snapshot {
	run: AutonomyRun;
	events: AutonomyEvent[];
}

function snapshotOf(storePath: string, runId: string): Snapshot {
	const store = openAutonomyStore(storePath);
	try {
		return { run: store.read(runId), events: store.events(runId) };
	} finally {
		store.close();
	}
}

function withStore<T>(storePath: string, action: (store: AutonomyStore) => T): T {
	const store = openAutonomyStore(storePath);
	try {
		return action(store);
	} finally {
		store.close();
	}
}

async function pollSnapshot(
	ctx: ScenarioContext,
	runId: string,
	label: string,
	timeoutMs: number,
	predicate: (snapshot: Snapshot) => boolean,
	intervalMs = 250,
): Promise<Snapshot> {
	const deadline = Date.now() + timeoutMs;
	let last: Snapshot | undefined;
	let lastSequence = -1;
	let lastError: string | undefined;
	while (Date.now() < deadline) {
		try {
			const snapshot = snapshotOf(ctx.storePath, runId);
			last = snapshot;
			if (snapshot.run.sequence !== lastSequence) {
				lastSequence = snapshot.run.sequence;
				recordSnapshot(ctx, snapshot);
			}
			if (predicate(snapshot)) return snapshot;
		} catch (error) {
			lastError = messageOf(error);
		}
		await Bun.sleep(intervalMs);
	}
	throw new Error(
		`${label} did not hold within ${Math.round(timeoutMs / 1000)}s; last status ${last?.run.status ?? "unavailable"}${
			lastError === undefined ? "" : `; last read error: ${lastError}`
		}`,
	);
}

async function waitForRunId(ctx: ScenarioContext, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(ctx.storePath)) {
			try {
				const runs = withStore(ctx.storePath, store => store.list());
				const first = runs[0];
				if (first !== undefined) return first.id;
			} catch {
				// Creation may be in flight; retry.
			}
		}
		await Bun.sleep(100);
	}
	throw new Error(`no autonomy run was created within ${Math.round(timeoutMs / 1000)}s`);
}

function lastEvent(events: AutonomyEvent[], kind: string): AutonomyEvent | undefined {
	return [...events].reverse().find(event => event.kind === kind);
}

function eventData(event: AutonomyEvent | undefined): Record<string, unknown> | undefined {
	return event === undefined ? undefined : asRecord(event.data);
}

function eventsAfter(events: AutonomyEvent[], sequence: number): AutonomyEvent[] {
	return events.filter(event => event.sequence > sequence);
}

function artifactUrls(run: AutonomyRun, name: string): string[] {
	return Object.keys(run.artifacts).filter(url => url === name || url === `local://${name}` || url.endsWith(`/${name}`));
}

function artifactHex(storePath: string, runId: string, url: string): string | undefined {
	const bytes = withStore(storePath, store => store.artifact(runId, url));
	return bytes === null ? undefined : sha256Hex(bytes);
}

function sessionFileExists(run: AutonomyRun): boolean {
	const file = run.session?.file;
	return typeof file === "string" && file.length > 0 && existsSync(file);
}

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

function completionObjective(): string {
	return [
		`Create the file autonomy-smoke.txt in the current workspace with exactly these bytes (UTF-8) and nothing else: ${show(COMPLETION_BYTES)}.`,
		`Verify it with the command \`sha256sum autonomy-smoke.txt\` and record the output as execution evidence. The expected SHA-256 is ${sha256Hex(COMPLETION_BYTES)}.`,
		`Also run \`wc -c autonomy-smoke.txt\`; it must report ${Buffer.byteLength(COMPLETION_BYTES, "utf8")} bytes.`,
		"Write a small Bun script verify-autonomy-smoke.ts that reads autonomy-smoke.txt and exits non-zero unless its bytes are exactly the expected ones, then run it with `bun run verify-autonomy-smoke.ts`.",
		"Keep project-file changes inside this workspace; use local:// for the private Jev plan and required workflow artifacts. Do not publish anything or install a service.",
		"Work autonomously with the normal Jev requirements, plan review and acceptance workflow: there is no human to answer questions, and this run must finish on its own.",
	].join("\n");
}

function startupObjective(): string {
	return [
		`Read the file notes.txt in the current workspace and confirm its only line is ${show(NOTES_BYTES)}.`,
		"Do not modify any project file and do not publish anything.",
		"Work autonomously with the normal Jev workflow; there is no human to answer questions.",
	].join("\n");
}

function cancelObjective(): string {
	return [
		`Create the file autonomy-cancel.txt in the current workspace with exactly these bytes (UTF-8): ${show(CANCEL_BYTES)}.`,
		"After the ordinary Jev plan approval, run exactly this shell command in the current workspace, in the foreground, without background jobs:",
		"sh cancel-effect.sh",
		"The workspace already contains cancel-effect.sh; do not rewrite or modify it. It writes autonomy-cancel.txt and then keeps running a long native effect.",
		`After it finishes, verify autonomy-cancel.txt contains exactly ${show(CANCEL_BYTES)}.`,
		"Keep project-file changes inside this workspace; use local:// for private Jev workflow artifacts. Do not publish anything.",
		"Work autonomously with the normal Jev workflow; there is no human to answer questions.",
	].join("\n");
}

function crashObjective(): string {
	return [
		`First create the session artifact local://crash-marker.txt with the \`write\` tool (path exactly local://crash-marker.txt) and exactly these bytes (UTF-8) and nothing else: ${show(CRASH_MARKER_BYTES)}. Checkpoint it through the ordinary Jev workflow and never rewrite it.`,
		"Then run exactly this shell command in the current workspace, in the foreground, without background jobs:",
		"sh crash-effect.sh",
		"The workspace already contains crash-effect.sh; do not rewrite or modify it. It writes crash-effect.txt and then keeps running a long native effect.",
		`After it finishes, verify crash-effect.txt contains exactly ${show(CRASH_EFFECT_BYTES)} and verify local://crash-marker.txt still has its exact bytes.`,
		"Then finish the task with the normal Jev requirements, plan review, acceptance and completion workflow.",
		"Keep project-file changes inside this workspace; use local:// for private Jev workflow artifacts. Do not publish anything or install a service. Work autonomously: there is no human to answer questions.",
	].join("\n");
}

function admissionObjective(): string {
	return [
		`Read the file notes.txt in the current workspace and report its only line ${show(NOTES_BYTES)}.`,
		"Do not modify any file and do not publish anything.",
		"Work autonomously with the normal Jev workflow; there is no human to answer questions.",
	].join("\n");
}

type AsyncDelivery = "native-wait" | "async-result";

function asyncObjective(delivery: AsyncDelivery): string {
	const settlement =
		delivery === "native-wait"
			? "Then call the `wait` tool exactly once for that background job id and use the terminal result it returns; do not end the task before that result."
			: "Do not call the `wait` tool and do not poll. End your reply immediately after the probe attempt and let the runtime wake you with the automatic async-result follow-up that carries the job's terminal result.";
	return [
		`Create the file async-effect.txt in the current workspace with exactly these bytes (UTF-8) and nothing else: ${show(ASYNC_BYTES)}.`,
		"The workspace already contains async-effect.sh; do not rewrite or modify it. It writes async-effect.txt, then runs a real native /usr/bin/sleep 70, then verifies its own bytes.",
		"After the ordinary Jev plan approval, run exactly this shell command in the current workspace, in the foreground, by calling the bash tool with the timeout parameter set to 120 and without backgrounding it yourself:",
		"sh async-effect.sh",
		"If the bash tool reports that the command was backgrounded as a job, do not claim completion. Immediately attempt exactly one probe call with the bash tool, `sh async-extra.sh`, and never retry it; the runtime must refuse that effect while the first one is unobserved. Apart from that single probe attempt, do not run any other consequential command until the native terminal result arrives.",
		settlement,
		`After the background result arrives, verify async-effect.txt contains exactly ${show(ASYNC_BYTES)} with \`sha256sum async-effect.txt\` and record the digest. The expected SHA-256 is ${sha256Hex(ASYNC_BYTES)}.`,
		"Keep project-file changes inside this workspace; use local:// for private Jev workflow artifacts. Do not publish anything.",
		"Work autonomously with the normal Jev workflow; there is no human to answer questions.",
	].join("\n");
}

/** A third script the objective asks for once the first call is backgrounded; the runtime must refuse it. */
function writeAsyncExtra(ctx: ScenarioContext): void {
	writeFileSync(join(ctx.workspace, "async-extra.sh"), "#!/bin/sh\nprintf 'jev-autonomy-async-extra-v1\\n' > async-extra.txt\n", "utf8");
}

/**
 * Write the executable fixture inside the authorized workspace. The objective's judged shell
 * command names only this relative script, so the policy can bound it to the root; the inspected
 * script bytes are what exec the real /usr/bin/sleep as a native detached descendant.
 */
function writeEffectScript(ctx: ScenarioContext, scriptName: string, effectName: string, bytes: string, sleepSeconds = 60): void {
	const literal = bytes.slice(0, -1);
	const script = [
		"#!/bin/sh",
		`printf '${literal}\\n' > ${effectName}`,
		`/usr/bin/sleep ${sleepSeconds}`,
		`test "$(cat ${effectName})" = '${literal}'`,
		"",
	].join("\n");
	writeFileSync(join(ctx.workspace, scriptName), script, "utf8");
}

function shellQuote(value: string): string {
	return `'${value.split("'").join("'\\''")}'`;
}

/** The real native host behind the smoke wrapper; a missing host is a stated prerequisite, not a pass. */
function resolveRealOmp(options: Options): string {
	const requested = options.omp?.trim();
	if (requested !== undefined && requested.length > 0) {
		const viaPath = Bun.which(requested);
		return realpathSync(viaPath ?? requested);
	}
	const found = Bun.which("omp");
	if (found === null || found.length === 0) throw new Error("the compaction scenario needs a real omp executable: pass --omp or put omp on PATH");
	return found;
}

/** Observations written by the smoke-only probe extension loaded through the existing --omp hook. */
function readProbeRecords(file: string): Array<Record<string, unknown>> {
	if (!existsSync(file)) return [];
	const records: Array<Record<string, unknown>> = [];
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const parsed = asRecord(parseJson(line));
		if (parsed !== undefined) records.push(parsed);
	}
	return records;
}

async function waitForProbe(
	file: string,
	label: string,
	predicate: (records: Array<Record<string, unknown>>) => boolean,
	timeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + timeoutMs;
	let last: Array<Record<string, unknown>> = [];
	while (Date.now() < deadline) {
		last = readProbeRecords(file);
		if (predicate(last)) return last;
		await Bun.sleep(250);
	}
	throw new Error(
		`${label} did not appear within ${Math.round(timeoutMs / 1000)}s; probe kinds: ${show(last.map(record => record["kind"] ?? null))}`,
	);
}

function sessionText(run: AutonomyRun): string | undefined {
	const file = run.session?.file;
	if (typeof file !== "string" || file.length === 0) return undefined;
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function sessionEntries(run: AutonomyRun): Array<Record<string, unknown>> {
	const text = sessionText(run);
	if (text === undefined) return [];
	const entries: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const parsed = asRecord(parseJson(line));
		if (parsed !== undefined) entries.push(parsed);
	}
	return entries;
}

/**
 * The probe only observes and triggers one real `ctx.compact`. It never writes a compaction entry,
 * never supplies instructions and never touches the runtime store or the production driver.
 */
function compactionProbeSource(logFile: string): string {
	return `import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const FILE = ${JSON.stringify(logFile)};
let turns = 0;
let armed = false;
let done = false;
let requests = 0;
let compacted = false;

function clip(value, max = 4000) {
	const text = typeof value === "string" ? value : String(value ?? "");
	return text.length <= max ? text : text.slice(0, max) + "...[truncated " + text.length + "]";
}
function sha(text) {
	return createHash("sha256").update(text).digest("hex");
}
function record(value) {
	try {
		appendFileSync(FILE, JSON.stringify(value) + "\\n");
	} catch {
		// Evidence only: a failed write never changes the session.
	}
}
function walk(value, visit, depth = 0) {
	if (depth > 8 || value === null || typeof value !== "object") return;
	visit(value);
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit, depth + 1);
		return;
	}
	for (const item of Object.values(value)) walk(item, visit, depth + 1);
}

export default function (pi) {
	pi.on("turn_end", event => {
		turns += 1;
		record({ kind: "turn_end", turns, turnIndex: event?.turnIndex ?? null });
	});
	pi.on("session_before_compact", event => {
		const preparation = event?.preparation ?? {};
		record({
			kind: "session_before_compact",
			firstKeptEntryId: preparation.firstKeptEntryId ?? null,
			messagesToSummarize: Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize.length : null,
			turnPrefixMessages: Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages.length : null,
			customInstructions: event?.customInstructions ?? null,
		});
	});
	pi.on("session.compacting", event => {
		record({
			kind: "session.compacting",
			sessionId: event?.sessionId ?? null,
			messages: Array.isArray(event?.messages) ? event.messages.length : null,
		});
	});
	pi.on("session_compact", event => {
		const entry = event?.compactionEntry ?? {};
		const summary = String(entry?.summary ?? "");
		compacted = true;
		record({
			kind: "session_compact",
			fromExtension: event?.fromExtension === true,
			entryType: entry?.type ?? null,
			summary: clip(summary),
			summarySha: sha(summary),
			summaryLength: summary.length,
			firstKeptEntryId: entry?.firstKeptEntryId ?? null,
			tokensBefore: entry?.tokensBefore ?? null,
		});
	});
	pi.on("auto_compaction_start", event => {
		record({ kind: "auto_compaction_start", action: event?.action ?? null, reason: event?.reason ?? null });
	});
	pi.on("auto_compaction_end", event => {
		record({
			kind: "auto_compaction_end",
			action: event?.action ?? null,
			skipped: event?.skipped === true,
			errorMessage: event?.errorMessage ?? null,
		});
	});
	pi.on("before_provider_request", event => {
		requests += 1;
		const payload = event?.payload ?? null;
		const contexts = [];
		const asyncJobs = [];
		walk(payload, value => {
			if (value?.role !== "custom") return;
			if (value.customType === "jev.autonomy.context" && typeof value.content === "string") contexts.push(value.content);
			if (value.customType === "async-result") {
				const jobs = value?.details?.jobs;
				if (Array.isArray(jobs)) for (const job of jobs) asyncJobs.push(String(job?.jobId ?? ""));
			}
		});
		const text = JSON.stringify(payload ?? null);
		if (!armed && text.includes("Workflow: the plan is approved at ")) armed = true;
		record({ kind: "before_provider_request", index: requests, armed, afterCompact: compacted, contexts, asyncJobs });
	});
	pi.on("context", event => {
		const messages = event?.messages;
		if (!Array.isArray(messages)) return;
		const contexts = [];
		let injected = 0;
		for (const message of messages) {
			if (message?.role !== "custom") continue;
			if (message.customType === "jev.autonomy.context") {
				const content = typeof message.content === "string" ? message.content : "";
				injected += 1;
				contexts.push(content);
				if (!armed && content.includes("Workflow: the plan is approved at ")) armed = true;
			}
		}
		record({ kind: "context", messages: messages.length, afterCompact: compacted, injected, contexts });
	});
	pi.on("turn_end", async (event, ctx) => {
		const awaitingAsyncWork = Array.isArray(event?.toolResults) &&
			event.toolResults.some(result => result?.details?.async?.state === "running");
		const idle = typeof ctx?.isIdle === "function" ? ctx.isIdle() : null;
		record({ kind: "compaction_boundary", turns, armed, done, awaitingAsyncWork, idle });
		// A tool turn ends before the whole agent loop: an uninterrupted loop may finish only after
		// autonomous completion has already fenced the executor. Compact at a committed tool boundary.
		if (done || !armed || turns < 2 || awaitingAsyncWork) return;
		done = true;
		record({ kind: "compact_trigger", turns, at: Date.now(), idle });
		// The event handler has a 30s budget and must not re-enter the agent from inside the
		// dispatch, so the real compaction starts on the next tick with its own controller.
		setTimeout(() => {
			try {
				void ctx
					.compact({
						mode: "soft",
						onComplete: result => {
							const summary = String(result?.summary ?? "");
							record({
								kind: "compact_complete",
								summary: clip(summary),
								summarySha: sha(summary),
								summaryLength: summary.length,
								shortSummary: clip(result?.shortSummary ?? ""),
								firstKeptEntryId: result?.firstKeptEntryId ?? null,
								tokensBefore: result?.tokensBefore ?? null,
							});
						},
						onError: error => {
							record({ kind: "compact_error", message: clip(error?.message ?? error) });
						},
					})
					.catch(error => {
						record({ kind: "compact_throw", message: clip(error?.message ?? error) });
					});
			} catch (error) {
				record({ kind: "compact_throw", message: clip(error?.message ?? error) });
			}
		}, 0);
	});
}
`;
}

function writeCompactionProbe(ctx: ScenarioContext): { wrapper: string; probe: string; log: string } {
	const probe = join(ctx.dir, "probe.ts");
	const log = join(ctx.dir, "probe.jsonl");
	writeFileSync(probe, compactionProbeSource(log), "utf8");
	const wrapper = join(ctx.dir, "omp-with-probe.sh");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(resolveRealOmp(ctx.options))} "$@" -e ${shellQuote(probe)}\n`, "utf8");
	chmodSync(wrapper, 0o755);
	return { wrapper, probe, log };
}

function policyFor(workspace: string, deadlineMs: number): AutonomyPolicy {
	return {
		roots: [realpathSync(workspace)],
		effects: ["project"],
		maxJudgeCalls: 600,
		maxExecutorCalls: 40,
		maxRuntimeMs: Math.min(Math.max(deadlineMs * 3, 1_800_000), 7_200_000),
		maxContextBytes: 262_144,
		maxArtifactBytes: 1_048_576,
	};
}

function prepareScenario(name: string, options: Options, outRoot: string, objective: string): ScenarioContext {
	const dir = join(outRoot, name);
	mkdirSync(dir, { recursive: true });
	const workspace = join(dir, "workspace");
	mkdirSync(workspace, { recursive: true });
	const storePath = join(dir, "control", "store.sqlite");
	const deadlineMs = options.deadlineSeconds * 1000;
	const policy = policyFor(workspace, deadlineMs);
	const policyFile = join(dir, "policy.json");
	const objectiveFile = join(dir, "objective.txt");
	writeFileSync(policyFile, `${showPretty(policy)}\n`, "utf8");
	writeFileSync(objectiveFile, objective, "utf8");
	return {
		dir,
		workspace,
		storePath,
		policy,
		policyFile,
		objectiveFile,
		options,
		deadlineMs,
		rec: createRecorder(dir),
		checks: [],
		supervisors: [],
		childGroups: new Set<number>(),
		trackedProcesses: [],
	};
}

function startArgsOf(ctx: ScenarioContext, omp?: string): string[] {
	const args = ["--objective", ctx.objectiveFile, "--policy", ctx.policyFile];
	const override = omp ?? ctx.options.omp;
	if (override !== undefined) args.push("--omp", override);
	if (ctx.options.model !== undefined) args.push("--model", ctx.options.model);
	return args;
}

function resumeArgsOf(ctx: ScenarioContext, runId: string): string[] {
	return ["--run", runId, ...nativeArgs(ctx)];
}

function parseCliResult(result: CommandResult): Record<string, unknown> {
	const parsed = asRecord(parseJson(result.stdout.trim()));
	return parsed ?? {};
}

/* -------------------------------------------------------------------------------------------------
 * Supervisor/terminal helpers
 * ---------------------------------------------------------------------------------------------- */

async function waitForSupervisor(
	ctx: ScenarioContext,
	handle: SupervisorHandle,
	runId: string,
	timeoutMs: number,
): Promise<CommandResult> {
	const deadline = Date.now() + timeoutMs;
	let lastSequence = -1;
	while (Date.now() < deadline) {
		const settled = await Promise.race([
			handle.result.then(result => ({ result })),
			Bun.sleep(1000).then(() => undefined),
		]);
		try {
			const snapshot = snapshotOf(ctx.storePath, runId);
			if (snapshot.run.sequence !== lastSequence) {
				lastSequence = snapshot.run.sequence;
				recordSnapshot(ctx, snapshot);
			}
		} catch {
			// The store may be momentarily unavailable; the next tick retries.
		}
		if (settled !== undefined) {
			recordCli(ctx, settled.result);
			handle.recorded = true;
			return settled.result;
		}
	}
	throw new Error(`the supervisor did not finish within ${Math.round(timeoutMs / 1000)}s`);
}

async function stopRun(ctx: ScenarioContext, runId: string, handle: SupervisorHandle): Promise<CommandResult> {
	const before = snapshotOf(ctx.storePath, runId);
	check(
		ctx,
		"the run is still active before the operator stop",
		before.run.status !== "completed" && before.run.status !== "cancelled" && before.run.status !== "infeasible",
		before.run.status,
	);
	const descendants = before.run.child === undefined ? [] : descendantsOf(before.run.child.pid);
	for (const observed of descendants) ctx.trackedProcesses.push(observed);
	writeBoundedJson(join(ctx.dir, "descendants-before-stop.json"), { child: before.run.child ?? null, descendants });
	const stop = await runCli(ctx, "stop", ["--run", runId, "--reason", "autonomy smoke control"], 60_000);
	const stopped = parseCliResult(stop);
	check(ctx, "stop exit code 0", stop.exitCode === 0 && !stop.timedOut, `${stop.exitCode}: ${stop.stderr.trim()}`);
	check(ctx, "stop reports durable cancellation", stopped["durableCancellation"] === true, show(stopped));
	check(ctx, "stop reports cancelled", stopped["status"] === "cancelled", show(stopped));
	if (!handle.finished) {
		const result = await awaitResult(handle.result, 120_000, "supervisor exit after stop");
		recordCli(ctx, result);
		handle.recorded = true;
		check(ctx, "supervisor exits after stop", result.exitCode === 0, `exit ${result.exitCode}: ${result.stderr.trim()}`);
	}
	const snapshot = snapshotOf(ctx.storePath, runId);
	check(ctx, "store status is cancelled", snapshot.run.status === "cancelled", snapshot.run.status);
	check(ctx, "cancellation cleared the wake", snapshot.run.wake === undefined, show(snapshot.run.wake));
	const stopScope = before.run.scope;
	check(ctx, "the stopped run had a recorded whole-executor scope", stopScope !== undefined, show(scopeBrief(stopScope)));
	let stopReceipt: AutonomyScopeFence | undefined;
	let stopEmpty = false;
	if (stopScope !== undefined) {
		stopReceipt = snapshot.run.fences.find(fence => sameScope(fence.scope, stopScope));
		check(
			ctx,
			"operator stop recorded a durable whole-scope fence receipt, not just a cancellation",
			stopReceipt !== undefined && stopReceipt.scope.bootId === autonomyBootId(),
			show(stopReceipt ?? null),
		);
		try {
			stopEmpty = autonomyScopeEmpty(stopScope);
		} catch (error) {
			appendBoundedLine(join(ctx.dir, "scope-stop.jsonl"), { at: Date.now(), problem: messageOf(error), scope: scopeBrief(stopScope) });
			stopEmpty = false;
		}
		check(ctx, "the stopped whole scope is positively empty", stopEmpty, show(scopeBrief(stopScope)));
		const pendingBefore = Object.keys(before.run.pending).sort();
		if (pendingBefore.length > 0 && stopReceipt !== undefined) {
			check(
				ctx,
				"the stop receipt covers the exact pending identities present at fencing",
				receiptCovering(snapshot.run.fences, stopScope, pendingBefore) !== undefined,
				show({ pending: pendingBefore, receipt: stopReceipt.intentIds }),
			);
		}
	}
	if (before.run.child !== undefined) {
		const childGone = await awaitIdentityGone(before.run.child, 10_000);
		appendBoundedLine(join(ctx.dir, "descendant-checks.jsonl"), { at: Date.now(), phase: "child-after-stop", child: before.run.child, gone: childGone });
		check(ctx, "the stopped bound executor identity is dead", childGone, show(before.run.child));
	}
	const survivors = descendants.filter(observed => identityMatches(observed));
	appendBoundedLine(join(ctx.dir, "descendant-checks.jsonl"), { at: Date.now(), phase: "after-stop", survivors });
	const surviving: string[] = [];
	for (const observed of descendants) {
		if (!(await awaitObservedGone(observed, 10_000))) surviving.push(`${observed.pid} (start ${observed.start})`);
	}
	check(
		ctx,
		"the supervisor stop left no observed executor descendant running",
		surviving.length === 0,
		show({ survivors: survivors.map(entry => entry.pid), surviving }),
	);
	return stop;
}

async function cleanupScenario(ctx: ScenarioContext): Promise<{ actions: string[]; alive: string[] }> {
	const actions: string[] = [];
	for (const handle of ctx.supervisors) {
		if (!handle.finished && groupAliveForCleanup(handle.pid)) {
			killGroup(handle.pid);
			actions.push(`SIGKILL supervisor group ${handle.pid}`);
		}
		const result = await awaitResult(handle.result, 5000, "supervisor exit during cleanup").catch(() => undefined);
		if (result !== undefined && !handle.recorded) {
			recordCli(ctx, result);
			handle.recorded = true;
		}
	}
	if (existsSync(ctx.storePath)) {
		try {
			for (const run of withStore(ctx.storePath, store => store.list())) {
				// Final cleanup only: a fenced whole scope first, then exact manual kills for anything
				// that could not be fenced. The main scenario path never relies on this.
				if (run.scope !== undefined) {
					try {
						await fenceAutonomyScope(run.scope);
						actions.push(`fenced whole scope ${run.scope.unit}`);
					} catch (error) {
						actions.push(`scope fence failed for ${run.scope.unit}: ${messageOf(error)}`);
					}
				}
				const child = run.child;
				if (child !== undefined && groupAliveForCleanup(child.group)) {
					ctx.childGroups.add(child.group);
					killGroup(child.group);
					actions.push(`SIGKILL child group ${child.group} (pid ${child.pid})`);
				}
			}
		} catch (error) {
			actions.push(`child cleanup could not read the store: ${messageOf(error)}`);
		}
	}
	for (const group of ctx.childGroups) {
		if (groupAliveForCleanup(group)) {
			killGroup(group);
			actions.push(`SIGKILL tracked child group ${group}`);
		}
	}
	for (const observed of ctx.trackedProcesses) {
		if (killObservedProcess(observed)) {
			actions.push(`SIGKILL observed descendant ${observed.pid} (start ${observed.start})`);
		}
	}
	await Bun.sleep(250);
	const alive: string[] = [];
	const groups = new Set<number>([...ctx.childGroups, ...ctx.supervisors.filter(handle => !handle.finished).map(handle => handle.pid)]);
	for (const group of groups) {
		let present: boolean;
		try {
			present = processGroupAlive(group);
		} catch (error) {
			alive.push(`group ${group} unobservable: ${messageOf(error)}`);
			continue;
		}
		if (present) alive.push(`group ${group}`);
	}
	for (const observed of ctx.trackedProcesses) {
		if (!(await awaitObservedGone(observed, 2000))) {
			alive.push(`observed descendant ${observed.pid} (start ${observed.start})`);
		}
	}
	return { actions, alive };
}

/** A process the harness actually observed under the bound executor, identified by pid and start tick. */
interface ObservedProcess {
	pid: number;
	start: string;
	group: number;
	parent: number;
	state: string;
	command: string;
}

function procStatOf(pid: number): { state: string; ppid: number; pgrp: number; start: string } | null {
	try {
		const text = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = text.lastIndexOf(")");
		if (close < 0) return null;
		const fields = text.slice(close + 1).trim().split(/\s+/);
		const state = fields[0];
		const ppid = fields[1];
		const pgrp = fields[2];
		const start = fields[19];
		if (state === undefined || ppid === undefined || pgrp === undefined || start === undefined) return null;
		return { state, ppid: Number(ppid), pgrp: Number(pgrp), start };
	} catch {
		return null;
	}
}

function observedProcess(pid: number): ObservedProcess | undefined {
	const stat = procStatOf(pid);
	if (stat === null) return undefined;
	let command = "";
	try {
		command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
	} catch {
		command = "";
	}
	return { pid, start: stat.start, group: stat.pgrp, parent: stat.ppid, state: stat.state, command };
}

/**
 * The real descendant tree of the bound executor, read from /proc. Group membership is recorded but
 * never assumed: a host tool runtime may start its own detached group, so the harness tracks these
 * exact pid+start identities for evidence and final cleanup instead of inferring them from one group.
 */
function descendantsOf(rootPid: number): ObservedProcess[] {
	const children = new Map<number, number[]>();
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const stat = procStatOf(Number(entry));
		if (stat === null) continue;
		const siblings = children.get(stat.ppid) ?? [];
		siblings.push(Number(entry));
		children.set(stat.ppid, siblings);
	}
	const found: ObservedProcess[] = [];
	const pending = [rootPid];
	const seen = new Set<number>([rootPid]);
	while (pending.length > 0 && found.length < 256) {
		const current = pending.shift();
		if (current === undefined) continue;
		for (const child of children.get(current) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			pending.push(child);
			const observed = observedProcess(child);
			if (observed !== undefined) found.push(observed);
		}
	}
	return found;
}

function identityAlive(identity: ProcessIdentity): boolean {
	try {
		return processAlive(identity);
	} catch {
		return true;
	}
}

function identityMatches(observed: ObservedProcess): boolean {
	try {
		const current = processIdentity(observed.pid);
		return current !== null && current.start === observed.start;
	} catch {
		return true;
	}
}

function killObservedProcess(observed: ObservedProcess): boolean {
	if (!identityMatches(observed)) return false;
	try {
		process.kill(observed.pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
}

async function awaitObservedGone(observed: ObservedProcess, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!identityMatches(observed)) return true;
		await Bun.sleep(100);
	}
	return false;
}

async function awaitIdentityGone(identity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!identityAlive(identity)) return true;
		await Bun.sleep(100);
	}
	return false;
}

/**
 * The owner's explicit root authority is the safety argument for isolation: one temporary workspace
 * outside the checkout, project effects only, and a database outside every writable root.
 */
function checkAuthority(ctx: ScenarioContext, run: AutonomyRun): void {
	const root = run.policy.roots[0];
	check(ctx, "the run has exactly one authorized root", run.policy.roots.length === 1, show(run.policy.roots));
	check(ctx, "the authorized root is the isolated temporary workspace", typeof root === "string" && root === realpathSync(ctx.workspace), show(run.policy.roots));
	check(ctx, "the authorized root is outside the checkout", typeof root === "string" && root !== CHECKOUT && !root.startsWith(`${CHECKOUT}/`), root ?? "missing");
	check(
		ctx,
		"the store database is outside every authorized root",
		ctx.policy.roots.every(authorized => ctx.storePath !== authorized && !ctx.storePath.startsWith(`${authorized}/`)),
		ctx.storePath,
	);
	check(ctx, "the policy grants only project effects", show(run.policy.effects) === show(["project"]), show(run.policy.effects));
	const scope = run.scope;
	check(ctx, "the run records an observed whole-executor scope", scope !== undefined, show(scopeBrief(scope)));
	const audience = run.audience;
	check(
		ctx,
		"the run records an objective-bound audience receipt with an actual decision",
		audience !== undefined &&
			audience.objectiveDigest === sha256Hex(run.objective) &&
			typeof audience.external === "boolean" &&
			audience.decisionId.length > 0,
		show(audience ?? null),
	);
	if (scope !== undefined) {
		check(ctx, "the observed scope belongs to this run and kernel boot", scope.runId === run.id && scope.bootId === autonomyBootId(), show(scopeBrief(scope)));
		check(ctx, "the observed scope identity is canonical, not a bare unit name", scope.controlGroup.length > 0 && scope.invocationId.length > 0 && scope.device.length > 0 && scope.inode.length > 0, show(scopeBrief(scope)));
		if (TERMINAL_RUN_STATUS[run.status] === true) {
			let empty = false;
			let emptyProblem: string | undefined;
			try {
				empty = autonomyScopeEmpty(scope);
			} catch (error) {
				emptyProblem = messageOf(error);
			}
			const childAlive = run.child !== undefined && identityAlive(run.child);
			const proofs = terminalScopeProof({
				scope,
				fences: run.fences,
				pendingIds: Object.keys(run.pending),
				child: run.child,
				childAlive,
				empty,
				...(emptyProblem === undefined ? {} : { emptyProblem }),
			});
			for (const proof of proofs) check(ctx, proof.name, proof.ok, proof.detail);
		} else if (run.child !== undefined) {
			let membership = false;
			try {
				assertAutonomyScope(scope, run.child);
				membership = true;
			} catch (error) {
				membership = false;
				appendBoundedLine(join(ctx.dir, "scope-membership.jsonl"), { at: Date.now(), problem: messageOf(error), scope: scopeBrief(scope), child: run.child });
			}
			check(ctx, "the bound child is a real member of the committed scope", membership, show({ scope: scopeBrief(scope), child: run.child }));
		}
	}
}

/* -------------------------------------------------------------------------------------------------
 * Scenarios
 * ---------------------------------------------------------------------------------------------- */

async function scenarioStartup(ctx: ScenarioContext): Promise<void> {
	writeFileSync(join(ctx.workspace, "notes.txt"), NOTES_BYTES, "utf8");
	const objective = readFileSync(ctx.objectiveFile, "utf8");
	const supervisor = spawnSupervisor(ctx, "start", startArgsOf(ctx), ctx.deadlineMs + 120_000);
	const runId = await waitForRunId(ctx, 60_000);
	const running = await pollSnapshot(
		ctx,
		runId,
		"run bound and running",
		ctx.deadlineMs,
		snapshot =>
			snapshot.run.status === "running" &&
			typeof snapshot.run.session?.id === "string" &&
			snapshot.run.session.id.length > 0,
	);
	const session = running.run.session;
	checkAuthority(ctx, running.run);
	check(ctx, "native get_state bound a session id", session !== undefined && session.id.length > 0);
	const ready = lastEvent(running.events, "driver.ready");
	const readyData = eventData(ready);
	const protocolVersion = readyData?.["protocolVersion"];
	const maxFrameBytes = readyData?.["maxFrameBytes"];
	check(ctx, "driver.ready was committed", ready !== undefined);
	check(ctx, "driver.ready carries a numeric protocol version", typeof protocolVersion === "number", show(readyData));
	check(ctx, "driver.ready carries a positive max frame size", typeof maxFrameBytes === "number" && maxFrameBytes > 0, show(readyData));
	const bound = eventData(lastEvent(running.events, "driver.session_bound"));
	check(ctx, "driver.session_bound matches the bound session", bound?.["sessionId"] === running.run.session?.id, show(bound));
	check(ctx, "driver.session_bound reports the same session file", bound?.["sessionFile"] === running.run.session?.file, show(bound));
	check(ctx, "driver.session_bound reports the bound generation", bound?.["generation"] === running.run.generation, show(bound));

	const bootstrapped = await pollSnapshot(
		ctx,
		runId,
		"autonomy.bootstrap on the first bound state",
		Math.min(ctx.deadlineMs, 120_000),
		snapshot => lastEvent(snapshot.events, "autonomy.bootstrap") !== undefined && snapshot.run.checkpoint.task !== undefined,
	);
	const bootstrapData = eventData(lastEvent(bootstrapped.events, "autonomy.bootstrap"));
	check(ctx, "bootstrap objective digest is the exact objective sha256", bootstrapData?.["objectiveDigest"] === sha256Hex(objective), show(bootstrapData));
	check(ctx, "bootstrap reports an external-deliverable verdict", typeof bootstrapData?.["external"] === "boolean", show(bootstrapData));
	check(ctx, "bootstrap task fingerprint matches the strict checkpoint", bootstrapData?.["taskFingerprint"] === bootstrapped.run.checkpoint.task?.fingerprint, show(bootstrapData));
	const receipt = bootstrapped.run.audience;
	check(
		ctx,
		"the run carries an immutable-objective-bound audience receipt",
		receipt !== undefined &&
			receipt.objectiveDigest === sha256Hex(objective) &&
			typeof receipt.external === "boolean" &&
			typeof receipt.decisionId === "string" &&
			receipt.decisionId.length > 0,
		show(receipt ?? null),
	);
	check(ctx, "bootstrap used the committed audience, not a lexical guess", bootstrapData?.["external"] === receipt?.external, show({ bootstrap: bootstrapData?.["external"], receipt }));
	check(ctx, "bootstrap names the committed audience decision", bootstrapData?.["decisionId"] === receipt?.decisionId, show(bootstrapData));
	const decisionEvents = bootstrapped.events.filter(event => {
		const data = eventData(event);
		return data?.["decisionId"] === receipt?.decisionId && asRecord(data)?.["outcome"] !== undefined;
	});
	const audienceDecision = decisionEvents.find(event => {
		const data = asRecord(eventData(event)) ?? {};
		return typeof data["contextDigest"] === "string" && Array.isArray(data["questions"]);
	});
	check(ctx, "the audience names an actual committed lifecycle decision", audienceDecision !== undefined, show(decisionEvents.map(event => event.kind)));
	const decisionData = asRecord(audienceDecision === undefined ? undefined : eventData(audienceDecision));
	const rawQuestions = decisionData?.["questions"];
	const decisionQuestions: unknown[] = Array.isArray(rawQuestions) ? rawQuestions : [];
	const typedAudience = decisionQuestions
		.map(entry => asRecord(entry))
		.find(question => {
			const options = asRecord(question?.["options"]);
			return options !== undefined && options["external"] !== undefined && options["internal"] !== undefined && options["unclear"] !== undefined;
		});
	const decisionAnswers = asRecord(decisionData?.["outcome"])?.["answers"];
	const audienceAnswer = Array.isArray(decisionAnswers)
		? decisionAnswers.map(entry => asRecord(entry)).find(answer => answer?.["name"] === typedAudience?.["name"])
		: undefined;
	const audienceLabel = audienceAnswer?.["label"];
	check(
		ctx,
		"the journaled initial batch carries a decisive typed external/internal audience choice",
		typedAudience !== undefined &&
			(audienceLabel === "external" || audienceLabel === "internal") &&
			(audienceLabel === "external") === receipt?.external,
		show({ question: typedAudience ?? null, answer: audienceAnswer ?? null, receipt: receipt ?? null }),
	);
	const decisionDigest = decisionData === undefined ? undefined : sha256Hex(JSON.stringify({
		purpose: decisionData["purpose"],
		context: decisionData["context"],
		questions: decisionData["questions"],
		outcome: decisionData["outcome"],
	}));
	check(
		ctx,
		"the audience decision id is the digest of the journaled actual batch",
		decisionDigest === receipt?.decisionId && decisionDigest === decisionData?.["decisionId"],
		show({ decisionDigest: decisionDigest ?? null, decisionId: decisionData?.["decisionId"] ?? null }),
	);
	const firstSpawn = bootstrapped.events.find(event => event.kind === "driver.launch_spawned");
	check(
		ctx,
		"the audience decision was committed before the first child spawn",
		audienceDecision !== undefined && firstSpawn !== undefined && audienceDecision.sequence < firstSpawn.sequence,
		show({ decision: audienceDecision?.sequence ?? null, spawn: firstSpawn?.sequence ?? null }),
	);
	check(ctx, "the strict checkpoint task is keyed by the objective fingerprint", bootstrapped.run.checkpoint.task?.fingerprint === sha256Hex(objective), bootstrapped.run.checkpoint.task?.fingerprint ?? "missing");
	check(ctx, "strict marker is set", bootstrapped.run.checkpoint.autonomous === true);
	check(ctx, "checkpoint objective equals the exact objective file bytes", bootstrapped.run.objective === objective);

	const wakeCommit = await pollSnapshot(
		ctx,
		runId,
		"wake.commit",
		Math.min(ctx.deadlineMs, 120_000),
		snapshot =>
			lastEvent(snapshot.events, "wake.commit") !== undefined &&
			(lastEvent(snapshot.events, "wake.send") !== undefined || lastEvent(snapshot.events, "wake.start") !== undefined),
	);
	const commitData = eventData(lastEvent(wakeCommit.events, "wake.commit"));
	const wakeId = commitData?.["wakeId"];
	const wakeDeadline = commitData?.["deadline"];
	const bootstrapSequence = lastEvent(wakeCommit.events, "autonomy.bootstrap")?.sequence ?? 0;
	const restoreEvent = lastEvent(wakeCommit.events, "autonomy.restore");
	const restoreSequence = restoreEvent?.sequence ?? 0;
	const commitSequence = lastEvent(wakeCommit.events, "wake.commit")?.sequence ?? 0;
	check(ctx, "the first bound state bootstrapped and restored before the wake", bootstrapSequence > 0 && restoreSequence > bootstrapSequence && commitSequence > restoreSequence, show({ bootstrapSequence, restoreSequence, commitSequence }));
	check(ctx, "autonomy.restore binds the initial epoch, generation and session", restoreEvent?.data !== undefined && eventData(restoreEvent)?.["epoch"] === wakeCommit.run.epoch && eventData(restoreEvent)?.["generation"] === wakeCommit.run.generation && eventData(restoreEvent)?.["sessionId"] === wakeCommit.run.session?.id, show(eventData(restoreEvent)));
	check(ctx, "wake was committed with a wake id", typeof wakeId === "string" && wakeId.length > 0, show(commitData));
	check(ctx, "wake.commit carries the bound session", commitData?.["sessionId"] === wakeCommit.run.session?.id, show(commitData));
	check(ctx, "wake.commit carries the current epoch", commitData?.["epoch"] === wakeCommit.run.epoch, show(commitData));
	check(ctx, "wake.commit carries the current generation", commitData?.["generation"] === wakeCommit.run.generation, show(commitData));
	check(
		ctx,
		"wake deadline lies beyond run creation",
		typeof wakeDeadline === "number" && wakeDeadline > wakeCommit.run.createdAt,
		show(commitData),
	);
	check(ctx, "wake.send followed the committed wake", lastEvent(wakeCommit.events, "wake.send") !== undefined);
	const sendData = eventData(lastEvent(wakeCommit.events, "wake.send"));
	check(
		ctx,
		"wake.send carries the same wake, epoch, generation and session",
		sendData?.["wakeId"] === wakeId &&
			sendData?.["epoch"] === wakeCommit.run.epoch &&
			sendData?.["generation"] === wakeCommit.run.generation &&
			sendData?.["sessionId"] === wakeCommit.run.session?.id,
		show(sendData),
	);

	const started = await pollSnapshot(
		ctx,
		runId,
		"wake.start acknowledgment",
		Math.min(ctx.deadlineMs, 300_000),
		snapshot => lastEvent(snapshot.events, "wake.start") !== undefined || snapshot.run.wake?.status === "started",
	);
	const startEvent = lastEvent(started.events, "wake.start");
	const startData = eventData(startEvent);
	check(ctx, "wake.start acknowledges the committed wake id", startData?.["wakeId"] === wakeId, show(startData));
	check(ctx, "wake.start reports the acknowledged epoch", startData?.["epoch"] === started.run.epoch, show(startData));
	check(ctx, "wake.start reports the acknowledged generation", startData?.["generation"] === started.run.generation, show(startData));
	check(ctx, "wake.start reports the acknowledged session", startData?.["sessionId"] === started.run.session?.id, show(startData));
	check(ctx, "run.wake is retained as started", started.run.wake?.status === "started", show(started.run.wake));
	check(ctx, "started wake keeps the same session", started.run.wake?.sessionId === started.run.session?.id, show(started.run.wake));
	check(ctx, "started wake keeps the same epoch", started.run.wake?.epoch === started.run.epoch, show(started.run.wake));
	check(ctx, "started wake keeps the same generation", started.run.wake?.generation === started.run.generation, show(started.run.wake));

	const wakeSequence = startEvent?.sequence ?? 0;
	const worked = await pollSnapshot(
		ctx,
		runId,
		"real executor work after the acknowledged wake",
		Math.min(ctx.deadlineMs, 600_000),
		snapshot => {
			const after = eventsAfter(snapshot.events, wakeSequence);
			return after.some(event => event.kind === "judge.result");
		},
	);
	check(
		ctx,
		"a post-wake executor decision actually reached Jev and returned",
		worked.run.judgeCalls > running.run.judgeCalls,
		`before ${running.run.judgeCalls}, after ${worked.run.judgeCalls}`,
	);
	// getSessionFile allocates a path before the native host materializes its lazy transcript.
	// A completed assistant turn, not the initial get_state reply, establishes file persistence.
	check(ctx, "the actual executor turn persisted its native session transcript", sessionFileExists(worked.run), worked.run.session?.file ?? "missing");
	const judgeResult = eventData(lastEvent(worked.events, "judge.result"));
	const judgeRequest = worked.events.find(event =>
		event.kind === "judge.request" && eventData(event)?.["requestDigest"] === judgeResult?.["requestDigest"],
	);
	const requestData = eventData(judgeRequest);
	const selectedInput = asRecord(requestData?.["request"]);
	check(
		ctx, "the durable judge request retains the exact selected input after the network call",
		selectedInput !== undefined && sha256Hex(JSON.stringify(selectedInput)) === requestData?.["requestDigest"],
		show({ requestSequence: judgeRequest?.sequence ?? null, requestDigest: requestData?.["requestDigest"] ?? null }),
	);
	const typedQuestions = requestData?.["questions"];
	check(
		ctx, "the durable judge request retains question meanings rather than names alone",
		Array.isArray(typedQuestions) && typedQuestions.length > 0 &&
			typedQuestions.every(question => {
				const record = asRecord(question);
				return typeof record?.["name"] === "string" && typeof record["mode"] === "string" &&
					typeof record["instructions"] === "string";
			}),
	);
	const typedOutcome = asRecord(judgeResult?.["outcome"]);
	check(
		ctx, "the durable result retains the actual typed judge outcome",
		typedOutcome?.["ok"] === true && Array.isArray(typedOutcome["answers"]) &&
			typedOutcome["answers"].length > 0,
	);

	await stopRun(ctx, runId, supervisor);
}

async function scenarioCompletion(ctx: ScenarioContext): Promise<void> {
	const objective = readFileSync(ctx.objectiveFile, "utf8");
	const supervisor = spawnSupervisor(ctx, "start", startArgsOf(ctx), ctx.deadlineMs + 120_000);
	const runId = await waitForRunId(ctx, 60_000);
	const result = await waitForSupervisor(ctx, supervisor, runId, ctx.deadlineMs);
	const cli = parseCliResult(result);
	check(ctx, "start exited 0", result.exitCode === 0 && !result.timedOut, `exit ${result.exitCode}: ${result.stderr.trim()}`);
	check(ctx, "driver result reports completed", cli["status"] === "completed", show(cli));

	const final = snapshotOf(ctx.storePath, runId);
	const run = final.run;
	check(ctx, "store status is completed", run.status === "completed", `${run.status}: ${run.waiting?.reason ?? ""}`);
	check(ctx, "completed run has no pending effect", Object.keys(run.pending).length === 0, show(Object.keys(run.pending)));
	check(ctx, "completed run retains no wake", run.wake === undefined, show(run.wake));
	const business = acceptanceAt(run.checkpoint, "business");
	const architecture = acceptanceAt(run.checkpoint, "architecture");
	check(ctx, "business acceptance is approved at the current revision", business?.approved === true && business.revision === run.checkpoint.revision, show(business));
	check(
		ctx,
		"architecture acceptance is approved at the current revision",
		architecture?.approved === true && architecture.revision === run.checkpoint.revision,
		show(architecture),
	);
	check(
		ctx,
		"completion approved the current revision",
		run.checkpoint.completion?.approved === true && run.checkpoint.completion.revision === run.checkpoint.revision,
		show(run.checkpoint.completion),
	);
	const completedEvent = eventData(lastEvent(final.events, "completed"));
	check(
		ctx,
		"the completed event binds the accepted revision and confidence",
		completedEvent?.["revision"] === run.checkpoint.revision && typeof completedEvent?.["confidence"] === "number",
		show(completedEvent),
	);

	const filePath = join(ctx.workspace, "autonomy-smoke.txt");
	check(ctx, "the requested file exists", existsSync(filePath));
	check(ctx, "the requested file has exactly the fixture bytes", fileHex(filePath) === sha256Hex(COMPLETION_BYTES), fileHex(filePath) ?? "unreadable");
	const aliases = artifactUrls(run, "autonomy-smoke.txt");
	for (const url of aliases) {
		check(ctx, `ledger artifact '${url}' keeps the exact bytes`, artifactHex(ctx.storePath, runId, url) === sha256Hex(COMPLETION_BYTES), artifactHex(ctx.storePath, runId, url) ?? "missing");
	}

	const commandResults = final.events
		.filter(event => event.kind === "result.recorded")
		.map(event => eventData(event))
		.filter((data): data is Record<string, unknown> => data !== undefined);
	const bashResults = commandResults.filter(data => data["tool"] === "bash" && data["isError"] === false);
	const commandText = (data: Record<string, unknown>): string => (typeof data["target"] === "string" ? data["target"] : "");
	const outputText = (data: Record<string, unknown>): string => (typeof data["excerpt"] === "string" ? data["excerpt"] : "");
	const completionSize = new RegExp(`\\b${Buffer.byteLength(COMPLETION_BYTES, "utf8")}\\b`);
	check(
		ctx,
		"a real sha256sum command observed the exact digest",
		bashResults.some(data => commandText(data).includes("sha256sum") && commandText(data).includes("autonomy-smoke.txt") && outputText(data).includes(sha256Hex(COMPLETION_BYTES))),
		show(bashResults.map(data => ({ target: commandText(data), excerpt: outputText(data).slice(0, 200) }))),
	);
	check(
		ctx,
		"a real byte-count command observed the exact size",
		bashResults.some(
			data =>
				commandText(data).includes("wc -c") &&
				commandText(data).includes("autonomy-smoke.txt") &&
				completionSize.test(outputText(data)),
		),
		show(bashResults.map(data => ({ target: commandText(data), excerpt: outputText(data).slice(0, 200) }))),
	);
	check(ctx, "executor calls happened", run.executorCalls > 0, String(run.executorCalls));
	const recordedActions = run.checkpoint.actions ?? [];
	check(
		ctx,
		"a consequential code action is recorded for completion",
		recordedActions.some(action => action.tool === "write" || action.tool === "edit" || action.tool === "ast_edit"),
		show(recordedActions.map(action => ({ tool: action.tool, target: action.target }))),
	);
	check(
		ctx,
		"a consequential execution action is recorded for completion",
		recordedActions.some(action => action.tool === "bash" && action.target.includes("bun run verify-autonomy-smoke.ts")),
		show(recordedActions.map(action => ({ tool: action.tool, target: action.target }))),
	);
	check(ctx, "judge calls happened", run.judgeCalls > 0, String(run.judgeCalls));
	check(ctx, "executor budget was not exceeded", run.executorCalls <= run.policy.maxExecutorCalls, `${run.executorCalls}/${run.policy.maxExecutorCalls}`);
	check(ctx, "judge budget was not exceeded", run.judgeCalls <= run.policy.maxJudgeCalls, `${run.judgeCalls}/${run.policy.maxJudgeCalls}`);
	checkAuthority(ctx, run);
	check(ctx, "policy limits are the fixture limits", run.policy.maxJudgeCalls === ctx.policy.maxJudgeCalls && run.policy.maxExecutorCalls === ctx.policy.maxExecutorCalls && run.policy.maxRuntimeMs === ctx.policy.maxRuntimeMs && run.policy.maxContextBytes === ctx.policy.maxContextBytes && run.policy.maxArtifactBytes === ctx.policy.maxArtifactBytes, show(run.policy));
	check(ctx, "the immutable objective is the exact fixture text", run.objective === objective);

	const status = await runCli(ctx, "status", ["--run", runId], 30_000);
	const rows = parseJson(status.stdout.trim());
	const row = Array.isArray(rows) ? asRecord(rows[0]) : undefined;
	check(ctx, "a fresh status invocation reads the completed run", status.exitCode === 0 && row?.["status"] === "completed", `${status.exitCode}: ${status.stdout.trim().slice(0, 300)}`);
	check(ctx, "status and store agree on the executor count", row?.["executorCalls"] === run.executorCalls, `${String(row?.["executorCalls"])} vs ${run.executorCalls}`);
	check(ctx, "status and store agree on the judge count", row?.["judgeCalls"] === run.judgeCalls, `${String(row?.["judgeCalls"])} vs ${run.judgeCalls}`);
	writeFileSync(join(ctx.dir, "observed-bytes.txt"), readFileSync(filePath));
}

async function scenarioAsync(ctx: ScenarioContext, delivery: AsyncDelivery): Promise<void> {
	const asyncPath = join(ctx.workspace, "async-effect.txt");
	const asyncHex = sha256Hex(ASYNC_BYTES);
	writeEffectScript(ctx, "async-effect.sh", "async-effect.txt", ASYNC_BYTES, 70);
	writeAsyncExtra(ctx);
	const objective = readFileSync(ctx.objectiveFile, "utf8");
	const script = readFileSync(join(ctx.workspace, "async-effect.sh"), "utf8");
	check(
		ctx,
		"the async fixture is inspectable and runs the real /usr/bin/sleep 70",
		script.includes("/usr/bin/sleep 70") && script.includes(ASYNC_BYTES.slice(0, -1)),
		show(script),
	);

	const asyncCommand = "sh async-effect.sh";
	/** The one effect the fixture objective authorized: neither a readonly background job nor any other bash call qualifies. */
	const isAuthorizedAsyncRunning = (snapshot: Snapshot, event: AutonomyEvent): boolean => {
		if (event.kind !== "result.recorded") return false;
		const data = eventData(event);
		if (data === undefined) return false;
		if (data["tool"] !== "bash" || data["target"] !== asyncCommand) return false;
		if (data["source"] !== "tool_result" || data["completed"] !== false || data["matched"] !== true) return false;
		const async = asRecord(data["async"]);
		if (async?.["type"] !== "bash" || async?.["state"] !== "running") return false;
		const observedJobId = async["jobId"];
		const observedIntentId = data["id"];
		if (typeof observedJobId !== "string" || observedJobId.length === 0 || typeof observedIntentId !== "string") return false;
		const intent = snapshot.run.pending[observedIntentId];
		if (intent === undefined || intent.kind !== "tool") return false;
		const payload = asRecord(intent.payload);
		return (
			payload !== undefined &&
			payload["tool"] === "bash" &&
			payload["invocationDigest"] === data["invocationDigest"] &&
			payload["backgroundJobId"] === observedJobId &&
			payload["backgroundState"] === "running"
		);
	};

	const supervisor = spawnSupervisor(ctx, "start", startArgsOf(ctx), ctx.deadlineMs + 120_000);
	const runId = await waitForRunId(ctx, 60_000);
	const running = await pollSnapshot(
		ctx,
		runId,
		"native bash auto-background with the pending intent retained",
		Math.min(ctx.deadlineMs, 900_000),
		snapshot => snapshot.run.status === "running" && snapshot.events.some(event => isAuthorizedAsyncRunning(snapshot, event)),
	);
	const runningEvent = [...running.events].reverse().find(event => isAuthorizedAsyncRunning(running, event));
	const runningData = eventData(runningEvent);
	const runningAsync = asRecord(runningData?.["async"]);
	const rawJobId = runningAsync?.["jobId"];
	const rawIntentId = runningData?.["id"];
	const jobId = typeof rawJobId === "string" ? rawJobId : "";
	const intentId = typeof rawIntentId === "string" ? rawIntentId : "";
	const pendingIntent = Object.values(running.run.pending).find(intent => intent.id === intentId);
	const pendingPayload = asRecord(pendingIntent?.payload);
	const revisionBefore = running.run.checkpoint.revision;
	check(
		ctx,
		"the backgrounded call keeps its pending intent",
		pendingIntent !== undefined && pendingPayload?.["backgroundJobId"] === jobId && pendingPayload?.["backgroundState"] === "running",
		show({ jobId, intentId, pending: Object.keys(running.run.pending), payload: pendingPayload }),
	);
	check(
		ctx,
		"the native running result is not settlement",
		running.run.status === "running" && running.events.every(event => event.kind !== "completed"),
		running.run.status,
	);
	check(
		ctx,
		"no native terminal delivery has settled the background job yet",
		running.events.every(event => {
			const data = eventData(event);
			return !(event.kind === "result.recorded" && (data?.["source"] === "async-result" || data?.["source"] === "native-wait"));
		}),
		show(running.events.filter(event => event.kind === "result.recorded").map(event => eventData(event)?.["source"] ?? null)),
	);

	const child = running.run.child;
	let tree: ObservedProcess[] = [];
	let sleeps: ObservedProcess[] = [];
	const treeDeadline = Date.now() + 15_000;
	while (child !== undefined && Date.now() < treeDeadline) {
		tree = descendantsOf(child.pid);
		sleeps = tree.filter(entry => /\/usr\/bin\/sleep\s+70/.test(entry.command));
		if (sleeps.length > 0) break;
		await Bun.sleep(100);
	}
	for (const entry of tree) ctx.trackedProcesses.push(entry);
	check(
		ctx,
		"a real /usr/bin/sleep 70 runs as a native descendant of the executor",
		sleeps.length > 0,
		show(tree.map(entry => ({ pid: entry.pid, group: entry.group, command: entry.command }))),
	);

	const terminal = await pollSnapshot(
		ctx,
		runId,
		"native terminal delivery for the background job",
		Math.min(ctx.deadlineMs, 900_000),
		snapshot =>
			snapshot.events.some(event => {
				const data = eventData(event);
				const async = asRecord(data?.["async"]);
				return (
					event.kind === "result.recorded" &&
					(data?.["source"] === "async-result" || data?.["source"] === "native-wait") &&
					data?.["id"] === intentId &&
					async?.["jobId"] === jobId &&
					async?.["status"] === "completed" &&
					data?.["completed"] === true
				);
			}),
	);
	const terminalEvent = [...terminal.events].reverse().find(event => {
		const data = eventData(event);
		return event.kind === "result.recorded" && (data?.["source"] === "async-result" || data?.["source"] === "native-wait") && data?.["id"] === intentId;
	});
	const terminalData = eventData(terminalEvent);
	const terminalAsync = asRecord(terminalData?.["async"]);
	check(
		ctx,
		"the terminal async result names the same intent, job and tool",
		terminalData?.["matched"] === true &&
			terminalData?.["completed"] === true &&
			terminalAsync?.["jobId"] === jobId &&
			terminalAsync?.["type"] === "bash" &&
			terminalAsync?.["status"] === "completed",
		show(terminalData),
	);
	check(
		ctx,
		`the terminal delivery arrived through the actual ${delivery} channel`,
		terminalData?.["source"] === delivery,
		show({ expected: delivery, actual: terminalData?.["source"] ?? null }),
	);
	check(
		ctx,
		"the terminal delivery clears exactly the matching intent",
		terminal.run.pending[intentId] === undefined &&
			Object.values(terminal.run.pending).every(intent => asRecord(intent.payload)?.["backgroundJobId"] !== jobId),
		show({ pending: Object.keys(terminal.run.pending), intentId, jobId }),
	);
	const terminalRevision = terminalData?.["revision"];
	check(
		ctx,
		"the terminal delivery advances the revision exactly once",
		typeof terminalRevision === "number" && terminalRevision === revisionBefore + 1,
		`${String(terminalRevision)} vs ${revisionBefore + 1}`,
	);
	const asyncEvents = terminal.events.filter(event => {
		const data = eventData(event);
		return event.kind === "result.recorded" && (data?.["source"] === "async-result" || data?.["source"] === "native-wait") && data?.["id"] === intentId;
	});
	check(ctx, "exactly one native terminal observation settles the intent", asyncEvents.length === 1, String(asyncEvents.length));
	const completedBefore = terminal.events.find(event => event.kind === "completed" && terminalEvent !== undefined && event.sequence < terminalEvent.sequence);
	check(ctx, "the run did not complete before the native async result", completedBefore === undefined, show(completedBefore ?? null));
	const terminalSettlements = exactTargetRecords(terminal.events, asyncCommand)
		.filter(result => result.id === intentId && result.matched && result.completed);
	check(ctx, "the exact async intent has one durable terminal settlement", terminalSettlements.length === 1, show(terminalSettlements));

	const probeCommand = "sh async-extra.sh";
	const probeCalls = exactCommandCalls(sessionEntries(terminal.run), probeCommand);
	check(
		ctx,
		"exactly one native bash call used the exact refused probe command",
		probeCalls.length === 1,
		show(probeCalls.map(call => ({ callId: call.callId, command: call.command }))),
	);
	const probeCall = probeCalls[0];
	const probeText = probeCall?.result?.text ?? "";
	check(
		ctx,
		"the exact probe call was blocked with the native unobserved-effect reason",
		probeCall !== undefined && probeCall.result?.isError === true && probeText.includes("still running or has an unobserved outcome"),
		show(probeCall ?? null),
	);
	const probeAdmissions = terminal.events.filter(event => {
		const data = eventData(event);
		return event.kind === "intent.admit" && probeCall !== undefined && data?.["id"] === probeCall.callId;
	});
	check(
		ctx,
		"the refused probe call was never admitted as an intent",
		probeCall !== undefined && probeAdmissions.length === 0,
		show(probeAdmissions.map(event => eventData(event) ?? null)),
	);
	const probeRecords = exactTargetRecords(terminal.events, probeCommand);
	check(
		ctx,
		"no recorded result claims the exact refused command was authorized",
		probeRecords.every(record => !record.matched),
		show(probeRecords),
	);
	check(ctx, "the refused extra effect wrote nothing", !existsSync(join(ctx.workspace, "async-extra.txt")), fileHex(join(ctx.workspace, "async-extra.txt")) ?? "absent");

	const result = await waitForSupervisor(ctx, supervisor, runId, ctx.deadlineMs);
	const cli = parseCliResult(result);
	check(ctx, "start exited 0", result.exitCode === 0 && !result.timedOut, `exit ${result.exitCode}: ${result.stderr.trim()}`);
	check(ctx, "driver result reports completed", cli["status"] === "completed", show(cli));
	const final = snapshotOf(ctx.storePath, runId);
	const run = final.run;
	check(ctx, "store status is completed", run.status === "completed", `${run.status}: ${run.waiting?.reason ?? ""}`);
	check(ctx, "completed run has no pending effect", Object.keys(run.pending).length === 0, show(Object.keys(run.pending)));
	check(ctx, "the async effect wrote exactly the fixture bytes", fileHex(asyncPath) === asyncHex, fileHex(asyncPath) ?? "unreadable");
	check(ctx, "the immutable objective is the exact fixture text", run.objective === objective);
	check(ctx, "the refused extra effect still wrote nothing", !existsSync(join(ctx.workspace, "async-extra.txt")), fileHex(join(ctx.workspace, "async-extra.txt")) ?? "absent");
	checkAuthority(ctx, run);
	check(
		ctx,
		"policy limits are the fixture limits",
		run.policy.maxJudgeCalls === ctx.policy.maxJudgeCalls &&
			run.policy.maxExecutorCalls === ctx.policy.maxExecutorCalls &&
			run.policy.maxRuntimeMs === ctx.policy.maxRuntimeMs &&
			run.policy.maxContextBytes === ctx.policy.maxContextBytes &&
			run.policy.maxArtifactBytes === ctx.policy.maxArtifactBytes,
		show(run.policy),
	);
	const finalAsync = final.events.filter(event => {
		const data = eventData(event);
		return event.kind === "result.recorded" && (data?.["source"] === "async-result" || data?.["source"] === "native-wait") && data?.["id"] === intentId;
	});
	check(ctx, "historical async data did not fabricate a second settlement", finalAsync.length === 1, String(finalAsync.length));
	const finalSession = sessionText(run);
	let retainedCallId: string | undefined;
	const retainedTerminal = finalSession?.split("\n").some(line => {
		try {
			const entry = asRecord(JSON.parse(line));
			if (entry === undefined) return false;
			const message = asRecord(entry["message"]) ?? entry;
			const jobs = asRecord(message["details"])?.["jobs"];
			if (!Array.isArray(jobs)) return false;
			const wait = delivery === "native-wait";
			if (wait ? message["role"] !== "toolResult" || message["toolName"] !== "wait" : message["customType"] !== "async-result") return false;
			const found = jobs.some(value => {
				const job = asRecord(value);
				return job?.[wait ? "id" : "jobId"] === jobId && job["type"] === "bash" && job["status"] === "completed";
			});
			if (found && wait) retainedCallId = typeof message["toolCallId"] === "string" ? message["toolCallId"] : undefined;
			return found;
		} catch {
			return false;
		}
	}) ?? false;
	check(ctx, `the native session retains the actual ${delivery} delivery channel and job`, retainedTerminal, `source ${String(terminalData?.["source"])}, job ${jobId}`);
	check(
		ctx,
		delivery === "native-wait"
			? "the native-wait receipt names the exact wait call that observed the job"
			: "the automatic async-result delivery is not a synthetic observation call",
		delivery === "native-wait"
			? retainedCallId !== undefined && terminalData?.["observationCallId"] === retainedCallId
			: terminalData?.["observationCallId"] === null,
		show({ observationCallId: terminalData?.["observationCallId"] ?? null, retainedCallId: retainedCallId ?? null }),
	);
	const finalSettlements = exactTargetRecords(final.events, "sh async-effect.sh")
		.filter(result => result.id === intentId && result.matched && result.completed);
	check(ctx, "exactly one durable terminal settlement survives action-window eviction or session change", finalSettlements.length === 1, show(finalSettlements));
}

async function scenarioCompaction(ctx: ScenarioContext): Promise<void> {
	const objective = readFileSync(ctx.objectiveFile, "utf8");
	const probe = writeCompactionProbe(ctx);
	const supervisor = spawnSupervisor(ctx, "start", startArgsOf(ctx, probe.wrapper), ctx.deadlineMs + 120_000);
	const runId = await waitForRunId(ctx, 60_000);
	const records = await waitForProbe(
		probe.log,
		"one real manual compaction with its completion callback",
		all => all.some(record => record["kind"] === "session_compact") && all.some(record => record["kind"] === "compact_complete"),
		Math.min(ctx.deadlineMs, 900_000),
	);
	const prepared = records.filter(record => record["kind"] === "session_before_compact");
	const compacting = records.filter(record => record["kind"] === "session.compacting");
	const compacted = records.filter(record => record["kind"] === "session_compact");
	const completes = records.filter(record => record["kind"] === "compact_complete");
	const triggers = records.filter(record => record["kind"] === "compact_trigger");
	const failures = records.filter(record => record["kind"] === "compact_error" || record["kind"] === "compact_throw");
	const automatic = records.filter(record => record["kind"] === "auto_compaction_start" || record["kind"] === "auto_compaction_end");
	check(ctx, "the probe triggered exactly one manual compaction", triggers.length === 1, String(triggers.length));
	check(ctx, "no compaction error or skipped compact was recorded", failures.length === 0, show(failures));
	check(ctx, "the manual compaction is not an automatic compaction", automatic.length === 0, show(automatic));
	check(ctx, "the probe observed one native compaction preparation and compaction", prepared.length === 1 && compacting.length === 1, show({ prepared: prepared.length, compacting: compacting.length }));
	const preparation = prepared[0];
	const summarizedMessages = preparation?.["messagesToSummarize"];
	const prefixMessages = preparation?.["turnPrefixMessages"];
	const firstKept = preparation?.["firstKeptEntryId"];
	check(ctx, "the compaction has real history to summarize", typeof summarizedMessages === "number" &&
		typeof prefixMessages === "number" && summarizedMessages + prefixMessages > 0, show(preparation));
	check(ctx, "the compaction preparation names the first kept entry", typeof firstKept === "string" && firstKept.length > 0, show(preparation));
	check(ctx, "the compaction carries no synthetic summarizer instructions", preparation?.["customInstructions"] == null, show(preparation));
	check(ctx, "exactly one native compaction entry was delivered", compacted.length === 1 && compacted[0]?.["entryType"] === "compaction", show(compacted));
	const entryRecord = compacted[0];
	const entrySummaryLength = entryRecord?.["summaryLength"];
	check(ctx, "the native compaction summary is not empty", typeof entrySummaryLength === "number" && entrySummaryLength > 0, show(entryRecord));
	const complete = completes[0];
	const callbackSummary = complete?.["summarySha"];
	const callbackSummaryLength = complete?.["summaryLength"];
	const callbackTokens = complete?.["tokensBefore"];
	const callbackFirstKept = complete?.["firstKeptEntryId"];
	check(
		ctx,
		"the ctx.compact callback returned a real CompactionResult",
		typeof callbackSummary === "string" &&
			typeof callbackSummaryLength === "number" &&
			callbackSummaryLength > 0 &&
			typeof callbackTokens === "number" &&
			callbackTokens > 0 &&
			typeof callbackFirstKept === "string" &&
			callbackFirstKept.length > 0,
		show(complete),
	);
	check(ctx, "the callback summary is the native compaction entry summary", callbackSummary === entryRecord?.["summarySha"], show({ callback: callbackSummary ?? null, native: entryRecord?.["summarySha"] ?? null }));

	const checkpointed = await pollSnapshot(
		ctx,
		runId,
		"pre-compaction durable checkpoint",
		Math.min(ctx.deadlineMs, 300_000),
		snapshot => snapshot.events.some(event => event.kind === "checkpoint" && eventData(event)?.["reason"] === "session_before_compact"),
	);
	const checkpointEvent = [...checkpointed.events].reverse().find(event => event.kind === "checkpoint" && eventData(event)?.["reason"] === "session_before_compact");
	const preparedIndex = preparation === undefined ? -1 : records.indexOf(preparation);
	const compactedIndex = entryRecord === undefined ? -1 : records.indexOf(entryRecord);
	check(
		ctx,
		"the runtime checkpointed the active binding before the compaction",
		checkpointEvent !== undefined && preparedIndex >= 0 && compactedIndex > preparedIndex,
		show({ checkpoint: checkpointEvent?.sequence ?? null, preparedIndex, compactedIndex }),
	);

	const freshRecords = await waitForProbe(
		probe.log,
		"the first provider-bound context after the compaction",
		all => all.some(record => record["kind"] === "context" && record["afterCompact"] === true),
		Math.min(ctx.deadlineMs, 300_000),
	);
	const fresh = freshRecords.find(record => record["kind"] === "context" && record["afterCompact"] === true);

	const result = await waitForSupervisor(ctx, supervisor, runId, ctx.deadlineMs);
	const cli = parseCliResult(result);
	check(ctx, "start exited 0", result.exitCode === 0 && !result.timedOut, `exit ${result.exitCode}: ${result.stderr.trim()}`);
	check(ctx, "driver result reports completed", cli["status"] === "completed", show(cli));
	const final = snapshotOf(ctx.storePath, runId);
	const run = final.run;
	check(ctx, "store status is completed", run.status === "completed", `${run.status}: ${run.waiting?.reason ?? ""}`);
	check(ctx, "completed run has no pending effect", Object.keys(run.pending).length === 0, show(Object.keys(run.pending)));
	const filePath = join(ctx.workspace, "autonomy-smoke.txt");
	check(ctx, "the requested file has exactly the fixture bytes after compaction", fileHex(filePath) === sha256Hex(COMPLETION_BYTES), fileHex(filePath) ?? "unreadable");
	check(ctx, "the immutable objective is the exact fixture text", run.objective === objective);
	checkAuthority(ctx, run);
	check(
		ctx,
		"policy limits are the fixture limits",
		run.policy.maxJudgeCalls === ctx.policy.maxJudgeCalls &&
			run.policy.maxExecutorCalls === ctx.policy.maxExecutorCalls &&
			run.policy.maxRuntimeMs === ctx.policy.maxRuntimeMs &&
			run.policy.maxContextBytes === ctx.policy.maxContextBytes &&
			run.policy.maxArtifactBytes === ctx.policy.maxArtifactBytes,
		show(run.policy),
	);
	const planUrl = run.checkpoint.plan?.planUrl;
	check(ctx, "the approved plan survived the compaction", typeof planUrl === "string" && planUrl.length > 0, show(run.checkpoint.plan ?? null));
	const injects = final.events.filter(event => event.kind === "context.inject" && checkpointEvent !== undefined && event.sequence > checkpointEvent.sequence);
	const contexts = Array.isArray(fresh?.["contexts"]) ? (fresh["contexts"] as unknown[]).filter((value): value is string => typeof value === "string") : [];
	check(
		ctx,
		"the provider-bound context after the compaction carries the bound runtime message",
		injects.length > 0 || contexts.length > 0,
		show({ injects: injects.map(event => eventData(event) ?? null), fresh: fresh ?? null }),
	);
	check(
		ctx,
		"the next provider request carries the exact objective and approved plan",
		planUrl !== undefined && contexts.some(text => text.includes(`Objective (immutable): ${objective}`) && text.includes(planUrl)),
		show(contexts.map(text => text.slice(0, 300))),
	);
	const nativeCompaction = sessionEntries(run).find(entry => entry["type"] === "compaction");
	const nativeSummary = nativeCompaction?.["summary"];
	check(
		ctx,
		"the native session stores the compaction entry with the callback summary",
		typeof nativeSummary === "string" && sha256Hex(nativeSummary) === complete?.["summarySha"],
		show({ native: typeof nativeSummary === "string" ? sha256Hex(nativeSummary) : null, callback: complete?.["summarySha"] ?? null }),
	);
}

async function scenarioCancel(ctx: ScenarioContext): Promise<void> {
	const cancelPath = join(ctx.workspace, "autonomy-cancel.txt");
	const cancelHex = sha256Hex(CANCEL_BYTES);
	writeEffectScript(ctx, "cancel-effect.sh", "autonomy-cancel.txt", CANCEL_BYTES);
	const supervisor = spawnSupervisor(ctx, "start", startArgsOf(ctx), ctx.deadlineMs + 120_000);
	const runId = await waitForRunId(ctx, 60_000);
	const active = await pollSnapshot(
		ctx,
		runId,
		"active run with the long native effect in flight before cancellation",
		Math.min(ctx.deadlineMs, 900_000),
		snapshot =>
			snapshot.run.status === "running" &&
			snapshot.run.session !== undefined &&
			snapshot.run.wake?.status === "started" &&
			fileHex(cancelPath) === cancelHex &&
			Object.values(snapshot.run.pending).some(intent => intent.kind === "tool" && show(intent.payload ?? null).includes("cancel-effect.sh")),
	);
	const pendingBefore = Object.keys(active.run.pending);
	const epochBefore = active.run.epoch;
	const childBefore = active.run.child;
	checkAuthority(ctx, active.run);
	check(
		ctx,
		"the cancel fixture observed a pending native /usr/bin/sleep effect before the operator stop",
		pendingBefore.length > 0 && fileHex(cancelPath) === cancelHex,
		show({ pending: pendingBefore, fileHex: fileHex(cancelPath) }),
	);
	let cancelTree: ObservedProcess[] = [];
	let cancelEffects: ObservedProcess[] = [];
	const cancelTreeDeadline = Date.now() + 10_000;
	while (childBefore !== undefined && Date.now() < cancelTreeDeadline) {
		cancelTree = descendantsOf(childBefore.pid);
		cancelEffects = cancelTree.filter(entry => /\/usr\/bin\/sleep\s+60/.test(entry.command));
		if (cancelEffects.length > 0) break;
		await Bun.sleep(100);
	}
	for (const entry of cancelTree) ctx.trackedProcesses.push(entry);
	check(
		ctx,
		"a real /usr/bin/sleep descendant runs outside the executor group before the operator stop",
		cancelEffects.some(entry => entry.group !== childBefore?.group),
		show({ tree: cancelTree.map(entry => ({ pid: entry.pid, group: entry.group, command: entry.command })), childGroup: childBefore?.group ?? null }),
	);
	await stopRun(ctx, runId, supervisor);

	const cancelled = snapshotOf(ctx.storePath, runId);
	check(ctx, "cancelled run keeps its epoch", cancelled.run.epoch === epochBefore, `${cancelled.run.epoch} vs ${epochBefore}`);
	check(ctx, "cancelled run has no wake", cancelled.run.wake === undefined, show(cancelled.run.wake));
	for (const id of pendingBefore) {
		check(ctx, `pending effect '${id}' is preserved as unknown, not silently cleared`, cancelled.run.pending[id] !== undefined, show(Object.keys(cancelled.run.pending)));
	}
	check(ctx, "the cancelled native effect wrote exactly the fixture bytes", fileHex(cancelPath) === cancelHex, fileHex(cancelPath) ?? "unreadable");
	const cancelledAt = cancelled.run.sequence;
	if (childBefore !== undefined) {
		check(ctx, "the recorded child is no longer executable", !identityAlive(childBefore), show(childBefore));
	}

	const resume = await runCli(ctx, "resume", ["--run", runId], 60_000);
	const resumed = parseCliResult(resume);
	check(ctx, "resume of a cancelled run exits 0", resume.exitCode === 0 && !resume.timedOut, `${resume.exitCode}: ${resume.stderr.trim()}`);
	check(ctx, "resume reports the terminal status", resumed["status"] === "cancelled", show(resumed));
	const after = snapshotOf(ctx.storePath, runId);
	check(ctx, "the cancelled run stays cancelled after resume", after.run.status === "cancelled", after.run.status);
	check(
		ctx,
		"resume preserved the committed audience receipt",
		show(after.run.audience ?? null) === show(cancelled.run.audience ?? null),
		show({ before: cancelled.run.audience ?? null, after: after.run.audience ?? null }),
	);
	const launches = eventsAfter(after.events, cancelledAt).filter(event => LAUNCH_KINDS[event.kind] === true);
	check(ctx, "no supervisor or child launch was admitted after cancellation", launches.length === 0, show(launches.map(event => event.kind)));
	check(ctx, "no new child was bound after cancellation", after.run.child === undefined || childBefore === undefined || show(after.run.child) === show(childBefore), show(after.run.child));

	const beforeSecondCancel = snapshotOf(ctx.storePath, runId);
	const secondCancel = withStore(ctx.storePath, store => store.cancel(runId, "second cancellation"));
	const afterSecondCancel = snapshotOf(ctx.storePath, runId);
	const authorityBefore = show({
		owner: beforeSecondCancel.run.owner ?? null,
		scope: beforeSecondCancel.run.scope ?? null,
		pending: Object.keys(beforeSecondCancel.run.pending).sort(),
		waiting: beforeSecondCancel.run.waiting ?? null,
	});
	const authorityAfter = show({
		owner: secondCancel.owner ?? null,
		scope: secondCancel.scope ?? null,
		pending: Object.keys(secondCancel.pending).sort(),
		waiting: secondCancel.waiting ?? null,
	});
	check(ctx, "a second cancellation is idempotent: the run stays cancelled", secondCancel.status === "cancelled", secondCancel.status);
	check(
		ctx,
		"a second cancellation keeps the run sequence and timestamp",
		secondCancel.sequence === beforeSecondCancel.run.sequence && secondCancel.updatedAt === beforeSecondCancel.run.updatedAt,
		show({
			sequence: secondCancel.sequence,
			sequenceBefore: beforeSecondCancel.run.sequence,
			updatedAt: secondCancel.updatedAt,
			updatedAtBefore: beforeSecondCancel.run.updatedAt,
		}),
	);
	check(
		ctx,
		"a second cancellation appends no cancel event",
		afterSecondCancel.events.length === beforeSecondCancel.events.length,
		show(afterSecondCancel.events.map(event => event.kind)),
	);
	check(ctx, "a second cancellation keeps the owner, scope, pending effects and waiting state", authorityAfter === authorityBefore, show({ before: authorityBefore, after: authorityAfter }));
	check(ctx, "a cancelled run keeps no wake after the second cancellation", secondCancel.wake === undefined, show(secondCancel.wake));
	const refusals = withStore(ctx.storePath, store => {
		const me = processIdentity();
		const outcome = { claim: "", update: "" };
		if (me !== null) {
			try {
				store.claim(runId, me);
			} catch (error) {
				outcome.claim = messageOf(error);
			}
		}
		try {
			store.update(runId, { epoch: after.run.epoch }, run => {
				run.status = "running";
			});
		} catch (error) {
			outcome.update = messageOf(error);
		}
		return outcome;
	});
	check(ctx, "a terminal run refuses a new claim", refusals.claim.includes("terminal"), show(refusals));
	check(ctx, "a terminal run refuses an admission update", refusals.update.includes("terminal"), show(refusals));
}

async function scenarioCrash(ctx: ScenarioContext): Promise<void> {
	const effectPath = join(ctx.workspace, "crash-effect.txt");
	const markerHex = sha256Hex(CRASH_MARKER_BYTES);
	const effectHex = sha256Hex(CRASH_EFFECT_BYTES);
	writeEffectScript(ctx, "crash-effect.sh", "crash-effect.txt", CRASH_EFFECT_BYTES);
	const supervisor = spawnSupervisor(ctx, "start", startArgsOf(ctx), ctx.deadlineMs + 120_000);
	const runId = await waitForRunId(ctx, 60_000);
	const active = await pollSnapshot(
		ctx,
		runId,
		"running executor before the crash",
		Math.min(ctx.deadlineMs, 300_000),
		snapshot => snapshot.run.status === "running" && snapshot.run.session !== undefined && snapshot.run.child !== undefined,
	);
	const child = active.run.child;
	checkAuthority(ctx, active.run);
	check(ctx, "a native child identity is bound", child !== undefined, "run.child missing");
	const scopeBefore = active.run.scope;
	check(ctx, "the pre-crash run has a canonical observed scope", scopeBefore !== undefined, show(scopeBrief(scopeBefore)));
	if (scopeBefore !== undefined && child !== undefined) {
		let membership = false;
		try {
			assertAutonomyScope(scopeBefore, child);
			membership = true;
		} catch (error) {
			appendBoundedLine(join(ctx.dir, "scope-membership.jsonl"), { at: Date.now(), problem: messageOf(error), scope: scopeBrief(scopeBefore), child });
		}
		check(ctx, "the pre-crash child is a real member of the observed scope", membership, show({ scope: scopeBrief(scopeBefore), child }));
	}

	const marker = await pollSnapshot(
		ctx,
		runId,
		"crash marker artifact checkpointed",
		Math.min(ctx.deadlineMs, 900_000),
		snapshot => {
			const urls = artifactUrls(snapshot.run, "crash-marker.txt");
			return urls.length === 1 && snapshot.run.artifacts[urls[0] ?? ""] === markerHex;
		},
	);
	const markerUrls = artifactUrls(marker.run, "crash-marker.txt");
	check(ctx, "exactly one crash marker alias exists", markerUrls.length === 1, show(Object.keys(marker.run.artifacts)));
	check(ctx, "the crash marker ledger digest is exact", marker.run.artifacts[markerUrls[0] ?? ""] === markerHex, show(marker.run.artifacts));

	const observed = await pollSnapshot(
		ctx,
		runId,
		"observed local effect with the long-running command in flight",
		Math.min(ctx.deadlineMs, 900_000),
		snapshot =>
			fileHex(effectPath) === effectHex &&
			Object.values(snapshot.run.pending).some(intent => intent.kind === "tool" && show(intent.payload ?? null).includes("crash-effect.sh")),
	);
	const pendingIds = Object.entries(observed.run.pending)
		.filter(([, intent]) => intent.kind === "tool")
		.map(([id]) => id);
	const epochBefore = observed.run.epoch;
	const childBefore = observed.run.child;
	check(
		ctx,
		"the bound child identity did not change before the crash",
		active.run.child !== undefined &&
			childBefore !== undefined &&
			active.run.child.pid === childBefore.pid &&
			active.run.child.start === childBefore.start,
		show({ active: active.run.child, crash: childBefore }),
	);
	check(ctx, "the effect file has exactly the fixture bytes before the crash", fileHex(effectPath) === effectHex, fileHex(effectPath) ?? "unreadable");
	check(ctx, "the marker bytes are exact before the crash", artifactHex(ctx.storePath, runId, markerUrls[0] ?? "") === markerHex);

	let tree: ObservedProcess[] = [];
	let effectProcesses: ObservedProcess[] = [];
	const treeDeadline = Date.now() + 10_000;
	while (Date.now() < treeDeadline) {
		tree = childBefore === undefined ? [] : descendantsOf(childBefore.pid);
		effectProcesses = tree.filter(entry => /\/usr\/bin\/sleep\s+60|\bsleep\s+60/.test(entry.command));
		if (effectProcesses.length > 0) break;
		await Bun.sleep(100);
	}
	for (const entry of tree) ctx.trackedProcesses.push(entry);
	writeBoundedJson(join(ctx.dir, "process-tree.json"), {
		child: childBefore ?? null,
		tree,
		effectProcesses: effectProcesses.map(entry => ({ pid: entry.pid, group: entry.group, command: entry.command })),
		effectOutsideExecutorGroup: effectProcesses.filter(entry => entry.group !== childBefore?.group).map(entry => ({ pid: entry.pid, group: entry.group })),
	});
	check(
		ctx,
		"the long effect runs in a native descendant of the bound executor",
		effectProcesses.length > 0,
		show(tree.map(entry => ({ pid: entry.pid, group: entry.group, command: entry.command }))),
	);
	check(
		ctx,
		"the long effect runs outside the bound executor's process group",
		effectProcesses.some(entry => entry.group !== childBefore?.group),
		show(effectProcesses.map(entry => ({ pid: entry.pid, group: entry.group, executorGroup: childBefore?.group ?? null }))),
	);
	check(
		ctx,
		"the long effect is the external /usr/bin/sleep binary",
		effectProcesses.some(entry => entry.command.includes("/usr/bin/sleep")),
		show(effectProcesses.map(entry => ({ pid: entry.pid, group: entry.group, command: entry.command }))),
	);

	// The crash is exactly the supervisor plus the OMP leader. Detached native work is deliberately
	// left alive: the production driver, not this harness, must fence the whole observed scope.
	killGroup(supervisor.pid);
	if (childBefore !== undefined) {
		ctx.childGroups.add(childBefore.group);
		killGroup(childBefore.group);
	}
	const groupsGone = childBefore === undefined ? false : await awaitGroupGone(childBefore.group, 10_000);
	check(ctx, "the crashed child process group is gone", groupsGone, childBefore === undefined ? "no child" : `group ${childBefore.group}`);
	const childGone = childBefore !== undefined && (await awaitIdentityGone(childBefore, 10_000));
	check(ctx, "the bound executor leader identity is dead", childGone, show(childBefore));
	check(
		ctx,
		"the detached native effect survived the leader-only crash",
		effectProcesses.length > 0 && effectProcesses.every(entry => identityMatches(entry)),
		show(effectProcesses.map(entry => ({ pid: entry.pid, group: entry.group, alive: identityMatches(entry) }))),
	);
	await Bun.sleep(3000);
	check(
		ctx,
		"detached native work and exact effect bytes persist after the crash",
		effectProcesses.length > 0 && effectProcesses.every(entry => identityMatches(entry)) && fileHex(effectPath) === effectHex,
		show({ survivors: effectProcesses.map(entry => entry.pid), effectHex: fileHex(effectPath) }),
	);

	const crashed = snapshotOf(ctx.storePath, runId);
	check(ctx, "the crashed run is not terminal", crashed.run.status !== "completed" && crashed.run.status !== "cancelled" && crashed.run.status !== "infeasible", crashed.run.status);
	for (const id of pendingIds) {
		check(ctx, `unknown intent '${id}' survives the crash`, crashed.run.pending[id] !== undefined, show(Object.keys(crashed.run.pending)));
		const recorded = payloadScope(asRecord(crashed.run.pending[id]?.payload)?.["scope"]);
		check(
			ctx,
			`the pending intent '${id}' recorded the exact pre-crash scope`,
			sameScope(recorded, scopeBefore),
			show({ recorded: scopeBrief(recorded), bound: scopeBrief(scopeBefore) }),
		);
	}
	check(ctx, "exact effect bytes survive the crash", fileHex(effectPath) === effectHex, fileHex(effectPath) ?? "unreadable");
	const crashedUrls = artifactUrls(crashed.run, "crash-marker.txt");
	check(ctx, "the exact marker alias survives the crash", crashedUrls.length === 1 && crashed.run.artifacts[crashedUrls[0] ?? ""] === markerHex, show(crashed.run.artifacts));
	check(ctx, "exact marker bytes survive the crash", artifactHex(ctx.storePath, runId, crashedUrls[0] ?? "") === markerHex);

	check(
		ctx,
		"the detached native survivor is still alive immediately before the production resume",
		effectProcesses.length > 0 && effectProcesses.every(entry => identityMatches(entry)),
		show(effectProcesses.map(entry => ({ pid: entry.pid, start: entry.start, alive: identityMatches(entry) }))),
	);
	const resumedSupervisor = spawnSupervisor(ctx, "resume", resumeArgsOf(ctx, runId), ctx.deadlineMs + 120_000);
	const expectedIds = Object.keys(crashed.run.pending).sort();
	const recovered = await pollSnapshot(
		ctx,
		runId,
		"production driver recorded the whole-scope fence receipt",
		Math.min(ctx.deadlineMs, 600_000),
		snapshot => scopeBefore !== undefined && receiptCovering(snapshot.run.fences, scopeBefore, expectedIds) !== undefined,
	);
	const run = recovered.run;
	check(
		ctx,
		"recovery preserved the committed audience receipt",
		show(run.audience ?? null) === show(crashed.run.audience ?? null) &&
			run.audience?.objectiveDigest === sha256Hex(readFileSync(ctx.objectiveFile, "utf8")),
		show({ before: crashed.run.audience ?? null, after: run.audience ?? null }),
	);
	const fenceReceipt = scopeBefore === undefined ? undefined : receiptCovering(run.fences, scopeBefore, expectedIds);
	check(
		ctx,
		"the production driver recorded a durable receipt for the exact old scope and pending identities",
		fenceReceipt !== undefined && scopeBefore !== undefined && sameScope(fenceReceipt.scope, scopeBefore),
		show({ receipt: fenceReceipt ?? null, expectedIds, scope: scopeBrief(scopeBefore) }),
	);
	check(
		ctx,
		"the fence receipt is bound to the current kernel boot and a real observation time",
		fenceReceipt !== undefined && fenceReceipt.scope.bootId === autonomyBootId() && Number.isFinite(fenceReceipt.observedAt) && fenceReceipt.observedAt > 0,
		show(fenceReceipt ?? null),
	);
	const fenceEvent = recovered.events.find(
		event => event.kind === "scope-fenced" && sameScope(payloadScope(asRecord(event.data)?.["scope"]), scopeBefore),
	);
	const fenceSequence = fenceEvent?.sequence ?? 0;
	check(ctx, "the fence receipt is a committed store event, not an inferred state", fenceEvent !== undefined && fenceSequence > 0, show(scopeBrief(scopeBefore)));
	check(ctx, "recovery never claims completion from an unfenceable inherited effect", run.status !== "completed", run.status);
	check(ctx, "recovery took a new epoch", run.epoch > epochBefore, `${run.epoch} vs ${epochBefore}`);
	const claim = eventData(lastEvent(recovered.events, "claim"));
	const claimSequence = lastEvent(recovered.events, "claim")?.sequence ?? 0;
	check(ctx, "a takeover claim was committed", claim?.["takeover"] === true && claim?.["epoch"] === run.epoch, show(claim));
	const fenceMarker = eventData(lastEvent(recovered.events, "driver.fence"));
	if (fenceMarker !== undefined) {
		check(
			ctx,
			"the driver fence event names the same canonical scope rather than a unit name",
			sameScope(payloadScope(fenceMarker["scope"]), scopeBefore),
			show(fenceMarker),
		);
		check(ctx, "the driver fence reports positive whole-scope emptiness", fenceMarker["empty"] === true && fenceMarker["aliveAfter"] === false, show(fenceMarker));
	}
	const earlyEffects = recovered.events.filter(
		event => event.sequence > claimSequence && event.sequence < fenceSequence && (event.kind === "intent.admit" || event.kind === "reconcile"),
	);
	check(
		ctx,
		"no reconciliation or new effect was committed before the durable fence receipt",
		earlyEffects.length === 0,
		show(earlyEffects.map(event => ({ kind: event.kind, sequence: event.sequence }))),
	);
	const recoveryDecision = eventData(lastEvent(recovered.events, "driver.recovery_decision"));
	check(
		ctx,
		"recovery was judged with a committed context digest and typed outcome",
		typeof recoveryDecision?.["contextDigest"] === "string" && asRecord(recoveryDecision?.["outcome"]) !== undefined,
		show(recoveryDecision),
	);
	const restoreEvent = [...recovered.events].reverse().find(event => event.kind === "autonomy.restore" && event.sequence > claimSequence);
	const restore = eventData(restoreEvent);
	const restoredPending: string[] = Array.isArray(restore?.["pending"]) ? (restore["pending"] as unknown[]).map(String) : [];
	if (restoreEvent !== undefined) {
		check(ctx, "autonomy.restore binds the resumed epoch and session", restore?.["epoch"] === run.epoch && typeof restore?.["sessionId"] === "string", show(restore));
		check(
			ctx,
			"autonomy.restore names the inherited unknown intents",
			pendingIds.every(id => restoredPending.includes(id)),
			show(restore),
		);
	}
	const survivorsGone = (await Promise.all(effectProcesses.map(entry => awaitObservedGone(entry, 10_000)))).every(Boolean);
	check(
		ctx,
		"the driver's whole-scope fence removed the detached native survivors",
		survivorsGone,
		show(effectProcesses.map(entry => ({ pid: entry.pid, start: entry.start, alive: identityMatches(entry) }))),
	);
	let scopeEmpty = false;
	if (scopeBefore !== undefined) {
		try {
			scopeEmpty = autonomyScopeEmpty(scopeBefore);
		} catch (error) {
			appendBoundedLine(join(ctx.dir, "scope-after-fence.jsonl"), { at: Date.now(), problem: messageOf(error), scope: scopeBrief(scopeBefore) });
			scopeEmpty = false;
		}
	}
	check(ctx, "the fenced observed scope is positively empty at the kernel level", scopeEmpty, show(scopeBrief(scopeBefore)));

	const reconciled = await pollSnapshot(
		ctx,
		runId,
		"inherited effects observed and judged after the whole-scope fence",
		Math.min(ctx.deadlineMs, 600_000),
		snapshot =>
			pendingIds.every(id => snapshot.run.pending[id] === undefined) &&
			pendingIds.every(id =>
				snapshot.events.some(event => {
					const data = eventData(event);
					return event.kind === "reconcile" && data?.["intent"] === id;
				}),
			),
	);
	for (const id of pendingIds) {
		const events = reconciled.events.filter(event => {
			const data = eventData(event);
			return event.kind === "reconcile" && data?.["intent"] === id;
		});
		check(ctx, `inherited intent '${id}' left pending only through a judged reconciliation`, events.length === 1, show(events.map(event => event.data)));
		const data = eventData(events[0]);
		check(
			ctx,
			`the reconciliation of '${id}' is marked inherited, not a returned attempt`,
			data?.["inherited"] === true && data?.["attemptReturned"] === false,
			show(data),
		);
		const outcome = data?.["outcome"];
		check(
			ctx,
			`the reconciliation of '${id}' carries an evidence-backed judged outcome`,
			(outcome === "executed" || outcome === "not_executed") &&
				typeof data?.["evidenceDigest"] === "string" &&
				String(data["evidenceDigest"]).length === 64,
			show(data),
		);
		const fenceData = asRecord(data?.["fence"]);
		check(
			ctx,
			`the reconciliation of '${id}' is bound to the exact fence receipt and scope`,
			sameScope(payloadScope(fenceData?.["scope"]), scopeBefore) &&
				Array.isArray(fenceData?.["intentIds"]) &&
				(fenceData["intentIds"] as unknown[]).includes(id),
			show(data),
		);
		check(ctx, `the reconciliation of '${id}' follows the fence receipt`, (events[0]?.sequence ?? 0) > fenceSequence, show({ sequence: events[0]?.sequence, fenceSequence }));
	}
	check(ctx, "the crash run did not become infeasible after a successful whole-scope fence", reconciled.run.status !== "infeasible", reconciled.run.status);
	let contained = reconciled;
	if (contained.run.status !== "completed" && contained.run.status !== "cancelled") {
		await stopRun(ctx, runId, resumedSupervisor);
		contained = snapshotOf(ctx.storePath, runId);
	} else {
		const stopped = await awaitResult(resumedSupervisor.result, 60_000, "resumed supervisor exit").catch(() => undefined);
		if (stopped !== undefined) {
			recordCli(ctx, stopped);
			resumedSupervisor.recorded = true;
			check(ctx, "the resumed supervisor exits cleanly after reconciliation", stopped.exitCode === 0, `exit ${stopped.exitCode}: ${stopped.stderr.trim()}`);
		}
	}
	const finalUrls = artifactUrls(contained.run, "crash-marker.txt");
	check(ctx, "exactly one marker alias remains after recovery", finalUrls.length === 1, show(Object.keys(contained.run.artifacts)));
	check(ctx, "the marker ledger digest is unchanged after recovery", contained.run.artifacts[finalUrls[0] ?? ""] === markerHex, show(contained.run.artifacts));
	check(ctx, "the marker artifact bytes are exact after recovery", artifactHex(ctx.storePath, runId, finalUrls[0] ?? "") === markerHex);
	check(ctx, "the effect bytes are exact after recovery", fileHex(effectPath) === effectHex, fileHex(effectPath) ?? "unreadable");
	writeFileSync(join(ctx.dir, "observed-effect-hex.txt"), `${effectHex}\n${markerHex}\n`, "utf8");
}

async function scenarioAdmission(ctx: ScenarioContext): Promise<void> {
	writeFileSync(join(ctx.workspace, "notes.txt"), NOTES_BYTES, "utf8");
	const supervisor = spawnSupervisor(ctx, "start", startArgsOf(ctx), ctx.deadlineMs + 120_000);
	const runId = await waitForRunId(ctx, 60_000);
	const active = await pollSnapshot(
		ctx,
		runId,
		"first run active",
		Math.min(ctx.deadlineMs, 300_000),
		snapshot => snapshot.run.status === "running" && snapshot.run.session !== undefined,
	);
	const ownerBefore = active.run.owner;
	const epochBefore = active.run.epoch;
	checkAuthority(ctx, active.run);
	const listBefore = withStore(ctx.storePath, store => store.list());
	check(ctx, "exactly one run exists before the competing start", listBefore.length === 1, String(listBefore.length));

	const competing = await runCli(ctx, "start", startArgsOf(ctx), 60_000);
	check(ctx, "an overlapping-root start exits non-zero", competing.exitCode !== 0 && !competing.timedOut, `${competing.exitCode}: ${competing.stderr.trim()}`);
	check(ctx, "the overlap refusal names the overlapping authorized root", competing.stderr.includes("overlapping authorized root"), competing.stderr.trim());
	const listAfter = withStore(ctx.storePath, store => store.list());
	check(ctx, "the refused start created no run", listAfter.length === 1, String(listAfter.length));
	const afterRefusal = snapshotOf(ctx.storePath, runId);
	check(ctx, "the first run's owner is unchanged", show(afterRefusal.run.owner) === show(ownerBefore), show(afterRefusal.run.owner));
	check(ctx, "the first run's epoch is unchanged", afterRefusal.run.epoch === epochBefore, `${afterRefusal.run.epoch} vs ${epochBefore}`);
	check(ctx, "the first run is still running", afterRefusal.run.status === "running", afterRefusal.run.status);

	const competingSupervisor = spawnSupervisor(ctx, "resume", resumeArgsOf(ctx, runId), 60_000);
	const refusedResume = await awaitResult(competingSupervisor.result, 60_000, "competing resume");
	recordCli(ctx, refusedResume);
	competingSupervisor.recorded = true;
	check(ctx, "a competing supervisor exits non-zero", refusedResume.exitCode !== 0 && !refusedResume.timedOut, `${refusedResume.exitCode}: ${refusedResume.stderr.trim()}`);
	check(ctx, "the competing supervisor is refused as a live owner", refusedResume.stderr.includes("another live supervisor"), refusedResume.stderr.trim());
	const afterResumeRefusal = snapshotOf(ctx.storePath, runId);
	check(ctx, "the competing resume changed no owner", show(afterResumeRefusal.run.owner) === show(ownerBefore), show(afterResumeRefusal.run.owner));
	check(ctx, "the competing resume changed no epoch", afterResumeRefusal.run.epoch === epochBefore, `${afterResumeRefusal.run.epoch} vs ${epochBefore}`);
	check(ctx, "the competing resume left the run running", afterResumeRefusal.run.status === "running", afterResumeRefusal.run.status);

	await stopRun(ctx, runId, supervisor);
	const released = withStore(ctx.storePath, store => {
		const created = store.create(admissionObjective(), ctx.policy);
		const ready = store.read(created.id);
		const cancelled = store.cancel(created.id, "autonomy smoke root release");
		return { id: created.id, status: ready.status, cancelled: cancelled.status };
	});
	check(ctx, "a released root accepts a new run", released.id !== runId, released.id);
	check(ctx, "the new run starts ready and unlaunched", released.status === "ready", released.status);
	check(ctx, "the new run can be cancelled", released.cancelled === "cancelled", released.cancelled);
	const releasedBefore = withStore(ctx.storePath, store => store.read(released.id));
	const releasedEventsBefore = withStore(ctx.storePath, store => store.events(released.id)).length;
	const releasedSecondCancel = withStore(ctx.storePath, store => store.cancel(released.id, "again"));
	const releasedAfter = withStore(ctx.storePath, store => ({ run: store.read(released.id), events: store.events(released.id) }));
	check(ctx, "the released-and-cancelled run keeps its cancelled status on a second cancellation", releasedSecondCancel.status === "cancelled", releasedSecondCancel.status);
	check(
		ctx,
		"the released-and-cancelled run keeps its sequence and timestamp",
		releasedSecondCancel.sequence === releasedBefore.sequence && releasedSecondCancel.updatedAt === releasedBefore.updatedAt,
		show({ sequence: releasedSecondCancel.sequence, sequenceBefore: releasedBefore.sequence, updatedAt: releasedSecondCancel.updatedAt, updatedAtBefore: releasedBefore.updatedAt }),
	);
	check(ctx, "the second cancellation appends no event", releasedAfter.events.length === releasedEventsBefore, show(releasedAfter.events.map(event => event.kind)));
	check(
		ctx,
		"the second cancellation keeps owner, scope, wake and pending unchanged",
		show(releasedSecondCancel.owner ?? null) === show(releasedBefore.owner ?? null) &&
			show(releasedSecondCancel.scope ?? null) === show(releasedBefore.scope ?? null) &&
			show(releasedSecondCancel.wake ?? null) === show(releasedBefore.wake ?? null) &&
			show(Object.keys(releasedSecondCancel.pending).sort()) === show(Object.keys(releasedBefore.pending).sort()),
		show({ before: releasedBefore, after: releasedSecondCancel }),
	);
	const terminalRefusals = withStore(ctx.storePath, store => {
		const me = processIdentity();
		const outcome = { claim: "", update: "" };
		if (me !== null) {
			try {
				store.claim(released.id, me);
			} catch (error) {
				outcome.claim = messageOf(error);
			}
		}
		try {
			store.update(released.id, { epoch: releasedBefore.epoch }, run => {
				run.status = "running";
			});
		} catch (error) {
			outcome.update = messageOf(error);
		}
		return outcome;
	});
	check(ctx, "the released-and-cancelled run refuses a claim", terminalRefusals.claim.includes("terminal"), show(terminalRefusals));
	check(ctx, "the released-and-cancelled run refuses an admission update", terminalRefusals.update.includes("terminal"), show(terminalRefusals));
}

const SCENARIOS: ScenarioDefinition[] = [
	{ name: "startup", purpose: "native ready/get_state, bootstrap, wake commit/send/start and real judged work", run: scenarioStartup },
	{ name: "completion", purpose: "one objective reaches evidence-backed completed without later human input", run: scenarioCompletion },
	{ name: "async", purpose: "real native bash auto-background: the pending intent survives until the native wait-tool delivery settles exactly one intent", run: ctx => scenarioAsync(ctx, "native-wait") },
	{ name: "async-result", purpose: "real native bash auto-background: the pending intent survives until the automatic custom async-result follow-up settles exactly one intent", run: ctx => scenarioAsync(ctx, "async-result") },
	{ name: "compaction", purpose: "real ctx.compact through a smoke-only probe extension: native compaction, pre-compaction checkpoint, preserved objective/plan and fresh provider context", run: scenarioCompaction },
	{ name: "cancel", purpose: "operator stop while a detached native effect runs: driver fences the whole scope, unknown effect preserved, cancelled admission stays closed", run: scenarioCancel },
	{ name: "crash", purpose: "external crash containment: production driver fences the detached native survivors, unknown effect preserved, exact bytes retained, no false recovery", run: scenarioCrash },
	{ name: "admission", purpose: "overlapping root and competing supervisor are refused; roots release on cancel", run: scenarioAdmission },
];

function scenarioNames(): string {
	return SCENARIOS.map(scenario => scenario.name).join(", ");
}

function selectedScenarios(value: string): ScenarioDefinition[] {
	if (value === "all") return SCENARIOS;
	const wanted = value
		.split(",")
		.map(name => name.trim())
		.filter(name => name.length > 0);
	if (wanted.length === 0) throw new Error(`--scenario is empty; choose ${scenarioNames()}`);
	const selected: ScenarioDefinition[] = [];
	for (const name of wanted) {
		const definition = SCENARIOS.find(scenario => scenario.name === name);
		if (definition === undefined) throw new Error(`unknown scenario '${name}'; choose ${scenarioNames()}`);
		if (!selected.includes(definition)) selected.push(definition);
	}
	return selected;
}

/* -------------------------------------------------------------------------------------------------
 * Prerequisites, execution and matrix
 * ---------------------------------------------------------------------------------------------- */

async function prerequisiteProblems(options: Options): Promise<string[]> {
	const problems: string[] = [];
	if (process.platform !== "linux") problems.push("Linux /proc is required for process ownership and group fencing");
	const omp = options.omp ?? "omp";
	let ompExecutable = false;
	if ((Bun.which(omp) ?? "").length > 0) ompExecutable = true;
	else {
		try {
			accessSync(omp, constants.X_OK);
			ompExecutable = true;
		} catch {
			ompExecutable = false;
		}
	}
	if (!ompExecutable) problems.push(`the real omp executable was not found or is not executable: ${omp}`);
	for (const file of [DRIVER, ENTRY]) {
		if (!existsSync(file)) problems.push(`the checkout entry is missing: ${file}`);
	}
	if (!existsSync(join(CHECKOUT, "package.json"))) problems.push(`the checkout manifest is missing: ${join(CHECKOUT, "package.json")}`);
	let key: string | undefined;
	try {
		key = await memoizedApiKeyResolver(process.env)();
	} catch {
		key = undefined;
	}
	if (key === undefined || key.trim().length === 0) {
		problems.push("no TypeSafe API key resolved from the environment or resolver; the real judge cannot answer");
	}
	return problems;
}

interface ScenarioResult {
	scenario: string;
	outcome: "PASS" | "FAIL";
	reason?: string;
	checks: CheckEntry[];
	evidence: string;
	durationMs: number;
	cleanup: { actions: string[]; alive: string[] };
	counts?: { judgeCalls: number; executorCalls: number; status: string; epoch: number; generation: number };
}

function objectiveFor(name: string): string {
	switch (name) {
		case "completion":
		case "compaction":
			return completionObjective();
		case "async":
			return asyncObjective("native-wait");
		case "async-result":
			return asyncObjective("async-result");
		case "crash":
			return crashObjective();
		case "cancel":
			return cancelObjective();
		case "startup":
			return startupObjective();
		default:
			return admissionObjective();
	}
}

async function runScenario(definition: ScenarioDefinition, options: Options, outRoot: string): Promise<ScenarioResult> {
	const startedAt = Date.now();
	const objective = objectiveFor(definition.name);
	const ctx = prepareScenario(definition.name, options, outRoot, objective);
	let outcome: "PASS" | "FAIL" = "PASS";
	let reason: string | undefined;
	try {
		await definition.run(ctx);
	} catch (error) {
		outcome = "FAIL";
		reason = messageOf(error);
	}
	const cleanup = await cleanupScenario(ctx);
	if (outcome === "PASS" && cleanup.alive.length > 0) {
		outcome = "FAIL";
		reason = `process groups survived cleanup: ${cleanup.alive.join(", ")}`;
	}
	const counts = { judgeCalls: 0, executorCalls: 0, status: "unavailable", epoch: 0, generation: 0 };
	try {
		const [run] = withStore(ctx.storePath, store => store.list());
		if (run !== undefined) {
			counts.judgeCalls = run.judgeCalls;
			counts.executorCalls = run.executorCalls;
			counts.status = run.status;
			counts.epoch = run.epoch;
			counts.generation = run.generation;
		}
		if (options.keep && run?.session?.file !== undefined && existsSync(run.session.file)) {
			mkdirSync(join(ctx.dir, "session"), { recursive: true });
			copyFileSync(run.session.file, join(ctx.dir, "session", "session.jsonl"));
		}
	} catch {
		// Evidence remains readable from summary.json and the CLI logs.
	}
	try {
		const runs = withStore(ctx.storePath, store => store.list());
		const journal: Array<{ run: string; events: unknown[] }> = [];
		for (const run of runs) {
			const events = withStore(ctx.storePath, store => store.events(run.id));
			journal.push({ run: run.id, events });
		}
		writeBoundedJson(join(ctx.dir, "events.json"), journal);
		writeBoundedJson(join(ctx.dir, "state.json"), runs);
	} catch (error) {
		appendBoundedLine(join(ctx.dir, "evidence-errors.jsonl"), { at: Date.now(), error: messageOf(error) });
	}
	const result: ScenarioResult = {
		scenario: definition.name,
		outcome,
		...(reason === undefined ? {} : { reason }),
		checks: ctx.checks,
		evidence: ctx.dir,
		durationMs: Date.now() - startedAt,
		cleanup,
		counts,
	};
	writeBoundedJson(join(ctx.dir, "summary.json"), { purpose: definition.purpose, objective, ...result });
	return result;
}

function printMatrix(results: ScenarioResult[], outRoot: string): void {
	const executed = results.map(result => result.scenario);
	const passed = results.filter(result => result.outcome === "PASS").map(result => result.scenario);
	const lines: string[] = [];
	lines.push("");
	lines.push("autonomy smoke matrix");
	lines.push(`evidence root: ${outRoot}`);
	lines.push(`executed live: ${executed.length === 0 ? "(none)" : executed.join(", ")}`);
	lines.push(`passed live:   ${passed.length === 0 ? "(none)" : passed.join(", ")}`);
	lines.push("");
	lines.push("scenario           source        outcome  evidence");
	for (const result of results) {
		const failed = result.checks.filter(entry => !entry.ok);
		lines.push(
			`${result.scenario.padEnd(18)} live          ${result.outcome.padEnd(8)} ${result.evidence}${
				result.reason === undefined ? "" : `\n${"".padEnd(18)} ${"".padEnd(13)} ${result.reason}${failed.length > 0 ? ` (${failed.length} failed check${failed.length === 1 ? "" : "s"})` : ""}`
			}`,
		);
	}
	for (const row of DETERMINISTIC_ROWS) {
		lines.push(`${row.scenario.slice(0, 60)}`);
		lines.push(`  source: ${row.coverage}  evidence: ${row.evidence}`);
	}
	lines.push("");
	lines.push(`checks passed: ${results.reduce((total, result) => total + result.checks.filter(entry => entry.ok).length, 0)}`);
	lines.push(`checks failed: ${results.reduce((total, result) => total + result.checks.filter(entry => !entry.ok).length, 0)}`);
	console.log(lines.join("\n"));
}

function prepareOutRoot(requested: string | undefined): string {
	if (requested === undefined) return mkdtempSync(join(tmpdir(), "jev-autonomy-smoke-"));
	const root = resolve(requested);
	if (root === CHECKOUT || root.startsWith(`${CHECKOUT}/`)) {
		throw new Error("--out must live outside the checkout so the smoke never writes into the user's project");
	}
	mkdirSync(root, { recursive: true });
	if (existsSync(join(root, "matrix.json"))) throw new Error(`the evidence root already holds a smoke run: ${root}`);
	return root;
}

async function main(): Promise<void> {
	let options: Options;
	try {
		options = parseArgs(Bun.argv.slice(2));
	} catch (error) {
		console.error(`${messageOf(error)}\n\n${usage()}`);
		process.exitCode = 2;
		return;
	}
	if (options.list || options.scenarios === "list") {
		console.log([`scenarios: ${scenarioNames()}`, "", "deterministic coverage (not re-run by this live harness):", ...DETERMINISTIC_ROWS.map(row => `  ${row.scenario} - ${row.evidence}`)].join("\n"));
		return;
	}
	const selected = selectedScenarios(options.scenarios);
	const outRoot = prepareOutRoot(options.out);
	const prerequisites = await prerequisiteProblems(options);
	if (prerequisites.length > 0) {
		const summary = {
			outcome: "PREREQUISITE",
			problems: prerequisites,
			scenarios: selected.map(scenario => scenario.name),
			evidence: outRoot,
			at: new Date().toISOString(),
		};
		writeBoundedJson(join(outRoot, "prerequisite.json"), summary);
		console.error(`PREREQUISITE missing real host/provider (nothing was run):\n- ${prerequisites.join("\n- ")}\nEvidence: ${outRoot}`);
		process.exitCode = 78;
		return;
	}
	const results: ScenarioResult[] = [];
	for (const definition of selected) {
		console.log(`running ${definition.name}: ${definition.purpose}`);
		const result = await runScenario(definition, options, outRoot);
		results.push(result);
		console.log(`${result.outcome} ${definition.name}${result.reason === undefined ? "" : `: ${result.reason}`} - ${result.evidence}`);
	}
	const executed = results.map(result => result.scenario);
	const passed = results.filter(result => result.outcome === "PASS").map(result => result.scenario);
	writeBoundedJson(join(outRoot, "matrix.json"), {
		at: new Date().toISOString(),
		deadlineSeconds: options.deadlineSeconds,
		model: options.model ?? null,
		omp: options.omp ?? "omp",
		executedLive: executed,
		passedLive: passed,
		selected: selected.map(scenario => scenario.name),
		results,
		deterministic: DETERMINISTIC_ROWS,
	});
	printMatrix(results, outRoot);
	process.exitCode = results.some(result => result.outcome === "FAIL") ? 1 : 0;
}

if (import.meta.main) await main();
