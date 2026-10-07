/**
 * Declarative control-point registry: the core of the Jev decision engine.
 *
 * Jev is a universal decision-point engine for any workload; stages are PRESETS of
 * this registry. Each control point declares where it fires (trigger) and how its
 * verdicts act. Engine services - fail-closed judging, content digests, bounded
 * rework, same-session feedback - are shared by every preset.
 *
 * Triggers:
 *  - mutation_gate: consulted before mutating tool calls are allowed (plan presets).
 *  - session_stop: consulted by the session_stop gate (completion preset).
 *  - on_demand: fires only when the executor submits it via jev_decision
 *    (course_check preset; config-declared custom points are on_demand only).
 */
import type { DecisionStage } from "./types.js";

export type ControlPointTrigger = "mutation_gate" | "session_stop" | "on_demand";
export type VerdictMapping = "standard" | "course_check";

export interface ControlPoint {
	stage: DecisionStage;
	trigger: ControlPointTrigger;
	/** Fixed option id set enforced on submissions when no template override exists. */
	fixedOptionIds?: ReadonlySet<string>;
	/** Completion preset: textual reports alone are insufficient evidence. */
	requiresArtifactEvidence?: boolean;
	/** course_check preset: approve+redirect options map to revise; record-only for benign. */
	verdictMapping: VerdictMapping;
}

const COURSE_CHECK_OPTION_IDS: ReadonlySet<string> = new Set([
	"continue",
	"return_to_requirement",
	"replan",
	"ask_user",
	"verify_before_proceeding",
]);

/** Built-in presets. Every declared point actually fires; nothing is decorative. */
export const CONTROL_POINT_REGISTRY: Readonly<Record<string, ControlPoint>> = {
	understanding_review: {
		stage: "understanding_review",
		trigger: "mutation_gate",
		verdictMapping: "standard",
	},
	direction_review: {
		stage: "direction_review",
		trigger: "mutation_gate",
		verdictMapping: "standard",
	},
	completion_review: {
		stage: "completion_review",
		trigger: "session_stop",
		requiresArtifactEvidence: true,
		verdictMapping: "standard",
	},
	course_check: {
		stage: "course_check",
		trigger: "on_demand",
		fixedOptionIds: COURSE_CHECK_OPTION_IDS,
		verdictMapping: "course_check",
	},
};

export { COURSE_CHECK_OPTION_IDS };

/** Stage is submittable iff known to the registry (built-in or config-declared on_demand). */
export function isKnownStage(stage: string, extra: ReadonlyMap<string, ControlPoint>): boolean {
	return stage in CONTROL_POINT_REGISTRY || extra.has(stage);
}

/** Registry lookup across built-ins and config-declared points. */
export function lookupControlPoint(stage: string, extra: ReadonlyMap<string, ControlPoint>): ControlPoint | undefined {
	return CONTROL_POINT_REGISTRY[stage] ?? extra.get(stage);
}

const STAGE_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Validate a config-declared control point. Only on_demand custom points are accepted in
 * this pass: mutation_gate/session_stop semantics cannot be made to fire safely for
 * arbitrary user stages yet (roadmap). Throws a plain Error naming the problem; the
 * config layer wraps it into JevConfigError with the file.
 */
export function validateDeclaredControlPoint(stage: string, value: unknown): ControlPoint {
	if (!STAGE_NAME_PATTERN.test(stage)) {
		throw new Error(`control point key "${stage}" must match ${STAGE_NAME_PATTERN.source}`);
	}
	if (stage in CONTROL_POINT_REGISTRY) {
		throw new Error(`control point key "${stage}" collides with a built-in preset`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`control point "${stage}" must be an object`);
	}
	const record = value as Record<string, unknown>;
	if (record["trigger"] !== "on_demand") {
		throw new Error(
			`control point "${stage}" must declare trigger "on_demand"; ` +
				"mutation_gate/session_stop triggers for custom stages are a roadmap item",
		);
	}
	return { stage: stage as DecisionStage, trigger: "on_demand", verdictMapping: "standard" };
}
