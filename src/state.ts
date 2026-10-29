/**
 * Per-session gate state and the digests that bind an approval to concrete work.
 *
 * The state lives in memory for the session: a host restart loses an approval and the gate closes
 * again, which is the safe direction (approvals are never restored from disk and never inferred).
 */
import { createHash } from "node:crypto";
import {
	PLAN_BOUNDARY,
	POLICY,
	type AntiSlopFinding,
	type AntiSlopReviewRecord,
	type AntiSlopWaiver,
	type Aspect,
	type PlanOutlineStep,
	type PlanTopic,
} from "./types.js";
import { namesExternalDeliverable, weightOf, type RequestWeight } from "./screen.js";
/** The development task the gate belongs to. */
export interface TaskIdentity {
	/** SHA-256 of the request text; the approval ledger is keyed by it. */
	fingerprint: string;
	request: string;
	/** The deliverable is intended for an audience outside the project (FR-45). */
	external?: boolean;
}

/** A plan approval, bound to one task and one exact artifact content. */
export interface PlanApproval {
	taskFingerprint: string;
	planUrl: string;
	planDigest: string;
	confidence: number;
}

/** The task-bound partial state retained between plan-review stages. */
export interface PlanDraft {
	taskFingerprint: string;
	requirementsDigest: string;
	steps: PlanOutlineStep[];
	outlineApproved: boolean;
	details: PlanTopic[];
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

/** A boundary whose refusal budget is spent, kept as the OPEN item the owner has to settle (FR-23). */
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

/** The course check in flight, and the task/revision whose verdict it is allowed to record. */
export interface PendingCheck {
	taskFingerprint?: string;
	revision: number;
}

/** Everything the gates read and write for one session. */
export interface JevState {
	task?: TaskIdentity;
	/** The approved obligations of the registered task. */
	requirementsApproval?: { taskFingerprint: string; items: string[] };
	/** The request triage confirmed simple: read-only work needs no deeper workflow, nothing more. */
	simple?: TaskIdentity;
	/**
	 * The screen's reading of the current request. It decides whether the request has to enter the
	 * workflow at all, and it is set when the prompt arrives, so it is not work state and survives
	 * the clearing a triage verdict performs.
	 */
	request?: { text: string; weight: RequestWeight };
	plan?: PlanApproval;
	/** The approved plan's topics: one judge question each, and the paths the course check compares (FR-24, FR-25). */
	planTopics: PlanTopic[];
	/** Partial outline and detail approvals, bound to the task and approved requirements. */
	planDraft?: PlanDraft;
	/** Count of successful consequential changes; a change invalidates stale approvals. */
	revision: number;
	/** Consequential actions since the last course check. */
	actionsSinceCheck: number;
	/** A course check is in flight; consequential changes wait for its verdict. */
	checkPending?: PendingCheck;
	/** A finding that holds consequential changes until the executor consults. */
	hold?: { reason: string };
	/**
	 * The owner's latest message arrived while the task was active. Its words may name a new course,
	 * so the direction is undecided until a judged re-aim replaces the task; nothing else opens it.
	 */
	directionPending?: { text: string };
	actions: ActionRecord[];
	/** Consecutive judge calls that failed for availability, reset by any usable answer (FR-21). */
	judgeFailures: number;
	/** Availability attempts are exhausted; continuation is permitted without a judge approval (FR-21). */
	judgeUnavailable?: true;
	/** The owner has been told the judge is unavailable; cleared when a usable answer restores it. */
	judgeUnavailableNotified?: true;
	/** The open item signature the owner has already been told about (FR-23). */
	openItemNotified?: string;
	/** The material every refusal judged, so a repeated framing is recognised (FR-22). The counts are permanent for the task. */
	submissions: SubmissionRecord[];
	/** The boundary whose refusal budget is spent (FR-23). */
	openItem?: OpenItemRecord;
	/**
	 * Boundaries whose refusal budget is spent. The finding remains OPEN while the controller
	 * permits continuation of the current request without manufacturing approval (FR-23).
	 */
	exhausted: string[];
	/** The consequential calls one standing boundary refused (FR-28). */
	refusedCalls: RefusedCalls;
	/** The first action whose target left the approved plan (FR-25). */
	deviation?: Deviation;
	courseCheck?: CourseCheckRecord;
	completion?: CompletionRecord;
	acceptance: AcceptanceRecord[];
	stop?: StopRecord;
	/** Permission to continue this request with unresolved findings; never a Jev approval. */
	continuation?: { taskFingerprint?: string; request: string; reason: string };
	/** Recorded external-artifact review parts, newest last (FR-45..FR-56). */
	antiSlopReviews: AntiSlopReviewRecord[];
	/** Owner waivers for individual anti-slop findings (FR-54). */
	antiSlopWaivers: AntiSlopWaiver[];
	/** The advisory anti-slop disclosure already sent for this revision and finding set. */
	antiSlopNotice?: string;
}

export function freshState(): JevState {
	return {
		revision: 0,
		actionsSinceCheck: 0,
		actions: [],
		acceptance: [],
		planTopics: [],
		submissions: [],
		exhausted: [],
		refusedCalls: { boundary: "", count: 0, calls: [] },
		judgeFailures: 0,
		antiSlopReviews: [],
		antiSlopWaivers: [],
	};
}

export function allowContinuation(state: JevState, reason: string): void {
	state.continuation = { taskFingerprint: state.task?.fingerprint, request: state.request?.text ?? "", reason };
}

export function continuationAllowed(state: JevState): boolean {
	return state.continuation !== undefined &&
		state.continuation.taskFingerprint === state.task?.fingerprint &&
		state.continuation.request === (state.request?.text ?? "");
}

/** SHA-256 in hex; the fingerprint and the artifact binding are both built from it. */
export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** A changed plan invalidates every verdict that evaluated the previous plan, not owner permission. */
export function invalidatePlan(state: JevState): void {
	delete state.plan;
	state.planTopics = [];
	state.acceptance = [];
	delete state.completion;
}

/**
 * The key an exhausted boundary is recorded under. Every plan-review stage closes the one plan
 * boundary, so exhausting a stage blocks the whole plan for the task; every other boundary keeps its
 * own key, so one spent budget never blocks an unrelated decision.
 */
export function boundaryKey(boundary: string): string {
	return boundary.startsWith(`${PLAN_BOUNDARY}:`) ? PLAN_BOUNDARY : boundary;
}

/** Drop every approval, verdict, retry and exhaustion marker that belonged to the previous task. */
function clearWork(state: JevState): void {
	delete state.task;
	delete state.simple;
	delete state.requirementsApproval;
	delete state.planDraft;
	delete state.plan;
	delete state.hold;
	delete state.directionPending;
	delete state.openItem;
	delete state.openItemNotified;
	delete state.checkPending;
	delete state.deviation;
	delete state.courseCheck;
	delete state.completion;
	delete state.stop;
	delete state.continuation;
	state.acceptance = [];
	state.actions = [];
	state.submissions = [];
	state.exhausted = [];
	state.planTopics = [];
	state.refusedCalls = { boundary: "", count: 0, calls: [] };
	state.antiSlopReviews = [];
	state.antiSlopWaivers = [];
	delete state.antiSlopNotice;
	state.revision = 0;
	state.actionsSinceCheck = 0;
}

/**
 * Register the development task under a fingerprint of its request. A different request starts
 * fresh work, so every approval, refusal and exhaustion of the previous task is dropped - a new
 * request never inherits an old approval or an old bypass.
 */
export function registerTask(state: JevState, request: string, external = false): TaskIdentity {
	const fingerprint = sha256(request.trim());
	if (state.simple === undefined && state.task?.fingerprint === fingerprint) return state.task;
	clearWork(state);
	state.task = { fingerprint, request, external };
	return state.task;
}

/**
 * The owner's interjection re-aims the registered task (FR-29): every approval, refusal and
 * exhaustion of the previous course is dropped, but nothing is approved - the re-aimed task needs a
 * fresh plan, and the plan boundary is not marked exhausted on its behalf.
 */
export function reaimTask(state: JevState, request: string, external = false): TaskIdentity {
	clearWork(state);
	state.task = { fingerprint: sha256(request.trim()), request, external };
	return state.task;
}

/**
 * Drop a finished task when its completion check approved the current revision: the next prompt is a
 * new request and may be triaged on its own. An unfinished task is kept, so a later prompt cannot
 * open its walls.
 */
export function clearFinishedTask(state: JevState): boolean {
	if (state.task === undefined) return false;
	if (state.hold !== undefined) return false;
	if (state.completion?.approved !== true || state.completion.revision !== state.revision) return false;
	clearWork(state);
	return true;
}

/**
 * Record a request triage confirmed simple. The verdict belongs to that request and ends any
 * registered development task; read-only work then needs no further workflow, and every
 * consequential call is still judged on its own payload before it runs.
 */
export function registerSimple(state: JevState, request: string, external = false): TaskIdentity {
	clearWork(state);
	state.simple = { fingerprint: sha256(request.trim()), request, external };
	return state.simple;
}

/**
 * Read the request once, for free, when the prompt arrives (`screen.ts`). The reading decides
 * whether the request has to enter the judged workflow; it costs no call and it is deliberately the
 * cheap half of the decision, with the judge answering the expensive half if the request enters.
 */
export function screenRequest(state: JevState, request: string): RequestWeight {
	state.request = { text: request, weight: weightOf(request) };
	return state.request.weight;
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
 * Record a consequential call that failed. It may still have touched the working tree (`rm` followed
 * by a failing command, a partial write), so it moves the revision and keeps its evidence - but it
 * advances no check interval, because a failed call is not progress to judge.
 */
export function recordFailedAction(state: JevState, action: ActionRecord): void {
	state.actions = [...state.actions, action].slice(-POLICY.maxActionRecords);
	state.revision += 1;
	delete state.completion;
}

/**
 * Count one blocked stop for an unchanged refusal. The count allows POLICY.maxStopBlocks continuing
 * blocks before the refusal is delivered as an OPEN item; a blocked stop never settles the session.
 */
export function recordStopBlock(state: JevState, signature: string): { blocks: number; exhausted: boolean } {
	const blocks = state.stop?.signature === signature ? state.stop.blocks + 1 : 1;
	state.stop = { signature, blocks };
	return { blocks, exhausted: blocks > POLICY.maxStopBlocks };
}

/**
 * Record one refusal at a boundary with the digest of the material it judged (FR-22). The ledger is
 * permanent for the task, so a refusal never falls out of the count. Once the budget is spent the
 * boundary is recorded as OPEN and continuation is permitted without approval (FR-23).
 */
export function recordRefusal(state: JevState, record: SubmissionRecord): void {
	state.submissions = [...state.submissions, record];
	const refusals = state.submissions.filter(entry => entry.boundary === record.boundary);
	if (refusals.length >= POLICY.maxRefusalsPerStage && !state.exhausted.includes(boundaryKey(record.boundary))) {
		exhaustBoundary(state, record.boundary);
	}
}

/**
 * What the ledger says about one material at one boundary, before any judge call (FR-22): whether
 * this exact framing was judged there already, how many submissions that boundary has taken, and
 * whether the budget is spent (FR-23). Exhaustion is read from its own record, so it survives any
 * later change to the submission history.
 */
export function submissionLedger(
	state: JevState,
	boundary: string,
	digest: string,
): { repeat: boolean; attempts: number; exhausted: boolean } {
	const judged = state.submissions.filter(entry => entry.boundary === boundary);
	const attempts = judged.length;
	return {
		repeat: judged.some(entry => entry.digest === digest),
		attempts,
		exhausted: state.exhausted.includes(boundaryKey(boundary)) || attempts >= POLICY.maxRefusalsPerStage,
	};
}

/**
 * Record a spent refusal budget as OPEN and permit continuation of this request.
 * Refusals stay recorded with their digests; no plan or acceptance is approved (FR-23).
 */
export function exhaustBoundary(state: JevState, boundary: string): OpenItemRecord {
	const refused = state.submissions.filter(entry => entry.boundary === boundary);
	const openItem: OpenItemRecord = {
		boundary,
		attempts: refused.length,
		digests: refused.map(entry => entry.digest),
	};
	state.openItem = openItem;
	const key = boundaryKey(boundary);
	if (!state.exhausted.includes(key)) state.exhausted = [...state.exhausted, key];
	allowContinuation(state, `attempt limit at ${boundary}; the decision remains OPEN`);
	return openItem;
}

/** Whether a boundary's refusal budget is spent (FR-23). */
export function boundaryExhausted(state: JevState, boundary: string): boolean {
	return state.exhausted.includes(boundaryKey(boundary));
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

/** The external deliverable the anti-slop review belongs to (FR-45, FR-46). */
export interface AntiSlopScope {
	taskFingerprint?: string;
	request: string;
	revision: number;
	quiet: boolean;
}

/** How far the recorded review parts cover one external deliverable (FR-53, FR-56). */
export interface AntiSlopStatus {
	reviews: AntiSlopReviewRecord[];
	missing: number[];
	blockers: AntiSlopFinding[];
	/** Parts disagree on the declared language, register or rule set. */
	inconsistent: boolean;
	complete: boolean;
}

/** The deliverable the current session may review, or undefined for an internal task. */
export function antiSlopScope(state: JevState): AntiSlopScope | undefined {
	if (state.task?.external === true) {
		return { taskFingerprint: state.task.fingerprint, request: state.task.request, revision: state.revision, quiet: false };
	}
	if (state.simple?.external === true) {
		return { taskFingerprint: state.simple.fingerprint, request: state.simple.request, revision: state.revision, quiet: false };
	}
	if (
		state.task === undefined &&
		state.simple === undefined &&
		state.request?.weight === "quiet" &&
		namesExternalDeliverable(state.request.text)
	) {
		return { request: state.request.text, revision: state.revision, quiet: true };
	}
	return undefined;
}

/** Whether the owner waived one finding id (FR-54). */
export function antiSlopWaived(state: JevState, findingId: string): boolean {
	return state.antiSlopWaivers.some(waiver => waiver.findingId === findingId);
}

/** Record one review part, replacing an earlier version of the same part. */
export function recordAntiSlopReview(state: JevState, review: AntiSlopReviewRecord): void {
	const samePart = (existing: AntiSlopReviewRecord): boolean =>
		existing.taskFingerprint === review.taskFingerprint &&
		existing.request === review.request &&
		existing.part.index === review.part.index;
	state.antiSlopReviews = [...state.antiSlopReviews.filter(existing => !samePart(existing)), review].slice(
		-POLICY.maxAntiSlopReviews,
	);
	delete state.antiSlopNotice;
}

/** Record an owner waiver; a repeated waiver is one record. */
export function recordAntiSlopWaiver(state: JevState, waiver: AntiSlopWaiver): void {
	if (antiSlopWaived(state, waiver.findingId)) return;
	state.antiSlopWaivers = [...state.antiSlopWaivers, waiver];
}

/** Find one recorded finding and the review part that carries it. */
export function findAntiSlopFinding(
	state: JevState,
	findingId: string,
): { review: AntiSlopReviewRecord; finding: AntiSlopFinding } | undefined {
	for (let index = state.antiSlopReviews.length - 1; index >= 0; index -= 1) {
		const review = state.antiSlopReviews[index];
		const finding = review?.findings.find(entry => entry.id === findingId);
		if (review !== undefined && finding !== undefined) return { review, finding };
	}
	return undefined;
}

/**
 * What the current review covers for one deliverable. The latest submitted part total owns the
 * group; a part missing from that group keeps the review incomplete, and an unwaived blocker keeps
 * it blocked. A review recorded for an older revision does not count (FR-53).
 */
export function antiSlopStatus(state: JevState, scope: AntiSlopScope): AntiSlopStatus {
	const reviews = state.antiSlopReviews.filter(review => {
		if (review.revision !== scope.revision) return false;
		if (scope.taskFingerprint !== undefined) return review.taskFingerprint === scope.taskFingerprint;
		return review.taskFingerprint === undefined && review.request === scope.request;
	});
	if (reviews.length === 0) {
		return { reviews: [], missing: [], blockers: [], inconsistent: false, complete: false };
	}
	const latest = reviews[reviews.length - 1];
	const total = latest?.part.total ?? 1;
	const byIndex = new Map<number, AntiSlopReviewRecord>();
	for (const review of reviews) {
		if (review.part.total === total) byIndex.set(review.part.index, review);
	}
	const missing: number[] = [];
	for (let index = 1; index <= total; index += 1) {
		if (!byIndex.has(index)) missing.push(index);
	}
	const ordered = [...byIndex.values()].sort((left, right) => left.part.index - right.part.index);
	const blockers = ordered.flatMap(review =>
		review.findings.filter(finding => finding.severity === "blocker" && !antiSlopWaived(state, finding.id)),
	);
	const inconsistent = ordered.some(
		review =>
			review.language !== latest?.language ||
			review.register !== latest?.register ||
			review.rulesDigest !== latest?.rulesDigest,
	);
	return {
		reviews: ordered,
		missing,
		blockers,
		inconsistent,
		complete: missing.length === 0 && blockers.length === 0 && !inconsistent,
	};
}
