/**
 * Per-session gate state and the digests that bind an approval to concrete work.
 *
 * The state lives in memory for the session: a host restart loses an approval and the gate closes
 * again, which is the safe direction (approvals are never restored from disk and never inferred).
 */
import { createHash } from "node:crypto";
import { POLICY, PLAN_BOUNDARY, type Aspect, type PlanTopic } from "./types.js";
/** The development task the gate belongs to. */
export interface TaskIdentity {
	/** SHA-256 of the request text; the approval ledger is keyed by it. */
	fingerprint: string;
	request: string;
}

/** A plan approval, bound to one task and one exact artifact content. */
export interface PlanApproval {
	taskFingerprint: string;
	planUrl: string;
	planDigest: string;
	confidence: number;
}

/** One acceptance verdict for one aspect at one work revision. */
export interface AcceptanceRecord {
	aspect: Aspect;
	revision: number;
	label: string;
	approved: boolean;
	confidence: number;
}

/** One successful consequential action, kept as evidence for the course and completion checks. */
export interface ActionRecord {
	tool: string;
	target: string;
	excerpt: string;
}

/** The last course check and what it said. */
export interface CourseCheckRecord {
	revision: number;
	label: string;
	approved: boolean;
	confidence: number;
}

/** The last completion check and what it said. */
export interface CompletionRecord {
	revision: number;
	label: string;
	approved: boolean;
	confidence: number;
}

/** The stop-block ledger for one unchanged refusal. */
export interface StopRecord {
	signature: string;
	blocks: number;
}

/** One judged submission: the material's digest and the verdict it received (FR-22). */
export interface SubmissionRecord {
	/** The boundary that judged it, so one boundary's refusals never block another's. */
	boundary: string;
	/** SHA-256 of the material as submitted. */
	digest: string;
	/** The verdict the judge returned, or the refusal that replaced it. */
	verdict: string;
}

/** A boundary released because its refusal bound was exhausted (FR-23). */
export interface OpenItemRecord {
	boundary: string;
	attempts: number;
	digests: string[];
}

/** The consequential calls one standing boundary refused (FR-28). */
export interface RefusedCalls {
	boundary: string;
	count: number;
	calls: string[];
}

/** The first recorded action whose target left the approved plan's topics (FR-25). */
export interface Deviation {
	tool: string;
	target: string;
	revision: number;
}

/** Everything the gates read and write for one session. */
export interface JevState {
	task?: TaskIdentity;
	/** The request triage confirmed simple: consequential changes pass without the complex stages. */
	simple?: TaskIdentity;
	plan?: PlanApproval;
	/** The approved plan's topics: one judge question each, and the paths the course check compares (FR-24, FR-25). */
	planTopics: PlanTopic[];
	/** Count of successful consequential changes; a change invalidates stale approvals. */
	revision: number;
	/** Consequential actions since the last course check. */
	actionsSinceCheck: number;
	/** A course check is in flight: consequential changes wait for its verdict. */
	checkPending?: boolean;
	/** A finding that holds consequential changes until the executor consults. */
	hold?: { reason: string };
	actions: ActionRecord[];
	/** Consecutive judge calls that failed for availability, reset by any usable answer (FR-21). */
	judgeFailures: number;
	/** The judge is unavailable for this session: the boundaries pass without an answer (FR-21). */
	judgeUnavailable?: true;
	/** The owner has been told the judge is unavailable; cleared when a usable answer restores it. */
	judgeUnavailableNotified?: true;
	/** The open item signature the owner has already been told about (FR-23). */
	openItemNotified?: string;
	/** The material every refusal judged, so a repeated framing is recognised (FR-22). */
	submissions: SubmissionRecord[];
	/** A boundary released after its refusal bound was exhausted (FR-23). */
	openItem?: OpenItemRecord;
	/** The boundaries released for the current request (FR-23). */
	released: string[];
	/** The consequential calls one standing boundary refused (FR-28). */
	refusedCalls: RefusedCalls;
	/** The first action whose target left the approved plan (FR-25). */
	deviation?: Deviation;
	courseCheck?: CourseCheckRecord;
	completion?: CompletionRecord;
	acceptance: AcceptanceRecord[];
	stop?: StopRecord;
}

export function freshState(): JevState {
	return {
		revision: 0,
		actionsSinceCheck: 0,
		actions: [],
		acceptance: [],
		planTopics: [],
		submissions: [],
		released: [],
		refusedCalls: { boundary: "", count: 0, calls: [] },
		judgeFailures: 0,
	};
}

/** SHA-256 in hex; the fingerprint and the artifact binding are both built from it. */
export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Drop every approval, verdict and record that belonged to the previous request. */
function clearWork(state: JevState): void {
	delete state.task;
	delete state.simple;
	delete state.plan;
	state.planTopics = [];
	delete state.hold;
	delete state.openItem;
	delete state.deviation;
	delete state.courseCheck;
	delete state.completion;
	delete state.stop;
	state.acceptance = [];
	state.actions = [];
	state.submissions = [];
	state.released = [];
	state.refusedCalls = { boundary: "", count: 0, calls: [] };
	state.revision = 0;
	state.actionsSinceCheck = 0;
}

/**
 * Register the development task under a fingerprint of its request. A different request starts
 * fresh work, so every approval and verdict of the previous task is dropped.
 */
export function registerTask(state: JevState, request: string): TaskIdentity {
	const fingerprint = sha256(request.trim());
	if (state.simple === undefined && state.task?.fingerprint === fingerprint) return state.task;
	clearWork(state);
	state.task = { fingerprint, request };
	return state.task;
}

/**
 * The owner's interjection re-aims the registered task (FR-29): every approval and record of the
 * previous course is dropped, but the released boundaries stay released and the plan boundary is
 * released for the new course - the owner's order replaces the plan review for the re-aim itself,
 * and nothing here approves anything the old course refused.
 */
export function reaimTask(state: JevState, request: string): TaskIdentity {
	const released = state.released.includes(PLAN_BOUNDARY) ? state.released : [...state.released, PLAN_BOUNDARY];
	clearWork(state);
	state.released = released;
	state.task = { fingerprint: sha256(request.trim()), request };
	return state.task;
}

/**
 * Record a request triage confirmed simple. The verdict belongs to that request and ends any
 * registered development task, so consequential changes pass without the complex stages.
 */
export function registerSimple(state: JevState, request: string): TaskIdentity {
	clearWork(state);
	state.simple = { fingerprint: sha256(request.trim()), request };
	return state.simple;
}

/** The acceptance verdict for one aspect at the current revision, if recorded. */
export function acceptanceAt(state: JevState, aspect: Aspect): AcceptanceRecord | undefined {
	return state.acceptance.find(record => record.aspect === aspect && record.revision === state.revision);
}

/** Record one acceptance verdict, replacing the earlier record for that aspect. */
export function recordAcceptance(state: JevState, record: AcceptanceRecord): void {
	state.acceptance = state.acceptance.filter(existing => existing.aspect !== record.aspect);
	state.acceptance.push(record);
}

/**
 * Record one action as evidence for the course and completion checks. A verification command
 * (`bumpsRevision` false) is evidence without consequences: it moves no revision, advances no check
 * interval and invalidates no completion - the executor is required to verify and must not be
 * punished for it.
 */
export function recordAction(state: JevState, action: ActionRecord, bumpsRevision: boolean = true): void {
	state.actions = [...state.actions, action].slice(-POLICY.maxActionRecords);
	if (!bumpsRevision) return;
	state.revision += 1;
	state.actionsSinceCheck += 1;
	delete state.completion;
}

/**
 * Count one blocked stop for an unchanged refusal. The count allows POLICY.maxStopBlocks blocks;
 * beyond that the refusal is recorded as an open item instead of looping on the same framing.
 */
export function recordStopBlock(state: JevState, signature: string): { block: boolean; blocks: number } {
	const blocks = state.stop?.signature === signature ? state.stop.blocks + 1 : 1;
	state.stop = { signature, blocks };
	return { block: blocks <= POLICY.maxStopBlocks, blocks };
}

/**
 * Record one refusal at a boundary with the digest of the material it judged (FR-22), and release the
 * boundary as an open item as soon as the refusal bound is reached (FR-23), so a judge that will not
 * pass a submission never holds the work indefinitely. The release approves nothing.
 */
export function recordRefusal(state: JevState, record: SubmissionRecord): void {
	state.submissions = [...state.submissions, record].slice(-POLICY.maxSubmissions);
	const refusals = state.submissions.filter(entry => entry.boundary === record.boundary);
	if (refusals.length >= POLICY.maxRefusalsPerStage && !state.released.includes(record.boundary)) {
		releaseBoundary(state, record.boundary);
	}
}

/**
 * What the ledger says about one material at one boundary, before any judge call (FR-22): whether
 * this exact framing was judged there already, how many submissions that boundary has taken, and
 * whether the bound is exhausted so the hold has to be released instead of repeated (FR-23).
 */
export function submissionLedger(
	state: JevState,
	boundary: string,
	digest: string,
): { repeat: boolean; attempts: number; exhausted: boolean } {
	const judged = state.submissions.filter(entry => entry.boundary === boundary);
	return {
		repeat: judged.some(entry => entry.digest === digest),
		attempts: judged.length,
		exhausted: judged.length >= POLICY.maxRefusalsPerStage,
	};
}

/**
 * Release a boundary after its refusal bound was exhausted: the request stops waiting for a decision
 * the executor cannot obtain, the refusal stays recorded as an open item with its numbers, and
 * nothing is approved (FR-23).
 */
export function releaseBoundary(state: JevState, boundary: string): OpenItemRecord {
	const refused = state.submissions.filter(entry => entry.boundary === boundary);
	const openItem: OpenItemRecord = {
		boundary,
		attempts: refused.length,
		digests: refused.map(entry => entry.digest),
	};
	state.openItem = openItem;
	state.released = [...state.released, boundary];
	return openItem;
}

/** Count one consequential call a standing boundary refused, and keep the call it named (FR-28). */
export function recordRefusedCall(state: JevState, boundary: string, call: string): number {
	const same = state.refusedCalls.boundary === boundary;
	const count = same ? state.refusedCalls.count + 1 : 1;
	const calls = same ? [...state.refusedCalls.calls, call] : [call];
	state.refusedCalls = { boundary, count, calls: calls.slice(-POLICY.maxIgnoredBoundaryCalls * 2) };
	return count;
}

/** Remember the first action whose target left the approved plan's topics (FR-25). */
export function markDeviation(state: JevState, tool: string, target: string): void {
	if (state.deviation === undefined) state.deviation = { tool, target, revision: state.revision };
}
