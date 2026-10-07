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
  | "refactor_check" // FR-13: capability preservation
  | "aspect_coverage"; // universal engine: forgotten-aspect three-way coverage check + FR-18 course_check (see control-points registry)

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
