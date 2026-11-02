/**
 * The single durable authority for strict autonomous runs.
 *
 * One private local SQLite file holds the current run checkpoint and its canonical writable roots,
 * the decision/invocation event journal and immutable artifact bytes addressed by SHA-256. Every
 * mutation is one `BEGIN IMMEDIATE` transaction, so a checkpoint, its events and its new blobs
 * commit together or not at all. Ownership is a native process identity checked on every write; a
 * run identifier or an inherited environment never grants access.
 *
 * Normal mode has no side effect here: the module is only imported by the autonomous entry points.
 */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { acceptanceAt, antiSlopScope, antiSlopStatus, freshState, sha256, type JevState } from "../src/state.js";
import { asRecord } from "../src/types.js";
import {
	assertAutonomyScope,
	autonomyBootId,
	autonomyLaunchUnloaded,
	autonomyScopeEmpty,
	type AutonomyScope,
	type AutonomyScopeFence,
	type AutonomyScopeLaunch,
} from "./scope.js";

/**
 * The native identity of one process. `start` is the kernel start tick, not a wall clock, and
 * `bootId` is the kernel boot UUID: a process from another boot can never be the same process as a
 * current one, so it is dead without signalling a possibly reused pid.
 */
export interface ProcessIdentity {
	pid: number;
	start: string;
	group: number;
	parent: number;
	bootId: string;
}

/** The owner-authorized envelope of one autonomous run. It never grants more than the owner did. */
export interface AutonomyPolicy {
	/** Canonical existing directories the executor may change. */
	roots: string[];
	effects: Array<"project" | "publication">;
	maxJudgeCalls: number;
	maxExecutorCalls: number;
	maxRuntimeMs: number;
	maxContextBytes: number;
	maxArtifactBytes: number;
}

export type AutonomyStatus =
	| "ready"
	| "recovering"
	| "running"
	| "waiting"
	| "completed"
	| "cancelled"
	| "infeasible";

/**
 * How one write proves its caller. The process identity is read natively; these fields fence the
 * epoch and, for a child, the main-session generation.
 */
export interface AutonomyAccess {
	epoch: number;
	sessionId?: string;
	generation?: number;
}

/** One committed authorization to attempt an exact invocation. It is not evidence it ran. */
export interface AutonomyIntent {
	id: string;
	kind: "tool" | "lifecycle";
	payload: unknown;
	revision: number;
	taskFingerprint?: string;
	createdAt: number;
}

/** One requested extension-origin turn; a request is not proof that the turn started. */
export interface AutonomyWake {
	id: string;
	epoch: number;
	generation: number;
	sessionId: string;
	status: "pending" | "started";
	deadline: number;
}

/** A durable reason that holds the run without releasing the decision. */
export interface AutonomyWait {
	kind: string;
	reason: string;
	attempts: number;
	retryAt?: number;
	/** Unchanged substantive decision material waits without a transport retry. */
	materialDigest?: string;
	/** Retained only for wait comparison when a new session clears its old action window. */
	actionsDigest?: string;
	/** Read-only selected paths whose actual bytes may make the held material change. */
	observationPaths?: string[];
}

/**
 * The judged business audience of the immutable objective. It is a receipt of one actual lifecycle
 * decision, not a lexical guess and not a default: `objectiveDigest` binds it to this objective and
 * `decisionId` names the journaled decision that established it. It never expands policy roots or
 * effects, and it never authorizes publication by itself.
 */
export interface AutonomyAudience {
	external: boolean;
	objectiveDigest: string;
	decisionId: string;
}

/**
 * A durable quiescence receipt for one precommitted launch whose unit was never observed in this
 * boot (or whose unit belongs to a previous boot). It is local-kernel evidence only: a boot
 * difference says the old boot's local effects cannot execute here, never that a remote or migrated
 * effect was fenced. `intentIds` covers exactly the pending spawn intents of this launch.
 */
export interface AutonomyLaunchFence {
	launch: AutonomyScopeLaunch;
	method: "unit-unloaded" | "boot-difference";
	generation: number;
	observedAt: number;
	intentIds: string[];
	localOnly: true;
}

/** Everything the supervisor bound to one objective, and the checkpoint it is currently at. */
export interface AutonomyRun {
	id: string;
	objective: string;
	policy: AutonomyPolicy;
	policyDigest: string;
	/** The established, frozen audience receipt for this immutable objective. */
	audience?: AutonomyAudience;
	createdAt: number;
	updatedAt: number;
	sequence: number;
	epoch: number;
	generation: number;
	status: AutonomyStatus;
	owner?: ProcessIdentity;
	child?: ProcessIdentity;
	/** The observed real systemd scope containing this run's whole native execution. */
	scope?: AutonomyScope;
	/** Durable safety-only receipts, each covering exactly the intents of the scope it observed. */
	fences: AutonomyScopeFence[];
	/** Durable per-launch quiescence proofs for launches that never yielded an observed scope. */
	launchFences: AutonomyLaunchFence[];
	session?: { id: string; file: string };
	checkpoint: JevState;
	artifacts: Record<string, string>;
	manifest: Record<string, string>;
	topicManifests: Record<string, Record<string, string>>;
	pending: Record<string, AutonomyIntent>;
	wake?: AutonomyWake;
	waiting?: AutonomyWait;
	judgeCalls: number;
	executorCalls: number;
}

/** One committed journal entry. Sequences increase per run; a transition may write several. */
export interface AutonomyEvent {
	sequence: number;
	kind: string;
	data: unknown;
}

/** The store the supervisor and the bound extension share. All methods are synchronous. */
export interface AutonomyStore {
	create(objective: string, policy: AutonomyPolicy): AutonomyRun;
	read(id: string): AutonomyRun;
	list(): AutonomyRun[];
	events(id: string): AutonomyEvent[];
	/**
	 * The exact `request` this run's judge actually saw for an admitted decision digest, or null when
	 * no such judge.request is journaled. Corrupt or inconsistent journal evidence throws.
	 */
	decisionContext(id: string, requestDigest: string): Record<string, unknown> | null;
	claim(id: string, owner: ProcessIdentity): AutonomyRun;
	bindScope(id: string, epoch: number, scope: AutonomyScope): AutonomyRun;
	recordFence(id: string, epoch: number, scope: AutonomyScope): AutonomyRun;
	recordLaunchFence(
		id: string,
		epoch: number,
		launch: AutonomyScopeLaunch,
		method: AutonomyLaunchFence["method"],
	): AutonomyRun;
	bindChild(id: string, epoch: number, child: ProcessIdentity): AutonomyRun;
	bindSession(id: string, epoch: number, session: { id: string; file: string }): AutonomyRun;
	update(
		id: string,
		access: AutonomyAccess,
		mutator: (run: AutonomyRun) => void,
		events?: Array<{ kind: string; data: unknown }>,
		artifacts?: Record<string, Uint8Array>,
	): AutonomyRun;
	artifact(id: string, url: string): Uint8Array | null;
	cancel(id: string, reason: string): AutonomyRun;
	close(): void;
}

const SCHEMA_VERSION = 1;
const EFFECT_NAMES: Record<string, true> = { project: true, publication: true };
const STATUS_NAMES: Record<string, true> = {
	ready: true,
	recovering: true,
	running: true,
	waiting: true,
	completed: true,
	cancelled: true,
	infeasible: true,
};
const TERMINAL_STATUS: Record<string, true> = { completed: true, cancelled: true, infeasible: true };
const RUNS_TABLE = [
	"id",
	"body",
	"digest",
	"status",
	"roots",
	"created_at",
	"updated_at",
];
const EVENTS_TABLE = ["run_id", "sequence", "kind", "data", "digest"];
const BLOBS_TABLE = ["digest", "bytes"];

/* -------------------------------------------------------------------------------------------------
 * Native process identity
 * ---------------------------------------------------------------------------------------------- */

interface ProcStat {
	state: string;
	parent: number;
	group: number;
	start: string;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code: unknown = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Read `/proc/<pid>/stat`. The command name is parenthesised and may itself contain spaces and
 * parentheses, so the fixed fields are parsed from after the last `)`. `ENOENT` is the one absence
 * that means "not there"; every other unreadable state is thrown, never reported as a dead process.
 */
function readProcStat(pid: number): ProcStat | null {
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

function isValidIdentity(value: unknown): value is ProcessIdentity {
	const candidate = asRecord(value);
	if (candidate === undefined) return false;
	const pid = candidate.pid;
	const start = candidate.start;
	const group = candidate.group;
	const parent = candidate.parent;
	const bootId = candidate.bootId;
	return (
		typeof pid === "number" &&
		Number.isSafeInteger(pid) &&
		pid > 0 &&
		typeof start === "string" &&
		/^\d+$/.test(start) &&
		typeof group === "number" &&
		Number.isSafeInteger(group) &&
		group > 0 &&
		typeof parent === "number" &&
		Number.isSafeInteger(parent) &&
		parent >= 0 &&
		typeof bootId === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)
	);
}

/**
 * Stable process identity. Parentage is not part of it: the kernel reparents a live process when its
 * launcher exits, so a supervisor keeps ownership of its own run. Callers that need the parentage
 * relationship check it explicitly.
 */
function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.start === right.start &&
		left.group === right.group &&
		left.bootId === right.bootId
	);
}

function identityOf(pid: number): ProcessIdentity | null {
	const stat = readProcStat(pid);
	return stat === null || stat.group === 0
		? null
		: { pid, start: stat.start, group: stat.group, parent: stat.parent, bootId: autonomyBootId() };
}

/** Whether a process can execute. Zombies and recycled pid+start pairs are not alive. */
function isExecutable(state: string): boolean {
	return state !== "Z" && state !== "X" && state !== "x";
}

/** Refuse to interpret a missing procfs as proof that an owner or group is dead. */
function requireProcfs(): void {
	if (process.platform !== "linux") throw new Error("process ownership requires Linux /proc");
	try {
		statSync("/proc/self/stat");
	} catch {
		throw new Error("process ownership cannot observe /proc");
	}
}

/**
 * The native positive-group identity of `pid`, or null when absent or outside a signalable group.
 * Kernel threads may have group zero; unreadable records still throw rather than prove quiescence.
 */
export function processIdentity(pid: number = process.pid): ProcessIdentity | null {
	return identityOf(pid);
}

/**
 * Whether the exact process is still executable. An unknown or permission-denied observation
 * throws; only a missing pid or a different start tick is a definite "no".
 */
export function processAlive(identity: ProcessIdentity): boolean {
	requireProcfs();
	if (!isValidIdentity(identity)) throw new Error("processAlive requires a native process identity");
	// A process from a different kernel boot is dead; a current pid/start would be a reused identity.
	if (identity.bootId !== autonomyBootId()) return false;
	const stat = readProcStat(identity.pid);
	if (stat === null) return false;
	if (!isExecutable(stat.state)) return false;
	return stat.start === identity.start;
}

/**
 * Whether any executable process remains in the group. A group of zombies is not a live executor,
 * and an unreadable `/proc` throws: unobservable ownership is never treated as fenced.
 */
export function processGroupAlive(group: number): boolean {
	requireProcfs();
	if (!Number.isSafeInteger(group) || group <= 0) throw new Error(`invalid process group ${group}`);
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch (error) {
		throw new Error(`cannot observe process groups: ${errorText(error)}`);
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const stat = readProcStat(Number(entry));
		if (stat === null || stat.group !== group) continue;
		if (isExecutable(stat.state)) return true;
	}
	return false;
}

function currentIdentity(): ProcessIdentity {
	const identity = processIdentity(process.pid);
	if (identity === null) throw new Error("the current process identity is unobservable");
	return identity;
}

/* -------------------------------------------------------------------------------------------------
 * Validation primitives
 * ---------------------------------------------------------------------------------------------- */

function record(value: unknown, what: string): Record<string, unknown> {
	const found = asRecord(value);
	if (found === undefined) throw new Error(`${what} must be an object`);
	return found;
}

function text(value: unknown, what: string): string {
	if (typeof value !== "string") throw new Error(`${what} must be a string`);
	return value;
}

function nonEmptyText(value: unknown, what: string): string {
	const found = text(value, what);
	if (found.trim() === "") throw new Error(`${what} must not be empty`);
	return found;
}

function integer(value: unknown, what: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${what} must be an integer of at least ${minimum}`);
	}
	return value;
}

function confidence(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${what} must be a probability between 0 and 1`);
	}
	return value;
}

function array(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${what} must be an array`);
	return value;
}

function stringArray(value: unknown, what: string): string[] {
	return array(value, what).map((entry, index) => text(entry, `${what}[${index}]`));
}

function optionalBoolean(value: unknown, what: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${what} must be a boolean`);
	return value;
}

function safeKey(key: string, what: string): string {
	if (key === "__proto__" || key === "constructor" || key === "prototype") {
		throw new Error(`${what} contains an unsafe key`);
	}
	return key;
}

function digestText(value: string): string {
	return sha256(value);
}

function digestBytes(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/* -------------------------------------------------------------------------------------------------
 * Policy and roots
 * ---------------------------------------------------------------------------------------------- */

function canonicalRoot(root: string, index: number): string {
	if (root.trim() === "" || !isAbsolute(root)) {
		throw new Error(`policy.roots[${index}] must be an absolute directory`);
	}
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch (error) {
		throw new Error(`policy.roots[${index}] does not exist: ${errorText(error)}`);
	}
	if (!statSync(canonical).isDirectory()) throw new Error(`policy.roots[${index}] is not a directory`);
	return canonical;
}

/** Whether `child` is `parent` or below it. Used for root overlap and database placement. */
function pathInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function rootsOverlap(left: string[], right: string[]): boolean {
	return left.some(a => right.some(b => pathInside(a, b) || pathInside(b, a)));
}

function normalizePolicy(value: unknown): AutonomyPolicy {
	const policy = record(value, "policy");
	const roots = stringArray(policy.roots, "policy.roots").map(canonicalRoot);
	for (let index = 0; index < roots.length; index += 1) {
		for (let other = index + 1; other < roots.length; other += 1) {
			if (pathInside(roots[index] ?? "", roots[other] ?? "")) {
				throw new Error("policy.roots must not overlap each other");
			}
			if (pathInside(roots[other] ?? "", roots[index] ?? "")) {
				throw new Error("policy.roots must not overlap each other");
			}
		}
	}
	const effects = stringArray(policy.effects, "policy.effects").map((effect, index) => {
		if (EFFECT_NAMES[effect] !== true) throw new Error(`policy.effects[${index}] is unknown`);
		return effect as AutonomyPolicy["effects"][number];
	});
	if (new Set(effects).size !== effects.length) throw new Error("policy.effects must be unique");
	const bounds = {
		maxJudgeCalls: integer(policy.maxJudgeCalls, "policy.maxJudgeCalls", 1),
		maxExecutorCalls: integer(policy.maxExecutorCalls, "policy.maxExecutorCalls", 1),
		maxRuntimeMs: integer(policy.maxRuntimeMs, "policy.maxRuntimeMs", 1),
		maxContextBytes: integer(policy.maxContextBytes, "policy.maxContextBytes", 1),
		maxArtifactBytes: integer(policy.maxArtifactBytes, "policy.maxArtifactBytes", 1),
	};
	return {
		roots: [...roots].sort(),
		effects: [...effects].sort() as AutonomyPolicy["effects"],
		...bounds,
	};
}

/** Validate a policy already stored by this schema; filesystem existence is a create-time check. */
function readPolicy(value: unknown): AutonomyPolicy {
	const policy = record(value, "run.policy");
	const roots = stringArray(policy.roots, "run.policy.roots");
	for (const root of roots) {
		if (!isAbsolute(root) || resolve(root) !== root) {
			throw new Error("run.policy.roots must stay canonical");
		}
	}
	const effects = stringArray(policy.effects, "run.policy.effects");
	for (const effect of effects) {
		if (EFFECT_NAMES[effect] !== true) throw new Error(`run.policy.effects contains ${effect}`);
	}
	if (new Set(effects).size !== effects.length) throw new Error("run.policy.effects repeats an effect");
	for (let index = 0; index < roots.length; index += 1) {
		for (let other = index + 1; other < roots.length; other += 1) {
			if (pathInside(roots[index] ?? "", roots[other] ?? "") || pathInside(roots[other] ?? "", roots[index] ?? "")) {
				throw new Error("run.policy.roots overlap");
			}
		}
	}
	return {
		roots,
		effects: effects as AutonomyPolicy["effects"],
		maxJudgeCalls: integer(policy.maxJudgeCalls, "run.policy.maxJudgeCalls", 1),
		maxExecutorCalls: integer(policy.maxExecutorCalls, "run.policy.maxExecutorCalls", 1),
		maxRuntimeMs: integer(policy.maxRuntimeMs, "run.policy.maxRuntimeMs", 1),
		maxContextBytes: integer(policy.maxContextBytes, "run.policy.maxContextBytes", 1),
		maxArtifactBytes: integer(policy.maxArtifactBytes, "run.policy.maxArtifactBytes", 1),
	};
}

/* -------------------------------------------------------------------------------------------------
 * JevState checkpoint codec
 * ---------------------------------------------------------------------------------------------- */

function refusedCallsOf(value: unknown): Map<string, number> {
	const entries = array(value, "checkpoint.refusedCalls");
	const map = new Map<string, number>();
	for (const entry of entries) {
		const pair = array(entry, "checkpoint.refusedCalls entry");
		if (pair.length !== 2) throw new Error("checkpoint.refusedCalls entry must be a pair");
		const key = text(pair[0], "checkpoint.refusedCalls boundary");
		const count = integer(pair[1], "checkpoint.refusedCalls count");
		if (map.has(key)) throw new Error("checkpoint.refusedCalls repeats a boundary");
		map.set(key, count);
	}
	return map;
}

function validatePlanTopic(value: unknown, what: string): void {
	const topic = record(value, what);
	text(topic.id, `${what}.id`);
	text(topic.section, `${what}.section`);
	stringArray(topic.paths, `${what}.paths`);
	text(topic.requirement, `${what}.requirement`);
}

function validateTask(value: unknown, what: string): void {
	const task = record(value, what);
	text(task.fingerprint, `${what}.fingerprint`);
	text(task.request, `${what}.request`);
	optionalBoolean(task.external, `${what}.external`);
}

function validateAction(value: unknown, what: string): void {
	const action = record(value, what);
	text(action.tool, `${what}.tool`);
	text(action.target, `${what}.target`);
	text(action.excerpt, `${what}.excerpt`);
}

function validateAcceptance(value: unknown, what: string): void {
	const recordValue = record(value, what);
	const aspect = text(recordValue.aspect, `${what}.aspect`);
	if (aspect !== "business" && aspect !== "architecture") throw new Error(`${what}.aspect is unknown`);
	integer(recordValue.revision, `${what}.revision`);
	text(recordValue.label, `${what}.label`);
	if (typeof recordValue.approved !== "boolean") throw new Error(`${what}.approved must be a boolean`);
	confidence(recordValue.confidence, `${what}.confidence`);
}

function validateCompletion(value: unknown, what: string): void {
	const completion = record(value, what);
	integer(completion.revision, `${what}.revision`);
	text(completion.label, `${what}.label`);
	if (typeof completion.approved !== "boolean") throw new Error(`${what}.approved must be a boolean`);
	confidence(completion.confidence, `${what}.confidence`);
}

function validateFinding(value: unknown, what: string): void {
	const finding = record(value, what);
	text(finding.id, `${what}.id`);
	text(finding.kind, `${what}.kind`);
	const severity = text(finding.severity, `${what}.severity`);
	if (severity !== "blocker" && severity !== "warning") throw new Error(`${what}.severity is unknown`);
	text(finding.target, `${what}.target`);
	text(finding.verdict, `${what}.verdict`);
	confidence(finding.confidence, `${what}.confidence`);
	if (finding.rule !== undefined) text(finding.rule, `${what}.rule`);
}

function validateAntiSlopReview(value: unknown, what: string): void {
	const review = record(value, what);
	if (review.taskFingerprint !== undefined) text(review.taskFingerprint, `${what}.taskFingerprint`);
	text(review.request, `${what}.request`);
	integer(review.revision, `${what}.revision`);
	const part = record(review.part, `${what}.part`);
	integer(part.index, `${what}.part.index`, 1);
	integer(part.total, `${what}.part.total`, 1);
	text(review.partDigest, `${what}.partDigest`);
	if (review.artifact !== undefined) {
		const artifact = text(review.artifact, `${what}.artifact`);
		if (sha256(artifact) !== review.partDigest) throw new Error(`${what}.artifact does not match its reviewed byte digest`);
	}
	text(review.language, `${what}.language`);
	text(review.register, `${what}.register`);
	text(review.rulesDigest, `${what}.rulesDigest`);
	array(review.findings, `${what}.findings`).forEach((entry, index) =>
		validateFinding(entry, `${what}.findings[${index}]`),
	);
}

function validateWaiver(value: unknown, what: string): void {
	const waiver = record(value, what);
	text(waiver.findingId, `${what}.findingId`);
	text(waiver.reason, `${what}.reason`);
	if (waiver.reviewPartDigest !== undefined) text(waiver.reviewPartDigest, `${what}.reviewPartDigest`);
	if (waiver.taskFingerprint !== undefined) text(waiver.taskFingerprint, `${what}.taskFingerprint`);
	if (waiver.request !== undefined) text(waiver.request, `${what}.request`);
}

function validateStats(value: unknown): Record<string, { ok: number; fail: number }> {
	const stats = record(value, "checkpoint.stats");
	const result: Record<string, { ok: number; fail: number }> = {};
	for (const [key, entry] of Object.entries(stats)) {
		safeKey(key, "checkpoint.stats");
		const count = record(entry, `checkpoint.stats.${key}`);
		result[key] = {
			ok: integer(count.ok, `checkpoint.stats.${key}.ok`),
			fail: integer(count.fail, `checkpoint.stats.${key}.fail`),
		};
	}
	return result;
}

/**
 * Decode one checkpoint. The `refusedCalls` Map is rebuilt from explicit pairs, and the transient
 * in-flight course token is dropped: a restarted process must not inherit an approval or a lock it
 * did not set. Required fields are checked rather than defaulted.
 */
function decodeCheckpoint(value: unknown): JevState {
	const state = record(value, "checkpoint");
	if (state.autonomous !== true) throw new Error("checkpoint is not marked autonomous");
	integer(state.revision, "checkpoint.revision");
	integer(state.actionsSinceCheck, "checkpoint.actionsSinceCheck");
	if (state.task !== undefined) validateTask(state.task, "checkpoint.task");
	if (state.simple !== undefined) validateTask(state.simple, "checkpoint.simple");
	if (state.requirementsApproval !== undefined) {
		const approval = record(state.requirementsApproval, "checkpoint.requirementsApproval");
		text(approval.taskFingerprint, "checkpoint.requirementsApproval.taskFingerprint");
		stringArray(approval.items, "checkpoint.requirementsApproval.items");
	}
	if (state.request !== undefined) {
		const request = record(state.request, "checkpoint.request");
		text(request.text, "checkpoint.request.text");
		text(request.weight, "checkpoint.request.weight");
	}
	if (state.plan !== undefined) {
		const plan = record(state.plan, "checkpoint.plan");
		text(plan.taskFingerprint, "checkpoint.plan.taskFingerprint");
		text(plan.planUrl, "checkpoint.plan.planUrl");
		text(plan.planDigest, "checkpoint.plan.planDigest");
	}
	if (state.planDraft !== undefined) {
		const draft = record(state.planDraft, "checkpoint.planDraft");
		text(draft.taskFingerprint, "checkpoint.planDraft.taskFingerprint");
		text(draft.requirementsDigest, "checkpoint.planDraft.requirementsDigest");
		array(draft.steps, "checkpoint.planDraft.steps").forEach((step, index) => {
			const outline = record(step, `checkpoint.planDraft.steps[${index}]`);
			text(outline.id, `checkpoint.planDraft.steps[${index}].id`);
			text(outline.summary, `checkpoint.planDraft.steps[${index}].summary`);
			text(outline.requirement, `checkpoint.planDraft.steps[${index}].requirement`);
		});
		if (typeof draft.outlineApproved !== "boolean") {
			throw new Error("checkpoint.planDraft.outlineApproved must be a boolean");
		}
		array(draft.details, "checkpoint.planDraft.details").forEach((topic, index) =>
			validatePlanTopic(topic, `checkpoint.planDraft.details[${index}]`),
		);
	}
	array(state.planTopics, "checkpoint.planTopics").forEach((topic, index) =>
		validatePlanTopic(topic, `checkpoint.planTopics[${index}]`),
	);
	if (state.hold !== undefined) text(record(state.hold, "checkpoint.hold").reason, "checkpoint.hold.reason");
	if (state.directionPending !== undefined) {
		text(record(state.directionPending, "checkpoint.directionPending").text, "checkpoint.directionPending.text");
	}
	array(state.actions, "checkpoint.actions").forEach((action, index) =>
		validateAction(action, `checkpoint.actions[${index}]`),
	);
	integer(state.judgeFailures, "checkpoint.judgeFailures");
	optionalBoolean(state.judgeUnavailable, "checkpoint.judgeUnavailable");
	optionalBoolean(state.judgeUnavailableNotified, "checkpoint.judgeUnavailableNotified");
	if (state.openItemNotified !== undefined) text(state.openItemNotified, "checkpoint.openItemNotified");
	array(state.submissions, "checkpoint.submissions").forEach((submission, index) => {
		const item = record(submission, `checkpoint.submissions[${index}]`);
		text(item.boundary, `checkpoint.submissions[${index}].boundary`);
		text(item.digest, `checkpoint.submissions[${index}].digest`);
	});
	if (state.openItem !== undefined) {
		const open = record(state.openItem, "checkpoint.openItem");
		text(open.boundary, "checkpoint.openItem.boundary");
		integer(open.attempts, "checkpoint.openItem.attempts");
	}
	stringArray(state.exhausted, "checkpoint.exhausted");
	if (state.deviation !== undefined) {
		const deviation = record(state.deviation, "checkpoint.deviation");
		text(deviation.tool, "checkpoint.deviation.tool");
		text(deviation.target, "checkpoint.deviation.target");
		integer(deviation.revision, "checkpoint.deviation.revision");
	}
	if (state.completion !== undefined) validateCompletion(state.completion, "checkpoint.completion");
	array(state.acceptance, "checkpoint.acceptance").forEach((entry, index) =>
		validateAcceptance(entry, `checkpoint.acceptance[${index}]`),
	);
	if (state.stop !== undefined) {
		const stop = record(state.stop, "checkpoint.stop");
		text(stop.signature, "checkpoint.stop.signature");
		integer(stop.blocks, "checkpoint.stop.blocks");
	}
	if (state.continuation !== undefined) {
		const continuation = record(state.continuation, "checkpoint.continuation");
		if (continuation.taskFingerprint !== undefined) {
			text(continuation.taskFingerprint, "checkpoint.continuation.taskFingerprint");
		}
		text(continuation.request, "checkpoint.continuation.request");
		text(continuation.reason, "checkpoint.continuation.reason");
	}
	array(state.antiSlopReviews, "checkpoint.antiSlopReviews").forEach((review, index) =>
		validateAntiSlopReview(review, `checkpoint.antiSlopReviews[${index}]`),
	);
	array(state.antiSlopWaivers, "checkpoint.antiSlopWaivers").forEach((waiver, index) =>
		validateWaiver(waiver, `checkpoint.antiSlopWaivers[${index}]`),
	);
	if (state.antiSlopNotice !== undefined) text(state.antiSlopNotice, "checkpoint.antiSlopNotice");
	const usage = record(state.usage, "checkpoint.usage");
	integer(usage.judgeCalls, "checkpoint.usage.judgeCalls");
	integer(usage.inputTokens, "checkpoint.usage.inputTokens");
	integer(usage.outputTokens, "checkpoint.usage.outputTokens");
	const stats = validateStats(state.stats);
	const decoded: Record<string, unknown> = { ...state, refusedCalls: refusedCallsOf(state.refusedCalls), stats };
	delete decoded.checkPending;
	return decoded as unknown as JevState;
}

/** Encode a checkpoint with the one Map field made explicit and transient state removed. */
function encodeCheckpoint(state: JevState): Record<string, unknown> {
	const entries = [...state.refusedCalls.entries()].sort((left, right) => left[0].localeCompare(right[0]));
	const encoded = { ...state, refusedCalls: entries } as unknown as Record<string, unknown>;
	delete encoded.checkPending;
	return encoded;
}

/* -------------------------------------------------------------------------------------------------
 * Run, intent, wake and wait validation
 * ---------------------------------------------------------------------------------------------- */

function validateIntent(value: unknown, what: string): AutonomyIntent {
	const intent = record(value, what);
	const kind = text(intent.kind, `${what}.kind`);
	if (kind !== "tool" && kind !== "lifecycle") throw new Error(`${what}.kind is unknown`);
	const validated: AutonomyIntent = {
		id: nonEmptyText(intent.id, `${what}.id`),
		kind,
		payload: intent.payload,
		revision: integer(intent.revision, `${what}.revision`),
		createdAt: integer(intent.createdAt, `${what}.createdAt`),
	};
	if (intent.taskFingerprint !== undefined) {
		validated.taskFingerprint = text(intent.taskFingerprint, `${what}.taskFingerprint`);
	}
	return validated;
}

function validatePending(value: unknown): Record<string, AutonomyIntent> {
	const pending = record(value, "run.pending");
	const result: Record<string, AutonomyIntent> = {};
	for (const [key, entry] of Object.entries(pending)) {
		safeKey(key, "run.pending");
		result[key] = validateIntent(entry, `run.pending.${key}`);
	}
	return result;
}

function validateWake(value: unknown): AutonomyWake {
	const wake = record(value, "run.wake");
	const status = text(wake.status, "run.wake.status");
	if (status !== "pending" && status !== "started") throw new Error("run.wake.status is unknown");
	return {
		id: nonEmptyText(wake.id, "run.wake.id"),
		epoch: integer(wake.epoch, "run.wake.epoch"),
		generation: integer(wake.generation, "run.wake.generation"),
		sessionId: nonEmptyText(wake.sessionId, "run.wake.sessionId"),
		status,
		deadline: integer(wake.deadline, "run.wake.deadline"),
	};
}

function validateWait(value: unknown): AutonomyWait {
	const wait = record(value, "run.waiting");
	const validated: AutonomyWait = {
		kind: nonEmptyText(wait.kind, "run.waiting.kind"),
		reason: text(wait.reason, "run.waiting.reason"),
		attempts: integer(wait.attempts, "run.waiting.attempts"),
	};
	if (wait.retryAt !== undefined) validated.retryAt = integer(wait.retryAt, "run.waiting.retryAt");
	if (wait.materialDigest !== undefined) validated.materialDigest = nonEmptyText(wait.materialDigest, "run.waiting.materialDigest");
	if (wait.actionsDigest !== undefined) validated.actionsDigest = nonEmptyText(wait.actionsDigest, "run.waiting.actionsDigest");
	if (wait.observationPaths !== undefined) {
		if (!Array.isArray(wait.observationPaths)) throw new Error("run.waiting.observationPaths must be an array");
		validated.observationPaths = wait.observationPaths.map(value => nonEmptyText(value, "run.waiting.observationPaths"));
	}
	return validated;
}

function validateAliases(value: unknown, what: string): Record<string, string> {
	const aliases = record(value, what);
	const result: Record<string, string> = {};
	for (const [alias, digest] of Object.entries(aliases)) {
		safeKey(alias, what);
		if (alias === "") throw new Error(`${what} contains an empty alias`);
		const hash = text(digest, `${what}.${alias}`);
		if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${what}.${alias} is not a SHA-256 digest`);
		result[alias] = hash;
	}
	return result;
}

function validateStringMap(value: unknown, what: string): Record<string, string> {
	const map = record(value, what);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(map)) {
		safeKey(key, what);
		result[key] = text(entry, `${what}.${key}`);
	}
	return result;
}

function validateTopicManifests(value: unknown): Record<string, Record<string, string>> {
	const manifests = record(value, "run.topicManifests");
	const result: Record<string, Record<string, string>> = {};
	for (const [key, entry] of Object.entries(manifests)) {
		safeKey(key, "run.topicManifests");
		result[key] = validateStringMap(entry, `run.topicManifests.${key}`);
	}
	return result;
}

/** The decision reference a lifecycle event cites, if its data names one. */
function decisionReference(data: unknown): string | undefined {
	const found = asRecord(data);
	if (found === undefined) return undefined;
	const value = found.decisionId;
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Validate one stored audience receipt. The objective digest is recomputed from the immutable
 * objective, so a copied receipt can never authorize a different objective, and there is no default.
 */
function validateAudience(value: unknown, objective: string, what: string): AutonomyAudience {
	const source = record(value, what);
	if (typeof source.external !== "boolean") throw new Error(`${what}.external must be a boolean`);
	const objectiveDigest = nonEmptyText(source.objectiveDigest, `${what}.objectiveDigest`);
	if (!/^[0-9a-f]{64}$/.test(objectiveDigest)) throw new Error(`${what}.objectiveDigest is not a SHA-256 digest`);
	if (objectiveDigest !== digestText(objective)) {
		throw new Error(`${what}.objectiveDigest does not match the run objective`);
	}
	return {
		external: source.external,
		objectiveDigest,
		decisionId: nonEmptyText(source.decisionId, `${what}.decisionId`),
	};
}

const SCOPE_BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_INVOCATION_ID = /^[0-9a-f]{32}$/;
const SCOPE_UNIT = /^jevstice-[A-Za-z0-9][A-Za-z0-9_.-]*\.scope$/;

/** Validate one stored scope identity. Observed values are numbers-as-strings and a systemd id. */
function validateStoredScope(value: unknown, what: string): AutonomyScope {
	const source = record(value, what);
	const runId = nonEmptyText(source.runId, `${what}.runId`);
	const epoch = integer(source.epoch, `${what}.epoch`, 0);
	const unit = nonEmptyText(source.unit, `${what}.unit`);
	if (!SCOPE_UNIT.test(unit)) throw new Error(`${what}.unit is not an owned jevstice scope unit`);
	const bootId = nonEmptyText(source.bootId, `${what}.bootId`);
	if (!SCOPE_BOOT_ID.test(bootId)) throw new Error(`${what}.bootId is not a canonical kernel UUID`);
	const controlGroup = nonEmptyText(source.controlGroup, `${what}.controlGroup`);
	if (
		!controlGroup.startsWith("/user.slice/") ||
		controlGroup.includes("\n") ||
		controlGroup.includes("\0") ||
		!controlGroup.endsWith(`/${unit}`)
	) {
		throw new Error(`${what}.controlGroup is not the user-slice cgroup of the unit`);
	}
	const device = nonEmptyText(source.device, `${what}.device`);
	const inode = nonEmptyText(source.inode, `${what}.inode`);
	if (!/^\d+$/.test(device)) throw new Error(`${what}.device is not a device number`);
	if (!/^\d+$/.test(inode)) throw new Error(`${what}.inode is not an inode number`);
	const invocationId = nonEmptyText(source.invocationId, `${what}.invocationId`);
	if (!SCOPE_INVOCATION_ID.test(invocationId)) throw new Error(`${what}.invocationId is not a systemd invocation id`);
	return { runId, epoch, unit, bootId, controlGroup, device, inode, invocationId };
}

function sameScope(left: AutonomyScope, right: AutonomyScope): boolean {
	return (
		left.runId === right.runId &&
		left.epoch === right.epoch &&
		left.unit === right.unit &&
		left.bootId === right.bootId &&
		left.controlGroup === right.controlGroup &&
		left.device === right.device &&
		left.inode === right.inode &&
		left.invocationId === right.invocationId
	);
}

function validateFence(value: unknown, what: string): AutonomyScopeFence {
	const source = record(value, what);
	const scope = validateStoredScope(source.scope, `${what}.scope`);
	const recordedEpoch = integer(source.recordedEpoch, `${what}.recordedEpoch`);
	const generation = integer(source.generation, `${what}.generation`);
	const observedAt = integer(source.observedAt, `${what}.observedAt`);
	const intentIds = stringArray(source.intentIds, `${what}.intentIds`);
	if (new Set(intentIds).size !== intentIds.length) throw new Error(`${what}.intentIds repeats an identity`);
	return { scope, recordedEpoch, generation, observedAt, intentIds };
}

function validateFences(value: unknown): AutonomyScopeFence[] {
	return array(value, "run.fences").map((entry, index) => validateFence(entry, `run.fences[${index}]`));
}

function validateLaunchValue(value: unknown, what: string): AutonomyScopeLaunch {
	const source = record(value, what);
	const runId = nonEmptyText(source.runId, `${what}.runId`);
	const epoch = integer(source.epoch, `${what}.epoch`, 0);
	const unit = nonEmptyText(source.unit, `${what}.unit`);
	if (!SCOPE_UNIT.test(unit)) throw new Error(`${what}.unit is not an owned jevstice scope unit`);
	const bootId = nonEmptyText(source.bootId, `${what}.bootId`);
	if (!SCOPE_BOOT_ID.test(bootId)) throw new Error(`${what}.bootId is not a canonical kernel UUID`);
	return { runId, epoch, unit, bootId };
}

function validateLaunchFence(value: unknown, what: string): AutonomyLaunchFence {
	const source = record(value, what);
	const launch = validateLaunchValue(source.launch, `${what}.launch`);
	const method = nonEmptyText(source.method, `${what}.method`);
	if (method !== "unit-unloaded" && method !== "boot-difference") {
		throw new Error(`${what}.method is not an observed launch quiescence method`);
	}
	const generation = integer(source.generation, `${what}.generation`);
	const observedAt = integer(source.observedAt, `${what}.observedAt`);
	const intentIds = stringArray(source.intentIds, `${what}.intentIds`);
	if (new Set(intentIds).size !== intentIds.length) throw new Error(`${what}.intentIds repeats an identity`);
	if (source.localOnly !== true) throw new Error(`${what}.localOnly must be true`);
	return { launch, method, generation, observedAt, intentIds, localOnly: true };
}

function validateLaunchFences(value: unknown): AutonomyLaunchFence[] {
	return array(value, "run.launchFences").map((entry, index) =>
		validateLaunchFence(entry, `run.launchFences[${index}]`),
	);
}

function validateRun(value: unknown): AutonomyRun {
	const source = record(value, "run");
	const policy = readPolicy(source.policy);
	const policyDigest = text(source.policyDigest, "run.policyDigest");
	if (policyDigest !== digestText(JSON.stringify(policy))) throw new Error("run.policyDigest does not match the stored policy");
	const status = text(source.status, "run.status");
	if (STATUS_NAMES[status] !== true) throw new Error(`run.status ${status} is unknown`);
	const run: AutonomyRun = {
		id: nonEmptyText(source.id, "run.id"),
		objective: nonEmptyText(source.objective, "run.objective"),
		policy,
		policyDigest,
		createdAt: integer(source.createdAt, "run.createdAt"),
		updatedAt: integer(source.updatedAt, "run.updatedAt"),
		sequence: integer(source.sequence, "run.sequence", 1),
		epoch: integer(source.epoch, "run.epoch"),
		generation: integer(source.generation, "run.generation"),
		status: status as AutonomyStatus,
		checkpoint: decodeCheckpoint(source.checkpoint),
		artifacts: validateAliases(source.artifacts, "run.artifacts"),
		manifest: validateStringMap(source.manifest, "run.manifest"),
		topicManifests: validateTopicManifests(source.topicManifests),
		pending: validatePending(source.pending),
		fences: validateFences(source.fences),
		launchFences: source.launchFences === undefined ? [] : validateLaunchFences(source.launchFences),
		judgeCalls: integer(source.judgeCalls, "run.judgeCalls"),
		executorCalls: integer(source.executorCalls, "run.executorCalls"),
	};
	if (run.updatedAt < run.createdAt) throw new Error("run.updatedAt precedes run.createdAt");
	const owner = source.owner;
	if (owner !== undefined) {
		if (!isValidIdentity(owner)) throw new Error("run.owner is not a process identity");
		run.owner = owner;
	}
	const child = source.child;
	if (child !== undefined) {
		if (!isValidIdentity(child)) throw new Error("run.child is not a process identity");
		run.child = child;
	}
	if (source.scope !== undefined) run.scope = validateStoredScope(source.scope, "run.scope");
	if (source.audience !== undefined) run.audience = validateAudience(source.audience, run.objective, "run.audience");
	for (const [index, fence] of run.fences.entries()) {
		if (fence.scope.runId !== run.id) throw new Error(`run.fences[${index}] does not belong to this run`);
	}
	for (const [index, fence] of run.launchFences.entries()) {
		if (fence.launch.runId !== run.id) throw new Error(`run.launchFences[${index}] does not belong to this run`);
	}
	if (source.session !== undefined) {
		const session = record(source.session, "run.session");
		run.session = {
			id: nonEmptyText(session.id, "run.session.id"),
			file: nonEmptyText(session.file, "run.session.file"),
		};
	}
	if (source.wake !== undefined) {
		const wake = validateWake(source.wake);
		run.wake = wake;
		if (wake.epoch !== run.epoch) throw new Error("run.wake epoch does not match the run");
		if (wake.generation !== run.generation) throw new Error("run.wake generation is stale");
		if (run.session === undefined || wake.sessionId !== run.session.id) {
			throw new Error("run.wake does not name the bound session");
		}
	}
	if (source.waiting !== undefined) run.waiting = validateWait(source.waiting);
	if (TERMINAL_STATUS[run.status] === true && run.wake !== undefined) {
		throw new Error("a terminal run cannot carry a queued wake");
	}
	return run;
}

/* -------------------------------------------------------------------------------------------------
 * Completion proof
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why a completed status is not proved, or undefined when it is. The proof is the current recorded
 * completion verdict, both acceptance aspects at the current revision and, for an external
 * deliverable, a complete review of the current bytes. A flag alone never completes a run.
 */
function completionProblem(run: AutonomyRun): string | undefined {
	if (Object.keys(run.pending).length > 0) return "pending effects have no observed result";
	if (run.wake !== undefined) return "a queued wake remains";
	const state = run.checkpoint;
	if (state.judgeUnavailable === true) return "judgment is unavailable";
	if (state.hold !== undefined) return "an open finding still holds the run";
	if (state.directionPending !== undefined) return "the task direction is unreviewed";
	const completion = state.completion;
	if (completion === undefined || completion.approved !== true || completion.revision !== state.revision) {
		return "the completion check did not approve the current revision";
	}
	const missing = (["business", "architecture"] as const).filter(
		aspect => acceptanceAt(state, aspect)?.approved !== true,
	);
	if (missing.length > 0) return `acceptance has not passed for ${missing.join(" and ")}`;
	const scope = antiSlopScope(state);
	if (scope !== undefined && !scope.quiet) {
		if (!antiSlopStatus(state, scope).complete) return "the external deliverable review is incomplete";
	}
	return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * SQLite plumbing
 * ---------------------------------------------------------------------------------------------- */

interface RunRow {
	id: string;
	body: string;
	digest: string;
	status: string;
	roots: string;
	created_at: number;
	updated_at: number;
}

interface EventRow {
	sequence: number;
	kind: string;
	data: string;
	digest: string;
}

interface BlobRow {
	bytes: Uint8Array;
}

function transaction<T>(database: Database, work: () => T): T {
	database.exec("BEGIN IMMEDIATE");
	try {
		const result = work();
		database.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// The transaction was already closed by SQLite; the original error is the useful one.
		}
		throw error;
	}
}

function columns(database: Database, table: string): string[] {
	const rows = database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
	return rows.map(row => row.name);
}

function sameColumns(found: string[], expected: string[], table: string): void {
	if (found.length !== expected.length || expected.some(name => !found.includes(name))) {
		throw new Error(`autonomy store schema ${table} is incompatible`);
	}
}

function ensureTable(database: Database, table: string): void {
	const row = database.query<{ type: string }, [string]>("SELECT type FROM sqlite_master WHERE name = ?").get(table);
	if (row?.type !== "table") throw new Error(`autonomy store schema ${table} is not a table`);
}

function initializeSchema(database: Database): void {
	transaction(database, () => {
		database.exec(
			"CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, roots TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		);
		database.exec(
			"CREATE TABLE events (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT, sequence INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (run_id, sequence))",
		);
		database.exec("CREATE TABLE blobs (digest TEXT PRIMARY KEY NOT NULL, bytes BLOB NOT NULL)");
		database.exec("CREATE INDEX runs_status ON runs(status)");
		database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	});
}

function verifySchema(database: Database): void {
	const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
	if (version === 0) {
		initializeSchema(database);
		const initialized = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
		if (initialized !== SCHEMA_VERSION) throw new Error("autonomy store could not record its schema version");
	} else if (version !== SCHEMA_VERSION) {
		throw new Error(`autonomy store schema version ${version} is not supported`);
	}
	ensureTable(database, "runs");
	ensureTable(database, "events");
	ensureTable(database, "blobs");
	sameColumns(columns(database, "runs"), RUNS_TABLE, "runs");
	sameColumns(columns(database, "events"), EVENTS_TABLE, "events");
	sameColumns(columns(database, "blobs"), BLOBS_TABLE, "blobs");
}

function configureDatabase(database: Database): void {
	database.exec("PRAGMA busy_timeout = 5000");
	database.exec("PRAGMA journal_mode = DELETE");
	database.exec("PRAGMA synchronous = EXTRA");
	database.exec("PRAGMA foreign_keys = ON");
	const journal = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
	if (journal?.journal_mode?.toLowerCase() !== "delete") {
		throw new Error("autonomy store cannot establish journal_mode=DELETE");
	}
	const synchronous = database.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
	if (synchronous?.synchronous !== 3) throw new Error("autonomy store cannot establish synchronous=EXTRA");
	const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
	if (integrity?.integrity_check !== "ok") throw new Error("autonomy store failed its integrity check");
}

/**
 * Resolve the one real file this store owns. A URI or `:memory:` is refused outright, the file is
 * pre-created with owner-only permissions, and an existing symlink, non-file or looser mode is
 * refused rather than accepted or silently downgraded.
 */
function storeFilePath(file: string): string {
	if (typeof file !== "string" || file.trim() === "" || file === ":memory:" || file.startsWith("file:")) {
		throw new Error("autonomy store requires a private local file path");
	}
	const absolute = resolve(file);
	const directory = dirname(absolute);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let existing = false;
	try {
		const stat = lstatSync(absolute);
		existing = true;
		if (stat.isSymbolicLink()) throw new Error("autonomy store file must not be a symlink");
		if (!stat.isFile()) throw new Error("autonomy store path must be a regular file");
		if ((stat.mode & 0o077) !== 0) throw new Error("autonomy store file permissions are not private");
	} catch (error) {
		if (errorCode(error) !== "ENOENT" || existing) throw error;
	}
	if (!existing) {
		const descriptor = openSync(absolute, "wx", 0o600);
		closeSync(descriptor);
	}
	if ((statSync(absolute).mode & 0o077) !== 0) throw new Error("autonomy store file permissions are not private");
	return absolute;
}

function encodeRun(run: AutonomyRun): string {
	return JSON.stringify({ ...run, checkpoint: encodeCheckpoint(run.checkpoint) });
}

function runRow(row: RunRow): AutonomyRun {
	if (digestText(row.body) !== row.digest) throw new Error(`autonomy run ${row.id} failed its checksum`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.body);
	} catch {
		throw new Error(`autonomy run ${row.id} is not valid JSON`);
	}
	const run = validateRun(parsed);
	if (run.id !== row.id) throw new Error("stored run id does not match its row");
	if (run.status !== row.status) throw new Error("stored run status does not match its row");
	if (JSON.stringify(run.policy.roots) !== row.roots) throw new Error("stored run roots do not match its row");
	if (run.createdAt !== row.created_at || run.updatedAt !== row.updated_at) {
		throw new Error("stored run timestamps do not match its row");
	}
	if (run.status === "completed") {
		const problem = completionProblem(run);
		if (problem !== undefined) throw new Error(`stored completion is not proved: ${problem}`);
	}
	return run;
}

/**
 * An established audience must still cite a decision that is actually journaled for this run. The
 * reference is stored as data, so reload re-proves it instead of trusting a fabricated string.
 */
function assertAudienceRecorded(database: Database, run: AutonomyRun): void {
	const audience = run.audience;
	if (audience === undefined) return;
	const rows = database
		.query<{ sequence: number; kind: string; data: string; digest: string }, [string]>(
			"SELECT sequence, kind, data, digest FROM events WHERE run_id = ?",
		)
		.all(run.id);
	for (const row of rows) {
		const sequence = integer(row.sequence, "event.sequence", 1);
		const kind = nonEmptyText(row.kind, "event.kind");
		if (eventDigest(sequence, kind, row.data) !== row.digest) {
			throw new Error(`autonomy event ${sequence} failed its checksum`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.data);
		} catch {
			throw new Error(`autonomy run ${run.id} has an event that is not valid JSON`);
		}
		if (decisionReference(parsed) === audience.decisionId) return;
	}
	throw new Error(`autonomy run ${run.id} audience decision reference is not journaled`);
}

function loadRun(database: Database, id: string): AutonomyRun {
	const row = database
		.query<RunRow, [string]>("SELECT id, body, digest, status, roots, created_at, updated_at FROM runs WHERE id = ?")
		.get(id);
	if (row === null) throw new Error(`autonomy run ${id} does not exist`);
	const run = runRow(row);
	assertAudienceRecorded(database, run);
	return run;
}

function readBlob(database: Database, digest: string): Uint8Array | null {
	const row = database.query<BlobRow, [string]>("SELECT bytes FROM blobs WHERE digest = ?").get(digest);
	if (row === null) return null;
	const bytes = row.bytes;
	if (digestBytes(bytes) !== digest) throw new Error(`artifact blob ${digest} is corrupt`);
	return bytes;
}

function storeBlob(database: Database, digest: string, bytes: Uint8Array): void {
	const existing = readBlob(database, digest);
	if (existing !== null) {
		if (existing.length !== bytes.length) throw new Error(`artifact blob ${digest} conflicts with existing bytes`);
		return;
	}
	database.query("INSERT INTO blobs(digest, bytes) VALUES (?, ?)").run(digest, bytes);
}

function eventDigest(sequence: number, kind: string, data: string): string {
	return digestText(`${sequence}\n${kind}\n${data}`);
}

function appendEvent(database: Database, runId: string, sequence: number, kind: string, data: unknown): void {
	const kindText = nonEmptyText(kind, "event.kind");
	const serialized: unknown = JSON.stringify(data === undefined ? null : data);
	if (typeof serialized !== "string") throw new Error("event.data must be JSON serializable");
	database
		.query("INSERT INTO events(run_id, sequence, kind, data, digest) VALUES (?, ?, ?, ?, ?)")
		.run(runId, sequence, kindText, serialized, eventDigest(sequence, kindText, serialized));
}

function nextTimestamp(previous: number): number {
	return Math.max(Date.now(), previous + 1);
}

function storePathInsideRoots(roots: string[], file: string): void {
	for (const root of roots) {
		if (pathInside(root, file)) {
			throw new Error("autonomy store database must not live under an executor-writable root");
		}
	}
}

/** Fields shared by an observed scope and a precommitted launch; the only launch identity. */
type LaunchIdentity = Pick<AutonomyScopeLaunch, "runId" | "epoch" | "unit" | "bootId">;

/**
 * Whether an observed scope is the concrete launch one lifecycle spawn intent precommitted. The unit
 * name is unique per run, epoch and random segment, so this identifies exactly one launch.
 */
function sameLaunch(left: LaunchIdentity, launch: unknown): boolean {
	const right = asRecord(launch);
	if (right === undefined) return false;
	return (
		left.runId === right["runId"] &&
		left.epoch === right["epoch"] &&
		left.unit === right["unit"] &&
		left.bootId === right["bootId"]
	);
}

/** The complete precommitted launch of a pending spawn intent, when it has one. */
function launchOf(intent: AutonomyIntent): Record<string, unknown> | undefined {
	if (intent.kind !== "lifecycle") return undefined;
	const payload = asRecord(intent.payload);
	if (payload === undefined || payload["operation"] !== "spawn") return undefined;
	return asRecord(payload["launch"]);
}

/** The recorded producer identity of a spawn intent, when the spawn was observed to start. */
function pendingChild(intent: AutonomyIntent): ProcessIdentity | undefined {
	const payload = asRecord(intent.payload);
	const child = payload?.["child"];
	return isValidIdentity(child) ? child : undefined;
}

/**
 * The pending intents one fence receipt for `scope` proves. A tool intent belongs to the run's one
 * bound scope; a lifecycle spawn intent belongs only to the exact launch it precommitted. A receipt
 * never stamps another scope's intents.
 */
function intentsCoveredBy(run: AutonomyRun, scope: AutonomyScope): string[] {
	const bound = run.scope !== undefined && sameScope(run.scope, scope);
	const ids: string[] = [];
	for (const [intentId, intent] of Object.entries(run.pending)) {
		if (intent.kind === "lifecycle") {
			const launch = launchOf(intent);
			if (launch !== undefined && sameLaunch(scope, launch)) ids.push(intentId);
		} else if (bound) {
			ids.push(intentId);
		}
	}
	return ids.sort();
}

/** The pending spawn intents of exactly this precommitted launch. */
function launchIntentsCoveredBy(run: AutonomyRun, launch: AutonomyScopeLaunch): string[] {
	const ids: string[] = [];
	for (const [intentId, intent] of Object.entries(run.pending)) {
		const recorded = launchOf(intent);
		if (recorded !== undefined && sameLaunch(launch, recorded)) ids.push(intentId);
	}
	return ids.sort();
}

/** Whether the observed empty scope and its receipts prove this exact pending intent cannot execute. */
function intentIsFenced(run: AutonomyRun, intentId: string, intent: AutonomyIntent): boolean {
	if (intent.kind === "lifecycle") {
		const launch = launchOf(intent);
		if (launch === undefined) return false;
		// The bound scope was already observed empty, so a launch it contains is proved quiet.
		if (run.scope !== undefined && sameLaunch(run.scope, launch)) return true;
		if (run.fences.some(fence => fence.intentIds.includes(intentId) && sameLaunch(fence.scope, launch))) return true;
		return run.launchFences.some(
			fence => fence.intentIds.includes(intentId) && sameLaunch(fence.launch, launch),
		);
	}
	// A tool authorization executes inside the run's one bound scope, already observed empty.
	return run.scope !== undefined;
}

/** Whether one pending intent is covered by a positive physical or launch-quiescence receipt. */
export function lifecycleIntentIsFenced(run: AutonomyRun, intentId: string): boolean {
	const intent = run.pending[intentId];
	if (intent === undefined) return true;
	return intentIsFenced(run, intentId, intent);
}

/**
 * Whether this run may still execute native work even though its status is terminal. Cancellation
 * closes admission, but only positive physical evidence releases its roots. An unobservable scope,
 * process or pending intent is held, never assumed dead or resolved.
 */
function mayStillExecute(run: AutonomyRun): boolean {
	if (run.scope !== undefined) {
		try {
			if (!autonomyScopeEmpty(run.scope)) return true;
		} catch {
			return true;
		}
	}
	if (run.child !== undefined) {
		try {
			if (processAlive(run.child)) return true;
		} catch {
			return true;
		}
	}
	return Object.entries(run.pending).some(([intentId, intent]) => !intentIsFenced(run, intentId, intent));
}

/** Whether the actual caller is this run's live supervisor. */
function isActualSupervisor(run: AutonomyRun, actual: ProcessIdentity): boolean {
	return run.owner !== undefined && sameProcessIdentity(run.owner, actual) && processAlive(run.owner);
}

/**
 * Require positive physical evidence that the scope cannot execute. A current-boot scope must still
 * match its observed identity; a scope from another boot is dead by definition and is never signalled.
 */
function requireScopeQuiescent(scope: AutonomyScope): void {
	if (scope.bootId === autonomyBootId()) {
		try {
			assertAutonomyScope(scope);
		} catch (error) {
			// A scope whose unit has already disappeared is positively empty; empty() either proves
			// that from the observed identity or throws on any uncertain live/mismatched state.
			if (!autonomyScopeEmpty(scope)) throw error;
		}
	}
	if (!autonomyScopeEmpty(scope)) throw new Error("scope still contains executable work");
}

/**
 * Every root that is still reserved. Nonterminal runs always reserve their roots; a terminal run
 * keeps them while its scope, child or unknown pre-bind launch can still be executing something.
 */
function reservedRoots(database: Database): string[] {
	const rows = database
		.query<RunRow, []>("SELECT id, body, digest, status, roots, created_at, updated_at FROM runs")
		.all();
	const roots: string[] = [];
	for (const row of rows) {
		const run = runRow(row);
		if (TERMINAL_STATUS[run.status] !== true || mayStillExecute(run)) roots.push(...run.policy.roots);
	}
	return roots;
}

/* -------------------------------------------------------------------------------------------------
 * Store
 * ---------------------------------------------------------------------------------------------- */

/** Open or create the private store. Only this factory path exists; there is no memory fallback. */
export function openAutonomyStore(file: string): AutonomyStore {
	const absolute = storeFilePath(file);
	const database = new Database(absolute, { strict: true, create: true });
	try {
		configureDatabase(database);
		verifySchema(database);
	} catch (error) {
		database.close();
		throw error;
	}
	const storePath = (() => {
		try {
			return realpathSync(absolute);
		} catch (error) {
			database.close();
			throw error;
		}
	})();
	let closed = false;

	const store: AutonomyStore = {
		create(objective, policy) {
			const objectiveText = nonEmptyText(objective, "objective");
			const normalized = normalizePolicy(policy);
			const digest = digestText(JSON.stringify(normalized));
			const now = Date.now();
			const checkpoint = freshState();
			checkpoint.autonomous = true;
			const initialCheckpoint = JSON.stringify(encodeCheckpoint(checkpoint));
			if (Buffer.byteLength(initialCheckpoint, "utf8") > normalized.maxContextBytes) {
				throw new Error("policy.maxContextBytes is too small for a strict checkpoint");
			}
			const run: AutonomyRun = {
				id: randomUUID(),
				objective: objectiveText,
				policy: normalized,
				policyDigest: digest,
				createdAt: now,
				updatedAt: now,
				sequence: 1,
				epoch: 0,
				generation: 0,
				status: "ready",
				checkpoint,
				artifacts: {},
				manifest: {},
				topicManifests: {},
				pending: {},
				fences: [],
				launchFences: [],
				judgeCalls: 0,
				executorCalls: 0,
			};
			return transaction(database, () => {
				const reserved = reservedRoots(database);
				if (rootsOverlap(normalized.roots, reserved)) {
					throw new Error("an active run already owns an overlapping authorized root");
				}
				storePathInsideRoots([...reserved, ...normalized.roots], storePath);
				const body = encodeRun(run);
				database
					.query("INSERT INTO runs(id, body, digest, status, roots, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
					.run(run.id, body, digestText(body), run.status, JSON.stringify(run.policy.roots), run.createdAt, run.updatedAt);
				appendEvent(database, run.id, run.sequence, "create", { policyDigest: run.policyDigest });
				return run;
			});
		},

		read(id) {
			return loadRun(database, id);
		},

		list() {
			const rows = database
				.query<RunRow, []>(
					"SELECT id, body, digest, status, roots, created_at, updated_at FROM runs ORDER BY created_at, id",
				)
				.all();
			return rows.map(row => {
				const run = runRow(row);
				assertAudienceRecorded(database, run);
				return run;
			});
		},

		events(id) {
			// Read the journal first: a later run snapshot can be newer, never older, than this prefix.
			const rows = database
				.query<EventRow, [string]>("SELECT sequence, kind, data, digest FROM events WHERE run_id = ? ORDER BY sequence")
				.all(id);
			const run = loadRun(database, id);
			if (rows.length === 0 || rows[0]?.sequence !== 1) {
				throw new Error(`autonomy run ${id} has no create journal entry`);
			}
			let previous = 0;
			return rows.map(row => {
				const sequence = integer(row.sequence, "event.sequence", 1);
				if (sequence <= previous) throw new Error(`autonomy run ${id} has unordered events`);
				if (sequence > run.sequence) throw new Error(`autonomy run ${id} has an event beyond its sequence`);
				previous = sequence;
				const kind = nonEmptyText(row.kind, "event.kind");
				if (eventDigest(sequence, kind, row.data) !== row.digest) {
					throw new Error(`autonomy event ${sequence} failed its checksum`);
				}
				let data: unknown;
				try {
					data = JSON.parse(row.data);
				} catch {
					throw new Error(`autonomy event ${sequence} is not valid JSON`);
				}
				return { sequence, kind, data };
			});
		},

		decisionContext(id, requestDigest) {
			const run = loadRun(database, id);
			const row = database
				.query<EventRow, [string, string, string]>(
					"SELECT sequence, kind, data, digest FROM events WHERE run_id = ? AND kind = ? AND json_extract(data, '$.requestDigest') = ? ORDER BY sequence DESC LIMIT 1",
				)
				.get(id, "judge.request", requestDigest);
			if (row === null) return null;
			const sequence = integer(row.sequence, "event.sequence", 1);
			if (sequence > run.sequence) throw new Error(`autonomy run ${id} has an event beyond its sequence`);
			const kind = nonEmptyText(row.kind, "event.kind");
			if (kind !== "judge.request") throw new Error(`autonomy event ${sequence} is not a judge request`);
			if (eventDigest(sequence, kind, row.data) !== row.digest) {
				throw new Error(`autonomy event ${sequence} failed its checksum`);
			}
			let data: unknown;
			try {
				data = JSON.parse(row.data);
			} catch {
				throw new Error(`autonomy event ${sequence} is not valid JSON`);
			}
			const request = asRecord(asRecord(data)?.request);
			if (request === undefined) throw new Error(`autonomy event ${sequence} has no judge request payload`);
			if (digestText(JSON.stringify(request)) !== requestDigest) {
				throw new Error(`autonomy event ${sequence} judge request digest does not match its request`);
			}
			return request;
		},

		claim(id, owner) {
			if (!isValidIdentity(owner)) throw new Error("claim requires a native process identity");
			const actual = currentIdentity();
			if (!sameProcessIdentity(owner, actual)) {
				throw new Error("claim owner is not the actual caller");
			}
			return transaction(database, () => {
				const run = loadRun(database, id);
				if (TERMINAL_STATUS[run.status] === true) throw new Error(`autonomy run ${id} is terminal`);
				if (run.owner !== undefined) {
					if (sameProcessIdentity(run.owner, actual)) return run;
					if (processAlive(run.owner)) throw new Error("another live supervisor owns this run");
				}
				const takeover = run.owner !== undefined;
				const previousOwner = run.owner;
				run.epoch += 1;
				run.owner = actual;
				delete run.session;
				delete run.wake;
				delete run.checkpoint.checkPending;
				run.checkpoint.acceptance = [];
				delete run.checkpoint.completion;
				run.status = takeover || Object.keys(run.pending).length > 0 || run.child !== undefined ? "recovering" : "ready";
				run.updatedAt = nextTimestamp(run.updatedAt);
				run.sequence += 1;
				const body = encodeRun(run);
				database
					.query("UPDATE runs SET body = ?, digest = ?, status = ?, updated_at = ? WHERE id = ?")
					.run(body, digestText(body), run.status, run.updatedAt, id);
				appendEvent(database, id, run.sequence, "claim", {
					epoch: run.epoch,
					takeover,
					previousOwner: previousOwner ?? null,
				});
				return run;
			});
		},

		bindScope(id, epoch, scope) {
			const validated = validateStoredScope(scope, "scope");
			if (validated.runId !== id) throw new Error("scope does not belong to this run");
			const actual = currentIdentity();
			return transaction(database, () => {
				const run = loadRun(database, id);
				if (TERMINAL_STATUS[run.status] === true) throw new Error(`autonomy run ${id} is terminal`);
				if (!isActualSupervisor(run, actual)) {
					throw new Error("only the actual current supervisor can bind a scope");
				}
				if (epoch !== run.epoch) throw new Error("bindScope epoch is stale");
				assertAutonomyScope(validated);
				const previous = run.scope;
				if (previous === undefined) {
					if (run.child !== undefined) assertAutonomyScope(validated, run.child);
				} else if (sameScope(previous, validated)) {
					if (run.child !== undefined) assertAutonomyScope(validated, run.child);
					return run;
				} else {
					requireScopeQuiescent(previous);
				}
				run.scope = validated;
				run.updatedAt = nextTimestamp(run.updatedAt);
				run.sequence += 1;
				const body = encodeRun(run);
				database
					.query("UPDATE runs SET body = ?, digest = ?, updated_at = ? WHERE id = ?")
					.run(body, digestText(body), run.updatedAt, id);
				appendEvent(database, id, run.sequence, "scope-bound", validated);
				return run;
			});
		},

		recordFence(id, epoch, scope) {
			const validated = validateStoredScope(scope, "scope");
			if (validated.runId !== id) throw new Error("scope does not belong to this run");
			const actual = currentIdentity();
			return transaction(database, () => {
				const run = loadRun(database, id);
				if (epoch !== run.epoch) throw new Error("recordFence epoch is stale");
				const bound = run.scope;
				const boundMatch = bound !== undefined && sameScope(bound, validated);
				if (!boundMatch) {
					// A pre-bind launch is a recorded candidate only when some pending spawn intent
					// precommitted this exact unit, epoch and boot. Nothing else may be "proved".
					const launched = Object.values(run.pending).some(intent => {
						const launch = launchOf(intent);
						return launch !== undefined && sameLaunch(validated, launch);
					});
					if (!launched) throw new Error("scope does not match the bound scope or a recorded launch intent");
				}
				if (TERMINAL_STATUS[run.status] === true) {
					// An operator may record physical safety proof for an already-cancelled run. The
					// other terminal statuses still require the run's actual supervisor.
					if (run.status !== "cancelled" && !isActualSupervisor(run, actual)) {
						throw new Error("only the actual current supervisor can record a terminal safety fence");
					}
				} else {
					if (!boundMatch) throw new Error("a nonterminal run can fence only its bound scope");
					if (!isActualSupervisor(run, actual)) {
						throw new Error("only the actual current supervisor can record a fence");
					}
				}
				requireScopeQuiescent(validated);
				const generation = run.generation;
				const intentIds = intentsCoveredBy(run, validated);
				const existing = run.fences.find(
					fence =>
						sameScope(fence.scope, validated) &&
						fence.generation === generation &&
						fence.intentIds.length === intentIds.length &&
						fence.intentIds.every((intentId, index) => intentId === intentIds[index]),
				);
				if (existing !== undefined) return run;
				const receipt: AutonomyScopeFence = {
					scope: validated,
					recordedEpoch: epoch,
					generation,
					observedAt: Date.now(),
					intentIds,
				};
				run.fences.push(receipt);
				run.updatedAt = nextTimestamp(run.updatedAt);
				run.sequence += 1;
				const body = encodeRun(run);
				database
					.query("UPDATE runs SET body = ?, digest = ?, updated_at = ? WHERE id = ?")
					.run(body, digestText(body), run.updatedAt, id);
				appendEvent(database, id, run.sequence, "scope-fenced", receipt);
				return run;
			});
		},

		recordLaunchFence(id, epoch, launch, method) {
			const validated = validateLaunchValue(launch, "launch");
			if (validated.runId !== id) throw new Error("launch does not belong to this run");
			if (method !== "unit-unloaded" && method !== "boot-difference") {
				throw new Error("launch quiescence method is not observed");
			}
			const actual = currentIdentity();
			return transaction(database, () => {
				const run = loadRun(database, id);
				if (epoch !== run.epoch) throw new Error("recordLaunchFence epoch is stale");
				// The launch's own epoch is part of its identity: an intent precommitted before a
				// supervisor takeover is still the same exact launch and may be proved quiet now.
				const matching = Object.values(run.pending).find(intent => {
					const recorded = launchOf(intent);
					return recorded !== undefined && sameLaunch(validated, recorded);
				});
				if (matching === undefined) throw new Error("launch does not match a recorded spawn intent");
				if (TERMINAL_STATUS[run.status] === true) {
					// An operator may record local quiescence for an already-cancelled run. The other
					// terminal statuses still require the run's actual supervisor.
					if (run.status !== "cancelled" && !isActualSupervisor(run, actual)) {
						throw new Error("only the actual current supervisor can record a terminal launch fence");
					}
				} else if (!isActualSupervisor(run, actual)) {
					throw new Error("only the actual current supervisor can record a launch fence");
				}
				// A unit being absent now is not future containment: the launch producer could still
				// create it. The receipt is committed only when the producer is causally excluded.
				const producer = pendingChild(matching);
				if (method === "boot-difference") {
					if (validated.bootId === autonomyBootId()) {
						throw new Error("boot-difference requires a launch from another kernel boot");
					}
					if (producer !== undefined && producer.bootId === autonomyBootId() && processAlive(producer)) {
						throw new Error("the launch producer is alive in this boot; a boot difference proves nothing here");
					}
				} else {
					if (validated.bootId !== autonomyBootId()) {
						throw new Error("unit-unloaded requires the current kernel boot");
					}
					const payload = asRecord(matching.payload);
					if (producer === undefined) {
						// Only an explicit never-started marker proves no producer exists. An unknown
						// or already-started intent may still create the unit later.
						if (payload?.["spawnStarted"] === true) {
							throw new Error(
								"the launch producer started but its identity was not recorded; the unit could still be created",
							);
						}
						if (payload?.["spawnStarted"] !== false) {
							throw new Error(
								"the launch producer state is unknown; the unit could still be created",
							);
						}
					} else if (processAlive(producer)) {
						throw new Error("the launch producer is still alive; the unit could still be created");
					}
					if (!autonomyLaunchUnloaded(validated)) {
						throw new Error("launch unit is not provably unloaded");
					}
				}
				if (run.launchFences.some(fence => sameLaunch(fence.launch, validated))) return run;
				const receipt: AutonomyLaunchFence = {
					launch: validated,
					method,
					generation: run.generation,
					observedAt: Date.now(),
					intentIds: launchIntentsCoveredBy(run, validated),
					localOnly: true,
				};
				run.launchFences.push(receipt);
				run.updatedAt = nextTimestamp(run.updatedAt);
				run.sequence += 1;
				const body = encodeRun(run);
				database
					.query("UPDATE runs SET body = ?, digest = ?, updated_at = ? WHERE id = ?")
					.run(body, digestText(body), run.updatedAt, id);
				appendEvent(database, id, run.sequence, "launch-fenced", receipt);
				return run;
			});
		},

		bindChild(id, epoch, child) {
			if (!isValidIdentity(child)) throw new Error("bindChild requires a native process identity");
			const actual = currentIdentity();
			return transaction(database, () => {
				const run = loadRun(database, id);
				if (TERMINAL_STATUS[run.status] === true) throw new Error(`autonomy run ${id} is terminal`);
				const owner = run.owner;
				if (owner === undefined || !isActualSupervisor(run, actual)) {
					throw new Error("only the actual current supervisor can bind a child");
				}
				if (epoch !== run.epoch) throw new Error("bindChild epoch is stale");
				const observed = identityOf(child.pid);
				if (
					observed === null ||
					!sameProcessIdentity(observed, child) ||
					!processAlive(child)
				) {
					throw new Error("child process identity is not the live caller-observed process");
				}
				if (child.parent !== owner.pid) throw new Error("child is not parented by the supervisor");
				if (child.group !== child.pid) throw new Error("child must lead its own process group");
				if (child.group === owner.group) throw new Error("child must not share the supervisor's process group");
				if (run.scope !== undefined) assertAutonomyScope(run.scope, child);
				const previous = run.child;
				if (previous !== undefined) {
					if (sameProcessIdentity(previous, child)) return run;
					if (processAlive(previous)) throw new Error("the previous child is still alive");
					// A group number alone cannot identify a process across kernel boots. A group from
					// another boot belongs to a kernel that no longer runs; a live group with that
					// number is an unrelated reused group, not the old executor.
					if (previous.bootId === autonomyBootId() && processGroupAlive(previous.group)) {
						throw new Error("the previous child's process group is still alive");
					}
				}
				run.child = child;
				delete run.session;
				delete run.wake;
				delete run.checkpoint.checkPending;
				run.checkpoint.acceptance = [];
				delete run.checkpoint.completion;
				run.updatedAt = nextTimestamp(run.updatedAt);
				run.sequence += 1;
				const body = encodeRun(run);
				database
					.query("UPDATE runs SET body = ?, digest = ?, updated_at = ? WHERE id = ?")
					.run(body, digestText(body), run.updatedAt, id);
				appendEvent(database, id, run.sequence, "bind_child", { child, epoch: run.epoch });
				return run;
			});
		},

		bindSession(id, epoch, session) {
			const sessionId = nonEmptyText(session.id, "session.id");
			const sessionFile = nonEmptyText(session.file, "session.file");
			const actual = currentIdentity();
			return transaction(database, () => {
				const run = loadRun(database, id);
				if (TERMINAL_STATUS[run.status] === true) throw new Error(`autonomy run ${id} is terminal`);
				const owner = run.owner;
				if (owner === undefined || !isActualSupervisor(run, actual)) {
					throw new Error("only the actual current supervisor can bind a session");
				}
				if (epoch !== run.epoch) throw new Error("bindSession epoch is stale");
				const boundChild = run.child;
				if (boundChild === undefined) throw new Error("no child is bound to this run");
				if (boundChild.parent !== owner.pid) {
					throw new Error("the bound child is not parented by the current supervisor; bind a fenced child first");
				}
				const observed = identityOf(boundChild.pid);
				if (observed === null || !sameProcessIdentity(observed, boundChild) || !processAlive(boundChild)) {
					throw new Error("the bound child is not the live process");
				}
				if (run.scope !== undefined) assertAutonomyScope(run.scope, boundChild);
				const current = run.session;
				if (current !== undefined && current.id === sessionId && current.file === sessionFile) return run;
				run.generation += 1;
				run.session = { id: sessionId, file: sessionFile };
				delete run.wake;
				delete run.checkpoint.checkPending;
				run.checkpoint.acceptance = [];
				delete run.checkpoint.completion;
				// Execution acceptance belongs to the newly bound session, not its predecessor's log.
				run.checkpoint.actions = [];
				run.checkpoint.actionsSinceCheck = 0;
				run.updatedAt = nextTimestamp(run.updatedAt);
				run.sequence += 1;
				const body = encodeRun(run);
				database
					.query("UPDATE runs SET body = ?, digest = ?, updated_at = ? WHERE id = ?")
					.run(body, digestText(body), run.updatedAt, id);
				appendEvent(database, id, run.sequence, "bind_session", { session: run.session, generation: run.generation });
				return run;
			});
		},

		update(id, access, mutator, events = [], artifacts = {}) {
			const accessRecord = record(access, "access");
			const requestedEpoch = integer(accessRecord.epoch, "access.epoch");
			const actual = currentIdentity();
			return transaction(database, () => {
				const run = loadRun(database, id);
				if (TERMINAL_STATUS[run.status] === true) throw new Error(`autonomy run ${id} is terminal`);
				if (requestedEpoch !== run.epoch) throw new Error("update epoch is stale");
				const owner = run.owner;
				const boundChild = run.child;
				const session = run.session;
				const supervisor = isActualSupervisor(run, actual);
				const child = boundChild !== undefined && sameProcessIdentity(boundChild, actual) && processAlive(boundChild);
				if (supervisor) {
					// The native supervisor identity is the access proof; no session is required.
				} else if (child) {
					if (owner === undefined || !processAlive(owner)) {
						throw new Error("the supervisor is not alive; the run needs recovery");
					}
					if (session === undefined) throw new Error("a child write requires a bound session");
					if (accessRecord.sessionId !== session.id) throw new Error("child session does not match the bound session");
					if (accessRecord.generation !== run.generation) throw new Error("child session generation is stale");
				} else {
					throw new Error("the caller has no bound access to this run");
				}
				const immutable = {
					id: run.id,
					objective: run.objective,
					policy: JSON.stringify(run.policy),
					policyDigest: run.policyDigest,
					audience: JSON.stringify(run.audience),
					createdAt: run.createdAt,
					sequence: run.sequence,
					epoch: run.epoch,
					generation: run.generation,
					owner: JSON.stringify(run.owner),
					child: JSON.stringify(run.child),
					session: JSON.stringify(run.session),
					scope: JSON.stringify(run.scope),
					fences: JSON.stringify(run.fences),
					launchFences: JSON.stringify(run.launchFences),
					judgeCalls: run.judgeCalls,
					executorCalls: run.executorCalls,
				};
				const returned = mutator(run) as unknown;
				if (returned instanceof Promise) {
					void returned.catch(() => undefined);
					throw new Error("the update mutator must be synchronous");
				}
				if (run.id !== immutable.id) throw new Error("the mutator cannot change the run id");
				if (run.objective !== immutable.objective) throw new Error("the mutator cannot change the objective");
				if (JSON.stringify(run.policy) !== immutable.policy) throw new Error("the mutator cannot change the policy");
				if (run.policyDigest !== immutable.policyDigest) throw new Error("the mutator cannot change the policy digest");
				if (run.createdAt !== immutable.createdAt) throw new Error("the mutator cannot change the creation time");
				if (run.sequence !== immutable.sequence) throw new Error("the mutator cannot change the sequence");
				if (run.epoch !== immutable.epoch) throw new Error("the mutator cannot change the epoch");
				if (run.generation !== immutable.generation) throw new Error("the mutator cannot change the generation");
				if (JSON.stringify(run.owner) !== immutable.owner) throw new Error("the mutator cannot change the owner");
				if (JSON.stringify(run.child) !== immutable.child) throw new Error("the mutator cannot change the child");
				if (JSON.stringify(run.session) !== immutable.session) throw new Error("the mutator cannot change the session");
				if (JSON.stringify(run.scope) !== immutable.scope) throw new Error("the mutator cannot change the scope");
				if (JSON.stringify(run.fences) !== immutable.fences) throw new Error("the mutator cannot change the fences");
				if (JSON.stringify(run.launchFences) !== immutable.launchFences) {
					throw new Error("the mutator cannot change the launch fences");
				}
				const audienceJson = immutable.audience;
				const audienceBefore =
					audienceJson === undefined ? undefined : validateAudience(JSON.parse(audienceJson), run.objective, "run.audience");
				const audienceAfter =
					run.audience === undefined ? undefined : validateAudience(run.audience, run.objective, "run.audience");
				if (audienceBefore !== undefined) {
					if (audienceAfter === undefined || JSON.stringify(audienceAfter) !== JSON.stringify(audienceBefore)) {
						throw new Error("the mutator cannot change the audience");
					}
				} else if (audienceAfter !== undefined && !supervisor) {
					throw new Error("only the actual current supervisor can establish the audience");
				}
				if (audienceAfter === undefined) delete run.audience;
				else run.audience = audienceAfter;
				const status = text(run.status, "run.status");
				if (STATUS_NAMES[status] !== true) throw new Error(`run.status ${status} is unknown`);
				run.judgeCalls = integer(run.judgeCalls, "run.judgeCalls");
				run.executorCalls = integer(run.executorCalls, "run.executorCalls");
				if (run.judgeCalls < immutable.judgeCalls) throw new Error("judge calls cannot be reset");
				if (run.executorCalls < immutable.executorCalls) throw new Error("executor calls cannot be reset");
				if (run.judgeCalls > run.policy.maxJudgeCalls) throw new Error("judge call limit is exhausted");
				if (run.executorCalls > run.policy.maxExecutorCalls) throw new Error("executor call limit is exhausted");
				const checkpointRecord = record(run.checkpoint, "run.checkpoint");
				if (!(checkpointRecord.refusedCalls instanceof Map)) {
					throw new Error("run.checkpoint.refusedCalls must be a Map");
				}
				const checkpointJson = JSON.stringify(encodeCheckpoint(run.checkpoint));
				if (Buffer.byteLength(checkpointJson, "utf8") > run.policy.maxContextBytes) {
					throw new Error("checkpoint exceeds the authorized context limit");
				}
				let checkpointValue: unknown;
				try {
					checkpointValue = JSON.parse(checkpointJson);
				} catch {
					throw new Error("checkpoint is not JSON serializable");
				}
				run.checkpoint = decodeCheckpoint(checkpointValue);
				run.pending = validatePending(run.pending);
				if (run.scope !== undefined) run.scope = validateStoredScope(run.scope, "run.scope");
				run.fences = validateFences(run.fences);
				run.launchFences = validateLaunchFences(run.launchFences);
				run.artifacts = validateAliases(run.artifacts, "run.artifacts");
				run.manifest = validateStringMap(run.manifest, "run.manifest");
				run.topicManifests = validateTopicManifests(run.topicManifests);
				if (run.wake !== undefined) {
					const wake = validateWake(run.wake);
					run.wake = wake;
					if (wake.epoch !== run.epoch) throw new Error("wake epoch does not match the run");
					if (wake.generation !== run.generation) throw new Error("wake generation is stale");
					if (session === undefined || wake.sessionId !== session.id) {
						throw new Error("wake does not name the bound main session");
					}
				}
				if (run.waiting !== undefined) run.waiting = validateWait(run.waiting);
				for (const [url, bytes] of Object.entries(artifacts)) {
					safeKey(url, "artifacts");
					if (url === "") throw new Error("artifact alias must not be empty");
					if (!(bytes instanceof Uint8Array)) throw new Error(`artifact ${url} must be exact bytes`);
					if (bytes.length > run.policy.maxArtifactBytes) {
						throw new Error(`artifact ${url} exceeds the authorized artifact limit`);
					}
					const digest = digestBytes(bytes);
					storeBlob(database, digest, bytes);
					run.artifacts[url] = digest;
				}
				if (TERMINAL_STATUS[run.status] === true) delete run.wake;
				if (run.status === "completed") {
					const problem = completionProblem(run);
					if (problem !== undefined) throw new Error(`completion is not proved: ${problem}`);
				}
				run.updatedAt = nextTimestamp(run.updatedAt);
				const base = run.sequence + 1;
				const eventRecords = events.map((entry, index) => {
					const event = record(entry, `events[${index}]`);
					return { kind: nonEmptyText(event.kind, `events[${index}].kind`), data: event.data };
				});
				const establishing = audienceBefore === undefined ? audienceAfter : undefined;
				if (establishing !== undefined) {
					const decisionId = establishing.decisionId;
					if (!eventRecords.some(entry => decisionReference(entry.data) === decisionId)) {
						throw new Error("audience establishment requires the recorded decision event in the same update");
					}
				}
				run.sequence = base + Math.max(0, eventRecords.length - 1);
				const body = encodeRun(run);
				database
					.query("UPDATE runs SET body = ?, digest = ?, status = ?, updated_at = ? WHERE id = ?")
					.run(body, digestText(body), run.status, run.updatedAt, id);
				eventRecords.forEach((entry, index) => appendEvent(database, id, base + index, entry.kind, entry.data));
				return run;
			});
		},

		artifact(id, url) {
			const run = store.read(id);
			const digest = run.artifacts[url];
			if (digest === undefined) return null;
			const bytes = readBlob(database, digest);
			if (bytes === null) throw new Error(`artifact blob ${digest} is missing`);
			return bytes;
		},

		cancel(id, reason) {
			return transaction(database, () => {
				const run = loadRun(database, id);
				if (TERMINAL_STATUS[run.status] === true) return run;
				run.status = "cancelled";
				delete run.wake;
				run.updatedAt = nextTimestamp(run.updatedAt);
				run.sequence += 1;
				const body = encodeRun(run);
				database
					.query("UPDATE runs SET body = ?, digest = ?, status = ?, updated_at = ? WHERE id = ?")
					.run(body, digestText(body), run.status, run.updatedAt, id);
				appendEvent(database, id, run.sequence, "cancel", { reason, pending: Object.keys(run.pending) });
				return run;
			});
		},

		close() {
			if (closed) return;
			closed = true;
			database.close();
		},
	};
	return store;
}
