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
	/** Blocked stop continuations for one unchanged refusal before it is recorded as an open item. */
	maxStopBlocks: 3,
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
	/** Longest kept excerpt of one action result. */
	maxActionExcerptChars: 200,
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

/** What a developer review looks at. */
export type ReviewKind = "checkpoint" | "commit" | "diff";

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
