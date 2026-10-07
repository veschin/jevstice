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
	// POLICY-DRAFT I (always_judge, 0.88): a destructive bash command (rm -rf, force push, schema
	// drop) is judged fresh at execution time, the plan never covering it. The controller consults
	// this point itself from the tool_call boundary, only while the owner configures
	// `gates.destructive.patterns`; it blocks the call only on a judged explicit negative.
	destructive_action: {
		stage: "destructive_action",
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
	// Activities framework: the requirements_formalization activity. The caller submits a
	// draft numbered requirement list plus the user/spec quotes; the judge marks every item's
	// traceability and every quote's coverage in one request. Advisory by construction
	// (on_demand never grants a gate) - its result is the checklist later activities use.
	requirements_formalization: {
		stage: "requirements_formalization",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	// Activities framework: the planning activity's per-requirement mapping. For every
	// formalized requirement the caller submits the claim that the plan serves it; the
	// claim_check path marks each claim against the quoted evidence. A requirement without a
	// submitted claim leaves planning incomplete and keeps the plan gate shut (gates.mutation).
	plan_mapping: {
		stage: "plan_mapping",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	// FR-20: the acceptance criteria of the accepted requirement list. The caller submits, per
	// criterion, the accepted requirement id it checks; a criterion naming no requirement, or an
	// id outside the accepted list, is refused before any judge call, and the judge marks every
	// criterion in one request. Advisory by construction (on_demand never grants a gate); the
	// completion boundary is what names a criterion the judge did not accept.
	acceptance_criteria: {
		stage: "acceptance_criteria",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	// FR-21: the judge's order over the accepted requirements. The controller supplies the
	// accepted list itself (the judge may not invent an item), the judge assigns a priority
	// class to every item in one request, and the controller derives the order from those marks
	// with a documented deterministic tie-break. Advisory by construction; the plan gate and the
	// stop boundary name an order that no longer ranks the accepted batch.
	requirement_priorities: {
		stage: "requirement_priorities",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	// Review activities (D5): the controller runs the review's FIXED question set itself when the
	// executor submits the stage, records the per-item results in session state and surfaces them.
	// Advisory by construction (on_demand records no gate approval and refuses nothing); the
	// descriptor of each review lives in src/gates.ts, its question set in src/reviews.ts.
	business_review: {
		stage: "business_review",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	architecture_review: {
		stage: "architecture_review",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	security_review: {
		stage: "security_review",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	// FR-13 part (1): the inventory of the old functions, each with its verification command,
	// fixed BEFORE the first code edit of the task. The controller refuses a submission that
	// arrives after the first edit (an inventory written afterwards cannot establish what
	// existed before the refactoring), records the inventory in session state and delivers the
	// item list back into the session. No judge consult: the declaration itself is not a
	// question; the marking below is what is judged.
	refactor_inventory: {
		stage: "refactor_inventory",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
	// FR-13 part (2): every inventory item marked preserved/lost AFTER the refactoring from the
	// artifact material attached to that item (a code quote or a command output). Advisory like
	// the other on_demand presets - it grants no gate approval; the completion boundary
	// (session_stop) is what stays shut while an item carries no evidence-backed marking.
	refactor_marking: {
		stage: "refactor_marking",
		trigger: "on_demand",
		verdictMapping: "standard",
	},
};

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
