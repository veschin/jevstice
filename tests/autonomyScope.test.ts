import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processAlive, processIdentity, type ProcessIdentity } from "../autonomy/store.js";
import {
	assertAutonomyScope,
	autonomyBootId,
	autonomyScopeCommand,
	autonomyScopeEmpty,
	checkAutonomyScopeCapability,
	fenceAutonomyScope,
	makeAutonomyScopeLaunch,
	observeAutonomyScope,
	type AutonomyScope,
	type AutonomyScopeLaunch,
} from "../autonomy/scope.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const OTHER_BOOT = "00000000-0000-4000-8000-000000000001";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requireIdentity(pid: number): ProcessIdentity {
	const identity = processIdentity(pid);
	if (identity === null) throw new Error(`no native identity for process ${pid}`);
	return identity;
}

interface ScopedHandle {
	child: { exited: Promise<number> };
	identity: ProcessIdentity;
	scope: AutonomyScope;
}

/** Require the real installed mechanisms; a missing capability is a test failure, never a skip. */
async function requireCapability(): Promise<void> {
	try {
		await checkAutonomyScopeCapability();
	} catch (error) {
		throw new Error(`this host cannot provide whole-scope containment: ${errorText(error)}`);
	}
}

/**
 * Spawn one native program inside a real user scope. The wrapper exec's the program in place, so the
 * spawned pid is the program's pid; observation is retried until the manager reports the live unit.
 * A failed startup is cleaned up before the error escapes, so no owned unit or process is leaked.
 */
async function spawnScoped(
	launch: AutonomyScopeLaunch,
	command: string,
	args: string[],
	options: { awaitExit?: boolean } = {},
): Promise<ScopedHandle & { launch: AutonomyScopeLaunch }> {
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
	if (options.awaitExit === true) await child.exited;
	const started = Date.now();
	let scope: AutonomyScope | undefined;
	let failure: unknown;
	while (scope === undefined) {
		try {
			scope = await observeAutonomyScope(launch, requireIdentity(child.pid));
		} catch (error) {
			if (child.exitCode !== null) {
				failure = new Error(`scoped process exited before observation: ${errorText(error)}`);
				break;
			}
			if (Date.now() - started > 20_000) {
				failure = error;
				break;
			}
			await Bun.sleep(50);
		}
	}
	if (scope === undefined) {
		const problem = await cleanupScopeStartup(launch, child, identity);
		if (problem !== undefined) {
			throw new Error(`scoped startup failed (${errorText(failure)}); cleanup failed: ${problem}`);
		}
		throw failure;
	}
	let observedIdentity: ProcessIdentity;
	try {
		observedIdentity = requireIdentity(child.pid);
	} catch (error) {
		const problem = await cleanupScopeStartup(launch, child, identity);
		if (problem !== undefined) {
			throw new Error(`scoped identity vanished after observation (${errorText(error)}); cleanup failed: ${problem}`);
		}
		throw error;
	}
	return { child, identity: observedIdentity, scope, launch };
}

function unitLoadState(unit: string): string {
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
 * Failed-startup cleanup addresses only the unique precommitted unit and the exact spawned identity.
 * It reports a problem instead of pretending the leak is gone.
 */
async function cleanupScopeStartup(
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
		if (unitLoadState(launch.unit) === "not-found") return undefined;
		await Bun.sleep(50);
	}
	return `unit ${launch.unit} is still ${unitLoadState(launch.unit)}`;
}

/**
 * A fenced scope's unit and cgroup disappear asynchronously. Poll the real manager and kernel until
 * the unit is gone and the recorded scope is positively empty; transient "cgroup gone, unit still
 * loaded" is retried rather than treated as either success or a hard failure.
 */
async function waitForScopeGone(scope: AutonomyScope, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (unitLoadState(scope.unit) === "not-found") {
			try {
				if (autonomyScopeEmpty(scope)) return;
			} catch {
				// The unit is still unloading; the next poll re-checks the real state.
			}
		}
		await Bun.sleep(20);
	}
	throw new Error(`scope ${scope.unit} did not become provably absent`);
}

/** Final cleanup only: fence the scope, then kill the exact observed identity while it is still live. */
async function releaseScoped(spawned: ScopedHandle): Promise<void> {
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

function detachedGrandchildScript(pidFile: string): string {
	return `
void (async () => {
	const fs = await import("node:fs");
	const child = Bun.spawn(["/usr/bin/sleep", "300"], { detached: true, stdout: "ignore", stderr: "ignore" });
	fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
	setInterval(() => {}, 1000);
})();
`;
}

/** Detach genuine work and exit immediately, leaving the scope's own process gone. */
function exitWithDetachedChildScript(pidFile: string): string {
	return `
void (async () => {
	const fs = await import("node:fs");
	const child = Bun.spawn(["/usr/bin/sleep", "300"], { detached: true, stdout: "ignore", stderr: "ignore" });
	fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
	process.exit(0);
})();
`;
}

async function waitForPid(file: string, timeoutMs = 20_000): Promise<number> {
	const started = Date.now();
	while (true) {
		if (existsSync(file)) {
			const value = readFileSync(file, "utf8").trim();
			if (value !== "") {
				const pid = Number(value);
				if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid in ${file}`);
				return pid;
			}
		}
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${file}`);
		await Bun.sleep(20);
	}
}

describe("kernel boot identity", () => {
	test("the boot id is one stable canonical kernel UUID shared by process identities", () => {
		const first = autonomyBootId();
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(autonomyBootId()).toBe(first);
		const identity = requireIdentity(process.pid);
		expect(identity.bootId).toBe(first);
		expect(processAlive(identity)).toBe(true);
		expect(processAlive({ ...identity, bootId: OTHER_BOOT })).toBe(false);
	});
});

describe("scope launch and capability", () => {
	test("the exact command argv is built without a shell and bad input is refused", () => {
		const launch = makeAutonomyScopeLaunch("run-command", 0);

		expect(launch.runId).toBe("run-command");
		expect(launch.epoch).toBe(0);
		expect(launch.bootId).toBe(autonomyBootId());
		expect(launch.unit).toMatch(/^jevstice-run-command-0-[0-9a-f]{8}\.scope$/);
		expect(autonomyScopeCommand(launch, "/usr/bin/sleep", ["5"])).toEqual([
			"systemd-run",
			"--user",
			"--scope",
			"--quiet",
			`--unit=${launch.unit}`,
			"/usr/bin/sleep",
			"5",
		]);
		expect(() => makeAutonomyScopeLaunch("../escape", 0)).toThrow(/run identifier/);
		expect(() => makeAutonomyScopeLaunch("run", -1)).toThrow(/epoch/);
		expect(() => autonomyScopeCommand({ ...launch, bootId: OTHER_BOOT }, "/usr/bin/sleep", [])).toThrow(/boot/);
		expect(() => autonomyScopeCommand(launch, "/usr/bin/sleep", ["a\0b"])).toThrow(/NUL/);
		expect(() => autonomyScopeCommand(launch, "", [])).toThrow(/executable/);
	});

	test("the installed capability either resolves or reports an explicit refusal", async () => {
		const error = await checkAutonomyScopeCapability().then(
			() => undefined,
			(caught: unknown) => caught,
		);
		if (error !== undefined) {
			expect(errorText(error)).toMatch(/whole-scope containment requires|does not answer|cannot address/);
		}
	});

	test("a missing executable or user bus is refused with no process-group fallback", async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "jev-scope-path-")));
		const originalPath = process.env.PATH;
		const originalRuntime = process.env.XDG_RUNTIME_DIR;
		try {
			process.env.PATH = directory;
			process.env.XDG_RUNTIME_DIR = directory;
			const error = await checkAutonomyScopeCapability().then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(Error);
			expect(errorText(error)).toMatch(/whole-scope containment requires/);
		} finally {
			process.env.PATH = originalPath;
			if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = originalRuntime;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("real scope observation and fencing", () => {
	test("the whole execution is contained and fencing kills a detached native group", async () => {
		await requireCapability();
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "jev-scope-real-")));
		const pidFile = join(directory, "grandchild.pid");
		// The spawned program must create a genuine native detached process, not a shell builtin.
		const launch = makeAutonomyScopeLaunch(`real-${Date.now()}`, 1);
		const spawned = await spawnScoped(launch, process.execPath, ["-e", detachedGrandchildScript(pidFile)]);
		try {
			expect(spawned.scope.unit).toBe(launch.unit);
			expect(spawned.scope.bootId).toBe(autonomyBootId());
			expect(spawned.scope.controlGroup.startsWith("/user.slice/")).toBe(true);
			expect(spawned.scope.controlGroup.endsWith(`/${launch.unit}`)).toBe(true);
			expect(spawned.scope.invocationId).toMatch(/^[0-9a-f]{32}$/);
			expect(spawned.scope.device).toMatch(/^\d+$/);
			expect(spawned.scope.inode).toMatch(/^\d+$/);
			// Kernel and manager state are real; polling is the only way to await them.
			const grandchildPid = await waitForPid(pidFile);
			const grandchild = requireIdentity(grandchildPid);
			expect(grandchild.group).toBe(grandchildPid);
			expect(grandchild.group).not.toBe(spawned.identity.group);
			expect(processAlive(grandchild)).toBe(true);
			assertAutonomyScope(spawned.scope, spawned.identity);
			assertAutonomyScope(spawned.scope, grandchild);
			expect(() => assertAutonomyScope(spawned.scope, requireIdentity(process.pid))).toThrow(/member/);
			expect(autonomyScopeEmpty(spawned.scope)).toBe(false);

			const receipt = await fenceAutonomyScope(spawned.scope);
			expect(receipt.scope).toEqual(spawned.scope);
			expect(receipt.method).toBe("systemd-scope");
			expect(receipt.empty).toBe(true);
			expect(receipt.observedAt).toBeGreaterThan(0);
			// The real unit and cgroup disappear asynchronously after the fence; poll the real
			// manager and kernel until the recorded identity is provably absent.
			await waitForScopeGone(spawned.scope);
			expect(autonomyScopeEmpty(spawned.scope)).toBe(true);
			expect(processAlive(spawned.identity)).toBe(false);
			expect(processAlive(grandchild)).toBe(false);
		} finally {
			await releaseScoped(spawned);
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	test("a failed scope startup kills the launched unit and its detached work", async () => {
		await requireCapability();
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "jev-scope-cleanup-")));
		const pidFile = join(directory, "grandchild.pid");
		const launch = makeAutonomyScopeLaunch(`cleanup-${Date.now()}`, 1);
		try {
			const failure = await spawnScoped(launch, process.execPath, ["-e", exitWithDetachedChildScript(pidFile)], {
				awaitExit: true,
			}).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(failure).toBeInstanceOf(Error);
			const grandchildPid = await waitForPid(pidFile);
			// The kernel and the user manager are the only clock for real cleanup; polling is the wait.
			const started = Date.now();
			while (processIdentity(grandchildPid) !== null) {
				if (Date.now() - started > 10_000) throw new Error("detached work survived failed startup cleanup");
				await Bun.sleep(20);
			}
			expect(unitLoadState(launch.unit)).toBe("not-found");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	test("fencing an already quiescent unloaded scope returns its proven receipt", async () => {
		await requireCapability();
		const launch = makeAutonomyScopeLaunch(`enoent-${Date.now()}`, 1);
		const spawned = await spawnScoped(launch, "/usr/bin/sleep", ["120"]);
		try {
			const first = await fenceAutonomyScope(spawned.scope);
			expect(first.empty).toBe(true);
			// The unit and its cgroup disappear asynchronously after the first fence. A second
			// physical fence of the same bound scope must be a no-op proof, not an ENOENT throw.
			await waitForScopeGone(spawned.scope);
			expect(autonomyScopeEmpty(spawned.scope)).toBe(true);
			const again = await fenceAutonomyScope(spawned.scope);
			expect(again.scope).toEqual(spawned.scope);
			expect(again.empty).toBe(true);
			expect(again.method).toBe("systemd-scope");
		} finally {
			await releaseScoped(spawned);
		}
	}, 60_000);

	test("a boot, identity, membership or metadata mismatch is refused", async () => {
		await requireCapability();
		const launch = makeAutonomyScopeLaunch(`mismatch-${Date.now()}`, 1);
		const spawned = await spawnScoped(launch, "/usr/bin/sleep", ["120"]);
		try {
			expect(autonomyScopeEmpty({ ...spawned.scope, bootId: OTHER_BOOT })).toBe(true);
			expect(() => assertAutonomyScope({ ...spawned.scope, bootId: OTHER_BOOT })).toThrow(/boot/);
			expect(() => assertAutonomyScope({ ...spawned.scope, inode: String(Number(spawned.scope.inode) + 1) })).toThrow(
				/inode/,
			);
			expect(() => assertAutonomyScope({ ...spawned.scope, invocationId: "not-an-id" })).toThrow(/invocation/);
			expect(() =>
				assertAutonomyScope({
					...spawned.scope,
					controlGroup: spawned.scope.controlGroup.replace(launch.unit, "jevstice-other.scope"),
				}),
			).toThrow();
			expect(() => assertAutonomyScope(spawned.scope, { ...spawned.identity, start: "0" })).toThrow(/live process/);
			expect(() => assertAutonomyScope(spawned.scope, { ...spawned.identity, bootId: OTHER_BOOT })).toThrow(/boot/);
			expect(() => fenceAutonomyScope({ ...spawned.scope, bootId: OTHER_BOOT })).toThrow(/boot/);
			expect(processAlive(spawned.identity)).toBe(true);
		} finally {
			await releaseScoped(spawned);
		}
	}, 60_000);
});

