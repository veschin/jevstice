/**
 * Shared contracts for the Jevstice MVP.
 *
 * `POLICY` carries the fail-closed floors: a judge error, a malformed answer and an
 * answer below the floor never approve (PRD constraint on S16). Every activity that
 * needs an approval reads its floor from here.
 */

/** Fail-closed floors, transport defaults and evidence bounds. */
export const POLICY = {
	/** Judge failure, malformed payload and uncertainty can never approve. */
	failureNeverApproves: true,
	/**
	 * Choice and score confidence below this floor never approves. Confidence is the judge's
	 * probability spread over the options ((3*p_max-1)/2 for three): 0.6 means roughly 73% of
	 * the probability mass on the approving option. Calibrated 2026-10-08 on a ground-truth
	 * domain (evidence/jev-calibration-2026-10-08.md): no false claim was ever approved at any
	 * threshold, while well-evidenced true claims measured 0.66-1.00; 0.8 cut correct answers
	 * that carry rule tension or one inference step.
	 */
	minConfidenceToApprove: 0.6,
	/** Boolean (noul) probability of the approving outcome below this floor never approves. */
	minProbabilityToApprove: 0.8,
	/** Plan-review coverage floor: the topic set as a whole (the topics keep minProbabilityToApprove). */
	minCoverageConfidence: 0.6,
	/** Blocked stop continuations for one unchanged refusal before it is recorded as an open item. */
	maxStopBlocks: 3,
	/** Consecutive availability failures before the judge is declared unavailable for the session (FR-21). */
	maxJudgeFailures: 3,
	/** Refusals of one boundary before its hold is released as an open item (FR-22, FR-23). */
	maxRefusalsPerStage: 3,
	/** Consequential calls one standing boundary may refuse before the owner is told (FR-28). */
	maxIgnoredBoundaryCalls: 3,
	/** Fragments a submitted text is split into for the text review (FR-27). */
	maxTextFragments: 12,
	/** Judged submissions kept in the ledger a repeated framing is recognised against (FR-22). */
	maxSubmissions: 24,
	/** Judge model; never substituted by another provider. */
	defaultModel: "jev-latest",
	/** Env var carrying the TypeSafe API key; never persisted, logged or echoed. */
	apiKeyEnv: "TYPESAFE_API_KEY",
	/** Additional accepted env vars for the key. */
	altApiKeyEnvs: ["JEVI_API_KEY"],
	/** Env var carrying a resolver command whose trimmed stdout is the key. */
	apiKeyCommandEnv: "TYPESAFE_API_KEY_COMMAND",
	/** Longest artifact text submitted as judge state; a longer artifact is refused, never approved unseen. */
	maxArtifactChars: 16000,
	/** Recent action results kept as evidence for the course and completion checks. */
	maxActionRecords: 5,
	/** Longest kept excerpt of one action's change material or result. */
	maxActionExcerptChars: 2000,
	/** Longest single submitted quote. */
	maxQuoteChars: 4000,
} as const;

/** Where a submitted quote comes from. */
export type EvidenceKind = "user" | "spec" | "code" | "execution" | "log" | "documentation";

/** One quoted fragment; the judge reads it as data, never as an instruction. */
export interface Evidence {
	kind: EvidenceKind;
	quote: string;
	source?: string;
}

/** The two perspectives a finished task is defended from at acceptance. */
export type Aspect = "business" | "architecture";

/**
 * The boundary names the gates read (FR-22, FR-23). A refusal is counted per boundary, and a
 * boundary whose refusal bound is exhausted is released: `plan` is the hold on consequential changes,
 * `hold` is a finding that has to be answered by a consultation.
 */
export const PLAN_BOUNDARY = "plan";
export const HOLD_BOUNDARY = "hold";

/** What a developer review looks at. */
export type ReviewKind = "checkpoint" | "commit" | "diff";

/**
 * One topic of a plan, as the executor submits it with the plan review (FR-24). The review asks one
 * question per topic, so a verdict names the topic it concerns; the paths are what the course check
 * compares a recorded action target against (FR-25).
 */
export interface PlanTopic {
	/** The id the verdict, the refusal and the course check name. */
	id: string;
	/** A verbatim section of the plan artifact that governs this topic. */
	section: string;
	/** The paths this topic changes. */
	paths: readonly string[];
	/** The requirement of the registered task this topic serves. */
	requirement: string;
}

/** One register rule a reviewed text must satisfy; the rule text is the owner's own (FR-27). */
export interface TextRule {
	/** The class the rule belongs to, such as jargon, formal register or brevity. */
	class: string;
	/** The rule line the executor submitted; the tool returns it and writes none of its own. */
	rule: string;
}

/** How often implementation is checked against the task direction. */
export interface CourseCheckConfig {
	mode: "interval" | "completion";
	interval: number;
}

/** Which boundaries are held by the extension. */
export interface GateConfig {
	mutation: boolean;
	completion: boolean;
}

/** Effective extension configuration plus the problems found while reading it. */
export interface JevConfig {
	gates: GateConfig;
	courseCheck: CourseCheckConfig;
	problems: readonly string[];
}

/**
 * Result of one activity submission.
 * `ok: true` means a well-formed judge answer was obtained (the verdict may still be a refusal);
 * `ok: false` means the submission was refused or the judge answer was unusable - never an approval.
 */
export type ToolOutcome =
	| { ok: true; text: string; details: Record<string, unknown> }
	| { ok: false; text: string; details?: Record<string, unknown> };

/** Narrow an unknown JSON value to a plain object record. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
