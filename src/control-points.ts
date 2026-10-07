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
 *
 * subagent_handoff (FR-11) is an on_demand preset that the controller ALSO consults itself at
 * the task-tool boundary (dispatch before_subagent_spawn, acceptance tool_result), and only
 * while the owner configures that stage: the PRD marks the policy unconfirmed (GAP:3).
 */
import type { DecisionStage } from "./types.js";

export type ControlPointTrigger = "mutation_gate" | "session_stop" | "on_demand";
export type VerdictMapping = "standard" | "course_check" | "aspect_coverage";

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
	// FR-10: the main model puts an important decision, and a finished code review, to the
	// judge through fixed options and acts on the answer. On-demand, never gate-granting.
	important_decision: {
		stage: "important_decision",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	code_review: {
		stage: "code_review",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	// FR-11 dispatch/acceptance: the controller consults the judge around a subagent handoff
	// (wired only when the owner configures the stage). On-demand, never gate-granting.
	// FR-02/FR-03: the executor asks for a routing decision; the controller applies the
	// selected skill or model. On-demand, never gate-granting.
	skill_routing: {
		stage: "skill_routing",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	model_routing: {
		stage: "model_routing",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	// FR-11: the lead agent's delegation to a task agent. The controller consults the point
	// itself at the task-tool boundary (dispatch + acceptance); the executor may also submit
	// it. Advisory: it grants no gate approval (on_demand never does) and blocks a spawn only
	// on a judged explicit negative at or above the confidence floor.
	subagent_handoff: {
		stage: "subagent_handoff",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	aspect_coverage: {
		stage: "aspect_coverage",
		trigger: "on_demand",
		verdictMapping: "aspect_coverage",
	},
	// Universal engine: several claims judged in ONE request, one verdict per claim, each
	// judged only from the quoted evidence. Advisory (on_demand never grants a gate); the
	// measured strongest regime, made first-class instead of hand-rolled per call.
	claim_check: {
		stage: "claim_check",
		trigger: "on_demand",
		verdictMapping: "standard",
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
