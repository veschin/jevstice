/**
 * Shared contracts for Jev.
 * Owned by JevIntegrator; changes only via integrator.
 */

// ---------- Evidence (FR-15, FR-16) ----------

export type EvidenceKind =
  | "user" // direct quote from user request
  | "spec" // quote from spec / task text
  | "code" // quote from source code
  | "execution" // captured output of a run
  | "log" // log excerpt
  | "documentation"; // official docs quote with link

export interface Evidence {
  kind: EvidenceKind;
  /** Where it came from: file path, command run, doc URL, "user". */
  source: string;
  /** Verbatim quote; never paraphrase. */
  quote: string;
}

// ---------- Decision lifecycle ----------

/** Named moments where the judge is consulted. */
export type DecisionStage =
  | "task_classification" // FR-01: development / analytics / query
  | "skill_routing" // FR-02
  | "model_routing" // FR-03
  | "topic_selection" // FR-04
  | "understanding_review" // FR-05
  | "direction_review" // FR-06
  | "completion_review" // FR-07
  | "course_check" // universal engine: on-demand on-track check (advisory-to-binding)
  | "important_decision" // FR-10: main-model decision gate
  | "code_review" // FR-10: code review gate
  | "subagent_handoff" // FR-11: validate dispatch and acceptance
  | "aspect_coverage" // universal engine: forgotten-aspect three-way coverage check + FR-18 course_check (see control-points registry)
  | "destructive_action" // POLICY-DRAFT I: judge a destructive bash command at execution time, fresh (plan never covers it)
  | "claim_check" // universal engine: per-claim support marking against quoted evidence (measured decisive per-claim regime)
  | "requirements_formalization" // activities framework: numbered requirement list, each item traceable to a verbatim quote + coverage verdict
  | "acceptance_criteria" // FR-20: acceptance criteria, each referencing an accepted requirement, every criterion judged
  | "requirement_priorities" // FR-21: the judge's order over the accepted requirements, recorded with their quotes
  | "plan_mapping" // activities framework (planning): per-requirement claim that the plan serves it, marked by the claim_check path
  | "business_review" // review activity (advisory): the product as it stands against the customer's promised outcome
  | "architecture_review" // review activity (advisory): how well the implementation absorbs the next change
  | "security_review" // review activity (advisory, opt-in): per-surface attack/disclosure paths
  | "refactor_inventory" // FR-13 part (1): the old-function inventory, fixed BEFORE the first code edit of the task
  | "refactor_marking"; // FR-13 part (2): per-item preserved/lost marking after the refactoring, from attached evidence

/** Fixed option set presented to the judge (FR-08). */
export interface DecisionOption {
  id: string;
  label: string;
  /** What approving this option commits the caller to do. */
  meaning: string;
}

export interface DecisionRequest {
  stage: DecisionStage;
  /** What is being decided, in one or two sentences. */
  task: string;
  /** The proposal/result under judgment (text, plan summary, diff excerpt...). */
  proposal: string;
  /** Candidate options; for yes/no gates pass approve/revise style options. */
  options: DecisionOption[];
  /** Structured supporting material; must not be empty where evidence is required. */
  evidence: Evidence[];
}

export type DecisionVerdict =
  | "approve" // selected option is actionable
  | "revise" // proposal rejected, judge returned actionable reasons
  | "insufficient_evidence" // judge could not decide on supplied material
  | "ask_user"; // decision must be escalated, preserved for the user

export interface DecisionResult {
  verdict: DecisionVerdict;
  /** Chosen option id; present iff verdict === "approve". */
  selectedOption?: string;
  /** Judge's stated justification, verbatim or condensed per-field. */
  reasons: string[];
  /** Judge confidence 0..1 when the API returns one. */
  confidence?: number;
  /** Pre-judge evidence-quality notices (duplicate/short quotes); advisory only. */
  warnings?: string[];
  /**
   * Typed mid-band completion candidate: raw judge verdict was approve on a
   * valid non-meta option with completionConfidenceFloor <= confidence <
   * minConfidenceToApprove, stage completion_review only, and the configured
   * bar not raised. verdict stays insufficient_evidence for every other
   * consumer; only the completion controller may honor this candidate. Never
   * inferred from reason strings.
   */
  completionCandidate?: { selectedOption: string };
}

// ---------- Judge dependency ----------

/** Pure decision call. Tests inject this; production uses the real client. */
export type Judge = (request: DecisionRequest) => Promise<DecisionResult>;

/**
 * Multi-label marking (FR-04 topic selection): one Noul question per item,
 * sharded <=255 items per systemone request. approve = marking completed;
 * ids outside the requested batch are a contract violation -> insufficient_evidence.
 */
export interface MultiLabelRequest {
  stage: DecisionStage;
  task: string;
  evidence: Evidence[];
  items: { id: string; text: string }[];
}

export interface MultiLabelResult {
  verdict: DecisionVerdict;
  applicable: Record<string, boolean>;
  reasons: string[];
  confidence?: number;
}

export type MultiLabelJudge = (request: MultiLabelRequest) => Promise<MultiLabelResult>;

// ---------- Course check (FR-18) ----------

export const COURSE_CHECK_NEXT_ACTIONS = [
  "continue",
  "return_to_requirement",
  "replan",
  "ask_user",
  "verify_before_proceeding",
] as const;

export type CourseCheckNextAction = (typeof COURSE_CHECK_NEXT_ACTIONS)[number];

export interface CourseCheckRequest {
  /** Verbatim requirement statement(s) under which the executor works. */
  requirements: { id: string; quote: string }[];
  /** Current action + progress summary. */
  currentAction: string;
  /** Progress evidence (execution/code/log quotes) + requirement provenance. */
  evidence: Evidence[];
}

export interface CourseCheckResult {
  /** Per-requirement drift verdict: true = still on track. */
  onTrack: Record<string, boolean>;
  nextAction: CourseCheckNextAction;
  reasons: string[];
  confidence?: number;
  /** False when the judge could not be consulted (fail-closed, nextAction is NOT auto-continue). */
  judged: boolean;
}

export type CourseCheckJudge = (request: CourseCheckRequest) => Promise<CourseCheckResult>;

// ---------- Aspect coverage (three-way per-aspect marking; aspect_coverage preset) ----------

export type AspectMarking =
  | "applicable_and_addressed"
  | "applicable_not_addressed"
  | "not_applicable";

export interface AspectCoverageRequest {
  aspects: Array<{ id: string; text: string }>;
  currentAction: string;
  evidence: Evidence[];
  /** Capabilities declared required: not_applicable cannot satisfy (reported as applicable_not_addressed). */
  requireAll?: boolean;
}

export interface AspectCoverageResult {
  markings: Record<string, AspectMarking>;
  reasons: string[];
  confidence?: number;
  /** False when the judge could not be consulted (fail-closed; never a mapping). */
  judged: boolean;
  /** Meta-option escape: judge cannot mark this batch -> insufficient_evidence. */
  escape?: boolean;
}

export type AspectCoverageJudge = (request: AspectCoverageRequest) => Promise<AspectCoverageResult>;

// ---------- Refactor inventory (FR-13: inventory before the first edit, per-item marking after it) ----------

/** One item of the refactor inventory: an old function and the command that verifies it. */
export interface RefactorInventoryItem {
  id: string;
  /** The old function/feature this item stands for. */
  name: string;
  /** The command that verifies this function (FR-13 part 1: every item carries one). */
  verification: string;
}

/**
 * What the judge can say about one inventory item after the refactoring (FR-13 part 2):
 * preserved or lost FROM the artifact material attached to that item - or not_evidenced when
 * the attached material does not establish either (a claim is not evidence).
 */
export type RefactorMarkingOutcome = "preserved" | "lost" | "not_evidenced";

/** One inventory item with the artifact material attached to it (a code quote or a command output). */
export interface RefactorMarkingSubject extends RefactorInventoryItem {
  evidence: Evidence[];
}

export interface RefactorMarkingRequest {
  items: RefactorMarkingSubject[];
  /** What the executor says it did; context only, never evidence by itself. */
  currentAction?: string;
}

export interface RefactorMarkingResult {
  /** One marking per requested item id; empty when judged is false or the judge escaped the frame. */
  markings: Record<string, RefactorMarkingOutcome>;
  reasons: string[];
  confidence?: number;
  /** False when the judge could not be consulted (fail-closed; never a partial marking). */
  judged: boolean;
  /** Meta-option escape: the judge rejects the frame -> no marking is ever recorded. */
  escape?: boolean;
}

export type RefactorMarkingJudge = (request: RefactorMarkingRequest) => Promise<RefactorMarkingResult>;

// ---------- Claim check (per-claim support marking; claim_check preset) ----------

export interface ClaimCheckRequest {
  stage: DecisionStage;
  /** Which decision the claims belong to (context only; claims are judged from the evidence). */
  task: string;
  /** Claims under judgment (2..N), each marked against the quoted evidence. */
  claims: Array<{ id: string; text: string }>;
  evidence: Evidence[];
}

export interface ClaimCheckResult {
  /** Per-claim marking: true = the quoted evidence supports the claim as stated. */
  supported: Record<string, boolean>;
  reasons: string[];
  /** False when the judge could not be consulted (fail-closed; never a partial marking). */
  judged: boolean;
}

export type ClaimCheckJudge = (request: ClaimCheckRequest) => Promise<ClaimCheckResult>;

// ---------- Requirements formalization (per-item traceability; requirements_formalization stage) ----------

/**
 * The activity-level primitive behind `requirements_formalization`: the caller submits a
 * DRAFT numbered requirement list plus the user/spec quotes it was derived from, and the
 * judge marks, in ONE request, two things per item:
 *  - every requirement: does a quoted user/spec item state or directly entail it (traceable)?
 *  - every quote: does at least one formalized requirement capture what it demands (covered)?
 * A requirement the quotes do not entail is refused (item_untraceable); a quote no
 * requirement captures is the coverage gap (coverage_missing). Never gate-granting.
 *
 * Each submitted item also NAMES the quote id it derives from (FR-19: every item carries a
 * number and a verbatim quote). An item naming no quote, or an id that is not among the
 * submitted quotes, is refused before the judge call: there is nothing to be traceable to.
 */
export interface RequirementsFormalizationRequest {
  stage: DecisionStage;
  /** What the formalization is for (context only; items are judged from the quotes). */
  task: string;
  /** Draft numbered requirements, >= 1, ids assigned by the caller (numbered list). */
  requirements: Array<{ id: string; text: string; quoteId: string }>;
  /** The user/spec quotes the list must be traceable to and must cover (>= 1). */
  quotes: Array<{ id: string; text: string }>;
  evidence: Evidence[];
}

export interface RequirementsFormalizationResult {
  /** Requirement id -> a quoted user/spec item states or directly entails it as written. */
  traceable: Record<string, boolean>;
  /** Quote id -> at least one formalized requirement captures what the quote demands. */
  covered: Record<string, boolean>;
  reasons: string[];
  /** False when the judge could not be consulted (fail-closed; never a partial marking). */
  judged: boolean;
}

export type RequirementsFormalizationJudge = (
  request: RequirementsFormalizationRequest,
) => Promise<RequirementsFormalizationResult>;

// ---------- Acceptance criteria (FR-20: each criterion references an accepted requirement) ----------

/**
 * The primitive behind the `acceptance_criteria` stage: the caller submits, per criterion, the
 * accepted formalized requirement id it checks, and the judge marks EVERY criterion in ONE
 * request against that requirement's verbatim quote. A criterion that names no requirement, or an
 * id outside the accepted list, never reaches the judge (the controller refuses it first); a
 * partial or unmarkable answer fails closed, so no criterion without a judge mark is recorded.
 */
export interface AcceptanceCriteriaRequest {
  stage: DecisionStage;
  task: string;
  /** Criteria, >= 1, ids assigned by the caller; each names the accepted requirement it checks. */
  criteria: Array<{ id: string; requirementId: string; text: string }>;
  /** The accepted requirements, so the judge reads the referenced quote instead of guessing it. */
  requirements: Array<{ id: string; text: string; quote: string }>;
  evidence: Evidence[];
}

export interface AcceptanceCriteriaResult {
  /** Criterion id -> the referenced accepted requirement states or entails this criterion as written. */
  marked: Record<string, boolean>;
  reasons: string[];
  /** False when the judge could not be consulted (fail-closed; never a partial marking). */
  judged: boolean;
}

export type AcceptanceCriteriaJudge = (request: AcceptanceCriteriaRequest) => Promise<AcceptanceCriteriaResult>;

// ---------- Priorities (FR-21: the judge sets the order over the accepted requirements) ----------

/**
 * The fixed ordinal classes the judge chooses among, per accepted requirement. The controller
 * derives the order by sorting on this sequence, so the order is a function of the judge's marks
 * alone; the tie-break is the item's own position in the accepted list (documented, deterministic).
 */
export const PRIORITY_CLASSES = ["must_be_first", "early", "later", "last"] as const;

export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

export interface PriorityRequest {
  stage: DecisionStage;
  task: string;
  /** The accepted requirements the order must cover, each with its number and verbatim quote. */
  requirements: Array<{ id: string; text: string; quote: string }>;
  evidence: Evidence[];
}

export interface PriorityResult {
  /** Requirement id -> the class the judge assigned; one entry per requested id or judged is false. */
  classes: Record<string, PriorityClass>;
  /** Per-requirement confidence of that answer, when the API returns one. */
  confidences: Record<string, number>;
  reasons: string[];
  /** False when the judge could not be consulted (fail-closed; never a partial order). */
  judged: boolean;
}

export type PriorityJudge = (request: PriorityRequest) => Promise<PriorityResult>;

// ---------- Reviews (business / architecture / security; advisory activities) ----------

/** The three question kinds a review's fixed question set is built from. */
export type ReviewQuestionKind = "score" | "choice" | "noul";

/**
 * One question of a review's fixed set. The set is shipped with the descriptor (an owner may
 * replace it per stage through `stages.<stage>.questions`, fail-closed on anything malformed);
 * `score`/`noul` carry their rubric/criteria, `choice` carries the DECLARED candidate set so the
 * judge can never invent a candidate.
 */
export interface ReviewQuestionWire {
  id: string;
  kind: ReviewQuestionKind;
  question: string;
  /** score: the 0..N rubric levels, in order (2..10 levels). */
  rubric?: string[];
  /** noul: the fixed true/false criteria. */
  noul?: { true?: string; false?: string };
  /** choice: candidate option id -> label or null; the candidates are the caller's declared list. */
  options?: Record<string, string | null>;
}

export interface ReviewRequest {
  stage: DecisionStage;
  /** What the review is about (fixed template text; the material itself is in `evidence`). */
  task: string;
  questions: ReviewQuestionWire[];
  evidence: Evidence[];
  /** Per declared item questions only: the item texts, so the judge is not asked to guess them. */
  items?: Array<{ id: string; text: string }>;
}

export interface ReviewAnswer {
  id: string;
  kind: ReviewQuestionKind;
  /** score answers: the level value the rubric indexes. */
  score?: number;
  /** choice answers: the selected candidate id. */
  choice?: string;
  /** noul answers: the probability the statement holds. */
  noul?: number;
  confidence?: number;
}

export interface ReviewResult {
  /** False when the judge could not be consulted or the answer was unusable: never a partial review. */
  judged: boolean;
  /** One entry per requested question id, in request order; empty when judged is false. */
  answers: ReviewAnswer[];
  reasons: string[];
}

export type ReviewJudge = (request: ReviewRequest) => Promise<ReviewResult>;

// ---------- TypeSafe systemone wire types (S:API, verified from docs.typesafe.ai/api) ----------

export interface JevNoulCriteria {
  true?: string;
  false?: string;
}

export interface JevNoulQuestion {
  type: "noul";
  id: string;
  instructions: string | object | unknown[];
  criteria?: JevNoulCriteria;
}

/** criteria: option id -> description or null; REQUIRED, max 255 options. */
export interface JevChoiceQuestion {
  type: "choice";
  id: string;
  instructions: string | object | unknown[];
  criteria: Record<string, string | null>;
}

export interface JevScoreQuestion {
  type: "score";
  id: string;
  instructions: string | object | unknown[];
  criteria: string[]; // 2..10 levels
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

/** POST https://api.typesafe.ai/v1/systemone body. questions is a map keyed by id. */
export interface JevApiRequest {
  state: string | object | unknown[];
  model?: string; // default jev-latest
  questions: Record<string, JevQuestion>;
}

export interface JevAnswer {
  type: "noul" | "choice" | "score";
  noul?: number; // noul
  choice?: string; // choice: selected option id
  score?: number; // score
  legend?: Record<string, string>; // score
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevApiResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------- Policy (conservative defaults, GAP:3 documented) ----------

export const POLICY = {
  /** Judge failure/unavailable/uncertain can NEVER approve (approve only from explicit judge answer). */
  failureNeverApproves: true,
  /** Max cheap iteration loops executor<->judge before escalating (FR-12 bound). */
  maxReworkIterations: 3,
  /** Confidence below this => insufficient_evidence/ask_user, not approve. */
  minConfidenceToApprove: 0.8,
  /** Env var carrying the TypeSafe API key; never persisted to disk by Jev. */
  apiKeyEnv: "TYPESAFE_API_KEY",
  /** Endpoint; overridable via TYPESAFE_API_URL for tests. */
  apiEnv: "TYPESAFE_API_URL",
  defaultApiUrl: "https://api.typesafe.ai/v1/systemone",
  /** Model used for judge inference; never substituted by another provider. */
  defaultModel: "jev-latest",
  /** Calibration-tolerant completion: consecutive approves needed when 0.6<=conf<0.8. */
  completionConsecutiveApproves: 2,
  /** Lower confidence bound that still counts toward consecutive completion approves. */
  completionConfidenceFloor: 0.6,
} as const;
