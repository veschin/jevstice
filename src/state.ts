/**
 * Per-session gate state and the digests that bind an approval to concrete work.
 *
 * Normal-mode state lives in memory: a restart loses its approvals and closes its gates.
 * Strict autonomous runs restore only validated ledger checkpoints and exact artifact bindings.
 */
import { createHash } from "node:crypto";
import {
	PLAN_BOUNDARY,
	POLICY,
	type AntiSlopFinding,
	type AntiSlopReviewRecord,
	type Aspect,
	type PlanOutlineStep,
	type PlanTopic,
	type ToolOutcome,
	asRecord,
} from "./types.js";
import { namesExternalDeliverable, weightOf, type RequestWeight } from "./screen.js";
import type { ContextSource } from "./context.js";
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
interface AcceptanceRecord {
	aspect: Aspect;
	revision: number;
	label: string;
	approved: boolean;
	confidence: number;
}

/** One successful consequential action, kept as evidence for the course and completion checks. */
interface ActionRecord {
	tool: string;
	target: string;
	excerpt: string;
}

/** The last completion check and what it said. */
interface CompletionRecord {
	revision: number;
	label: string;
	approved: boolean;
	confidence: number;
}

/** The stop-block ledger for one unchanged refusal. */
interface StopRecord {
	signature: string;
	blocks: number;
}

/** One judged submission: the boundary that judged it and the material's digest (FR-22). */
interface SubmissionRecord {
	/** The boundary that judged it, so one boundary's refusals never block another's. */
	boundary: string;
	/** SHA-256 of the material as submitted. */
	digest: string;
	/** A Jev-approved resolution retired this refusal; history remains, but it cannot refuse a fresh judgment. */
	resolved?: true;
}

/** A boundary whose refusal budget is spent, kept as the OPEN item the owner has to settle (FR-23). */
interface OpenItemRecord {
	boundary: string;
	attempts: number;
}


/** The first recorded action whose target left the approved plan's topics (FR-25). */
interface Deviation {
	tool: string;
	target: string;
	revision: number;
}

/** Why a recovery hold was recorded; the classes must stay distinguishable in feedback. */
export type RecoveryKind = "refusal" | "invalid" | "unavailable" | "unclear" | "defect" | "stale";

/**
 * A finding that holds consequential work until a supported correction resolves it. The legacy
 * `{reason}` shape stays readable; a recorded finding carries the identity and exact material its
 * recovery consultation must name.
 */
export interface RecoveryHold {
	reason: string;
	/** Stable finding id bound to the task, boundary, class and judged material. */
	id?: string;
	boundary?: string;
	revision?: number;
	/** The exact failed submission, serialized. */
	material?: string;
	/** The exact returned result or details. */
	result?: unknown;
}


/** The source provenance the controller resolves before an activity reads its evidence. */
export interface TrustedContext {
	introduction: string;
	ownerMessages: readonly ContextSource[];
	selectedSources: readonly ContextSource[];
}

/** The course check in flight; only the check that set this token may clear it. */
export type PendingCheck = object;

/** Session-wide judge usage; a task change does not reset it. */
export interface SessionUsage {
	judgeCalls: number;
	inputTokens: number;
	outputTokens: number;
}

/** One activity's success and failure counts. */
export interface ActivityCount {
	ok: number;
	fail: number;
}

export type DiagnosticKind = "passed" | "failed" | "inconclusive" | "unavailable" | "not_checked";
export type DiagnosticCounts = Record<DiagnosticKind, number>;
export interface SessionDiagnostics {
	checks: DiagnosticCounts;
	work: DiagnosticCounts;
}

const diagnosticCounts = (): DiagnosticCounts => ({
	passed: 0, failed: 0, inconclusive: 0, unavailable: 0, not_checked: 0,
});

/** Shared classification for diagnostic accounting and user presentation. */
export function diagnosticKind(outcome: ToolOutcome): DiagnosticKind {
	const details = asRecord(outcome.details);
	const named = details?.["kind"];
	const confidence = details?.["confidence"];
	const unsettled = details?.["unsettled"];
	return (
		details?.["skipped"] === true || details?.["prerequisite"] !== undefined ||
		named === "invalid" || named === "stale" ? "not_checked" :
		named === "unavailable" ? "unavailable" :
		named === "unclear" || named === "unusable" || details?.["verdict"] === "unclear" ||
		(Array.isArray(unsettled) && unsettled.length > 0) ||
		(details?.["approved"] === false && typeof confidence === "number" && confidence < POLICY.minConfidenceToApprove) ? "inconclusive" :
		!outcome.ok || details?.["approved"] === false || details?.["verdict"] === "revise" ||
		details?.["blocked"] === true || (typeof details?.["blockers"] === "number" && details["blockers"] > 0) ? "failed" : "passed"
	);
}

/** A check result is evidence, never execution permission. */
export function recordDiagnostic(state: JevState, outcome: ToolOutcome, work = false): DiagnosticKind {
	const kind = diagnosticKind(outcome);
	const diagnostics = state.diagnostics ??= { checks: diagnosticCounts(), work: diagnosticCounts() };
	diagnostics.checks[kind] += 1;
	if (work) diagnostics.work[kind] += 1;
	return kind;
}

export function diagnosticSummary(state: JevState): string {
	const render = (counts: DiagnosticCounts): string => {
		const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
		return `${total} total; ${counts.passed} passed; ${counts.failed} failed; ${counts.inconclusive} inconclusive; ${counts.unavailable} unavailable; ${counts.not_checked} not checked`;
	};
	const diagnostics = state.diagnostics ?? { checks: diagnosticCounts(), work: diagnosticCounts() };
	const accepted = (["business", "architecture"] as const).filter(aspect => acceptanceAt(state, aspect)?.approved === true);
	return `Jev diagnostics, not execution permission. Work: ${render(diagnostics.work)}. Checks: ${render(diagnostics.checks)}. Current-revision acceptance: ${accepted.join(", ") || "none"}. Passed action checks do not prove a successful implementation. Findings never block continued work or completion.`;
}

/** Session workflow evidence and diagnostic history. */
export interface JevState {
	/** This session is supervised by the strict runtime's deterministic safety policy. */
	autonomous?: true;
	task?: TaskIdentity;
	/** The approved obligations of the registered task. */
	requirementsApproval?: { taskFingerprint: string; items: string[] };
	/** FR-42: unaffected obligations remain accepted, but the amended set needs review. */
	requirementsRetained?: { taskFingerprint: string; items: string[] };
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
	/** First unresolved diagnostic; it never controls work permission. */
	hold?: RecoveryHold;
	/** Exact distinct failed-check records, retained for the session. */
	findings?: RecoveryHold[];
	/** Every authentic owner message of this session, in chronological order. */
	ownerMessages: string[];
	/** Complete owner messages not yet classified against the active task. */
	pendingOwnerMessages?: string[];
	/** Trusted sources the controller resolved for the activity currently being judged. */
	trustedContext?: TrustedContext;
	/**
	 * The owner's latest message replaces the active course. The direction is undecided until
	 * jev_reaim establishes the replacement from authentic owner context; nothing else opens it.
	 */
	directionPending?: { text: string };
	actions: ActionRecord[];
	/** Consecutive judge calls that failed for availability, reset by any usable answer (FR-21). */
	judgeFailures: number;
	/** Availability attempts are exhausted; the outage is recorded and authorizes no effect (FR-21). */
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
	 * Boundaries whose refusal budget is spent. The finding stays OPEN and keeps blocking until a
	 * supported recovery resolves it; the count itself manufactures no approval and no permission (FR-23).
	 */
	exhausted: string[];
	/** Per-boundary ignored-call counts for the current owner request (FR-28, FR-44). */
	refusedCalls: Map<string, number>;
	/** The first action whose target left the approved plan (FR-25). */
	deviation?: Deviation;
	completion?: CompletionRecord;
	acceptance: AcceptanceRecord[];
	stop?: StopRecord;
	/** Recorded external-artifact review parts, newest last (FR-45..FR-56). */
	antiSlopReviews: AntiSlopReviewRecord[];
	/** The advisory anti-slop disclosure already sent for this revision and finding set. */
	antiSlopNotice?: string;
	/** Session-wide judge calls and token usage; it survives a task change. */
	usage: SessionUsage;
	/** Session-wide activity outcomes, keyed by tool name. */
	stats: Record<string, ActivityCount>;
	/** Session-wide diagnostic coverage, retained across task changes. */
	diagnostics?: SessionDiagnostics;
}

export function freshState(): JevState {
	return {
		revision: 0,
		actionsSinceCheck: 0,
		actions: [],
		ownerMessages: [],
		acceptance: [],
		planTopics: [],
		submissions: [],
		exhausted: [],
		refusedCalls: new Map(),
		judgeFailures: 0,
		antiSlopReviews: [],
		usage: { judgeCalls: 0, inputTokens: 0, outputTokens: 0 },
		stats: {},
		diagnostics: { checks: diagnosticCounts(), work: diagnosticCounts() },
		findings: [],
	};
}


const RECOVERY_KINDS: Record<string, true> = {
	refusal: true,
	invalid: true,
	unavailable: true,
	unclear: true,
	defect: true,
	stale: true,
};

/**
 * Add one authentic owner message to the chronological history and to the unclassified queue.
 * The controller calls this with interactive/rpc input only; extension messages and tool arguments
 * never reach it.
 */
export function queueOwnerMessage(state: JevState, message: string): void {
	const trimmed = message.trim();
	if (trimmed.length === 0) return;
	state.ownerMessages = [...state.ownerMessages, trimmed];
	state.pendingOwnerMessages = [...(state.pendingOwnerMessages ?? []), trimmed];
}

/** Take the queued owner messages for one serialized classification. */
export function takePendingOwnerMessages(state: JevState): string[] {
	const pending = state.pendingOwnerMessages ?? [];
	state.pendingOwnerMessages = [];
	return pending;
}

function classifyRecovery(outcome: ToolOutcome): RecoveryKind {
	const named = asRecord(outcome.details)?.["kind"];
	return typeof named === "string" && RECOVERY_KINDS[named] === true ? (named as RecoveryKind) : "refusal";
}

/**
 * The one-line reason a finding records: the boundary and the answer it returned, with the reported
 * confidence when the activity provided one. It stays short because the exact material and result
 * are kept beside it, and the class is carried separately.
 */
function summarizeRecovery(boundary: string, outcome: ToolOutcome): string {
	const details = asRecord(outcome.details);
	const verdict = details?.["verdict"] ?? details?.["label"] ?? details?.["assessment"];
	const confidence = details?.["confidence"];
	const answer =
		typeof verdict === "string" && verdict.length > 0
			? typeof confidence === "number"
				? ` (answer: ${verdict} at confidence ${confidence.toFixed(2)})`
				: ` (answer: ${verdict})`
			: "";
	return `${boundary} did not approve the material${answer}`;
}

/**
 * Record the hold every actual refusal creates. Only `ok: false` and an explicit
 * `details.approved === false` count; a well-formed answer that merely says "no" to an ordinary
 * question is not a workflow failure, and a skipped check is not a finding. An existing hold is
 * preserved: an unrelated refusal never resets it.
 */
export function recordRecovery(
	state: JevState,
	boundary: string,
	params: unknown,
	outcome: ToolOutcome,
): RecoveryHold | undefined {
	const details = asRecord(outcome.details);
	if (details?.["skipped"] === true) return undefined;
	// Local argument validation is not a Jev verdict. Corrected arguments must remain callable.
	if (details?.["kind"] === "invalid") return undefined;
	// A stale answer was discarded before judgment: it is no finding and no current decision, so
	// the corrected material must be judged again rather than held behind a manufactured finding.
	if (details?.["kind"] === "stale") return undefined;
	const failed = outcome.ok !== true || details?.["approved"] === false;
	if (!failed) return undefined;
	const kind = classifyRecovery(outcome);
	let material: string;
	try {
		material = JSON.stringify(params) ?? "null";
	} catch {
		material = String(params);
	}
	const identity = sha256(
		JSON.stringify({
			task: state.task?.fingerprint ?? state.request?.text ?? null,
			boundary: boundaryKey(boundary),
			revision: state.revision,
			material,
		}),
	);
	const id = `finding-${identity.slice(0, 12)}`;
	// The exact returned text is the observable failure; the details stay alongside it so neither
	// the validation/transport message nor the structured class is lost from the finding.
	const result = { ...(details ?? {}), kind, text: outcome.text };
	const finding: RecoveryHold = {
		reason: summarizeRecovery(boundary, outcome), id, boundary, revision: state.revision, material, result,
	};
	const findings = state.findings ??= [];
	if (!findings.some(entry => entry.id === id)) findings.push(finding);
	if (state.hold !== undefined) {
		if (state.hold.boundary === undefined || boundaryKey(state.hold.boundary) === boundaryKey(boundary)) {
			state.hold = {
				...state.hold,
				boundary: state.hold.boundary ?? boundary,
				revision: state.hold.revision ?? state.revision,
				material: state.hold.material ?? material,
				result: state.hold.result ?? result,
				id: state.hold.id ?? id,
			};
		}
		return state.hold;
	}
	state.hold = finding;
	return state.hold;
}

/** The finding id a recovery consultation must name, when the hold carries one. */
export function recoveryHoldId(state: JevState): string | undefined {
	return state.hold?.id;
}

/** Original finding context remains inspectable without controlling execution. */
export function recoveryFeedback(state: JevState): string {
	const finding = state.hold;
	if (finding === undefined) return "";
	const kind = asRecord(finding.result)?.["kind"] ?? "inconclusive";
	return `Diagnostic finding ${finding.id ?? "(legacy)"} at ${finding.boundary ?? "check"}: ${kind}. ${finding.reason}. The original submission and result remain available through jev_context. Continue useful work; this finding grants no approval and blocks no action or completion.`;
}

/** Clear the hold only when the consultation names its exact finding id. */
export function clearResolvedHold(state: JevState, findingId: string): boolean {
	if (state.hold === undefined || state.hold.id !== findingId) return false;
	// FR-67: resolving a finding changes its authorization context, not the approval floor.
	// Retire only the exact refused material named by this finding, not its whole tool boundary.
	const boundary = state.hold.boundary;
	const submission = asRecord(asRecord(state.hold.result)?.["submission"]);
	state.submissions = state.submissions.map(entry =>
		entry.boundary === submission?.["boundary"] && entry.digest === submission?.["digest"]
			? { ...entry, resolved: true } : entry,
	);
	if (boundary === "completion" && state.completion?.approved === false) {
		delete state.completion;
		delete state.stop;
	}
	delete state.hold;
	return true;
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
	delete state.requirementsRetained;
	delete state.planDraft;
	delete state.plan;
	delete state.hold;
	delete state.directionPending;
	state.pendingOwnerMessages = [];
	delete state.openItem;
	delete state.openItemNotified;
	delete state.checkPending;
	delete state.deviation;
	delete state.completion;
	delete state.stop;
	state.acceptance = [];
	state.actions = [];
	state.submissions = [];
	state.exhausted = [];
	state.planTopics = [];
	state.refusedCalls = new Map();
	state.antiSlopReviews = [];
	delete state.antiSlopNotice;
	state.revision = 0;
	state.actionsSinceCheck = 0;
}

/** Retire the settled ordinary objective without discarding the session's diagnostic history. */
export function retireTask(state: JevState): void {
	clearWork(state);
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
	if (state.request?.text !== request) {
		state.refusedCalls.clear();
		delete state.stop;
	}
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
 * boundary is recorded as OPEN; that record authorizes nothing, and the finding stays unresolved
 * until materially new evidence or the owner's explicit continuation (FR-23).
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
		repeat: judged.some(entry => entry.digest === digest && entry.resolved !== true),
		attempts,
		exhausted: state.exhausted.includes(boundaryKey(boundary)) || attempts >= POLICY.maxRefusalsPerStage,
	};
}

/**
 * Record a spent refusal budget as OPEN. It authorizes nothing: the finding stays open, only
 * materially new evidence or the owner's explicit continuation can move the work, and neither is
 * Jev approval (FR-23).
 */
export function exhaustBoundary(state: JevState, boundary: string): OpenItemRecord {
	const refused = state.submissions.filter(entry => entry.boundary === boundary);
	const openItem: OpenItemRecord = { boundary, attempts: refused.length };
	state.openItem = openItem;
	const key = boundaryKey(boundary);
	if (!state.exhausted.includes(key)) state.exhausted = [...state.exhausted, key];
	return openItem;
}

/** Whether a boundary's refusal budget is spent (FR-23). */
export function boundaryExhausted(state: JevState, boundary: string): boolean {
	return state.exhausted.includes(boundaryKey(boundary));
}

/** Count one consequential call a standing boundary refused (FR-28). */
export function recordRefusedCall(state: JevState, boundary: string): number {
	const count = (state.refusedCalls.get(boundary) ?? 0) + 1;
	state.refusedCalls.set(boundary, count);
	return count;
}

/**
 * Record the ignored-call limit as an OPEN item without spending the activity refusal budget.
 * The gate's own refusals must never exhaust the activity they protect, and the count never
 * releases the boundary: only a supported correction or explicit owner continuation can.
 */
export function permitAfterIgnoredCalls(state: JevState, boundary: string, attempts: number): OpenItemRecord {
	const openItem: OpenItemRecord = { boundary, attempts };
	state.openItem = openItem;
	return openItem;
}

/** Record one activity outcome for the session status. */
export function recordActivityOutcome(state: JevState, tool: string, ok: boolean): void {
	const current = state.stats[tool] ?? { ok: 0, fail: 0 };
	state.stats[tool] = ok ? { ok: current.ok + 1, fail: current.fail } : { ok: current.ok, fail: current.fail + 1 };
}

/** Record one judge attempt and its token usage; a failed attempt still counts as a call. */
export function recordJudgeCall(state: JevState, usage?: { inputTokens: number; outputTokens: number }): void {
	state.usage.judgeCalls += 1;
	if (usage === undefined) return;
	state.usage.inputTokens += usage.inputTokens;
	state.usage.outputTokens += usage.outputTokens;
}

/** Remember the first action whose target left the approved plan's topics (FR-25). */
export function markDeviation(state: JevState, tool: string, target: string): void {
	if (state.deviation === undefined) state.deviation = { tool, target, revision: state.revision };
}

/** The external deliverable the anti-slop review belongs to (FR-45, FR-46). */
interface AntiSlopScope {
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
	const blockers = ordered.flatMap(review => review.findings.filter(finding => finding.severity === "blocker"));
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
