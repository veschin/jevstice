/**
 * Whole-executor containment for autonomous runs.
 *
 * A native child that creates its own process group survives the death of the Bun supervisor's
 * group, so group signalling cannot prove or enforce that autonomous work stopped. This module
 * describes and inspects one real transient user-manager scope instead: the scope's cgroup is the
 * containment identity, and only that bound scope may ever be signalled.
 *
 * Identity comes from the live kernel and the actual user manager (`systemctl show`), never from an
 * environment variable or a unit name alone. Missing capability, unreadable metadata, a boot
 * mismatch or an unproved absence is an explicit error, never a fallback to process groups.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { ProcessIdentity } from "./store.js";

/** The lifecycle identity committed before a scope is spawned. It is metadata, not authority. */
export interface AutonomyScopeLaunch {
	runId: string;
	epoch: number;
	unit: string;
	bootId: string;
}

/** The observed cgroupv2 identity of one real user scope, including the kernel boot. */
export interface AutonomyScope extends AutonomyScopeLaunch {
	controlGroup: string;
	device: string;
	inode: string;
	invocationId: string;
}

/** A durable safety-only receipt for one observed scope. It covers exactly that scope's intents and claims no outcome. */
export interface AutonomyScopeFence {
	scope: AutonomyScope;
	recordedEpoch: number;
	generation: number;
	observedAt: number;
	intentIds: string[];
}

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVOCATION_ID = /^[0-9a-f]{32}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const UNIT = /^jevstice-[A-Za-z0-9][A-Za-z0-9_.-]*\.scope$/;
const CGROUP_ROOT = "/sys/fs/cgroup";
const KILL_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 10_000;
const FENCE_POLL_MS = 50;
// A transient --scope unit is not a service and has no meaningful service MainPID; the container
// identity is the unit's control group, checked against the live process's own cgroup below.
const SHOWN_PROPERTIES = "LoadState,ActiveState,ControlGroup,KillMode,InvocationID";

let cachedBootId: string | undefined;

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code: unknown = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${what} must be an object`);
	}
	return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string`);
	return value;
}

function integer(value: unknown, what: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${what} must be an integer of at least ${minimum}`);
	}
	return value;
}

/**
 * The kernel boot UUID of this running kernel. It is read once and never changes for the lifetime of
 * the process, so a later identity comparison cannot silently disagree with an earlier one.
 */
export function autonomyBootId(): string {
	if (cachedBootId !== undefined) return cachedBootId;
	let raw: string;
	try {
		raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch (error) {
		throw new Error(`cannot read the kernel boot id: ${errorText(error)}`);
	}
	if (!BOOT_ID.test(raw)) throw new Error("the kernel boot id is not a canonical UUID");
	cachedBootId = raw;
	return raw;
}

function validateUnit(unit: string, what: string): string {
	if (!UNIT.test(unit)) throw new Error(`${what} is not an owned jevstice scope unit`);
	if (unit.length > 255) throw new Error(`${what} is too long for a unit name`);
	return unit;
}

function validateLaunch(value: AutonomyScopeLaunch, what: string): AutonomyScopeLaunch {
	const source = record(value, what);
	const runId = nonEmpty(source.runId, `${what}.runId`);
	if (!RUN_ID.test(runId)) throw new Error(`${what}.runId is not a safe run identifier`);
	const epoch = integer(source.epoch, `${what}.epoch`, 0);
	const unit = validateUnit(nonEmpty(source.unit, `${what}.unit`), `${what}.unit`);
	const bootId = nonEmpty(source.bootId, `${what}.bootId`);
	if (!BOOT_ID.test(bootId)) throw new Error(`${what}.bootId is not a canonical kernel UUID`);
	return { runId, epoch, unit, bootId };
}

function assertOwnedControlGroup(controlGroup: string, unit: string, what: string): string {
	if (
		!controlGroup.startsWith("/") ||
		controlGroup.includes("\n") ||
		controlGroup.includes("\0") ||
		controlGroup === "/" ||
		!controlGroup.startsWith("/user.slice/") ||
		!controlGroup.endsWith(`/${unit}`)
	) {
		throw new Error(`${what} is not the user-slice cgroup of ${unit}`);
	}
	if (controlGroup.split("/").some(segment => segment === "." || segment === "..")) {
		throw new Error(`${what} is not a simple cgroup path`);
	}
	return controlGroup;
}

function validateScope(value: AutonomyScope, what: string): AutonomyScope {
	const source = record(value, what);
	const launch = validateLaunch(source as unknown as AutonomyScopeLaunch, what);
	const controlGroup = assertOwnedControlGroup(
		nonEmpty(source.controlGroup, `${what}.controlGroup`),
		launch.unit,
		`${what}.controlGroup`,
	);
	const device = nonEmpty(source.device, `${what}.device`);
	const inode = nonEmpty(source.inode, `${what}.inode`);
	if (!/^\d+$/.test(device)) throw new Error(`${what}.device is not a device number`);
	if (!/^\d+$/.test(inode)) throw new Error(`${what}.inode is not an inode number`);
	const invocationId = nonEmpty(source.invocationId, `${what}.invocationId`);
	if (!INVOCATION_ID.test(invocationId)) throw new Error(`${what}.invocationId is not a systemd invocation id`);
	return { ...launch, controlGroup, device, inode, invocationId };
}

/**
 * Precommit the exact lifecycle identity of a future scope. The unit name is unique per run, epoch
 * and random segment, so a later observation can never be satisfied by an unrelated reused unit.
 */
export function makeAutonomyScopeLaunch(runId: string, epoch: number): AutonomyScopeLaunch {
	const launch = validateLaunch(
		{ runId, epoch, unit: "jevstice-placeholder.scope", bootId: autonomyBootId() },
		"scope launch",
	);
	const segment = randomUUID().split("-")[0] ?? "";
	const unit = validateUnit(`jevstice-${launch.runId}-${launch.epoch}-${segment}.scope`, "scope launch.unit");
	return { runId: launch.runId, epoch: launch.epoch, unit, bootId: launch.bootId };
}

/** The complete real `systemd-run` argv. Arguments are passed as argv, never through a shell. */
export function autonomyScopeCommand(launch: AutonomyScopeLaunch, command: string, args: string[]): string[] {
	const validated = validateLaunch(launch, "scope launch");
	if (validated.bootId !== autonomyBootId()) throw new Error("scope launch belongs to a different kernel boot");
	if (typeof command !== "string" || command.trim() === "" || command.includes("\0")) {
		throw new Error("scope command must be a non-empty executable path");
	}
	if (!Array.isArray(args)) throw new Error("scope command arguments must be an array");
	for (const [index, argument] of args.entries()) {
		if (typeof argument !== "string" || argument.includes("\0")) {
			throw new Error(`scope command argument ${index} must be a string without NUL bytes`);
		}
	}
	return ["systemd-run", "--user", "--scope", "--quiet", `--unit=${validated.unit}`, command, ...args];
}

function requireTool(name: string): string {
	const found = Bun.which(name);
	if (found === null) throw new Error(`whole-scope containment requires the ${name} executable`);
	return found;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

function spawnBounded(command: string, args: string[]) {
	try {
		return Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	} catch (error) {
		throw new Error(`cannot execute ${command}: ${errorText(error)}`);
	}
}

/** Run one bounded command. A timeout kills the process and throws; it never looks like success. */
async function runBounded(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
	const child = spawnBounded(command, args);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			child.kill("SIGKILL");
		} catch {
			// The child already exited; the timeout is still recorded below.
		}
	}, timeoutMs);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (timedOut) throw new Error(`${command} did not answer within ${timeoutMs}ms`);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

/** Verify the actual installed mechanisms this module needs. It installs and changes nothing. */
export async function checkAutonomyScopeCapability(): Promise<void> {
	if (process.platform !== "linux") throw new Error("whole-scope containment requires Linux cgroup v2");
	let controllers: string;
	try {
		controllers = readFileSync(join(CGROUP_ROOT, "cgroup.controllers"), "utf8");
	} catch (error) {
		throw new Error(`whole-scope containment requires the cgroup v2 unified hierarchy: ${errorText(error)}`);
	}
	if (controllers.trim() === "") throw new Error("the cgroup v2 hierarchy does not expose controllers");
	try {
		if (!statSync("/run/systemd/system").isDirectory()) {
			throw new Error("the systemd runtime directory is not a directory");
		}
	} catch (error) {
		throw new Error(`whole-scope containment requires a running systemd user manager: ${errorText(error)}`);
	}
	requireTool("systemd-run");
	const systemctl = requireTool("systemctl");
	const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
	const bus =
		runtimeDirectory !== undefined && runtimeDirectory.trim() !== ""
			? join(runtimeDirectory, "bus")
			: `/run/user/${process.getuid?.() ?? ""}/bus`;
	let busSocket = false;
	try {
		busSocket = statSync(bus).isSocket();
	} catch {
		busSocket = false;
	}
	if (!busSocket) throw new Error(`whole-scope containment requires the user manager bus at ${bus}`);
	const version = await runBounded(systemctl, ["--user", "show", "--property=Version", "--value"], QUERY_TIMEOUT_MS);
	if (version.code !== 0 || version.stdout.trim() === "") {
		throw new Error(`the systemd user manager does not answer: ${version.stderr.trim() || `exit ${version.code}`}`);
	}
	const help = await runBounded(systemctl, ["--help"], QUERY_TIMEOUT_MS);
	if (help.code !== 0 || !help.stdout.includes("--kill-whom")) {
		throw new Error("the installed systemctl cannot address the whole scope when killing");
	}
}

interface NativeStat {
	state: string;
	parent: number;
	group: number;
	start: string;
}

function readNativeStat(pid: number): NativeStat | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid process id ${pid}`);
	let text: string;
	try {
		text = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw new Error(`cannot observe process ${pid}: ${errorText(error)}`);
	}
	const close = text.lastIndexOf(")");
	if (close < 0) throw new Error(`process ${pid} has an unreadable stat record`);
	const fields = text.slice(close + 1).trim().split(/\s+/);
	const state = fields[0];
	const parent = fields[1];
	const group = fields[2];
	const start = fields[19];
	if (state === undefined || parent === undefined || group === undefined || start === undefined) {
		throw new Error(`process ${pid} has an incomplete stat record`);
	}
	const parentId = Number(parent);
	const groupId = Number(group);
	if (!Number.isSafeInteger(parentId) || parentId < 0) throw new Error(`process ${pid} has an invalid parent`);
	if (!Number.isSafeInteger(groupId) || groupId < 0) throw new Error(`process ${pid} has an invalid group`);
	if (!/^\d+$/.test(start)) throw new Error(`process ${pid} has an invalid start time`);
	return { state, parent: parentId, group: groupId, start };
}

function nativeIdentity(pid: number): ProcessIdentity {
	const stat = readNativeStat(pid);
	if (stat === null) throw new Error(`process ${pid} does not exist`);
	if (stat.group === 0) throw new Error(`process ${pid} is outside a signalable process group`);
	return { pid, start: stat.start, group: stat.group, parent: stat.parent, bootId: autonomyBootId() };
}

function sameNativeIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.start === right.start &&
		left.group === right.group &&
		left.parent === right.parent &&
		left.bootId === right.bootId
	);
}

/** The exact unified cgroup of `pid`. Any unreadable or non-unified state throws. */
function cgroupOf(pid: number): string {
	let text: string;
	try {
		text = readFileSync(`/proc/${pid}/cgroup`, "utf8");
	} catch (error) {
		throw new Error(`cannot observe the cgroup of process ${pid}: ${errorText(error)}`);
	}
	const lines = text.split("\n").filter(line => line.trim() !== "");
	if (lines.length !== 1) throw new Error(`process ${pid} is not in exactly one unified cgroup`);
	const line = lines[0] ?? "";
	if (!line.startsWith("0::")) throw new Error(`process ${pid} is not on the cgroup v2 unified hierarchy`);
	const path = line.slice("0::".length);
	if (path === "" || !path.startsWith("/")) throw new Error(`process ${pid} has an invalid cgroup path`);
	return path;
}

function parseProperties(output: string, what: string): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const line of output.split("\n")) {
		if (line === "") continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new Error(`${what} is not a property list`);
		const key = line.slice(0, separator);
		if (properties[key] !== undefined) throw new Error(`${what} repeats ${key}`);
		properties[key] = line.slice(separator + 1);
	}
	return properties;
}

async function showUnit(unit: string): Promise<Record<string, string>> {
	const systemctl = requireTool("systemctl");
	const result = await runBounded(
		systemctl,
		["--user", "show", `--property=${SHOWN_PROPERTIES}`, "--", unit],
		QUERY_TIMEOUT_MS,
	);
	if (result.code !== 0) {
		throw new Error(`cannot read unit ${unit}: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	return parseProperties(result.stdout, `systemd metadata for ${unit}`);
}

/** A synchronous LoadState query used only to judge an already-observed unit that disappeared. */
function syncLoadStateOf(unit: string): string {
	const systemctl = requireTool("systemctl");
	try {
		const result = Bun.spawnSync({
			cmd: [systemctl, "--user", "show", "--property=LoadState", "--", unit],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: QUERY_TIMEOUT_MS,
		});
		if (!result.success || result.exitCode !== 0) {
			const stderr = result.stderr.toString().trim();
			throw new Error(stderr || `exit ${result.exitCode}`);
		}
		const properties = parseProperties(result.stdout.toString(), `systemd metadata for ${unit}`);
		const state = properties.LoadState;
		if (state === undefined) throw new Error("systemd did not report LoadState");
		return state;
	} catch (error) {
		throw new Error(`cannot ask systemd about ${unit}: ${errorText(error)}`);
	}
}

/** The filesystem directory of a cgroup path; the kernel reports paths relative to the mount root. */
function cgroupDirectory(controlGroup: string): string {
	return join(CGROUP_ROOT, controlGroup);
}

function directoryIdentity(path: string): { device: string; inode: string } {
	const stat = statSync(path);
	if (!stat.isDirectory()) throw new Error(`${path} is not a cgroup directory`);
	return { device: String(stat.dev), inode: String(stat.ino) };
}

function cgroupHasExecutableProcesses(path: string): boolean {
	let entries: Dirent[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch (error) {
		throw new Error(`cannot read cgroup ${path}: ${errorText(error)}`);
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (cgroupHasExecutableProcesses(join(path, entry.name))) return true;
			continue;
		}
		if (entry.name !== "cgroup.procs" && entry.name !== "cgroup.threads") continue;
		let content: string;
		try {
			content = readFileSync(join(path, entry.name), "utf8");
		} catch (error) {
			throw new Error(`cannot read ${entry.name} of ${path}: ${errorText(error)}`);
		}
		for (const line of content.split("\n")) {
			const value = line.trim();
			if (value === "") continue;
			if (!/^\d+$/.test(value)) throw new Error(`${entry.name} of ${path} contains an invalid id`);
			const stat = readNativeStat(Number(value));
			if (stat !== null && stat.state !== "Z" && stat.state !== "X" && stat.state !== "x") return true;
		}
	}
	return false;
}

/**
 * Observe a real user scope and require that it is the actual whole-executor container of `process`.
 * Only values read from the kernel and the user manager are returned.
 */
export async function observeAutonomyScope(
	launch: AutonomyScopeLaunch,
	process: ProcessIdentity,
): Promise<AutonomyScope> {
	const validated = validateLaunch(launch, "scope launch");
	if (validated.bootId !== autonomyBootId()) throw new Error("scope launch belongs to a different kernel boot");
	if (process.bootId !== validated.bootId) throw new Error("process identity belongs to a different kernel boot");
	if (!sameNativeIdentity(nativeIdentity(process.pid), process)) {
		throw new Error("process identity is not the live process");
	}
	const properties = await showUnit(validated.unit);
	if (properties.LoadState !== "loaded") throw new Error(`scope ${validated.unit} is not loaded`);
	if (properties.ActiveState !== "active") throw new Error(`scope ${validated.unit} is not active`);
	if (properties.KillMode !== "control-group") {
		throw new Error(`scope ${validated.unit} does not kill its whole control group`);
	}
	const invocationId = properties.InvocationID ?? "";
	if (!INVOCATION_ID.test(invocationId)) throw new Error(`scope ${validated.unit} has no observed invocation identity`);
	const controlGroup = assertOwnedControlGroup(
		properties.ControlGroup ?? "",
		validated.unit,
		`scope ${validated.unit} control group`,
	);
	const observed = directoryIdentity(cgroupDirectory(controlGroup));
	// A transient scope has no service-style MainPID; membership in the unit's own unified cgroup
	// is the actual container proof, and detached descendants inherit it.
	if (cgroupOf(process.pid) !== controlGroup) {
		throw new Error(`process ${process.pid} is not a member of scope ${validated.unit}`);
	}
	if (!sameNativeIdentity(nativeIdentity(process.pid), process)) {
		throw new Error("process identity changed while its scope was observed");
	}
	return {
		runId: validated.runId,
		epoch: validated.epoch,
		unit: validated.unit,
		bootId: validated.bootId,
		controlGroup,
		device: observed.device,
		inode: observed.inode,
		invocationId,
	};
}

/**
 * Observe the committed unit of a launch without requiring its recorded leader to be live. A crash
 * between spawn and the child record, or a killed leader with detached descendants, still leaves a
 * real unit and cgroup whose exact identity can be fenced. Membership of a particular process is
 * deliberately not required: the unit name is unique per launch, and the cgroup is the container.
 */
export async function observeCommittedAutonomyScope(
	launch: AutonomyScopeLaunch,
): Promise<AutonomyScope> {
	const validated = validateLaunch(launch, "scope launch");
	if (validated.bootId !== autonomyBootId()) throw new Error("scope launch belongs to a different kernel boot");
	const properties = await showUnit(validated.unit);
	if (properties.LoadState !== "loaded") throw new Error(`scope ${validated.unit} is not loaded`);
	if (properties.ActiveState !== "active") throw new Error(`scope ${validated.unit} is not active`);
	if (properties.KillMode !== "control-group") {
		throw new Error(`scope ${validated.unit} does not kill its whole control group`);
	}
	const invocationId = properties.InvocationID ?? "";
	if (!INVOCATION_ID.test(invocationId)) throw new Error(`scope ${validated.unit} has no observed invocation identity`);
	const controlGroup = assertOwnedControlGroup(
		properties.ControlGroup ?? "",
		validated.unit,
		`scope ${validated.unit} control group`,
	);
	const observed = directoryIdentity(cgroupDirectory(controlGroup));
	return {
		runId: validated.runId,
		epoch: validated.epoch,
		unit: validated.unit,
		bootId: validated.bootId,
		controlGroup,
		device: observed.device,
		inode: observed.inode,
		invocationId,
	};
}

/**
 * A launch whose unit was never observed is provably quiescent only in its own kernel boot and only
 * when the manager positively reports it absent. Anything else stays unproved; a different boot is
 * handled by the caller as a local-only boot difference, never as a remote fence.
 */
export function autonomyLaunchUnloaded(launch: AutonomyScopeLaunch): boolean {
	const validated = validateLaunch(launch, "scope launch");
	if (validated.bootId !== autonomyBootId()) return false;
	return syncLoadStateOf(validated.unit) === "not-found";
}

/**
 * Synchronous admission check for a recorded scope, optionally including one process's real
 * membership. Any unreadable or mismatched state throws; nothing is inferred from the environment.
 */
export function assertAutonomyScope(scope: AutonomyScope, process?: ProcessIdentity): void {
	const validated = validateScope(scope, "scope");
	if (validated.bootId !== autonomyBootId()) throw new Error("scope belongs to a different kernel boot");
	const observed = directoryIdentity(cgroupDirectory(validated.controlGroup));
	if (observed.device !== validated.device) throw new Error("scope control group device does not match");
	if (observed.inode !== validated.inode) throw new Error("scope control group inode does not match");
	if (process === undefined) return;
	if (process.bootId !== validated.bootId) throw new Error("process identity belongs to a different kernel boot");
	const live = nativeIdentity(process.pid);
	if (!sameNativeIdentity(live, process)) throw new Error("process identity is not the live process");
	if (cgroupOf(process.pid) !== validated.controlGroup) {
		throw new Error(`process ${process.pid} is not a member of the bound scope`);
	}
}

/**
 * Positive whole-scope quiescence, including every nested cgroup. A different observed kernel boot
 * proves the old scope's processes are dead and is answered without any signal; an absent cgroup is
 * accepted only when the observed unit is actually gone, never for an arbitrary name.
 */
export function autonomyScopeEmpty(scope: AutonomyScope): boolean {
	const validated = validateScope(scope, "scope");
	if (validated.bootId !== autonomyBootId()) return true;
	let observed: { device: string; inode: string } | undefined;
	try {
		observed = directoryIdentity(cgroupDirectory(validated.controlGroup));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	if (observed === undefined) {
		const state = syncLoadStateOf(validated.unit);
		if (state === "not-found") return true;
		throw new Error(`scope ${validated.unit} has no control group while its unit is ${state}`);
	}
	if (observed.device !== validated.device || observed.inode !== validated.inode) {
		throw new Error("scope control group identity does not match the observed scope");
	}
	return !cgroupHasExecutableProcesses(cgroupDirectory(validated.controlGroup));
}

/**
 * Await two positive quiescence observations. Transient "unit still loaded while its cgroup was
 * already removed" is retried rather than treated as either success or a hard failure.
 */
async function awaitScopeEmpty(scope: AutonomyScope, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (true) {
		try {
			if (autonomyScopeEmpty(scope)) {
				await Bun.sleep(FENCE_POLL_MS);
				if (autonomyScopeEmpty(scope)) return;
			}
			lastError = undefined;
		} catch (error) {
			lastError = error;
		}
		if (Date.now() > deadline) {
			if (lastError !== undefined) throw lastError;
			throw new Error(`scope ${scope.unit} still contains executable work`);
		}
		await Bun.sleep(FENCE_POLL_MS);
	}
}

/**
 * Physically fence the one bound scope by killing its whole control group and awaiting positive
 * quiescence. Only the asserted scope's unit is ever signalled; mismatched or unavailable control is
 * refused, and a different-boot scope is never touched.
 */
export async function fenceAutonomyScope(
	scope: AutonomyScope,
): Promise<{ scope: AutonomyScope; observedAt: number; method: "systemd-scope"; empty: true }> {
	const validated = validateScope(scope, "scope");
	if (validated.bootId !== autonomyBootId()) {
		throw new Error("scope belongs to a different kernel boot; there is no current control to signal");
	}
	// The unit and cgroup may already be gone after a previous physical fence. Positive quiescence is
	// the success condition; an absent cgroup with a loaded unit, an unreadable manager, a metadata
	// mismatch or live members still throws from autonomyScopeEmpty instead of becoming fake success.
	if (autonomyScopeEmpty(validated)) {
		return { scope: { ...validated }, observedAt: Date.now(), method: "systemd-scope", empty: true };
	}
	assertAutonomyScope(validated);
	if (!autonomyScopeEmpty(validated)) {
		const systemctl = requireTool("systemctl");
		const result = await runBounded(
			systemctl,
			["--user", "kill", "--signal=KILL", "--kill-whom=all", "--", validated.unit],
			KILL_TIMEOUT_MS,
		);
		if (result.code !== 0) {
			let empty = false;
			try {
				empty = autonomyScopeEmpty(validated);
			} catch {
				empty = false;
			}
			if (!empty) {
				throw new Error(`cannot kill scope ${validated.unit}: ${result.stderr.trim() || `exit ${result.code}`}`);
			}
		}
		await awaitScopeEmpty(validated, KILL_TIMEOUT_MS);
	}
	return { scope: { ...validated }, observedAt: Date.now(), method: "systemd-scope", empty: true };
}
