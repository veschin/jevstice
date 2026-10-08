/**
 * Jev decision controller: omp extension core.
 *
 * Real omp semantics (verified against @oh-my-pi/pi-coding-agent 18.6.3 source):
 * - `tool_call` handler (event, ctx) => {block?, reason?, input?, additionalContext?} fires
 *   before execution and can block (extensibility/shared-events.ts:325).
 * - `session_stop` handler => {decision: "block", reason} is extension-only and maps to a
 *   continuation; `event.stop_hook_active` is true when already continuing from a stop hook
 *   (shared-events.ts:110/486) - we never block twice on the same unmet gate (finite rework).
 * - `before_subagent_spawn` => {model?, block?, reason?, note?} (extensions/types.ts:1301); the
 *   event carries the agent name and spawn key but NOT the prompt, so the FR-11 work order is
 *   captured from the `task` tool call input (`task`, batch `tasks[].task`, shared `context`;
 *   omp 18.6.3 task/agents.ts + task/index.ts:821).
 * - `tool_result` => {content?, details?, isError?, additionalContext?} fires after every tool
 *   call (wrapper.ts:459) and CANNOT refuse one (shared-events.ts:398): a handler may only
 *   rewrite content/details/isError, so the FR-11 acceptance verdict is recorded and fed back
 *   into the session, never a block.
 * - `before_agent_start` carries the already-transformed prompt (task fingerprint source).
 * - `pi.appendEntry(customType, data)` persists non-LLM state; `ctx.sessionManager.getEntries()`
 *   reads it back on session start (session-manager.ts:3419, 653-676).
 * - Same-agent feedback: `pi.sendMessage(payload, {deliverAs, triggerTurn})` injects into the
 *   SAME session - no respawn, no new session.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isRecord, nonEmptyString } from "./guards.js";
import type { JevTemplateConfig } from "./config.js";
import * as mechanism from "./gates.js";
import {
	REVIEW_DEADLINE_MS,
	consultReview,
	isReviewStage,
	reviewLine,
	reviewRecord,
	type ReviewId,
	type ReviewRecord,
} from "./reviews.js";
import {
	ACTIVITY_REGISTRY,
	PLAN_MAPPING_APPROVED_OPTION,
	PLAN_MAPPING_INCOMPLETE_OPTION,
	PLAN_MAPPING_STAGE,
	FORMALIZATION_APPROVED_OPTION,
	FORMALIZATION_COVERAGE_MISSING_OPTION,
	FORMALIZATION_UNTRACEABLE_OPTION,
	CRITERIA_ACCEPTED_OPTION,
	CRITERIA_UNBACKED_OPTION,
	PRIORITIES_RANKED_OPTION,
	PRIORITIES_STALE_OPTION,
	resolveActivityOutcome,
	type ActivityRegistry,
} from "./activities.js";
import {
	type ControlPoint,
	lookupControlPoint,
	validateDeclaredControlPoint,
} from "./control-points.js";
import { classifyTaskType, routeModel, routeSkills, selectTopics, type CatalogTopic, type RoutingCandidate } from "./catalog.js";
import { STAGES } from "./stages.js";
import {
	POLICY,
	COURSE_CHECK_NEXT_ACTIONS,
	PRIORITY_CLASSES,
	type AcceptanceCriteriaJudge,
	type AcceptanceCriteriaResult,
	type AspectCoverageJudge,
	type AspectCoverageResult,
	type ClaimCheckJudge,
	type ClaimCheckResult,
	type CourseCheckJudge,
	type CourseCheckNextAction,
	type CourseCheckResult,
	type MultiLabelJudge,
	type PriorityClass,
	type PriorityJudge,
	type PriorityResult,
	type RefactorInventoryItem,
	type RefactorMarkingJudge,
	type RefactorMarkingOutcome,
	type RefactorMarkingResult,
	type RequirementsFormalizationJudge,
	type RequirementsFormalizationResult,
	type ReviewJudge,
} from "./types.js";
import {
	type DecisionResult,
	type DecisionStage,
	type DecisionVerdict,
	type Evidence,
	type Judge,
	type DecisionOption,
} from "./types.js";

// ---------- persisted state ----------

export interface ApprovalRecord {
	stage: DecisionStage;
	/** sha256 of the exact decision request revision this approval covers (AC5 content digest). */
	revisionHash: string;
	/** Fingerprint of the user task active when approved; changed task invalidates. */
	taskFingerprint: string | undefined;
	/** Mutation counter value when approved; later work invalidates completion approvals. */
	workRevision: number;
	selectedOption: string;
	approvedAt: number;
}

/** One claim as marked by the judge (claim_check preset); text is the caller's own words. */
export interface ClaimCheckMarking {
	id: string;
	text: string;
	/** True when the quoted evidence states or entails the claim. */
	supported: boolean;
}

/** One formalized requirement (requirements_formalization activity), with its marking. */
export interface FormalizedRequirement {
	id: string;
	/** The caller's own wording of the requirement (its numbered list item). */
	text: string;
	/** FR-19: the submitted quote id this item names as its source. */
	quoteId: string;
	/** That quote's verbatim text, so an observer reads a quote beside every numbered item. */
	quote: string;
	/** True when a quoted user/spec item states or directly entails it. */
	traceable: boolean;
}

/**
 * Latest requirements_formalization result for the current task. `complete` is true only when
 * the list was accepted (every item traceable and every quoted source covered): an incomplete
 * record is surfaced but never used as the checklist for planning/development/completion.
 */
export interface FormalizationRecord {
	requirements: FormalizedRequirement[];
	/** Quoted source texts no formalized requirement captured (the coverage verdict). */
	uncovered: Array<{ id: string; source: string; excerpt: string }>;
	outcome: string;
	complete: boolean;
	/** Content digest of the accepted items: the identity of this accepted batch (FR-21). */
	batchDigest: string;
	at: number;
	taskFingerprint: string | undefined;
	workRevision: number;
}

/** Latest plan_mapping result (planning activity): the claim that the plan serves each requirement. */
export interface PlanMappingRecord {
	requirements: Array<{ id: string; claim: string; supported: boolean }>;
	/** Formalized requirement ids with no submitted plan claim (planning incomplete). */
	missing: string[];
	complete: boolean;
	at: number;
	taskFingerprint: string | undefined;
	workRevision: number;
}

/**
 * Identity of an accepted requirement batch: the task plus a digest of the accepted list's items
 * (numbers, wording, named quotes and their verbatim text). Content, not a timestamp: re-accepting
 * the SAME list keeps an order valid, while a genuinely new portion (different items or quotes)
 * makes it a different batch - which is exactly what "re-ranked after the next accepted batch" needs.
 */
export interface AcceptedBatch {
	taskFingerprint: string | undefined;
	digest: string;
}

/**
 * FR-20: one acceptance criterion with the ACCEPTED requirement it references, that
 * requirement's verbatim quote, and the judge's own mark. A criterion the judge did not mark is
 * never accepted and is named at the completion boundary.
 */
export interface AcceptanceCriterion {
	id: string;
	requirementId: string;
	text: string;
	/** The referenced accepted requirement's verbatim quote, so the criterion is readable alone. */
	requirementQuote: string;
	/** The judge's mark: the referenced requirement states or entails this criterion as written. */
	marked: boolean;
}

/**
 * Latest acceptance_criteria result for the current task (FR-20), bound to the accepted batch its
 * criteria were formalized from. `complete` is true only when every criterion is marked; an
 * incomplete record names the unaccepted criterion ids.
 */
export interface AcceptanceCriteriaRecord {
	criteria: AcceptanceCriterion[];
	/** Criterion ids the judge did not accept - named at the stop boundary, never used as criteria. */
	unaccepted: string[];
	complete: boolean;
	batch: AcceptedBatch;
	at: number;
	workRevision: number;
}

/** FR-21: one ranked accepted requirement with its number, its verbatim quote and the judge's class. */
export interface PriorityOrderItem {
	requirementId: string;
	/** 1-based rank in the order derived from the judge's own class marks. */
	rank: number;
	text: string;
	/** The accepted requirement's verbatim quote (FR-21 requires the quotes in this record). */
	quote: string;
	priorityClass: PriorityClass;
	confidence?: number;
}

/**
 * Latest requirement_priorities result for the current task (FR-21): the order over the accepted
 * batch it ranks, the judge's per-item class marks with their confidences, and each ranked item's
 * verbatim requirement quote. A later accepted batch retires the record (stale + reason); the next
 * judged consultation replaces it and records the batch it superseded.
 */
export interface PriorityRecord {
	items: PriorityOrderItem[];
	/** The accepted batch this order ranks. */
	batch: AcceptedBatch;
	stale: boolean;
	staleReason?: string;
	/** The batch a later judged consultation superseded, when this record replaced an older order. */
	supersedes?: AcceptedBatch;
	/** FR-21 naming: work started on an item the order ranked later; recorded when observed. */
	outOfOrder?: { started: string; expectedFirst: string };
	at: number;
}

/** One automatic (periodic) course-check consult. Advisory: it never unlocks anything. */
export interface AutoCourseCheckRecord {
	/** True when the judge answered; false only when it could not be consulted or answered unusably. */
	judged: boolean;
	selectedOption?: string;
	confidence?: number;
	reasons: string[];
	/**
	 * F3: true when the judge DID answer and the answer was recorded as uncertainty instead of a
	 * verdict (a redirect at a confidence below the floor). The record must read as uncertainty -
	 * never as "not judged" - because the judge's own answer is what is being recorded.
	 */
	belowFloor?: boolean;
	/** Work revision the consult ran at (the mutation count that crossed the period). */
	workRevision: number;
	at: number;
}

/**
 * FR-13 part (1): the inventory of the old functions, each with its verification command,
 * recorded BEFORE the first code edit of the task (a submission after the first edit is refused,
 * so a record can never be reconstructed after the fact). Bound to the task it was declared for.
 */
export interface RefactorInventoryRecord {
	items: RefactorInventoryItem[];
	taskFingerprint: string | undefined;
	at: number;
}

/** One inventory item as marked by the judge from the material attached to that item. */
export interface RefactorMark {
	id: string;
	outcome: RefactorMarkingOutcome;
	reasons: string[];
}

/**
 * FR-13 part (2): the per-item marking made AFTER the refactoring from each item's own artifact
 * material. Bound to the task AND to the work revision it was made at: a later code edit makes
 * the marking stale, and the completion boundary then names every item again (a marking must
 * describe the code that exists, not the code that existed when it was written).
 */
export interface RefactorMarkingRecord {
	marks: RefactorMark[];
	taskFingerprint: string | undefined;
	workRevision: number;
	at: number;
}

/**
 * One judged rework attempt (PRD 19, TASKS "Rules of the loop"): the approach the executor named
 * and the judge's own answer to it. Only a judged consultation is an attempt - a submission
 * refused before the judge call spends no approach and never enters the journal.
 */
export interface ReworkAttempt {
	/** 1-based attempt number within this task+stage loop. */
	attempt: number;
	/** The approach as submitted (the comparison key folds case and whitespace only). */
	approach: string;
	verdict: DecisionVerdict;
	reasons: string[];
	confidence?: number;
	at: number;
}

/**
 * The written journal of one `${taskFingerprint}:${stage}` rework loop: every judged attempt with
 * its approach and the judge's verbatim answer, so a repeated approach is refused instead of judged
 * again and exhaustion can name what was already tried. `open` marks the exhaustion recorded as an
 * OPEN item - the loop stops there instead of bending the wording to fit an answer.
 */
export interface ReworkJournal {
	taskFingerprint: string | undefined;
	stage: string;
	attempts: ReworkAttempt[];
	open: boolean;
	at: number;
}

/**
 * The named problems a confident refusal left standing for one task+stage (PRD section 1.1 and
 * FR-10: "если ты спросил судью и он сказал переделать значит выясняй что не так и переделывай" -
 * the answer obliges). `problems` are the judge's own reasons, verbatim and in the order it named
 * them: the numbered list the refusal delivers into the session, the list the next submission must
 * answer by position, and the list the next consult shows the judge verbatim. The record is cleared
 * only by the judge's own approval of a submission that answered every problem, or by an escalation
 * the judge answered (`ask_user`); an abstention, a judge error, a sub-floor answer and an
 * escalation from the attempt bound neither create nor clear it.
 */
export interface OutstandingRework {
	stage: string;
	taskFingerprint: string | undefined;
	/** The standing problems, verbatim, in the order the refusals named them (never re-ordered). */
	problems: string[];
	/** How many confident refusals have contributed problems to this obligation. */
	refusals: number;
	at: number;
}

/**
 * One allowed mutating tool call whose work revision crossed the `courseCheck.everyMutations`
 * period, awaiting its OWN `tool_result` so the periodic consult can judge what the mutation
 * produced rather than the intention to mutate. Keyed by toolCallId; transient like the handoff
 * orders (never restored, aged out, cleared with the task).
 */
export interface PendingMutation {
	/** Work revision the call bumped to (the period is counted on this call). */
	revision: number;
	/** The mutating tool the call named, for the consult's currentAction. */
	toolName: string;
	at: number;
}

export interface JevState {
	approvals: ApprovalRecord[];
	/** Judge consultations per `${taskFingerprint}:${stage}` - bounded rework (FR-12). */
	iterations: Record<string, number>;
	/** Bumped on every allowed mutating tool call (edit/write/bash); completion approvals bind to it. */
	workRevision: number;
	/** sha256 of the latest before_agent_start prompt. */
	taskFingerprint: string | undefined;
	/** Explicit unresolved blockers, surfaced verbatim - never replaced by fake success. */
	blockers: string[];
	/** Applied model-routing selection (AC2): enforced at before_subagent_spawn. */
	routedModel: string | undefined;
	/** Applied skill-routing selection (AC2), delivered into the session as an aside when made. */
	routedSkill: string | undefined;
	/**
	 * Work revision the current task started at. FR-13 part (1): an inventory is only a
	 * pre-refactoring inventory while no mutating call happened since the task began.
	 */
	taskStartWorkRevision: number;
	/** FR-13 part (1): the old-function inventory of the current task, or undefined when none was declared. */
	refactorInventory: RefactorInventoryRecord | undefined;
	/** FR-13 part (2): the latest per-item marking of that inventory (task + work-revision bound). */
	lastRefactorMarking: RefactorMarkingRecord | undefined;
	/** Latest judged course_check continue/verify record; completion requires a fresh one (task+work bound). */
	lastCourseCheck: { selectedOption: string; at: number; taskFingerprint: string | undefined; workRevision: number } | undefined;
	/**
	 * Latest claim_check marking: one entry per submitted claim, in submission order
	 * (advisory, never a gate grant). Undefined until a claim_check is marked.
	 */
	lastClaimCheck: { claims: ClaimCheckMarking[]; at: number; taskFingerprint: string | undefined; workRevision: number } | undefined;
	/**
	 * Latest requirements_formalization result (advisory, never a gate grant). Undefined until
	 * a formalization is judged; only a `complete` record is used as the requirement checklist.
	 */
	lastFormalization: FormalizationRecord | undefined;
	/** Latest plan_mapping result: the per-requirement plan claims of the planning activity. */
	lastPlanMapping: PlanMappingRecord | undefined;
	/** FR-20: latest acceptance_criteria result, bound to the accepted batch its criteria came from. */
	lastAcceptanceCriteria: AcceptanceCriteriaRecord | undefined;
	/** FR-21: latest requirement_priorities order over an accepted batch (undefined = none recorded). */
	lastPriorities: PriorityRecord | undefined;
	/**
	 * Latest automatic (periodic) course-check consult. Advisory record only: it never records a
	 * gate approval and never satisfies the completion boundary (that needs a deliberate
	 * course_check with option continue bound to the current revision).
	 */
	lastAutoCourseCheck: AutoCourseCheckRecord | undefined;
	/** Open aspect_coverage drift: missed aspect ids for the current task (completion teeth). */
	openAspectGaps: { missed: string[]; taskFingerprint: string | undefined } | undefined;
	/** Calibration-tolerant completion: consecutive mid-band approves, bound to task+work+exact content digest. */
	consecutiveCompletionApproves: { count: number; confidences: number[]; taskFingerprint: string | undefined; workRevision: number; revisionHash: string } | undefined;
	/**
	 * Last submission digest per `taskFingerprint:stage`. The rework bound limits no-progress
	 * loops, not consultation: content that differs from the last submission is new work and
	 * gets a fresh budget, while an identical resubmission keeps consuming (PRD 1.1 asks for
	 * many cheap iterations; three honest answers must not close a stage forever).
	 */
	submissionDigests: Record<string, string>;
	/**
	 * Approach-varied rework journal per `taskFingerprint:stage` (PRD 19 / TASKS rules of the loop):
	 * every judged attempt with the approach it named. A submission naming an approach already in the
	 * journal is refused before any judge call; a new approach is a new attempt; N attempts exhaust the
	 * bound and the journal is what the escalation surfaces. Submissions that name no approach are not
	 * touched by this dimension and keep the digest budget above unchanged.
	 */
	reworkJournal: Record<string, ReworkJournal>;
	/**
	 * The standing named problems of a confident refusal per `taskFingerprint:stage` (PRD 1.1 /
	 * FR-10: the answer obliges). While a record stands, the stage's next submission must answer
	 * every problem by position, the consult shows the judge the problems and the declared answers
	 * verbatim, and no approval of that stage is recorded from a submission that answers none.
	 */
	outstandingRework: Record<string, OutstandingRework>;
	/** FR-01 record: task type the judge assigned at task start (undefined = not established). */
	taskType: string | undefined;
	/** FR-04 record: catalog topic ids the judge marked applicable at task start. */
	selectedTopics: string[] | undefined;
	/** FR-11: latest before_agent_start prompt - the requirement the handoff judge is shown. */
	taskPrompt: string | undefined;
	/**
	 * FR-11: work orders of the task tool calls in flight, keyed by toolCallId, captured at
	 * tool_call because before_subagent_spawn carries no prompt and no toolCallId (spawnKey may
	 * be the agent name or `${toolCallId}:${index}`). `usedBySpawn` marks an order a spawn has
	 * already been judged against, so a sibling spawn is never judged on someone else's order.
	 * Cleared when the task fingerprint changes and aged out after HANDOFF_ORDER_MAX_AGE_MS, so a
	 * call that never reaches execution cannot disarm the check. Transient: never restored from
	 * session entries.
	 */
	pendingHandoffs: Record<string, { text: string; at: number; usedBySpawn: boolean }>;
	/**
	 * Activities framework (development): the allowed mutating tool calls whose work revision
	 * crossed the automatic course-check period, keyed by toolCallId and consumed by their own
	 * `tool_result`. The periodic consult runs on that result (never on the call), so it judges
	 * what the mutation produced. Cleared when the task fingerprint changes and aged out after
	 * PENDING_MUTATION_MAX_AGE_MS, so a call whose result never arrives cannot leak or judge a
	 * later call. Transient: never restored from session entries.
	 */
	pendingMutations: Record<string, PendingMutation>;
	/** FR-11: last handoff judgement (dispatch or acceptance) - recorded, never a silent no-op. */
	lastHandoff: HandoffRecord | undefined;
	/** POLICY-DRAFT I: last destructive-action judgement - recorded, never a silent no-op. */
	lastDestructive: DestructiveRecord | undefined;
	/**
	 * Latest recorded review per review stage (business_review, architecture_review,
	 * security_review): the scores with their confidences, the chosen declared candidate and every
	 * statement verdict. Advisory by construction - a review records no gate approval and pushes no
	 * blocker.
	 */
	reviews: Partial<Record<ReviewId, ReviewRecord>>;
}

function freshState(): JevState {
	return {
		approvals: [],
		iterations: {},
		workRevision: 0,
		taskFingerprint: undefined,
		blockers: [],
		routedModel: undefined,
		routedSkill: undefined,
		taskStartWorkRevision: 0,
		refactorInventory: undefined,
		lastRefactorMarking: undefined,
		lastCourseCheck: undefined,
		lastClaimCheck: undefined,
		lastFormalization: undefined,
		lastPlanMapping: undefined,
		lastAcceptanceCriteria: undefined,
		lastPriorities: undefined,
		lastAutoCourseCheck: undefined,
		openAspectGaps: undefined,
		consecutiveCompletionApproves: undefined,
		submissionDigests: {},
		reworkJournal: {},
		outstandingRework: {},
		taskType: undefined,
		selectedTopics: undefined,
		taskPrompt: undefined,
		pendingHandoffs: {},
		pendingMutations: {},
		lastHandoff: undefined,
		lastDestructive: undefined,
		reviews: {},
	};
}

// ---------- public result shapes ----------

export interface DecisionOutcome {
	verdict: DecisionVerdict;
	selectedOption?: string;
	reasons: string[];
	confidence?: number;
	/** Judge was actually consulted for this outcome. */
	judged: boolean;
	/** Non-fatal evidence-quality codes surfaced alongside a judged verdict. */
	warnings?: string[];
	/** One-line fixed-template summary for executor readability (no generated prose). */
	summary: string;
}

export interface StopGateResult {
	decision?: "block";
	reason?: string;
}

export interface SpawnRouteResult {
	model?: string | string[];
	block?: boolean;
	reason?: string;
	note?: string;
}

/**
 * FR-11 record of one hand-off consultation: dispatch (before_subagent_spawn) or acceptance (the
 * delegated result the host delivers). The fields every gate record carries live in src/gates.ts.
 */
export interface HandoffRecord extends mechanism.GateRecordFields {
	phase: "dispatch" | "acceptance";
}

/**
 * POLICY-DRAFT I record of one execution-time destructive-action consultation. Both triggers share
 * one record shape: the shared gate fields, the trigger and what it quoted.
 */
export type DestructiveTrigger = "command" | "outsideProjectWrite";

export interface DestructiveRecord extends mechanism.GateRecordFields {
	/**
	 * Which trigger judged: a bash command matching an owner pattern, or a write/edit/ast_edit call
	 * whose target lies outside the project root. Absent on records persisted before the second
	 * trigger existed, and read back as the command trigger.
	 */
	trigger?: DestructiveTrigger;
	/**
	 * What triggered the judgement, verbatim from its source: the owner pattern that matched
	 * (trigger `command`), or the outside-root target path(s) (trigger `outsideProjectWrite`).
	 */
	pattern: string;
	/**
	 * The text that was judged (verbatim prefix): the bash command, or the content the call would write
	 * (`outsideProjectWrite`, or the target path list when the call carries no content).
	 */
	command: string;
}

/** What the outside-root write trigger read from the tool call, for the consult and the record. */
interface OutsideRootWriteFacts {
	toolName: string;
	targets: readonly string[];
	/** The project root the targets were measured against, quoted verbatim in the judge's subject. */
	root: string;
	/** The content the call would write, or undefined when the call carries none. */
	content: string | undefined;
}

// ---------- tool input validation ----------

const EVIDENCE_KINDS: ReadonlySet<string> = new Set([
	"user",
	"spec",
	"code",
	"execution",
	"log",
	"documentation",
]);
/** Completion must rest on artifact evidence, not self-report (AC4b). */
const COMPLETION_EVIDENCE_KINDS: ReadonlySet<string> = new Set(["execution", "code", "log"]);
/** FR-13 part (2): the markings the judge may return per inventory item; anything else is a bad payload. */
const REFACTOR_MARKING_OUTCOMES: Readonly<Record<string, true>> = {
	preserved: true,
	lost: true,
	not_evidenced: true,
};
// Mutation-bearing builtins (omp 18.6.3 tools/builtin-names.ts + tool sources):
// edit/write mutate files directly; ast_edit performs structural edits; bash executes
// arbitrary shell (mutation-capable, conservatively gated); memory_edit and manage_skill
// write user-level state, and learn/retain write the same state (a lesson into long-term
// memory, and - with `learn` - a managed skill) under names the set did not carry.
// Non-builtin custom tools are out of this gate's reach (documented).
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"ast_edit",
	"bash",
	"memory_edit",
	"manage_skill",
	"learn",
	"retain",
	// eval spawns processes and writes files from inside the kernel without a tool_call
	// of its own: gated for the same reason as bash (conservative, mutation-capable).
	"eval",
]);
/** course_check redirecting options: approve+these map to revise (registry holds the full set). */
const COURSE_CHECK_REDIRECTING: ReadonlySet<string> = new Set(["return_to_requirement", "replan"]);
/**
 * Marker the client puts in `reasons` on a frame escape, followed by the service option id,
 * the companion meta_reason and the actionable fix (client.ts FRAME_FIX_PREFIX). It is declared
 * with the descriptors: src/gates.ts owns the contract, this module reads it.
 */
const FRAME_ESCAPE_REASON = mechanism.FRAME_ESCAPE_REASON;
const FRAME_FIX_PREFIX = "frame_fix: ";
/**
 * Plan stages: a proposal that quotes no evidence is not judgeable (live 0.14-0.26 against
 * 0.79-0.96 for the same plan phrased as a claim). The check is a pre-judge refusal, so a
 * submission defect never burns a consultation or a rework iteration.
 */
const GROUNDING_MIN_QUOTE_CHARS = 20;
const GROUNDING_PROBLEM = "proposal_not_grounded_in_evidence";
const GROUNDING_FIX =
	`quote at least one submitted evidence item (>= ${GROUNDING_MIN_QUOTE_CHARS} characters) verbatim ` +
	"inside the proposal and state what it supports, so the plan is a claim checked against evidence";
/**
 * Rework journal (PRD 19 rule 5): the judge's reasons are kept verbatim, capped to this many
 * characters so the journal line, the feedback and the exhaustion message stay readable.
 */
const REWORK_REASON_EXCERPT_CHARS = 240;
/** claim_check preset: N independent decisions in one request start at two claims. */
const CLAIM_CHECK_MIN_CLAIMS = 2;
/** Fix named when a claim cannot be marked: it must be answerable from the quoted evidence. */
const CLAIM_CHECK_FIX =
	"quote evidence that states or directly entails each claim; a claim is judged only from the quoted evidence";
/** Claim text shown in fixed-template lines: the caller's words, capped for readability. */
const CLAIM_EXCERPT_CHARS = 80;
/**
 * Activities framework (requirements_formalization): the fix named when an item is not
 * traceable or a quoted source is not covered.
 */
const FORMALIZATION_FIX =
	"quote a user/spec source that states or directly entails each requirement (kind user or spec), and " +
	"formalize every quoted source into at least one requirement - drop the quote or add the requirement";
/** Activities framework (planning): the fix named when a requirement has no supported plan claim. */
const PLAN_MAPPING_FIX =
	"submit a plan claim for every formalized requirement id, naming the plan work that serves it; a claim the " +
	"quoted evidence does not support cannot map the requirement";
/** FR-20: the fix named when a criterion is not backed by the accepted requirement it references. */
const CRITERIA_FIX =
	"reference an accepted requirement id and state a checkable criterion of that requirement; a criterion the " +
	"referenced requirement does not state or entail is not accepted";
/** FR-21: the fix named when no order could be recorded. */
const PRIORITIES_FIX =
	"resubmit stage=requirement_priorities so the judge can rank the accepted requirement list; no order is " +
	"recorded from a partial, escaped or low-confidence answer";
/**
 * Fixed options of the single-claim plan mapping (a formalization with exactly one requirement):
 * the per-claim marking path starts at two claims, so that one mapping goes through one
 * claim-shaped decision instead. A `stages.plan_mapping` template may replace them (R3).
 */
const PLAN_MAPPING_OPTIONS: DecisionOption[] = [
	{
		id: PLAN_MAPPING_APPROVED_OPTION,
		label: "The plan serves the requirement",
		meaning:
			"the plan work named in the claim covers the quoted formalized requirement and nothing in the plan contradicts it",
	},
	{
		id: PLAN_MAPPING_INCOMPLETE_OPTION,
		label: "Mapping incomplete or unsupported",
		meaning:
			"the formalized requirement has no plan work that serves it, or the claim is not supported by the quoted evidence; name what is missing",
	},
];
/**
 * The gate option sets, refusal conditions, frame-escape marker and consult deadlines live with
 * the descriptors (src/gates.ts): the three gates and the three reviews are one mechanism, so
 * nothing about a gate's options or deadline is declared here any more.
 */
/**
 * Age bound for a captured work order. A `task` tool call refused between capture and execution
 * (a foreign `tool_call` block, a preflight refusal or an approval deny - wrapper.ts:284-327
 * throws before `execute`) never reaches a spawn, so its order would linger and disarm the
 * dispatch check for the rest of the session; it is cleared outright when the task changes, and a
 * spawn that consumed it retires it when the order has served its purpose.
 * Two minutes is far longer than any real dispatch and far shorter than a task.
 */
const HANDOFF_ORDER_MAX_AGE_MS = 120_000;
/**
 * Age bound for an allowed mutating tool call awaiting its own `tool_result` (the automatic
 * course-check input). A call whose result never arrives (session abort, an outcome the host
 * surfaces some other way) must neither linger nor judge a later call; the entry is cleared
 * outright when the task changes. Measured tool results follow their call within seconds, so the
 * same two-minute bound as the handoff orders is far longer than any real call.
 */
const PENDING_MUTATION_MAX_AGE_MS = 120_000;
/** The host builds a settled background job's delivery as this custom message (session/async-job-delivery.ts). */
const ASYNC_RESULT_MESSAGE_TYPE = "async-result";
const STATE_ENTRY_TYPE = "jev.state";
const TOOL_NAME = "jev_decision";

export interface ValidatedDecisionInput {
	stage: DecisionStage;
	task: string;
	proposal: string;
	/**
	 * Short name of the approach this attempt takes (PRD 19 rework loop). Optional; absent keeps the
	 * digest-bound rework semantics. A name already spent on the same task+stage is refused before any
	 * judge call, a new name is a new attempt.
	 */
	approach?: string;
	/**
	 * The declared answers to the standing named problems of this stage (PRD 1.1/FR-10: the answer
	 * obliges). Positional: entry i answers problem i of the numbered list the refusal delivered,
	 * each stating what changed in the work. Empty when no problem stands.
	 */
	answers: string[];
	options: DecisionOption[];
	evidence: Evidence[];
	capabilities: string[];
	/** Claimed-aspect catalog ids for the aspect_coverage preset. */
	aspects: string[];
	/** Claim texts for the claim_check preset (each judged separately against the evidence). */
	claims: string[];
	/** Draft numbered requirements for the requirements_formalization stage, each naming its quote. */
	requirements: Array<{ text: string; quoteId: string }>;
	/** Per-requirement plan claims for the plan_mapping stage (planning activity). */
	planClaims: Array<{ requirementId: string; claim: string }>;
	/** FR-20: acceptance criteria for the acceptance_criteria stage, each referencing an accepted id. */
	criteria: Array<{ requirementId: string; text: string }>;
	/** FR-13 part (1): the old-function inventory submitted to the refactor_inventory stage. */
	inventory: RefactorInventoryItem[];
	/** FR-13 part (2): the artifact material attached to each inventory item for refactor_marking. */
	inventoryMarks: Array<{ id: string; evidence: Evidence[] }>;
}

export interface ValidationResult {
	ok: boolean;
	reasons: string[];
	input?: ValidatedDecisionInput;
}

/**
 * Parse one {kind,source,quote} evidence item. Shared by the submission's own `evidence` array
 * and by the per-item material a refactor marking attaches, so both boundaries reject the same
 * malformed shapes with the same words. Undefined when malformed; the defect is pushed.
 */
function parseEvidenceItem(value: unknown, where: string, reasons: string[]): Evidence | undefined {
	if (!isRecord(value) || typeof value["kind"] !== "string" || !EVIDENCE_KINDS.has(value["kind"])) {
		reasons.push(`${where}.kind must be one of: ${[...EVIDENCE_KINDS].join(", ")}`);
		return undefined;
	}
	if (!nonEmptyString(value["source"]) || !nonEmptyString(value["quote"])) {
		reasons.push(`${where} must carry non-empty source and quote`);
		return undefined;
	}
	return {
		kind: value["kind"] as Evidence["kind"],
		source: value["source"] as string,
		quote: value["quote"] as string,
	};
}

/** Validate the executor's structured decision submission. Never throws. */
export function validateDecisionInput(raw: unknown, extraStages: ReadonlySet<string> = new Set()): ValidationResult {
	const reasons: string[] = [];
	if (!isRecord(raw)) return { ok: false, reasons: ["decision input must be a JSON object"] };
	const stage = raw["stage"];
	if (typeof stage !== "string" || !(STAGES.has(stage) || extraStages.has(stage))) {
		reasons.push(`stage must be one of: ${[...new Set([...STAGES, ...extraStages])].join(", ")}`);
	}
	if (!nonEmptyString(raw["task"])) reasons.push("task must be a non-empty string");
	if (!nonEmptyString(raw["proposal"])) reasons.push("proposal must be a non-empty string");
	// Optional loop field (PRD 19): when present it names the approach this attempt takes, so a
	// repeated approach can be refused before the judge call. A blank or non-string value is a
	// submission defect - refused pre-judge like every other malformed field.
	const rawApproach = raw["approach"];
	let approach: string | undefined;
	if (rawApproach !== undefined) {
		if (typeof rawApproach !== "string" || rawApproach.trim().length === 0) {
			reasons.push("approach must be a non-empty string naming the approach when provided");
		} else {
			approach = rawApproach.trim();
		}
	}
	// The declared answers to a standing refusal (PRD 1.1/FR-10): positional, one per named
	// problem. A blank entry is a submission defect like every other malformed field - the
	// problem it claims to answer would not be answered by it either way.
	const rawAnswers = raw["answers"];
	const answers: string[] = [];
	if (rawAnswers !== undefined) {
		if (!Array.isArray(rawAnswers) || rawAnswers.some(a => typeof a !== "string" || a.trim().length === 0)) {
			reasons.push(
				"answers must be an array of non-empty strings: one entry per standing problem, in the order " +
					"the refusal named them, each stating what changed in the work",
			);
		} else {
			for (const answer of rawAnswers) answers.push((answer as string).trim());
		}
	}
	const rawOptions = raw["options"];
	if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
		reasons.push("options must be a non-empty array of {id,label,meaning}");
	}
	const options: DecisionOption[] = [];
	if (Array.isArray(rawOptions)) {
		rawOptions.forEach((o, i) => {
			if (!isRecord(o) || !nonEmptyString(o["id"]) || !nonEmptyString(o["label"]) || !nonEmptyString(o["meaning"])) {
				reasons.push(`options[${i}] must have non-empty id, label and meaning`);
				return;
			}
			options.push({ id: o["id"] as string, label: o["label"] as string, meaning: o["meaning"] as string });
		});
	}
	const optionIds = new Set(options.map(o => o.id));
	if (optionIds.size !== options.length) reasons.push("option ids must be unique");
	const rawEvidence = raw["evidence"];
	if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
		reasons.push("evidence must be a non-empty array of {kind,source,quote}");
	}
	const evidence: Evidence[] = [];
	if (Array.isArray(rawEvidence)) {
		rawEvidence.forEach((e, i) => {
			const parsed = parseEvidenceItem(e, `evidence[${i}]`, reasons);
			if (parsed !== undefined) evidence.push(parsed);
		});
	}
	const aspects = Array.isArray(raw["aspects"])
		? raw["aspects"].filter((a): a is string => typeof a === "string" && a.trim().length > 0)
		: [];
	const capabilities = Array.isArray(raw["capabilities"])
		? raw["capabilities"].filter((c): c is string => typeof c === "string" && c.trim().length > 0)
		: [];
	const claims = Array.isArray(raw["claims"])
		? raw["claims"].filter((c): c is string => typeof c === "string" && c.trim().length > 0)
		: [];
	const requirementItems: Array<{ text: string; quoteId: string }> = [];
	const rawRequirements = raw["requirements"];
	if (rawRequirements !== undefined && !Array.isArray(rawRequirements)) {
		reasons.push("requirements must be an array of {text, quoteId}");
	} else if (Array.isArray(rawRequirements)) {
		rawRequirements.forEach((r, i) => {
			if (!isRecord(r) || !nonEmptyString(r["text"]) || !nonEmptyString(r["quoteId"])) {
				// FR-19: an item without a number and a named verbatim quote is not a formalized
				// requirement, so it is refused here - before any judge call.
				reasons.push(
					`requirements[${i}] must be {text, quoteId}: the item's own wording and the id of the ` +
						"submitted user/spec quote it derives from (an item without a quote is refused)",
				);
				return;
			}
			requirementItems.push({ text: r["text"] as string, quoteId: r["quoteId"] as string });
		});
	}
	const criteria: Array<{ requirementId: string; text: string }> = [];
	const rawCriteria = raw["criteria"];
	if (rawCriteria !== undefined && !Array.isArray(rawCriteria)) {
		reasons.push("criteria must be an array of {requirementId, text}");
	} else if (Array.isArray(rawCriteria)) {
		rawCriteria.forEach((c, i) => {
			if (!isRecord(c) || !nonEmptyString(c["requirementId"]) || !nonEmptyString(c["text"])) {
				// FR-20: a criterion that references no requirement is refused before any judge call.
				reasons.push(
					`criteria[${i}] must be {requirementId, text}: the criterion and the id of the accepted ` +
						"formalized requirement it checks (a criterion referencing no requirement is refused)",
				);
				return;
			}
			criteria.push({ requirementId: c["requirementId"] as string, text: c["text"] as string });
		});
	}
	const planClaims: Array<{ requirementId: string; claim: string }> = [];
	const rawPlanClaims = raw["planClaims"];
	if (rawPlanClaims !== undefined && !Array.isArray(rawPlanClaims)) {
		reasons.push("planClaims must be an array of {requirementId, claim}");
	} else if (Array.isArray(rawPlanClaims)) {
		rawPlanClaims.forEach((c, i) => {
			if (!isRecord(c) || !nonEmptyString(c["requirementId"]) || !nonEmptyString(c["claim"])) {
				reasons.push(`planClaims[${i}] must have non-empty requirementId and claim`);
				return;
			}
			planClaims.push({ requirementId: c["requirementId"] as string, claim: c["claim"] as string });
		});
	}
	// FR-13 part (1): the inventory of the old functions. Every item names the function and the
	// command that verifies it; ids are unique so the marking below can only match one item.
	const inventory: RefactorInventoryItem[] = [];
	const rawInventory = raw["inventory"];
	if (rawInventory !== undefined && !Array.isArray(rawInventory)) {
		reasons.push("inventory must be an array of {id, name, verification}");
	} else if (Array.isArray(rawInventory)) {
		const seenInventoryIds = new Set<string>();
		rawInventory.forEach((item, i) => {
			if (
				!isRecord(item) ||
				!nonEmptyString(item["id"]) ||
				!nonEmptyString(item["name"]) ||
				!nonEmptyString(item["verification"])
			) {
				reasons.push(
					`inventory[${i}] must have non-empty id, name and verification ` +
						"(verification = the command that checks this function)",
				);
				return;
			}
			const id = item["id"] as string;
			if (seenInventoryIds.has(id)) {
				reasons.push(`inventory[${i}].id duplicated: ${id}`);
				return;
			}
			seenInventoryIds.add(id);
			inventory.push({
				id,
				name: item["name"] as string,
				verification: item["verification"] as string,
			});
		});
	}
	// FR-13 part (2): the material attached to each inventory item. The shape is validated here;
	// whether the material is an artifact (code/execution/log) rather than a claim is the
	// stage's pre-check, because that is the requirement's own line, not a schema rule.
	const inventoryMarks: Array<{ id: string; evidence: Evidence[] }> = [];
	const rawMarks = raw["inventoryMarks"];
	if (rawMarks !== undefined && !Array.isArray(rawMarks)) {
		reasons.push("inventoryMarks must be an array of {id, evidence}");
	} else if (Array.isArray(rawMarks)) {
		const seenMarkIds = new Set<string>();
		rawMarks.forEach((mark, i) => {
			if (!isRecord(mark) || !nonEmptyString(mark["id"])) {
				reasons.push(`inventoryMarks[${i}] must have a non-empty id`);
				return;
			}
			const id = mark["id"] as string;
			if (seenMarkIds.has(id)) {
				reasons.push(`inventoryMarks[${i}].id duplicated: ${id}`);
				return;
			}
			seenMarkIds.add(id);
			const rawItemEvidence = mark["evidence"];
			if (!Array.isArray(rawItemEvidence) || rawItemEvidence.length === 0) {
				reasons.push(`inventoryMarks[${i}].evidence must be a non-empty array of {kind,source,quote}`);
				return;
			}
			const itemEvidence: Evidence[] = [];
			rawItemEvidence.forEach((e, j) => {
				const parsed = parseEvidenceItem(e, `inventoryMarks[${i}].evidence[${j}]`, reasons);
				if (parsed !== undefined) itemEvidence.push(parsed);
			});
			inventoryMarks.push({ id, evidence: itemEvidence });
		});
	}
	if (reasons.length > 0) return { ok: false, reasons };
	return {
		ok: true,
		reasons: [],
		input: {
			stage: stage as DecisionStage,
			task: raw["task"] as string,
			proposal: raw["proposal"] as string,
			approach,
			answers,
			options,
			evidence,
			capabilities,
			aspects,
			claims,
			requirements: requirementItems,
			planClaims,
			criteria,
			inventory,
			inventoryMarks,
		},
	};
}

// ---------- revision hashing ----------

function canonicalEvidence(evidence: Evidence[]): string {
	return JSON.stringify(
		evidence.map(e => ({ kind: e.kind, source: e.source, quote: e.quote })).sort((a, b) =>
			(a.kind + a.source + a.quote).localeCompare(b.kind + b.source + b.quote),
		),
	);
}

function toHex(digest: ArrayBuffer, slice?: number): string {
	const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
	return slice === undefined ? hex : hex.slice(0, slice);
}

/**
 * Content digest of a submission. `approach` is passed only by the REWORK-BOUND call site (PRD 19):
 * a new approach is a new attempt even over unchanged wording - while the approval digest (AC5)
 * stays byte-for-byte what it was, so persisted approvals keep binding.
 */
async function revisionHash(
	stage: string,
	task: string,
	proposal: string,
	evidence: Evidence[],
	approach?: string,
): Promise<string> {
	let material = `${stage}\u0000${task}\u0000${proposal}\u0000${canonicalEvidence(evidence)}`;
	if (approach !== undefined) material += `\u0000${approach}`;
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)));
}

async function fingerprint(text: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)), 16);
}

// ---------- judge result validation ----------

const VERDICTS: ReadonlySet<string> = new Set(["approve", "revise", "insufficient_evidence", "ask_user"]);

/**
 * The judge-result normalization is the mechanism's (src/gates.ts: the consult runner and this
 * decision pipeline must share one fail-closed normalization); re-exported for existing importers.
 */
export const normalizeJudgeResult = mechanism.normalizeJudgeResult;

// ---------- controller ----------

export interface ControllerDeps {
	judge: Judge;
	/** Bounded rework per task+stage (FR-12). */
	maxReworkIterations?: number;
	minConfidence?: number;
	now?: () => number;
	/** Template overrides (R1-R6): threshold may only RAISE the bar; stage shaping only. */
	template?: JevTemplateConfig;
	/** Validation error from a config file: fail closed on every submission (R5). */
	templateError?: string;
	/** Per-requirement drift judge for the course_check preset (C1 wired path). */
	courseCheckJudge?: CourseCheckJudge;
	/** Three-way aspect marking judge: the aspect_coverage preset AND judged completion capability coverage (requireAll). */
	aspectCoverageJudge?: AspectCoverageJudge;
	/** Per-claim support judge: the claim_check preset (N claims, one request, one verdict per claim). */
	claimCheckJudge?: ClaimCheckJudge;
	/** Per-item traceability judge: the requirements_formalization stage (one request, per-item marks). */
	requirementsFormalizationJudge?: RequirementsFormalizationJudge;
	/** FR-20 per-criterion judge: the acceptance_criteria stage (one request, one mark per criterion). */
	acceptanceCriteriaJudge?: AcceptanceCriteriaJudge;
	/** FR-21 ranking judge: the requirement_priorities stage (one priority class per accepted item). */
	priorityJudge?: PriorityJudge;
	/**
	 * FR-13 per-item marking judge: the refactor_marking stage (one request, one preserved/lost
	 * marking per inventory item, judged from the material attached to that item).
	 */
	refactorMarkingJudge?: RefactorMarkingJudge;
	/**
	 * Activity registry (src/activities.ts): the frame the controller enforces outcome sets
	 * against. Tests inject a doctored registry to prove an undeclared outcome fails closed.
	 */
	activities?: ActivityRegistry;
	/** Valid catalog topic ids for the aspects[] pre-check (built in index from the catalog). */
	catalogIds?: ReadonlySet<string>;
	/** FR-01/FR-04 wiring: the catalog and the marking judge for the automatic task-start checks. */
	catalog?: CatalogTopic[];
	multiLabelJudge?: MultiLabelJudge;
	/**
	 * FR-11 dispatch consult deadline; must stay under the host's 30s handler timeout
	 * (HANDOFF_DISPATCH_DEADLINE_MS). Exposed for tests only.
	 */
	handoffDispatchDeadlineMs?: number;
	/**
	 * Destructive-action consult deadline; must stay under the host's 30s `tool_call` handler
	 * timeout, whose on-timeout policy is fail-closed (DESTRUCTIVE_DEADLINE_MS). Tests only.
	 */
	destructiveDeadlineMs?: number;
	/**
	 * Project root the outside-root write trigger measures a target against - the same directory the
	 * config loader reads `<cwd>/.omp/jev.config.json` from. Absent = `process.cwd()` read at each
	 * judgement, which is what the extension's own config loading resolves (tests pin it).
	 */
	projectRoot?: string;
	/** Review judge: the fixed question set of a review stage in one request (src/client.ts). */
	reviewJudge?: ReviewJudge;
	/** Review consult deadline; must stay under the host's handler timeout (REVIEW_DEADLINE_MS). Tests only. */
	reviewDeadlineMs?: number;
}

/** Minimal structural surface of the omp ExtensionAPI the controller needs. */
export interface PiApi {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
	}): void;
	appendEntry(customType: string, data?: unknown): void;
	sendMessage(
		payload: unknown,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void;
}

export class JevController {
	private state: JevState = freshState();
	private readonly judge: Judge;
	private readonly maxReworkIterations: number;
	private readonly now: () => number;
	private pi: PiApi | undefined;
	private readonly courseCheckJudge: CourseCheckJudge | undefined;
	private readonly aspectCoverageJudge: AspectCoverageJudge | undefined;
	private readonly claimCheckJudge: ClaimCheckJudge | undefined;
	private readonly requirementsFormalizationJudge: RequirementsFormalizationJudge | undefined;
	private readonly acceptanceCriteriaJudge: AcceptanceCriteriaJudge | undefined;
	private readonly priorityJudge: PriorityJudge | undefined;
	private readonly refactorMarkingJudge: RefactorMarkingJudge | undefined;
	/** Activity registry the outcome-set guard resolves against (default: the product registry). */
	private readonly activities: ActivityRegistry;
	/** In-flight automatic (periodic) course-check chain; never awaited by the tool path. */
	private autoCourseCheck: Promise<void> | undefined;
	private readonly catalogIds: ReadonlySet<string>;
	private readonly catalog: CatalogTopic[] | undefined;
	private readonly multiLabelJudge: MultiLabelJudge | undefined;
	/** In-flight advisory catalog checks; never awaited by the task path. */
	private catalogChecks: Promise<void> | undefined;
	/** In-flight FR-11 acceptance consult; never awaited by the tool_result path. */
	private handoffAcceptance: Promise<void> | undefined;
	private template: JevTemplateConfig;
	private templateError: string | undefined;
	/** Config-declared on_demand control points (controlPoints key). */
	private extraPoints: ReadonlyMap<string, ControlPoint> = new Map();
	/** R1: never below POLICY floor; a template override may only raise it. */
	private minConfidence: number;
	/** Calibration-tolerant completion: template/config may only RAISE these (Math.max clamp). */
	private completionConsecutiveApproves!: number;
	private completionConfidenceFloor!: number;
	/** FR-11 dispatch consult deadline (under the host's 30s handler timeout). */
	private readonly handoffDispatchDeadlineMs: number;
	/** Destructive-action consult deadline (under the host's fail-closed 30s tool_call timeout). */
	private readonly destructiveDeadlineMs: number;
	/** Project root for the outside-root write trigger; undefined = `process.cwd()` at each judgement. */
	private readonly projectRoot: string | undefined;
	/** Review judge: the fixed question set of a review stage in one request. */
	private readonly reviewJudge: ReviewJudge | undefined;
	/** Review consult deadline (under the host's handler timeout). */
	private readonly reviewDeadlineMs: number;

	constructor(deps: ControllerDeps) {
		this.judge = deps.judge;
		this.courseCheckJudge = deps.courseCheckJudge;
		this.aspectCoverageJudge = deps.aspectCoverageJudge;
		this.claimCheckJudge = deps.claimCheckJudge;
		this.requirementsFormalizationJudge = deps.requirementsFormalizationJudge;
		this.acceptanceCriteriaJudge = deps.acceptanceCriteriaJudge;
		this.priorityJudge = deps.priorityJudge;
		this.refactorMarkingJudge = deps.refactorMarkingJudge;
		this.activities = deps.activities ?? ACTIVITY_REGISTRY;
		this.catalogIds = deps.catalogIds ?? new Set();
		this.catalog = deps.catalog;
		this.multiLabelJudge = deps.multiLabelJudge;
		this.maxReworkIterations = deps.maxReworkIterations ?? POLICY.maxReworkIterations;
		this.handoffDispatchDeadlineMs = deps.handoffDispatchDeadlineMs ?? mechanism.HANDOFF_DISPATCH_DEADLINE_MS;
		this.destructiveDeadlineMs = deps.destructiveDeadlineMs ?? mechanism.DESTRUCTIVE_DEADLINE_MS;
		this.projectRoot = deps.projectRoot;
		this.reviewJudge = deps.reviewJudge;
		this.reviewDeadlineMs = deps.reviewDeadlineMs ?? REVIEW_DEADLINE_MS;
		// R1: a confidenceThreshold override may only RAISE the bar above POLICY.
		this.minConfidence = Math.max(
			deps.minConfidence ?? POLICY.minConfidenceToApprove,
			deps.template?.confidenceThreshold ?? 0,
		);
		this.now = deps.now ?? (() => Date.now());
		this.template = deps.template ?? {};
		this.templateError = deps.templateError;
		this.extraPoints = extraPointsFromTemplate(this.template);
		this.applyCompletionClamps();
	}

	/** Raise-only completion clamps from the active template (constructor + every reload). */
	private applyCompletionClamps(): void {
		this.completionConsecutiveApproves = Math.max(
			POLICY.completionConsecutiveApproves,
			this.template.completion?.consecutiveApproves ?? 0,
		);
		this.completionConfidenceFloor = Math.max(
			POLICY.completionConfidenceFloor,
			this.template.completion?.confidenceFloor ?? 0,
		);
	}

	/** Re-validate config mid-session (R5): corruption degrades to typed fail-closed errors. */
	setTemplateState(template: JevTemplateConfig | undefined, templateError?: string): void {
		this.template = template ?? {};
		this.extraPoints = extraPointsFromTemplate(this.template);
		this.templateError = templateError;
		if (templateError === undefined && template?.confidenceThreshold !== undefined) {
			this.minConfidence = Math.max(POLICY.minConfidenceToApprove, template.confidenceThreshold);
		}
		// A raised completion config applies on reload, same raise-only clamp as construction.
		this.applyCompletionClamps();
	}

	// ----- registration -----

	register(pi: PiApi): void {
		this.pi = pi;
		pi.registerTool({
			name: TOOL_NAME,
			label: "Jev decision",
			description:
				"If any action is blocked by the plan gate, your very next tool call MUST be jev_decision itself " +
				"with stage=understanding_review (plan stage) and verbatim quoted evidence — do not write files " +
				"first, do not report the block to the user. " +
				"Submit a structured important decision, review or completion claim to the Jev judge. " +
				"Required before any file-mutating work and before finishing work. " +
				"Consultation protocol (it decides the answer quality; live: 0.14-0.26 ungrounded against " +
				"0.79-0.96 for the same material phrased as a claim): one decision per request — write a claim " +
				"and ask whether the quoted evidence supports it, never an open request to approve a summary; " +
				"3-6 short non-duplicate quotes; on plan stages at least one submitted quote (20+ characters) must " +
				"appear verbatim inside the proposal and at least one requirement quote (kind user or spec) must be " +
				"among the evidence, so the plan is a claim checked against the quoted evidence; 2-4 real " +
				"alternatives whose meanings state what choosing them commits you to. " +
				"A plan-stage proposal that quotes no evidence is refused before any judge call, consuming no " +
				"rework, with the fix named. " +
				`Rework is a bounded loop with a changed approach: at most ${this.maxReworkIterations} attempts per ` +
				"stage per task, and every attempt MUST name a DIFFERENT `approach` (a short name of the move, e.g. " +
				'"tighten the trigger", "split into narrower items", "state the outcome plus the evidence that ' +
				'settles it"). An approach already spent on this stage is refused before any judge call, naming ' +
				"the approaches already tried and consuming no rework - the same approach in different words is " +
				`never a new attempt. When the ${this.maxReworkIterations} attempts are exhausted the stage escalates ` +
				"as an OPEN item with the journal of approaches and the judge's answer to each; the wording is " +
				"never bent to fit an answer. " +
				"THE ANSWER OBLIGES: when the judge refuses a submission on a stage and names its reasons, those " +
				"reasons are recorded as the standing problems of that stage and delivered into this session as a " +
				"numbered list. The next submission on that stage must state, positionally in `answers`, what changed " +
				"in the WORK for each problem (one entry per problem, in the numbered order), and no approval or pass " +
				"of that stage is recorded while any problem is unanswered - for a plan-granting stage the mutation " +
				"gate stays shut even when an older approval exists. The judge reads the standing problems and your " +
				"answers verbatim inside the next consultation, so it decides whether each problem is resolved; an " +
				"abstention, a sub-floor answer or a judge error neither creates nor clears the obligation. " +
				"An abstention is not a verdict: insufficient_evidence means better " +
				"evidence is needed, not the same request again, and a judge-chosen service option means the " +
				"offered set was wrong, not that the work failed. " +
				"Write your own text - task, proposal, option labels and meanings - in English; quoted " +
				"evidence keeps the original wording of its source verbatim. " +
				"Provide fixed options " +
				"and evidence as {kind, source, quote} items (kind: user|spec|code|execution|log|documentation). " +
				"Completion claims additionally need execution/code/log evidence; pass `capabilities` " +
				"(original feature ids) for refactor completion coverage checks. " +
				"Run stage=course_check at the task/plan boundary, after every work mutation and before claiming " +
				"completion: the completion gate requires a fresh judged course_check with option continue " +
				"(verify_before_proceeding never unlocks). Pass `aspects` (catalog topic ids) with " +
				"stage=aspect_coverage to check for forgotten aspects. " +
				"Use stage=claim_check for several claims at once: pass 2+ claim texts in `claims` and each is " +
				"judged separately against the quoted evidence in ONE request, returning one verdict per claim; " +
				"it is advisory (it never unlocks a gate) and a claim the judge cannot mark is named and fails " +
				"closed. Options and the proposal stay required by the schema but are not judged on claim_check " +
				"(the claim judge reads `task`, `claims` and `evidence`). " +
				"Use stage=requirements_formalization to formalize the task/spec: pass the draft numbered list in " +
				"`requirements` (one text per numbered requirement) plus the user/spec quotes as evidence; every " +
				"item comes back marked traceable or not, and the result names the quoted source texts no " +
				"requirement captures (the coverage verdict). An untraceable item is refused and fails closed; " +
				"the stage never unlocks a gate, and only a completely formalized list becomes the checklist " +
				"later stages are judged against. " +
				"Once a list is formalized, planning needs the per-requirement mapping: submit stage=plan_mapping " +
				"with `planClaims` (one {requirementId, claim} per formalized requirement, the claim being that " +
				"the plan serves it); a requirement without a supported claim leaves planning incomplete and " +
				"mutating work stays blocked until the mapping covers every requirement. " +
				"Submit stage=requirement_priorities (no list to supply: the accepted requirements are used) so " +
				"the judge sets the build order over them; the order is recorded with each item's own quote and " +
				"the session works by it, and mutating work stays blocked until the accepted batch has a fresh " +
				"order - a new accepted batch retires the previous order by name. " +
				"Submit stage=acceptance_criteria with `criteria` (one {requirementId, text} per criterion, the " +
				"id being an ACCEPTED formalized requirement) so the judge marks every criterion against the " +
				"referenced requirement; a criterion referencing no accepted requirement is refused before any " +
				"judge call, and a criterion the judge does not accept is named at the completion boundary. " +
				"(`options` and `proposal` stay required by the tool schema on all four stages, but the judges read " +
				"`task`, `requirements`/`planClaims`/`criteria` and `evidence`.) " +
				"Use stage=business_review, stage=architecture_review or stage=security_review for the review " +
				"activities: pass the material as quoted evidence, the declared items (decisions, defects or " +
				"surfaces) in `claims` and the declared candidates for the review's choice question in `options`. " +
				"The review asks its fixed question set in ONE request and records the per-item results " +
				"(scores with confidences, the chosen candidate, every statement verdict) in the session; it is " +
				"advisory - it refuses nothing, and only a confident negative statement comes back as a finding to " +
				"answer. " +
				"Refactoring has two steps (FR-13). Before the first code edit of the task, submit " +
				"stage=refactor_inventory with `inventory`: one {id, name, verification} per old function, where " +
				"`verification` is the command that checks it. A submission after the first edit is refused " +
				"(an inventory written afterwards cannot establish what existed before), and the recorded " +
				"inventory is what the completion boundary compares against. After the refactoring, submit " +
				"stage=refactor_marking with `inventoryMarks`: one {id, evidence} per inventory item, the evidence " +
				"being that item's own artifact material (a code quote or a command output - kind code, execution " +
				"or log; a claim is not evidence). The judge marks every item preserved or lost from its own " +
				"material; an item it can only mark not_evidenced blocks completion, which names that item.",
			parameters: {
				type: "object",
				properties: {
					stage: { type: "string", description: "which gate this decision belongs to" },
					task: { type: "string", description: "what is being decided" },
					proposal: { type: "string", description: "the proposal/result under judgment" },
					approach: {
						type: "string",
						description:
							"short name of the approach this attempt takes, e.g. \"tighten the trigger\"; it must " +
							"differ from every approach already spent on this stage - a repeated approach is " +
							"refused before any judge call",
					},
					answers: {
						type: "array",
						items: { type: "string" },
						description:
							"the declared answers to the standing named problems of this stage, POSITIONAL: entry i " +
							"answers problem i of the numbered list the refusal delivered into the session, each " +
							"stating what changed in the WORK for that problem. Required (complete) when the stage is " +
							"under a refusal: with any problem unanswered no approval or pass of this stage is recorded",
					},
					options: {
						type: "array",
						items: {
							type: "object",
							properties: { id: { type: "string" }, label: { type: "string" }, meaning: { type: "string" } },
							required: ["id", "label", "meaning"],
						},
					},
					evidence: {
						type: "array",
						items: {
							type: "object",
							properties: { kind: { type: "string" }, source: { type: "string" }, quote: { type: "string" } },
							required: ["kind", "source", "quote"],
						},
					},
					capabilities: { type: "array", items: { type: "string" } },
					aspects: {
						type: "array",
						items: { type: "string" },
						description: "catalog topic ids to mark for the aspect_coverage stage",
					},
					claims: {
						type: "array",
						items: { type: "string" },
						description:
							"2+ claim texts for stage=claim_check, each judged separately against the quoted evidence; " +
							"for the review stages (business_review, architecture_review, security_review) the " +
							"DECLARED items under review (decisions, defects, surfaces), one statement question per item",
					},
					requirements: {
						type: "array",
						items: {
							type: "object",
							properties: { text: { type: "string" }, quoteId: { type: "string" } },
							required: ["text", "quoteId"],
						},
						description:
							"draft numbered requirement list for stage=requirements_formalization; one {text, " +
							"quoteId} per numbered item, where quoteId names one of the submitted user/spec " +
							"evidence quotes it derives from (an item naming no quote is refused before any judge call)",
					},
					criteria: {
						type: "array",
						items: {
							type: "object",
							properties: { requirementId: { type: "string" }, text: { type: "string" } },
							required: ["requirementId", "text"],
						},
						description:
							"stage=acceptance_criteria: one {requirementId, text} per acceptance criterion, the " +
							"id being an ACCEPTED formalized requirement the criterion checks; a criterion " +
							"referencing no accepted requirement is refused before any judge call",
					},
					planClaims: {
						type: "array",
						items: {
							type: "object",
							properties: { requirementId: { type: "string" }, claim: { type: "string" } },
							required: ["requirementId", "claim"],
						},
						description:
							"stage=plan_mapping: one {requirementId, claim} per formalized requirement id, the claim " +
							"being that the plan serves it; a requirement left out leaves planning incomplete",
					},
					inventory: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								name: { type: "string" },
								verification: { type: "string" },
							},
							required: ["id", "name", "verification"],
						},
						description:
							"stage=refactor_inventory: the old functions the refactoring touches, one " +
							"{id, name, verification} per function BEFORE the first code edit; `verification` is the " +
							"command that checks that function, and a submission after the first edit is refused",
					},
					inventoryMarks: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								evidence: {
									type: "array",
									items: {
										type: "object",
										properties: {
											kind: { type: "string" },
											source: { type: "string" },
											quote: { type: "string" },
										},
										required: ["kind", "source", "quote"],
									},
								},
							},
							required: ["id", "evidence"],
						},
						description:
							"stage=refactor_marking: one {id, evidence} per inventory item AFTER the refactoring; the " +
							"evidence must be the artifact material for THAT item (kind code/execution/log - the code " +
							"quote or the command output). The judge marks each item preserved or lost from its own " +
							"material; an item whose material is a claim is marked not_evidenced and keeps completion " +
							"blocked by name",
					},
				},
				required: ["stage", "task", "proposal", "options", "evidence"],
			},
			execute: async (_id: string, params: unknown) => {
				const outcome = await this.submitDecision(params);
				return {
					content: [
						{
							type: "text",
							text: `${outcome.summary}\n${JSON.stringify(outcome, null, 2)}`,
						},
					],
					details: outcome,
				};
			},
		});
		pi.on("tool_call", (event, ctx) => this.onToolCall(event, ctx));
		// POLICY-DRAFT I: a separate handler (same shape as the FR-11 dispatch side) so the plan
		// gate's result stays deterministic when the destructive consult runs long; a plan-gate
		// block short-circuits the event and this consult never happens.
		pi.on("tool_call", (event, ctx) => this.onDestructiveCall(event, ctx));
		pi.on("before_agent_start", event => this.onBeforeAgentStart(event));
		pi.on("session_stop", event => this.onSessionStop(event));
		pi.on("before_subagent_spawn", (event, ctx) => this.onBeforeSubagentSpawn(event, ctx));
		// FR-11 dispatch side: a separate handler so the model-routing result stays deterministic
		// even when the judge consult runs long enough to hit the host's handler timeout (a
		// timed-out handler result is dropped whole, routing included).
		pi.on("before_subagent_spawn", (event, ctx) => this.onHandoffDispatch(event, ctx));
		// FR-11 acceptance side: omp's task tool returns a spawn acknowledgement, so the delegated
		// result is judged where the host delivers it - the custom `async-result` message a settled
		// background job produces (message_end is notification-only, so this handler cannot refuse).
		pi.on("message_end", (event, ctx) => this.onDeliveredResult(event, ctx));
		// The acknowledgement itself: recorded as not-judged while the acceptance side is armed.
		pi.on("tool_result", (event, ctx) => this.onTaskResult(event, ctx));
	}

	// ----- event handlers (also directly test-invokable) -----

	/**
	 * Pre-execution gates (AC4a): malformed jev_decision input never reaches the judge;
	 * mutating tool calls are blocked until the plan gate holds for the current task.
	 * Read-only tools pass untouched in every case.
	 */
	onToolCall(event: unknown, _ctx?: unknown): { block?: boolean; reason?: string } | undefined {
		if (!isRecord(event)) return undefined;
		const toolName = event["toolName"];
		if (toolName === TOOL_NAME) {
			const check = validateDecisionInput(event["input"], this.extraStageSet());
			if (!check.ok) {
				return {
					block: true,
					reason:
						`jev_decision rejected before judging: ${check.reasons.join("; ")}. ` +
						`Fix the listed problems and call ${TOOL_NAME} again.`,
				};
			}
			return undefined;
		}
		if (toolName === "task") {
			// FR-11: capture the work order now - before_subagent_spawn carries the agent name
			// but not the prompt, and tool_call is the only hook that sees the task tool input.
			this.captureHandoffWorkOrder(event);
			return undefined;
		}
		// These write targets dispatch to tools, not files: keep the judge reachable and
		// let agents report a blocker to their parent without granting plan approval.
		if (toolName === "write" && isRecord(event["input"])) {
			const path = event["input"]["path"];
			if (path === "xd://jev_decision" || (typeof path === "string" && path.startsWith("agent://") && path !== "agent://")) {
				return undefined;
			}
		}
		if (typeof toolName === "string" && MUTATING_TOOLS.has(toolName)) {
			// Fail-closed config (R5): restored approvals never unlock mutations while the
			// template is invalid - the gates run on defaults that were never validated.
			if (this.templateError !== undefined) {
				return {
					block: true,
					reason:
						`jev config invalid (fail-closed): ${this.templateError}. ` +
						"Mutating work is blocked until the config file is fixed; " +
						"read-only evidence gathering remains available.",
				};
			}
			const plan = this.planApproval();
			// User-owned switch: `gates.mutation === false` lifts the block. Judging,
			// digests and the work-revision bump on the next lines are unchanged.
			if (plan === undefined && this.template.gates?.mutation !== false) {
				return {
					block: true,
					reason:
						"plan gate: mutating work requires an approved understanding_review or direction_review " +
						`for the current task first. Call ${TOOL_NAME} if available, or write JSON arguments to ` +
						"xd://jev_decision. Use read/glob/grep to gather evidence; bash is gated because it " +
						"can also mutate files. Other writes remain blocked until plan approval.",
				};
			}
			// Planning is incomplete while a formalized requirement has no supported plan claim
			// (activities framework, planning activity) or while the judged priority order does not
			// rank the accepted batch (FR-21). Only a task with an accepted
			// requirements_formalization is affected - without one the gate behaves as before.
			if (this.template.gates?.mutation !== false) {
				// PRD 1.1/FR-10: a refusal on a plan-granting stage names problems that oblige, and
				// an older approval of that stage does not lift them - the boundary keeps the judge's
				// own answer standing instead of the plan approval it replaced.
				const standing = this.outstandingGrantingProblem();
				if (standing !== undefined) {
					return {
						block: true,
						reason:
							`plan gate: ${standing}. Answer them in the same \`answers\` field of the next ` +
							`submission on that stage and let the judge decide. Read-only evidence gathering ` +
							"remains available.",
					};
				}
				const mappingGap = this.planMappingGap();
				const orderGap = this.prioritiesGap();
				if (mappingGap !== undefined || orderGap !== undefined) {
					const fixes: string[] = [];
					if (mappingGap !== undefined) {
						fixes.push(
							`${mappingGap}. Call ${TOOL_NAME} with stage=${PLAN_MAPPING_STAGE} and ` +
								"`planClaims` naming, for every formalized requirement id, the plan work that " +
								"serves it (the judge marks each claim against the quoted evidence)",
						);
					}
					if (orderGap !== undefined) {
						fixes.push(
							`${orderGap}. Call ${TOOL_NAME} with stage=requirement_priorities so the judge sets ` +
								"the order over the accepted requirement list; the order is re-ranked after every " +
								"accepted batch",
						);
					}
					return {
						block: true,
						reason: `${fixes.join(". ")}. Read-only evidence gathering remains available.`,
					};
				}
			}
			this.state.workRevision += 1;
			this.persist();
			// Activities framework (development): the automatic course check runs on THIS call's
			// matching tool_result, never here - the call has not executed yet, so a consult now
			// could only judge the intention to mutate. The call is remembered for that result.
			this.recordPendingMutation(event, toolName);
		}
		return undefined;
	}

	async onBeforeAgentStart(event: unknown): Promise<void> {
		if (!isRecord(event) || typeof event["prompt"] !== "string") return;
		const fp = await fingerprint(event["prompt"]);
		if (fp !== this.state.taskFingerprint) {
			this.state.taskFingerprint = fp;
			// FR-13: the first code edit of THIS task is what an inventory must precede, and a
			// previous task's inventory/marking never gates a new one.
			this.state.taskStartWorkRevision = this.state.workRevision;
			this.state.refactorInventory = undefined;
			this.state.lastRefactorMarking = undefined;
			// FR-11: the requirement the handoff judge quotes for this task (same source as the
			// fingerprint, so the two can never describe different prompts).
			this.state.taskPrompt = event["prompt"];
			// A stale work order can never legitimately judge a spawn of the new task.
			this.state.pendingHandoffs = {};
			// A late result of the old task must never feed the new task's course check either.
			this.state.pendingMutations = {};
			this.persist();
			// Advisory and non-blocking: a task must not wait on judge latency. Measured live:
			// the checks took 33s against a resetting endpoint, which no task start should pay.
			this.catalogChecks = this.runCatalogChecks(event["prompt"]);
			void this.catalogChecks.catch(() => {});
		}
	}

	/** Await the in-flight advisory catalog checks (test seam; the task path never blocks on them). */
	async catalogChecksSettled(): Promise<void> {
		await this.catalogChecks?.catch(() => {});
	}

	/**
	 * Catalog checks at task start (FR-01, FR-04): the system classifies the task and marks
	 * the applicable plan topics through the judge. Advisory by design - an abstention, a
	 * judge failure or an unwired dependency records uncertainty and never blocks; the owner's
	 * measured constraint is that a check which blocks on abstention becomes a permanent block.
	 */
	private async runCatalogChecks(task: string): Promise<void> {
		if (this.catalog === undefined || this.catalog.length === 0) return;
		const evidence: Evidence[] = [{ kind: "user", source: "task prompt", quote: task }];
		const notes: string[] = [];
		try {
			const classified = await classifyTaskType(task, evidence, this.judge);
			this.state.taskType =
				classified.verdict === "approve" && classified.selectedOption !== undefined
					? classified.selectedOption
					: undefined;
			if (this.state.taskType === undefined) notes.push(`task type not established (${classified.reasons.join(", ")})`);
		} catch (err) {
			this.state.taskType = undefined;
			notes.push(`task type unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (this.multiLabelJudge !== undefined) {
			try {
				const selection = await selectTopics({ task, evidence, catalog: this.catalog, judge: this.multiLabelJudge });
				this.state.selectedTopics = selection.selected.map(t => t.id);
				if (selection.outcome !== "selected") notes.push(`topics not established (${selection.outcome})`);
			} catch (err) {
				this.state.selectedTopics = undefined;
				notes.push(`topics unavailable: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		this.persist();
		const parts = [
			this.state.taskType !== undefined ? `task type ${this.state.taskType}` : undefined,
			this.state.selectedTopics !== undefined && this.state.selectedTopics.length > 0
				? `applicable topics ${this.state.selectedTopics.join(", ")}`
				: undefined,
			...notes,
		].filter((s): s is string => s !== undefined);
		if (parts.length > 0) this.pushFeedback(`Jev catalog: ${parts.join("; ")}`);
	}

	async onSessionStop(event: unknown): Promise<StopGateResult | undefined> {
		if (!isRecord(event)) return undefined;
		// Never block on a continuation of our own block: finite rework (FR-12, AC4 fail-visible).
		if (event["stop_hook_active"] === true) {
			const missing = this.unmetStopGates();
			if (missing.length > 0) {
				const blocker =
					`Jev gates still unmet after one continuation (${missing.join(", ")}). ` +
					"Stopped WITHOUT fake success: submit the required stage and evidence using " +
					"jev_decision or write JSON arguments to xd://jev_decision, or resolve with the user.";
				if (!this.state.blockers.includes(blocker)) {
					this.state.blockers.push(blocker);
					this.persist();
					this.pushFeedback(blocker);
				}
			}
			return undefined;
		}
		const missing = this.unmetStopGates();
		if (missing.length === 0) return undefined;
		return {
			decision: "block",
			reason:
				`Jev gate(s) not satisfied: ${missing.join("; ")}. ` +
				`Use ${TOOL_NAME} or write JSON arguments to xd://jev_decision with the required stage, ` +
				"fixed options and quoted evidence (completion needs execution/code/log evidence).",
		};
	}

	onBeforeSubagentSpawn(event: unknown, ctx?: unknown): SpawnRouteResult | undefined {
		if (!isRecord(event) || this.state.routedModel === undefined) return undefined;
		const wanted = this.state.routedModel;
		const listed = hostModelIds(ctx);
		if (listed.includes(wanted)) {
			return { model: wanted, note: `Jev model_routing selected ${wanted}; host list confirmed.` };
		}
		return {
			block: true,
			reason:
				`Jev model routing selected ${wanted}, but it is not among the host's authenticated models ` +
				`(${listed.join(", ") || "none"}). Jev never substitutes other models; adjust the routing decision or host config.`,
		};
	}

	/** Record an applied model-routing decision; enforced against the host model list at spawn (AC2). */
	rememberModelRouting(model: string): void {
		this.state.routedModel = model;
		this.persist();
	}

	/**
	 * FR-02: make the judge's skill selection take effect in the running session. The selected
	 * candidate is delivered to the executor as an aside through the same channel every other
	 * verdict uses, carrying its id, its label and the owner's own statement of what choosing it
	 * commits to; the selection is recorded in session state at the same time. A candidate the
	 * owner did not offer can never be activated (the judge only ever sees the configured list),
	 * and nothing is delivered and nothing is recorded on any verdict other than approve.
	 * Returns false when the selection names no configured candidate.
	 */
	activateSkill(skill: string, candidates: readonly RoutingCandidate[]): boolean {
		const candidate = candidates.find(c => c.id === skill);
		if (candidate === undefined) return false;
		this.state.routedSkill = candidate.id;
		this.persist();
		this.pushFeedback(
			`Jev skill_routing activated skill \`${candidate.id}\` (${candidate.label}): ${candidate.meaning} ` +
				"Apply this skill to the current task; session state records it as routedSkill.",
		);
		return true;
	}

	// ----- FR-11 handoff (dispatch + acceptance) -----

	/**
	 * Wiring switch (user-owned): the handoff gate fires only when the owner configured the
	 * `subagent_handoff` stage. FR-11 is an unconfirmed policy (PRD GAP:3) and POLICY-DRAFT
	 * lists spawn judging as a post-approval item, so without that config the session behaves
	 * exactly as before: no consultation, no state captured, no block. The stage is registered,
	 * so the executor may still submit it through jev_decision at any time.
	 */
	private handoffWired(): boolean {
		return this.template.stages?.["subagent_handoff"] !== undefined;
	}

	/**
	 * The acceptance side is a separate, explicitly opt-in switch (`gates.handoffAcceptance`,
	 * default false). F2: omp's task tool returns a spawn acknowledgement and the delegated report
	 * arrives later as the host's `async-result` delivery, so this side depends on a host contract
	 * the live smoke has not verified - it must be armed deliberately, and its uncertainty is
	 * recorded instead of an acknowledgement being judged as a result.
	 */
	private acceptanceWired(): boolean {
		return this.handoffWired() && this.template.gates?.handoffAcceptance === true;
	}

	/**
	 * Drop captured work orders older than HANDOFF_ORDER_MAX_AGE_MS. A `task` tool call refused
	 * between capture and execution (foreign `tool_call` block, preflight refusal, approval deny:
	 * wrapper.ts:284-327 throws before `execute`) never emits `tool_result`, so its order would
	 * otherwise linger and disarm the dispatch check; aging it out also keeps a phantom order from
	 * judging a later spawn.
	 */
	private pruneStaleHandoffOrders(): void {
		const cutoff = this.now() - HANDOFF_ORDER_MAX_AGE_MS;
		for (const [key, entry] of Object.entries(this.state.pendingHandoffs)) {
			if (entry.at < cutoff) delete this.state.pendingHandoffs[key];
		}
	}

	/**
	 * Capture the work order of a task tool call for the dispatch check, keyed by toolCallId.
	 * Only while the gate is wired: an unwired gate leaves the session state untouched. The entry
	 * is NOT retired by the task tool's own `tool_result` - omp emits that before
	 * `before_subagent_spawn` (measured 21:11:31.698 vs 21:11:31.705), so retiring it there made
	 * the dispatch consult inert in the real host (F1). It is retired when the spawn it belongs to
	 * is judged (or aged out / cleared with the task); the spawn event carries no toolCallId, so
	 * exact attribution to a call is not possible without host support - see onHandoffDispatch.
	 */
	private captureHandoffWorkOrder(event: Record<string, unknown>): void {
		if (!this.handoffWired()) return;
		const text = taskWorkOrder(event["input"]);
		if (text === undefined) return;
		this.pruneStaleHandoffOrders();
		const toolCallId = typeof event["toolCallId"] === "string" ? event["toolCallId"] : "";
		this.state.pendingHandoffs[toolCallId] = { text, at: this.now(), usedBySpawn: false };
	}

	/**
	 * FR-11 dispatch side (before_subagent_spawn): judge the work order the lead agent is about
	 * to hand to a task agent against the requirement captured at task start, through the
	 * hand-off descriptor (src/gates.ts). Refuses the spawn ONLY on a confident explicit negative
	 * with the offered option set naming that refusal and with the answer arriving before the
	 * frame's deadline. An abstention, a low-confidence answer, a judge error, a frame-escape
	 * answer, a missing requirement, an unattributable work order or an unwired gate let the spawn
	 * through and are recorded - the owner measured that a gate which blocks on an abstention
	 * becomes a permanent block.
	 */
	async onHandoffDispatch(event: unknown, _ctx?: unknown): Promise<SpawnRouteResult | undefined> {
		if (!this.handoffWired() || !isRecord(event)) return undefined;
		// eval spawns (agent() calls) carry no captured work order: nothing judgeable here.
		if (event["invocationKind"] !== "task") return undefined;
		this.pruneStaleHandoffOrders();
		// Only orders no spawn has consumed are attributable: a consumed entry is a sibling spawn's
		// order, not something "in flight", so it must not turn a single live order into "several".
		const all = Object.entries(this.state.pendingHandoffs);
		const available = all.filter(([, entry]) => !entry.usedBySpawn);
		const id = available.length === 1 ? available[0]![0] : undefined;
		const order = id !== undefined ? available[0]![1] : undefined;
		if (id === undefined || order === undefined) {
			const gap =
				all.length === 0
					? "no work order captured from the task tool call"
					: available.length === 0
						? "the captured work order was already used by a sibling spawn of the same task call"
						: "several task calls are in flight and the spawn event carries no toolCallId to " +
							"attribute one work order to this spawn";
			this.recordHandoffUncertainty("dispatch", gap);
			return undefined;
		}
		// Consume before judging: one captured order per spawn, never reused for a sibling.
		order.usedBySpawn = true;
		const requirement = this.state.taskPrompt;
		if (requirement === undefined) {
			this.recordHandoffUncertainty("dispatch", "no user requirement captured for this task yet");
			return undefined;
		}
		const gate = mechanism.decisionGate("subagent_handoff");
		const evidence: Evidence[] = [
			mechanism.gateEvidence("user", "session task prompt (the requirement)", requirement),
			mechanism.gateEvidence("spec", "task tool call input (the work order)", order.text),
		];
		const subject = mechanism.gateSubject("Work order handed over by the lead agent (verbatim)", order.text);
		// A late answer must never block: the host already dropped this handler's result at its own
		// ceiling and proceeded with the spawn (see the descriptor's frame deadline).
		const consult = await mechanism.consultGate(gate, {
			frame: "dispatch",
			subject,
			evidence,
			options: this.template.stages?.["subagent_handoff"]?.options,
			judge: this.judge,
			minConfidence: this.minConfidence,
			deadlineMs: this.handoffDispatchDeadlineMs,
		});
		if (consult.deadlineLost) {
			delete this.state.pendingHandoffs[id];
			this.recordHandoffUncertainty(
				"dispatch",
				`the judge did not answer before the dispatch deadline (${this.handoffDispatchDeadlineMs}ms, ` +
					"under the host's handler timeout)",
			);
			return undefined;
		}
		const record: HandoffRecord = {
			phase: "dispatch",
			judged: consult.judged,
			verdict: consult.verdict,
			confidence: consult.confidence,
			reasons: consult.reasons,
			blocked: false,
			at: this.now(),
		};
		if (consult.negative) {
			const reason =
				`Jev handoff check refused the dispatch: ${record.reasons.join(" ")} ` +
				`(judge revise at confidence ${record.confidence}). ` +
				"Rewrite the work order so it covers the quoted requirement, then dispatch again - " +
				"or escalate to the user.";
			// A refused spawn produces no delegated result: the order has nothing left to do.
			delete this.state.pendingHandoffs[id];
			this.blockHandoff(record, reason);
			return { block: true, reason };
		}
		// The order has served its purpose unless the acceptance side will need it to quote the
		// work order alongside the delivered result.
		if (!this.acceptanceWired()) delete this.state.pendingHandoffs[id];
		this.state.lastHandoff = record;
		this.pushFeedback(`Jev handoff (${mechanism.gateLine(record.phase, record)}). The delegation proceeds.`);
		this.persist();
		return undefined;
	}

	/**
	 * F2: the `task` tool's own result is NOT the delegated result - omp returns a spawn
	 * acknowledgement ("Spawned agent ...; results auto-deliver") and the report arrives later as
	 * the host's `async-result` delivery. This handler therefore never judges that result; while
	 * the acceptance side is armed it records the honest uncertainty ("the spawn acknowledgement,
	 * not the delegated result") and leaves the captured order for the spawn and the delivery. It
	 * also never retires the captured order here: omp emits this result BEFORE
	 * `before_subagent_spawn`, so retiring it here made the dispatch consult inert (F1).
	 */
	onTaskResult(event: unknown, _ctx?: unknown): undefined {
		if (!isRecord(event)) return undefined;
		// Activities framework (development): the automatic course check is served by this same
		// result event, on the matching successful result of an allowed mutating call.
		this.onMutatingResult(event);
		if (!this.acceptanceWired() || event["toolName"] !== "task") return undefined;
		this.recordHandoffUncertainty(
			"acceptance",
			"the task tool result is the spawn acknowledgement, not the delegated result; the " +
				"delegated result is judged when the host delivers it",
		);
		return undefined;
	}

	/**
	 * Automatic course check (development): the matching `tool_result` of an allowed mutating
	 * call consumes the entry captured at `tool_call` and schedules the consult with what the
	 * mutation actually produced. A result that is not this call's own (unmatched id), or that
	 * reports an error, runs no check and leaves no state behind; an errored call produced no work
	 * to check against. The result text is read from the event's own text blocks only - never
	 * `details`, never a JSON dump of the whole event - and `gateEvidence` caps it; a call whose
	 * result carries no text is recorded as uncertainty, never as progress.
	 */
	private onMutatingResult(event: Record<string, unknown>): void {
		const toolCallId = typeof event["toolCallId"] === "string" ? event["toolCallId"] : "";
		const pending = this.state.pendingMutations[toolCallId];
		if (pending === undefined) return;
		delete this.state.pendingMutations[toolCallId];
		if (event["isError"] === true) return;
		this.scheduleAutomaticCourseCheck(pending.revision, pending.toolName, messageText(event));
	}

	/**
	 * FR-11 acceptance side, on the delivered result: omp injects a settled background job's result
	 * as a custom `async-result` message (session/async-job-delivery.ts), which is what this handler
	 * judges - before the lead agent builds on it. `message_end` is notification-only, so a
	 * confident negative is recorded as an unresolved blocker and pushed back into the same session,
	 * never a refusal. The consult is not awaited: measured judge latency reaches 33s against a
	 * resetting endpoint, and the delivery must reach the model without that delay.
	 */
	onDeliveredResult(event: unknown, _ctx?: unknown): undefined {
		if (!this.acceptanceWired() || !isRecord(event)) return undefined;
		const message = event["message"];
		if (!isRecord(message)) return undefined;
		if (message["role"] !== "custom" || message["customType"] !== ASYNC_RESULT_MESSAGE_TYPE) return undefined;
		const reported = messageText(message);
		if (reported.length === 0) {
			this.recordHandoffUncertainty("acceptance", "the delivered background result carried no text to judge");
			return undefined;
		}
		const requirement = this.state.taskPrompt;
		if (requirement === undefined) {
			this.recordHandoffUncertainty("acceptance", "no user requirement captured for this task yet");
			return undefined;
		}
		this.handoffAcceptance = this.runHandoffAcceptance(requirement, this.takeAwaitingOrder(), reported).catch(() => {});
		return undefined;
	}

	/**
	 * The work order of the spawn whose result is being delivered: the single captured order a
	 * spawn has consumed and no delivery has claimed yet. It is consumed here (the delivery is the
	 * order's last reader). With several in flight the delivery cannot be attributed - the host's
	 * delivery names the job, not the spawn key - so `undefined` judges the result against the
	 * requirement alone, and an unconsumed order ages out as before.
	 */
	private takeAwaitingOrder(): string | undefined {
		this.pruneStaleHandoffOrders();
		const awaiting = Object.entries(this.state.pendingHandoffs).filter(([, entry]) => entry.usedBySpawn);
		if (awaiting.length !== 1) return undefined;
		const [key, entry] = awaiting[0]!;
		delete this.state.pendingHandoffs[key];
		return entry.text;
	}

	/** Await the in-flight acceptance consult (test seam; neither event path blocks on it). */
	async handoffAcceptanceSettled(): Promise<void> {
		await this.handoffAcceptance?.catch(() => {});
	}

	private async runHandoffAcceptance(requirement: string, workOrder: string | undefined, reported: string): Promise<void> {
		const gate = mechanism.decisionGate("subagent_handoff");
		const evidence: Evidence[] = [mechanism.gateEvidence("user", "session task prompt (the requirement)", requirement)];
		if (workOrder !== undefined) {
			evidence.push(mechanism.gateEvidence("spec", "task tool call input (the work order)", workOrder));
		}
		// The delegated agent's own report is self-report, not artifact evidence (FR-16): the source
		// says so, and a report-only acceptance claim is exactly what the judge may abstain on.
		evidence.push(
			mechanism.gateEvidence(
				"log",
				"delivered background result (the delegated agent's own report, not artifact-verified)",
				reported,
			),
		);
		const subject =
			(workOrder !== undefined
				? `${mechanism.gateSubject("Work order the agent was given (verbatim)", workOrder)}\n\n`
				: "") +
			mechanism.gateSubject("Result reported by the task agent (verbatim)", reported);
		const consult = await mechanism.consultGate(gate, {
			frame: "acceptance",
			subject,
			evidence,
			options: this.template.stages?.["subagent_handoff"]?.options,
			judge: this.judge,
			minConfidence: this.minConfidence,
		});
		const record: HandoffRecord = {
			phase: "acceptance",
			judged: consult.judged,
			verdict: consult.verdict,
			confidence: consult.confidence,
			reasons: consult.reasons,
			blocked: false,
			at: this.now(),
		};
		if (consult.negative) {
			this.blockHandoff(
				record,
				`Jev handoff check did not accept the delegated result: ${record.reasons.join(" ")} ` +
					`(judge revise at confidence ${record.confidence}). ` +
					"Rework it or re-dispatch before building on it.",
			);
			return;
		}
		this.state.lastHandoff = record;
		this.pushFeedback(`Jev handoff (${mechanism.gateLine(record.phase, record)}).`);
		this.persist();
	}

	/** Unjudged handoff outcome: recorded in state and surfaced, never a block (owner constraint). */
	private recordHandoffUncertainty(phase: HandoffRecord["phase"], note: string): void {
		this.state.lastHandoff = { phase, judged: false, reasons: [note], blocked: false, at: this.now() };
		this.persist();
		this.pushFeedback(`Jev handoff (${phase}) not judged: ${note}. The work proceeds.`);
	}

	/** Confident negative: recorded as an explicit unresolved blocker (same shape as the gate blockers). */
	private blockHandoff(record: HandoffRecord, reason: string): void {
		this.state.lastHandoff = { ...record, blocked: true };
		if (!this.state.blockers.includes(reason)) this.state.blockers.push(reason);
		this.persist();
		this.pushFeedback(reason);
	}

	// ----- POLICY-DRAFT I: destructive-action gate -----

	/**
	 * Destructive-action gate (POLICY-DRAFT class I, always_judge 0.88). One descriptor, one option
	 * set, one refusal rule, two triggers:
	 *  - a bash command matching an owner pattern (`gates.destructive.patterns`);
	 *  - a `write`/`edit`/`ast_edit` call whose target is a plain path outside the project root
	 *    (`gates.destructive.outsideProjectWrites`, off by default) - the class the live session
	 *    performed under a tool name no pattern list can reach.
	 * Either call is judged before it runs, with the call's own text and the session task as evidence.
	 * The call is refused ONLY on a judged explicit negative at or above the confidence floor - the same
	 * condition as the FR-11 handoff gate - so an abstention, a judge error, a low confidence, a frame
	 * escape, a deadline loss or a disarmed trigger lets it run and records the uncertainty (the owner
	 * measured that blocking on an abstention becomes a permanent block).
	 */
	async onDestructiveCall(event: unknown, _ctx?: unknown): Promise<{ block?: boolean; reason?: string } | undefined> {
		if (!isRecord(event)) return undefined;
		// An invalid config is already blocked fail-closed by the mutation gate; never judge on it.
		if (this.templateError !== undefined) return undefined;
		const toolName = event["toolName"];
		if (typeof toolName !== "string") return undefined;
		const destructive = this.template.gates?.destructive;
		const input = event["input"];
		if (toolName === "bash") {
			// Absent or empty list means the command trigger does not exist (default off).
			const patterns = destructive?.patterns ?? [];
			if (patterns.length === 0) return undefined;
			const command = isRecord(input) && nonEmptyString(input["command"]) ? input["command"] : undefined;
			if (command === undefined) return undefined;
			const matched = destructivePatternMatch(command, patterns);
			if (matched === undefined) return undefined;
			return this.consultDestructive("command", matched, command);
		}
		// The second trigger: a file write or edit that lands outside the project the task works in.
		// Disarmed by default, and independent of the pattern list (`outsideProjectWrites`).
		if (destructive?.outsideProjectWrites !== true) return undefined;
		if (OUTSIDE_ROOT_WRITE_TOOLS[toolName] !== true) return undefined;
		const root = this.projectRoot ?? process.cwd();
		const targets = outsideRootWriteTargets(toolName, input, root);
		if (targets.length === 0) return undefined;
		const content = writePayloadText(input);
		return this.consultDestructive(
			"outsideProjectWrite",
			targets.join(", "),
			content ?? targets.join("\n"),
			{ toolName, targets, root, content },
		);
	}

	/**
	 * One destructive-action consult for either trigger: the frame, the evidence, the deadline race,
	 * then the one refusal rule. The subject names the concrete fact - the command, or the tool and
	 * the outside-root target(s) - so the judge quotes what it judged.
	 */
	private async consultDestructive(
		trigger: DestructiveTrigger,
		subjectText: string,
		judgedText: string,
		write?: OutsideRootWriteFacts,
	): Promise<{ block?: boolean; reason?: string } | undefined> {
		const gate = mechanism.decisionGate("destructive_action");
		const evidence: Evidence[] = [];
		let subject: string;
		if (write === undefined) {
			evidence.push(mechanism.gateEvidence("spec", "bash tool call command (about to run)", judgedText));
			subject = mechanism.gateSubject("Command about to run (verbatim)", judgedText);
		} else {
			// The concrete fact, quotable: which tool, which path(s), outside which root.
			subject = mechanism.gateSubject(
				`Outside-root write about to run (tool: ${write.toolName})`,
				`Tool call: ${write.toolName}\nTarget path(s), outside the project root ${write.root}:\n` +
					write.targets.join("\n"),
			);
			evidence.push(
				mechanism.gateEvidence(
					"code",
					`${write.toolName} tool call target path(s), outside the project root ${write.root}`,
					write.targets.join("\n"),
				),
			);
			if (write.content !== undefined) {
				evidence.push(
					mechanism.gateEvidence(
						"code",
						`${write.toolName} tool call content (about to be written)`,
						write.content,
					),
				);
			}
		}
		const task = this.state.taskPrompt;
		if (task !== undefined) evidence.push(mechanism.gateEvidence("user", "session task prompt", task));
		// A late answer must never block: the host's own tool_call timeout is fail-closed, so the
		// frame's deadline must fire first and take the fail-open path.
		const consult = await mechanism.consultGate(gate, {
			frame: trigger === "command" ? "execution" : "outside_root_write",
			subject,
			evidence,
			options: this.template.stages?.[gate.stage]?.options,
			judge: this.judge,
			minConfidence: this.minConfidence,
			deadlineMs: this.destructiveDeadlineMs,
		});
		if (consult.deadlineLost) {
			this.recordDestructiveUncertainty(
				trigger,
				subjectText,
				judgedText,
				`the judge did not answer before the destructive-gate deadline (${this.destructiveDeadlineMs}ms)`,
			);
			return undefined;
		}
		const record: DestructiveRecord = {
			trigger,
			pattern: subjectText,
			command: mechanism.cappedQuote(judgedText).quote,
			judged: consult.judged,
			verdict: consult.verdict,
			confidence: consult.confidence,
			reasons: consult.reasons,
			blocked: false,
			at: this.now(),
		};
		if (consult.negative) {
			const reason =
				write === undefined
					? `Jev destructive-action gate refused this command before execution: ${record.reasons.join(" ")} ` +
						`(judge revise at confidence ${record.confidence}, matched pattern "${subjectText}"). ` +
						"Confirm the destructive action with the user or replace it with a reversible step, then run it again."
					: `Jev destructive-action gate refused this write before execution: ${record.reasons.join(" ")} ` +
						`(judge revise at confidence ${record.confidence}, tool ${write.toolName} targeting a path ` +
						`outside the project root: ${subjectText}). Confirm the out-of-root write with the user, move it ` +
						"inside the project, or replace it with a reversible step, then run it again.";
			this.blockDestructive(record, reason);
			return { block: true, reason };
		}
		this.state.lastDestructive = record;
		this.pushFeedback(
			`Jev destructive-action gate (${mechanism.gateLine(
				trigger === "command" ? `command matched "${subjectText}"` : `write outside the project root: ${subjectText}`,
				record,
			)}). ${trigger === "command" ? "The command" : "The write"} proceeds.`,
		);
		this.persist();
		return undefined;
	}

	/** Unjudged destructive outcome: recorded in state and surfaced, never a block (owner constraint). */
	private recordDestructiveUncertainty(
		trigger: DestructiveTrigger,
		subject: string,
		judgedText: string,
		note: string,
	): void {
		this.state.lastDestructive = {
			trigger,
			pattern: subject,
			command: mechanism.cappedQuote(judgedText).quote,
			judged: false,
			reasons: [note],
			blocked: false,
			at: this.now(),
		};
		this.persist();
		this.pushFeedback(`Jev destructive-action gate not judged: ${note}. The work proceeds.`);
	}

	/** Confident negative: recorded as an explicit unresolved blocker (same shape as the gate blockers). */
	private blockDestructive(record: DestructiveRecord, reason: string): void {
		this.state.lastDestructive = { ...record, blocked: true };
		if (!this.state.blockers.includes(reason)) this.state.blockers.push(reason);
		this.persist();
		this.pushFeedback(reason);
	}

	/** Restore persisted state from session custom entries (session continuity, no cache claims). */
	onSessionStart(entries: ReadonlyArray<{ customType?: unknown; data?: unknown }>): void {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry: { customType?: unknown; data?: unknown } | undefined = entries[i];
			if (entry === undefined) continue;
			if (entry.customType !== STATE_ENTRY_TYPE || !isRecord(entry.data)) continue;
			const data = entry.data;
			// Validate each restored approval; drop malformed records rather than trusting disk.
			const restoredApprovals: ApprovalRecord[] = Array.isArray(data["approvals"])
				? data["approvals"].flatMap((a: unknown): ApprovalRecord[] => {
						if (!isRecord(a)) return [];
						const stage = a["stage"];
						const revisionHash = a["revisionHash"];
						const workRevision = a["workRevision"];
						const approvedAt = a["approvedAt"];
						if (typeof stage !== "string" || !(STAGES.has(stage) || this.extraStageSet().has(stage))) return [];
						if (!nonEmptyString(revisionHash)) return [];
						if (typeof workRevision !== "number" || !Number.isFinite(workRevision)) return [];
						if (typeof approvedAt !== "number" || !Number.isFinite(approvedAt)) return [];
						if (!nonEmptyString(a["selectedOption"])) return [];
						return [
							{
								stage: stage as DecisionStage,
								revisionHash,
								taskFingerprint: typeof a["taskFingerprint"] === "string" ? a["taskFingerprint"] : undefined,
								workRevision,
								selectedOption: a["selectedOption"] as string,
								approvedAt,
							},
						];
					})
				: [];
			// FR-13: a session persisted before this field existed carries no task-start revision;
			// assume the current task starts now rather than making the inventory undeclarable.
			const restoredWorkRevision = typeof data["workRevision"] === "number" ? data["workRevision"] : 0;
			this.state = {
				approvals: restoredApprovals,
				iterations: isRecord(data["iterations"]) ? (data["iterations"] as Record<string, number>) : {},
				workRevision: restoredWorkRevision,
				taskFingerprint: typeof data["taskFingerprint"] === "string" ? data["taskFingerprint"] : undefined,
				blockers: Array.isArray(data["blockers"])
					? data["blockers"].filter((b): b is string => typeof b === "string")
					: [],
				routedModel: typeof data["routedModel"] === "string" ? data["routedModel"] : undefined,
				routedSkill: typeof data["routedSkill"] === "string" ? data["routedSkill"] : undefined,
				taskStartWorkRevision:
					typeof data["taskStartWorkRevision"] === "number" && Number.isFinite(data["taskStartWorkRevision"])
						? data["taskStartWorkRevision"]
						: restoredWorkRevision,
				refactorInventory: restoreRefactorInventory(data["refactorInventory"]),
				lastRefactorMarking: restoreRefactorMarking(data["lastRefactorMarking"]),
				lastCourseCheck: restoreCourseCheck(data["lastCourseCheck"]),
				lastClaimCheck: restoreClaimCheck(data["lastClaimCheck"]),
				lastFormalization: restoreFormalization(data["lastFormalization"]),
				lastPlanMapping: restorePlanMapping(data["lastPlanMapping"]),
				lastAcceptanceCriteria: restoreAcceptanceCriteria(data["lastAcceptanceCriteria"]),
				lastPriorities: restorePriorities(data["lastPriorities"]),
				lastAutoCourseCheck: restoreAutoCourseCheck(data["lastAutoCourseCheck"]),
				openAspectGaps: restoreAspectGaps(data["openAspectGaps"]),
				submissionDigests: restoreDigests(data["submissionDigests"]),
				reworkJournal: restoreReworkJournal(data["reworkJournal"]),
				outstandingRework: restoreOutstandingRework(data["outstandingRework"]),
				taskType: typeof data["taskType"] === "string" ? data["taskType"] : undefined,
				selectedTopics: Array.isArray(data["selectedTopics"])
					? (data["selectedTopics"] as unknown[]).filter((t): t is string => typeof t === "string")
					: undefined,
				consecutiveCompletionApproves: undefined,
				taskPrompt: typeof data["taskPrompt"] === "string" ? data["taskPrompt"] : undefined,
				// Transient by nature: a restart mid-call loses the captured orders, nothing else.
				pendingHandoffs: {},
				pendingMutations: {},
				lastHandoff: restoreHandoffRecord(data["lastHandoff"]),
				lastDestructive: restoreDestructiveRecord(data["lastDestructive"]),
				// Review records are restored only when they validate; a malformed one is dropped, never
				// trusted as a result (a restart must not resurrect a fake review).
				reviews: restoreReviews(data["reviews"]),
			};
			return;
		}
	}

	getState(): JevState {
		return this.state;
	}

	// ----- core decision flow -----

	/** Public pipeline: run the core flow, then attach the one-line fixed-template summary. */
	async submitDecision(raw: unknown): Promise<DecisionOutcome> {
		const outcome = await this.submitDecisionCore(raw);
		// Rework journal (PRD 19 rule 5): a judged attempt carrying an approach is recorded with the
		// approach and the judge's own verdict, and a rejection feeds back what the next attempt must
		// change. Pre-judge refusals (`judged:false`) never spend an approach, so they are never recorded.
		await this.recordReworkAttempt(raw, outcome);
		// The answer obliges (PRD 1.1/FR-10): a confident refusal's named problems are recorded,
		// delivered into this session and shown to the next judgement; an answered approval clears
		// them and nothing else does.
		this.applyOutstandingRework(raw, outcome);
		if (outcome.summary !== "") return outcome;
		const stage = isRecord(raw) && typeof raw["stage"] === "string" ? raw["stage"] : "unknown";
		const options =
			isRecord(raw) && Array.isArray(raw["options"]) ? (raw["options"] as Array<Record<string, unknown>>) : [];
		const meaningOf = (id: string | undefined): string => {
			if (id === undefined) return "";
			const opt = options.find(o => o["id"] === id);
			return opt && typeof opt["meaning"] === "string" ? `: ${opt["meaning"]}` : "";
		};
		const taskText = isRecord(raw) && typeof raw["task"] === "string" ? raw["task"] : "";
		const fp = this.state.taskFingerprint ?? (taskText.length > 0 ? await fingerprint(taskText) : "");
		const used = this.state.iterations[`${fp}:${stage}`] ?? 0;
		// A judged attempt that named an approach says which number of the loop it was (PRD 19), so the
		// executor reads the attempt counter and not only the digest-bound iteration counter.
		const approach = isRecord(raw) && typeof raw["approach"] === "string" ? raw["approach"].trim() : undefined;
		const attempt = approach === undefined || approach.length === 0
			? undefined
			: this.spentApproach(`${fp}:${stage}`, approach);
		const attemptSuffix =
			attempt === undefined
				? ""
				: ` — attempt ${attempt.attempt}/${this.maxReworkIterations} with approach "${approach}"`;
		// A frame escape (the judge rejected the offered option set) must surface the fix the
		// client attached, not only a verdict: the executor has to change the frame, not re-ask.
		const frameFix = outcome.reasons.includes(FRAME_ESCAPE_REASON)
			? outcome.reasons.find(r => r.startsWith(FRAME_FIX_PREFIX))
			: undefined;
		let line: string;
		switch (outcome.verdict) {
			case "approve":
				line = `${stage}: approve — ${outcome.selectedOption ?? ""}${meaningOf(outcome.selectedOption)}`;
				break;
			case "revise":
				line =
					`${stage}: revise — sent back with reasons (iteration ${used}/${this.maxReworkIterations})` +
					attemptSuffix +
					(frameFix !== undefined ? ` — ${frameFix.slice(FRAME_FIX_PREFIX.length)}` : "");
				break;
			case "ask_user":
				line =
					`${stage}: ask_user — escalate to the user` +
					attemptSuffix +
					(frameFix !== undefined ? ` — ${frameFix.slice(FRAME_FIX_PREFIX.length)}` : "");
				break;
			default:
				if (frameFix !== undefined) {
					line =
						`${stage}: insufficient_evidence — the judge rejected the offered option set; ` +
						frameFix.slice(FRAME_FIX_PREFIX.length);
				} else {
					line = outcome.judged
						? `${stage}: insufficient_evidence — judge answered insufficient_evidence (confidence ${outcome.confidence ?? "n/a"}) — improve evidence and re-submit`
						: `${stage}: insufficient_evidence — judge not consulted or answer unusable; fix the request`;
				}
		}
		return { ...outcome, summary: line };
	}

	/**
	 * Full decision pipeline: validate -> coverage -> bound -> judge -> normalize -> record.
	 * Judge throw/unavailability and any malformed answer can never approve (AC4c/d).
	 * Approvals bind to the exact content digest (AC5); a new approve for the same stage/task
	 * with different content supersedes and invalidates the earlier record.
	 */
	private async submitDecisionCore(raw: unknown): Promise<DecisionOutcome> {
		// The completion streak is content-bound; every interruption (error, invalid or
		// rejected submission, revise) breaks it. Helper covers the early failure returns.
		const stopStageRaw = isRecord(raw) && raw["stage"] === this.approvalBoundary().stopStage;
		const interrupted = (): void => {
			if (stopStageRaw && this.state.consecutiveCompletionApproves !== undefined) {
				this.state.consecutiveCompletionApproves = undefined;
				this.persist();
			}
		};
		if (this.templateError !== undefined) {
			interrupted();
			return {
				verdict: "insufficient_evidence",
				reasons: [`jev config invalid (fail-closed, defaults NOT applied): ${this.templateError}`],
				judged: false,
				summary: "config error: jev refuses to decide; fix the config file",
			};
		}
		const check = validateDecisionInput(raw, this.extraStageSet());
		if (!check.ok || check.input === undefined) {
			interrupted();
			return { verdict: "insufficient_evidence", reasons: check.reasons, judged: false, summary: "" };
		}
		const input = check.input;
		const taskFp = this.state.taskFingerprint ?? (await fingerprint(input.task));
		const boundKey = `${taskFp}:${input.stage}`;

		// Rework loop (PRD 19, TASKS "Rules of the loop"): a submission that names an approach is an
		// attempt of the bounded loop, and the loop runs BEFORE everything else - including every
		// preset's own judge - because the rule is about the attempt, not about its content.
		//  1. An approach already spent on this task+stage is not a new attempt at all: it is refused
		//     here, before any judge call and before the counters move, naming what was already tried
		//     and naming the difference - the approach must change, the wording is irrelevant.
		//  2. The bound counts ATTEMPTS: once N attempts (each with its own approach) have been judged,
		//     the stage is an OPEN item with the journal recorded, so the next approach escalates
		//     instead of being judged - the wording is never bent until the judge agrees.
		const spent = input.approach === undefined ? undefined : this.spentApproach(boundKey, input.approach);
		if (input.approach !== undefined) {
			// The bound counts REJECTED attempts only: an approved attempt closed its loop, so it
			// neither spends the bound nor refuses a later consultation of the same stage.
			const rejected = this.rejectedAttempts(boundKey);
			if (spent !== undefined) {
				interrupted();
				const already = rejected.map(a => `"${a.approach}"`).join(", ");
				const problem =
					`approach_already_spent: the approach "${input.approach}" was already rejected on attempt ` +
					`${spent.attempt} of ${input.stage} for this task and stays spent; every rejected attempt of ` +
					`the loop must change the approach, and a repeated approach is not a new attempt. Approaches ` +
					`already rejected: ${already}. ` +
					"Change the approach - tighten the trigger, split the item into narrower separately checkable " +
					"items, or restate it as an outcome plus the evidence that settles it - not the wording.";
				return {
					verdict: "insufficient_evidence",
					reasons: [problem],
					judged: false,
					summary:
						`${input.stage}: insufficient_evidence — refused before judging (no judge call, no rework ` +
						`consumed): ${problem}`,
				};
			}
			if (rejected.length >= this.maxReworkIterations) {
				interrupted();
				const blocker =
					`Jev rework bound exhausted for stage ${input.stage}: ${rejected.length} attempt(s), each ` +
					`with a different approach, all rejected — ${this.reworkJournalLine(rejected)}. ` +
					"Recorded as an OPEN item: the approaches are spent, their state is written down, and the loop " +
					"does NOT continue by re-wording a spent approach or bending the wording until the judge " +
					"agrees. Escalate to the user.";
				const journal = this.state.reworkJournal[boundKey];
				if (journal !== undefined) journal.open = true;
				if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
				this.persist();
				this.pushFeedback(blocker);
				return { verdict: "ask_user", reasons: [blocker], judged: false, summary: "" };
			}
		}

		// P3 evidence pre-check: catch would-be-wasted consultations before burning the
		// rework counter. >=2 problems (or missing requirement evidence on plan stages)
		// reject immediately; a single quality problem judges with a warnings annotation.
		const planStage = lookupControlPoint(input.stage, this.extraPoints)?.trigger === "mutation_gate";
		const problems: string[] = [];
		const warnings: string[] = [];
		const seenQuotes = new Map<string, number>();
		input.evidence.forEach((e, i) => {
			const first = seenQuotes.get(e.quote);
			if (first !== undefined) {
				problems.push(`duplicate_evidence_quote#${i}`);
				warnings.push(`duplicate_evidence_quote#${i}`);
				return;
			}
			seenQuotes.set(e.quote, i);
			if (e.quote.length < 20) {
				problems.push(`quote_too_short:${e.source}#${i}`);
				warnings.push(`quote_too_short:${e.source}#${i}`);
			}
		});
		if (planStage && !input.evidence.some(e => e.kind === "user" || e.kind === "spec")) {
			problems.push("no_requirement_evidence");
		}
		// Grounding (plan stages): at least one evidence quote of >= GROUNDING_MIN_QUOTE_CHARS
		// characters must appear verbatim inside the proposal. This is what forces the claim
		// shape; an ungrounded plan question is answered insufficient_evidence at 0.14-0.26,
		// which reads as judge failure but is a submission defect - so it is refused here, with
		// the fix named, before any judge call and before the rework counter moves.
		if (planStage && !input.evidence.some(e => {
			const quote = e.quote.trim();
			return quote.length >= GROUNDING_MIN_QUOTE_CHARS && input.proposal.includes(quote);
		})) {
			problems.push(`${GROUNDING_PROBLEM}: ${GROUNDING_FIX}`);
		}
		const blockingProblem = problems.some(
			p => p === "no_requirement_evidence" || p.startsWith(GROUNDING_PROBLEM),
		);
		if (blockingProblem || problems.length >= 2) {
			interrupted();
			// The fix travels with the refusal: the executor reads the summary line first.
			return {
				verdict: "insufficient_evidence",
				reasons: problems,
				judged: false,
				summary:
					`${input.stage}: insufficient_evidence — refused before judging (no judge call, ` +
					`no rework consumed): ${problems.join("; ")}`,
			};
		}

		const point = lookupControlPoint(input.stage, this.extraPoints);
		if (point?.requiresArtifactEvidence === true) {
			if (!input.evidence.some(e => COMPLETION_EVIDENCE_KINDS.has(e.kind))) {
				interrupted();
				return {
					verdict: "insufficient_evidence",
					reasons: [
						"completion_review requires at least one execution, code or log evidence item; " +
							"a textual report alone is insufficient",
					],
					judged: false,
					summary: "",
				};
			}
			// Capability coverage is judged, never keyword-matched: requireAll three-way
			// marking over the UNION of configured and submitted inventory (a caller cannot
			// narrow the template by omitting capabilities). Denial happens before any
			// consultation of the stage judge and consumes no rework.
			const effectiveCaps = [...new Set([...(this.template.capabilities ?? []), ...input.capabilities])];
			if (effectiveCaps.length > 0) {
				const denial = await this.checkCapabilityCoverage(input, effectiveCaps);
				if (denial !== undefined) {
					interrupted();
					return denial;
				}
			}
		}

		// `taskFp`/`boundKey` are computed before the rework-loop checks: the approach journal uses the
		// same key as the digest budget, so one submission can never be two attempts.
		// A changed submission is new work, not rework: it gets a fresh budget. Only an
		// identical resubmission keeps consuming the bound; naming a new approach counts as a change
		// too (the approach is part of the bound digest), while the approval digest stays untouched.
		const boundDigest = await revisionHash(input.stage, input.task, input.proposal, input.evidence, input.approach);
		if (this.state.submissionDigests[boundKey] !== boundDigest) {
			this.state.submissionDigests[boundKey] = boundDigest;
			this.state.iterations[boundKey] = 0;
			this.persist();
		}
		const used = this.state.iterations[boundKey] ?? 0;
		if (used >= this.maxReworkIterations) {
			interrupted();
			const blocker =
				`Jev rework bound exhausted for stage ${input.stage} (${used} consultations of the SAME submission). ` +
				"Change the submission or escalate to the user; an identical resubmission is refused and completion is not claimed.";
			if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
			this.persist();
			this.pushFeedback(blocker);
			return { verdict: "ask_user", reasons: [blocker], judged: false, summary: "" };
		}

		// R3: template options replace the executor's fixed option set for this stage.
		const templateStage = this.template.stages?.[input.stage] ?? this.extraStageTemplate(input.stage);
		const judgeOptions = templateStage?.options ?? input.options;
		if (point?.fixedOptionIds !== undefined && templateStage?.options === undefined) {
			const ids = new Set(judgeOptions.map(o => o.id));
			const mismatch = [...point.fixedOptionIds].filter(id => !ids.has(id));
			if (mismatch.length > 0 || ids.size !== judgeOptions.length) {
				interrupted();
				return {
					verdict: "insufficient_evidence",
					reasons: [
						"this control point requires exactly its fixed options " +
							`[...${[...(point.fixedOptionIds ?? [])].join(", ")}] (template override may replace them)`,
					],
					judged: false,
					summary: "",
				};
			}
		}
		// R2: built-in evidence policy first, template instructions appended after (cap 4000).
		let judgeProposal =
			`${input.proposal}\n\nJev evidence policy: evidence items must quote real artifacts ` +
			"(user/spec/code/execution/log/documentation); completion claims require execution/code/log " +
			"evidence; refactor completions must evidence every declared capability.";
		if (templateStage?.instructions !== undefined) {
			judgeProposal += `\n\n${templateStage.instructions.slice(0, 4000)}`;
		}
		// PRD 1.1/FR-10: while this stage carries standing named problems, the judgement is about
		// them - the judge reads the problems and the declared answers verbatim inside the claim, so
		// its approve decides the standing problem and nothing else can clear it. The block is
		// derived from the standing record, never from the submission, so it cannot be omitted by
		// answering nothing (that variant reaches the judge with `<not answered>` visible).
		judgeProposal = this.withOutstandingProblems(boundKey, input, judgeProposal);

		// C1 wired path: course_check preset consults the dedicated per-requirement judge.
		if (input.stage === "course_check" && this.courseCheckJudge !== undefined) {
			const preset = await this.submitCourseCheck(input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}
		if (input.stage === "skill_routing" || input.stage === "model_routing") {
			const routed = await this.submitRouting(input);
			if (routed !== undefined) return this.guardActivityOutcome(input.stage, routed) ?? routed;
		}
		// FR-13 part (1): the old-function inventory, declared before the first code edit. No judge
		// consult: the declaration itself is not a question - what is judged is the marking below.
		if (input.stage === "refactor_inventory") {
			return this.submitRefactorInventory(input);
		}
		// FR-13 parts (2)+(3): every inventory item marked preserved or lost from its own artifact
		// material; an item without such material keeps the completion boundary shut by name.
		if (input.stage === "refactor_marking") {
			const preset = await this.submitRefactorMarking(input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}
		// aspect_coverage preset: catalog pre-check + dedicated three-way judge.
		if (input.stage === "aspect_coverage") {
			const unknown = input.aspects.filter(id => !this.catalogIds.has(id));
			if (input.aspects.length === 0) {
				return {
					verdict: "insufficient_evidence",
					reasons: ["aspect_coverage requires a non-empty aspects list of catalog topic ids"],
					judged: false,
					summary: "",
				};
			}
			if (unknown.length > 0) {
				return {
					verdict: "insufficient_evidence",
					reasons: [`unknown_aspect_id: ${unknown.join(", ")}`],
					judged: false,
					summary: "",
				};
			}
			if (this.aspectCoverageJudge !== undefined) {
				const preset = await this.submitAspectCoverage(input, boundKey, used);
				return this.guardActivityOutcome(input.stage, preset) ?? preset;
			}
			// No judge wired: keep the pre-check result as a typed correction, fail-closed.
			return {
				verdict: "insufficient_evidence",
				reasons: ["aspect_coverage judge not configured in this session"],
				judged: false,
				summary: "",
			};
		}

		// claim_check preset: N claims, one request, one verdict per claim. Advisory like the
		// other on_demand presets - it never records a gate approval.
		if (input.stage === "claim_check") {
			if (input.claims.length < CLAIM_CHECK_MIN_CLAIMS) {
				return {
					verdict: "insufficient_evidence",
					reasons: [
						`claim_check needs at least ${CLAIM_CHECK_MIN_CLAIMS} claims: pass the claim texts in ` +
							"`claims` (each is judged separately against the quoted evidence)",
					],
					judged: false,
					summary: "",
				};
			}
			if (this.claimCheckJudge === undefined) {
				// No wired judge: keep the pre-check result as a typed correction, fail-closed.
				return {
					verdict: "insufficient_evidence",
					reasons: ["claim_check judge not configured in this session"],
					judged: false,
					summary: "",
				};
			}
			const preset = await this.submitClaimCheck(input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}

		// Activities framework: requirements_formalization - the draft numbered list is marked
		// per item against the quoted user/spec sources, with the coverage verdict for what the
		// quotes do not cover. Advisory by construction (on_demand records no gate approval).
		if (input.stage === "requirements_formalization") {
			const preset = await this.submitRequirementsFormalization(input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}

		// Activities framework: planning - the per-requirement plan mapping. For every formalized
		// requirement the submitted claim that the plan serves it is marked by the claim_check
		// path; a requirement without a supported claim leaves planning incomplete.
		if (input.stage === PLAN_MAPPING_STAGE) {
			const preset = await this.submitPlanMapping(input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}

		// FR-20: the acceptance criteria of the accepted requirement list. A criterion naming no
		// accepted requirement is refused before the judge call; the judge marks every criterion.
		if (input.stage === "acceptance_criteria") {
			const preset = await this.submitAcceptanceCriteria(input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}

		// FR-21: the judge sets the order over the accepted requirement list; the controller
		// derives and records it. A new accepted batch retires the recorded order (stale + named).
		if (input.stage === "requirement_priorities") {
			const preset = await this.submitPriorities(input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}

		// Review activities (business_review, architecture_review, security_review): the controller
		// runs the review's fixed question set itself and records the per-item results. Advisory by
		// construction - a review records no gate approval, pushes no blocker and refuses nothing.
		const reviewDescriptor = mechanism.reviewGateForStage(input.stage);
		if (reviewDescriptor !== undefined) {
			const preset = await this.submitReview(reviewDescriptor, input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}

		let rawResult: DecisionResult;
		try {
			rawResult = await this.judge({
				stage: input.stage,
				task: input.task,
				proposal: judgeProposal,
				options: judgeOptions,
				evidence: input.evidence,
			});
		} catch (err) {
			// A failed consultation is real rework for course_check: it consumes the
			// bounded budget so a broken judge cannot loop forever. Other stages keep
			// their existing no-burn failure semantics.
			if (point?.verdictMapping === "course_check") {
				this.state.iterations[boundKey] = used + 1;
				this.persist();
			}
			interrupted();
			return {
				verdict: "insufficient_evidence",
				reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`],
				judged: false,
				summary: "",
			};
		}

		// Calibration-tolerant completion: normalize with the lowered bar so mid-band
		// approves survive; the counting block below enforces floor/count/teeth.
		const stopStage = input.stage === this.approvalBoundary().stopStage;
		// F1 policy interaction: the streak path applies ONLY at the POLICY default bar;
		// a raised threshold keeps a single strict bar (no streak credit).
		const streakEligible = this.minConfidence === POLICY.minConfidenceToApprove;
		const normalizeBar = stopStage && streakEligible
			? Math.min(this.minConfidence, this.completionConfidenceFloor)
			: this.minConfidence;
		const normalized = normalizeJudgeResult(rawResult, judgeOptions, normalizeBar);
		// Typed mid-band candidate (shared client contract): the client demoted a raw
		// approve at completion_review into insufficient_evidence + completionCandidate.
		// The controller counts it ONLY here (completion stage, default bar), validating
		// the offered option, finite confidence at/above the effective floor - never from
		// reason strings.
		const candidate =
			stopStage && streakEligible && normalized.verdict === "insufficient_evidence"
				? this.typedCompletionCandidate(rawResult, judgeOptions)
				: undefined;
		// course_check advisory-to-binding mapping (record, never approve anything).
		let result = normalized;
		let benignCourseCheck = false;
		if (
			point?.verdictMapping === "course_check" &&
			normalized.verdict === "approve" &&
			normalized.selectedOption !== undefined
		) {
			const picked = normalized.selectedOption;
			if (COURSE_CHECK_REDIRECTING.has(picked)) {
				result = {
					verdict: "revise",
					reasons: [...normalized.reasons, `course_check redirects: ${picked}`],
					confidence: normalized.confidence,
				};
			} else if (picked === "ask_user") {
				result = this.escalateCourseCheck(normalized);
			} else {
				// continue / verify_before_proceeding: record only, approves nothing.
				// The record binds to task+work revision so the completion boundary can
				// demand a FRESH check (verify never unlocks; only continue does).
				// `continue` is the pass the completion boundary consumes, so the standing
				// problems decide before it is written: with any of them unanswered there is
				// no pass at all (the refusal below names them and spends the budget).
				if (picked === "continue") {
					const withheld = this.withheldByOutstanding(boundKey, input);
					if (withheld !== undefined) {
						// The consultation was spent on a submission that did not answer the standing
						// problems: real rework, so it spends the bounded budget like a redirect.
						this.state.iterations[boundKey] = used + 1;
						this.persist();
						return withheld;
					}
				}
				this.state.lastCourseCheck = {
					selectedOption: picked,
					at: this.now(),
					taskFingerprint: this.state.taskFingerprint,
					workRevision: this.state.workRevision,
				};
				benignCourseCheck = true;
			}
		} else if (point?.verdictMapping === "course_check" && normalized.verdict === "ask_user") {
			// Judge itself chose ask_user: escalate with a recorded blocker.
			result = this.escalateCourseCheck(normalized);
		}
		// Bounded rework counts real rework only: a benign continue/verify record is not
		// a retry and consumes nothing; redirects, escalations and failures do.
		if (!benignCourseCheck) this.state.iterations[boundKey] = used + 1;

		// The answer obliges (PRD 1.1/FR-10): while this stage carries standing named problems,
		// an approve whose submission answered none of them is NOT recorded - no gate approval, no
		// pass record, no completion-streak credit; the outcome is the refusal naming every problem.
		// A benign course_check record is the exception the boundary itself handles: `continue` was
		// already withheld above (it is what unlocks completion), while `verify_before_proceeding`
		// unlocks nothing and is recorded as before with the problems left standing.
		if (result.verdict === "approve" && !benignCourseCheck) {
			const withheld = this.withheldByOutstanding(boundKey, input);
			if (withheld !== undefined) {
				interrupted();
				return withheld;
			}
		}

		// Lazy memo shared by the streak update and the approval record below: at most one
		// content digest per submission.
		let digestMemo: Promise<string> | undefined;
		const contentDigest = (): Promise<string> =>
			(digestMemo ??= revisionHash(input.stage, input.task, input.proposal, input.evidence));
		// Advisory points (course_check benign pair, config-declared on_demand) never
		// record gate approvals; their outcomes live in state records/feedback only.
		// Calibration-tolerant completion rule: 0.6<=conf<minConfidence counts toward
		// consecutive approves (count/floor clamp raise-only); reset on non-approve, work
		// bump or task change; below-floor never counts.
		if (
			stopStage &&
			result.verdict === "approve" &&
			result.confidence !== undefined &&
			result.confidence < this.completionConfidenceFloor
		) {
			this.state.consecutiveCompletionApproves = undefined;
			this.persist();
			return {
				verdict: "insufficient_evidence",
				reasons: [`conf=${result.confidence} below calibration floor ${this.completionConfidenceFloor}`],
				confidence: result.confidence,
				judged: true,
				summary: "",
			};
		}
		// Completion streak: mid-band raw approves AND typed candidates count; the streak
		// binds to the exact decision content digest as well as task+work revision, so any
		// content change restarts it.
		const midBandApprove =
			stopStage &&
			streakEligible &&
			result.verdict === "approve" &&
			result.confidence !== undefined &&
			result.confidence < this.minConfidence;
		if (stopStage && streakEligible && (midBandApprove || candidate !== undefined)) {
			const digest = await contentDigest();
			const confidence = midBandApprove ? result.confidence! : candidate!.confidence;
			let streak = this.state.consecutiveCompletionApproves;
			if (
				streak === undefined ||
				streak.taskFingerprint !== this.state.taskFingerprint ||
				streak.workRevision !== this.state.workRevision ||
				streak.revisionHash !== digest
			) {
				streak = {
					count: 0,
					confidences: [],
					taskFingerprint: this.state.taskFingerprint,
					workRevision: this.state.workRevision,
					revisionHash: digest,
				};
			}
			streak.count += 1;
			streak.confidences.push(confidence);
			this.state.consecutiveCompletionApproves = streak;
			if (streak.count < this.completionConsecutiveApproves) {
				this.persist();
				return {
					verdict: "insufficient_evidence",
					reasons: [
						"completion_pending_consecutive_approves",
						`n=${streak.count}/${this.completionConsecutiveApproves}`,
						`conf=${confidence}`,
					],
					confidence,
					judged: true,
					summary: "",
				};
			}
			const streakReasons = [
				"consecutive_approves",
				`n=${streak.count}`,
				`conf=${streak.confidences.join(", ")}`,
			];
			result = midBandApprove
				? { ...result, reasons: [...streakReasons, ...result.reasons] }
				: {
						// A completed candidate streak IS the calibration-tolerant approval: the
						// typed candidate option becomes the recorded selectedOption.
						verdict: "approve",
						selectedOption: candidate!.selectedOption,
						reasons: [...streakReasons, ...normalized.reasons],
						confidence,
					};
		} else if (stopStage && result.verdict !== "approve") {
			this.state.consecutiveCompletionApproves = undefined;
		}

		// Activities framework: an engine answer the owning activity cannot express in its
		// declared outcome set fails closed HERE, before any approval is recorded.
		const activityViolation = this.guardActivityOutcome(input.stage, { ...result, judged: true, summary: "" });
		if (activityViolation !== undefined) {
			interrupted();
			return activityViolation;
		}

		const skipApproval =
			point?.trigger === "on_demand" &&
			!(point.verdictMapping === "course_check" &&
				(result.selectedOption === "ask_user" || COURSE_CHECK_REDIRECTING.has(result.selectedOption ?? "")));
		if (result.verdict === "approve" && result.selectedOption !== undefined && !skipApproval) {
			const digest = await contentDigest();
			// AC5 replay/supersede: an older approval of the same stage for this task with a
			// different content digest is no longer authoritative.
			this.state.approvals = this.state.approvals.filter(
				a => !(a.stage === input.stage && a.taskFingerprint === this.state.taskFingerprint && a.revisionHash !== digest),
			);
			this.state.approvals.push({
				stage: input.stage,
				revisionHash: digest,
				// Bind to the established user-task fingerprint; when none is established the
				// strict gate comparisons below treat the approval as stale (fail-safe, AC5).
				taskFingerprint: this.state.taskFingerprint,
				workRevision: this.state.workRevision,
				selectedOption: result.selectedOption,
				approvedAt: this.now(),
			});
		}
		if (result.verdict === "revise") {
			this.pushFeedback(`Jev judge asked for revision: ${result.reasons.join(" ")}`);
		}
		this.persist();
		if (warnings.length > 0) {
			return { ...result, judged: true, warnings, summary: "" };
		}
		return { ...result, judged: true, summary: "" };
	}

	/**
	 * requireAll capability coverage at the completion boundary, judged by the same
	 * aspect coverage judge the aspect_coverage preset uses (no keyword matching).
	 * Returns a denial outcome, or undefined when every declared capability is
	 * applicable_and_addressed (the judge downgrades not_applicable under requireAll;
	 * any other marking denies a declared capability).
	 */
	private async checkCapabilityCoverage(
		input: ValidatedDecisionInput,
		capabilities: string[],
	): Promise<DecisionOutcome | undefined> {
		if (this.aspectCoverageJudge === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"completion capability coverage requires a wired coverage judge; " +
						"refusing to approve unverifiable capabilities (fail-closed)",
				],
				judged: false,
				summary: "",
			};
		}
		let raw: AspectCoverageResult;
		try {
			raw = await this.aspectCoverageJudge({
				aspects: capabilities.map(id => ({ id, text: id })),
				currentAction: input.proposal,
				evidence: input.evidence,
				requireAll: true,
			});
		} catch (err) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`coverage judge unavailable: ${err instanceof Error ? err.message : String(err)}`],
				judged: false,
				summary: "",
			};
		}
		if (!isRecord(raw) || raw["judged"] !== true || raw["escape"] === true || !isRecord(raw["markings"])) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["coverage judge returned an unjudged, escaped or malformed result; completion denied"],
				judged: false,
				summary: "",
			};
		}
		const markings = raw["markings"] as Record<string, string>;
		const unmarked = capabilities.filter(id => !(id in markings));
		if (unmarked.length > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`coverage judge did not mark: ${unmarked.join(", ")}`],
				judged: false,
				summary: "",
			};
		}
		const denied = capabilities.filter(id => markings[id] !== "applicable_and_addressed");
		if (denied.length > 0) {
			return {
				verdict: "revise",
				reasons: [
					`refactor requirement coverage incomplete: capability id(s) not addressed per coverage judge ` +
						`(requireAll): ${denied.join(", ")}`,
				],
				judged: true,
				summary: "",
			};
		}
		return undefined;
	}

	/**
	 * Typed mid-band completion candidate from the shared client contract (strict
	 * insufficient_evidence verdict + completionCandidate). Only the typed field counts;
	 * invalid shapes -> undefined (never a mapping, never inferred from reasons).
	 */
	private typedCompletionCandidate(
		rawResult: unknown,
		options: DecisionOption[],
	): { selectedOption: string; confidence: number } | undefined {
		if (!isRecord(rawResult) || !isRecord(rawResult["completionCandidate"])) return undefined;
		const selected = rawResult["completionCandidate"]["selectedOption"];
		if (typeof selected !== "string" || !options.some(o => o.id === selected)) return undefined;
		const confidence = rawResult["confidence"];
		if (
			typeof confidence !== "number" ||
			!Number.isFinite(confidence) ||
			confidence < 0 ||
			confidence > 1 ||
			confidence < this.completionConfidenceFloor
		) {
			return undefined;
		}
		return { selectedOption: selected, confidence };
	}

	/**
	 * C1 wired course_check: per-requirement drift (Noul) + next-action Choice in ONE request.
	 * Verdict mapping: continue/verify_before_proceeding -> recorded (no approval, no rework);
	 * return_to_requirement/replan -> revise + feedback; ask_user -> escalation.
	 * Rework bound consumes redirects, escalations and failures ONLY - a benign on-track
	 * record is not a retry. Fail-closed: throw/unjudged/contract-violation/sub-floor
	 * confidence/drift+continue -> insufficient_evidence, no unlock, rework consumed.
	 */
	private async submitCourseCheck(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		// Deterministic dedupe: judge questions are keyed by requirement id, so duplicate
		// ids must never silently collapse a drift check. Same id + same quote merges;
		// same id + different quote gets a #N suffix so every distinct requirement is judged.
		const requirements: Array<{ id: string; quote: string }> = [];
		const seenQuotes = new Map<string, string>();
		input.evidence
			.filter(e => e.kind === "user" || e.kind === "spec")
			.forEach((e, i) => {
				const base = nonEmptyString(e.source) ? e.source : `req-${i}`;
				if (seenQuotes.get(base) === e.quote) return;
				let id = base;
				for (let n = 2; requirements.some(r => r.id === id); n++) id = `${base}#${n}`;
				seenQuotes.set(id, e.quote);
				requirements.push({ id, quote: e.quote });
			});
		if (requirements.length === 0) {
			// Invalid submission, not judge rework: rejected before any consultation.
			return {
				verdict: "insufficient_evidence",
				reasons: ["course_check requires at least one user or spec evidence item as the requirement under check"],
				judged: false,
				summary: "",
			};
		}
		// Every failure below is rework: it consumes the bounded budget (persist included).
		const consume = (): void => {
			this.state.iterations[boundKey] = used + 1;
			this.persist();
		};
		const failClosed = (detail: string): DecisionOutcome => {
			consume();
			return { verdict: "insufficient_evidence", reasons: [detail], judged: false, summary: "" };
		};
		let raw: CourseCheckResult;
		try {
			raw = await this.courseCheckJudge!({
				requirements,
				// PRD 1.1/FR-10: while the stage carries standing named problems, the judge reads
				// them and the declared answers verbatim beside the action being checked.
				currentAction: this.withOutstandingProblems(boundKey, input, input.proposal),
				evidence: input.evidence,
			});
		} catch (err) {
			return failClosed(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!isRecord(raw) || raw["judged"] !== true || typeof raw["nextAction"] !== "string") {
			// Contract violation / judge could not be consulted: never auto-continue.
			return failClosed("course_check judge returned an unjudged or malformed result; no action taken");
		}
		const nextAction = raw["nextAction"] as string;
		if (!(COURSE_CHECK_NEXT_ACTIONS as readonly string[]).includes(nextAction)) {
			return failClosed(`course_check judge returned an unknown next action: ${nextAction}`);
		}
		if (!isRecord(raw["onTrack"])) {
			return failClosed("course_check judge result carries no onTrack record");
		}
		// Exact keys: the judge must answer every presented requirement and nothing else.
		const onTrack = raw["onTrack"] as Record<string, unknown>;
		const expectedKeys = requirements.map(r => r.id).sort();
		const actualKeys = Object.keys(onTrack).sort();
		if (expectedKeys.length !== actualKeys.length || expectedKeys.some((k, i) => k !== actualKeys[i])) {
			return failClosed(
				`course_check onTrack keys must be exactly the requirement ids (${expectedKeys.join(", ")}); ` +
					`got ${actualKeys.join(", ")}`,
			);
		}
		const drifted = Object.entries(onTrack)
			.filter(([, ok]) => ok !== true)
			.map(([id]) => id);
		// False drift must not continue: a drifted requirement can never yield a plain
		// continue record - the judge must redirect or escalate.
		if (drifted.length > 0 && nextAction === "continue") {
			return failClosed(
				`course_check contract violation: drifted requirement(s) ${drifted.join(", ")} cannot yield continue`,
			);
		}
		const reasons = [...(Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : [])];
		if (drifted.length > 0) reasons.push(`not on track: ${drifted.join(", ")}`);
		if (nextAction === "continue" || nextAction === "verify_before_proceeding") {
			// A record that could unlock progress must carry finite confidence at/above the
			// effective floor - an unquantified or sub-floor answer never records.
			const confidence = raw["confidence"];
			if (
				typeof confidence !== "number" ||
				!Number.isFinite(confidence) ||
				confidence < 0 ||
				confidence > 1 ||
				confidence < this.completionConfidenceFloor
			) {
				return failClosed(
					`course_check confidence must be a finite 0..1 number at/above the floor ${this.completionConfidenceFloor}`,
				);
			}
			// Benign record: binds to task+work revision, consumes no rework. Only a judged
			// continue satisfies the completion boundary (verify never unlocks).
			// The answer obliges (PRD 1.1/FR-10): `continue` is the pass that boundary consumes,
			// so it is not written while a standing named problem of this stage is unanswered -
			// the refusal names the problems and spends the budget like a redirect.
			if (nextAction === "continue") {
				const withheld = this.withheldByOutstanding(boundKey, input);
				if (withheld !== undefined) {
					consume();
					return withheld;
				}
			}
			this.state.lastCourseCheck = {
				selectedOption: nextAction,
				at: this.now(),
				taskFingerprint: this.state.taskFingerprint,
				workRevision: this.state.workRevision,
			};
			this.persist();
			return {
				verdict: "approve",
				selectedOption: nextAction,
				reasons,
				confidence,
				judged: true,
				summary: "",
			};
		}
		const driftSuffix = drifted.length > 0 ? ` (drifted: ${drifted.join(", ")})` : "";
		if (nextAction === "return_to_requirement" || nextAction === "replan") {
			consume();
			this.pushFeedback(`Jev course_check redirects: ${nextAction}${driftSuffix}`);
			// The judge's own confidence travels with the redirect: the standing-problem rule
			// (PRD 1.1/FR-10) reads it exactly as it reads the choice verdicts, so a sub-floor or
			// unquantified redirect stays uncertainty and obliges nothing.
			const redirectConfidence = raw["confidence"];
			return {
				verdict: "revise",
				selectedOption: nextAction,
				reasons,
				...(typeof redirectConfidence === "number" &&
				Number.isFinite(redirectConfidence) &&
				redirectConfidence >= 0 &&
				redirectConfidence <= 1
					? { confidence: redirectConfidence }
					: {}),
				judged: true,
				summary: `course_check: revise — ${nextAction}: back to requirement${driftSuffix}`,
			};
		}
		// ask_user
		consume();
		const blocker = "course_check escalated to the user (ask_user chosen by the judge or rework bound).";
		if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
		return {
			verdict: "ask_user",
			selectedOption: nextAction,
			reasons: [...reasons, blocker],
			judged: true,
			summary: "",
		};
	}

	/**
	 * claim_check preset: one request, one Noul per claim, claim ids answered exactly. The
	 * per-claim verdicts land in the summary and in state (bound to task+work revision) and
	 * never record a gate approval. Fail-closed: an unjudged, unmarkable or unknown answer is
	 * insufficient_evidence naming the claim, keeps no marking and consumes the bounded budget,
	 * so a broken consultation cannot loop. Every claim supported consumes nothing (nothing was
	 * sent back); an unsupported claim is a revise with the claims named.
	 */
	private async submitClaimCheck(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		const claims = input.claims.map((text, i) => ({ id: `claim-${i + 1}`, text }));
		const consume = (): void => {
			this.state.iterations[boundKey] = used + 1;
			this.persist();
		};
		const failClosed = (detail: string): DecisionOutcome => {
			consume();
			return {
				verdict: "insufficient_evidence",
				reasons: [`claim_check: ${detail}`, `fix: ${CLAIM_CHECK_FIX}`],
				judged: false,
				summary: "",
			};
		};
		let raw: ClaimCheckResult;
		try {
			raw = await this.claimCheckJudge!({
				stage: "claim_check",
				task: input.task,
				claims,
				evidence: input.evidence,
			});
		} catch (err) {
			return failClosed(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!isRecord(raw) || raw["judged"] !== true || !isRecord(raw["supported"])) {
			return failClosed("judge returned an unjudged or malformed result; no claim marking kept");
		}
		const marked = raw["supported"] as Record<string, unknown>;
		const unmarkable = claims.filter(c => typeof marked[c.id] !== "boolean");
		if (unmarkable.length > 0) {
			return failClosed(
				`the judge could not mark ${unmarkable.map(c => `${c.id} (${claimExcerpt(c.text)})`).join(", ")}; ` +
					"an unmarkable claim is insufficient_evidence, not a verdict",
			);
		}
		const expectedIds = claims.map(c => c.id).sort();
		const actualIds = Object.keys(marked).sort();
		if (expectedIds.length !== actualIds.length || expectedIds.some((id, i) => id !== actualIds[i])) {
			return failClosed(
				`marked claim ids must be exactly the submitted claims (${expectedIds.join(", ")}); ` +
					`got ${actualIds.join(", ")}`,
			);
		}
		const results: ClaimCheckMarking[] = claims.map(c => ({
			id: c.id,
			text: c.text,
			supported: marked[c.id] === true,
		}));
		this.state.lastClaimCheck = {
			claims: results,
			at: this.now(),
			taskFingerprint: this.state.taskFingerprint,
			workRevision: this.state.workRevision,
		};
		const unsupported = results.filter(r => !r.supported);
		if (unsupported.length === 0) {
			this.persist();
			return {
				verdict: "approve",
				reasons: [`claim_check: every claim supported by the quoted evidence (${results.length})`],
				judged: true,
				summary: `claim_check: ${results.length}/${results.length} supported`,
			};
		}
		consume();
		const named = unsupported.map(r => `${r.id} (${claimExcerpt(r.text)})`).join(", ");
		this.pushFeedback(`Jev claim_check: claim(s) not supported by the quoted evidence — ${named}`);
		return {
			verdict: "revise",
			reasons: [`claim_check: not supported by the quoted evidence: ${named}`],
			judged: true,
			summary: `claim_check: ${results.length - unsupported.length}/${results.length} supported — not supported: ${named}`,
		};
	}

	/**
	 * requirements_formalization activity: the draft numbered list is judged per item against
	 * the quoted user/spec sources in ONE request. Each item comes back marked traceable (a
	 * quoted source states or directly entails it) and the coverage verdict names the quoted
	 * source texts no requirement captures. Advisory by construction (on_demand records no gate
	 * approval). Fail-closed: an untraceable item is refused and named, an unjudged or
	 * unmarkable answer keeps no list at all, and only a fully accepted list is stored as
	 * `complete` (the checklist later activities are judged against).
	 */
	private async submitRequirementsFormalization(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		const requirements = input.requirements.map((item, i) => ({
			id: `req-${i + 1}`,
			text: item.text,
			quoteId: item.quoteId,
		}));
		if (requirements.length === 0) {
			// Invalid submission, not judge rework: refused before any consultation.
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"requirements_formalization needs the draft numbered list: pass one {text, quoteId} per " +
						"numbered item in `requirements`",
				],
				judged: false,
				summary: "",
			};
		}
		const quotes = requirementQuotes(input.evidence);
		if (quotes.length === 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"requirements_formalization requires at least one user or spec evidence item: every formalized " +
						"requirement must be traceable to a quoted source",
				],
				judged: false,
				summary: "",
			};
		}
		// FR-19: an item that names no submitted quote has nothing to be traceable to. Refused
		// BEFORE the judge call (the row's violation is an item without a verbatim quote entering
		// development), naming the quote ids that do exist.
		const unknownQuote = [...new Set(requirements.filter(r => !quotes.some(q => q.id === r.quoteId)).map(r => `${r.id}→${r.quoteId}`))];
		if (unknownQuote.length > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					`unknown_quote_id: ${unknownQuote.join(", ")} — every numbered item must name one of the ` +
						`submitted user/spec quotes (${quotes.map(q => q.id).join(", ")}); an item without a ` +
						"verbatim source quote is refused before any judge call",
				],
				judged: false,
				summary: "",
			};
		}
		if (this.requirementsFormalizationJudge === undefined) {
			// No wired judge: keep the pre-check result as a typed correction, fail-closed.
			return {
				verdict: "insufficient_evidence",
				reasons: ["requirements_formalization judge not configured in this session"],
				judged: false,
				summary: "",
			};
		}
		const consume = (): void => {
			this.state.iterations[boundKey] = used + 1;
			this.persist();
		};
		const failClosed = (detail: string): DecisionOutcome => {
			consume();
			return {
				verdict: "insufficient_evidence",
				reasons: [`requirements_formalization: ${detail}`, `fix: ${FORMALIZATION_FIX}`],
				judged: false,
				summary: "",
			};
		};
		let raw: RequirementsFormalizationResult;
		try {
			raw = await this.requirementsFormalizationJudge({
				stage: "requirements_formalization",
				task: input.task,
				requirements,
				quotes: quotes.map(q => ({ id: q.id, text: q.text })),
				evidence: input.evidence,
			});
		} catch (err) {
			return failClosed(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!isRecord(raw) || raw["judged"] !== true || !isRecord(raw["traceable"]) || !isRecord(raw["covered"])) {
			return failClosed("the judge returned an unjudged or malformed result; no requirement list kept");
		}
		const traceable = raw["traceable"] as Record<string, unknown>;
		const covered = raw["covered"] as Record<string, unknown>;
		const unmarkable = [
			...requirements.filter(r => typeof traceable[r.id] !== "boolean").map(r => r.id),
			...quotes.filter(q => typeof covered[q.id] !== "boolean").map(q => q.id),
		];
		if (unmarkable.length > 0) {
			return failClosed(`the judge could not mark ${unmarkable.join(", ")}; an unmarkable item fails closed`);
		}
		const expectedIds = [...requirements.map(r => r.id), ...quotes.map(q => q.id)].sort();
		const actualIds = [...Object.keys(traceable), ...Object.keys(covered)].sort();
		if (expectedIds.length !== actualIds.length || expectedIds.some((id, i) => id !== actualIds[i])) {
			return failClosed(
				`the marked item ids must be exactly the submitted requirements and quotes ` +
					`(${expectedIds.join(", ")}); got ${actualIds.join(", ")}`,
			);
		}
		const list: FormalizedRequirement[] = requirements.map(r => ({
			id: r.id,
			text: r.text,
			quoteId: r.quoteId,
			// FR-19: the item's named quote is stored verbatim beside it, so the accepted list is
			// itself the requirement list with a number and a verbatim quote per item.
			quote: quotes.find(q => q.id === r.quoteId)?.text ?? "",
			traceable: traceable[r.id] === true,
		}));
		const uncovered = quotes
			.filter(q => covered[q.id] !== true)
			.map(q => ({ id: q.id, source: q.source, excerpt: claimExcerpt(q.text) }));
		const untraceable = list.filter(r => !r.traceable);
		const outcome =
			untraceable.length > 0
				? FORMALIZATION_UNTRACEABLE_OPTION
				: uncovered.length > 0
					? FORMALIZATION_COVERAGE_MISSING_OPTION
					: FORMALIZATION_APPROVED_OPTION;
		this.state.lastFormalization = {
			requirements: list,
			uncovered,
			outcome,
			complete: outcome === FORMALIZATION_APPROVED_OPTION,
			// FR-21: the identity of this accepted batch - content, so the SAME accepted list stays
			// the same batch while a new portion is a different one.
			batchDigest: await fingerprint(
				JSON.stringify(list.map(r => [r.id, r.text, r.quoteId, r.quote])),
			),
			at: this.now(),
			taskFingerprint: this.state.taskFingerprint,
			workRevision: this.state.workRevision,
		};
		if (outcome === FORMALIZATION_APPROVED_OPTION) this.retireSupersededOrders();
		if (untraceable.length > 0) {
			consume();
			const named = untraceable.map(r => `${r.id} (${claimExcerpt(r.text)})`).join(", ");
			this.pushFeedback(
				`Jev requirements_formalization: item(s) not traceable to a quoted source — ${named}`,
			);
			return {
				verdict: "revise",
				selectedOption: FORMALIZATION_UNTRACEABLE_OPTION,
				reasons: [
					`requirements_formalization: no quoted source states or entails ${named}`,
					`fix: ${FORMALIZATION_FIX}`,
				],
				judged: true,
				summary: `requirements_formalization: revise — item_untraceable: ${named}`,
			};
		}
		if (uncovered.length > 0) {
			consume();
			const named = uncovered.map(q => `${q.id} (${q.source}: ${q.excerpt})`).join(", ");
			this.pushFeedback(`Jev requirements_formalization: quoted source(s) not covered — ${named}`);
			return {
				verdict: "revise",
				selectedOption: FORMALIZATION_COVERAGE_MISSING_OPTION,
				reasons: [
					`requirements_formalization: coverage missing — no requirement captures ${named}`,
					`fix: ${FORMALIZATION_FIX}`,
				],
				judged: true,
				summary: `requirements_formalization: revise — coverage_missing: ${named}`,
			};
		}
		this.persist();
		return {
			verdict: "approve",
			selectedOption: FORMALIZATION_APPROVED_OPTION,
			reasons: [
				`requirements_formalization: ${list.length} requirement(s) traceable, ${quotes.length} quoted ` +
					"source(s) covered",
			],
			judged: true,
			summary:
				`requirements_formalization: formalized ${list.length} requirement(s) — ` +
				list.map(r => `${r.id}: ${claimExcerpt(r.text)}`).join("; "),
		};
	}

	/**
	 * planning activity, per-requirement mapping: for every formalized requirement the caller
	 * submits the claim that the plan serves it, marked by the claim_check path against the
	 * quoted evidence (one Noul per claim, ONE request). A requirement without a submitted
	 * claim, or with a claim the evidence does not support, leaves planning incomplete - the
	 * record says so, the submission comes back as `revise`, and the plan gate stays shut until
	 * the mapping covers every formalized requirement.
	 */
	private async submitPlanMapping(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		const formalization = this.currentFormalization();
		if (formalization === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					`${PLAN_MAPPING_STAGE} needs a completed requirements_formalization for the current task first ` +
						"(submit stage=requirements_formalization): there is no formalized requirement list to map",
				],
				judged: false,
				summary: "",
			};
		}
		if (input.planClaims.length === 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					`${PLAN_MAPPING_STAGE} needs planClaims: one {requirementId, claim} per formalized requirement, ` +
						"the claim being that the plan serves it",
				],
				judged: false,
				summary: "",
			};
		}
		const ids = formalization.requirements.map(r => r.id);
		const unknown = [...new Set(input.planClaims.filter(c => !ids.includes(c.requirementId)).map(c => c.requirementId))];
		if (unknown.length > 0) {
			// A claim about a requirement that was never formalized cannot map anything:
			// refused before any judge call, consuming no rework.
			return {
				verdict: "insufficient_evidence",
				reasons: [
					`unknown_requirement_id: ${unknown.join(", ")} — the formalized requirement ids are: ${ids.join(", ")}`,
				],
				judged: false,
				summary: "",
			};
		}
		const claims = input.planClaims.map(c => ({ id: c.requirementId, text: c.claim }));
		const missing = ids.filter(id => !claims.some(c => c.id === id));
		const consume = (): void => {
			this.state.iterations[boundKey] = used + 1;
			this.persist();
		};
		const failClosed = (detail: string): DecisionOutcome => {
			consume();
			return {
				verdict: "insufficient_evidence",
				reasons: [`${PLAN_MAPPING_STAGE}: ${detail}`, `fix: ${PLAN_MAPPING_FIX}`],
				judged: false,
				summary: "",
			};
		};
		const supported: Record<string, boolean> = {};
		if (claims.length < CLAIM_CHECK_MIN_CLAIMS) {
			// One formalized requirement: the per-claim marking path starts at two claims, so the
			// single mapping is one claim-shaped decision with fixed options instead.
			const options = this.template.stages?.[PLAN_MAPPING_STAGE]?.options ?? PLAN_MAPPING_OPTIONS;
			const requirement = formalization.requirements.find(r => r.id === claims[0]!.id)!;
			let rawResult: DecisionResult;
			try {
				rawResult = await this.judge({
					stage: PLAN_MAPPING_STAGE,
					task: input.task,
					proposal:
						"Claim under judgment: the plan below serves the formalized requirement, which is quoted " +
						`verbatim as \`${requirement.text}\`; nothing the requirement asks for is left without work ` +
						"in the plan, and no part of the plan contradicts it.\n\n" +
						`Plan claim (verbatim):\n${claims[0]!.text}`,
					options,
					evidence: input.evidence,
				});
			} catch (err) {
				return failClosed(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
			}
			const result = normalizeJudgeResult(rawResult, options, this.minConfidence);
			if (result.verdict === "ask_user" || result.verdict === "insufficient_evidence") {
				consume();
				return {
					verdict: result.verdict,
					reasons: [`${PLAN_MAPPING_STAGE}: ${result.reasons.join(" ")}`],
					confidence: result.confidence,
					judged: true,
					summary: "",
				};
			}
			supported[claims[0]!.id] = result.verdict === "approve";
		} else {
			if (this.claimCheckJudge === undefined) {
				return {
					verdict: "insufficient_evidence",
					reasons: [
						`${PLAN_MAPPING_STAGE} with several formalized requirements needs the per-claim marking judge, ` +
							"which is not configured in this session",
					],
					judged: false,
					summary: "",
				};
			}
			let raw: ClaimCheckResult;
			try {
				raw = await this.claimCheckJudge({
					stage: PLAN_MAPPING_STAGE,
					task: input.task,
					claims,
					evidence: input.evidence,
				});
			} catch (err) {
				return failClosed(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!isRecord(raw) || raw["judged"] !== true || !isRecord(raw["supported"])) {
				return failClosed("the judge returned an unjudged or malformed result; no mapping kept");
			}
			const marked = raw["supported"] as Record<string, unknown>;
			const unmarkable = claims.filter(c => typeof marked[c.id] !== "boolean");
			if (unmarkable.length > 0) {
				return failClosed(
					`the judge could not mark the plan claim(s) for ${unmarkable.map(c => c.id).join(", ")}; ` +
						"an unmarkable claim fails closed",
				);
			}
			const expectedIds = claims.map(c => c.id).sort();
			const actualIds = Object.keys(marked).sort();
			if (expectedIds.length !== actualIds.length || expectedIds.some((id, i) => id !== actualIds[i])) {
				return failClosed(
					`marked requirement ids must be exactly the submitted plan claims (${expectedIds.join(", ")}); ` +
						`got ${actualIds.join(", ")}`,
				);
			}
			for (const claim of claims) supported[claim.id] = marked[claim.id] === true;
		}
		const mapped = claims.map(c => ({ id: c.id, claim: c.text, supported: supported[c.id] === true }));
		const unsupported = mapped.filter(m => !m.supported);
		const complete = unsupported.length === 0 && missing.length === 0;
		this.state.lastPlanMapping = {
			requirements: mapped,
			missing,
			complete,
			at: this.now(),
			taskFingerprint: this.state.taskFingerprint,
			workRevision: this.state.workRevision,
		};
		// FR-21: the plan claims name the requirements the work serves, in the executor's own
		// declared order, so starting an item the judge's order ranked later than an item with no
		// supported claim yet is readable from two records. NAMED, never blocked (the row's own
		// wording is only "последовательности работы сессии", and an abstention never blocks work).
		this.noteOutOfOrderStart(mapped);
		if (complete) {
			this.persist();
			return {
				verdict: "approve",
				selectedOption: PLAN_MAPPING_APPROVED_OPTION,
				reasons: [`${PLAN_MAPPING_STAGE}: every formalized requirement has a supported plan claim (${mapped.length})`],
				judged: true,
				summary: `${PLAN_MAPPING_STAGE}: approve — ${mapped.length}/${ids.length} requirement(s) mapped to plan work`,
			};
		}
		consume();
		const named = [
			...unsupported.map(m => `${m.id} (claim not supported: ${claimExcerpt(m.claim)})`),
			...missing.map(id => `${id} (no plan claim submitted)`),
		].join(", ");
		this.pushFeedback(`Jev ${PLAN_MAPPING_STAGE}: planning incomplete — ${named}`);
		return {
			verdict: "revise",
			selectedOption: PLAN_MAPPING_INCOMPLETE_OPTION,
			reasons: [`${PLAN_MAPPING_STAGE}: planning incomplete — ${named}`, `fix: ${PLAN_MAPPING_FIX}`],
			judged: true,
			summary: `${PLAN_MAPPING_STAGE}: revise — planning incomplete: ${named}`,
		};
	}

	/**
	 * FR-20: acceptance criteria of the ACCEPTED requirement list. Each submitted criterion names
	 * the accepted requirement it checks; a criterion naming no requirement, or an id outside the
	 * accepted list, is refused BEFORE any judge call (the row's violation is a criterion that
	 * references nothing, and it can only be prevented where the reference is read). The judge then
	 * marks EVERY criterion in one request against the referenced requirement's verbatim quote; an
	 * unmarkable or partial answer fails closed with no record, so a criterion without a judge mark
	 * is never recorded and never usable. The record names the unaccepted criteria and the
	 * completion boundary names them too.
	 */
	private async submitAcceptanceCriteria(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		const formalization = this.currentFormalization();
		if (formalization === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"acceptance_criteria needs an ACCEPTED requirements list for the current task first " +
						"(submit stage=requirements_formalization): criteria are formalized from accepted requirements",
				],
				judged: false,
				summary: "",
			};
		}
		if (input.criteria.length === 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"acceptance_criteria needs criteria: one {requirementId, text} per criterion, the reference " +
						"being the accepted formalized requirement the criterion checks",
				],
				judged: false,
				summary: "",
			};
		}
		const ids = formalization.requirements.map(r => r.id);
		const unreferenced = input.criteria.filter(c => !ids.includes(c.requirementId)).map(c => c.requirementId);
		if (unreferenced.length > 0) {
			// Refused before any judge call: a criterion referencing no ACCEPTED requirement cannot
			// be judged against one, and letting it through would be exactly the row's violation.
			return {
				verdict: "insufficient_evidence",
				reasons: [
					`unknown_requirement_id: ${[...new Set(unreferenced)].join(", ")} — every criterion must ` +
						`reference an accepted requirement (${ids.join(", ")})`,
				],
				judged: false,
				summary: "",
			};
		}
		if (this.acceptanceCriteriaJudge === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["acceptance_criteria judge not configured in this session"],
				judged: false,
				summary: "",
			};
		}
		const criteria = input.criteria.map((c, i) => ({ id: `crit-${i + 1}`, ...c }));
		const consume = (): void => {
			this.state.iterations[boundKey] = used + 1;
			this.persist();
		};
		const failClosed = (detail: string): DecisionOutcome => {
			consume();
			return {
				verdict: "insufficient_evidence",
				reasons: [`acceptance_criteria: ${detail}`, `fix: ${CRITERIA_FIX}`],
				judged: false,
				summary: "",
			};
		};
		const accepted = formalization.requirements.map(r => ({ id: r.id, text: r.text, quote: r.quote }));
		let raw: AcceptanceCriteriaResult;
		try {
			raw = await this.acceptanceCriteriaJudge({
				stage: "acceptance_criteria",
				task: input.task,
				criteria: criteria.map(c => ({ id: c.id, requirementId: c.requirementId, text: c.text })),
				requirements: accepted,
				evidence: input.evidence,
			});
		} catch (err) {
			return failClosed(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!isRecord(raw) || raw["judged"] !== true || !isRecord(raw["marked"])) {
			return failClosed("the judge returned an unjudged or malformed result; no criterion is accepted");
		}
		const marks = raw["marked"] as Record<string, unknown>;
		const unmarkable = criteria.filter(c => typeof marks[c.id] !== "boolean").map(c => c.id);
		if (unmarkable.length > 0) {
			return failClosed(`the judge could not mark ${unmarkable.join(", ")}; an unmarkable criterion fails closed`);
		}
		const expectedIds = criteria.map(c => c.id).sort();
		const actualIds = Object.keys(marks).sort();
		if (expectedIds.length !== actualIds.length || expectedIds.some((id, i) => id !== actualIds[i])) {
			return failClosed(
				`the marked criterion ids must be exactly the submitted criteria (${expectedIds.join(", ")}); ` +
					`got ${actualIds.join(", ")}`,
			);
		}
		const record: AcceptanceCriteriaRecord = {
			criteria: criteria.map(c => ({
				id: c.id,
				requirementId: c.requirementId,
				text: c.text,
				requirementQuote: accepted.find(r => r.id === c.requirementId)?.quote ?? "",
				marked: marks[c.id] === true,
			})),
			unaccepted: criteria.filter(c => marks[c.id] !== true).map(c => c.id),
			complete: criteria.every(c => marks[c.id] === true),
			batch: this.acceptedBatch(),
			at: this.now(),
			workRevision: this.state.workRevision,
		};
		this.state.lastAcceptanceCriteria = record;
		if (!record.complete) {
			consume();
			const named = record.criteria
				.filter(c => !c.marked)
				.map(c => `${c.id} (${c.requirementId}: ${claimExcerpt(c.text)})`)
				.join(", ");
			this.pushFeedback(`Jev acceptance_criteria: criterion(s) without a requirement basis — ${named}`);
			return {
				verdict: "revise",
				selectedOption: CRITERIA_UNBACKED_OPTION,
				reasons: [
					`acceptance_criteria: the referenced requirement does not state or entail ${named}`,
					`fix: ${CRITERIA_FIX}`,
				],
				judged: true,
				summary: `acceptance_criteria: revise — criterion_without_requirement_basis: ${named}`,
			};
		}
		this.persist();
		return {
			verdict: "approve",
			selectedOption: CRITERIA_ACCEPTED_OPTION,
			reasons: [`acceptance_criteria: ${record.criteria.length} criterion/criteria accepted, each referencing an accepted requirement`],
			judged: true,
			summary:
				`acceptance_criteria: accepted ${record.criteria.length} criterion/criteria — ` +
				record.criteria.map(c => `${c.id}→${c.requirementId}: ${claimExcerpt(c.text)}`).join("; "),
		};
	}

	/**
	 * FR-21: the judge sets the order over the ACCEPTED requirement list. The controller supplies
	 * the list itself (the judge can never invent an item), the judge assigns a priority class to
	 * every item in ONE request, and the order is derived from those marks with the item's position
	 * in the accepted list as the documented tie-break - so the executor generates no text that
	 * orders anything. The record carries the order, each item's number and verbatim quote, and the
	 * batch it ranks; a record that replaced an earlier order keeps the superseded batch identity.
	 */
	private async submitPriorities(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		const formalization = this.currentFormalization();
		if (formalization === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"requirement_priorities needs an ACCEPTED requirements list for the current task first " +
						"(submit stage=requirements_formalization): there is nothing to rank",
				],
				judged: false,
				summary: "",
			};
		}
		if (this.priorityJudge === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["requirement_priorities judge not configured in this session"],
				judged: false,
				summary: "",
			};
		}
		const consume = (): void => {
			this.state.iterations[boundKey] = used + 1;
			this.persist();
		};
		const failClosed = (detail: string): DecisionOutcome => {
			consume();
			// Fail-closed and named: no order is recorded, the previous record (if any) stands as it
			// is, and the planning gap keeps naming the accepted batch that has no fresh order.
			return {
				verdict: "insufficient_evidence",
				reasons: [`requirement_priorities: ${detail}`, `fix: ${PRIORITIES_FIX}`],
				judged: false,
				summary: "",
			};
		};
		const accepted = formalization.requirements.map(r => ({ id: r.id, text: r.text, quote: r.quote }));
		let raw: PriorityResult;
		try {
			raw = await this.priorityJudge({
				stage: "requirement_priorities",
				task: input.task,
				requirements: accepted,
				evidence: input.evidence,
			});
		} catch (err) {
			return failClosed(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!isRecord(raw) || raw["judged"] !== true || !isRecord(raw["classes"])) {
			return failClosed("the judge returned an unjudged or malformed result; no order was recorded");
		}
		const classes = raw["classes"] as Record<string, unknown>;
		const confidences = isRecord(raw["confidences"]) ? (raw["confidences"] as Record<string, unknown>) : {};
		const unranked = accepted.filter(r => typeof classes[r.id] !== "string").map(r => r.id);
		if (unranked.length > 0) {
			return failClosed(`the judge ranked no class for ${unranked.join(", ")}; a partial ranking is not an order`);
		}
		const wrongClass = accepted
			.filter(r => !(PRIORITY_CLASSES as readonly string[]).includes(classes[r.id] as string))
			.map(r => `${r.id}→${String(classes[r.id])}`);
		if (wrongClass.length > 0) {
			return failClosed(`the judge returned a class outside the fixed set for ${wrongClass.join(", ")}`);
		}
		const expectedIds = accepted.map(r => r.id).sort();
		const actualIds = Object.keys(classes).sort();
		if (expectedIds.length !== actualIds.length || expectedIds.some((id, i) => id !== actualIds[i])) {
			return failClosed(
				`the ranked ids must be exactly the accepted requirement ids (${expectedIds.join(", ")}); ` +
					`got ${actualIds.join(", ")}`,
			);
		}
		// The order: the fixed class sequence, ties broken by the item's position in the accepted
		// list (documented and deterministic, so the same marks always produce the same order).
		const items: PriorityOrderItem[] = accepted
			.map((r, position) => ({
				position,
				requirement: r,
				priorityClass: classes[r.id] as PriorityClass,
				confidence: typeof confidences[r.id] === "number" ? (confidences[r.id] as number) : undefined,
			}))
			.sort((a, b) => {
				const byClass = PRIORITY_CLASSES.indexOf(a.priorityClass) - PRIORITY_CLASSES.indexOf(b.priorityClass);
				return byClass !== 0 ? byClass : a.position - b.position;
			})
			.map((entry, i) => ({
				requirementId: entry.requirement.id,
				rank: i + 1,
				text: entry.requirement.text,
				quote: entry.requirement.quote,
				priorityClass: entry.priorityClass,
				confidence: entry.confidence,
			}));
		const previous = this.state.lastPriorities;
		this.state.lastPriorities = {
			items,
			batch: this.acceptedBatch(),
			stale: false,
			supersedes: previous?.batch,
			at: this.now(),
		};
		this.persist();
		return {
			verdict: "approve",
			selectedOption: PRIORITIES_RANKED_OPTION,
			reasons: [
				`requirement_priorities: the judge set the order over ${items.length} accepted requirement(s): ` +
					items.map(i => i.requirementId).join(" → "),
			],
			judged: true,
			summary:
				`requirement_priorities: order set by the judge — ` +
				items.map(i => `${i.rank}. ${i.requirementId} (${i.priorityClass}): via "${i.quote}"`).join("; "),
		};
	}

	/**
	 * The identity of the accepted requirement batch: the current task plus the content digest the
	 * accepted list carries. Two records with the same identity rank the same list, so comparing
	 * identities is what makes "the order was not re-ranked after the accepted batch" visible.
	 */
	private acceptedBatch(): AcceptedBatch {
		return {
			taskFingerprint: this.state.taskFingerprint,
			digest: this.currentFormalization()?.batchDigest ?? "",
		};
	}

	/**
	 * FR-21: a NEW accepted batch retires the order that ranked the previous one. Recorded on the
	 * order itself (stale + the reason naming both batches) so the state says the re-rank is owed,
	 * and pushed into the session at the moment it happens.
	 */
	private retireSupersededOrders(): void {
		const batch = this.acceptedBatch();
		const order = this.state.lastPriorities;
		if (order === undefined || order.stale) return;
		if (order.batch.taskFingerprint === batch.taskFingerprint && order.batch.digest === batch.digest) {
			return;
		}
		order.stale = true;
		order.staleReason =
			`the accepted requirement list changed, so the recorded priority order no longer ranks it ` +
			`(the order ranks batch ${order.batch.digest.slice(0, 8)}, the accepted list is batch ` +
			`${batch.digest.slice(0, 8)}): re-rank with stage=requirement_priorities`;
		this.persist();
		this.pushFeedback(`Jev requirement_priorities: ${order.staleReason}`);
	}

	/**
	 * FR-21 naming: the plan mapping's claims arrive in the executor's declared work order, so the
	 * first supported claim is the first item the work serves. When the judge's order ranks another
	 * item first and that item carries no supported claim yet, the session record says so: the item
	 * that was started and the item the order asked for first. Naming only - it blocks nothing.
	 */
	private noteOutOfOrderStart(mapped: Array<{ id: string; supported: boolean }>): void {
		const order = this.state.lastPriorities;
		if (order === undefined || order.stale) return;
		const batch = this.acceptedBatch();
		if (order.batch.taskFingerprint !== batch.taskFingerprint || order.batch.digest !== batch.digest) return;
		const declaredFirst = mapped.find(m => m.supported);
		if (declaredFirst === undefined) return;
		const declaredItem = order.items.find(i => i.requirementId === declaredFirst.id);
		if (declaredItem === undefined || declaredItem.rank <= 1) return;
		const earlier = order.items
			.filter(i => i.rank < declaredItem.rank && !mapped.some(m => m.id === i.requirementId && m.supported))
			.sort((a, b) => a.rank - b.rank)[0];
		if (earlier === undefined) return;
		order.outOfOrder = { started: declaredItem.requirementId, expectedFirst: earlier.requirementId };
		this.persist();
		const line =
			`Jev requirement_priorities: the work order starts at ${declaredItem.requirementId} while the judge's ` +
			`order ranks ${earlier.requirementId} first and no supported plan claim covers it. The order: ` +
			order.items.map(i => `${i.rank}. ${i.requirementId}`).join(" → ");
		this.pushFeedback(line);
	}

	/**
	 * Review activity (src/reviews.ts): the descriptor's fixed question set goes to the review
	 * judge in ONE request; the per-item results are recorded in the session state and surfaced.
	 * Advisory by construction - the submission path here records no approval, pushes no blocker and
	 * refuses nothing: a confident negative STATEMENT is reported as a finding the executor must
	 * answer, and an abstention, a judge error, a deadline loss or a frame escape records the
	 * uncertainty. `claims` carries the declared items (decisions, defects, surfaces) and `options`
	 * the declared candidates, so the judge can never invent one.
	 */
	private async submitReview(
		gate: mechanism.ReviewGate,
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		const questions = this.template.stages?.[gate.stage]?.questions ?? gate.consult.questions;
		const items = input.claims.map((text, i) => ({ id: `item-${i + 1}`, text }));
		if (this.reviewJudge === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`${gate.stage}: review judge not configured in this session`],
				judged: false,
				summary: "",
			};
		}
		const outcome = await consultReview({
			stage: gate.stage,
			// PRD 1.1/FR-10: the findings of the previous review of this stage and the declared
			// answers travel with the subject, verbatim, so an approve is the judge's own answer
			// about the standing problem rather than a fresh reading of the same material.
			task: this.withOutstandingProblems(
				boundKey,
				input,
				`${gate.consult.task}\n\nSubject under review: ${input.task}`,
			),
			questions,
			items,
			// The template may replace the review's declared candidate set exactly as it may replace
			// its question set; without an override the executor's declared candidates are used.
			candidates: this.template.stages?.[gate.stage]?.options ?? input.options,
			evidence: input.evidence,
			judge: this.reviewJudge,
			deadlineMs: this.reviewDeadlineMs,
		});
		const record = reviewRecord(gate.id, gate.stage, outcome, {
			at: this.now(),
			taskFingerprint: this.state.taskFingerprint,
			workRevision: this.state.workRevision,
		});
		if (!outcome.ok) {
			// A review that could not be judged is real rework: it consumes the bound so a broken
			// consult cannot loop forever, and it records the uncertainty without blocking anything.
			this.state.reviews[gate.id] = record;
			this.state.iterations[boundKey] = used + 1;
			this.persist();
			this.pushFeedback(`Jev ${gate.stage} not judged: ${outcome.detail}. Nothing is blocked.`);
			return {
				verdict: "insufficient_evidence",
				reasons: [`${gate.stage}: ${outcome.detail}`],
				judged: false,
				summary: `${gate.stage}: insufficient_evidence — ${outcome.detail} (recorded; nothing is blocked)`,
			};
		}
		if (record.findings.length === 0) {
			// The answer obliges (PRD 1.1/FR-10): a review with no findings is the pass of this
			// stage, so while a standing named problem of it is unanswered the pass is not recorded
			// at all - the refusal names the problems (the stage stays advisory: no blocker, no
			// boundary moves, the finding list is simply not cleared by answering nothing). The
			// consultation was spent on a submission that answered nothing, so it is real rework.
			const withheld = this.withheldByOutstanding(boundKey, input);
			if (withheld !== undefined) {
				this.state.iterations[boundKey] = used + 1;
				this.persist();
				return withheld;
			}
		}
		this.state.reviews[gate.id] = record;
		if (record.findings.length > 0) {
			this.state.iterations[boundKey] = used + 1;
			this.persist();
			this.pushFeedback(`Jev ${gate.stage}: finding(s) to answer — ${record.findings.join(", ")}`);
			return {
				verdict: "revise",
				reasons: [`${gate.stage}: findings — ${record.findings.join(", ")}`],
				judged: true,
				summary: reviewLine(record),
			};
		}
		this.persist();
		return { verdict: "approve", reasons: [`${gate.stage}: recorded`], judged: true, summary: reviewLine(record) };
	}

	/** aspect_coverage three-way marking: missed aspects -> revise; else recorded, no approval. */
	private async submitAspectCoverage(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		let raw: AspectCoverageResult;
		try {
			raw = await this.aspectCoverageJudge!({
				aspects: input.aspects.map(id => ({ id, text: id })),
				// PRD 1.1/FR-10: standing named problems and the declared answers travel with the
				// action under check, verbatim.
				currentAction: this.withOutstandingProblems(boundKey, input, input.proposal),
				evidence: input.evidence,
			});
		} catch (err) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`],
				judged: false,
				summary: "",
			};
		}
		if (
			!isRecord(raw) ||
			raw["judged"] !== true ||
			raw["escape"] === true ||
			!isRecord(raw["markings"])
		) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["aspect_coverage judge returned an unjudged, escaped or malformed result; no mapping applied"],
				judged: false,
				summary: "",
			};
		}
		const markings = raw["markings"] as Record<string, string>;
		const unknownIds = input.aspects.filter(id => !(id in markings));
		if (unknownIds.length > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`aspect_coverage judge did not mark: ${unknownIds.join(", ")}`],
				judged: false,
				summary: "",
			};
		}
		const missed = input.aspects.filter(id => markings[id] === "applicable_not_addressed");
		this.state.iterations[boundKey] = used + 1;
		const reasons = [
			...(Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : []),
		];
		if (missed.length > 0) {
			// Open drift recorded against the current task: completion teeth (unmetStopGates).
			this.state.openAspectGaps = { missed, taskFingerprint: this.state.taskFingerprint };
			reasons.push(`missed aspects: ${missed.join(", ")}`);
			this.pushFeedback(`Jev aspect_coverage: applicable but not addressed — ${missed.join(", ")}`);
			this.persist();
			return {
				verdict: "revise",
				reasons,
				confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
				judged: true,
				summary: `aspect_coverage: revise — applicable_not_addressed: ${missed.join(", ")}`,
			};
		}
		// The answer obliges (PRD 1.1/FR-10): an approve whose submission answered none of the
		// standing named problems is not recorded - the drift teeth are not lifted and no pass of
		// this stage is written while the judge's own problem stands.
		const withheldAspect = this.withheldByOutstanding(boundKey, input);
		if (withheldAspect !== undefined) return withheldAspect;
		this.state.openAspectGaps = undefined;
		this.persist();
		return {
			verdict: "approve",
			reasons,
			confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
			judged: true,
			summary: "aspect_coverage: approve — all applicable aspects addressed",
		};
	}

	/** course_check ask_user escalation: recorded blocker, never a gate grant. */
	private escalateCourseCheck(normalized: DecisionResult): DecisionOutcome {
		const blocker = "course_check escalated to the user (ask_user chosen by the judge or rework bound).";
		if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
		this.persist();
		return {
			verdict: "ask_user",
			reasons: [...normalized.reasons, blocker],
			confidence: normalized.confidence,
			judged: true,
			summary: "",
		};
	}

	// ----- internals -----

	private extraStageSet(): Set<string> {
		return new Set(this.extraPoints.keys());
	}

	private extraStageTemplate(stage: string): { instructions?: string; options?: DecisionOption[] } | undefined {
		const declared = this.template.controlPoints?.[stage];
		if (declared === undefined) return undefined;
		return { instructions: declared.instructions, options: declared.options };
	}

	// ----- rework loop: N attempts, each a different approach (PRD 19, TASKS "Rules of the loop") -----

	/**
	 * The rejected attempt that already spent this approach on the same task+stage, if any. An
	 * APPROVED attempt is not a spent approach: its loop ended with the judge's agreement, so
	 * naming that approach again later is a fresh consultation, not a re-wording of a rejection.
	 * Comparison folds case and inner whitespace only, so "Tighten the  trigger" cannot buy a
	 * second attempt; every message quotes the text as submitted. Only judged attempts are in the
	 * journal, so a submission refused before the judge call never spends its approach.
	 */
	private spentApproach(key: string, approach: string): ReworkAttempt | undefined {
		const normalized = approach.trim().replace(/\s+/g, " ").toLowerCase();
		return this.rejectedAttempts(key).find(
			a => a.approach.trim().replace(/\s+/g, " ").toLowerCase() === normalized,
		);
	}

	/**
	 * The judged attempts the bound counts: those the judge did NOT approve. An approved attempt
	 * ended its loop successfully, so it neither consumes the bound nor blocks a later consultation
	 * of the same stage (the executor is told to run course_check after every mutation, and three
	 * benign `continue` verdicts must never exhaust a rework bound - the journal would then assert
	 * "all rejected" against its own record).
	 */
	private rejectedAttempts(key: string): ReworkAttempt[] {
		return (this.state.reworkJournal[key]?.attempts ?? []).filter(a => a.verdict !== "approve");
	}

	/** The rejected attempts as one line: each approach with the judge's own verbatim answer. */
	private reworkJournalLine(attempts: readonly ReworkAttempt[]): string {
		if (attempts.length === 0) return "no rejected attempt recorded";
		return attempts
			.map(a => {
				const reasons = a.reasons.join(" ").slice(0, REWORK_REASON_EXCERPT_CHARS);
				return `${a.attempt}. "${a.approach}" — ${a.verdict}${reasons === "" ? "" : `: ${reasons}`}`;
			})
			.join("; ");
	}

	/**
	 * Record a judged attempt in the journal (PRD 19 rule 5: attempts, approaches, verbatim verdicts)
	 * and tell the same session what the next attempt must change. Only a judged outcome carrying an
	 * approach is an attempt: a submission refused before the judge call never spent one, and a judge
	 * error produced no verdict to record. A repeated approach cannot reach this point - the core
	 * refuses it before judging - so the journal never holds the same approach twice.
	 */
	private async recordReworkAttempt(raw: unknown, outcome: DecisionOutcome): Promise<void> {
		if (!isRecord(raw) || outcome.judged !== true) return;
		const stage = typeof raw["stage"] === "string" ? raw["stage"] : undefined;
		const approach = typeof raw["approach"] === "string" ? raw["approach"].trim() : undefined;
		if (stage === undefined || approach === undefined || approach.length === 0) return;
		const taskText = typeof raw["task"] === "string" ? raw["task"] : "";
		const fp = this.state.taskFingerprint ?? (taskText.length > 0 ? await fingerprint(taskText) : "");
		if (fp === "") return;
		const key = `${fp}:${stage}`;
		const journal: ReworkJournal = this.state.reworkJournal[key] ?? {
			taskFingerprint: this.state.taskFingerprint,
			stage,
			attempts: [],
			open: false,
			at: this.now(),
		};
		const attempt = journal.attempts.length + 1;
		const rejectedBefore = journal.attempts.filter(a => a.verdict !== "approve").map(a => `"${a.approach}"`);
		journal.attempts.push({
			attempt,
			approach,
			verdict: outcome.verdict,
			reasons: [...outcome.reasons],
			confidence: outcome.confidence,
			at: this.now(),
		});
		journal.at = this.now();
		this.state.reworkJournal[key] = journal;
		this.persist();
		if (outcome.verdict === "approve") return;
		// The bound is the count of REJECTED attempts (see rejectedAttempts): an approved attempt
		// earlier in the same journal does not count toward it.
		const rejectedNow = rejectedBefore.length + 1;
		const reasons = outcome.reasons.join(" ").slice(0, REWORK_REASON_EXCERPT_CHARS);
		this.pushFeedback(
			`Jev rework attempt ${rejectedNow}/${this.maxReworkIterations} for ${stage} (approach "${approach}") was ` +
				`rejected — ${outcome.verdict}${reasons === "" ? "" : `: ${reasons}`}. ` +
				`Approaches already rejected: ${rejectedBefore.length === 0 ? "none" : rejectedBefore.join(", ")}. ` +
				(rejectedNow >= this.maxReworkIterations
					? "The attempt bound is now exhausted: the next approach escalates as an OPEN item with this " +
						"journal instead of being judged; re-wording a spent approach is refused outright."
					: "The next attempt must name a DIFFERENT approach (tighten the trigger; split the item into " +
						"narrower separately checkable items; restate it as an outcome plus the evidence that " +
						"settles it) - the same approach in different words is not a new attempt."),
		);
	}

	// ----- the standing named problems of a confident refusal (PRD 1.1 / FR-10) -----

	/**
	 * The standing problems for a `taskFingerprint:stage` key, when any stand. A record without a
	 * problem (or without a current task) is no obligation at all.
	 */
	private outstandingReworkFor(key: string): OutstandingRework | undefined {
		const record = this.state.outstandingRework[key];
		return record === undefined || record.problems.length === 0 ? undefined : record;
	}

	/** Parse the answers of a raw submission the way validateDecisionInput does (blank entries dropped). */
	private static submissionAnswers(raw: unknown): string[] {
		if (!isRecord(raw) || !Array.isArray(raw["answers"])) return [];
		return raw["answers"]
			.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
			.map(a => a.trim());
	}

	/**
	 * The named problems a judged outcome leaves standing (`[]` = the outcome obliges nothing).
	 * The problems are the judge's own reasons (src/gates.ts keeps them verbatim and de-duplicated).
	 *
	 * Who may oblige: only a refusal the product reads as confident. For every stage but a review
	 * that means the judge's own confidence, present and at or above the minimum that gate refusals
	 * use - a sub-floor or unquantified refusal is uncertainty, and uncertainty is never turned into
	 * an obligation (while an approval still requires the floor and the fail-closed normalizer). A
	 * review is the exception by its own contract: `src/reviews.ts` builds a finding out of the
	 * declared statement polarity above a fixed threshold and calls it a confident negative, so a
	 * finding IS how a review states a refusal - it carries no choice-confidence to compare.
	 */
	private namedRefusalProblems(stage: string, outcome: DecisionOutcome): string[] {
		if (outcome.judged !== true || outcome.verdict !== "revise") return [];
		// A frame escape is the judge rejecting the OFFERED OPTION SET, not the work: it records
		// and never refuses, so it obliges nothing either (src/gates.ts, FRAME_ESCAPE_REASON).
		if (outcome.reasons.includes(mechanism.FRAME_ESCAPE_REASON)) return [];
		const problems = mechanism.namedRefusalProblems(outcome.reasons);
		if (problems.length === 0) return [];
		if (mechanism.reviewGateForStage(stage) !== undefined) return problems;
		const confidence = outcome.confidence;
		if (
			confidence === undefined ||
			!Number.isFinite(confidence) ||
			confidence < this.minConfidence ||
			confidence > 1
		) {
			return [];
		}
		return problems;
	}

	/**
	 * Record (or extend) the standing problems of a task+stage and deliver the numbered list into the
	 * SAME session as the thing to fix: what the judge named, that every problem must be answered by
	 * position in `answers` on the next submission of this stage, and that the judge sees the problems
	 * and the answers verbatim. Problems already standing are never renumbered or dropped - a refusal
	 * adds what it named.
	 */
	private recordOutstandingRework(key: string, stage: string, problems: readonly string[], confidence: number | undefined): void {
		const record = this.state.outstandingRework[key] ?? {
			stage,
			taskFingerprint: this.state.taskFingerprint,
			problems: [],
			refusals: 0,
			at: this.now(),
		};
		for (const problem of problems) {
			if (!record.problems.includes(problem)) record.problems.push(problem);
		}
		record.refusals += 1;
		record.at = this.now();
		this.state.outstandingRework[key] = record;
		this.persist();
		this.pushFeedback(
			`Jev ${stage}: the judge refused and named ${problems.length} problem(s) - this answer obliges ` +
				"(PRD 1.1: выясняй что не так и переделывай). The next submission on this stage must change the " +
				`WORK and answer every problem below by position in \`answers\` (one entry per problem, in this ` +
				`order), and no approval of this stage is recorded while any of them stands unanswered:\n` +
				mechanism.numberedProblems(record.problems) +
				(record.problems.length > problems.length
					? `\n(${record.problems.length - problems.length} problem(s) named by an earlier refusal of ` +
						"this stage still stand too.)"
					: "") +
				(confidence !== undefined ? `\n(that refusal carried confidence ${confidence})` : ""),
		);
	}

	/** Drop a standing obligation: its stage is no longer under a refusal (approved or escalated). */
	private clearOutstandingRework(key: string, stage: string, why: string): void {
		if (this.state.outstandingRework[key] === undefined) return;
		delete this.state.outstandingRework[key];
		this.persist();
		this.pushFeedback(`Jev ${stage}: the standing problems are settled - ${why}.`);
	}

	/**
	 * The refusal that withholds an approval: while a stage carries standing named problems, a
	 * submission that answers none of them is NOT recorded as an approval - the outcome is
	 * insufficient_evidence naming every problem and the fix, so the boundary that consumes an
	 * approval (the plan gate, the stop gate, the course-check pass) stays shut and the next step is
	 * the rework the judge asked for. `undefined` when no problem stands or every problem is answered
	 * (then the judge's own answer decides).
	 */
	private withheldByOutstanding(key: string, input: ValidatedDecisionInput): DecisionOutcome | undefined {
		const record = this.outstandingReworkFor(key);
		if (record === undefined) return undefined;
		const unanswered = mechanism.unansweredProblems(record.problems, input.answers);
		if (unanswered.length === 0) return undefined;
		const problem =
			`outstanding_rework_unanswered: ${input.stage} is under a refusal that named ` +
			`${record.problems.length} problem(s); ${unanswered.length} of them are not answered by this ` +
			"submission, so it is not recorded as an approval and no pass of this stage is written. Answer every " +
			"problem by position in `answers` (one entry per problem, in the order below, each stating what changed " +
			"in the work - changing the wording is not a rework). Named problems:\n" +
			mechanism.numberedProblems(record.problems);
		this.pushFeedback(`Jev ${input.stage}: approval withheld - ${problem}`);
		return {
			verdict: "insufficient_evidence",
			reasons: [problem],
			judged: true,
			summary: `${input.stage}: insufficient_evidence — approval withheld: ${unanswered.length} named problem(s) unanswered`,
		};
	}

	/**
	 * The standing named problems of a plan-granting stage, as one line naming the stage and quoting
	 * the problems verbatim - or undefined when none stands. The mutation boundary reads it beside
	 * the approval record: a refusal on a granting stage keeps the boundary shut even when an older
	 * approval of that stage is still in state, so no mutating work continues as if the judge had
	 * answered approve (PRD 1.1/FR-10, and section 12.11 keeps the boundary check alongside the
	 * obligation to rework).
	 */
	private outstandingGrantingProblem(): string | undefined {
		const taskFingerprint = this.state.taskFingerprint;
		if (taskFingerprint === undefined) return undefined;
		for (const stage of this.approvalBoundary().grantingStages) {
			const record = this.outstandingReworkFor(`${taskFingerprint}:${stage}`);
			if (record !== undefined) {
				return (
					`${stage} carries ${record.problems.length} named problem(s) from a refusal of the judge: ` +
					`${record.problems.join(" | ")}. Mutating work is blocked until a submission on that stage ` +
					"answers every one of them and the judge approves it"
				);
			}
		}
		return undefined;
	}

	/** The judge-facing text with the standing problems and the declared answers attached, verbatim. */
	private withOutstandingProblems(key: string, input: ValidatedDecisionInput, text: string): string {
		const record = this.outstandingReworkFor(key);
		if (record === undefined) return text;
		return `${text}\n\n${mechanism.outstandingProblemsBlock(record.problems, input.answers)}`;
	}

	/**
	 * The obligation in one place, after every path has produced its outcome: a confident refusal
	 * records the problems it named, an APPROVED submission that answered every problem clears them,
	 * an escalation to the user hands the loop over (the blocker names the problems), and an
	 * abstention, a judge error or a sub-floor refusal leaves the record exactly as it was.
	 */
	private applyOutstandingRework(raw: unknown, outcome: DecisionOutcome): void {
		if (!isRecord(raw) || outcome.judged !== true) return;
		const stage = typeof raw["stage"] === "string" ? raw["stage"] : undefined;
		const fingerprintNow = this.state.taskFingerprint;
		if (stage === undefined || fingerprintNow === undefined) return;
		const key = `${fingerprintNow}:${stage}`;
		const standing = this.outstandingReworkFor(key);
		if (standing !== undefined) {
			if (outcome.verdict === "approve") {
				const unanswered = mechanism.unansweredProblems(standing.problems, JevController.submissionAnswers(raw));
				if (unanswered.length === 0) {
					this.clearOutstandingRework(key, stage, "the judge approved a submission that answered every problem");
				}
				return;
			}
			if (outcome.verdict === "ask_user") {
				this.clearOutstandingRework(key, stage, "the loop was escalated to the user, who owns the decision now");
				return;
			}
		}
		const problems = this.namedRefusalProblems(stage, outcome);
		if (problems.length === 0) return;
		this.recordOutstandingRework(key, stage, problems, outcome.confidence);
	}

	/**
	 * The approval boundary of the plan/mutation descriptor: which stages grant the pre-mutation
	 * gate and which stage opens the session-stop boundary. Declared once, in src/gates.ts.
	 */
	private approvalBoundary(): { grantingStages: readonly DecisionStage[]; stopStage: DecisionStage } {
		return mechanism.approvalGate("plan_mutation").consult;
	}

	private planApproval(): ApprovalRecord | undefined {
		// Undefined current fingerprint means no user task is established yet: no gate credit.
		if (this.state.taskFingerprint === undefined) return undefined;
		const granting = this.approvalBoundary().grantingStages;
		return this.state.approvals.find(
			a => granting.includes(a.stage) && a.taskFingerprint === this.state.taskFingerprint,
		);
	}

	// ----- activities framework (src/activities.ts): outcome sets, planning completeness -----

	/**
	 * Activity outcome enforcement: the registry (src/activities.ts) declares the FIXED outcome
	 * set of every activity, so an engine answer the owning activity cannot express is a defect
	 * and fails closed - never an approval, never a silent pass. Stages no activity claims
	 * (config-declared on_demand points) are not guarded: the registry frames the product's own
	 * stages, not owner-declared extras.
	 */
	private guardActivityOutcome(stage: DecisionStage, outcome: DecisionOutcome): DecisionOutcome | undefined {
		const resolved = resolveActivityOutcome(stage, outcome.verdict, outcome.selectedOption, this.activities);
		if (resolved === undefined || resolved.declared) return undefined;
		const declared = this.activities[resolved.activityId]?.outcomes ?? [];
		return {
			verdict: "insufficient_evidence",
			reasons: [
				`activity_outcome_undeclared: activity "${resolved.activityId}" cannot answer "${resolved.outcome}" ` +
					`for stage "${stage}" (declared outcomes: ${declared.join(", ")})`,
			],
			judged: false,
			summary:
				`${stage}: insufficient_evidence — the answer is outside the declared outcome set of activity ` +
				`"${resolved.activityId}"; the submission is refused (fail-closed)`,
		};
	}

	/** The accepted requirement checklist of the current task, or undefined when none exists. */
	private currentFormalization(): FormalizationRecord | undefined {
		const record = this.state.lastFormalization;
		if (record === undefined || !record.complete) return undefined;
		// A list formalized for another task never authorizes the current one (fail-safe).
		if (record.taskFingerprint !== this.state.taskFingerprint) return undefined;
		return record;
	}

	/**
	 * Planning incompleteness (activities framework, planning activity): for every formalized
	 * requirement the plan must carry a claim that the work serves it, marked by the claim_check
	 * path, and the judged priority order must rank the SAME accepted batch (FR-21: the order is
	 * re-ranked after the next accepted batch, so an order that ranks a retired batch leaves
	 * planning incomplete by name). Returns the gap, or undefined when planning is complete -
	 * including when the task was never formalized, so the default workflow behaves as before.
	 */
	private planningGap(): string | undefined {
		const gaps = [this.planMappingGap(), this.prioritiesGap()].filter((g): g is string => g !== undefined);
		return gaps.length === 0 ? undefined : gaps.join("; ");
	}

	/** The plan-mapping half of the planning gap: no submission, or a requirement with no supported claim. */
	private planMappingGap(): string | undefined {
		const formalization = this.currentFormalization();
		if (formalization === undefined) return undefined;
		const mapping = this.state.lastPlanMapping;
		const ids = formalization.requirements.map(r => r.id);
		if (mapping === undefined || mapping.taskFingerprint !== this.state.taskFingerprint) {
			return (
				`plan mapping incomplete: no ${PLAN_MAPPING_STAGE} submission covers the ${ids.length} formalized ` +
				`requirement(s) (${ids.join(", ")})`
			);
		}
		const unmapped = ids.filter(id => !mapping.requirements.some(r => r.id === id && r.supported));
		if (unmapped.length === 0) return undefined;
		return `plan mapping incomplete: requirement(s) ${unmapped.join(", ")} have no supported plan claim`;
	}

	/**
	 * FR-21: the judged order must rank the accepted batch that is current. An absent order, an
	 * order that ranks a retired batch (recorded as stale the moment the new batch was accepted) or
	 * an order that leaves an accepted item unranked is a named planning gap - the row's violation
	 * is "порядок не пересмотрен после принятой порции", and this is what makes it impossible to
	 * work through silently. Undefined when no list was accepted (FR-21 is not engaged).
	 */
	private prioritiesGap(): string | undefined {
		const formalization = this.currentFormalization();
		if (formalization === undefined) return undefined;
		const ids = formalization.requirements.map(r => r.id);
		const order = this.state.lastPriorities;
		if (order === undefined || order.batch.taskFingerprint !== this.state.taskFingerprint) {
			return (
				`priority order missing: the accepted requirement(s) (${ids.join(", ")}) have no ` +
				"requirement_priorities order from the judge"
			);
		}
		if (order.stale) {
			return order.staleReason ?? "the priority order does not rank the accepted requirement list";
		}
		if (order.batch.digest !== formalization.batchDigest) {
			return (
				`priority order ranks a retired batch (the order ranks batch ${order.batch.digest.slice(0, 8)}, ` +
				`the accepted list is batch ${formalization.batchDigest.slice(0, 8)}): re-rank with ` +
				"stage=requirement_priorities"
			);
		}
		const unranked = ids.filter(id => !order.items.some(i => i.requirementId === id));
		if (unranked.length > 0) {
			return `priority order leaves accepted requirement(s) ${unranked.join(", ")} unranked`;
		}
		return undefined;
	}

	/**
	 * FR-20 teeth: a submitted criteria list the judge did not fully accept names its unaccepted
	 * criterion ids, and the completion boundary names them - work never completes by a criterion
	 * that carries no judge mark. Criteria formalized from a retired batch are stale the same way
	 * (a new accepted list needs its own criteria). Undefined when no criteria were submitted.
	 */
	private criteriaGap(): string | undefined {
		const record = this.state.lastAcceptanceCriteria;
		if (record === undefined || record.batch.taskFingerprint !== this.state.taskFingerprint) return undefined;
		if (!record.complete) {
			return (
				`acceptance criteria not accepted: criterion(s) ${record.unaccepted.join(", ")} are not backed by ` +
				`their referenced requirement (resubmit stage=acceptance_criteria)`
			);
		}
		const formalization = this.currentFormalization();
		if (formalization !== undefined && record.batch.digest !== formalization.batchDigest) {
			return (
				`acceptance criteria describe a retired requirement batch (criteria rank batch ` +
				`${record.batch.digest.slice(0, 8)}, the accepted list is batch ` +
				`${formalization.batchDigest.slice(0, 8)}): resubmit stage=acceptance_criteria`
			);
		}
		return undefined;
	}

	/**
	 * FR-02/FR-03: route the skill or the model from the owner-held candidate list in the
	 * template config. The judge sees only those candidates, so it can never invent one; the
	 * selection is applied (skill recorded, model enforced at spawn). On-demand, never
	 * gate-granting, and fail-closed: a config or library problem reports uncertainty.
	 */
	private async submitRouting(input: ValidatedDecisionInput): Promise<DecisionOutcome | undefined> {
		const routing = this.template.routing;
		const candidatesConfigured =
			input.stage === "skill_routing" ? (routing?.skills?.length ?? 0) > 0 : (routing?.models?.length ?? 0) > 0;
		if (!candidatesConfigured) {
			// No candidates, no routing: say so instead of approving nothing.
			const key = input.stage === "skill_routing" ? "routing.skills" : "routing.models";
			return {
				verdict: "insufficient_evidence",
				reasons: [`${input.stage} needs candidate lists in jev.config.json (${key}); the judge may only choose from candidates the owner offered`],
				judged: false,
				summary: "",
			};
		}
		try {
			if (input.stage === "skill_routing") {
				const candidates = routing!.skills!;
				const result = await routeSkills({ task: input.task, evidence: input.evidence, candidates, judge: this.judge });
				if (result.verdict === "approve" && result.selectedOption !== undefined) {
					this.activateSkill(result.selectedOption, candidates);
				}
				return {
					verdict: result.verdict,
					selectedOption: result.selectedOption,
					reasons: result.reasons,
					confidence: result.confidence,
					judged: true,
					summary:
						result.verdict === "approve"
							? `skill_routing: approve — skill ${result.selectedOption ?? ""}`
							: `skill_routing: ${result.verdict}`,
				};
			}
			const candidates = routing!.models!;
			// No separate allowlist given: the candidate list is itself the allowlist, so the
			// judge still cannot reach a model the owner did not offer.
			const allowlist = routing!.allowlist ?? candidates.map(c => c.id);
			const result = await routeModel({ task: input.task, evidence: input.evidence, candidates, allowlist, judge: this.judge });
			if (result.verdict === "approve" && result.selected !== undefined) {
				this.rememberModelRouting(result.selected);
			}
			return {
				verdict: result.verdict,
				selectedOption: result.selected,
				reasons: result.reasons,
				confidence: result.confidence,
				judged: result.verdict !== "ask_user" || result.confidence !== undefined,
				summary:
					result.verdict === "approve"
						? `model_routing: approve — model ${result.selected ?? ""}`
						: `model_routing: ${result.verdict}`,
			};
		} catch (err) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`routing unavailable: ${err instanceof Error ? err.message : String(err)}`],
				judged: false,
				summary: "",
			};
		}
	}

	/**
	 * FR-13 part (1): record the inventory of the old functions - one item per function, each
	 * carrying the command that verifies it - BEFORE the first code edit of the task. A submission
	 * after the first edit is refused: an inventory written afterwards cannot establish what
	 * existed before the refactoring, so it can never be what the marking is made against. The
	 * recorded inventory is bound to the task and is what the completion boundary compares
	 * against. No judge is consulted - a declaration is not a question; the marking is judged.
	 */
	private submitRefactorInventory(input: ValidatedDecisionInput): DecisionOutcome {
		const items = input.inventory;
		if (items.length === 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"refactor_inventory needs `inventory`: one {id, name, verification} per old function, " +
						"each verification being the command that checks that function",
				],
				judged: false,
				summary: "",
			};
		}
		const edits = this.state.workRevision - this.state.taskStartWorkRevision;
		if (edits > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					`refactor_inventory refused: this task already has ${edits} code edit(s), so an inventory ` +
						"submitted now cannot fix what existed before the refactoring (FR-13 part 1: the inventory " +
						"exists before the first code edit). Record the inventory before the first edit.",
				],
				judged: false,
				summary: "",
			};
		}
		this.state.refactorInventory = { items, taskFingerprint: this.state.taskFingerprint, at: this.now() };
		// A re-declared inventory supersedes a marking made against the previous one.
		this.state.lastRefactorMarking = undefined;
		this.persist();
		const listed = items.map(i => `${i.id} (${i.verification})`).join("; ");
		this.pushFeedback(
			`Jev refactor_inventory fixed before the first code edit: ${items.length} item(s) — ${listed}. ` +
				"After the refactoring, submit stage=refactor_marking with each item's own artifact material; " +
				"an item without it keeps completion blocked under its id.",
		);
		return {
			verdict: "approve",
			reasons: [`inventory recorded before the first code edit: ${items.length} item(s)`],
			judged: false,
			summary:
				`refactor_inventory: ${items.length} item(s) recorded before the first code edit — ` +
				items.map(i => i.id).join(", "),
		};
	}

	/**
	 * FR-13 parts (2)+(3): mark every inventory item preserved or lost from the artifact material
	 * attached to that item. A submission whose material is a claim is refused before any judge
	 * call (a textual report is not evidence), an item the judge can only mark not_evidenced is
	 * recorded as such and keeps the completion boundary shut under that item's id, and a judge
	 * that fails, escapes the frame or answers below the floor records nothing (fail-closed).
	 */
	private async submitRefactorMarking(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		const inventory = this.currentRefactorInventory();
		if (inventory === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"refactor_marking needs an inventory recorded for the current task first: submit " +
						"stage=refactor_inventory (before the first code edit) with one {id, name, verification} " +
						"per old function",
				],
				judged: false,
				summary: "",
			};
		}
		const known = new Map(inventory.items.map(i => [i.id, i]));
		const outside = input.inventoryMarks.filter(m => !known.has(m.id)).map(m => m.id);
		if (outside.length > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`refactor_marking marks item id(s) that are not in the recorded inventory: ${outside.join(", ")}`],
				judged: false,
				summary: "",
			};
		}
		const missing = inventory.items.filter(i => !input.inventoryMarks.some(m => m.id === i.id)).map(i => i.id);
		if (missing.length > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`refactor_marking needs one marking per inventory item; no material submitted for: ${missing.join(", ")}`],
				judged: false,
				summary: "",
			};
		}
		// FR-13 part (3): the executor's own report is not evidence. The material attached to an
		// item must be an artifact - a code quote, a command output or a log excerpt.
		const claimed = input.inventoryMarks
			.filter(m => !m.evidence.some(e => COMPLETION_EVIDENCE_KINDS.has(e.kind)))
			.map(m => m.id);
		if (claimed.length > 0) {
			const reason =
				`refactor_marking: item(s) ${claimed.join(", ")} carry no artifact material ` +
				"(a code quote, a command output or a log); a textual report is not evidence (FR-13 part 3)";
			this.pushFeedback(`Jev refactor_marking refused: ${reason}`);
			return { verdict: "insufficient_evidence", reasons: [reason], judged: false, summary: "" };
		}
		if (this.refactorMarkingJudge === undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["refactor_marking judge not configured in this session"],
				judged: false,
				summary: "",
			};
		}
		const items = input.inventoryMarks.map(m => ({ ...known.get(m.id)!, evidence: m.evidence }));
		let raw: RefactorMarkingResult;
		try {
			raw = await this.refactorMarkingJudge({
				items,
				// PRD 1.1/FR-10: standing named problems and the declared answers travel with the
				// action under check, verbatim.
				currentAction: this.withOutstandingProblems(boundKey, input, input.proposal),
			});
		} catch (err) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`refactor marking judge unavailable: ${err instanceof Error ? err.message : String(err)}`],
				judged: false,
				summary: "",
			};
		}
		if (!isRecord(raw) || raw["judged"] !== true || raw["escape"] === true || !isRecord(raw["markings"])) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["refactor marking judge returned an unjudged, escaped or malformed result; nothing is recorded"],
				judged: false,
				summary: "",
			};
		}
		const markings = raw["markings"] as Record<string, string>;
		const unmarked = inventory.items.filter(i => !(i.id in markings)).map(i => i.id);
		if (unmarked.length > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`refactor marking judge did not mark: ${unmarked.join(", ")}`],
				judged: false,
				summary: "",
			};
		}
		const unknownMarking = inventory.items
			.filter(i => !(markings[i.id]! in REFACTOR_MARKING_OUTCOMES))
			.map(i => i.id);
		if (unknownMarking.length > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`refactor marking judge returned an unknown marking for: ${unknownMarking.join(", ")}`],
				judged: false,
				summary: "",
			};
		}
		const confidence = typeof raw["confidence"] === "number" ? raw["confidence"] : undefined;
		const marks: RefactorMark[] = inventory.items.map(i => ({
			id: i.id,
			outcome: markings[i.id] as RefactorMarkingOutcome,
			reasons: [`${i.name}: ${markings[i.id]}`],
		}));
		const notEvidenced = marks.filter(m => m.outcome === "not_evidenced").map(m => m.id);
		// The answer obliges (PRD 1.1/FR-10): a complete marking is the pass this stage records for
		// the completion boundary, so it is not written while a standing named problem of this stage
		// is unanswered - the refusal names the problems instead. An incomplete marking is refused by
		// name below as before (it blocks completion through the items, not through a pass).
		if (notEvidenced.length === 0) {
			const withheld = this.withheldByOutstanding(boundKey, input);
			if (withheld !== undefined) return withheld;
		}
		// A judged marking is real rework when it comes back incomplete: the budget is spent, so a
		// broken marking loop cannot run forever (same rule as the aspect_coverage preset).
		this.state.iterations[boundKey] = used + 1;
		this.state.lastRefactorMarking = {
			marks,
			taskFingerprint: this.state.taskFingerprint,
			workRevision: this.state.workRevision,
			at: this.now(),
		};
		this.persist();
		if (notEvidenced.length > 0) {
			const named = notEvidenced.join(", ");
			this.pushFeedback(
				`Jev refactor_marking: item(s) ${named} have no evidence-backed marking — attach the code quote or ` +
					"the command output for each one; completion stays blocked on those items by name.",
			);
			return {
				verdict: "revise",
				reasons: [
					`refactor marking incomplete: item(s) without evidence: ${named} ` +
						"(a claim is not evidence; attach a code quote or a command output)",
				],
				confidence,
				judged: true,
				summary: `refactor_marking: revise — not evidenced: ${named}`,
			};
		}
		const lost = marks.filter(m => m.outcome === "lost").map(m => m.id);
		this.pushFeedback(
			`Jev refactor_marking: ${marks.length} item(s) marked from their own material` +
				(lost.length > 0 ? ` — lost: ${lost.join(", ")}` : "") +
				". The marking does not block completion.",
		);
		return {
			verdict: "approve",
			reasons: ["judged"],
			confidence,
			judged: true,
			summary:
				`refactor_marking: approve — ${marks.length} item(s) marked from evidence` +
				(lost.length > 0 ? `, lost: ${lost.join(", ")}` : ""),
		};
	}

	/** The refactor inventory recorded for the CURRENT task, or undefined when none was declared. */
	private currentRefactorInventory(): RefactorInventoryRecord | undefined {
		const record = this.state.refactorInventory;
		if (record === undefined || record.taskFingerprint !== this.state.taskFingerprint) return undefined;
		return record;
	}

	/**
	 * FR-13 parts (2)+(3): an inventory recorded for the current task keeps the completion
	 * boundary shut until EVERY item carries a marking made from its own material at the current
	 * work revision. Returns the gap naming the items, or undefined when nothing is outstanding -
	 * including when no inventory was declared, so a task that is not a refactoring is unaffected.
	 */
	private refactorMarkingGap(): string | undefined {
		const inventory = this.currentRefactorInventory();
		if (inventory === undefined) return undefined;
		const ids = inventory.items.map(i => i.id);
		const record = this.state.lastRefactorMarking;
		if (record === undefined || record.taskFingerprint !== this.state.taskFingerprint) {
			return (
				`refactor inventory item(s) without a marking: ${ids.join(", ")} ` +
				"(run stage=refactor_marking with each item's own artifact material)"
			);
		}
		if (record.workRevision !== this.state.workRevision) {
			return (
				`refactor inventory item(s) marked before the latest code edit: ${ids.join(", ")} ` +
				"(that marking describes the code that existed then; run stage=refactor_marking again)"
			);
		}
		const unmarked = inventory.items
			.filter(i => {
				const mark = record.marks.find(m => m.id === i.id);
				return mark === undefined || mark.outcome === "not_evidenced";
			})
			.map(i => i.id);
		if (unmarked.length === 0) return undefined;
		return `refactor inventory item(s) without evidence: ${unmarked.join(", ")}`;
	}

	/**
	 * Fresh course_check for the completion boundary: a judged continue recorded for the
	 * current task AND the current work revision. verify_before_proceeding never unlocks;
	 * any mutation after the record makes it stale.
	 */
	private freshCourseCheck(): boolean {
		const check = this.state.lastCourseCheck;
		return (
			check !== undefined &&
			check.selectedOption === "continue" &&
			check.taskFingerprint === this.state.taskFingerprint &&
			check.workRevision === this.state.workRevision
		);
	}

	// ----- activities framework: the automatic course check (development) -----

	/**
	 * Periodic course check (owner switch `courseCheck.everyMutations`, default off). The controller
	 * consults the course-check judge itself after the N-th allowed mutation, so a session can ask
	 * "am I still on the plan?" without the executor choosing to. The consult is served by the
	 * mutation's OWN successful result (see onMutatingResult): it judges what the mutation produced,
	 * not the intention to make it. Nothing is captured while the switch is off.
	 */
	private recordPendingMutation(event: Record<string, unknown>, toolName: string): void {
		const every = this.template.courseCheck?.everyMutations ?? 0;
		if (every <= 0) return;
		const revision = this.state.workRevision;
		if (revision <= 0 || revision % every !== 0) return;
		this.pruneStaleMutations();
		const toolCallId = typeof event["toolCallId"] === "string" ? event["toolCallId"] : "";
		this.state.pendingMutations[toolCallId] = { revision, toolName, at: this.now() };
	}

	/**
	 * Drop awaited mutating calls whose result never arrived (session abort, an outcome the host
	 * surfaces another way): the entry would otherwise linger for the rest of the session.
	 */
	private pruneStaleMutations(): void {
		const cutoff = this.now() - PENDING_MUTATION_MAX_AGE_MS;
		for (const [key, entry] of Object.entries(this.state.pendingMutations)) {
			if (entry.at < cutoff) delete this.state.pendingMutations[key];
		}
	}

	/**
	 * Queue the consult for one consumed mutating result. It runs in the BACKGROUND (measured
	 * judge latency reaches 33s against a resetting endpoint, so it must never hold a turn) and
	 * stays advisory: no block, no gate approval, no rework budget. Chained so consults stay
	 * ordered and at most one is in flight at a time.
	 */
	private scheduleAutomaticCourseCheck(revision: number, toolName: string, resultText: string): void {
		const chain = this.autoCourseCheck ?? Promise.resolve();
		this.autoCourseCheck = chain
			.then(() => this.runAutomaticCourseCheck(revision, toolName, resultText))
			.catch(() => {});
	}

	/** Await the in-flight automatic course-check chain (test seam; the tool path never waits). */
	async automaticCourseChecksSettled(): Promise<void> {
		await this.autoCourseCheck?.catch(() => {});
	}

	/**
	 * The requirements an automatic course check runs against: the accepted formalized list of
	 * the current task when one exists, each item's own number AND the verbatim source quote it
	 * names (FR-19 keeps the quote beside every item), else the captured task prompt as the single
	 * requirement (id "task"). Empty when neither exists - recorded as uncertainty, never invented.
	 */
	private courseCheckRequirements(): Array<{ id: string; quote: string }> {
		const formalization = this.currentFormalization();
		if (formalization !== undefined && formalization.requirements.length > 0) {
			return formalization.requirements.map(r => ({ id: r.id, quote: r.quote }));
		}
		const task = this.state.taskPrompt;
		return task !== undefined ? [{ id: "task", quote: mechanism.cappedQuote(task).quote }] : [];
	}

	/**
	 * One automatic consultation, run on the mutation's own result. Never throws and never blocks:
	 * a missing requirement, a result with no text to judge, an unwired judge, a judge error, an
	 * unusable answer or a sub-floor confidence is RECORDED as uncertainty and pushed as feedback;
	 * a confident redirect or escalation is pushed back into the same session (ask_user additionally
	 * as a recorded blocker). Nothing here records a gate approval or satisfies the completion
	 * boundary - that still needs a deliberate course_check with option continue bound to the
	 * current revision. The consult's evidence is the mutation's own text result, never the raw
	 * event (no `details`, no JSON dump) and never fabricated progress.
	 */
	private async runAutomaticCourseCheck(revision: number, toolName: string, resultText: string): Promise<void> {
		const requirements = this.courseCheckRequirements();
		const base: AutoCourseCheckRecord = { judged: false, reasons: [], workRevision: revision, at: this.now() };
		if (requirements.length === 0) {
			this.recordAutomaticCourseCheck({ ...base, reasons: ["no requirement captured for this task yet"] }, "no requirement to check against");
			return;
		}
		if (resultText.length === 0) {
			// An empty or non-text result (images only) carries nothing to judge: recorded as
			// uncertainty, never as fabricated progress.
			const note = `the ${toolName} tool result carried no text to judge`;
			this.recordAutomaticCourseCheck({ ...base, reasons: [note] }, note);
			return;
		}
		if (this.courseCheckJudge === undefined) {
			this.recordAutomaticCourseCheck({ ...base, reasons: ["course_check judge not configured in this session"] }, "judge not wired");
			return;
		}
		const evidence: Evidence[] = [
			mechanism.gateEvidence("execution", `${toolName} mutation result (after execution)`, resultText),
		];
		if (this.state.taskPrompt !== undefined) {
			evidence.push(mechanism.gateEvidence("user", "session task prompt (the requirement)", this.state.taskPrompt));
		}
		for (const r of requirements) evidence.push(mechanism.gateEvidence("spec", `requirement ${r.id}`, r.quote));
		let raw: CourseCheckResult;
		try {
			raw = await this.courseCheckJudge({
				requirements,
				currentAction:
					`automatic course check of the ${toolName} mutation at work revision ${revision}: ` +
					"the mutation's own result is quoted in the evidence",
				evidence,
			});
		} catch (err) {
			this.recordAutomaticCourseCheck(
				{ ...base, reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`] },
				"judge unavailable",
			);
			return;
		}
		const read = readCourseCheckAnswer(raw, requirements, this.completionConfidenceFloor);
		if (read.kind === "unjudged") {
			// The judge could not be consulted, or its body carried nothing usable: not judged.
			this.recordAutomaticCourseCheck({ ...base, reasons: [read.detail] }, read.detail);
			return;
		}
		if (read.kind === "uncertain") {
			// F3: the judge DID answer - only its confidence (or the answer's own inconsistency)
			// kept that answer from being acted on. That is recorded uncertainty, never a
			// "not judged" message: the record keeps the answer, the confidence and the reasons.
			this.state.lastAutoCourseCheck = {
				judged: true,
				selectedOption: read.nextAction,
				confidence: read.confidence,
				reasons: [...read.reasons, read.detail],
				belowFloor: read.belowFloor,
				workRevision: revision,
				at: this.now(),
			};
			this.persist();
			const what = read.belowFloor
				? `the judge answered ${read.nextAction ?? "nothing usable"} at confidence ` +
					`${read.confidence ?? "unknown"}, below the floor ${this.completionConfidenceFloor}`
				: `the judge's answer${read.nextAction === undefined ? "" : ` (${read.nextAction})`} cannot be acted on`;
			const why = read.reasons.length > 0 ? ` ${read.reasons.join(" ")}` : "";
			this.pushFeedback(
				`Jev automatic course_check after ${revision} mutation(s): recorded uncertainty — ${what}; no ` +
					`action is taken from it and nothing is blocked.${why}`,
			);
			return;
		}
		const record: AutoCourseCheckRecord = {
			judged: true,
			selectedOption: read.nextAction,
			confidence: read.confidence,
			reasons: read.reasons,
			workRevision: revision,
			at: this.now(),
		};
		if (read.nextAction === "ask_user") {
			// Judge-chosen escalation: a recorded blocker, exactly like the deliberate path.
			const blocker = `automatic course_check escalated to the user (ask_user at work revision ${revision}).`;
			if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
			record.reasons = [...record.reasons, blocker];
		}
		this.state.lastAutoCourseCheck = record;
		this.persist();
		const drifted = read.drifted.length > 0 ? ` (drifted: ${read.drifted.join(", ")})` : "";
		const why = read.reasons.length > 0 ? ` ${read.reasons.join(" ")}` : "";
		switch (read.nextAction) {
			case "continue":
				this.pushFeedback(
					`Jev automatic course_check after ${revision} mutation(s): continue — on track for ` +
						`${requirements.length} requirement(s). The work proceeds.`,
				);
				break;
			case "verify_before_proceeding":
				this.pushFeedback(
					`Jev automatic course_check after ${revision} mutation(s): verify_before_proceeding — gather ` +
						"evidence before proceeding; this record does not satisfy the completion boundary." + why,
				);
				break;
			case "ask_user":
				this.pushFeedback(`Jev automatic course_check after ${revision} mutation(s): ${record.reasons.join(" ")}`);
				break;
			default:
				// return_to_requirement | replan: the remark goes back into the same session.
				this.pushFeedback(
					`Jev automatic course_check after ${revision} mutation(s): ${read.nextAction}${drifted}` +
						`${why} — return to the quoted requirement before continuing.`,
				);
		}
	}

	/** Uncertainty from an automatic consult: recorded and surfaced, never a block (fail-open). */
	private recordAutomaticCourseCheck(record: AutoCourseCheckRecord, note: string): void {
		this.state.lastAutoCourseCheck = record;
		this.persist();
		this.pushFeedback(`Jev automatic course_check not judged: ${note}. The work proceeds; nothing is blocked.`);
	}

	private unmetStopGates(): string[] {
		// Fail-closed config (R5): corrupted template keeps every gate shut, regardless of
		// restored approvals - they were granted under defaults that no longer validate.
		if (this.templateError !== undefined) {
			return [`jev config invalid (fail-closed): ${this.templateError}`];
		}
		// User-owned switch: `gates.completion === false` lifts the stop gate entirely
		// (completion approval, fresh course_check, aspect teeth). Judging is untouched.
		if (this.template.gates?.completion === false) return [];
		// Once a task fingerprint exists the completion boundary applies to read-only work
		// exactly like mutated work; a session with no established task stops free.
		if (this.state.taskFingerprint === undefined) return [];
		const missing: string[] = [];
		if (this.template.gates?.mutation !== false && this.planApproval() === undefined) {
			missing.push("no plan-stage approval (understanding_review or direction_review) for the current task");
		}
		// Activities framework (planning): a formalized requirement with no supported plan claim
		// leaves planning incomplete, so the plan requirement is not met either. Demanded only
		// while the plan gate is armed - gates.mutation: false drops it with the gate.
		if (this.template.gates?.mutation !== false) {
			const planningGap = this.planningGap();
			if (planningGap !== undefined) missing.push(planningGap);
		}
		// FR-20: a criterion the judge did not accept, or criteria formalized from a retired
		// batch, keeps the completion boundary shut by name - completion is by the acceptance
		// criteria (PRD 18 step 7), so an unaccepted criterion is what it must not complete through.
		const criteriaGap = this.criteriaGap();
		if (criteriaGap !== undefined) missing.push(criteriaGap);
		// Latest approval wins: supersede keeps same-digest records, so the freshest
		// completion_review must be consulted, not the first.
		const stopStage = this.approvalBoundary().stopStage;
		let completion: ApprovalRecord | undefined;
		for (const a of this.state.approvals) {
			if (a.stage === stopStage) completion = a;
		}
		if (completion === undefined) {
			missing.push("no completion_review approval at all");
		} else if (completion.taskFingerprint !== this.state.taskFingerprint) {
			// Strict comparison: an approval from before any fingerprint was set must NOT
			// pass once a new task establishes a fingerprint (AC5).
			missing.push(
				`completion_review approval is stale: the user task changed since it was granted ` +
					`(approved ${completion.taskFingerprint}, now ${this.state.taskFingerprint ?? "unknown"})`,
			);
		} else if (completion.workRevision !== this.state.workRevision) {
			missing.push(
				`completion_review approval is stale: work revision ${this.state.workRevision} > approved ${completion.workRevision}`,
			);
		}
		if (!this.freshCourseCheck()) {
			missing.push(
				"no fresh course_check pass: a judged course_check with option continue must be recorded " +
					"for the current task and work revision (run it at the task/plan boundary, after every " +
					"work mutation and before completion; verify_before_proceeding never unlocks)",
			);
		}
		// PRD 1.1/FR-10: a later refusal of the stop stage is not covered by an older completion
		// approval - the boundary names the problems the judge asked to answer instead of closing.
		const standingAtStop = this.outstandingReworkFor(`${this.state.taskFingerprint}:${stopStage}`);
		if (standingAtStop !== undefined) {
			missing.push(
				`${stopStage} carries ${standingAtStop.problems.length} named problem(s) from a refusal of the ` +
					`judge: ${standingAtStop.problems.join(" | ")} - completion is not claimed while they stand`,
			);
		}
		// aspect_coverage teeth: an open drift for the CURRENT task blocks completion until
		// a fresh aspect_coverage submission clears it (advisory preset, no own stop gate).
		const gaps = this.state.openAspectGaps;
		if (gaps !== undefined && gaps.taskFingerprint === this.state.taskFingerprint && gaps.missed.length > 0) {
			missing.push(`aspects not addressed: ${gaps.missed.join(", ")}`);
		}
		// FR-13 teeth: an inventory recorded for the current task keeps the boundary shut until
		// every item carries a marking made from its own material at the current work revision,
		// and the message names the item ids.
		const refactorGap = this.refactorMarkingGap();
		if (refactorGap !== undefined) missing.push(refactorGap);
		return missing;
	}

	/** Same-session feedback via the host's real message injection (AC7). */
	private pushFeedback(text: string): void {
		this.pi?.sendMessage(
			{ customType: "jev-feedback", content: text, display: true },
			{ deliverAs: "aside", triggerTurn: false },
		);
	}

	private persist(): void {
		this.pi?.appendEntry(STATE_ENTRY_TYPE, this.state);
	}
}

/** Validate persisted submission digests; malformed entries simply grant a fresh budget. */
function restoreDigests(raw: unknown): Record<string, string> {
	if (!isRecord(raw)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" && value.length > 0) out[key] = value;
	}
	return out;
}

/**
 * Validate a persisted rework journal: malformed entries are dropped (a corrupt approach list would
 * otherwise refuse honest work or hide the state of the loop), and a journal for a stage with no
 * attempt is dropped whole.
 */
function restoreReworkJournal(raw: unknown): Record<string, ReworkJournal> {
	if (!isRecord(raw)) return {};
	const out: Record<string, ReworkJournal> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!isRecord(value) || typeof value["stage"] !== "string") continue;
		const attempts: ReworkAttempt[] = Array.isArray(value["attempts"])
			? value["attempts"].flatMap((a: unknown): ReworkAttempt[] => {
					if (!isRecord(a)) return [];
					if (typeof a["approach"] !== "string" || a["approach"].trim().length === 0) return [];
					if (typeof a["verdict"] !== "string" || !VERDICTS.has(a["verdict"])) return [];
					return [
						{
							// Numbering is positional: the journal is an ordered list of attempts.
							attempt: 0,
							approach: a["approach"],
							verdict: a["verdict"] as DecisionVerdict,
							reasons: Array.isArray(a["reasons"])
								? a["reasons"].filter((r): r is string => typeof r === "string")
								: [],
							...(typeof a["confidence"] === "number" ? { confidence: a["confidence"] } : {}),
							at: typeof a["at"] === "number" ? a["at"] : 0,
						},
					];
				})
			: [];
		if (attempts.length === 0) continue;
		out[key] = {
			taskFingerprint: typeof value["taskFingerprint"] === "string" ? value["taskFingerprint"] : undefined,
			stage: value["stage"],
			attempts: attempts.map((a, i) => ({ ...a, attempt: i + 1 })),
			open: value["open"] === true,
			at: typeof value["at"] === "number" ? value["at"] : 0,
		};
	}
	return out;
}

/**
 * Validate persisted standing problems: a malformed record is dropped whole (it would otherwise
 * withhold honest work or assert a refusal that was never judged), and a record without a problem
 * is dropped too - there is nothing to answer in it.
 */
function restoreOutstandingRework(raw: unknown): Record<string, OutstandingRework> {
	if (!isRecord(raw)) return {};
	const out: Record<string, OutstandingRework> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!isRecord(value) || typeof value["stage"] !== "string") continue;
		const problems = Array.isArray(value["problems"])
			? value["problems"].filter((p): p is string => typeof p === "string" && p.trim().length > 0)
			: [];
		if (problems.length === 0) continue;
		out[key] = {
			stage: value["stage"],
			taskFingerprint: typeof value["taskFingerprint"] === "string" ? value["taskFingerprint"] : undefined,
			problems,
			refusals: typeof value["refusals"] === "number" && Number.isFinite(value["refusals"]) ? value["refusals"] : 1,
			at: typeof value["at"] === "number" ? value["at"] : 0,
		};
	}
	return out;
}

/** Validate persisted aspect gaps (D1): a restart must not bypass completion teeth. */
function restoreAspectGaps(raw: unknown): { missed: string[]; taskFingerprint: string | undefined } | undefined {
	if (!isRecord(raw)) return undefined;
	const missed = Array.isArray(raw["missed"]) ? raw["missed"].filter((m): m is string => typeof m === "string") : [];
	if (missed.length === 0) return undefined;
	return {
		missed,
		taskFingerprint: typeof raw["taskFingerprint"] === "string" ? raw["taskFingerprint"] : undefined,
	};
}

/**
 * Validate a persisted refactor inventory: every item must carry a non-empty id, name and
 * verification command and ids must be unique; a malformed record is dropped whole (it would
 * otherwise name items the marking could never match, or gate completion on garbage).
 */
function restoreRefactorInventory(raw: unknown): RefactorInventoryRecord | undefined {
	if (!isRecord(raw) || !Array.isArray(raw["items"])) return undefined;
	const items: RefactorInventoryItem[] = [];
	const seen = new Set<string>();
	for (const item of raw["items"]) {
		if (!isRecord(item)) return undefined;
		const { id, name, verification } = item;
		if (typeof id !== "string" || id.trim().length === 0) return undefined;
		if (typeof name !== "string" || name.trim().length === 0) return undefined;
		if (typeof verification !== "string" || verification.trim().length === 0) return undefined;
		if (seen.has(id)) return undefined;
		seen.add(id);
		items.push({ id, name, verification });
	}
	if (items.length === 0) return undefined;
	return {
		items,
		taskFingerprint: typeof raw["taskFingerprint"] === "string" ? raw["taskFingerprint"] : undefined,
		at: typeof raw["at"] === "number" && Number.isFinite(raw["at"]) ? raw["at"] : 0,
	};
}

/** Validate a persisted refactor marking: a malformed mark is dropped, never trusted as evidence. */
function restoreRefactorMarking(raw: unknown): RefactorMarkingRecord | undefined {
	if (!isRecord(raw) || !Array.isArray(raw["marks"])) return undefined;
	if (typeof raw["workRevision"] !== "number" || !Number.isFinite(raw["workRevision"])) return undefined;
	const marks: RefactorMark[] = [];
	for (const mark of raw["marks"]) {
		if (!isRecord(mark)) continue;
		const id = mark["id"];
		const outcome = mark["outcome"];
		if (typeof id !== "string" || id.length === 0) continue;
		if (outcome !== "preserved" && outcome !== "lost" && outcome !== "not_evidenced") continue;
		marks.push({
			id,
			outcome,
			reasons: Array.isArray(mark["reasons"])
				? mark["reasons"].filter((r): r is string => typeof r === "string")
				: [],
		});
	}
	if (marks.length === 0) return undefined;
	return {
		marks,
		taskFingerprint: typeof raw["taskFingerprint"] === "string" ? raw["taskFingerprint"] : undefined,
		workRevision: raw["workRevision"],
		at: typeof raw["at"] === "number" && Number.isFinite(raw["at"]) ? raw["at"] : 0,
	};
}

/** Validate a persisted course-check record: malformed entries never unlock a boundary. */
function restoreCourseCheck(raw: unknown): JevState["lastCourseCheck"] {
	if (!isRecord(raw) || typeof raw["selectedOption"] !== "string") return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	if (typeof raw["workRevision"] !== "number" || !Number.isFinite(raw["workRevision"])) return undefined;
	return {
		selectedOption: raw["selectedOption"],
		at: raw["at"],
		taskFingerprint: typeof raw["taskFingerprint"] === "string" ? raw["taskFingerprint"] : undefined,
		workRevision: raw["workRevision"],
	};
}

/** Validate a persisted claim-check marking: malformed entries are dropped, never trusted. */
function restoreClaimCheck(raw: unknown): JevState["lastClaimCheck"] {
	if (!isRecord(raw) || !Array.isArray(raw["claims"])) return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	if (typeof raw["workRevision"] !== "number" || !Number.isFinite(raw["workRevision"])) return undefined;
	const claims: ClaimCheckMarking[] = [];
	for (const c of raw["claims"]) {
		if (!isRecord(c) || !nonEmptyString(c["id"]) || typeof c["text"] !== "string" || typeof c["supported"] !== "boolean") {
			return undefined;
		}
		claims.push({ id: c["id"], text: c["text"], supported: c["supported"] });
	}
	if (claims.length === 0) return undefined;
	return {
		claims,
		at: raw["at"],
		taskFingerprint: typeof raw["taskFingerprint"] === "string" ? raw["taskFingerprint"] : undefined,
		workRevision: raw["workRevision"],
	};
}

/** Validate a persisted formalization: malformed entries are dropped, never used as a checklist. */
function restoreFormalization(raw: unknown): FormalizationRecord | undefined {
	if (!isRecord(raw) || !Array.isArray(raw["requirements"])) return undefined;
	if (typeof raw["complete"] !== "boolean" || typeof raw["outcome"] !== "string") return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	if (typeof raw["workRevision"] !== "number" || !Number.isFinite(raw["workRevision"])) return undefined;
	const requirements: FormalizedRequirement[] = [];
	for (const entry of raw["requirements"]) {
		if (!isRecord(entry) || !nonEmptyString(entry["id"]) || typeof entry["text"] !== "string") return undefined;
		if (typeof entry["traceable"] !== "boolean") return undefined;
		// FR-19: an item without its number and its verbatim quote is not the record the row
		// describes, so a malformed one is dropped rather than restored as a checklist.
		if (!nonEmptyString(entry["quoteId"]) || typeof entry["quote"] !== "string" || entry["quote"].length === 0) {
			return undefined;
		}
		requirements.push({
			id: entry["id"],
			text: entry["text"],
			quoteId: entry["quoteId"],
			quote: entry["quote"],
			traceable: entry["traceable"],
		});
	}
	if (requirements.length === 0) return undefined;
	const uncovered: FormalizationRecord["uncovered"] = [];
	if (Array.isArray(raw["uncovered"])) {
		for (const entry of raw["uncovered"]) {
			if (!isRecord(entry) || !nonEmptyString(entry["id"]) || typeof entry["source"] !== "string") return undefined;
			uncovered.push({
				id: entry["id"],
				source: entry["source"],
				excerpt: typeof entry["excerpt"] === "string" ? entry["excerpt"] : "",
			});
		}
	}
	// FR-21: without its batch identity a list cannot be compared against a recorded order, and an
	// unidentifiable checklist is dropped rather than trusted.
	if (!nonEmptyString(raw["batchDigest"])) return undefined;
	return {
		requirements,
		uncovered,
		outcome: raw["outcome"],
		// A restored list is a checklist only if it was complete AND every item is traceable.
		complete: raw["complete"] === true && requirements.every(r => r.traceable),
		batchDigest: raw["batchDigest"],
		at: raw["at"],
		taskFingerprint: typeof raw["taskFingerprint"] === "string" ? raw["taskFingerprint"] : undefined,
		workRevision: raw["workRevision"],
	};
}

/** Validate a persisted plan mapping: malformed entries are dropped, never counted as complete. */
function restorePlanMapping(raw: unknown): PlanMappingRecord | undefined {
	if (!isRecord(raw) || !Array.isArray(raw["requirements"]) || !Array.isArray(raw["missing"])) return undefined;
	if (typeof raw["complete"] !== "boolean") return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	if (typeof raw["workRevision"] !== "number" || !Number.isFinite(raw["workRevision"])) return undefined;
	const requirements: PlanMappingRecord["requirements"] = [];
	for (const entry of raw["requirements"]) {
		if (!isRecord(entry) || !nonEmptyString(entry["id"]) || typeof entry["claim"] !== "string") return undefined;
		if (typeof entry["supported"] !== "boolean") return undefined;
		requirements.push({ id: entry["id"], claim: entry["claim"], supported: entry["supported"] });
	}
	const missing = raw["missing"].filter((id): id is string => typeof id === "string");
	return {
		requirements,
		missing,
		// A restored mapping is complete only if it still says so AND nothing is missing.
		complete: raw["complete"] === true && missing.length === 0 && requirements.every(r => r.supported),
		at: raw["at"],
		taskFingerprint: typeof raw["taskFingerprint"] === "string" ? raw["taskFingerprint"] : undefined,
		workRevision: raw["workRevision"],
	};
}

/** Validate a persisted automatic course-check record: malformed entries are dropped. */
function restoreAutoCourseCheck(raw: unknown): AutoCourseCheckRecord | undefined {
	if (!isRecord(raw) || typeof raw["judged"] !== "boolean") return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	if (typeof raw["workRevision"] !== "number" || !Number.isFinite(raw["workRevision"])) return undefined;
	if (raw["selectedOption"] !== undefined && typeof raw["selectedOption"] !== "string") return undefined;
	if (raw["confidence"] !== undefined && typeof raw["confidence"] !== "number") return undefined;
	if (raw["belowFloor"] !== undefined && typeof raw["belowFloor"] !== "boolean") return undefined;
	return {
		judged: raw["judged"],
		selectedOption: typeof raw["selectedOption"] === "string" ? raw["selectedOption"] : undefined,
		confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
		reasons: Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : [],
		belowFloor: raw["belowFloor"] === true,
		workRevision: raw["workRevision"],
		at: raw["at"],
	};
}

/** Identity of an accepted batch as persisted: the digest must be present to compare anything. */
function restoreBatch(raw: unknown): AcceptedBatch | undefined {
	if (!isRecord(raw)) return undefined;
	if (!nonEmptyString(raw["digest"])) return undefined;
	if (raw["taskFingerprint"] !== undefined && typeof raw["taskFingerprint"] !== "string") return undefined;
	return {
		taskFingerprint: typeof raw["taskFingerprint"] === "string" ? raw["taskFingerprint"] : undefined,
		digest: raw["digest"],
	};
}

/** Validate a persisted acceptance-criteria record (FR-20): malformed entries are dropped. */
function restoreAcceptanceCriteria(raw: unknown): AcceptanceCriteriaRecord | undefined {
	if (!isRecord(raw) || !Array.isArray(raw["criteria"]) || !Array.isArray(raw["unaccepted"])) return undefined;
	if (typeof raw["complete"] !== "boolean") return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	if (typeof raw["workRevision"] !== "number" || !Number.isFinite(raw["workRevision"])) return undefined;
	const batch = restoreBatch(raw["batch"]);
	if (batch === undefined) return undefined;
	const criteria: AcceptanceCriterion[] = [];
	for (const entry of raw["criteria"]) {
		if (!isRecord(entry) || !nonEmptyString(entry["id"]) || !nonEmptyString(entry["requirementId"])) return undefined;
		if (typeof entry["text"] !== "string") return undefined;
		if (typeof entry["requirementQuote"] !== "string") return undefined;
		if (typeof entry["marked"] !== "boolean") return undefined;
		criteria.push({
			id: entry["id"],
			requirementId: entry["requirementId"],
			text: entry["text"],
			requirementQuote: entry["requirementQuote"],
			marked: entry["marked"],
		});
	}
	if (criteria.length === 0) return undefined;
	const unaccepted = raw["unaccepted"].filter((id): id is string => typeof id === "string");
	return {
		criteria,
		unaccepted: unaccepted.length > 0 ? unaccepted : criteria.filter(c => !c.marked).map(c => c.id),
		// A restored record is accepted only if it still says so AND every criterion carries its mark.
		complete: raw["complete"] === true && criteria.every(c => c.marked),
		batch,
		at: raw["at"],
		workRevision: raw["workRevision"],
	};
}

/** Validate a persisted priority order (FR-21): malformed entries are dropped, never a half order. */
function restorePriorities(raw: unknown): PriorityRecord | undefined {
	if (!isRecord(raw) || !Array.isArray(raw["items"])) return undefined;
	if (typeof raw["stale"] !== "boolean") return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	const batch = restoreBatch(raw["batch"]);
	if (batch === undefined) return undefined;
	const items: PriorityOrderItem[] = [];
	for (const entry of raw["items"]) {
		if (!isRecord(entry) || !nonEmptyString(entry["requirementId"])) return undefined;
		if (typeof entry["rank"] !== "number" || !Number.isFinite(entry["rank"])) return undefined;
		if (typeof entry["text"] !== "string" || typeof entry["quote"] !== "string" || entry["quote"].length === 0) {
			return undefined;
		}
		const priorityClass = entry["priorityClass"];
		if (typeof priorityClass !== "string" || !(PRIORITY_CLASSES as readonly string[]).includes(priorityClass)) {
			return undefined;
		}
		items.push({
			requirementId: entry["requirementId"],
			rank: entry["rank"],
			text: entry["text"],
			quote: entry["quote"],
			priorityClass: priorityClass as PriorityClass,
			confidence: typeof entry["confidence"] === "number" ? entry["confidence"] : undefined,
		});
	}
	if (items.length === 0) return undefined;
	// FR-21 naming is a recorded finding, so it survives with the record; a malformed one is dropped.
	const rawOutOfOrder = raw["outOfOrder"];
	const outOfOrder =
		isRecord(rawOutOfOrder) && nonEmptyString(rawOutOfOrder["started"]) && nonEmptyString(rawOutOfOrder["expectedFirst"])
			? { started: rawOutOfOrder["started"] as string, expectedFirst: rawOutOfOrder["expectedFirst"] as string }
			: undefined;
	return {
		items: items.sort((a, b) => a.rank - b.rank),
		batch,
		stale: raw["stale"],
		staleReason: typeof raw["staleReason"] === "string" ? raw["staleReason"] : undefined,
		supersedes: restoreBatch(raw["supersedes"]),
		outOfOrder,
		at: raw["at"],
	};
}

function extraPointsFromTemplate(template: JevTemplateConfig): ReadonlyMap<string, ControlPoint> {
	const out = new Map<string, ControlPoint>();
	const declared = template.controlPoints;
	if (declared === undefined) return out;
	for (const [stage, value] of Object.entries(declared)) {
		try {
			out.set(stage, validateDeclaredControlPoint(stage, value));
		} catch {
			// Invalid declarations are caught at config load; skip here (fail-closed already ran).
		}
	}
	return out;
}

/**
 * Validate a persisted hand-off record: the shared gate fields come from the mechanism's validator
 * (src/gates.ts), the phase is this record's own field, and a malformed entry is dropped outright.
 */
function restoreHandoffRecord(raw: unknown): HandoffRecord | undefined {
	const base = mechanism.restoreGateRecordFields(raw);
	if (base === undefined || !isRecord(raw)) return undefined;
	if (raw["phase"] !== "dispatch" && raw["phase"] !== "acceptance") return undefined;
	return { phase: raw["phase"], ...base };
}

/** Validate a persisted destructive-action record: shared fields + the trigger, the subject and the text. */
function restoreDestructiveRecord(raw: unknown): DestructiveRecord | undefined {
	const base = mechanism.restoreGateRecordFields(raw);
	if (base === undefined || !isRecord(raw)) return undefined;
	if (!nonEmptyString(raw["pattern"]) || typeof raw["command"] !== "string") return undefined;
	const trigger = raw["trigger"];
	if (trigger !== undefined && trigger !== "command" && trigger !== "outsideProjectWrite") return undefined;
	return {
		trigger: trigger as DestructiveTrigger | undefined,
		pattern: raw["pattern"],
		command: raw["command"],
		...base,
	};
}

/**
 * Validate the persisted reviews: every entry must be a review record that validates, keyed by a
 * review stage. A malformed entry is dropped rather than trusted as a result - a restart must not
 * resurrect a review that never happened, and one bad entry must not discard the others.
 */
function restoreReviews(raw: unknown): Partial<Record<ReviewId, ReviewRecord>> {
	const out: Partial<Record<ReviewId, ReviewRecord>> = {};
	if (!isRecord(raw)) return out;
	for (const [stage, value] of Object.entries(raw)) {
		if (!isReviewStage(stage)) continue;
		if (!isRecord(value) || value["stage"] !== stage || typeof value["judged"] !== "boolean") continue;
		if (typeof value["at"] !== "number" || !Number.isFinite(value["at"])) continue;
		if (typeof value["workRevision"] !== "number" || !Number.isFinite(value["workRevision"])) continue;
		const scores: ReviewRecord["scores"] = [];
		if (!Array.isArray(value["scores"]) || !validScores(value["scores"], scores)) continue;
		const items: ReviewRecord["items"] = [];
		if (!Array.isArray(value["items"]) || !validReviewItems(value["items"], items)) continue;
		const findings = Array.isArray(value["findings"])
			? value["findings"].filter((f): f is string => typeof f === "string")
			: undefined;
		if (findings === undefined) continue;
		const reasons = Array.isArray(value["reasons"])
			? value["reasons"].filter((r): r is string => typeof r === "string")
			: undefined;
		if (reasons === undefined) continue;
		const choice = restoreReviewChoice(value["choice"]);
		if (value["choice"] !== undefined && choice === undefined) continue;
		out[stage] = {
			review: stage,
			stage,
			judged: value["judged"],
			scores,
			...(choice !== undefined ? { choice } : {}),
			items,
			findings,
			reasons,
			at: value["at"],
			taskFingerprint: typeof value["taskFingerprint"] === "string" ? value["taskFingerprint"] : undefined,
			workRevision: value["workRevision"],
		};
	}
	return out;
}

/** Validate the recorded scores in place; false when any entry is malformed. */
function validScores(raw: unknown[], out: ReviewRecord["scores"]): boolean {
	for (const entry of raw) {
		if (!isRecord(entry) || !nonEmptyString(entry["questionId"])) return false;
		if (typeof entry["score"] !== "number" || !Number.isFinite(entry["score"])) return false;
		if (entry["confidence"] !== undefined && typeof entry["confidence"] !== "number") return false;
		out.push({
			questionId: entry["questionId"],
			score: entry["score"],
			...(typeof entry["confidence"] === "number" ? { confidence: entry["confidence"] } : {}),
		});
	}
	return true;
}

/** Validate the recorded statement verdicts in place; false when any entry is malformed. */
function validReviewItems(raw: unknown[], out: ReviewRecord["items"]): boolean {
	for (const entry of raw) {
		if (!isRecord(entry) || !nonEmptyString(entry["questionId"]) || typeof entry["item"] !== "string") return false;
		if (typeof entry["verdict"] !== "boolean" || typeof entry["finding"] !== "boolean") return false;
		if (typeof entry["noul"] !== "number" || !Number.isFinite(entry["noul"])) return false;
		if (entry["confidence"] !== undefined && typeof entry["confidence"] !== "number") return false;
		out.push({
			questionId: entry["questionId"],
			item: entry["item"],
			verdict: entry["verdict"],
			noul: entry["noul"],
			...(typeof entry["confidence"] === "number" ? { confidence: entry["confidence"] } : {}),
			finding: entry["finding"],
		});
	}
	return true;
}

/** Validate a recorded choice; undefined when the value is present but malformed. */
function restoreReviewChoice(raw: unknown): ReviewRecord["choice"] {
	if (raw === undefined) return undefined;
	if (!isRecord(raw) || !nonEmptyString(raw["questionId"]) || !nonEmptyString(raw["optionId"]) || !nonEmptyString(raw["label"])) {
		return undefined;
	}
	return {
		questionId: raw["questionId"],
		optionId: raw["optionId"],
		label: raw["label"],
		...(typeof raw["confidence"] === "number" ? { confidence: raw["confidence"] } : {}),
	};
}

/**
 * Work-order text of a `task` tool call, verbatim: the flat `task`, the batch `tasks[].task`
 * items and the shared `context` (omp 18.6.3 task/agent contract).
 */
function taskWorkOrder(raw: unknown): string | undefined {
	if (!isRecord(raw)) return undefined;
	const parts: string[] = [];
	if (nonEmptyString(raw["task"])) parts.push(raw["task"].trim());
	const batch = raw["tasks"];
	if (Array.isArray(batch)) {
		for (const item of batch) {
			if (isRecord(item) && nonEmptyString(item["task"])) parts.push(item["task"].trim());
		}
	}
	if (nonEmptyString(raw["context"])) parts.push(raw["context"].trim());
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Text blocks of a delivered custom message, in order (image and other blocks carry no text to
 * judge). The host builds an `async-result` delivery with either a plain string or content blocks,
 * so both shapes are read; a message with no text yields "" and is recorded as uncertainty.
 */
function messageText(message: Record<string, unknown>): string {
	const content = message["content"];
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is Record<string, unknown> => isRecord(b) && b["type"] === "text" && nonEmptyString(b["text"]))
		.map(b => (b["text"] as string).trim())
		.filter(text => text.length > 0)
		.join("\n");
}

/** Claim text in a fixed-template line: the caller's own words, whitespace-joined and capped. */
function claimExcerpt(text: string): string {
	const flat = text.trim().replace(/\s+/g, " ");
	return flat.length > CLAIM_EXCERPT_CHARS ? `${flat.slice(0, CLAIM_EXCERPT_CHARS)}…` : flat;
}

/**
 * The quoted source texts a formalized requirement list must be traceable to and cover: the
 * user/spec evidence items, de-duplicated by quote (first wins, so the id order mirrors the
 * submission) and capped verbatim. The judge sees one `quote-N` question per entry.
 */
function requirementQuotes(evidence: Evidence[]): Array<{ id: string; text: string; source: string }> {
	const out: Array<{ id: string; text: string; source: string }> = [];
	const seen = new Set<string>();
	for (const item of evidence) {
		if (item.kind !== "user" && item.kind !== "spec") continue;
		const { quote } = mechanism.cappedQuote(item.quote);
		if (seen.has(quote)) continue;
		seen.add(quote);
		out.push({ id: `quote-${out.length + 1}`, text: quote, source: item.source });
	}
	return out;
}

/**
 * The three readings of a course-check answer, independent of the deliberate submission path on
 * purpose: the automatic consult is advisory, and a refactor of submitted course checks must never
 * give it teeth. Same rules, same conservative reading, but the three cases are kept apart (F3):
 *  - "unjudged": the judge could not be consulted, or the body carried no answer at all;
 *  - "uncertain": the judge answered and the answer cannot be acted on - a redirect below the
 *    confidence floor, or an answer inconsistent with its own per-requirement markings. Recorded
 *    as uncertainty, never as a verdict and never as "not judged";
 *  - "usable": a well-formed answer inside the option set, used exactly as before.
 */
type CourseCheckRead =
	| { kind: "unjudged"; detail: string }
	| {
			kind: "uncertain";
			judged: true;
			nextAction?: CourseCheckNextAction;
			drifted: string[];
			reasons: string[];
			confidence?: number;
			belowFloor: boolean;
			detail: string;
	  }
	| {
			kind: "usable";
			nextAction: CourseCheckNextAction;
			drifted: string[];
			reasons: string[];
			confidence?: number;
	  };

function readCourseCheckAnswer(
	raw: unknown,
	requirements: Array<{ id: string }>,
	confidenceFloor: number,
): CourseCheckRead {
	if (!isRecord(raw) || raw["judged"] !== true || typeof raw["nextAction"] !== "string") {
		return { kind: "unjudged", detail: "the judge returned an unjudged or malformed course_check result" };
	}
	const nextAction = raw["nextAction"];
	if (!(COURSE_CHECK_NEXT_ACTIONS as readonly string[]).includes(nextAction)) {
		return { kind: "unjudged", detail: `the judge returned an unknown next action: ${nextAction}` };
	}
	if (!isRecord(raw["onTrack"])) return { kind: "unjudged", detail: "the result carries no onTrack record" };
	const onTrack = raw["onTrack"] as Record<string, unknown>;
	const expected = requirements.map(r => r.id).sort();
	const actual = Object.keys(onTrack).sort();
	if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) {
		return {
			kind: "unjudged",
			detail: `onTrack keys must be exactly the requirement ids (${expected.join(", ")}); got ${actual.join(", ")}`,
		};
	}
	const drifted = Object.entries(onTrack)
		.filter(([, onTrackNow]) => onTrackNow !== true)
		.map(([id]) => id);
	const reasons = Array.isArray(raw["reasons"])
		? raw["reasons"].filter((r): r is string => typeof r === "string")
		: [];
	if (drifted.length > 0) reasons.push(`not on track: ${drifted.join(", ")}`);
	const rawConfidence = raw["confidence"];
	const confidence =
		typeof rawConfidence === "number" && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
			? rawConfidence
			: undefined;
	if (drifted.length > 0 && nextAction === "continue") {
		// The judge answered, and its own markings contradict that answer: recorded uncertainty.
		return {
			kind: "uncertain",
			judged: true,
			nextAction: "continue",
			drifted,
			reasons,
			confidence,
			belowFloor: false,
			detail: `drifted requirement(s) ${drifted.join(", ")} cannot yield continue`,
		};
	}
	if (
		(nextAction === "continue" || nextAction === "verify_before_proceeding") &&
		(confidence === undefined || confidence < confidenceFloor)
	) {
		return {
			kind: "uncertain",
			judged: true,
			nextAction: nextAction as CourseCheckNextAction,
			drifted,
			reasons,
			confidence,
			belowFloor: true,
			detail:
				`confidence ${confidence === undefined ? "absent" : String(confidence)} is below the floor ` +
				`${confidenceFloor}`,
		};
	}
	return { kind: "usable", nextAction: nextAction as CourseCheckNextAction, drifted, reasons, confidence };
}

/**
 * Match the owner's pattern list against a bash command: case-insensitive literal substrings with
 * whitespace collapsed, so a pattern split across a line break still matches. Pattern text is data,
 * never syntax: this cannot throw and no pattern can be malformed (a live consultation abstained on
 * literal-vs-regex, 0.29 - the conservative reading is the one where an owner typo cannot silently
 * change what matches and no pattern can fail the config load). First match wins; returns the
 * pattern verbatim, or undefined.
 */
function destructivePatternMatch(command: string, patterns: readonly string[]): string | undefined {
	const haystack = command.replace(/\s+/g, " ").toLowerCase();
	for (const pattern of patterns) {
		const needle = pattern.replace(/\s+/g, " ").trim().toLowerCase();
		if (needle.length > 0 && haystack.includes(needle)) return pattern;
	}
	return undefined;
}

/** The tool calls whose target the outside-root write trigger reads (the builtin plain-file writers). */
const OUTSIDE_ROOT_WRITE_TOOLS: Readonly<Record<string, true>> = {
	write: true,
	edit: true,
	ast_edit: true,
};

/**
 * Targets an `edit` payload names inside its own text, read only from the documented headers: the
 * hashline `[PATH#TAG]` section headers and the apply-patch `*** Add/Update/Delete File:` and
 * `*** Move to:` directives. Content that merely looks like a header inside a body row is not a
 * target; the hashline `MV` destination is none of these and is not read (documented limit).
 */
function editPayloadTargets(payload: string): string[] {
	const out: string[] = [];
	for (const line of payload.split(/\r?\n/)) {
		const trimmed = line.trim();
		const hashline = /^\[([^[\]#]+)#[0-9A-Fa-f]{4}\]$/.exec(trimmed);
		if (hashline !== null) {
			out.push(hashline[1]!.trim());
			continue;
		}
		const directive = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(trimmed);
		if (directive !== null) out.push(directive[1]!.trim());
	}
	return out;
}

/**
 * The plain filesystem targets a write/edit/ast_edit call names, as the model wrote them. A target
 * carrying a `://` scheme addresses an internal resource or a mounted tool device whose own handler
 * owns the write semantics, so it is not read here (documented limit). Deduplicated, order kept.
 */
function writeTargetPaths(toolName: string, input: unknown): string[] {
	if (!isRecord(input)) return [];
	const out: string[] = [];
	const add = (value: unknown): void => {
		if (!nonEmptyString(value)) return;
		const target = value.trim();
		if (target.length === 0 || target.includes("://") || out.includes(target)) return;
		out.push(target);
	};
	if (toolName === "ast_edit") {
		const paths = input["paths"];
		if (Array.isArray(paths)) for (const path of paths) add(path);
	}
	add(input["path"]);
	add(input["file_path"]);
	if (toolName === "edit") {
		const payload = input["input"];
		if (typeof payload === "string") for (const target of editPayloadTargets(payload)) add(target);
	}
	return out;
}

/**
 * Which of the named targets land outside the project root, in the order given. A relative target
 * resolves against the root - the way the write/edit tools resolve it against the session cwd - and
 * an absolute one is used as it stands.
 */
function outsideRootWriteTargets(toolName: string, input: unknown, projectRoot: string): string[] {
	return writeTargetPaths(toolName, input).filter(target => {
		const rel = relative(projectRoot, resolve(projectRoot, target));
		return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	});
}

/**
 * The text a write/edit/ast_edit call would apply, for the consult's content evidence: the write
 * payload, the edit patch or replaced text, or the ast_edit rewrite ops. `gateEvidence` caps it.
 */
function writePayloadText(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined;
	const parts: string[] = [];
	for (const key of ["input", "content", "new_string", "old_string"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim().length > 0) parts.push(value);
	}
	const ops = input["ops"];
	if (Array.isArray(ops) && ops.length > 0) parts.push(JSON.stringify(ops));
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function hostModelIds(ctxOrList: unknown): string[] {
	if (Array.isArray(ctxOrList)) {
		return ctxOrList.filter(m => typeof m === "string") as string[];
	}
	if (!isRecord(ctxOrList)) return [];
	const models = ctxOrList["models"];
	if (!isRecord(models) || typeof models["list"] !== "function") return [];
	try {
		const list = (models["list"] as () => unknown[])();
		return list.filter(m => isRecord(m) && typeof m["id"] === "string").map(m => (m as { id: string }).id);
	} catch {
		return [];
	}
}

/** Test seam / DI entry point. */
export function createJevController(deps: ControllerDeps): JevController {
	return new JevController(deps);
}
