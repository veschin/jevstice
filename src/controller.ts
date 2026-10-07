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
import { isRecord, nonEmptyString } from "./guards.js";
import type { JevTemplateConfig } from "./config.js";
import {
	ACTIVITY_REGISTRY,
	PLAN_MAPPING_APPROVED_OPTION,
	PLAN_MAPPING_INCOMPLETE_OPTION,
	PLAN_MAPPING_STAGE,
	FORMALIZATION_APPROVED_OPTION,
	FORMALIZATION_COVERAGE_MISSING_OPTION,
	FORMALIZATION_UNTRACEABLE_OPTION,
	resolveActivityOutcome,
	type ActivityRegistry,
} from "./activities.js";
import {
	type ControlPoint,
	lookupControlPoint,
	validateDeclaredControlPoint,
} from "./control-points.js";
import { classifyTaskType, routeModel, routeSkills, selectTopics, type CatalogTopic } from "./catalog.js";
import { STAGES } from "./stages.js";
import {
	POLICY,
	COURSE_CHECK_NEXT_ACTIONS,
	type AspectCoverageJudge,
	type AspectCoverageResult,
	type ClaimCheckJudge,
	type ClaimCheckResult,
	type CourseCheckJudge,
	type CourseCheckNextAction,
	type CourseCheckResult,
	type MultiLabelJudge,
	type RequirementsFormalizationJudge,
	type RequirementsFormalizationResult,
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

/** One automatic (periodic) course-check consult. Advisory: it never unlocks anything. */
export interface AutoCourseCheckRecord {
	judged: boolean;
	selectedOption?: string;
	confidence?: number;
	reasons: string[];
	/** Work revision the consult ran at (the mutation count that crossed the period). */
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
	/** Applied skill-routing selection (AC2), recorded for dispatch visibility. */
	routedSkill: string | undefined;
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
	/** FR-11: last handoff judgement (dispatch or acceptance) - recorded, never a silent no-op. */
	lastHandoff: HandoffRecord | undefined;
	/** POLICY-DRAFT I: last destructive-action judgement - recorded, never a silent no-op. */
	lastDestructive: DestructiveRecord | undefined;
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
		lastCourseCheck: undefined,
		lastClaimCheck: undefined,
		lastFormalization: undefined,
		lastPlanMapping: undefined,
		lastAutoCourseCheck: undefined,
		openAspectGaps: undefined,
		consecutiveCompletionApproves: undefined,
		submissionDigests: {},
		reworkJournal: {},
		taskType: undefined,
		selectedTopics: undefined,
		taskPrompt: undefined,
		pendingHandoffs: {},
		lastHandoff: undefined,
		lastDestructive: undefined,
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

/** FR-11 record of one handoff consultation: dispatch (before_subagent_spawn) or acceptance (tool_result). */
export interface HandoffRecord {
	phase: "dispatch" | "acceptance";
	/** Judge verdict when a consultation happened; absent when it never did. */
	verdict?: DecisionVerdict;
	/** True when the judge answered (an unusable answer is still a consultation, not a failure). */
	judged: boolean;
	confidence?: number;
	reasons: string[];
	/** A spawn was refused on this record (dispatch only; the acceptance hook cannot refuse). */
	blocked: boolean;
	at: number;
}

/** POLICY-DRAFT I record of one execution-time destructive-action consultation. */
export interface DestructiveRecord {
	/** The owner pattern that matched, verbatim from the config. */
	pattern: string;
	/** The bash command that was judged (verbatim prefix, capped for readability). */
	command: string;
	/** Judge verdict when a consultation happened; absent when it never did. */
	verdict?: DecisionVerdict;
	/** True when the judge answered (an unusable answer is still a consultation, not a failure). */
	judged: boolean;
	confidence?: number;
	reasons: string[];
	/** The command was refused before execution (only a confident explicit negative does this). */
	blocked: boolean;
	at: number;
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
// Mutation-bearing builtins (omp 18.6.3 tools/builtin-names.ts + tool sources):
// edit/write mutate files directly; ast_edit performs structural edits; bash executes
// arbitrary shell (mutation-capable, conservatively gated); memory_edit and manage_skill
// write user-level state. Non-builtin custom tools are out of this gate's reach (documented).
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"ast_edit",
	"bash",
	"memory_edit",
	"manage_skill",
	// eval spawns processes and writes files from inside the kernel without a tool_call
	// of its own: gated for the same reason as bash (conservative, mutation-capable).
	"eval",
]);
/** course_check redirecting options: approve+these map to revise (registry holds the full set). */
const COURSE_CHECK_REDIRECTING: ReadonlySet<string> = new Set(["return_to_requirement", "replan"]);
/**
 * Marker the client puts in `reasons` on a frame escape, followed by the service option id,
 * the companion meta_reason and the actionable fix (client.ts FRAME_FIX_PREFIX). Same literal
 * as HANDOFF_FRAME_ESCAPE_REASON below: the controller depends on the contract, not the module.
 */
const FRAME_ESCAPE_REASON = "meta_option";
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
 * FR-11 handoff options, shared by the dispatch and acceptance sides (a `stages.subagent_handoff`
 * template may replace them, R3). The option ids carry consequence: the controller reads an
 * explicit `revise` verdict as the negative; an `approve` is never required for the work to pass,
 * and a template that overrides the options without keeping `revise` leaves the gate advisory
 * (HANDOFF_REFUSAL_OPTION below).
 */
const HANDOFF_OPTIONS: DecisionOption[] = [
	{
		id: "approve",
		label: "Hand-off is sound",
		meaning: "the work order or the returned result matches the quoted requirement and is complete enough to proceed",
	},
	{
		id: "revise",
		label: "Hand-off is deficient",
		meaning: "the work order or result contradicts or omits part of the quoted requirement; name the deficiency",
	},
];
/** Option id that expresses the refusal: the offered set must name it for the gate to have teeth. */
const HANDOFF_REFUSAL_OPTION = "revise";
/**
 * Marker the client puts in `reasons` when the judge rejected the caller's frame instead of
 * judging the hand-off (client.ts: "meta_option", serviceId, metaReason; asserted in
 * tests/client.test.ts). A frame rejection is never an explicit negative about the work, so it
 * can record but never block.
 */
const HANDOFF_FRAME_ESCAPE_REASON = "meta_option";
/**
 * Dispatch deadline for the FR-11 handoff consult. The host runs `before_subagent_spawn`
 * handlers under a 30s timeout and DROPS the handler result on timeout, letting the spawn
 * proceed (runner.ts EXTENSION_HANDLER_TIMEOUT_MS = 30_000, no onFailure for this event), while
 * this handler keeps running: a negative that arrives after that ceiling would be recorded as a
 * refusal that never applied. Live endpoint latency has been measured at 33s against the
 * resetting edge, so the gate decides well before the host gives up.
 */
const HANDOFF_DISPATCH_DEADLINE_MS = 25_000;
/**
 * Age bound for a captured work order. A `task` tool call refused between capture and execution
 * (a foreign `tool_call` block, a preflight refusal or an approval deny - wrapper.ts:284-327
 * throws before `execute`) never emits `tool_result`, so its order would linger and disarm the
 * dispatch check for the rest of the session; it is also cleared outright when the task changes.
 * Two minutes is far longer than any real dispatch and far shorter than a task.
 */
const HANDOFF_ORDER_MAX_AGE_MS = 120_000;
/** Evidence quotes are capped for cost; the kept prefix stays verbatim and the source says it was capped. */
const HANDOFF_QUOTE_CAP = 4000;
/**
 * POLICY-DRAFT I (always_judge, 0.88): destructive actions are judged fresh at execution time.
 * The stage is the registry point the controller consults; the gate is armed only by a non-empty
 * `gates.destructive.patterns`. Options mirror the handoff set - the refusal is an explicit
 * `revise` verdict, an `approve` is never required for the command to run, and the offered set
 * must name the refusal for the gate to have teeth.
 */
const DESTRUCTIVE_STAGE: DecisionStage = "destructive_action";
const DESTRUCTIVE_OPTIONS: DecisionOption[] = [
	{
		id: "approve",
		label: "Safe to execute",
		meaning:
			"the command is not destructive or irreversible, or it is scoped so that running it is clearly intended",
	},
	{
		id: "revise",
		label: "Destructive or irreversible",
		meaning:
			"the command deletes or overwrites data, rewrites history, drops schema or is otherwise hard to " +
			"reverse; do not run it without a fresh explicit decision - name the hazard",
	},
];
/** Option id that expresses the refusal: the offered set must name it for the gate to have teeth. */
const DESTRUCTIVE_REFUSAL_OPTION = "revise";
/**
 * Internal deadline for the destructive-action consult. The host bounds every `tool_call` handler
 * at 30s and its on-timeout policy is fail-CLOSED (`{ block: true }`, runner.ts emitToolCall), so
 * a slow judge would otherwise become a block this gate never decided. The deadline fires first
 * and takes the fail-open path: the uncertainty is recorded and the command proceeds. A verdict
 * landing after the deadline is never read - a late answer must not pin a refusal that never
 * applied.
 */
const DESTRUCTIVE_DEADLINE_MS = 25_000;
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
	options: DecisionOption[];
	evidence: Evidence[];
	capabilities: string[];
	/** Claimed-aspect catalog ids for the aspect_coverage preset. */
	aspects: string[];
	/** Claim texts for the claim_check preset (each judged separately against the evidence). */
	claims: string[];
	/** Draft numbered requirements for the requirements_formalization stage (one per item). */
	requirements: string[];
	/** Per-requirement plan claims for the plan_mapping stage (planning activity). */
	planClaims: Array<{ requirementId: string; claim: string }>;
}

export interface ValidationResult {
	ok: boolean;
	reasons: string[];
	input?: ValidatedDecisionInput;
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
			if (!isRecord(e) || typeof e["kind"] !== "string" || !EVIDENCE_KINDS.has(e["kind"])) {
				reasons.push(`evidence[${i}].kind must be one of: ${[...EVIDENCE_KINDS].join(", ")}`);
				return;
			}
			if (!nonEmptyString(e["source"]) || !nonEmptyString(e["quote"])) {
				reasons.push(`evidence[${i}] must carry non-empty source and quote`);
				return;
			}
			evidence.push({
				kind: e["kind"] as Evidence["kind"],
				source: e["source"] as string,
				quote: e["quote"] as string,
			});
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
	const requirements = Array.isArray(raw["requirements"])
		? raw["requirements"].filter((r): r is string => typeof r === "string" && r.trim().length > 0)
		: [];
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
	if (reasons.length > 0) return { ok: false, reasons };
	return {
		ok: true,
		reasons: [],
		input: {
			stage: stage as DecisionStage,
			task: raw["task"] as string,
			proposal: raw["proposal"] as string,
			approach,
			options,
			evidence,
			capabilities,
			aspects,
			claims,
			requirements,
			planClaims,
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

/** A judge answer approves only if fully well-formed, option-resolvable and confident enough (AC4c/d). */
export function normalizeJudgeResult(raw: unknown, options: DecisionOption[], minConfidence: number): DecisionResult {
	if (!isRecord(raw)) {
		return { verdict: "insufficient_evidence", reasons: ["judge returned a non-object payload"] };
	}
	const verdict = raw["verdict"];
	if (typeof verdict !== "string" || !VERDICTS.has(verdict)) {
		return { verdict: "insufficient_evidence", reasons: [`judge returned unknown verdict: ${String(verdict)}`] };
	}
	const reasons = Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : [];
	const confidence = typeof raw["confidence"] === "number" ? raw["confidence"] : undefined;
	if (verdict === "approve") {
		const selected = raw["selectedOption"];
		if (typeof selected !== "string" || !options.some(o => o.id === selected)) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["judge approved without naming one of the offered options"],
			};
		}
		if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`judge confidence ${confidence} outside 0..1 is malformed`],
				confidence,
			};
		}
		if (confidence === undefined || confidence < minConfidence) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					confidence === undefined
						? `judge approved without reporting confidence; absent is not above the required ${minConfidence}`
						: `judge confidence ${confidence} below required ${minConfidence}`,
				],
				confidence,
			};
		}
	}
	return {
		verdict: verdict as DecisionVerdict,
		selectedOption: typeof raw["selectedOption"] === "string" ? raw["selectedOption"] : undefined,
		reasons: reasons.length > 0 ? reasons : [`judge verdict: ${verdict}`],
		confidence,
	};
}

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

	constructor(deps: ControllerDeps) {
		this.judge = deps.judge;
		this.courseCheckJudge = deps.courseCheckJudge;
		this.aspectCoverageJudge = deps.aspectCoverageJudge;
		this.claimCheckJudge = deps.claimCheckJudge;
		this.requirementsFormalizationJudge = deps.requirementsFormalizationJudge;
		this.activities = deps.activities ?? ACTIVITY_REGISTRY;
		this.catalogIds = deps.catalogIds ?? new Set();
		this.catalog = deps.catalog;
		this.multiLabelJudge = deps.multiLabelJudge;
		this.maxReworkIterations = deps.maxReworkIterations ?? POLICY.maxReworkIterations;
		this.handoffDispatchDeadlineMs = deps.handoffDispatchDeadlineMs ?? HANDOFF_DISPATCH_DEADLINE_MS;
		this.destructiveDeadlineMs = deps.destructiveDeadlineMs ?? DESTRUCTIVE_DEADLINE_MS;
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
				"(`options` and `proposal` stay required by the tool schema on both stages, but the judges read " +
				"`task`, `requirements`/`planClaims` and `evidence`.)",
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
							"2+ claim texts for stage=claim_check; each is judged separately against the quoted evidence",
					},
					requirements: {
						type: "array",
						items: { type: "string" },
						description:
							"draft numbered requirement list for stage=requirements_formalization; one text per " +
							"numbered item, each marked traceable to a quoted user/spec item",
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
		// FR-11 acceptance side: `tool_result` is the only hook that observes a task result.
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
						`for the current task first. Call ${TOOL_NAME} with the plan stage and evidence. ` +
						"Read-only evidence gathering remains available. " +
						`Submit decisions with the registered ${TOOL_NAME} TOOL (tool call), not by writing files ` +
						`(e.g. to xd://${TOOL_NAME}); ` +
						"the block message you received does not mean the addon is unavailable. " +
						"Your next tool call must be jev_decision (a normal registered tool call, exactly like read/write) — not a file write.",
				};
			}
			// Planning is incomplete while a formalized requirement has no supported plan claim
			// (activities framework, planning activity). Only a task with an accepted
			// requirements_formalization is affected - without one the gate behaves as before.
			if (this.template.gates?.mutation !== false) {
				const planningGap = this.planningGap();
				if (planningGap !== undefined) {
					return {
						block: true,
						reason:
							`${planningGap}. Call ${TOOL_NAME} with stage=${PLAN_MAPPING_STAGE} and ` +
							"`planClaims` naming, for every formalized requirement id, the plan work that serves " +
							"it (the judge marks each claim against the quoted evidence). Read-only evidence " +
							"gathering remains available.",
					};
				}
			}
			this.state.workRevision += 1;
			this.persist();
			// Activities framework (development): the automatic course check fires in the
			// BACKGROUND after every N allowed mutations; it never delays or blocks this call.
			this.maybeAutomaticCourseCheck();
		}
		return undefined;
	}

	async onBeforeAgentStart(event: unknown): Promise<void> {
		if (!isRecord(event) || typeof event["prompt"] !== "string") return;
		const fp = await fingerprint(event["prompt"]);
		if (fp !== this.state.taskFingerprint) {
			this.state.taskFingerprint = fp;
			// FR-11: the requirement the handoff judge quotes for this task (same source as the
			// fingerprint, so the two can never describe different prompts).
			this.state.taskPrompt = event["prompt"];
			// A stale work order can never legitimately judge a spawn of the new task.
			this.state.pendingHandoffs = {};
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
					"Stopped WITHOUT fake success: run jev_decision with the required stage and evidence, " +
					"or resolve with the user.";
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
				`Call the ${TOOL_NAME} tool with the required stage, fixed options and quoted evidence ` +
				"(completion needs execution/code/log evidence; refactors must evidence every original capability).",
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

	/** Record an applied skill-routing selection (AC2 dispatch visibility). */
	rememberSkillRouting(skill: string): void {
		this.state.routedSkill = skill;
		this.persist();
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
	 * is retired when that call settles (onTaskResult); the spawn event carries no toolCallId, so
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
	 * to hand to a task agent against the requirement captured at task start. Refuses the spawn
	 * ONLY on a judged verdict that is explicitly negative (revise) at or above the confidence
	 * floor, with the offered option set naming that refusal, and with the answer arriving before
	 * the deadline below. An abstention, a low-confidence answer, a judge error, a frame-escape
	 * answer, a missing requirement, an unattributable work order or an unwired gate let the spawn
	 * through and are recorded - the owner measured that a gate which blocks on an abstention
	 * becomes a permanent block.
	 */
	async onHandoffDispatch(event: unknown, _ctx?: unknown): Promise<SpawnRouteResult | undefined> {
		if (!this.handoffWired() || !isRecord(event)) return undefined;
		// eval spawns (agent() calls) carry no captured work order: nothing judgeable here.
		if (event["invocationKind"] !== "task") return undefined;
		this.pruneStaleHandoffOrders();
		const ids = Object.keys(this.state.pendingHandoffs);
		const id = ids.length === 1 ? ids[0] : undefined;
		const order = id !== undefined ? this.state.pendingHandoffs[id] : undefined;
		if (id === undefined || order === undefined || order.usedBySpawn) {
			const gap =
				ids.length === 0
					? "no work order captured from the task tool call"
					: order?.usedBySpawn === true
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
		const workOrder = cappedQuote(order.text).quote;
		const proposal =
			"Claim under judgment: this work order is an adequate assignment for a task agent - it asks for the " +
			"work the quoted user requirement needs, stays within it, and names a result the agent can hand back.\n\n" +
			`Work order handed over by the lead agent (verbatim):\n${workOrder}`;
		const evidence: Evidence[] = [
			handoffEvidence("user", "session task prompt (the requirement)", requirement),
			handoffEvidence("spec", "task tool call input (the work order)", order.text),
		];
		// A late answer must never block: the host already dropped this handler's result at its
		// own ceiling (see HANDOFF_DISPATCH_DEADLINE_MS) and proceeded with the spawn.
		let settled: { record: HandoffRecord; negative: boolean } | undefined;
		let deadline: Timer | undefined;
		try {
			settled = await Promise.race([
				this.judgeHandoff("dispatch", proposal, evidence),
				new Promise<undefined>(resolve => {
					deadline = setTimeout(() => resolve(undefined), this.handoffDispatchDeadlineMs);
				}),
			]);
		} finally {
			clearTimeout(deadline);
		}
		if (settled === undefined) {
			this.recordHandoffUncertainty(
				"dispatch",
				`the judge did not answer before the dispatch deadline (${this.handoffDispatchDeadlineMs}ms, ` +
					"under the host's handler timeout)",
			);
			return undefined;
		}
		const { record, negative } = settled;
		if (negative) {
			const reason =
				`Jev handoff check refused the dispatch: ${record.reasons.join(" ")} ` +
				`(judge revise at confidence ${record.confidence}). ` +
				"Rewrite the work order so it covers the quoted requirement, then dispatch again - " +
				"or escalate to the user.";
			this.blockHandoff(record, reason);
			return { block: true, reason };
		}
		this.state.lastHandoff = record;
		this.pushFeedback(`Jev handoff (${handoffLine(record)}). The delegation proceeds.`);
		this.persist();
		return undefined;
	}

	/**
	 * FR-11 acceptance side (tool_result): when a task tool call settles, consult the judge about
	 * the result before the lead agent builds on it. `tool_result` cannot refuse a call (the host
	 * only lets a handler rewrite content/details/isError), so a confident negative is recorded as
	 * an unresolved blocker and pushed back into the same session. The consult is not awaited: the
	 * measured judge latency against a resetting endpoint (33s) must not delay the delegated
	 * result reaching the model.
	 */
	onTaskResult(event: unknown, _ctx?: unknown): undefined {
		if (!this.handoffWired() || !isRecord(event) || event["toolName"] !== "task") return undefined;
		const toolCallId = typeof event["toolCallId"] === "string" ? event["toolCallId"] : undefined;
		const order = toolCallId !== undefined ? this.state.pendingHandoffs[toolCallId] : undefined;
		// Retire the order of the call that settled, consumed by a spawn or not.
		if (toolCallId !== undefined) delete this.state.pendingHandoffs[toolCallId];
		const requirement = this.state.taskPrompt;
		if (requirement === undefined) {
			this.recordHandoffUncertainty("acceptance", "no user requirement captured for this task yet");
			return undefined;
		}
		const reported = resultText(event);
		if (reported.length === 0) {
			this.recordHandoffUncertainty(
				"acceptance",
				`the task result carried no report text${event["isError"] === true ? " (the call failed)" : ""}`,
			);
			return undefined;
		}
		this.handoffAcceptance = this.runHandoffAcceptance(requirement, order?.text, reported).catch(() => {});
		return undefined;
	}

	/** Await the in-flight acceptance consult (test seam; the tool_result path never blocks on it). */
	async handoffAcceptanceSettled(): Promise<void> {
		await this.handoffAcceptance?.catch(() => {});
	}

	private async runHandoffAcceptance(requirement: string, workOrder: string | undefined, reported: string): Promise<void> {
		const evidence: Evidence[] = [handoffEvidence("user", "session task prompt (the requirement)", requirement)];
		if (workOrder !== undefined) {
			evidence.push(handoffEvidence("spec", "task tool call input (the work order)", workOrder));
		}
		// The delegated agent's own report is self-report, not artifact evidence (FR-16): the source
		// says so, and a report-only acceptance claim is exactly what the judge may abstain on.
		evidence.push(
			handoffEvidence("log", "task tool result (the delegated agent's own report, not artifact-verified)", reported),
		);
		const proposal =
			"Claim under judgment: the returned result satisfies the quoted user requirement and is supported by " +
			"what the delegated agent reported; nothing the requirement asks for is missing or contradicted.\n\n" +
			(workOrder !== undefined ? `Work order the agent was given (verbatim):\n${cappedQuote(workOrder).quote}\n\n` : "") +
			`Result reported by the task agent (verbatim):\n${cappedQuote(reported).quote}`;
		const { record, negative } = await this.judgeHandoff("acceptance", proposal, evidence);
		if (negative) {
			this.blockHandoff(
				record,
				`Jev handoff check did not accept the delegated result: ${record.reasons.join(" ")} ` +
					`(judge revise at confidence ${record.confidence}). ` +
					"Rework it or re-dispatch before building on it.",
			);
			return;
		}
		this.state.lastHandoff = record;
		this.pushFeedback(`Jev handoff (${handoffLine(record)}).`);
		this.persist();
	}

	/**
	 * One handoff consultation. Never throws: a judge error is an unjudged record (it approves
	 * nothing and blocks nothing). The negative is read from the verdict - the question the client
	 * fixes for every caller - and is only decisive when the offered option set names the refusal,
	 * the judge did not reject the frame instead (HANDOFF_FRAME_ESCAPE_REASON) and the confidence
	 * is a real number at or above the floor and inside 0..1 (normalizeJudgeResult range-checks
	 * confidence on the approve branch only, so a malformed 1.5 revise must not count).
	 */
	private async judgeHandoff(
		phase: HandoffRecord["phase"],
		proposal: string,
		evidence: Evidence[],
	): Promise<{ record: HandoffRecord; negative: boolean }> {
		const options = this.template.stages?.["subagent_handoff"]?.options ?? HANDOFF_OPTIONS;
		const base: HandoffRecord = { phase, judged: false, reasons: [], blocked: false, at: this.now() };
		let raw: unknown;
		try {
			raw = await this.judge({
				stage: "subagent_handoff",
				task:
					phase === "dispatch"
						? "Validate the work order the lead agent is about to hand to a task agent, before dispatch (FR-11)."
						: "Validate the result a task agent returned, before the lead agent accepts it and builds on it (FR-11).",
				proposal,
				options,
				evidence,
			});
		} catch (err) {
			return {
				record: { ...base, reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`] },
				negative: false,
			};
		}
		const result = normalizeJudgeResult(raw, options, this.minConfidence);
		const negative =
			result.verdict === "revise" &&
			options.some(o => o.id === HANDOFF_REFUSAL_OPTION) &&
			!result.reasons.includes(HANDOFF_FRAME_ESCAPE_REASON) &&
			result.confidence !== undefined &&
			result.confidence >= this.minConfidence &&
			result.confidence <= 1;
		return {
			record: {
				...base,
				judged: true,
				verdict: result.verdict,
				confidence: result.confidence,
				reasons: result.reasons,
			},
			negative,
		};
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
	 * Destructive-action gate (POLICY-DRAFT class I, always_judge 0.88). A bash command matching an
	 * owner pattern is judged before it runs, with the command and the session task as evidence. The
	 * call is refused ONLY on a judged explicit negative at or above the confidence floor - the same
	 * condition as the FR-11 handoff gate - so an abstention, a judge error, a low confidence, a frame
	 * escape, a deadline loss or an unwired pattern list lets the command run and records the
	 * uncertainty (the owner measured that blocking on an abstention becomes a permanent block).
	 */
	async onDestructiveCall(event: unknown, _ctx?: unknown): Promise<{ block?: boolean; reason?: string } | undefined> {
		if (!isRecord(event) || event["toolName"] !== "bash") return undefined;
		// An invalid config is already blocked fail-closed by the mutation gate; never judge on it.
		if (this.templateError !== undefined) return undefined;
		// Absent or empty list means the gate does not exist (default off).
		const patterns = this.template.gates?.destructive?.patterns ?? [];
		if (patterns.length === 0) return undefined;
		const input = event["input"];
		const command = isRecord(input) && nonEmptyString(input["command"]) ? input["command"] : undefined;
		if (command === undefined) return undefined;
		const matched = destructivePatternMatch(command, patterns);
		if (matched === undefined) return undefined;
		const proposal =
			"Claim under judgment: this shell command is destructive or irreversible enough that running it " +
			"now is not safe without a fresh explicit decision - it deletes or overwrites data, rewrites " +
			"history, drops schema, or is otherwise hard to reverse.\n\n" +
			`Command about to run (verbatim):\n${cappedQuote(command).quote}`;
		const evidence: Evidence[] = [handoffEvidence("spec", "bash tool call command (about to run)", command)];
		const task = this.state.taskPrompt;
		if (task !== undefined) evidence.push(handoffEvidence("user", "session task prompt", task));
		// A late answer must never block: the host's own tool_call timeout is fail-closed, so this
		// deadline must fire first and take the fail-open path (see DESTRUCTIVE_DEADLINE_MS).
		let settled: { record: DestructiveRecord; negative: boolean } | undefined;
		let deadline: Timer | undefined;
		try {
			settled = await Promise.race([
				this.judgeDestructive(matched, command, proposal, evidence),
				new Promise<undefined>(resolve => {
					deadline = setTimeout(() => resolve(undefined), this.destructiveDeadlineMs);
				}),
			]);
		} finally {
			clearTimeout(deadline);
		}
		if (settled === undefined) {
			this.recordDestructiveUncertainty(
				matched,
				command,
				`the judge did not answer before the destructive-gate deadline (${this.destructiveDeadlineMs}ms)`,
			);
			return undefined;
		}
		const { record, negative } = settled;
		if (negative) {
			const reason =
				`Jev destructive-action gate refused this command before execution: ${record.reasons.join(" ")} ` +
				`(judge revise at confidence ${record.confidence}, matched pattern "${record.pattern}"). ` +
				"Confirm the destructive action with the user or replace it with a reversible step, then run it again.";
			this.blockDestructive(record, reason);
			return { block: true, reason };
		}
		this.state.lastDestructive = record;
		this.pushFeedback(`Jev destructive-action gate (${destructiveLine(record)}). The command proceeds.`);
		this.persist();
		return undefined;
	}

	/**
	 * One destructive-action consultation. Never throws: a judge error is an unjudged record (it
	 * approves nothing and blocks nothing). The negative is read from the verdict and is only
	 * decisive when the offered option set names the refusal, the judge did not reject the frame
	 * instead and the confidence is a real number at or above the floor and inside 0..1
	 * (normalizeJudgeResult range-checks confidence on the approve branch only, so a malformed 1.5
	 * revise must not count).
	 */
	private async judgeDestructive(
		pattern: string,
		command: string,
		proposal: string,
		evidence: Evidence[],
	): Promise<{ record: DestructiveRecord; negative: boolean }> {
		const options = this.template.stages?.[DESTRUCTIVE_STAGE]?.options ?? DESTRUCTIVE_OPTIONS;
		const base: DestructiveRecord = {
			pattern,
			command: cappedQuote(command).quote,
			judged: false,
			reasons: [],
			blocked: false,
			at: this.now(),
		};
		let raw: unknown;
		try {
			raw = await this.judge({
				stage: DESTRUCTIVE_STAGE,
				task:
					"Judge this destructive or irreversible shell command at execution time, before it runs " +
					"(POLICY-DRAFT destructive-action gate; the plan never covers it).",
				proposal,
				options,
				evidence,
			});
		} catch (err) {
			return {
				record: { ...base, reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`] },
				negative: false,
			};
		}
		const result = normalizeJudgeResult(raw, options, this.minConfidence);
		const negative =
			result.verdict === "revise" &&
			options.some(o => o.id === DESTRUCTIVE_REFUSAL_OPTION) &&
			!result.reasons.includes(FRAME_ESCAPE_REASON) &&
			result.confidence !== undefined &&
			result.confidence >= this.minConfidence &&
			result.confidence <= 1;
		return {
			record: {
				...base,
				judged: true,
				verdict: result.verdict,
				confidence: result.confidence,
				reasons: result.reasons,
			},
			negative,
		};
	}

	/** Unjudged destructive outcome: recorded in state and surfaced, never a block (owner constraint). */
	private recordDestructiveUncertainty(pattern: string, command: string, note: string): void {
		this.state.lastDestructive = {
			pattern,
			command: cappedQuote(command).quote,
			judged: false,
			reasons: [note],
			blocked: false,
			at: this.now(),
		};
		this.persist();
		this.pushFeedback(`Jev destructive-action gate not judged: ${note}. The command proceeds.`);
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
			this.state = {
				approvals: restoredApprovals,
				iterations: isRecord(data["iterations"]) ? (data["iterations"] as Record<string, number>) : {},
				workRevision: typeof data["workRevision"] === "number" ? data["workRevision"] : 0,
				taskFingerprint: typeof data["taskFingerprint"] === "string" ? data["taskFingerprint"] : undefined,
				blockers: Array.isArray(data["blockers"])
					? data["blockers"].filter((b): b is string => typeof b === "string")
					: [],
				routedModel: typeof data["routedModel"] === "string" ? data["routedModel"] : undefined,
				routedSkill: typeof data["routedSkill"] === "string" ? data["routedSkill"] : undefined,
				lastCourseCheck: restoreCourseCheck(data["lastCourseCheck"]),
				lastClaimCheck: restoreClaimCheck(data["lastClaimCheck"]),
				lastFormalization: restoreFormalization(data["lastFormalization"]),
				lastPlanMapping: restorePlanMapping(data["lastPlanMapping"]),
				lastAutoCourseCheck: restoreAutoCourseCheck(data["lastAutoCourseCheck"]),
				openAspectGaps: restoreAspectGaps(data["openAspectGaps"]),
				submissionDigests: restoreDigests(data["submissionDigests"]),
				reworkJournal: restoreReworkJournal(data["reworkJournal"]),
				taskType: typeof data["taskType"] === "string" ? data["taskType"] : undefined,
				selectedTopics: Array.isArray(data["selectedTopics"])
					? (data["selectedTopics"] as unknown[]).filter((t): t is string => typeof t === "string")
					: undefined,
				consecutiveCompletionApproves: undefined,
				taskPrompt: typeof data["taskPrompt"] === "string" ? data["taskPrompt"] : undefined,
				// Transient by nature: a restart mid-call loses the captured orders, nothing else.
				pendingHandoffs: {},
				lastHandoff: restoreHandoffRecord(data["lastHandoff"]),
				lastDestructive: restoreDestructiveRecord(data["lastDestructive"]),
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
		const stopStageRaw = isRecord(raw) && raw["stage"] === "completion_review";
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
			const journalAttempts = this.state.reworkJournal[boundKey]?.attempts ?? [];
			if (spent !== undefined) {
				interrupted();
				const already = journalAttempts.map(a => `"${a.approach}"`).join(", ");
				const problem =
					`approach_already_spent: the approach "${input.approach}" was already judged on attempt ` +
					`${spent.attempt} of ${input.stage} for this task; every attempt of the loop must change the ` +
					`approach, and a repeated approach is not a new attempt. Approaches already spent: ${already}. ` +
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
			if (journalAttempts.length >= this.maxReworkIterations) {
				interrupted();
				const blocker =
					`Jev rework bound exhausted for stage ${input.stage}: ${journalAttempts.length} attempt(s), each ` +
					`with a different approach, all rejected — ${this.reworkJournalLine(boundKey)}. ` +
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

		// C1 wired path: course_check preset consults the dedicated per-requirement judge.
		if (input.stage === "course_check" && this.courseCheckJudge !== undefined) {
			const preset = await this.submitCourseCheck(input, boundKey, used);
			return this.guardActivityOutcome(input.stage, preset) ?? preset;
		}
		if (input.stage === "skill_routing" || input.stage === "model_routing") {
			const routed = await this.submitRouting(input);
			if (routed !== undefined) return this.guardActivityOutcome(input.stage, routed) ?? routed;
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
		const stopStage = lookupControlPoint(input.stage, this.extraPoints)?.trigger === "session_stop";
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
				currentAction: input.proposal,
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
			return {
				verdict: "revise",
				selectedOption: nextAction,
				reasons,
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
		const requirements = input.requirements.map((text, i) => ({ id: `req-${i + 1}`, text }));
		if (requirements.length === 0) {
			// Invalid submission, not judge rework: refused before any consultation.
			return {
				verdict: "insufficient_evidence",
				reasons: [
					"requirements_formalization needs the draft numbered list: pass one requirement text per " +
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
			at: this.now(),
			taskFingerprint: this.state.taskFingerprint,
			workRevision: this.state.workRevision,
		};
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
				currentAction: input.proposal,
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
	 * The judged attempt that already spent this approach on the same task+stage, if any. Comparison
	 * folds case and inner whitespace only, so "Tighten the  trigger" cannot buy a second attempt;
	 * every message quotes the text as submitted. Only judged attempts are in the journal, so a
	 * submission refused before the judge call never spends its approach.
	 */
	private spentApproach(key: string, approach: string): ReworkAttempt | undefined {
		const normalized = approach.trim().replace(/\s+/g, " ").toLowerCase();
		return this.state.reworkJournal[key]?.attempts.find(
			a => a.approach.trim().replace(/\s+/g, " ").toLowerCase() === normalized,
		);
	}

	/** The journal as one line: each attempt's approach with the judge's own verbatim answer. */
	private reworkJournalLine(key: string): string {
		const attempts = this.state.reworkJournal[key]?.attempts ?? [];
		if (attempts.length === 0) return "no judged attempt recorded";
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
		const spentBefore = journal.attempts.map(a => `"${a.approach}"`).join(", ");
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
		const reasons = outcome.reasons.join(" ").slice(0, REWORK_REASON_EXCERPT_CHARS);
		this.pushFeedback(
			`Jev rework attempt ${attempt}/${this.maxReworkIterations} for ${stage} (approach "${approach}") was ` +
				`rejected — ${outcome.verdict}${reasons === "" ? "" : `: ${reasons}`}. ` +
				`Approaches already spent: ${spentBefore === "" ? "none" : spentBefore}. ` +
				(attempt >= this.maxReworkIterations
					? "The attempt bound is now exhausted: the next approach escalates as an OPEN item with this " +
						"journal instead of being judged; re-wording a spent approach is refused outright."
					: "The next attempt must name a DIFFERENT approach (tighten the trigger; split the item into " +
						"narrower separately checkable items; restate it as an outcome plus the evidence that " +
						"settles it) - the same approach in different words is not a new attempt."),
		);
	}

	private planApproval(): ApprovalRecord | undefined {
		// Undefined current fingerprint means no user task is established yet: no gate credit.
		if (this.state.taskFingerprint === undefined) return undefined;
		return this.state.approvals.find(
			a =>
				lookupControlPoint(a.stage, this.extraPoints)?.trigger === "mutation_gate" &&
				a.taskFingerprint === this.state.taskFingerprint,
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
	 * path. Returns the gap naming the requirement ids, or undefined when planning is complete -
	 * including when the task was never formalized, so the default workflow (no formalization)
	 * behaves exactly as before.
	 */
	private planningGap(): string | undefined {
		const formalization = this.currentFormalization();
		if (formalization === undefined) return undefined;
		const ids = formalization.requirements.map(r => r.id);
		const mapping = this.state.lastPlanMapping;
		if (mapping === undefined || mapping.taskFingerprint !== this.state.taskFingerprint) {
			return (
				`plan mapping incomplete: no ${PLAN_MAPPING_STAGE} submission covers the ${ids.length} formalized ` +
				`requirement(s) (${ids.join(", ")})`
			);
		}
		const missing = ids.filter(id => !mapping.requirements.some(r => r.id === id && r.supported));
		if (missing.length === 0) return undefined;
		return `plan mapping incomplete: requirement(s) ${missing.join(", ")} have no supported plan claim`;
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
					this.rememberSkillRouting(result.selectedOption);
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
	 * Periodic course check (owner switch `courseCheck.everyMutations`, default off). After every
	 * N allowed mutating tool calls the controller consults the course-check judge itself, so a
	 * session can ask "am I still on the plan?" without the executor choosing to. The consult runs
	 * in the BACKGROUND (measured judge latency reaches 33s against a resetting endpoint, so it
	 * must never hold a turn) and stays advisory: no block, no gate approval, no rework budget.
	 */
	private maybeAutomaticCourseCheck(): void {
		const every = this.template.courseCheck?.everyMutations ?? 0;
		if (every <= 0) return;
		const revision = this.state.workRevision;
		if (revision <= 0 || revision % every !== 0) return;
		// Chained: consults stay ordered and at most one is in flight at a time.
		const chain = this.autoCourseCheck ?? Promise.resolve();
		this.autoCourseCheck = chain.then(() => this.runAutomaticCourseCheck(revision)).catch(() => {});
	}

	/** Await the in-flight automatic course-check chain (test seam; the tool path never waits). */
	async automaticCourseChecksSettled(): Promise<void> {
		await this.autoCourseCheck?.catch(() => {});
	}

	/**
	 * The requirements an automatic course check runs against: the accepted formalized list of
	 * the current task when one exists, else the captured task prompt as the single requirement
	 * (id "task"). Empty when neither exists - recorded as uncertainty, never invented.
	 */
	private courseCheckRequirements(): Array<{ id: string; quote: string }> {
		const formalization = this.currentFormalization();
		if (formalization !== undefined && formalization.requirements.length > 0) {
			return formalization.requirements.map(r => ({ id: r.id, quote: r.text }));
		}
		const task = this.state.taskPrompt;
		return task !== undefined ? [{ id: "task", quote: cappedQuote(task).quote }] : [];
	}

	/**
	 * One automatic consultation. Never throws and never blocks: a missing requirement, an
	 * unwired judge, a judge error, an unusable answer or a sub-floor confidence is RECORDED as
	 * uncertainty and pushed as feedback; a confident redirect or escalation is pushed back into
	 * the same session (ask_user additionally as a recorded blocker). Nothing here records a gate
	 * approval or satisfies the completion boundary - that still needs a deliberate course_check
	 * with option continue bound to the current revision.
	 */
	private async runAutomaticCourseCheck(revision: number): Promise<void> {
		const requirements = this.courseCheckRequirements();
		const base: AutoCourseCheckRecord = { judged: false, reasons: [], workRevision: revision, at: this.now() };
		if (requirements.length === 0) {
			this.recordAutomaticCourseCheck({ ...base, reasons: ["no requirement captured for this task yet"] }, "no requirement to check against");
			return;
		}
		if (this.courseCheckJudge === undefined) {
			this.recordAutomaticCourseCheck({ ...base, reasons: ["course_check judge not configured in this session"] }, "judge not wired");
			return;
		}
		const evidence: Evidence[] = [];
		if (this.state.taskPrompt !== undefined) {
			evidence.push(handoffEvidence("user", "session task prompt (the requirement)", this.state.taskPrompt));
		}
		for (const r of requirements) evidence.push(handoffEvidence("spec", `requirement ${r.id}`, r.quote));
		let raw: CourseCheckResult;
		try {
			raw = await this.courseCheckJudge({
				requirements,
				currentAction: `automatic course check after ${revision} allowed mutating tool call(s)`,
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
		if (!read.ok) {
			this.recordAutomaticCourseCheck({ ...base, reasons: [read.detail] }, read.detail);
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
		// Latest approval wins: supersede keeps same-digest records, so the freshest
		// completion_review must be consulted, not the first.
		let completion: ApprovalRecord | undefined;
		for (const a of this.state.approvals) {
			if (lookupControlPoint(a.stage, this.extraPoints)?.trigger === "session_stop") completion = a;
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
		// aspect_coverage teeth: an open drift for the CURRENT task blocks completion until
		// a fresh aspect_coverage submission clears it (advisory preset, no own stop gate).
		const gaps = this.state.openAspectGaps;
		if (gaps !== undefined && gaps.taskFingerprint === this.state.taskFingerprint && gaps.missed.length > 0) {
			missing.push(`aspects not addressed: ${gaps.missed.join(", ")}`);
		}
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
		requirements.push({ id: entry["id"], text: entry["text"], traceable: entry["traceable"] });
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
	return {
		requirements,
		uncovered,
		outcome: raw["outcome"],
		// A restored list is a checklist only if it was complete AND every item is traceable.
		complete: raw["complete"] === true && requirements.every(r => r.traceable),
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
	return {
		judged: raw["judged"],
		selectedOption: typeof raw["selectedOption"] === "string" ? raw["selectedOption"] : undefined,
		confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
		reasons: Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : [],
		workRevision: raw["workRevision"],
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

/** Validate a persisted handoff record: malformed entries are dropped, never trusted. */
function restoreHandoffRecord(raw: unknown): HandoffRecord | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw["phase"] !== "dispatch" && raw["phase"] !== "acceptance") return undefined;
	if (typeof raw["judged"] !== "boolean" || typeof raw["blocked"] !== "boolean") return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	const verdict = raw["verdict"];
	if (verdict !== undefined && (typeof verdict !== "string" || !VERDICTS.has(verdict))) return undefined;
	return {
		phase: raw["phase"],
		verdict: verdict as DecisionVerdict | undefined,
		judged: raw["judged"],
		confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
		reasons: Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : [],
		blocked: raw["blocked"],
		at: raw["at"],
	};
}

/** Validate a persisted destructive-action record: malformed entries are dropped, never trusted. */
function restoreDestructiveRecord(raw: unknown): DestructiveRecord | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw["judged"] !== "boolean" || typeof raw["blocked"] !== "boolean") return undefined;
	if (typeof raw["at"] !== "number" || !Number.isFinite(raw["at"])) return undefined;
	if (!nonEmptyString(raw["pattern"]) || typeof raw["command"] !== "string") return undefined;
	const verdict = raw["verdict"];
	if (verdict !== undefined && (typeof verdict !== "string" || !VERDICTS.has(verdict))) return undefined;
	return {
		pattern: raw["pattern"],
		command: raw["command"],
		verdict: verdict as DecisionVerdict | undefined,
		judged: raw["judged"],
		confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
		reasons: Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : [],
		blocked: raw["blocked"],
		at: raw["at"],
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

/** Text blocks of a tool result event, in order (image and other blocks carry no judging material). */
function resultText(event: Record<string, unknown>): string {
	const content = event["content"];
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is Record<string, unknown> => isRecord(b) && b["type"] === "text" && nonEmptyString(b["text"]))
		.map(b => (b["text"] as string).trim())
		.filter(text => text.length > 0)
		.join("\n");
}

/** Verbatim prefix of a quote, capped for cost; `truncated` lets the source string report the cut. */
function cappedQuote(text: string): { quote: string; truncated: boolean } {
	const trimmed = text.trim();
	return { quote: trimmed.slice(0, HANDOFF_QUOTE_CAP), truncated: trimmed.length > HANDOFF_QUOTE_CAP };
}

/** Judge evidence item for a handoff consultation: the quote stays verbatim even when capped. */
function handoffEvidence(kind: Evidence["kind"], source: string, text: string): Evidence {
	const { quote, truncated } = cappedQuote(text);
	return {
		kind,
		source: truncated ? `${source} (verbatim prefix, truncated at ${HANDOFF_QUOTE_CAP} characters)` : source,
		quote,
	};
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
		const { quote } = cappedQuote(item.quote);
		if (seen.has(quote)) continue;
		seen.add(quote);
		out.push({ id: `quote-${out.length + 1}`, text: quote, source: item.source });
	}
	return out;
}

type CourseCheckRead =
	| { ok: true; nextAction: CourseCheckNextAction; drifted: string[]; reasons: string[]; confidence?: number }
	| { ok: false; detail: string };

/**
 * Contract check of a course-check answer, independent of the deliberate submission path on
 * purpose: the automatic consult is advisory, and a refactor of submitted course checks must
 * never give it teeth. Same rules, same conservative reading - an unjudged, malformed,
 * out-of-set, key-mismatched, drift+continue or sub-floor answer is never a usable verdict.
 */
function readCourseCheckAnswer(
	raw: unknown,
	requirements: Array<{ id: string }>,
	confidenceFloor: number,
): CourseCheckRead {
	if (!isRecord(raw) || raw["judged"] !== true || typeof raw["nextAction"] !== "string") {
		return { ok: false, detail: "the judge returned an unjudged or malformed course_check result" };
	}
	const nextAction = raw["nextAction"];
	if (!(COURSE_CHECK_NEXT_ACTIONS as readonly string[]).includes(nextAction)) {
		return { ok: false, detail: `the judge returned an unknown next action: ${nextAction}` };
	}
	if (!isRecord(raw["onTrack"])) return { ok: false, detail: "the result carries no onTrack record" };
	const onTrack = raw["onTrack"] as Record<string, unknown>;
	const expected = requirements.map(r => r.id).sort();
	const actual = Object.keys(onTrack).sort();
	if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) {
		return {
			ok: false,
			detail: `onTrack keys must be exactly the requirement ids (${expected.join(", ")}); got ${actual.join(", ")}`,
		};
	}
	const drifted = Object.entries(onTrack)
		.filter(([, onTrackNow]) => onTrackNow !== true)
		.map(([id]) => id);
	if (drifted.length > 0 && nextAction === "continue") {
		return { ok: false, detail: `drifted requirement(s) ${drifted.join(", ")} cannot yield continue` };
	}
	const reasons = Array.isArray(raw["reasons"])
		? raw["reasons"].filter((r): r is string => typeof r === "string")
		: [];
	if (drifted.length > 0) reasons.push(`not on track: ${drifted.join(", ")}`);
	const rawConfidence = raw["confidence"];
	const confidence =
		typeof rawConfidence === "number" && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
			? rawConfidence
			: undefined;
	if (
		(nextAction === "continue" || nextAction === "verify_before_proceeding") &&
		(confidence === undefined || confidence < confidenceFloor)
	) {
		return {
			ok: false,
			detail: `confidence must be a finite 0..1 number at/above the floor ${confidenceFloor}`,
		};
	}
	return { ok: true, nextAction: nextAction as CourseCheckNextAction, drifted, reasons, confidence };
}

/** One-line fixed-template summary of a handoff record (no generated prose). */
function handoffLine(record: HandoffRecord): string {
	const verdict = record.judged ? (record.verdict ?? "unusable answer") : "not judged";
	const confidence = record.confidence !== undefined ? `, confidence ${record.confidence}` : "";
	const reasons = record.reasons.length > 0 ? ` - ${record.reasons.join(" ")}` : "";
	return `${record.phase}: ${verdict}${confidence}${reasons}`;
}

/** One-line fixed-template summary of a destructive-action record (no generated prose). */
function destructiveLine(record: DestructiveRecord): string {
	const verdict = record.judged ? (record.verdict ?? "unusable answer") : "not judged";
	const confidence = record.confidence !== undefined ? `, confidence ${record.confidence}` : "";
	const reasons = record.reasons.length > 0 ? ` - ${record.reasons.join(" ")}` : "";
	return `command matched "${record.pattern}": ${verdict}${confidence}${reasons}`;
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
