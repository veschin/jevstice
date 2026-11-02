import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	openAutonomyStore,
	processIdentity,
	type AutonomyEvent,
	type AutonomyPolicy,
	type AutonomyRun,
	type AutonomyStore,
} from "../autonomy/store.js";
import { autonomyBootId } from "../autonomy/scope.js";
import {
	AUTONOMY_RECOVERY_QUESTION,
	parseAutonomyPolicy,
	resumeAutonomyRun,
	runAutonomyCli,
	startAutonomyRun,
	statusAutonomy,
	stopAutonomy,
} from "../autonomy/driver.js";
import type { Judge } from "../src/judge.js";
import { asRecord } from "../src/types.js";

const REPO = resolve(import.meta.dir, "..");
const ENTRY = realpathSync(join(REPO, "autonomy", "index.ts"));
const STORE_MODULE = join(REPO, "autonomy", "store.ts");
const SCOPE_MODULE = join(REPO, "autonomy", "scope.ts");
const OBJECTIVE = "Build a small autonomous feature.\n";

// These are real process and transient-systemd-scope integration tests: the supervisor, the RPC
// fixture and the kernel user manager exchange real OS signals and real cgroups, so bounded real
// waits are part of the behavior under test rather than scheduled unit-test time.

interface Setup {
	dir: string;
	root: string;
	storePath: string;
	objectiveFile: string;
	policyFile: string;
	policy: AutonomyPolicy;
	fixture: string;
	startFile: string;
	sleepFile: string;
}

const temporary: string[] = [];
const tracked: Array<{ storePath: string; runId: string }> = [];

afterEach(async () => {
	for (const entry of tracked.splice(0)) {
		try {
			await stopAutonomy({ store: entry.storePath, run: entry.runId, reason: "test cleanup" });
		} catch {
			// A failed cleanup is reported by the failed test, never masked as success.
		}
	}
	for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("JEVSTICE_TEST_")) delete process.env[key];
	}
});

function track(storePath: string, runId: string): void {
	tracked.push({ storePath, runId });
}

const FIXTURE = String.raw`#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { openAutonomyStore } from ${JSON.stringify(STORE_MODULE)};
const behavior = process.env.JEVSTICE_TEST_BEHAVIOR || "stay";
const storePath = process.env.JEVSTICE_AUTONOMY_STORE;
const runId = process.env.JEVSTICE_AUTONOMY_RUN;
const startFile = process.env.JEVSTICE_TEST_START_FILE;
const sleepFile = process.env.JEVSTICE_TEST_SLEEP_FILE;
const argvFile = process.env.JEVSTICE_TEST_ARGV_FILE;
const cwdFile = process.env.JEVSTICE_TEST_CWD_FILE;
if (argvFile) writeFileSync(argvFile, JSON.stringify(process.argv));
if (cwdFile) writeFileSync(cwdFile, process.cwd());
if (startFile) appendFileSync(startFile, process.pid + "\n");
if (behavior === "spawn-detached" || behavior === "detached-exit") {
	const sleep = Bun.spawn(["/usr/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
	if (sleepFile) writeFileSync(sleepFile, JSON.stringify({ pid: sleep.pid }));
}
if (behavior === "detached-exit") setTimeout(() => process.exit(7), 1000);
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const ready = () => out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
const stateResponse = frame => ({ id: frame.id, type: "response", command: "get_state", success: true, data: { sessionId: "session-" + process.pid, sessionFile: "/tmp/session-" + process.pid + ".jsonl", isStreaming: false, isCompacting: false, isSettled: true, messageCount: 0 } });
const respondState = frame => out(stateResponse(frame));
const respondChunkedState = frame => {
	const response = stateResponse(frame);
	response.data.systemPrompt = ["x".repeat(1400000)];
	const bytes = Buffer.from(JSON.stringify(response), "utf8");
	const size = 200000;
	const count = Math.ceil(bytes.length / size);
	const chunkId = "state-" + process.pid;
	for (let index = 0; index < count; index++) out({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data: bytes.subarray(index * size, (index + 1) * size).toString("base64") });
};
let protocolV2 = false;
let acked = false;
let timer;
const exitAfterAck = () => {
	// A child that exits immediately after its receipt is a real liveness loss after a committed
	// startup, not a scheduling accident. A child that stays for a bounded interval is supervised.
	if (behavior === "ack-then-exit") process.exit(7);
	if (behavior === "exit-after-ready") setTimeout(() => process.exit(7), 300);
};
const ack = () => {
	if (acked || behavior === "no-ack") return;
	let store;
	try {
		store = openAutonomyStore(storePath);
		const run = store.read(runId);
		if (run.session === undefined || run.child === undefined || run.child.pid !== process.pid) return;
		const sessionId = behavior === "forged-ack" ? "forged-session-" + process.pid : run.session.id;
		store.update(runId, { epoch: run.epoch, sessionId: run.session.id, generation: run.generation }, () => {}, [
			{ kind: "autonomy.restore", data: { epoch: run.epoch, generation: run.generation, sessionId, revision: run.checkpoint.revision ?? 0, task: null, plan: null, pending: Object.keys(run.pending) } },
		]);
		acked = true;
		clearInterval(timer);
		exitAfterAck();
	} catch {
	} finally {
		try { store?.close(); } catch {}
	}
};
// The bound runtime is a real long-lived process; its acknowledgment poll is genuine runtime
// plumbing, not test scheduling.
timer = setInterval(ack, 40);
timer.unref?.();
let buffer = "";
const handle = line => {
	const text = line.trim();
	if (!text) return;
	let frame;
	try { frame = JSON.parse(text); } catch { return; }
	if (frame.type === "negotiate_protocol") {
		protocolV2 = true;
		out({ id: frame.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
		return;
	}
	if (frame.type === "get_state") {
		if (behavior === "bad-state") out({ id: frame.id, type: "response", command: "get_state", success: false, error: "no state", code: "state_unavailable" });
		else if (behavior === "chunked-response" && protocolV2) respondChunkedState(frame);
		else respondState(frame);
		return;
	}
	if (frame.type === "abort" && behavior !== "stubborn") {
		out({ id: frame.id, type: "response", command: "abort", success: true });
		setTimeout(() => process.exit(0), 10);
		return;
	}
	if (frame.type) out({ id: frame.id, type: "response", command: frame.type, success: false, error: "unsupported", code: "unsupported" });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		handle(line);
		index = buffer.indexOf("\n");
	}
});
process.on("SIGTERM", () => {
	if (behavior === "stubborn") return;
	process.exit(0);
});
if (behavior === "exit-before-ready") setTimeout(() => process.exit(5), 100);
else {
	ready();
}
`;

async function setup(overrides: Partial<AutonomyPolicy> = {}): Promise<Setup> {
	const dir = await mkdtemp(join(tmpdir(), "jev-autonomy-driver-"));
	temporary.push(dir);
	const rootPath = join(dir, "root");
	// The fixture root must exist before realpathSync, otherwise the canonical directory fails.
	await mkdir(rootPath, { recursive: true });
	const root = realpathSync(rootPath);
	const stateDir = join(dir, "state");
	await mkdir(stateDir, { mode: 0o700 });
	const policy: AutonomyPolicy = {
		roots: [root],
		effects: ["project"],
		maxJudgeCalls: 4,
		maxExecutorCalls: 4,
		maxRuntimeMs: 60_000,
		maxContextBytes: 200_000,
		maxArtifactBytes: 100_000,
		...overrides,
	};
	const objectiveFile = join(dir, "objective.md");
	const policyFile = join(dir, "policy.json");
	const fixture = join(dir, "fake-omp.ts");
	await writeFile(objectiveFile, OBJECTIVE);
	await writeFile(policyFile, JSON.stringify(policy));
	await writeFile(fixture, FIXTURE, { mode: 0o755 });
	await chmod(fixture, 0o755);
	const startFile = join(dir, "start.jsonl");
	const sleepFile = join(dir, "sleep.json");
	process.env["JEVSTICE_TEST_START_FILE"] = startFile;
	process.env["JEVSTICE_TEST_SLEEP_FILE"] = sleepFile;
	process.env["JEVSTICE_TEST_BEHAVIOR"] = "stay";
	return {
		dir,
		root,
		storePath: join(stateDir, "autonomy.sqlite"),
		objectiveFile,
		policyFile,
		policy,
		fixture,
		startFile,
		sleepFile,
	};
}

function withStore<T>(path: string, run: (store: AutonomyStore) => T): T {
	const store = openAutonomyStore(path);
	try {
		return run(store);
	} finally {
		store.close();
	}
}

function eventData(event: AutonomyEvent): Record<string, unknown> {
	return asRecord(event.data) ?? {};
}

function answer(label: string, confidence = 0.95): Judge {
	return async () => ({
		ok: true,
		answers: [
			{ name: AUTONOMY_RECOVERY_QUESTION, mode: "choice", label, confidence },
			{ name: "deliverable_audience", mode: "choice", label: "internal", confidence },
		],
	});
}

function unavailable(problem = "the network is unavailable"): Judge {
	return async () => ({ ok: false, kind: "unavailable", problem });
}

function sequenceJudge(...judges: Judge[]): Judge {
	let index = 0;
	return async (state, questions) => {
		const judge = judges[Math.min(index, judges.length - 1)] ?? judges[0];
		index += 1;
		if (judge === undefined) throw new Error("no judge step");
		return judge(state, questions);
	};
}

async function starts(setupDir: Setup): Promise<number> {
	try {
		const text = await readFile(setupDir.startFile, "utf8");
		return text.split("\n").filter(line => line.length > 0).length;
	} catch {
		return 0;
	}
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value !== undefined) return value;
		} catch (error) {
			last = error;
		}
		await Bun.sleep(50);
	}
	throw new Error(`condition was not met: ${String(last ?? "timeout")}`);
}

async function runScript(source: string, name: string, args: string[], cwd: string): Promise<void> {
	const file = join(cwd, name);
	await writeFile(file, source, { mode: 0o755 });
	await chmod(file, 0o755);
	const child = Bun.spawn([process.execPath, file, ...args], {
		cwd,
		env: { ...process.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(`helper failed (${code}): ${stderr}`);
}

/**
 * Prepare a real run whose execution exists in a real scope, then let the helper die without
 * fencing it. Modes: "live" (bound scope/child + tool intent), "cancelled" (same, then cancel),
 * "budget" (bound scope with the judge budget already exhausted), "unknown" (lifecycle intent
 * precommitted with no child identity), "prebind-cancelled" (observed child recorded on an
 * unbound lifecycle intent), "prebind-over-older" (empty bound scope A plus a newer unbound child
 * B recorded on its own launch intent).
 */
function preStateScript(): string {
	return String.raw`
import { openAutonomyStore, processIdentity } from ${JSON.stringify(STORE_MODULE)};
import { makeAutonomyScopeLaunch, autonomyScopeCommand, observeAutonomyScope, fenceAutonomyScope } from ${JSON.stringify(SCOPE_MODULE)};
import { readFileSync, writeFileSync } from "node:fs";
const [mode, storePath, root, objective, policyJson, fixture, entry, stateFile, sleepFile, startMode] = process.argv.slice(2);
const store = openAutonomyStore(storePath);
const me = processIdentity();
if (me === null) throw new Error("helper identity unavailable");
const policy = JSON.parse(policyJson);
const run = store.create(objective, policy);
const claimed = store.claim(run.id, me);
const launch = makeAutonomyScopeLaunch(run.id, claimed.epoch);
const lifecycleIntent = (scopeLaunch, childIdentity) => ({
	id: crypto.randomUUID(),
	kind: "lifecycle",
	payload: { operation: "spawn", epoch: claimed.epoch, launch: scopeLaunch, executable: fixture, arguments: ["--mode", "rpc"], entry, cwd: root, model: null, locators: {}, spawnStarted: false, child: childIdentity },
	revision: 1,
	createdAt: Date.now(),
});
const readSleep = suffix => {
	try {
		return JSON.parse(readFileSync(sleepFile + suffix, "utf8")).pid;
	} catch {
		return null;
	}
};
const waitSleep = async suffix => {
	for (let attempt = 0; attempt < 250; attempt++) {
		const pid = readSleep(suffix);
		if (pid !== null) return pid;
		await Bun.sleep(20);
	}
	return null;
};
const startScope = async (scopeLaunch, suffix) => {
	const argv = autonomyScopeCommand(scopeLaunch, fixture, ["--mode", "rpc", "--no-extensions", "-e", entry]);
	const child = Bun.spawn(argv, {
		cwd: root,
		env: { ...process.env, JEVSTICE_AUTONOMY_STORE: storePath, JEVSTICE_AUTONOMY_RUN: claimed.id, JEVSTICE_TEST_BEHAVIOR: "spawn-detached", JEVSTICE_TEST_START_FILE: startMode, JEVSTICE_TEST_SLEEP_FILE: sleepFile + suffix },
		stdin: "pipe",
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	let identity = processIdentity(child.pid);
	let scope;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			identity = processIdentity(child.pid);
			if (identity !== null) scope = await observeAutonomyScope(scopeLaunch, identity);
			if (scope !== undefined) break;
		} catch {}
		await Bun.sleep(50);
	}
	if (scope === undefined || identity === null) throw new Error("helper could not observe its scope");
	return { child, identity, scope };
};
if (mode === "unknown") {
	const intent = lifecycleIntent(launch, undefined);
	store.update(claimed.id, { epoch: claimed.epoch }, current => { current.pending[intent.id] = intent; }, []);
	writeFileSync(stateFile, JSON.stringify({ runId: claimed.id, unit: launch.unit, intentId: intent.id }));
	store.close();
	process.exit(0);
}
const first = await startScope(launch, "");
if (mode === "prebind-cancelled") {
	const intent = lifecycleIntent(launch, first.identity);
	store.update(claimed.id, { epoch: claimed.epoch }, current => { current.pending[intent.id] = intent; }, []);
	store.cancel(claimed.id, "operator stop for pre-bind race test");
	writeFileSync(stateFile, JSON.stringify({ runId: claimed.id, unit: first.scope.unit, intentId: intent.id, child: first.identity, sleepPid: await waitSleep("") }));
	store.close();
	process.exit(0);
}
store.bindScope(claimed.id, claimed.epoch, first.scope);
store.bindChild(claimed.id, claimed.epoch, first.identity);
store.update(claimed.id, { epoch: claimed.epoch }, current => {
	current.pending["tool-1"] = { id: "tool-1", kind: "tool", payload: { command: "publish" }, revision: 1, createdAt: Date.now() };
}, []);
if (mode === "budget") {
	store.update(claimed.id, { epoch: claimed.epoch }, current => { current.judgeCalls = current.policy.maxJudgeCalls; }, []);
}
if (mode === "prebind-over-older") {
	// The bound scope A is physically fenced and empty; the newer child B lives in its own,
	// never-bound scope recorded on a launch intent.
	await fenceAutonomyScope(first.scope);
	const secondLaunch = makeAutonomyScopeLaunch(run.id, claimed.epoch);
	const second = await startScope(secondLaunch, ".b");
	const intent = lifecycleIntent(secondLaunch, second.identity);
	store.update(claimed.id, { epoch: claimed.epoch }, current => { current.pending[intent.id] = intent; }, []);
	store.cancel(claimed.id, "operator stop with a newer pre-bind child");
	writeFileSync(stateFile, JSON.stringify({
		runId: claimed.id,
		unitA: first.scope.unit,
		unitB: second.scope.unit,
		childA: first.identity,
		childB: second.identity,
		intentId: intent.id,
		sleepPid: await waitSleep(".b"),
	}));
	store.close();
	process.exit(0);
}
if (mode === "cancelled") store.cancel(claimed.id, "operator stop for race test");
writeFileSync(stateFile, JSON.stringify({ runId: claimed.id, unit: first.scope.unit, controlGroup: first.scope.controlGroup, child: first.identity, sleepPid: await waitSleep("") }));
store.close();
process.exit(0);
`;
}

describe("T1 - explicit policy and CLI boundaries", () => {
	test("the policy rejects non-canonical roots, duplicate effects, zero bounds and unknown effects", async () => {
		const setupDir = await setup();
		expect(() =>
			parseAutonomyPolicy({
				roots: [setupDir.root, setupDir.root],
				effects: ["project"],
				maxJudgeCalls: 1,
				maxExecutorCalls: 1,
				maxRuntimeMs: 1,
				maxContextBytes: 1,
				maxArtifactBytes: 1,
			}),
		).toThrow("unique");
		expect(() =>
			parseAutonomyPolicy({
				roots: [setupDir.root],
				effects: ["project", "project"],
				maxJudgeCalls: 1,
				maxExecutorCalls: 1,
				maxRuntimeMs: 1,
				maxContextBytes: 1,
				maxArtifactBytes: 1,
			}),
		).toThrow("must not repeat");
		expect(() =>
			parseAutonomyPolicy({
				roots: [setupDir.root],
				effects: ["project"],
				maxJudgeCalls: 0,
				maxExecutorCalls: 1,
				maxRuntimeMs: 1,
				maxContextBytes: 1,
				maxArtifactBytes: 1,
			}),
		).toThrow("positive finite integer");
		expect(() =>
			parseAutonomyPolicy({
				roots: [setupDir.root],
				effects: ["publish"],
				maxJudgeCalls: 1,
				maxExecutorCalls: 1,
				maxRuntimeMs: 1,
				maxContextBytes: 1,
				maxArtifactBytes: 1,
			}),
		).toThrow("policy.effects[0]");
	});

	test("the CLI refuses the old print flag and missing required options", async () => {
		expect(await runAutonomyCli(["start", "-p", "a prompt"])).toBe(2);
		expect(await runAutonomyCli(["stop"])).toBe(2);
		expect(await runAutonomyCli(["resume"])).toBe(2);
	});
});

describe("T2 - initial lifecycle decision gates the real scope launch", () => {
	test("an initial wait decision launches nothing", async () => {
		const setupDir = await setup();
		const result = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: answer("wait") },
		);
		expect(result.exitCode).toBe(4);
		expect(result.status).toBe("waiting");
		const run = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(run.judgeCalls).toBe(1);
		expect(run.waiting?.reason).toContain("Jev chose to wait");
		expect(run.scope).toBeUndefined();
		expect(run.pending).toEqual({});
		expect(await starts(setupDir)).toBe(0);
	});

	test("an unavailable lifecycle decision launches nothing", async () => {
		const setupDir = await setup({ maxJudgeCalls: 1 });
		const result = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: unavailable() },
		);
		expect(result.exitCode).toBe(4);
		const run = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(run.status).toBe("waiting");
		expect(run.judgeCalls).toBe(1);
		expect(run.waiting?.kind).toBe("resource");
		expect(await starts(setupDir)).toBe(0);
		const events = withStore(setupDir.storePath, store => store.events(result.runId));
		const decision = events.find(event => event.kind === "driver.recovery_decision");
		const outcome = asRecord(eventData(decision as AutonomyEvent)["outcome"]);
		expect(outcome?.["ok"]).toBe(false);
		expect(outcome?.["kind"]).toBe("unavailable");
	});

	test("a launch decision runs the real scoped RPC lifecycle and requires a bound bootstrap acknowledgment", async () => {
		const setupDir = await setup();
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "exit-after-ready";
		const result = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: sequenceJudge(answer("launch"), answer("wait")) },
		);
		expect(result.exitCode).toBe(4);
		track(setupDir.storePath, result.runId);
		const run = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(run.status).toBe("waiting");
		expect(run.scope?.bootId).toBe(autonomyBootId());
		expect(run.scope?.controlGroup.endsWith(`/${run.scope?.unit}`)).toBe(true);
		expect(run.child?.bootId).toBe(autonomyBootId());
		expect(run.child?.group).toBe(run.child?.pid);
		expect(run.session?.id.startsWith("session-")).toBe(true);
		expect(run.session?.file.startsWith("/tmp/session-")).toBe(true);
		expect(run.judgeCalls).toBe(2);
		expect(await starts(setupDir)).toBe(1);
		expect(processIdentity(run.child?.pid ?? -1)).toBeNull();

		const events = withStore(setupDir.storePath, store => store.events(result.runId));
		expect(events.some(event => event.kind === "driver.launch_intent")).toBe(true);
		expect(events.some(event => event.kind === "scope-bound")).toBe(true);
		expect(events.some(event => event.kind === "driver.bootstrap_ack")).toBe(true);
		expect(events.some(event => event.kind === "driver.session_bound")).toBe(true);
		expect(events.some(event => event.kind === "scope-fenced")).toBe(true);
		expect(run.fences.length).toBeGreaterThanOrEqual(1);
	});

	test("protocol v2 chunked get_state is reassembled before the session binds", async () => {
		const setupDir = await setup({ maxJudgeCalls: 2 });
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "chunked-response";
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: sequenceJudge(answer("launch"), answer("wait")) },
		);
		const running = await waitFor(async () =>
			withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
		);
		track(setupDir.storePath, running.id);
		await waitFor(async () =>
			withStore(setupDir.storePath, store =>
				store.events(running.id).some(event => event.kind === "driver.bootstrap_ack") ? true : undefined,
			),
		);
		const stopped = await stopAutonomy({ store: setupDir.storePath, run: running.id, reason: "chunked reassembly observed" });
		expect(stopped.status).toBe("cancelled");
		expect(stopped.exitCode).toBe(0);
		const result = await driving;
		expect(result.status).toBe("cancelled");
		const run = withStore(setupDir.storePath, store => store.read(running.id));
		expect(run.session?.id.startsWith("session-")).toBe(true);
		const events = withStore(setupDir.storePath, store => store.events(running.id));
		expect(events.some(event => event.kind === "driver.bootstrap_ack")).toBe(true);
		expect(events.some(event => event.kind === "driver.launch_failed")).toBe(false);
		expect(await starts(setupDir)).toBe(1);
	});

	test("ready and get_state without a bound runtime acknowledgment fail the launch and fence the scope", async () => {
		const setupDir = await setup({ maxJudgeCalls: 2 });
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "no-ack";
		const result = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: sequenceJudge(answer("launch"), answer("wait")), startupAckTimeoutMs: 400 },
		);
		track(setupDir.storePath, result.runId);
		const run = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(run.status).toBe("waiting");
		expect(run.scope).toBeDefined();
		expect(run.child).toBeDefined();
		expect(processIdentity(run.child?.pid ?? -1)).toBeNull();
		const events = withStore(setupDir.storePath, store => store.events(result.runId));
		const failed = events.find(event => event.kind === "driver.launch_failed");
		expect(failed).toBeDefined();
		expect(eventData(failed as AutonomyEvent)["stage"]).toBe("bootstrap_ack");
		expect(eventData(failed as AutonomyEvent)["fenced"]).toBe(true);
		expect(events.some(event => event.kind === "driver.bootstrap_ack")).toBe(false);
	});

	test("a committed acknowledgment is retained when the child exits before the next poll, without treating it as live", async () => {
		const setupDir = await setup({ maxJudgeCalls: 2 });
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "ack-then-exit";
		const result = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: sequenceJudge(answer("launch"), answer("wait")) },
		);
		expect(result.exitCode).toBe(4);
		track(setupDir.storePath, result.runId);
		const run = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(run.status).toBe("waiting");
		expect(run.session?.id.startsWith("session-")).toBe(true);
		expect(processIdentity(run.child?.pid ?? -1)).toBeNull();
		const events = withStore(setupDir.storePath, store => store.events(result.runId));
		expect(events.some(event => event.kind === "driver.bootstrap_ack")).toBe(true);
		expect(events.some(event => event.kind === "driver.session_bound")).toBe(true);
		expect(events.some(event => event.kind === "driver.ready")).toBe(false);
		const failed = events.find(event => event.kind === "driver.launch_failed");
		expect(failed).toBeDefined();
		expect(eventData(failed as AutonomyEvent)["stage"]).toBe("bootstrap_ack");
		expect(eventData(failed as AutonomyEvent)["fenced"]).toBe(true);
		expect(await starts(setupDir)).toBe(1);
	});

	test("an honest completed or infeasible run with a live scope is fenced and exits 0", async () => {
		for (const status of ["completed", "infeasible"] as const) {
			const setupDir = await setup();
			process.env["JEVSTICE_TEST_BEHAVIOR"] = "stay";
			const driving = startAutonomyRun(
				{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
				{ judge: answer("launch") },
			);
			const running = await waitFor(async () =>
				withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
			);
			track(setupDir.storePath, running.id);
			const child = running.child as NonNullable<AutonomyRun["child"]>;
			expect(processIdentity(child.pid)).not.toBeNull();
			withStore(setupDir.storePath, store =>
				store.update(
					running.id,
					{ epoch: running.epoch },
					current => {
						current.status = status;
						if (status === "completed") {
							current.checkpoint.completion = { revision: current.checkpoint.revision, label: "follows", approved: true, confidence: 0.95 };
							current.checkpoint.acceptance = [
								{ aspect: "business", revision: current.checkpoint.revision, label: "serves_business_need", approved: true, confidence: 0.95 },
								{ aspect: "architecture", revision: current.checkpoint.revision, label: "sound_for_next_change", approved: true, confidence: 0.95 },
							];
						}
					},
					[],
				),
			);
			const result = await driving;
			expect(result.status).toBe(status);
			expect(result.exitCode).toBe(0);
			expect(processIdentity(child.pid)).toBeNull();
			const final = withStore(setupDir.storePath, store => store.read(running.id));
			expect(final.status).toBe(status);
			expect(final.fences.some(fence => fence.scope.unit === final.scope?.unit)).toBe(true);
		}
	}, 30_000);

	test("resume does not re-ask an unchanged decisive wait but judges fresh material", async () => {
		const setupDir = await setup({ maxJudgeCalls: 3 });
		const first = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: answer("wait") },
		);
		track(setupDir.storePath, first.runId);
		expect(first.exitCode).toBe(4);
		let run = withStore(setupDir.storePath, store => store.read(first.runId));
		expect(run.judgeCalls).toBe(1);
		expect(run.waiting?.kind).toBe("judge");
		expect(
			withStore(setupDir.storePath, store =>
				store.events(first.runId).some(event => event.kind === "driver.refusal_hold"),
			),
		).toBe(true);

		let calls = 0;
		const judge: Judge = async (context, questions) => {
			calls += 1;
			return answer("wait")(context, questions);
		};
		const repeated = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: first.runId, omp: setupDir.fixture },
			{ judge },
		);
		expect(repeated.exitCode).toBe(4);
		expect(calls).toBe(0);
		run = withStore(setupDir.storePath, store => store.read(first.runId));
		expect(run.judgeCalls).toBe(1);
		expect(run.waiting?.kind).toBe("judge");
		expect(run.waiting?.reason).toContain("Jev chose to wait");

		withStore(setupDir.storePath, store =>
			store.update(
				first.runId,
				{ epoch: run.epoch },
				current => {
					current.checkpoint.revision += 1;
				},
				[],
			),
		);
		const fresh = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: first.runId, omp: setupDir.fixture },
			{ judge },
		);
		expect(fresh.exitCode).toBe(4);
		expect(calls).toBe(1);
		run = withStore(setupDir.storePath, store => store.read(first.runId));
		expect(run.judgeCalls).toBe(2);
	}, 30_000);

	test("a durable refusal survives an unrelated capability wait", async () => {
		const setupDir = await setup({ maxJudgeCalls: 3 });
		const first = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: answer("wait") },
		);
		track(setupDir.storePath, first.runId);
		expect(first.exitCode).toBe(4);
		let calls = 0;
		const judge: Judge = async (context, questions) => {
			calls += 1;
			return answer("wait")(context, questions);
		};
		const blocked = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: first.runId, omp: setupDir.fixture },
			{
				judge,
				scopeCapability: async () => {
					throw new Error("temporary capability outage");
				},
			},
		);
		expect(blocked.exitCode).toBe(4);
		let run = withStore(setupDir.storePath, store => store.read(first.runId));
		expect(run.waiting?.kind).toBe("capability");
		expect(calls).toBe(0);

		const repeated = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: first.runId, omp: setupDir.fixture },
			{ judge },
		);
		expect(repeated.exitCode).toBe(4);
		expect(calls).toBe(0);
		run = withStore(setupDir.storePath, store => store.read(first.runId));
		expect(run.judgeCalls).toBe(1);
		expect(run.waiting?.kind).toBe("judge");
	}, 30_000);

	test("the judged candidate argv pins a run-private session directory used by the actual spawn", async () => {
		const setupDir = await setup();
		const argvFile = join(setupDir.dir, "spawn-argv.json");
		process.env["JEVSTICE_TEST_ARGV_FILE"] = argvFile;
		let context: Record<string, unknown> | undefined;
		const judge: Judge = async (state, questions) => {
			context = asRecord(state);
			return answer("launch")(state, questions);
		};
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge },
		);
		const running = await waitFor(async () =>
			withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
		);
		track(setupDir.storePath, running.id);
		try {
			const candidate = asRecord(context?.["candidate"]);
			const command = candidate?.["command"];
			expect(Array.isArray(command)).toBe(true);
			const argv = command as string[];
			const flag = argv.indexOf("--session-dir");
			expect(flag).toBeGreaterThan(0);
			const sessionDir = argv[flag + 1];
			const controlRoot = dirname(setupDir.storePath);
			if (typeof sessionDir !== "string" || !sessionDir.startsWith(controlRoot + "/")) {
				throw new Error(`judged argv did not pin a private run session directory: ${String(sessionDir)}`);
			}
			expect(sessionDir).toContain(`/autonomy-sessions/${running.id}/`);
			expect(statSync(sessionDir).isDirectory()).toBe(true);
			expect(statSync(sessionDir).mode & 0o077).toBe(0);

			const actual = JSON.parse(await readFile(argvFile, "utf8")) as string[];
			const executable = argv.indexOf(setupDir.fixture);
			expect(executable).toBeGreaterThan(0);
			expect(actual.slice(1)).toEqual(argv.slice(executable));
		} finally {
			await stopAutonomy({ store: setupDir.storePath, run: running.id, reason: "session directory test" });
			await driving;
		}
	}, 30_000);

	test("lifecycle context carries exact selected bodies and the observation-only effect policy", async () => {
		const setupDir = await setup();
		const effectText = "x".repeat(100 * 1024);
		const noteText = "\uFEFFexact-note-bytes\n";
		await writeFile(join(setupDir.root, "effect.txt"), effectText);
		const created = withStore(setupDir.storePath, store => {
			const owner = processIdentity();
			if (owner === null) throw new Error("test identity unavailable");
			const run = store.create(OBJECTIVE, setupDir.policy);
			const claimed = store.claim(run.id, owner);
			return store.update(
				claimed.id,
				{ epoch: claimed.epoch },
				current => {
					current.checkpoint.plan = {
						taskFingerprint: "task-1",
						planUrl: "local://test-plan.md",
						planDigest: "plan-digest",
					};
					current.checkpoint.planTopics = [
						{
							id: "step",
							section: "## step",
							paths: ["effect.txt", "local://test-note.txt", "missing.txt"],
							requirement: "The observed effect matches.",
						},
					];
					current.pending["tool-1"] = {
						id: "tool-1",
						kind: "tool",
						payload: { command: "publish" },
						revision: 1,
						createdAt: Date.now(),
					};
				},
				[],
				{
					"local://test-plan.md": Buffer.from("# plan\n"),
					"local://test-note.txt": Buffer.from(noteText),
				},
			);
		});
		track(setupDir.storePath, created.id);
		let seen: Record<string, unknown> | undefined;
		const judge: Judge = async (context, questions) => {
			seen = asRecord(context);
			return answer("wait")(context, questions);
		};
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: created.id, omp: setupDir.fixture },
			{ judge },
		);
		expect(result.exitCode).toBe(4);
		expect(seen).toBeDefined();
		const observations = asRecord(seen?.["observations"]);
		const entries = observations?.["selectedPaths"];
		expect(Array.isArray(entries)).toBe(true);
		const list = entries as Array<Record<string, unknown>>;
		const effect = list.find(entry => entry["path"] === "effect.txt");
		expect(effect?.["content"]).toBe(effectText);
		expect(effect?.["encoding"]).toBe("utf-8");
		expect(effect?.["complete"]).toBe(true);
		const note = list.find(entry => entry["path"] === "local://test-note.txt");
		expect(note?.["content"]).toBe(noteText);
		const missing = list.find(entry => entry["path"] === "missing.txt");
		expect(missing?.["exists"]).toBe(false);
		const candidate = asRecord(seen?.["candidate"]);
		const effectPolicy = asRecord(candidate?.["effectPolicy"]);
		expect(effectPolicy?.["mode"]).toBe("observation_and_reconciliation_only");
		expect(effectPolicy?.["consequentialEffectsBlocked"]).toBe(true);
	});

	test("oversized selected material stays a durable context wait instead of a truncated body", async () => {
		const setupDir = await setup();
		await writeFile(join(setupDir.root, "large-effect.txt"), "x".repeat(setupDir.policy.maxContextBytes + 1));
		const created = withStore(setupDir.storePath, store => {
			const owner = processIdentity();
			if (owner === null) throw new Error("test identity unavailable");
			const run = store.create(OBJECTIVE, setupDir.policy);
			const claimed = store.claim(run.id, owner);
			return store.update(claimed.id, { epoch: claimed.epoch }, current => {
				current.checkpoint.planTopics = [
					{
						id: "step",
						section: "## step",
						paths: ["large-effect.txt"],
						requirement: "The large effect remains fully observable.",
					},
				];
			});
		});
		track(setupDir.storePath, created.id);
		let calls = 0;
		const judge: Judge = async (context, questions) => {
			calls += 1;
			return answer("launch")(context, questions);
		};
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: created.id, omp: setupDir.fixture },
			{ judge },
		);
		expect(result.exitCode).toBe(4);
		expect(calls).toBe(0);
		const run = withStore(setupDir.storePath, store => store.read(created.id));
		expect(run.waiting?.kind).toBe("context");
		expect(run.waiting?.reason).toContain("large-effect.txt");
		expect(await starts(setupDir)).toBe(0);
	});

	test("a forged bootstrap acknowledgment cannot authorize the launch", async () => {
		const setupDir = await setup({ maxJudgeCalls: 2 });
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "forged-ack";
		const result = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: sequenceJudge(answer("launch"), answer("wait")), startupAckTimeoutMs: 400 },
		);
		expect(result.exitCode).toBe(4);
		track(setupDir.storePath, result.runId);
		const run = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(run.status).toBe("waiting");
		expect(await starts(setupDir)).toBe(1);
		const events = withStore(setupDir.storePath, store => store.events(result.runId));
		const failed = events.find(event => event.kind === "driver.launch_failed");
		expect(failed).toBeDefined();
		expect(eventData(failed as AutonomyEvent)["stage"]).toBe("bootstrap_ack");
		expect(eventData(failed as AutonomyEvent)["fenced"]).toBe(true);
		expect(events.some(event => event.kind === "driver.bootstrap_ack")).toBe(false);
	});
});

describe("T3 - whole-scope fencing, unknown intents and root races", () => {
	test("resume fences a dead owner's real scope including a detached native survivor and journals pending IDs", async () => {
		const setupDir = await setup();
		const stateFile = join(setupDir.dir, "pre-state.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-state.ts",
			[
				"live",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as {
			runId: string;
			unit: string;
			child: { pid: number };
			sleepPid: number;
		};
		track(setupDir.storePath, state.runId);
		expect(processIdentity(state.sleepPid)).not.toBeNull();

		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: state.runId, omp: setupDir.fixture },
			{ judge: answer("wait") },
		);
		expect(result.exitCode).toBe(4);
		const run = withStore(setupDir.storePath, store => store.read(state.runId));
		expect(run.pending["tool-1"]).toBeDefined();
		expect(run.fences.length).toBe(1);
		expect(run.fences[0]?.intentIds).toEqual(["tool-1"]);
		expect(run.fences[0]?.scope.unit).toBe(state.unit);
		expect(processIdentity(state.sleepPid)).toBeNull();
		expect(processIdentity(state.child.pid)).toBeNull();
		const events = withStore(setupDir.storePath, store => store.events(state.runId));
		expect(events.some(event => event.kind === "scope-fenced")).toBe(true);
		expect(events.some(event => event.kind === "driver.fence")).toBe(true);
	});

	test("a never-observed launch is proved quiet but recovery still requires an observed child identity", async () => {
		const setupDir = await setup();
		const stateFile = join(setupDir.dir, "unknown.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-unknown.ts",
			[
				"unknown",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as { runId: string; intentId: string; unit: string };
		track(setupDir.storePath, state.runId);
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: state.runId, omp: setupDir.fixture },
			{ judge: answer("launch") },
		);
		expect(result.exitCode).toBe(4);
		const run = withStore(setupDir.storePath, store => store.read(state.runId));
		expect(run.status).toBe("waiting");
		expect(run.waiting?.kind).toBe("fencing");
		expect(run.judgeCalls).toBe(0);
		expect(run.pending[state.intentId]).toBeDefined();
		expect(run.fences).toEqual([]);
		expect(run.launchFences.some(fence => fence.launch.unit === state.unit)).toBe(true);
		expect(await starts(setupDir)).toBe(0);
	});

	test("a lifecycle decision made stale by a terminal cancel never launches", async () => {
		const setupDir = await setup();
		let calls = 0;
		const judge: Judge = async () => {
			calls += 1;
			withStore(setupDir.storePath, store => {
				const current = store.list()[0];
				if (current !== undefined) store.cancel(current.id, "concurrent operator stop");
			});
			return answer("launch")({}, []);
		};
		const result = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge },
		);
		expect(calls).toBe(1);
		expect(result.status).toBe("cancelled");
		const run = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(run.status).toBe("cancelled");
		expect(await starts(setupDir)).toBe(0);
	});

	test("operator stop durably cancels and fences a stubborn scope that ignores SIGTERM", async () => {
		const setupDir = await setup();
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "stubborn";
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: answer("launch") },
		);
		const running = await waitFor(async () =>
			withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
		);
		track(setupDir.storePath, running.id);
		const child = running.child as NonNullable<AutonomyRun["child"]>;
		const result = await stopAutonomy({ store: setupDir.storePath, run: running.id, reason: "test stop" });
		expect(result.exitCode).toBe(0);
		expect(result.durableCancellation).toBe(true);
		expect(result.status).toBe("cancelled");
		expect(processIdentity(child.pid)).toBeNull();
		const final = withStore(setupDir.storePath, store => store.read(running.id));
		expect(final.status).toBe("cancelled");
		expect(final.fences.length).toBe(1);
		const outcome = await driving;
		expect(outcome.status).toBe("cancelled");
	});

	test("a cancelled run with live contained work keeps its root reserved until the operator fence receipt", async () => {
		const setupDir = await setup();
		const stateFile = join(setupDir.dir, "cancelled-live.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-cancelled.ts",
			[
				"cancelled",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as { runId: string; sleepPid: number };
		track(setupDir.storePath, state.runId);
		expect(processIdentity(state.sleepPid)).not.toBeNull();
		expect(() =>
			withStore(setupDir.storePath, store =>
				store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }),
			),
		).toThrow("overlapping authorized root");
		const result = await stopAutonomy({ store: setupDir.storePath, run: state.runId, reason: "fence the cancelled scope" });
		expect(result.exitCode).toBe(0);
		expect(processIdentity(state.sleepPid)).toBeNull();
		const final = withStore(setupDir.storePath, store => store.read(state.runId));
		expect(final.status).toBe("cancelled");
		expect(final.fences.length).toBe(1);
		withStore(setupDir.storePath, store => {
			const created = store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] });
			expect(created.status).toBe("ready");
		});
	});

	test("a cancelled pre-bind launch is fenced by its own observed scope and releases the root", async () => {
		const setupDir = await setup();
		const stateFile = join(setupDir.dir, "prebind.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-prebind.ts",
			[
				"prebind-cancelled",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as {
			runId: string;
			unit: string;
			child: { pid: number };
			sleepPid: number;
		};
		track(setupDir.storePath, state.runId);
		expect(processIdentity(state.child.pid)).not.toBeNull();
		expect(processIdentity(state.sleepPid)).not.toBeNull();
		expect(() =>
			withStore(setupDir.storePath, store =>
				store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }),
			),
		).toThrow("overlapping authorized root");
		const result = await stopAutonomy({ store: setupDir.storePath, run: state.runId, reason: "fence the pre-bind scope" });
		expect(result.exitCode).toBe(0);
		expect(result.status).toBe("cancelled");
		expect(processIdentity(state.child.pid)).toBeNull();
		expect(processIdentity(state.sleepPid)).toBeNull();
		const final = withStore(setupDir.storePath, store => store.read(state.runId));
		expect(final.scope).toBeUndefined();
		expect(final.fences.some(fence => fence.scope.unit === state.unit)).toBe(true);
		withStore(setupDir.storePath, store => {
			expect(store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }).status).toBe("ready");
		});
	}, 30_000);

	test("a newer pre-bind child is fenced even when an older bound scope is already empty", async () => {
		const setupDir = await setup();
		const stateFile = join(setupDir.dir, "prebind-older.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-prebind-older.ts",
			[
				"prebind-over-older",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as {
			runId: string;
			unitA: string;
			unitB: string;
			childA: { pid: number };
			childB: { pid: number };
			sleepPid: number;
		};
		track(setupDir.storePath, state.runId);
		expect(processIdentity(state.childA.pid)).toBeNull();
		expect(processIdentity(state.childB.pid)).not.toBeNull();
		expect(processIdentity(state.sleepPid)).not.toBeNull();
		expect(() =>
			withStore(setupDir.storePath, store =>
				store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }),
			),
		).toThrow("overlapping authorized root");
		const result = await stopAutonomy({ store: setupDir.storePath, run: state.runId, reason: "fence both launch candidates" });
		expect(result.exitCode).toBe(0);
		expect(processIdentity(state.childB.pid)).toBeNull();
		expect(processIdentity(state.sleepPid)).toBeNull();
		const final = withStore(setupDir.storePath, store => store.read(state.runId));
		const units = final.fences.map(fence => fence.scope.unit);
		expect(units).toContain(state.unitA);
		expect(units).toContain(state.unitB);
		withStore(setupDir.storePath, store => {
			expect(store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }).status).toBe("ready");
		});
	}, 30_000);

	test("a killed pre-bind leader is fenced by its committed unit and releases the root", async () => {
		const setupDir = await setup();
		const stateFile = join(setupDir.dir, "prebind-leader-gone.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-prebind-leader-gone.ts",
			[
				"prebind-cancelled",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as {
			runId: string;
			unit: string;
			child: { pid: number };
			sleepPid: number;
		};
		track(setupDir.storePath, state.runId);
		process.kill(state.child.pid, "SIGKILL");
		await waitFor(async () => (processIdentity(state.child.pid) === null ? true : undefined));
		expect(processIdentity(state.sleepPid)).not.toBeNull();

		const result = await stopAutonomy({ store: setupDir.storePath, run: state.runId, reason: "fence leader-gone scope" });
		expect(result.exitCode).toBe(0);
		expect(result.status).toBe("cancelled");
		expect(processIdentity(state.sleepPid)).toBeNull();
		const final = withStore(setupDir.storePath, store => store.read(state.runId));
		expect(
			final.fences.some(fence => fence.scope.unit === state.unit) ||
				final.launchFences.some(fence => fence.launch.unit === state.unit),
		).toBe(true);
		withStore(setupDir.storePath, store => {
			expect(store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }).status).toBe("ready");
		});
	}, 30_000);

	test("a never-observed launch whose unit is unloaded gets a durable launch proof and releases the root", async () => {
		const setupDir = await setup();
		const stateFile = join(setupDir.dir, "unknown-proof.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-unknown-proof.ts",
			[
				"unknown",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as { runId: string; unit: string; intentId: string };
		track(setupDir.storePath, state.runId);
		const result = await stopAutonomy({ store: setupDir.storePath, run: state.runId, reason: "release never-observed launch" });
		expect(result.exitCode).toBe(0);
		expect(result.status).toBe("cancelled");
		const final = withStore(setupDir.storePath, store => store.read(state.runId));
		expect(final.launchFences.some(fence => fence.launch.unit === state.unit && fence.method === "unit-unloaded")).toBe(true);
		withStore(setupDir.storePath, store => {
			expect(store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }).status).toBe("ready");
		});
	}, 30_000);

	test("a terminal transition during pre-bind observation records the terminal receipt", async () => {
		const setupDir = await setup();
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{
				judge: answer("launch"),
				lifecycleRace: {
					afterLaunchSpawned: () => {
						withStore(setupDir.storePath, store => {
							const current = store.list()[0];
							if (current !== undefined && current.status !== "cancelled") {
								store.cancel(current.id, "operator stop during scope observation");
							}
						});
					},
				},
			},
		);
		const result = await driving;
		track(setupDir.storePath, result.runId);
		expect(result.status).toBe("cancelled");
		const final = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(final.fences.length).toBeGreaterThan(0);
		withStore(setupDir.storePath, store => {
			expect(store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }).status).toBe("ready");
		});
	}, 30_000);

	test("a child exit after a terminal transition still fences the whole scope", async () => {
		const setupDir = await setup();
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "detached-exit";
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{
				judge: answer("launch"),
				lifecycleRace: {
					afterChildExit: () => {
						withStore(setupDir.storePath, store => {
							const current = store.list()[0];
							if (current !== undefined && current.status !== "cancelled") {
								store.cancel(current.id, "operator stop at child exit");
							}
						});
					},
				},
			},
		);
		const running = await waitFor(async () =>
			withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
		);
		track(setupDir.storePath, running.id);
		const sleepState = JSON.parse(await readFile(setupDir.sleepFile, "utf8")) as { pid: number };
		const result = await driving;
		expect(result.status).toBe("cancelled");
		expect(processIdentity(sleepState.pid)).toBeNull();
		const final = withStore(setupDir.storePath, store => store.read(running.id));
		expect(final.fences.length).toBeGreaterThan(0);
		withStore(setupDir.storePath, store => {
			expect(store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }).status).toBe("ready");
		});
	}, 30_000);

	test("a cancellation at recovery entry still fences the live scope before success", async () => {
		const setupDir = await setup();
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "detached-exit";
		let cancelled = false;
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{
				judge: answer("launch"),
				lifecycleRace: {
					beforeRecoverRead: () => {
						if (cancelled) return;
						withStore(setupDir.storePath, store => {
							const current = store.list()[0];
							if (current !== undefined && current.scope !== undefined && current.status !== "cancelled") {
								cancelled = true;
								store.cancel(current.id, "operator stop at recovery entry");
							}
						});
					},
				},
			},
		);
		const running = await waitFor(async () =>
			withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
		);
		track(setupDir.storePath, running.id);
		const sleepState = JSON.parse(await readFile(setupDir.sleepFile, "utf8")) as { pid: number };
		const result = await Promise.race([
			driving,
			Bun.sleep(5_000).then(() => undefined),
		]);
		if (result === undefined) throw new Error("the supervisor did not exit after the recovery-entry cancellation");
		expect(cancelled).toBe(true);
		expect(result.status).toBe("cancelled");
		expect(result.exitCode).toBe(0);
		expect(processIdentity(sleepState.pid)).toBeNull();
		const final = withStore(setupDir.storePath, store => store.read(running.id));
		expect(final.fences.length).toBeGreaterThan(0);
		withStore(setupDir.storePath, store => {
			expect(store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }).status).toBe("ready");
		});
	}, 30_000);

	test("initial and replacement launches use the committed sorted policy root as cwd", async () => {
		const setupDir = await setup();
		const secondRoot = join(setupDir.dir, "root-a");
		await mkdir(secondRoot, { recursive: true });
		const ordered = { ...setupDir.policy, roots: [realpathSync(secondRoot), setupDir.root] };
		await writeFile(setupDir.policyFile, JSON.stringify(ordered));
		const cwdFile = join(setupDir.dir, "child-cwd.txt");
		process.env["JEVSTICE_TEST_CWD_FILE"] = cwdFile;
		let context: Record<string, unknown> | undefined;
		const judge: Judge = async (state, questions) => {
			context = asRecord(state);
			return answer("launch")(state, questions);
		};
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge },
		);
		const running = await waitFor(async () =>
			withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
		);
		track(setupDir.storePath, running.id);
		try {
			const committed = withStore(setupDir.storePath, store => store.read(running.id));
			expect(committed.policy.roots[0]).toBe(setupDir.root);
			const candidate = asRecord(context?.["candidate"]);
			expect(candidate?.["cwd"]).toBe(committed.policy.roots[0]);
			const actualCwd = (await Bun.file(cwdFile).text()).trim();
			expect(actualCwd).toBe(setupDir.root);
		} finally {
			await stopAutonomy({ store: setupDir.storePath, run: running.id, reason: "committed cwd test" });
			await driving;
		}
	}, 30_000);

	test("operator abort cancels and fences the real scope without another Jev call", async () => {
		const setupDir = await setup();
		const controller = new AbortController();
		let calls = 0;
		const judge: Judge = async () => {
			calls += 1;
			return answer("launch")({}, []);
		};
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge, signal: controller.signal },
		);
		const running = await waitFor(async () =>
			withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
		);
		track(setupDir.storePath, running.id);
		const child = running.child as NonNullable<AutonomyRun["child"]>;
		controller.abort("operator stop");
		const result = await driving;
		expect(result.status).toBe("cancelled");
		expect(result.durableCancellation).toBe(true);
		expect(calls).toBe(1);
		expect(processIdentity(child.pid)).toBeNull();
		const final = withStore(setupDir.storePath, store => store.read(running.id));
		expect(final.fences.length).toBe(1);
	});
});

describe("T4 - budgets, unavailable capability and rotation", () => {
	test("unavailable scope capability creates no run on start and a durable wait on resume", async () => {
		const setupDir = await setup();
		const capability = async () => {
			throw new Error("cgroup v2 is unavailable");
		};
		await expect(
			startAutonomyRun(
				{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
				{ judge: answer("launch"), scopeCapability: capability },
			),
		).rejects.toThrow("scope capability is unavailable");
		expect(existsSync(setupDir.storePath)).toBe(false);

		const created = withStore(setupDir.storePath, store => {
			const owner = processIdentity();
			if (owner === null) throw new Error("test identity unavailable");
			const run = store.create(OBJECTIVE, setupDir.policy);
			return store.claim(run.id, owner);
		});
		track(setupDir.storePath, created.id);
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: created.id, omp: setupDir.fixture },
			{ judge: answer("launch"), scopeCapability: capability },
		);
		expect(result.exitCode).toBe(4);
		const run = withStore(setupDir.storePath, store => store.read(created.id));
		expect(run.status).toBe("waiting");
		expect(run.waiting?.kind).toBe("capability");
		expect(run.judgeCalls).toBe(0);
		expect(await starts(setupDir)).toBe(0);
	});

	test("an unavailable judge is retried with backoff, then the exhausted budget preserves waiting", async () => {
		const setupDir = await setup({ maxJudgeCalls: 2, maxRuntimeMs: 60_000 });
		const created = withStore(setupDir.storePath, store => {
			const owner = processIdentity();
			if (owner === null) throw new Error("test identity unavailable");
			const run = store.create(OBJECTIVE, setupDir.policy);
			return store.claim(run.id, owner);
		});
		track(setupDir.storePath, created.id);
		let clock = Date.now();
		const sleeps: number[] = [];
		let calls = 0;
		const judge: Judge = async () => {
			calls += 1;
			return { ok: false, kind: "unavailable", problem: "offline" };
		};
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: created.id, omp: setupDir.fixture },
			{
				judge,
				now: () => clock,
				sleep: async ms => {
					sleeps.push(ms);
					clock += ms;
					return true;
				},
			},
		);
		expect(result.exitCode).toBe(4);
		expect(calls).toBe(2);
		expect(sleeps.length).toBeGreaterThanOrEqual(1);
		const run = withStore(setupDir.storePath, store => store.read(created.id));
		expect(run.status).toBe("waiting");
		expect(run.judgeCalls).toBe(2);
		expect(run.waiting?.reason).toContain("judge call budget is exhausted");
		expect(run.child).toBeUndefined();
	});

	test("a below-floor lifecycle answer stays a disclosed durable wait and launches nothing", async () => {
		const setupDir = await setup({ maxJudgeCalls: 2, maxRuntimeMs: 60_000 });
		const created = withStore(setupDir.storePath, store => {
			const owner = processIdentity();
			if (owner === null) throw new Error("test identity unavailable");
			const run = store.create(OBJECTIVE, setupDir.policy);
			return store.claim(run.id, owner);
		});
		track(setupDir.storePath, created.id);
		let calls = 0;
		const judge: Judge = async () => {
			calls += 1;
			return {
				ok: true,
				answers: [
					{ name: AUTONOMY_RECOVERY_QUESTION, mode: "choice", label: "launch", confidence: 0.52 },
					{ name: "deliverable_audience", mode: "choice", label: "internal", confidence: 0.95 },
				],
			};
		};
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: created.id, omp: setupDir.fixture },
			{ judge },
		);
		expect(result.exitCode).toBe(4);
		// An inconclusive verdict is neither a defect nor approval: the run keeps its durable wait,
		// spends no second judge call on unchanged material, and never launches a child.
		expect(calls).toBe(1);
		const run = withStore(setupDir.storePath, store => store.read(created.id));
		expect(run.status).toBe("waiting");
		expect(run.judgeCalls).toBe(1);
		expect(run.waiting?.kind).toBe("judge");
		expect(run.waiting?.reason).toBe("Jev did not decisively approve the lifecycle transition");
		expect(run.child).toBeUndefined();
		expect(await starts(setupDir)).toBe(0);
		const events = withStore(setupDir.storePath, store => store.events(created.id));
		expect(events.some(event => event.kind === "driver.refusal_hold")).toBe(true);
		expect(events.some(event => event.kind === "driver.launch_intent")).toBe(false);
	});

	test("an exhausted judge budget on resume fences the prior scope before refusing", async () => {
		const setupDir = await setup({ maxJudgeCalls: 1 });
		const stateFile = join(setupDir.dir, "budget.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-budget.ts",
			[
				"budget",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as {
			runId: string;
			unit: string;
			child: { pid: number };
			sleepPid: number;
		};
		track(setupDir.storePath, state.runId);
		expect(processIdentity(state.child.pid)).not.toBeNull();
		expect(processIdentity(state.sleepPid)).not.toBeNull();
		let calls = 0;
		const judge: Judge = async (context, questions) => {
			calls += 1;
			return answer("launch")(context, questions);
		};
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: state.runId, omp: setupDir.fixture },
			{ judge },
		);
		expect(result.exitCode).toBe(4);
		expect(calls).toBe(0);
		expect(processIdentity(state.child.pid)).toBeNull();
		expect(processIdentity(state.sleepPid)).toBeNull();
		const run = withStore(setupDir.storePath, store => store.read(state.runId));
		expect(run.status).toBe("waiting");
		expect(run.waiting?.kind).toBe("resource");
		expect(run.judgeCalls).toBe(1);
		expect(run.fences.some(fence => fence.scope.unit === state.unit)).toBe(true);
		expect(() =>
			withStore(setupDir.storePath, store =>
				store.create("A competing objective.\n", { ...setupDir.policy, roots: [setupDir.root] }),
			),
		).toThrow("overlapping authorized root");
	}, 30_000);

	test("a persisted judge retry time survives resume without an early judge call", async () => {
		const setupDir = await setup();
		const created = withStore(setupDir.storePath, store => {
			const owner = processIdentity();
			if (owner === null) throw new Error("test identity unavailable");
			const run = store.create(OBJECTIVE, setupDir.policy);
			const claimed = store.claim(run.id, owner);
			const retryAt = Date.now() + 5_000;
			return store.update(
				claimed.id,
				{ epoch: claimed.epoch },
				current => {
					current.status = "waiting";
					current.waiting = {
						kind: "judge",
						reason: "the lifecycle decision was unavailable (unavailable): offline",
						attempts: 2,
						retryAt,
					};
				},
				[],
			);
		});
		track(setupDir.storePath, created.id);
		let clock = Date.now();
		const sleeps: number[] = [];
		let calls = 0;
		const judge: Judge = async (context, questions) => {
			calls += 1;
			return answer("wait")(context, questions);
		};
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: created.id, omp: setupDir.fixture },
			{
				judge,
				now: () => clock,
				sleep: async ms => {
					sleeps.push(ms);
					clock += ms;
					return true;
				},
			},
		);
		expect(result.exitCode).toBe(4);
		expect(sleeps[0]).toBeGreaterThanOrEqual(4_000);
		expect(calls).toBe(1);
	}, 30_000);

	test("an already exhausted runtime budget on resume fences the stored scope before the resource wait", async () => {
		const setupDir = await setup({ maxRuntimeMs: 1_000 });
		const stateFile = join(setupDir.dir, "runtime.json");
		const objective = await readFile(setupDir.objectiveFile, "utf8");
		await runScript(
			preStateScript(),
			"pre-runtime.ts",
			[
				"live",
				setupDir.storePath,
				setupDir.root,
				objective,
				JSON.stringify(setupDir.policy),
				setupDir.fixture,
				ENTRY,
				stateFile,
				setupDir.sleepFile,
				setupDir.startFile,
			],
			setupDir.dir,
		);
		const state = JSON.parse(await readFile(stateFile, "utf8")) as {
			runId: string;
			unit: string;
			child: { pid: number };
			sleepPid: number;
		};
		track(setupDir.storePath, state.runId);
		expect(processIdentity(state.child.pid)).not.toBeNull();
		const stored = withStore(setupDir.storePath, store => store.read(state.runId));
		let calls = 0;
		const judge: Judge = async (context, questions) => {
			calls += 1;
			return answer("launch")(context, questions);
		};
		const result = await resumeAutonomyRun(
			{ store: setupDir.storePath, run: state.runId, omp: setupDir.fixture },
			{ judge, now: () => stored.createdAt + stored.policy.maxRuntimeMs + 1_000 },
		);
		expect(result.exitCode).toBe(3);
		expect(calls).toBe(0);
		expect(processIdentity(state.child.pid)).toBeNull();
		expect(processIdentity(state.sleepPid)).toBeNull();
		const run = withStore(setupDir.storePath, store => store.read(state.runId));
		expect(run.waiting?.kind).toBe("resource");
		expect(run.waiting?.reason).toContain("runtime budget is exhausted");
		expect(run.fences.some(fence => fence.scope.unit === state.unit)).toBe(true);
	}, 30_000);

	test("the runtime budget fences the child scope without cancelling the run", async () => {
		const setupDir = await setup({ maxRuntimeMs: 1_500 });
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "stay";
		const result = await startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge: answer("launch") },
		);
		expect(result.exitCode).toBe(3);
		track(setupDir.storePath, result.runId);
		const run = withStore(setupDir.storePath, store => store.read(result.runId));
		expect(run.status).toBe("waiting");
		expect(run.waiting?.kind).toBe("resource");
		expect(run.waiting?.reason).toContain("runtime budget is exhausted");
		expect(run.child).toBeDefined();
		expect(processIdentity(run.child?.pid ?? -1)).toBeNull();
		expect(run.fences.length).toBe(1);
	});

	test("a settled rotation request fences the current scope and relaunches only through a fresh decision", async () => {
		const setupDir = await setup({ maxJudgeCalls: 3, maxRuntimeMs: 30_000 });
		process.env["JEVSTICE_TEST_BEHAVIOR"] = "stay";
		let calls = 0;
		const judge: Judge = async () => {
			calls += 1;
			return answer("launch")({}, []);
		};
		const driving = startAutonomyRun(
			{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
			{ judge },
		);
		const running = await waitFor(async () =>
			withStore(setupDir.storePath, store => store.list().find(candidate => candidate.status === "running")),
		);
		track(setupDir.storePath, running.id);
		const oldChild = running.child as NonNullable<AutonomyRun["child"]>;
		withStore(setupDir.storePath, store =>
			store.update(
				running.id,
				{ epoch: running.epoch },
				current => {
					current.status = "waiting";
					current.waiting = { kind: "rotation_requested", reason: "rotate the settled session", attempts: 0 };
				},
				[],
			),
		);
		// Wait for the second actual bound acknowledgment: the rotated child must be alive and
		// acknowledged before the operator ends the run, not lost as an unrelated process death.
		await waitFor(async () =>
			withStore(setupDir.storePath, store =>
				store.events(running.id).filter(event => event.kind === "driver.bootstrap_ack").length >= 2 ? true : undefined,
			),
		);
		const rotated = withStore(setupDir.storePath, store => store.read(running.id));
		expect(rotated.child).toBeDefined();
		expect(rotated.child?.pid).not.toBe(oldChild.pid);
		expect(processIdentity(rotated.child?.pid ?? -1)).not.toBeNull();
		const stopped = await stopAutonomy({ store: setupDir.storePath, run: running.id, reason: "rotation observed" });
		expect(stopped.status).toBe("cancelled");
		expect(stopped.exitCode).toBe(0);
		const result = await driving;
		expect(result.status).toBe("cancelled");
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(await starts(setupDir)).toBe(2);
		const after = withStore(setupDir.storePath, store => store.read(running.id));
		expect(after.status).toBe("cancelled");
		expect(processIdentity(oldChild.pid)).toBeNull();
		const events = withStore(setupDir.storePath, store => store.events(running.id));
		expect(events.some(event => event.kind === "driver.rotation")).toBe(true);
		expect(events.some(event => event.kind === "scope-fenced")).toBe(true);
	});
});

describe("T5 - status projection", () => {
	test("status prints a bounded summary without the objective or environment", async () => {
		const setupDir = await setup();
		const created = withStore(setupDir.storePath, store => {
			const owner = processIdentity();
			if (owner === null) throw new Error("test identity unavailable");
			const run = store.create(OBJECTIVE, setupDir.policy);
			return store.claim(run.id, owner);
		});
		track(setupDir.storePath, created.id);
		const rows = statusAutonomy({ store: setupDir.storePath, run: created.id });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(created.id);
		expect(rows[0]?.status).toBe("ready");
		expect(rows[0]?.fences).toBe(0);
		const serialized = JSON.stringify(rows[0]);
		expect(serialized).not.toContain("Build a small autonomous feature");
		expect(serialized).not.toContain("TYPESAFE_API_KEY");
	});
});

test("FR-57: lifecycle launch approval cannot substitute for an unsettled deliverable audience", async () => {
	const setupDir = await setup({ maxJudgeCalls: 1, maxRuntimeMs: 8_000 });
	process.env["JEVSTICE_TEST_BEHAVIOR"] = "exit-after-ready";
	const judge: Judge = async () => ({
		ok: true,
		answers: [
			{ name: AUTONOMY_RECOVERY_QUESTION, mode: "choice", label: "launch", confidence: 0.99 },
			{ name: "deliverable_audience", mode: "choice", label: "unclear", confidence: 0.99 },
		],
	});

	const result = await startAutonomyRun(
		{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
		{ judge },
	);
	track(setupDir.storePath, result.runId);

	expect(result.status).toBe("waiting");
	expect(await starts(setupDir)).toBe(0);
}, 20_000);

test("FR-58: a changed checkpoint while startup is judged cannot authorize a child", async () => {
	const setupDir = await setup({ maxJudgeCalls: 1, maxRuntimeMs: 8_000 });
	process.env["JEVSTICE_TEST_BEHAVIOR"] = "exit-after-ready";
	const judge: Judge = async () => {
		withStore(setupDir.storePath, store => {
			const run = store.list()[0];
			if (run === undefined) throw new Error("the judged run was not committed");
			store.update(run.id, { epoch: run.epoch }, current => {
				current.checkpoint.revision += 1;
			});
		});
		return {
			ok: true,
			answers: [
				{ name: AUTONOMY_RECOVERY_QUESTION, mode: "choice", label: "launch", confidence: 0.99 },
				{ name: "deliverable_audience", mode: "choice", label: "internal", confidence: 0.99 },
			],
		};
	};

	const result = await startAutonomyRun(
		{ store: setupDir.storePath, objectiveFile: setupDir.objectiveFile, policyFile: setupDir.policyFile, omp: setupDir.fixture },
		{ judge },
	);
	track(setupDir.storePath, result.runId);

	expect(result.status).toBe("waiting");
	expect(await starts(setupDir)).toBe(0);
}, 20_000);
