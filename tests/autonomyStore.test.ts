import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	openAutonomyStore,
	processAlive,
	processGroupAlive,
	processIdentity,
	type AutonomyPolicy,
	type AutonomyRun,
	type AutonomyStore,
	type ProcessIdentity,
} from "../autonomy/store.js";
import { sha256 } from "../src/state.js";
import {
	autonomyBootId,
	autonomyScopeCommand,
	checkAutonomyScopeCapability,
	fenceAutonomyScope,
	makeAutonomyScopeLaunch,
	observeAutonomyScope,
	type AutonomyScope,
	type AutonomyScopeLaunch,
} from "../autonomy/scope.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const moduleUrl = new URL("../autonomy/store.ts", import.meta.url).href;

interface Fixture {
	dir: string;
	root: string;
	storeDir: string;
	file: string;
	store: AutonomyStore;
}

function policy(root: string, overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
	return {
		roots: [root],
		effects: ["project"],
		maxJudgeCalls: 50,
		maxExecutorCalls: 50,
		maxRuntimeMs: 60_000,
		maxContextBytes: 1_000_000,
		maxArtifactBytes: 100_000,
		...overrides,
	};
}

function openFixture(): Fixture {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "jev-autonomy-store-")));
	const root = join(dir, "project");
	mkdirSync(root);
	const storeDir = join(dir, "state");
	const file = join(storeDir, "autonomy.sqlite");
	return { dir, root, storeDir, file, store: openAutonomyStore(file) };
}

async function inFixture(run: (fixture: Fixture) => void | Promise<void>): Promise<void> {
	const fixture = openFixture();
	try {
		await run(fixture);
	} finally {
		fixture.store.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
}

function create(fixture: Fixture, overrides: Partial<AutonomyPolicy> = {}): AutonomyRun {
	return fixture.store.create("Build the documented reporter", policy(fixture.root, overrides));
}

function requireIdentity(pid: number): ProcessIdentity {
	const identity = processIdentity(pid);
	if (identity === null) throw new Error(`no identity for process ${pid}`);
	return identity;
}

function claim(store: AutonomyStore, id: string): AutonomyRun {
	return store.claim(id, requireIdentity(process.pid));
}

function audienceFor(run: AutonomyRun, external = true, decisionId = "decision-1"): {
	external: boolean;
	objectiveDigest: string;
	decisionId: string;
} {
	return { external, objectiveDigest: sha256(run.objective), decisionId };
}

/** Establish the audience the way the supervisor does: with the recorded decision in the same commit. */
function establishAudience(
	fixture: Fixture,
	run: AutonomyRun,
	claimed: AutonomyRun,
	external = true,
	decisionId = "decision-1",
): AutonomyRun {
	return fixture.store.update(
		run.id,
		{ epoch: claimed.epoch },
		draft => {
			draft.audience = audienceFor(run, external, decisionId);
		},
		[{ kind: "driver.recovery_decision", data: { decisionId, external, purpose: "initial" } }],
	);
}

async function detachedIdentity(pid: number): Promise<ProcessIdentity> {
	// The kernel creates the new process group asynchronously, so a real poll is required.
	const started = Date.now();
	while (true) {
		const identity = processIdentity(pid);
		if (identity !== null && identity.group === pid) return identity;
		if (Date.now() - started > 5000) throw new Error(`process ${pid} did not enter its own group`);
		await Bun.sleep(10);
	}
}

interface SpawnedChild {
	pid: number;
	exited: Promise<number>;
}

function spawnScript(script: string, environment: Record<string, string>, detached = false): SpawnedChild {
	return Bun.spawn([process.execPath, "-e", script], {
		cwd: repoRoot,
		env: { ...process.env, ...environment },
		stdout: "ignore",
		stderr: "ignore",
		detached,
	});
}

async function stopDetached(child: SpawnedChild, group: number): Promise<void> {
	try {
		process.kill(-group, "SIGKILL");
	} catch {
		// The group already exited; waiting for the child is still required.
	}
	await child.exited;
}

async function stopProcess(child: SpawnedChild): Promise<void> {
	try {
		process.kill(child.pid, "SIGKILL");
	} catch {
		// The child already exited.
	}
	await child.exited;
}

async function waitForMarker(file: string, timeoutMs = 20_000): Promise<string> {
	// A real child writes this marker after its own commit; fake timers cannot advance kernel state.
	const started = Date.now();
	while (true) {
		if (existsSync(file)) {
			const value = readFileSync(file, "utf8");
			if (value !== "") return value;
		}
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${file}`);
		await Bun.sleep(20);
	}
}

const OTHER_BOOT = "00000000-0000-4000-8000-000000000001";

async function requireScopeCapability(): Promise<void> {
	try {
		await checkAutonomyScopeCapability();
	} catch (error) {
		throw new Error(`these tests require whole-scope capability: ${error instanceof Error ? error.message : error}`);
	}
}

interface ScopedNative {
	child: { exited: Promise<number> };
	identity: ProcessIdentity;
	scope: AutonomyScope;
	launch: AutonomyScopeLaunch;
}

/** Spawn a genuine native program inside a real user scope and observe the live unit. */
async function spawnScopedNative(
	runId: string,
	epoch: number,
	command: string,
	args: string[],
): Promise<ScopedNative> {
	const launch = makeAutonomyScopeLaunch(runId, epoch);
	const child = Bun.spawn(autonomyScopeCommand(launch, command, args), {
		cwd: repoRoot,
		env: process.env,
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	let identity: ProcessIdentity | undefined;
	try {
		identity = processIdentity(child.pid) ?? undefined;
	} catch {
		identity = undefined;
	}
	const started = Date.now();
	let scope: AutonomyScope | undefined;
	let failure: unknown;
	while (scope === undefined) {
		try {
			scope = await observeAutonomyScope(launch, requireIdentity(child.pid));
		} catch (error) {
			if (child.exitCode !== null) {
				failure = new Error(`scoped process exited early: ${String(error)}`);
				break;
			}
			if (Date.now() - started > 20_000) {
				failure = error;
				break;
			}
			// The kernel creates the scope asynchronously; a real poll is the only wait available.
			await Bun.sleep(50);
		}
	}
	if (scope === undefined) {
		const problem = await cleanupScopedStartup(launch, child, identity);
		if (problem !== undefined) {
			throw new Error(`scoped startup failed (${String(failure)}); cleanup failed: ${problem}`);
		}
		throw failure;
	}
	let observedIdentity: ProcessIdentity;
	try {
		observedIdentity = requireIdentity(child.pid);
	} catch (error) {
		const problem = await cleanupScopedStartup(launch, child, identity);
		if (problem !== undefined) {
			throw new Error(`scoped identity vanished after observation (${String(error)}); cleanup failed: ${problem}`);
		}
		throw error;
	}
	return { child, identity: observedIdentity, scope, launch };
}

function scopedUnitState(unit: string): string {
	try {
		const result = Bun.spawnSync({
			cmd: ["systemctl", "--user", "show", "--property=LoadState", "--", unit],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		if (!result.success || result.exitCode !== 0) return "unknown";
		const text = result.stdout.toString().trim();
		return text.startsWith("LoadState=") ? text.slice("LoadState=".length) : "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * A fenced scope's unit unloads asynchronously. Wait for the real manager to report it gone so a
 * synchronous store call after fencing does not race the transient unit-teardown state.
 */
async function waitForScopedUnitGone(unit: string, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (scopedUnitState(unit) === "not-found") return;
		await Bun.sleep(20);
	}
	throw new Error(`unit ${unit} did not become not-found`);
}

/** Failed-startup cleanup addresses only the unique precommitted unit and the exact spawned identity. */
async function cleanupScopedStartup(
	launch: AutonomyScopeLaunch,
	child: { exited: Promise<number> },
	identity: ProcessIdentity | undefined,
): Promise<string | undefined> {
	try {
		Bun.spawnSync({
			cmd: ["systemctl", "--user", "kill", "--signal=KILL", "--kill-whom=all", "--", launch.unit],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
	} catch {
		// The unit may never have loaded; the quiescence check below is the real proof.
	}
	if (identity !== undefined) {
		try {
			if (processAlive(identity)) {
				process.kill(identity.pid, "SIGKILL");
				if (identity.group === identity.pid) process.kill(-identity.group, "SIGKILL");
			}
		} catch {
			// An unobservable identity is never signalled.
		}
	}
	try {
		await child.exited;
	} catch {
		// Cleanup does not depend on the exit value.
	}
	const started = Date.now();
	while (Date.now() - started < 10_000) {
		if (scopedUnitState(launch.unit) === "not-found") return undefined;
		await Bun.sleep(50);
	}
	return `unit ${launch.unit} is still ${scopedUnitState(launch.unit)}`;
}

/** Final cleanup only: fence the whole scope, then kill the exact observed identity while it is live. */
async function releaseScopedNative(spawned: ScopedNative): Promise<void> {
	try {
		await fenceAutonomyScope(spawned.scope);
	} catch {
		// The scope may already be gone; the exact-identity kill below is the fallback.
	}
	try {
		if (processAlive(spawned.identity)) {
			process.kill(spawned.identity.pid, "SIGKILL");
			if (spawned.identity.group === spawned.identity.pid) process.kill(-spawned.identity.group, "SIGKILL");
		}
	} catch {
		// The exact process or group already exited; a reused identity is never signalled.
	}
	await spawned.child.exited;
}

/** Replace one run body and its checksum, so a stored field can be exercised without a real reboot. */
function rewriteRunBody(fixture: Fixture, id: string, mutate: (body: Record<string, unknown>) => void): void {
	const raw = new Database(fixture.file, { strict: true });
	try {
		const row = raw.query<{ body: string }, [string]>("SELECT body FROM runs WHERE id = ?").get(id);
		if (row === null) throw new Error("run row missing");
		const body = JSON.parse(row.body) as Record<string, unknown>;
		mutate(body);
		const forged = JSON.stringify(body);
		raw.query("UPDATE runs SET body = ?, digest = ? WHERE id = ?").run(forged, sha256(forged), id);
	} finally {
		raw.close();
	}
}

/** Journal the judge.request a decision actually saw, so its exact context can be recovered later. */
function recordJudgeRequest(
	fixture: Fixture,
	runId: string,
	epoch: number,
	request: Record<string, unknown>,
): { digest: string; sequence: number } {
	const serialized = JSON.stringify(request);
	const digest = sha256(serialized);
	const updated = fixture.store.update(runId, { epoch }, () => {}, [
		{
			kind: "judge.request",
			data: {
				purpose: "decision",
				callId: null,
				requestDigest: digest,
				bytes: Buffer.byteLength(serialized, "utf8"),
				request,
				questions: "Is this call actually authorized?",
				revision: 0,
			},
		},
	]);
	return { digest, sequence: updated.sequence };
}

function claimScript(): string {
	// The spawned runtime receives the module URL as data, so its import cannot be static.
	return `
void (async () => {
	const fs = await import("node:fs");
	try {
		const mod = await import(${JSON.stringify(moduleUrl)});
		const store = mod.openAutonomyStore(process.env.JEV_STORE_FILE);
		const identity = mod.processIdentity();
		if (identity === null) throw new Error("no process identity");
		const run = store.claim(process.env.JEV_RUN_ID, identity);
		fs.writeFileSync(process.env.JEV_MARKER, String(run.epoch));
		store.close();
		await Bun.sleep(60000);
	} catch (error) {
		fs.writeFileSync(process.env.JEV_MARKER, "ERR:" + (error instanceof Error ? error.message : String(error)));
	}
})();
`;
}

function childWriteScript(): string {
	// The spawned runtime receives the module URL as data, so its import cannot be static; its file
	// handshake is a real process boundary that fake timers cannot advance.
	return `
void (async () => {
	const fs = await import("node:fs");
	const mod = await import(${JSON.stringify(moduleUrl)});
	const store = mod.openAutonomyStore(process.env.JEV_STORE_FILE);
	const commandPath = process.env.JEV_DIR + "/command.json";
	while (true) {
		if (!fs.existsSync(commandPath)) {
			await Bun.sleep(10);
			continue;
		}
		let command;
		try {
			command = JSON.parse(fs.readFileSync(commandPath, "utf8"));
		} catch {
			await Bun.sleep(10);
			continue;
		}
		fs.unlinkSync(commandPath);
		try {
			store.update(
				command.run,
				command.access,
				draft => {
					if (command.audience !== undefined) {
						draft.audience = command.audience;
					}
					draft.status = "running";
				},
				command.events === undefined ? undefined : command.events,
			);
			fs.writeFileSync(command.result, "ALLOWED");
		} catch (error) {
			fs.writeFileSync(command.result, "REJECTED:" + (error instanceof Error ? error.message : String(error)));
		}
	}
})();
`;
}

function foreignUpdateScript(): string {
	// The spawned runtime receives the module URL as data, so its import cannot be static.
	return `
void (async () => {
	const fs = await import("node:fs");
	try {
		const mod = await import(${JSON.stringify(moduleUrl)});
		const store = mod.openAutonomyStore(process.env.JEV_STORE_FILE);
		const run = store.read(process.env.JEV_RUN_ID);
		store.update(run.id, { epoch: run.epoch }, draft => {
			draft.status = "running";
		});
		fs.writeFileSync(process.env.JEV_MARKER, "ALLOWED");
		store.close();
	} catch (error) {
		fs.writeFileSync(process.env.JEV_MARKER, "REJECTED:" + (error instanceof Error ? error.message : String(error)));
	}
})();
`;
}

/**
 * A real launcher process: it starts the supervisor, waits until that supervisor has claimed the run
 * natively, then exits. The live supervisor is consequently reparented by the kernel.
 *
 * These scripts run in separate processes and receive the module URL as data, so a static import
 * cannot resolve it; the poll below observes a real kernel reparenting event that fake timers cannot
 * advance.
 */
function reparentingLauncherScript(): string {
	return `
void (async () => {
	const fs = await import("node:fs");
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, [process.env.JEV_SUPERVISOR_FILE], {
		env: process.env,
		stdio: "ignore",
		detached: false,
	});
	child.unref();
	const started = Date.now();
	while (!fs.existsSync(process.env.JEV_CLAIMED)) {
		if (Date.now() - started > 20000) process.exit(2);
		await Bun.sleep(10);
	}
	process.exit(0);
})();
`;
}

/**
 * The supervisor claims with its own native identity, waits until its kernel parent actually changes,
 * then writes with that same claimed epoch. Its marker records the pid and both parents.
 */
function reparentedSupervisorScript(): string {
	return `
void (async () => {
	const fs = await import("node:fs");
	const mod = await import(${JSON.stringify(moduleUrl)});
	const store = mod.openAutonomyStore(process.env.JEV_STORE_FILE);
	const identity = mod.processIdentity();
	if (identity === null) throw new Error("no process identity");
	const claimed = store.claim(process.env.JEV_RUN_ID, identity);
	fs.writeFileSync(process.env.JEV_CLAIMED, JSON.stringify({ pid: process.pid, parent: identity.parent }));
	const started = Date.now();
	while (true) {
		const now = mod.processIdentity(process.pid);
		if (now !== null && now.parent !== identity.parent) {
			try {
				store.update(claimed.id, { epoch: claimed.epoch }, draft => {
					draft.status = "running";
				});
				fs.writeFileSync(process.env.JEV_RESULT, JSON.stringify({ ok: true, parent: now.parent, claimedFrom: identity.parent }));
			} catch (error) {
				fs.writeFileSync(process.env.JEV_RESULT, "ERR:" + (error instanceof Error ? error.message : String(error)));
			}
			break;
		}
		if (Date.now() - started > 20000) {
			fs.writeFileSync(process.env.JEV_RESULT, "ERR:never reparented");
			break;
		}
		await Bun.sleep(10);
	}
	await Bun.sleep(60000);
})();
`;
}

describe("process identity", () => {
	test("the current identity is exact and a different start tick is a dead process", () => {
		const identity = requireIdentity(process.pid);

		expect(identity.pid).toBe(process.pid);
		expect(identity.start).toMatch(/^\d+$/);
		expect(processAlive(identity)).toBe(true);
		expect(processAlive({ ...identity, start: "0" })).toBe(false);
	});

	test("a different kernel boot is dead and is never signalled", () => {
		const identity = requireIdentity(process.pid);
		expect(identity.bootId).toBe(autonomyBootId());
		expect(processAlive({ ...identity, bootId: OTHER_BOOT })).toBe(false);
	});

	test("a kernel thread in group zero parses without being a signalable identity", () => {
		// kthreadd is the kernel's standard group-0 process: the parser must accept the record and
		// the identity layer must refuse to call it a signalable process.
		expect(processIdentity(2)).toBeNull();
	});

	test("a missing process and process group are not alive, and invalid input is refused", () => {
		const unusedPid = 2_147_483_646;
		const unused: ProcessIdentity = {
			pid: unusedPid,
			start: "1",
			group: 1,
			parent: 0,
			bootId: requireIdentity(process.pid).bootId,
		};

		expect(processIdentity(unusedPid)).toBeNull();
		expect(processAlive(unused)).toBe(false);
		expect(processGroupAlive(unusedPid)).toBe(false);
		expect(processGroupAlive(requireIdentity(process.pid).group)).toBe(true);
		expect(() => processAlive({ ...unused, pid: 0 })).toThrow();
		expect(() => processGroupAlive(0)).toThrow();
	});

	test("a command name with spaces and parentheses is parsed from the real proc record", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-autonomy-comm-"));
		const link = join(dir, "a (b) c");
		symlinkSync(process.execPath, link);
		const child = Bun.spawn([link, "-e", "void (async () => { await Bun.sleep(60000); })();"], {
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		const identity = await detachedIdentity(child.pid);
		try {
			expect(identity.pid).toBe(child.pid);
			expect(identity.start).toMatch(/^\d+$/);
			expect(processAlive(identity)).toBe(true);
		} finally {
			await stopDetached(child, identity.group);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a killed detached child's group stops being alive", async () => {
		const child = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
		const identity = await detachedIdentity(child.pid);
		try {
			expect(identity.group).toBe(child.pid);
			expect(processAlive(identity)).toBe(true);
			expect(processGroupAlive(identity.group)).toBe(true);
		} finally {
			await stopDetached(child, identity.group);
		}
		expect(processAlive(identity)).toBe(false);
		expect(processGroupAlive(identity.group)).toBe(false);
	});
});

describe("create and restore", () => {
	test("a created run binds the canonical policy, a fresh strict checkpoint and a create event", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);

			expect(run.objective).toBe("Build the documented reporter");
			expect(run.policy.roots).toEqual([fixture.root]);
			expect(run.policyDigest).toBe(sha256(JSON.stringify(run.policy)));
			expect(run.status).toBe("ready");
			expect(run.epoch).toBe(0);
			expect(run.generation).toBe(0);
			expect(run.sequence).toBe(1);
			expect(run.checkpoint.autonomous).toBe(true);
			expect(run.checkpoint.refusedCalls).toBeInstanceOf(Map);
			expect(run.policy.effects).toEqual(["project"]);
			expect(run.pending).toEqual({});
			const restored = fixture.store.read(run.id);
			expect(restored.id).toBe(run.id);
			expect(restored.status).toBe("ready");
			expect(restored.policy).toEqual(run.policy);
			expect(restored.checkpoint.autonomous).toBe(true);
			expect(fixture.store.list().map(entry => entry.id)).toEqual([run.id]);
			expect(fixture.store.events(run.id)).toEqual([{ sequence: 1, kind: "create", data: { policyDigest: run.policyDigest } }]);
			expect(statSync(fixture.file).mode & 0o777).toBe(0o600);
			expect(statSync(fixture.storeDir).mode & 0o077).toBe(0);
		});
	});

	test("the checkpoint survives close and reopen with its Map and artifact bytes", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const bytes = new TextEncoder().encode("exact artifact bytes");
			const updated = fixture.store.update(
				run.id,
				{ epoch: claimed.epoch },
				draft => {
					draft.status = "running";
					draft.checkpoint.refusedCalls.set("plan", 2);
					draft.checkpoint.actions.push({ tool: "write", target: "src/a.ts", excerpt: "changed" });
				},
				[{ kind: "progress", data: { step: 1 } }],
				{ "local://a.txt": bytes },
			);
			const digest = updated.artifacts["local://a.txt"];
			fixture.store.close();

			const reopened = openAutonomyStore(fixture.file);
			try {
				const restored = reopened.read(run.id);
				expect(restored.status).toBe("running");
				expect(restored.sequence).toBe(updated.sequence);
				expect(restored.checkpoint.refusedCalls).toBeInstanceOf(Map);
				expect(restored.checkpoint.refusedCalls.get("plan")).toBe(2);
				expect(restored.artifacts["local://a.txt"]).toBe(digest);
				expect([...(reopened.artifact(run.id, "local://a.txt") ?? [])]).toEqual([...bytes]);
				expect(reopened.artifact(run.id, "local://missing.txt")).toBeNull();
			} finally {
				reopened.close();
			}
		});
	});

	test("an invalid policy or objective is refused and no run is reserved", async () => {
		await inFixture(async fixture => {
			const missing = join(fixture.dir, "missing");
			const nested = join(fixture.root, "nested");
			mkdirSync(nested);

			expect(() => fixture.store.create("", policy(fixture.root))).toThrow();
			expect(() => fixture.store.create("objective", policy("relative/path"))).toThrow();
			expect(() => fixture.store.create("objective", policy(missing))).toThrow();
			expect(() => fixture.store.create("objective", { ...policy(fixture.root), roots: [fixture.root, fixture.root] })).toThrow();
			expect(() => fixture.store.create("objective", { ...policy(fixture.root), roots: [fixture.root, nested] })).toThrow();
			expect(() =>
				fixture.store.create("objective", {
					...policy(fixture.root),
					effects: ["publication", "publication"],
				}),
			).toThrow();
			expect(() =>
				fixture.store.create("objective", {
					...policy(fixture.root),
					effects: ["push"],
				} as unknown as AutonomyPolicy),
			).toThrow();
			expect(() => fixture.store.create("objective", policy(fixture.root, { maxJudgeCalls: 0 }))).toThrow();
			expect(() => fixture.store.create("objective", policy(fixture.root, { maxExecutorCalls: 1.5 }))).toThrow();
			expect(fixture.store.list()).toEqual([]);
		});
	});

	test("the store file may not live under an authorized root", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-autonomy-inside-"));
		const root = join(dir, "project");
		mkdirSync(root);
		const store = openAutonomyStore(join(root, "state", "autonomy.sqlite"));
		try {
			expect(() => store.create("objective", policy(root))).toThrow(/executor-writable/);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("overlapping roots are exclusive to nonterminal runs and released by cancellation", async () => {
		await inFixture(async fixture => {
			const nested = join(fixture.root, "nested");
			mkdirSync(nested);
			const first = create(fixture);
			const sibling = join(fixture.dir, "sibling");
			mkdirSync(sibling);
			const second = fixture.store.create("second objective", policy(sibling));

			expect(() => fixture.store.create("overlap", policy(fixture.root))).toThrow(/overlapping/);
			expect(() => fixture.store.create("nested overlap", policy(nested))).toThrow(/overlapping/);

			fixture.store.cancel(first.id, "operator stop");
			const reused = fixture.store.create("reused objective", policy(fixture.root));
			expect(fixture.store.list().length).toBe(3);
			expect(reused.policy.roots).toEqual([fixture.root]);
			expect(second.status).toBe("ready");
		});
	});

	test("a canonical symlink alias still conflicts with the real root", async () => {
		await inFixture(async fixture => {
			create(fixture);
			const alias = join(fixture.dir, "alias");
			symlinkSync(fixture.root, alias);

			expect(() => fixture.store.create("alias objective", policy(alias))).toThrow(/overlapping/);
		});
	});

	test("an insecure, symbolic or in-memory database path is refused", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-autonomy-path-"));
		try {
			expect(() => openAutonomyStore(":memory:")).toThrow();
			expect(() => openAutonomyStore("file::memory:")).toThrow();

			const loose = join(dir, "loose.sqlite");
			writeFileSync(loose, "");
			chmodSync(loose, 0o644);
			expect(() => openAutonomyStore(loose)).toThrow(/permissions/);

			const target = join(dir, "target.sqlite");
			writeFileSync(target, "", { mode: 0o600 });
			const link = join(dir, "link.sqlite");
			symlinkSync(target, link);
			expect(() => openAutonomyStore(link)).toThrow(/symlink/);

			const directory = join(dir, "directory");
			mkdirSync(directory);
			expect(() => openAutonomyStore(directory)).toThrow(/regular file/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("close is idempotent", async () => {
		await inFixture(async fixture => {
			fixture.store.close();
			fixture.store.close();
		});
	});
});

describe("claim ownership", () => {
	test("the same live owner keeps its claim and epoch", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const first = claim(fixture.store, run.id);

			expect(first.epoch).toBe(1);
			expect(first.owner?.pid).toBe(process.pid);
			expect(first.status).toBe("ready");
			const again = claim(fixture.store, run.id);
			expect(again.epoch).toBe(first.epoch);
			expect(again.sequence).toBe(first.sequence);
		});
	});

	test("a forged owner identity is refused", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const identity = requireIdentity(process.pid);

			expect(() => fixture.store.claim(run.id, { ...identity, start: "0" })).toThrow(/actual caller/);
			expect(fixture.store.read(run.id).owner).toBeUndefined();
		});
	});

	test("another live supervisor blocks a claim, and a dead supervisor is replaced with a new epoch", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const marker = join(fixture.dir, "claim.marker");
			const child = spawnScript(claimScript(), {
				JEV_STORE_FILE: fixture.file,
				JEV_RUN_ID: run.id,
				JEV_MARKER: marker,
			});
			try {
				expect(await waitForMarker(marker)).toBe("1");
				expect(() => claim(fixture.store, run.id)).toThrow(/live supervisor/);
			} finally {
				await stopProcess(child);
			}

			const takeover = claim(fixture.store, run.id);
			expect(takeover.epoch).toBe(2);
			expect(takeover.owner?.pid).toBe(process.pid);
			expect(takeover.status).toBe("recovering");
			expect(fixture.store.events(run.id).some(event => event.kind === "claim")).toBe(true);
		});
	});

	test("a reparented live supervisor keeps its own authority and a foreign caller is refused", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const supervisorFile = join(fixture.dir, "reparented-supervisor.ts");
			const claimedMarker = join(fixture.dir, "reparented-claimed.marker");
			const resultMarker = join(fixture.dir, "reparented-result.marker");
			writeFileSync(supervisorFile, reparentedSupervisorScript());
			const launcher = Bun.spawn([process.execPath, "-e", reparentingLauncherScript()], {
				cwd: repoRoot,
				env: {
					...process.env,
					JEV_STORE_FILE: fixture.file,
					JEV_RUN_ID: run.id,
					JEV_SUPERVISOR_FILE: supervisorFile,
					JEV_CLAIMED: claimedMarker,
					JEV_RESULT: resultMarker,
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			let supervisorPid: number | undefined;
			try {
				const claimedInfo = JSON.parse(await waitForMarker(claimedMarker)) as { pid: number; parent: number };
				supervisorPid = claimedInfo.pid;
				const result = await waitForMarker(resultMarker);
				expect(result.startsWith("ERR:")).toBe(false);
				const written = JSON.parse(result) as { ok: boolean; parent: number; claimedFrom: number };
				expect(written.ok).toBe(true);
				expect(written.parent).not.toBe(written.claimedFrom);

				// The store now holds the reparented supervisor's own identity, and only that identity
				// may write. The test process is a live foreign caller and stays refused.
				const current = fixture.store.read(run.id);
				expect(current.owner?.pid).toBe(claimedInfo.pid);
				expect(current.status).toBe("running");
				expect(() =>
					fixture.store.update(run.id, { epoch: current.epoch }, draft => {
						draft.status = "waiting";
					}),
				).toThrow();
				expect(() => claim(fixture.store, run.id)).toThrow();
			} finally {
				await launcher.exited;
				if (supervisorPid !== undefined) {
					try {
						process.kill(supervisorPid, "SIGKILL");
					} catch {
						// The supervisor may already have exited.
					}
				}
			}
		});
	}, 60_000);

	test("a terminal run refuses a claim", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			fixture.store.cancel(run.id, "operator stop");

			expect(() => claim(fixture.store, run.id)).toThrow(/terminal/);
		});
	});
});

describe("child and session binding", () => {
	test("only a live supervised child in its own group is admitted, and the old group must be fenced", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const first = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const firstIdentity = await detachedIdentity(first.pid);
			const second = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const secondIdentity = await detachedIdentity(second.pid);
			try {
				expect(() => fixture.store.bindChild(run.id, claimed.epoch + 1, firstIdentity)).toThrow(/epoch/);
				expect(() => fixture.store.bindChild(run.id, claimed.epoch, { ...firstIdentity, start: "0" })).toThrow(/identity/);

				const bound = fixture.store.bindChild(run.id, claimed.epoch, firstIdentity);
				expect(bound.child).toEqual(firstIdentity);
				expect(bound.session).toBeUndefined();
				expect(() => fixture.store.bindChild(run.id, claimed.epoch, secondIdentity)).toThrow(/still alive/);

				await stopDetached(first, firstIdentity.group);
				expect(processAlive(firstIdentity)).toBe(false);
				const replaced = fixture.store.bindChild(run.id, claimed.epoch, secondIdentity);
				expect(replaced.child).toEqual(secondIdentity);
			} finally {
				await stopDetached(first, firstIdentity.group);
				await stopDetached(second, secondIdentity.group);
			}
		});
	});

	test("a session binds only under the supervisor, increments generation and clears execution acceptance", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			expect(() => fixture.store.bindSession(run.id, claimed.epoch, { id: "s0", file: "local://s0.jsonl" })).toThrow(
				/no child/,
			);
			const child = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const childIdentity = await detachedIdentity(child.pid);
			try {
				fixture.store.bindChild(run.id, claimed.epoch, childIdentity);
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.checkpoint.acceptance = [
						{ aspect: "business", revision: 0, label: "serves", approved: true, confidence: 0.9 },
					];
					draft.checkpoint.completion = { revision: 0, label: "follows", approved: true, confidence: 0.9 };
				});

				const first = fixture.store.bindSession(run.id, claimed.epoch, { id: "s1", file: "local://s1.jsonl" });
				expect(first.generation).toBe(1);
				expect(first.checkpoint.acceptance).toEqual([]);
				expect(first.checkpoint.completion).toBeUndefined();
				expect(() =>
					fixture.store.bindSession(run.id, claimed.epoch + 1, { id: "s2", file: "local://s2.jsonl" }),
				).toThrow(/epoch/);

				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.checkpoint.acceptance = [
						{ aspect: "business", revision: 0, label: "serves", approved: true, confidence: 0.9 },
					];
					draft.wake = {
						id: "wake-1",
						epoch: claimed.epoch,
						generation: first.generation,
						sessionId: "s1",
						status: "pending",
						deadline: Date.now() + 1000,
					};
				});
				const same = fixture.store.bindSession(run.id, claimed.epoch, { id: "s1", file: "local://s1.jsonl" });
				expect(same.generation).toBe(1);
				expect(same.sequence).toBe(first.sequence + 1);
				expect(same.checkpoint.acceptance.length).toBe(1);
				expect(same.wake?.id).toBe("wake-1");

				const changed = fixture.store.bindSession(run.id, claimed.epoch, { id: "s2", file: "local://s2.jsonl" });
				expect(changed.generation).toBe(2);
				expect(changed.checkpoint.acceptance).toEqual([]);
				expect(changed.wake).toBeUndefined();
			} finally {
				await stopDetached(child, childIdentity.group);
			}
		});
	});

	test("a stored child from another boot never blocks a replacement via a reused live group", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const first = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const firstIdentity = await detachedIdentity(first.pid);
			const unrelated = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const unrelatedIdentity = await detachedIdentity(unrelated.pid);
			const replacement = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const replacementIdentity = await detachedIdentity(replacement.pid);
			try {
				fixture.store.bindChild(run.id, claimed.epoch, firstIdentity);
				await stopDetached(first, firstIdentity.group);
				expect(processAlive(firstIdentity)).toBe(false);
				// A reboot makes the stored child dead by definition. Its numeric group id may now name
				// an unrelated live group; only the recorded boot can decide whether the old executor exists.
				rewriteRunBody(fixture, run.id, body => {
					const child = body.child as Record<string, unknown>;
					child.bootId = OTHER_BOOT;
					child.group = unrelatedIdentity.group;
				});
				expect(processGroupAlive(unrelatedIdentity.group)).toBe(true);
				const replaced = fixture.store.bindChild(run.id, claimed.epoch, replacementIdentity);
				expect(replaced.child).toEqual(replacementIdentity);
			} finally {
				await stopDetached(first, firstIdentity.group);
				await stopDetached(unrelated, unrelatedIdentity.group);
				await stopDetached(replacement, replacementIdentity.group);
			}
		});
	}, 60_000);

	test("a new child clears the old session and the next bind is a fresh generation even for the same id and file", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const first = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const firstIdentity = await detachedIdentity(first.pid);
			const second = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const secondIdentity = await detachedIdentity(second.pid);
			try {
				fixture.store.bindChild(run.id, claimed.epoch, firstIdentity);
				const bound = fixture.store.bindSession(run.id, claimed.epoch, { id: "s1", file: "local://s1.jsonl" });
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.checkpoint.acceptance = [
						{ aspect: "business", revision: 0, label: "serves", approved: true, confidence: 0.9 },
					];
				});
				expect(bound.generation).toBe(1);

				await stopDetached(first, firstIdentity.group);
				const reboundChild = fixture.store.bindChild(run.id, claimed.epoch, secondIdentity);
				expect(reboundChild.child).toEqual(secondIdentity);
				expect(reboundChild.session).toBeUndefined();
				expect(reboundChild.checkpoint.acceptance).toEqual([]);

				// The host may reuse the previous session id and file for the new child; the stale
				// acceptance must not survive that reuse, and the generation must still advance.
				const fresh = fixture.store.bindSession(run.id, claimed.epoch, { id: "s1", file: "local://s1.jsonl" });
				expect(fresh.generation).toBe(2);
				expect(fresh.checkpoint.acceptance).toEqual([]);
				const idempotent = fixture.store.bindSession(run.id, claimed.epoch, { id: "s1", file: "local://s1.jsonl" });
				expect(idempotent.generation).toBe(2);
			} finally {
				await stopDetached(first, firstIdentity.group);
				await stopDetached(second, secondIdentity.group);
			}
		});
	}, 60_000);

	test("a launch quiescence receipt is monotone, bound to its launch and refuses a wrong boot claim", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const launch = makeAutonomyScopeLaunch(run.id, claimed.epoch);
			fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
				draft.pending["launch-quiet"] = {
					id: "launch-quiet",
					kind: "lifecycle",
					payload: { operation: "spawn", launch, spawnStarted: false },
					revision: 0,
					createdAt: Date.now(),
				};
			});
			const first = fixture.store.recordLaunchFence(run.id, claimed.epoch, launch, "unit-unloaded");
			expect(first.launchFences.length).toBe(1);
			expect(first.launchFences[0]?.launch.unit).toBe(launch.unit);
			expect(first.launchFences[0]?.method).toBe("unit-unloaded");
			expect(first.launchFences[0]?.intentIds).toEqual(["launch-quiet"]);

			const again = fixture.store.recordLaunchFence(run.id, claimed.epoch, launch, "unit-unloaded");
			expect(again.launchFences.length).toBe(1);
			expect(again.launchFences[0]?.observedAt).toBe(first.launchFences[0]?.observedAt);

			const unrelated = makeAutonomyScopeLaunch(run.id, claimed.epoch);
			expect(() => fixture.store.recordLaunchFence(run.id, claimed.epoch, unrelated, "unit-unloaded")).toThrow(
				/launch/,
			);
			expect(() => fixture.store.recordLaunchFence(run.id, claimed.epoch, launch, "boot-difference")).toThrow(
				/boot/,
			);

			fixture.store.cancel(run.id, "operator stop after launch proof");
			expect(() => fixture.store.create("overlap with a proved launch", policy(fixture.root))).not.toThrow();
		});
	}, 60_000);

	test("an absent unit is not quiescence while a launch producer may still create it", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const startedLaunch = makeAutonomyScopeLaunch(run.id, claimed.epoch);
			fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
				draft.pending["launch-started"] = {
					id: "launch-started",
					kind: "lifecycle",
					payload: { operation: "spawn", launch: startedLaunch, spawnStarted: true },
					revision: 0,
					createdAt: Date.now(),
				};
			});
			expect(() =>
				fixture.store.recordLaunchFence(run.id, claimed.epoch, startedLaunch, "unit-unloaded"),
			).toThrow(/producer started/);

			// An intent from an older writer carries no never-started marker; its producer state is unknown.
			const legacyLaunch = makeAutonomyScopeLaunch(run.id, claimed.epoch);
			fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
				draft.pending["launch-legacy"] = {
					id: "launch-legacy",
					kind: "lifecycle",
					payload: { operation: "spawn", launch: legacyLaunch },
					revision: 0,
					createdAt: Date.now(),
				};
			});
			expect(() =>
				fixture.store.recordLaunchFence(run.id, claimed.epoch, legacyLaunch, "unit-unloaded"),
			).toThrow(/producer state is unknown/);

			const producer = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const producerIdentity = await detachedIdentity(producer.pid);
			const liveLaunch = makeAutonomyScopeLaunch(run.id, claimed.epoch);
			fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
				draft.pending["launch-live"] = {
					id: "launch-live",
					kind: "lifecycle",
					payload: { operation: "spawn", launch: liveLaunch, child: producerIdentity },
					revision: 0,
					createdAt: Date.now(),
				};
			});
			try {
				expect(() =>
					fixture.store.recordLaunchFence(run.id, claimed.epoch, liveLaunch, "unit-unloaded"),
				).toThrow(/producer is still alive/);
				expect(fixture.store.read(run.id).launchFences).toEqual([]);
			} finally {
				await stopDetached(producer, producerIdentity.group);
			}
		});
	}, 60_000);

	test("a process outside the run cannot commit an update", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			claim(fixture.store, run.id);
			const marker = join(fixture.dir, "foreign.marker");
			const child = spawnScript(foreignUpdateScript(), {
				JEV_STORE_FILE: fixture.file,
				JEV_RUN_ID: run.id,
				JEV_MARKER: marker,
			});
			try {
				expect(await waitForMarker(marker)).toContain("REJECTED:");
				expect(fixture.store.read(run.id).status).toBe("ready");
				expect(fixture.store.read(run.id).sequence).toBe(2);
			} finally {
				await stopProcess(child);
			}
		});
	});

	test("a bound child commits only with the current session generation", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const child = spawnScript(childWriteScript(), { JEV_STORE_FILE: fixture.file, JEV_DIR: fixture.dir }, true);
			const childIdentity = await detachedIdentity(child.pid);
			try {
				fixture.store.bindChild(run.id, claimed.epoch, childIdentity);
				const session = fixture.store.bindSession(run.id, claimed.epoch, {
					id: "child-session",
					file: "local://child-session.jsonl",
				});
				const command = join(fixture.dir, "command.json");
				const firstResult = join(fixture.dir, "child-result-1.txt");
				writeFileSync(
					command,
					JSON.stringify({
						run: run.id,
						access: { epoch: claimed.epoch, sessionId: "child-session", generation: session.generation },
						result: firstResult,
					}),
				);
				expect(await waitForMarker(firstResult)).toBe("ALLOWED");
				expect(fixture.store.read(run.id).status).toBe("running");

				const secondResult = join(fixture.dir, "child-result-2.txt");
				writeFileSync(
					command,
					JSON.stringify({
						run: run.id,
						access: { epoch: claimed.epoch, sessionId: "child-session", generation: session.generation - 1 },
						result: secondResult,
					}),
				);
				expect(await waitForMarker(secondResult)).toContain("REJECTED:");
				expect(fixture.store.read(run.id).status).toBe("running");
			} finally {
				await stopDetached(child, childIdentity.group);
			}
		});
	});
});

describe("audience receipt", () => {
	test("the supervisor establishes an objective-bound audience once and it survives reload", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			expect(run.audience).toBeUndefined();
			const claimed = claim(fixture.store, run.id);
			const established = establishAudience(fixture, run, claimed, true, "decision-initial");

			expect(established.audience).toEqual(audienceFor(run, true, "decision-initial"));
			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.audience = audienceFor(run, false, "decision-initial");
				}),
			).toThrow();
			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.audience = audienceFor(run, true, "decision-other");
				}),
			).toThrow();
			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					delete draft.audience;
				}),
			).toThrow();
			expect(fixture.store.read(run.id).audience).toEqual(audienceFor(run, true, "decision-initial"));

			fixture.store.close();
			const reopened = openAutonomyStore(fixture.file);
			try {
				const restored = reopened.read(run.id);
				expect(restored.audience).toEqual(audienceFor(run, true, "decision-initial"));
				const reclaimed = reopened.claim(run.id, requireIdentity(process.pid));
				expect(reclaimed.audience).toEqual(audienceFor(run, true, "decision-initial"));
				expect(
					reopened
						.events(run.id)
						.some(
							event =>
								typeof event.data === "object" &&
								event.data !== null &&
								Reflect.get(event.data, "decisionId") === "decision-initial",
						),
				).toBe(true);
			} finally {
				reopened.close();
			}
		});
	});

	test("no audience is invented without its recorded decision or for another objective", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);

			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.audience = audienceFor(run, true, "decision-1");
				}),
			).toThrow();
			expect(fixture.store.read(run.id).audience).toBeUndefined();
			expect(() =>
				fixture.store.update(
					run.id,
					{ epoch: claimed.epoch },
					draft => {
						draft.audience = {
							...audienceFor(run, true, "decision-1"),
							objectiveDigest: sha256("another objective"),
						};
					},
					[{ kind: "driver.recovery_decision", data: { decisionId: "decision-1" } }],
				),
			).toThrow();
			expect(() =>
				fixture.store.update(
					run.id,
					{ epoch: claimed.epoch },
					draft => {
						draft.audience = audienceFor(run, true, "decision-1");
					},
					[{ kind: "driver.recovery_decision", data: { decisionId: "decision-2" } }],
				),
			).toThrow();
			expect(fixture.store.read(run.id).audience).toBeUndefined();
			expect(
				fixture.store
					.events(run.id)
					.some(
						event =>
							typeof event.data === "object" &&
							event.data !== null &&
							Reflect.get(event.data, "decisionId") === "decision-1",
					),
			).toBe(false);
		});
	});

	test("a bound child cannot establish or change the audience", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const child = spawnScript(childWriteScript(), { JEV_STORE_FILE: fixture.file, JEV_DIR: fixture.dir }, true);
			const childIdentity = await detachedIdentity(child.pid);
			try {
				fixture.store.bindChild(run.id, claimed.epoch, childIdentity);
				const session = fixture.store.bindSession(run.id, claimed.epoch, {
					id: "audience-session",
					file: "local://audience.jsonl",
				});
				const access = { epoch: claimed.epoch, sessionId: "audience-session", generation: session.generation };
				const firstResult = join(fixture.dir, "audience-child-1.txt");
				writeFileSync(
					join(fixture.dir, "command.json"),
					JSON.stringify({
						run: run.id,
						access,
						result: firstResult,
						audience: audienceFor(run, true, "child-decision"),
						events: [{ kind: "driver.recovery_decision", data: { decisionId: "child-decision" } }],
					}),
				);
				expect(await waitForMarker(firstResult)).toContain("REJECTED:");
				expect(fixture.store.read(run.id).audience).toBeUndefined();

				establishAudience(fixture, run, claimed, false, "decision-initial");
				const secondResult = join(fixture.dir, "audience-child-2.txt");
				writeFileSync(
					join(fixture.dir, "command.json"),
					JSON.stringify({
						run: run.id,
						access,
						result: secondResult,
						audience: audienceFor(run, true, "decision-initial"),
					}),
				);
				expect(await waitForMarker(secondResult)).toContain("REJECTED:");
				expect(fixture.store.read(run.id).audience).toEqual(audienceFor(run, false, "decision-initial"));
			} finally {
				await stopDetached(child, childIdentity.group);
			}
		});
	});

	test("a stored audience whose decision was never journaled is rejected on reload", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			rewriteRunBody(fixture, run.id, body => {
				body.audience = { external: true, objectiveDigest: sha256(run.objective), decisionId: "forged" };
			});
			expect(() => fixture.store.read(run.id)).toThrow();
			expect(() => fixture.store.list()).toThrow();
		});
	});
});

describe("transactional updates and artifacts", () => {
	test("a supervisor transition commits checkpoint, events and exact bytes together", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const bytes = new Uint8Array([0, 1, 2, 250]);
			const updated = fixture.store.update(
				run.id,
				{ epoch: claimed.epoch },
				draft => {
					draft.status = "running";
					draft.checkpoint.refusedCalls.set("architecture", 1);
					draft.checkpoint.checkPending = {};
				},
				[
					{ kind: "decision", data: { approved: true } },
					{ kind: "invocation", data: { intent: "i-1" } },
				],
				{ "local://bytes.bin": bytes },
			);

			expect(updated.checkpoint.refusedCalls.get("architecture")).toBe(1);
			expect(updated.checkpoint.checkPending).toBeUndefined();
			expect(updated.sequence).toBe(claimed.sequence + 2);
			expect(updated.artifacts["local://bytes.bin"]).toBe(createHash("sha256").update(bytes).digest("hex"));
			expect([...(fixture.store.artifact(run.id, "local://bytes.bin") ?? [])]).toEqual([...bytes]);
			expect(fixture.store.events(run.id).slice(-2)).toEqual([
				{ sequence: updated.sequence - 1, kind: "decision", data: { approved: true } },
				{ sequence: updated.sequence, kind: "invocation", data: { intent: "i-1" } },
			]);
		});
	});

	test("a mutator failure rolls back the checkpoint, event and blob", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const bytes = new TextEncoder().encode("rolled back bytes");

			expect(() => fixture.store.update(run.id, { epoch: claimed.epoch }, () => {
				throw new Error("mutator failed");
			})).toThrow(/mutator failed/);
			expect(() =>
				fixture.store.update(
					run.id,
					{ epoch: claimed.epoch },
					draft => {
						draft.status = "waiting";
					},
					[{ kind: "", data: {} }],
					{ "local://rolled-back.txt": bytes },
				),
			).toThrow(/kind/);

			const after = fixture.store.read(run.id);
			expect(after.status).toBe("ready");
			expect(after.sequence).toBe(claimed.sequence);
			expect(after.artifacts["local://rolled-back.txt"]).toBeUndefined();
			const raw = new Database(fixture.file, { strict: true });
			try {
				const row = raw.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM blobs").get();
				expect(row?.count).toBe(0);
			} finally {
				raw.close();
			}
		});
	});

	test("a promise-returning mutator is rejected and changes nothing", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);

			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, async draft => {
					draft.status = "waiting";
				}),
			).toThrow(/synchronous/);
			expect(fixture.store.read(run.id).status).toBe("ready");
		});
	});

	test("identity, policy, epoch and resource limits cannot be overwritten by a mutator", async () => {
		await inFixture(async fixture => {
			const run = create(fixture, { maxJudgeCalls: 2, maxContextBytes: 1024, maxArtifactBytes: 8 });
			const claimed = claim(fixture.store, run.id);

			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.objective = "another objective";
				}),
			).toThrow(/objective/);
			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.policy.maxJudgeCalls = 999;
				}),
			).toThrow(/policy/);
			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					if (draft.owner !== undefined) draft.owner.pid += 1;
				}),
			).toThrow(/owner/);
			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch + 1 }, draft => {
					draft.status = "waiting";
				}),
			).toThrow(/epoch/);
			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.judgeCalls = 3;
				}),
			).toThrow(/judge call/);
			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.checkpoint.actions.push({ tool: "write", target: "x", excerpt: "x".repeat(5000) });
				}),
			).toThrow(/context/);
			expect(() =>
				fixture.store.update(
					run.id,
					{ epoch: claimed.epoch },
					draft => {
						draft.status = "running";
					},
					[],
					{ "local://too-large.bin": new Uint8Array(9) },
				),
			).toThrow(/artifact limit/);
			expect(fixture.store.read(run.id).status).toBe("ready");
		});
	});

	test("missing and corrupt referenced blobs throw; an unknown alias is null", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const updated = fixture.store.update(
				run.id,
				{ epoch: claimed.epoch },
				draft => {
					draft.status = "running";
				},
				[],
				{ "local://kept.bin": new Uint8Array([1, 2, 3]) },
			);
			const digest = updated.artifacts["local://kept.bin"];
			if (digest === undefined) throw new Error("artifact alias absent");
			expect(fixture.store.artifact(run.id, "local://unknown.bin")).toBeNull();

			const raw = new Database(fixture.file, { strict: true });
			try {
				raw.query("UPDATE blobs SET bytes = ? WHERE digest = ?").run(new Uint8Array([9, 9]), digest);
			} finally {
				raw.close();
			}
			expect(() => fixture.store.artifact(run.id, "local://kept.bin")).toThrow(/corrupt/);

			const removing = new Database(fixture.file, { strict: true });
			try {
				removing.query("DELETE FROM blobs WHERE digest = ?").run(digest);
			} finally {
				removing.close();
			}
			expect(() => fixture.store.artifact(run.id, "local://kept.bin")).toThrow(/missing/);
		});
	});
});

describe("completion proof", () => {
	test("completion is refused until current business, architecture and completion approvals exist", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);

			expect(() =>
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.status = "completed";
				}),
			).toThrow(/completion is not proved/);
			expect(fixture.store.read(run.id).status).toBe("ready");

			const completed = fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
				draft.checkpoint.revision = 2;
				draft.checkpoint.completion = { revision: 2, label: "follows", approved: true, confidence: 0.9 };
				draft.checkpoint.acceptance = [
					{ aspect: "business", revision: 2, label: "serves", approved: true, confidence: 0.9 },
					{ aspect: "architecture", revision: 2, label: "fits", approved: true, confidence: 0.9 },
				];
				draft.status = "completed";
			});
			expect(completed.status).toBe("completed");
			expect(fixture.store.read(run.id).status).toBe("completed");
			expect(fixture.store.events(run.id).map(event => event.kind)).toEqual(["create", "claim"]);
			expect(() =>
				fixture.store.update(run.id, { epoch: completed.epoch }, draft => {
					draft.status = "running";
				}),
			).toThrow(/terminal/);
			expect(fixture.store.cancel(run.id, "late stop").status).toBe("completed");
			expect(() => claim(fixture.store, run.id)).toThrow(/terminal/);
		});
	});

	test("a hand-forged completed row is rejected on read", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const raw = new Database(fixture.file, { strict: true });
			try {
				const row = raw.query<{ body: string }, [string]>("SELECT body FROM runs WHERE id = ?").get(run.id);
				if (row === null) throw new Error("run row missing");
				const body: Record<string, unknown> = JSON.parse(row.body);
				body.status = "completed";
				const forged = JSON.stringify(body);
				raw.query("UPDATE runs SET body = ?, digest = ?, status = 'completed' WHERE id = ?").run(forged, sha256(forged), run.id);
			} finally {
				raw.close();
			}

			expect(() => fixture.store.read(run.id)).toThrow(/completion/);
		});
	});
});

describe("durable cancellation", () => {
	test("cancellation closes admission, clears a queued wake and keeps pending uncertainty", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const child = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const childIdentity = await detachedIdentity(child.pid);
			try {
				fixture.store.bindChild(run.id, claimed.epoch, childIdentity);
				const session = fixture.store.bindSession(run.id, claimed.epoch, {
					id: "session-1",
					file: "local://session-1.jsonl",
				});
				const before = fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.status = "waiting";
					draft.waiting = { kind: "judge", reason: "decision unavailable", attempts: 2 };
					draft.pending["intent-1"] = {
						id: "intent-1",
						kind: "tool",
						payload: { command: "write" },
						revision: 0,
						createdAt: Date.now(),
					};
					draft.wake = {
						id: "wake-1",
						epoch: claimed.epoch,
						generation: session.generation,
						sessionId: "session-1",
						status: "pending",
						deadline: Date.now() + 5000,
					};
				});
				const cancelled = fixture.store.cancel(run.id, "operator stop");

				expect(cancelled.status).toBe("cancelled");
				expect(cancelled.wake).toBeUndefined();
				expect(cancelled.waiting).toEqual(before.waiting);
				expect(Object.keys(cancelled.pending)).toEqual(["intent-1"]);
				expect(cancelled.sequence).toBe(before.sequence + 1);
				expect(fixture.store.events(run.id).at(-1)).toEqual({
					sequence: cancelled.sequence,
					kind: "cancel",
					data: { reason: "operator stop", pending: ["intent-1"] },
				});

				const again = fixture.store.cancel(run.id, "second stop");
				expect(again.sequence).toBe(cancelled.sequence);
				expect(() =>
					fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
						draft.status = "running";
					}),
				).toThrow(/terminal/);
			} finally {
				await stopDetached(child, childIdentity.group);
			}
		});
	});

	test("a storage failure propagates instead of reporting durable cancellation", async () => {
		const fixture = openFixture();
		try {
			const run = create(fixture);
			fixture.store.close();
			expect(() => fixture.store.cancel(run.id, "operator stop")).toThrow();
		} finally {
			fixture.store.close();
			rmSync(fixture.dir, { recursive: true, force: true });
		}
	});
});

describe("stored integrity", () => {
	test("a corrupted run body fails its checksum", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const raw = new Database(fixture.file, { strict: true });
			try {
				raw.query("UPDATE runs SET body = body || ' ' WHERE id = ?").run(run.id);
			} finally {
				raw.close();
			}
			expect(() => fixture.store.read(run.id)).toThrow(/checksum/);
		});
	});

	test("a corrupted event fails its checksum", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const raw = new Database(fixture.file, { strict: true });
			try {
				raw.query("UPDATE events SET data = ? WHERE run_id = ? AND sequence = 1").run('{"tampered":true}', run.id);
			} finally {
				raw.close();
			}
			expect(() => fixture.store.events(run.id)).toThrow(/checksum/);
		});
	});

	test("a missing schema table is refused on open", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-autonomy-schema-table-"));
		try {
			const file = join(dir, "autonomy.sqlite");
			const store = openAutonomyStore(file);
			store.close();
			const raw = new Database(file, { strict: true });
			try {
				raw.exec("DROP TABLE blobs");
			} finally {
				raw.close();
			}
			expect(() => openAutonomyStore(file)).toThrow(/not a table/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unsupported schema version is refused on open", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-autonomy-schema-"));
		try {
			const file = join(dir, "autonomy.sqlite");
			const store = openAutonomyStore(file);
			store.close();
			const raw = new Database(file, { strict: true });
			try {
				raw.exec("PRAGMA user_version = 9");
			} finally {
				raw.close();
			}
			expect(() => openAutonomyStore(file)).toThrow(/schema version/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("decision context lookup", () => {
	test("returns the original request named by the admitted decision digest", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const epoch = claim(fixture.store, run.id).epoch;
			const alpha = {
				target: "project/src/alpha.ts",
				referencedCode: [{ path: "project/src/alpha.ts", source: "export const ALPHA = 41;" }],
				task: "repair the alpha reporter",
			};
			const beta = {
				target: "project/src/beta.ts",
				referencedCode: [{ path: "project/src/beta.ts", source: "export const BETA = 7;" }],
				task: "repair the beta reporter",
			};
			const first = recordJudgeRequest(fixture, run.id, epoch, alpha);
			const second = recordJudgeRequest(fixture, run.id, epoch, beta);
			expect(first.digest).not.toBe(second.digest);
			expect(fixture.store.decisionContext(run.id, first.digest)).toEqual(alpha);
			const found = fixture.store.decisionContext(run.id, second.digest);
			expect(found).toEqual(beta);

			// The approval is a separate journal entry that carries the same request digest.
			fixture.store.update(run.id, { epoch }, () => {}, [
				{
					kind: "judge.result",
					data: {
						callId: null,
						requestDigest: first.digest,
						revision: 0,
						outcome: { ok: true },
						approval: { accepted: true },
					},
				},
			]);
			const original = fixture.store.decisionContext(run.id, first.digest);
			expect(original).toEqual(alpha);
			expect(Object.keys(original ?? {})).toEqual(Object.keys(alpha));
			expect(original?.approval).toBeUndefined();
		});
	});

	test("a different run or a different digest cannot reach the request", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const epoch = claim(fixture.store, run.id).epoch;
			const request = {
				target: "project/src/gamma.ts",
				referencedCode: [{ path: "project/src/gamma.ts", source: "export const GAMMA = 3;" }],
				task: "repair the gamma reporter",
			};
			const { digest } = recordJudgeRequest(fixture, run.id, epoch, request);
			const secondRoot = join(fixture.dir, "second");
			mkdirSync(secondRoot);
			const other = fixture.store.create("Build another reporter", policy(secondRoot));
			expect(fixture.store.decisionContext(run.id, sha256("no judged request"))).toBeNull();
			expect(fixture.store.decisionContext(other.id, digest)).toBeNull();
			expect(fixture.store.decisionContext(run.id, digest)).toEqual(request);
		});
	});

	test("a corrupted journal entry for the selected digest is refused", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const epoch = claim(fixture.store, run.id).epoch;
			const request = {
				target: "project/src/delta.ts",
				referencedCode: [{ path: "project/src/delta.ts", source: "export const DELTA = 9;" }],
				task: "repair the delta reporter",
			};
			const { digest, sequence } = recordJudgeRequest(fixture, run.id, epoch, request);
			const raw = new Database(fixture.file, { strict: true });
			try {
				raw.query(
					"UPDATE events SET data = json_set(data, '$.request.target', 'project/src/tampered.ts') WHERE run_id = ? AND sequence = ?",
				).run(run.id, sequence);
			} finally {
				raw.close();
			}
			expect(() => fixture.store.decisionContext(run.id, digest)).toThrow(/checksum/);
		});
	});

	test("an event whose stored digest does not match its request is refused", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const epoch = claim(fixture.store, run.id).epoch;
			const request = {
				target: "project/src/epsilon.ts",
				referencedCode: [{ path: "project/src/epsilon.ts", source: "export const EPSILON = 11;" }],
				task: "repair the epsilon reporter",
			};
			const { digest, sequence } = recordJudgeRequest(fixture, run.id, epoch, request);
			const forgedDigest = sha256(JSON.stringify({ ...request, target: "project/src/other.ts" }));
			const raw = new Database(fixture.file, { strict: true });
			try {
				const row = raw
					.query<{ data: string }, [string, number]>("SELECT data FROM events WHERE run_id = ? AND sequence = ?")
					.get(run.id, sequence);
				if (row === null) throw new Error("judge request event is missing");
				const data = JSON.parse(row.data) as Record<string, unknown>;
				data.requestDigest = forgedDigest;
				const serialized = JSON.stringify(data);
				raw.query("UPDATE events SET data = ?, digest = ? WHERE run_id = ? AND sequence = ?").run(
					serialized,
					sha256(`${sequence}\njudge.request\n${serialized}`),
					run.id,
					sequence,
				);
			} finally {
				raw.close();
			}
			expect(() => fixture.store.decisionContext(run.id, forgedDigest)).toThrow(/digest/);
			expect(fixture.store.decisionContext(run.id, digest)).toBeNull();
		});
	});

	test("an event beyond the run's committed sequence is refused", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const epoch = claim(fixture.store, run.id).epoch;
			const request = {
				target: "project/src/zeta.ts",
				referencedCode: [{ path: "project/src/zeta.ts", source: "export const ZETA = 13;" }],
				task: "repair the zeta reporter",
			};
			const { digest, sequence } = recordJudgeRequest(fixture, run.id, epoch, request);
			rewriteRunBody(fixture, run.id, body => {
				body.sequence = sequence - 1;
			});
			expect(() => fixture.store.decisionContext(run.id, digest)).toThrow(/sequence/);
		});
	});
});

describe("whole-scope binding", () => {
	test("bindScope requires the actual supervisor, the epoch and a real observation", async () => {
		await requireScopeCapability();
		await inFixture(async fixture => {
			const run = create(fixture);
			const spawned = await spawnScopedNative(run.id, 1, "/usr/bin/sleep", ["120"]);
			try {
				expect(() => fixture.store.bindScope(run.id, 0, spawned.scope)).toThrow(/supervisor/);
				const claimed = claim(fixture.store, run.id);
				expect(claimed.epoch).toBe(1);
				expect(() => fixture.store.bindScope(run.id, claimed.epoch + 1, spawned.scope)).toThrow(/epoch/);
				expect(() =>
					fixture.store.bindScope(run.id, claimed.epoch, {
						...spawned.scope,
						inode: String(Number(spawned.scope.inode) + 1),
					}),
				).toThrow(/inode/);

				const bound = fixture.store.bindScope(run.id, claimed.epoch, spawned.scope);
				expect(bound.scope).toEqual(spawned.scope);
				expect(bound.fences).toEqual([]);
				expect(fixture.store.events(run.id).at(-1)?.kind).toBe("scope-bound");

				const other = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
				const otherIdentity = await detachedIdentity(other.pid);
				try {
					expect(() => fixture.store.bindChild(run.id, claimed.epoch, otherIdentity)).toThrow(/member|child/);
				} finally {
					await stopDetached(other, otherIdentity.group);
				}

				const child = fixture.store.bindChild(run.id, claimed.epoch, spawned.identity);
				expect(child.child).toEqual(spawned.identity);
				const session = fixture.store.bindSession(run.id, claimed.epoch, {
					id: "scope-session",
					file: "local://scope-session.jsonl",
				});
				expect(session.generation).toBe(1);

				expect(() =>
					fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
						draft.scope = { ...spawned.scope, inode: "1" };
					}),
				).toThrow(/scope/);
				expect(() =>
					fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
						draft.fences.push({
							scope: spawned.scope,
							recordedEpoch: claimed.epoch,
							generation: 0,
							observedAt: Date.now(),
							intentIds: [],
						});
					}),
				).toThrow(/fences/);
			} finally {
				await releaseScopedNative(spawned);
			}
		});
	}, 60_000);

	test("a replacement scope is only bound after the old scope is physically quiescent", async () => {
		await requireScopeCapability();
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			let first: ScopedNative | undefined;
			let second: ScopedNative | undefined;
			try {
				const firstSpawned = await spawnScopedNative(run.id, claimed.epoch, "/usr/bin/sleep", ["120"]);
				first = firstSpawned;
				const secondSpawned = await spawnScopedNative(run.id, claimed.epoch, "/usr/bin/sleep", ["120"]);
				second = secondSpawned;
				fixture.store.bindScope(run.id, claimed.epoch, firstSpawned.scope);
				expect(() => fixture.store.bindScope(run.id, claimed.epoch, secondSpawned.scope)).toThrow(/executable work/);
				await fenceAutonomyScope(firstSpawned.scope);
				await waitForScopedUnitGone(firstSpawned.scope.unit);
				const replaced = fixture.store.bindScope(run.id, claimed.epoch, secondSpawned.scope);
				expect(replaced.scope).toEqual(secondSpawned.scope);
				expect(replaced.fences).toEqual([]);
			} finally {
				if (first !== undefined) await releaseScopedNative(first);
				if (second !== undefined) await releaseScopedNative(second);
			}
		});
	}, 60_000);

	test("recordFence proves quiescence, covers its scope's intents and is idempotent", async () => {
		await requireScopeCapability();
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const spawned = await spawnScopedNative(run.id, claimed.epoch, "/usr/bin/sleep", ["120"]);
			try {
				fixture.store.bindScope(run.id, claimed.epoch, spawned.scope);
				const withPending = fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.pending["intent-a"] = {
						id: "intent-a",
						kind: "tool",
						payload: { command: "write" },
						revision: 0,
						createdAt: Date.now(),
					};
					draft.pending["intent-b"] = {
						id: "intent-b",
						kind: "lifecycle",
						payload: {},
						revision: 0,
						createdAt: Date.now(),
					};
				});
				expect(() => fixture.store.recordFence(run.id, claimed.epoch, spawned.scope)).toThrow(/executable work/);
				await fenceAutonomyScope(spawned.scope);
				await waitForScopedUnitGone(spawned.scope.unit);
				expect(() =>
					fixture.store.recordFence(run.id, claimed.epoch, {
						...spawned.scope,
						invocationId: "0".repeat(32),
					}),
				).toThrow(/does not match/);

				const fenced = fixture.store.recordFence(run.id, claimed.epoch, spawned.scope);
				expect(fenced.fences).toHaveLength(1);
				const receipt = fenced.fences[0];
				expect(receipt?.intentIds).toEqual(["intent-a"]);
				expect(receipt?.recordedEpoch).toBe(claimed.epoch);
				expect(receipt?.generation).toBe(withPending.generation);
				expect(receipt?.scope).toEqual(spawned.scope);
				expect(fixture.store.events(run.id).at(-1)).toEqual({
					sequence: fenced.sequence,
					kind: "scope-fenced",
					data: receipt,
				});
				const again = fixture.store.recordFence(run.id, claimed.epoch, spawned.scope);
				expect(again.sequence).toBe(fenced.sequence);
				expect(again.fences).toHaveLength(1);

				fixture.store.close();
				const reopened = openAutonomyStore(fixture.file);
				try {
					const restored = reopened.read(run.id);
					expect(restored.fences).toHaveLength(1);
					expect(restored.fences[0]?.scope).toEqual(spawned.scope);
					expect(restored.scope).toEqual(spawned.scope);
				} finally {
					reopened.close();
				}
			} finally {
				await releaseScopedNative(spawned);
			}
		});
	}, 60_000);
});

describe("cancellation and root release", () => {
	test("cancellation holds roots while the scope runs and an operator proof records safely", async () => {
		await requireScopeCapability();
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const spawned = await spawnScopedNative(run.id, claimed.epoch, "/usr/bin/sleep", ["120"]);
			try {
				fixture.store.bindScope(run.id, claimed.epoch, spawned.scope);
				fixture.store.bindChild(run.id, claimed.epoch, spawned.identity);
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.pending["unknown-launch"] = {
						id: "unknown-launch",
						kind: "lifecycle",
						payload: { operation: "spawn", epoch: claimed.epoch, launch: spawned.launch },
						revision: 0,
						createdAt: Date.now(),
					};
				});
				const cancelled = fixture.store.cancel(run.id, "operator stop");
				expect(cancelled.status).toBe("cancelled");
				expect(() => fixture.store.create("overlap while live", policy(fixture.root))).toThrow(/overlapping/);

				await fenceAutonomyScope(spawned.scope);
				await waitForScopedUnitGone(spawned.scope.unit);
				const fenced = fixture.store.recordFence(run.id, cancelled.epoch, spawned.scope);
				expect(fenced.status).toBe("cancelled");
				expect(fenced.owner).toEqual(claimed.owner);
				expect(fenced.pending).toEqual(cancelled.pending);
				expect(fenced.generation).toBe(cancelled.generation);
				expect(fenced.fences[0]?.intentIds).toEqual(["unknown-launch"]);
				expect(processAlive(spawned.identity)).toBe(false);

				const reused = fixture.store.create("reused after proof", policy(fixture.root));
				expect(reused.policy.roots).toEqual([fixture.root]);
			} finally {
				await releaseScopedNative(spawned);
			}
		});
	}, 60_000);

	test("an older empty scope's proof never releases a newer pre-bind launch's root", async () => {
		await requireScopeCapability();
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const older = await spawnScopedNative(run.id, claimed.epoch, "/usr/bin/sleep", ["120"]);
			let newer: ScopedNative | undefined;
			try {
				fixture.store.bindScope(run.id, claimed.epoch, older.scope);
				const newerSpawn = await spawnScopedNative(run.id, claimed.epoch, "/usr/bin/sleep", ["120"]);
				newer = newerSpawn;
				fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.pending["tool-old"] = {
						id: "tool-old",
						kind: "tool",
						payload: { command: "write" },
						revision: 0,
						createdAt: Date.now(),
					};
					draft.pending["newer-launch"] = {
						id: "newer-launch",
						kind: "lifecycle",
						payload: { operation: "spawn", epoch: claimed.epoch, launch: newerSpawn.launch },
						revision: 0,
						createdAt: Date.now(),
					};
				});
				await fenceAutonomyScope(older.scope);
				await waitForScopedUnitGone(older.scope.unit);
				const cancelled = fixture.store.cancel(run.id, "operator stop");
				expect(() => fixture.store.create("overlap with newer launch", policy(fixture.root))).toThrow();

				// The older bound scope proves its own tool intent, and nothing else.
				const olderProof = fixture.store.recordFence(run.id, cancelled.epoch, older.scope);
				expect(olderProof.fences).toHaveLength(1);
				expect(olderProof.fences[0]?.intentIds).toEqual(["tool-old"]);
				expect(() => fixture.store.create("overlap after older proof", policy(fixture.root))).toThrow();

				// Only the newer launch's own receipt covers its intent and releases the root.
				await fenceAutonomyScope(newerSpawn.scope);
				await waitForScopedUnitGone(newerSpawn.scope.unit);
				const newerProof = fixture.store.recordFence(run.id, cancelled.epoch, newerSpawn.scope);
				expect(newerProof.fences).toHaveLength(2);
				expect(newerProof.fences[1]?.intentIds).toEqual(["newer-launch"]);
				const again = fixture.store.recordFence(run.id, cancelled.epoch, newerSpawn.scope);
				expect(again.sequence).toBe(newerProof.sequence);
				expect(again.fences).toHaveLength(2);
				expect(processAlive(newerSpawn.identity)).toBe(false);

				fixture.store.close();
				const reopened = openAutonomyStore(fixture.file);
				try {
					const restored = reopened.read(run.id);
					expect(restored.fences.map(fence => fence.intentIds)).toEqual([["tool-old"], ["newer-launch"]]);
					const reused = reopened.create("reused after both proofs", policy(fixture.root));
					expect(reused.policy.roots).toEqual([fixture.root]);
				} finally {
					reopened.close();
				}
			} finally {
				await releaseScopedNative(older);
				if (newer !== undefined) await releaseScopedNative(newer);
			}
		});
	}, 120_000);

	test("an infeasible terminal run records honest safety proof without changing status", async () => {
		await requireScopeCapability();
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const spawned = await spawnScopedNative(run.id, claimed.epoch, "/usr/bin/sleep", ["120"]);
			try {
				fixture.store.bindScope(run.id, claimed.epoch, spawned.scope);
				// The run is already terminal when the physical fence and its receipt are recorded.
				const infeasible = fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.status = "infeasible";
				});
				await fenceAutonomyScope(spawned.scope);
				await waitForScopedUnitGone(spawned.scope.unit);
				const acceptance = infeasible.checkpoint.acceptance;
				const sequenced = infeasible.sequence;

				const fenced = fixture.store.recordFence(run.id, infeasible.epoch, spawned.scope);
				expect(fenced.status).toBe("infeasible");
				expect(fenced.pending).toEqual(infeasible.pending);
				expect(fenced.checkpoint.acceptance).toEqual(acceptance);
				expect(fenced.fences).toHaveLength(1);
				expect(fenced.sequence).toBe(sequenced + 1);

				const reused = fixture.store.create("reused after infeasible proof", policy(fixture.root));
				expect(reused.policy.roots).toEqual([fixture.root]);

				fixture.store.close();
				const reopened = openAutonomyStore(fixture.file);
				try {
					const restored = reopened.read(run.id);
					expect(restored.fences).toHaveLength(1);
					expect(restored.status).toBe("infeasible");
				} finally {
					reopened.close();
				}
			} finally {
				await releaseScopedNative(spawned);
			}
		});
	}, 60_000);

	test("a completed terminal run records honest safety proof without changing status", async () => {
		await requireScopeCapability();
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const spawned = await spawnScopedNative(run.id, claimed.epoch, "/usr/bin/sleep", ["120"]);
			try {
				fixture.store.bindScope(run.id, claimed.epoch, spawned.scope);
				// Completion is already committed while the scope is still alive; the supervisor then
				// fences it and must still be able to record the safety receipt.
				const completed = fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
					draft.checkpoint.revision = 2;
					draft.checkpoint.completion = { revision: 2, label: "follows", approved: true, confidence: 0.9 };
					draft.checkpoint.acceptance = [
						{ aspect: "business", revision: 2, label: "serves", approved: true, confidence: 0.9 },
						{ aspect: "architecture", revision: 2, label: "fits", approved: true, confidence: 0.9 },
					];
					draft.status = "completed";
				});
				await fenceAutonomyScope(spawned.scope);
				await waitForScopedUnitGone(spawned.scope.unit);
				const acceptance = completed.checkpoint.acceptance;
				const fenced = fixture.store.recordFence(run.id, completed.epoch, spawned.scope);
				expect(fenced.status).toBe("completed");
				expect(fenced.pending).toEqual({});
				expect(fenced.checkpoint.acceptance).toEqual(acceptance);
				expect(fenced.fences).toHaveLength(1);

				const reused = fixture.store.create("reused after completed proof", policy(fixture.root));
				expect(reused.policy.roots).toEqual([fixture.root]);

				fixture.store.close();
				const reopened = openAutonomyStore(fixture.file);
				try {
					const restored = reopened.read(run.id);
					expect(restored.fences).toHaveLength(1);
					expect(restored.status).toBe("completed");
				} finally {
					reopened.close();
				}
			} finally {
				await releaseScopedNative(spawned);
			}
		});
	}, 60_000);

	test("unknown pre-bind launch uncertainty keeps the root held after cancellation", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			fixture.store.update(run.id, { epoch: claimed.epoch }, draft => {
				draft.pending["launch-unknown"] = {
					id: "launch-unknown",
					kind: "lifecycle",
					payload: { unit: "jevstice-unobserved.scope" },
					revision: 0,
					createdAt: Date.now(),
				};
			});
			fixture.store.cancel(run.id, "operator stop");
			expect(() => fixture.store.create("overlap with unknown launch", policy(fixture.root))).toThrow(/overlapping/);
		});
	});

	test("a cross-boot child identity is dead and does not hold a cancelled root", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			const claimed = claim(fixture.store, run.id);
			const child = spawnScript("void (async () => { await Bun.sleep(60000); })();", {}, true);
			const identity = await detachedIdentity(child.pid);
			try {
				fixture.store.bindChild(run.id, claimed.epoch, identity);
				fixture.store.cancel(run.id, "operator stop");
				expect(() => fixture.store.create("overlap with live child", policy(fixture.root))).toThrow(/overlapping/);

				// A real reboot would replace this kernel; the forged boot makes the stored child old.
				rewriteRunBody(fixture, run.id, body => {
					const stored = body.child as Record<string, unknown>;
					stored.bootId = OTHER_BOOT;
				});
				const restored = fixture.store.read(run.id);
				expect(restored.child?.bootId).toBe(OTHER_BOOT);
				expect(processAlive(restored.child ?? identity)).toBe(false);
				const reused = fixture.store.create("reused after boot change", policy(fixture.root));
				expect(reused.policy.roots).toEqual([fixture.root]);
			} finally {
				await stopDetached(child, identity.group);
			}
		});
	}, 60_000);
});

describe("stored scope integrity", () => {
	test("a malformed stored scope is rejected on read", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			rewriteRunBody(fixture, run.id, body => {
				body.scope = {
					runId: run.id,
					epoch: 0,
					unit: "jevstice-bad.scope",
					bootId: OTHER_BOOT,
					controlGroup: "/user.slice/x/jevstice-bad.scope",
					device: "1",
					inode: "2",
					invocationId: "not-an-id",
				};
			});
			expect(() => fixture.store.read(run.id)).toThrow(/invocation/);
		});
	});

	test("a malformed fence history is rejected on read", async () => {
		await inFixture(async fixture => {
			const run = create(fixture);
			rewriteRunBody(fixture, run.id, body => {
				body.fences = "not-an-array";
			});
			expect(() => fixture.store.read(run.id)).toThrow(/fences/);
		});
	});
});


