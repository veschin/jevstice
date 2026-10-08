/**
 * Activity registry: the frame that says which mechanism belongs where.
 *
 * The control-point registry (./control-points.ts) stays the MECHANISM: where a judge
 * consultation fires (trigger) and how its verdicts act. This module is the ACTIVITY level
 * the owner asked for: the named unit of work (task definition, requirements
 * formalization, planning, development, review, completion), each with its own purpose,
 * entrance boundary, required evidence, FIXED outcome set, invariants, outcome->action
 * mapping, enforcement mode and course-keeping mechanism.
 *
 * Nothing here is decorative: every declared activity must map to at least one wired
 * mechanism, every declared outcome must be reachable from an edge of one of its
 * mechanisms, and every mechanism stage must be known to the engine. An activity that is
 * declared but not wired is a defect and `validateActivityRegistry` reports it - the same
 * rule the control-point registry follows ("every declared point actually fires").
 *
 * The registry is data: the controller reads it to enforce outcome sets (an engine answer
 * outside an activity's declared outcome set fails closed) and the test suite reads it to
 * prove that no activity is decorative.
 */
import { CONTROL_POINT_REGISTRY, lookupControlPoint, type ControlPoint } from "./control-points.js";
import type { DecisionStage, DecisionVerdict } from "./types.js";

/** The six activities of the framework, in course order. */
export const ACTIVITY_IDS = [
	"task_definition",
	"requirements_formalization",
	"planning",
	"development",
	"review",
	"completion",
] as const;

export type ActivityId = (typeof ACTIVITY_IDS)[number];

/** What the caller does with a declared outcome (spec: verdict_actions). */
export const VERDICT_ACTIONS = [
	"continue",
	"return_to_activity",
	"replan",
	"escalate",
	"block",
] as const;

export type VerdictAction = (typeof VERDICT_ACTIONS)[number];

/**
 * How a mechanism fires:
 *  - "gate":     a registered control point whose trigger the controller enforces
 *                (mutation_gate before mutating tool calls, session_stop at the boundary);
 *  - "stage":    a registered control point the executor submits through jev_decision;
 *  - "controller": the controller consults the judge itself at a boundary (no submission),
 *                e.g. the automatic course check, the catalog checks, the destructive and
 *                hand-off boundaries.
 */
export type MechanismWiring = "gate" | "stage" | "controller";

/**
 * Judge stages the controller/reserved engine consults by itself. A "controller" wiring may
 * name a stage that is not a control point (the catalog stages), so this table is what makes
 * such a declaration verifiable: a typo is not an accepted mechanism.
 */
export const CONTROLLER_CONSULTED_STAGES: Readonly<Record<string, true>> = {
	course_check: true,
	destructive_action: true,
	subagent_handoff: true,
	completion_review: true,
	understanding_review: true,
	direction_review: true,
	skill_routing: true,
	model_routing: true,
	task_classification: true,
	topic_selection: true,
};

/** Stage names follow the registry's own pattern (a typo is never a mechanism). */
const STAGE_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * One engine answer -> one declared outcome of the activity. The first matching edge wins;
 * `option` (when present) matches the option id the engine selected. Every mechanism MUST
 * carry an option-less edge for each of the four engine verdicts, so no answer is silent.
 */
export interface OutcomeEdge {
	verdict: DecisionVerdict;
	option?: string;
	outcome: string;
}

export interface ActivityMechanism {
	stage: DecisionStage;
	wiring: readonly MechanismWiring[];
	/** Where the automatic consultation lives; required when "controller" is in wiring. */
	consultedBy?: string;
	outcomeEdges: readonly OutcomeEdge[];
}

export interface Activity {
	id: ActivityId;
	/** The one sentence this activity exists to establish. */
	purpose: string;
	/** The boundary that opens the activity. */
	entersWhen: string;
	/** What must be quoted for a judgement to be possible at all. */
	evidenceRequired: string;
	/** The fixed set of results this activity can end with. */
	outcomes: readonly string[];
	/** What must hold whatever the outcome is. */
	invariants: readonly string[];
	/** outcome -> what the caller does next. Keys are exactly `outcomes`. */
	verdictActions: Readonly<Record<string, VerdictAction>>;
	enforcement: { mode: "gate" | "advisory"; armedBy: string };
	/** How the judge keeps this activity on course. */
	courseMechanism: string;
	/** The wired mechanisms that implement the activity (never empty). */
	mechanisms: readonly ActivityMechanism[];
}

/** A mechanism whose refusal keeps the plan gate shut: planning is incomplete. */
export const PLAN_MAPPING_STAGE: DecisionStage = "plan_mapping";
/** Option ids the plan-mapping preset selects (the controller's own fixed template). */
export const PLAN_MAPPING_APPROVED_OPTION = "approved";
export const PLAN_MAPPING_INCOMPLETE_OPTION = "incomplete_mapping";
/** Option ids the formalization preset selects. */
export const FORMALIZATION_APPROVED_OPTION = "formalized";
export const FORMALIZATION_UNTRACEABLE_OPTION = "item_untraceable";
export const FORMALIZATION_COVERAGE_MISSING_OPTION = "coverage_missing";
/** Option ids the acceptance-criteria preset selects (FR-20). */
export const CRITERIA_ACCEPTED_OPTION = "criteria_accepted";
export const CRITERIA_UNBACKED_OPTION = "criterion_without_requirement_basis";
/** Option ids the priority preset selects (FR-21). */
export const PRIORITIES_RANKED_OPTION = "ranked";
export const PRIORITIES_STALE_OPTION = "stale_batch";

/**
 * The six activities. Verbatim from the framework spec (evidence/activities-framework.md);
 * the mechanisms are the registered control points and the controller-driven consults.
 */
export const ACTIVITY_REGISTRY: Readonly<Record<string, Activity>> = {
	task_definition: {
		id: "task_definition",
		purpose: "Establish what the user actually asked for, from the user's own words.",
		entersWhen: "a new task prompt (before_agent_start captures the prompt and its fingerprint)",
		evidenceRequired: "the user's words verbatim (kind user/spec)",
		outcomes: ["understood", "incomplete", "wrong", "ask_user"],
		invariants: [
			"the task is quoted, never paraphrased",
			"an abstention escalates, never blocks",
		],
		verdictActions: {
			understood: "continue",
			incomplete: "return_to_activity",
			wrong: "replan",
			ask_user: "escalate",
		},
		enforcement: {
			mode: "advisory",
			armedBy:
				"always on: the prompt capture has no switch; the plan gate covers approval when armed (gates.mutation)",
		},
		courseMechanism: "every later activity cites the requirement that authorizes the work (the captured task prompt)",
		mechanisms: [
			{
				stage: "understanding_review",
				wiring: ["gate", "stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "understood" },
					{ verdict: "revise", option: "wrong", outcome: "wrong" },
					{ verdict: "revise", outcome: "incomplete" },
					{ verdict: "insufficient_evidence", outcome: "ask_user" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "direction_review",
				wiring: ["gate", "stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "understood" },
					{ verdict: "revise", option: "wrong", outcome: "wrong" },
					{ verdict: "revise", outcome: "incomplete" },
					{ verdict: "insufficient_evidence", outcome: "ask_user" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "task_classification",
				wiring: ["controller"],
				consultedBy: "before_agent_start catalog check (controller.ts runCatalogChecks -> catalog.classifyTaskType)",
				outcomeEdges: [
					{ verdict: "approve", outcome: "understood" },
					{ verdict: "revise", outcome: "incomplete" },
					{ verdict: "insufficient_evidence", outcome: "ask_user" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
		],
	},
	requirements_formalization: {
		id: "requirements_formalization",
		purpose:
			"Turn the quoted task/spec into a numbered requirement list, each item traceable to a verbatim quote, and formalize the acceptance criteria of the accepted items.",
		entersWhen: "after task_definition, before planning (submitted with stage=requirements_formalization)",
		evidenceRequired: "user/spec quotes (kind user or spec) that state or entail the formalized requirements",
		outcomes: ["formalized", "item_untraceable", "coverage_missing", "ask_user"],
		invariants: [
			"every formalized requirement carries a verbatim quote; a requirement without a quote is refused",
			"every acceptance criterion references an accepted requirement; a criterion without one is refused",
			"the formalized list becomes the checklist every later activity is judged against",
			"never gate-granting by itself (on_demand records no approval)",
		],
		verdictActions: {
			formalized: "continue",
			item_untraceable: "return_to_activity",
			coverage_missing: "return_to_activity",
			ask_user: "escalate",
		},
		enforcement: {
			mode: "advisory",
			armedBy: "always submittable; the stage grants no gate, so there is no switch to arm",
		},
		courseMechanism:
			"the formalized list is the checklist: course_check requirements, plan_mapping ids and the completion boundary all read it",
		mechanisms: [
			{
				stage: "requirements_formalization",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", option: FORMALIZATION_APPROVED_OPTION, outcome: "formalized" },
					{ verdict: "approve", outcome: "formalized" },
					{ verdict: "revise", option: FORMALIZATION_UNTRACEABLE_OPTION, outcome: "item_untraceable" },
					{ verdict: "revise", option: FORMALIZATION_COVERAGE_MISSING_OPTION, outcome: "coverage_missing" },
					// Conservative catch-all: an unmatched refusal means the list was not accepted.
					{ verdict: "revise", outcome: "item_untraceable" },
					{ verdict: "insufficient_evidence", outcome: "ask_user" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			// FR-20: the acceptance criteria of the accepted list. A criterion the judge does not
			// accept is an item with no requirement basis behind it, so it resolves to the same
			// outcome an untraceable requirement does: the list is not accepted and the item is named.
			{
				stage: "acceptance_criteria",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", option: CRITERIA_ACCEPTED_OPTION, outcome: "formalized" },
					{ verdict: "approve", outcome: "formalized" },
					{ verdict: "revise", option: CRITERIA_UNBACKED_OPTION, outcome: "item_untraceable" },
					{ verdict: "revise", outcome: "item_untraceable" },
					{ verdict: "insufficient_evidence", outcome: "ask_user" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
		],
	},
	planning: {
		id: "planning",
		purpose:
			"Establish, before the first mutation, a plan in which every formalized requirement has work that serves it, in the order the judge sets.",
		entersWhen:
			"before the first mutation (mutation_gate) and after requirements_formalization; re-entered when a new accepted batch retires the plan mapping or the priority order",
		evidenceRequired: "the requirement list (verbatim quotes) plus the plan as a claim",
		outcomes: ["approved", "revise", "insufficient_evidence", "ask_user"],
		invariants: [
			"no mutation before an approved plan (switchable with gates.mutation)",
			"an open plan summary is not judgeable - the plan must be a claim checked against quotes",
			"a formalized requirement with no plan claim leaves planning incomplete",
			"the judge sets the order over the accepted items; the executor's work order is named against it",
		],
		verdictActions: {
			approved: "continue",
			revise: "return_to_activity",
			insufficient_evidence: "escalate",
			ask_user: "escalate",
		},
		enforcement: {
			mode: "gate",
			armedBy: "gates.mutation (default on)",
		},
		courseMechanism: "the plan must name, for each requirement, the work that serves it (plan_mapping)",
		mechanisms: [
			{
				stage: "understanding_review",
				wiring: ["gate", "stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "approved" },
					{ verdict: "revise", outcome: "revise" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "direction_review",
				wiring: ["gate", "stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "approved" },
					{ verdict: "revise", outcome: "revise" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: PLAN_MAPPING_STAGE,
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", option: PLAN_MAPPING_APPROVED_OPTION, outcome: "approved" },
					{ verdict: "approve", outcome: "approved" },
					{ verdict: "revise", option: PLAN_MAPPING_INCOMPLETE_OPTION, outcome: "revise" },
					{ verdict: "revise", outcome: "revise" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			// FR-21: the judge sets the order over the accepted requirement list; the controller
			// derives it from the judge's per-item class marks and records it with each item's
			// verbatim quote. A stale order (one that ranks a retired batch) is a planning gap.
			{
				stage: "requirement_priorities",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", option: PRIORITIES_RANKED_OPTION, outcome: "approved" },
					{ verdict: "approve", outcome: "approved" },
					{ verdict: "revise", option: PRIORITIES_STALE_OPTION, outcome: "revise" },
					{ verdict: "revise", outcome: "revise" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "claim_check",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "approved" },
					{ verdict: "revise", outcome: "revise" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "skill_routing",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "approved" },
					{ verdict: "revise", outcome: "revise" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "model_routing",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "approved" },
					{ verdict: "revise", outcome: "revise" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "topic_selection",
				wiring: ["controller"],
				consultedBy: "before_agent_start catalog check (controller.ts runCatalogChecks -> catalog.selectTopics)",
				outcomeEdges: [
					{ verdict: "approve", outcome: "approved" },
					{ verdict: "revise", outcome: "revise" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
		],
	},
	development: {
		id: "development",
		purpose: "Keep the running work inside the approved course, step by step.",
		entersWhen: "after every mutation, at step boundaries",
		evidenceRequired: "current action plus the requirement quote and progress artifacts (execution/code/log)",
		outcomes: [
			"continue",
			"return_to_requirement",
			"replan",
			"ask_user",
			"verify_before_proceeding",
		],
		invariants: [
			"an abstention is never recorded as continue",
			"only a judged continue unlocks completion",
			"an abstention never blocks the work",
		],
		verdictActions: {
			continue: "continue",
			return_to_requirement: "return_to_activity",
			replan: "replan",
			ask_user: "escalate",
			verify_before_proceeding: "block",
		},
		enforcement: {
			mode: "advisory",
			armedBy:
				"course_check is always submittable and runs automatically when courseCheck.everyMutations is set; " +
				"the destructive gate is armed by gates.destructive.patterns and the hand-off gate by stages.subagent_handoff",
		},
		courseMechanism:
			"per-requirement drift marking (course_check), deliberately at step boundaries and automatically every N mutations",
		mechanisms: [
			{
				stage: "course_check",
				wiring: ["stage", "controller"],
				consultedBy: "periodic consult on the matching successful mutating tool_result (controller.ts onTaskResult -> runAutomaticCourseCheck)",
				outcomeEdges: [
					{ verdict: "approve", option: "continue", outcome: "continue" },
					{ verdict: "approve", option: "verify_before_proceeding", outcome: "verify_before_proceeding" },
					// An approve naming no known next action never records continue.
					{ verdict: "approve", outcome: "verify_before_proceeding" },
					{ verdict: "revise", option: "return_to_requirement", outcome: "return_to_requirement" },
					{ verdict: "revise", option: "replan", outcome: "replan" },
					{ verdict: "revise", outcome: "return_to_requirement" },
					{ verdict: "insufficient_evidence", outcome: "verify_before_proceeding" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "destructive_action",
				wiring: ["controller"],
				consultedBy: "tool_call boundary for a bash command matching gates.destructive.patterns (controller.ts onDestructiveCall)",
				outcomeEdges: [
					{ verdict: "approve", outcome: "continue" },
					{ verdict: "revise", outcome: "replan" },
					{ verdict: "insufficient_evidence", outcome: "verify_before_proceeding" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "subagent_handoff",
				wiring: ["stage", "controller"],
				consultedBy: "task-tool boundary while stages.subagent_handoff is declared (controller.ts onHandoffDispatch/onTaskResult)",
				outcomeEdges: [
					{ verdict: "approve", outcome: "continue" },
					{ verdict: "revise", outcome: "return_to_requirement" },
					{ verdict: "insufficient_evidence", outcome: "verify_before_proceeding" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			// FR-13 (refactoring): the inventory of the old functions is fixed before the first edit
			// and every item is marked preserved-or-lost from its own artifact material afterwards.
			// Both are development-time mechanisms; the completion boundary is what stays shut while
			// an item carries no evidence-backed marking.
			{
				stage: "refactor_inventory",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "continue" },
					{ verdict: "revise", outcome: "return_to_requirement" },
					{ verdict: "insufficient_evidence", outcome: "verify_before_proceeding" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
			{
				stage: "refactor_marking",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "continue" },
					{ verdict: "revise", outcome: "return_to_requirement" },
					{ verdict: "insufficient_evidence", outcome: "verify_before_proceeding" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
		],
	},
	review: {
		id: "review",
		purpose: "Judge finished work against the requirement, per requirement and per capability, from the artifacts.",
		entersWhen: "on demand, and before completion",
		evidenceRequired: "code/diff quotes and execution output",
		outcomes: ["accept", "rework", "escalate"],
		invariants: [
			"the judge reads artifacts, not the author's report",
			"the review is per requirement and per capability",
		],
		verdictActions: {
			accept: "continue",
			rework: "return_to_activity",
			escalate: "escalate",
		},
		enforcement: {
			mode: "advisory",
			armedBy:
				"code_review, claim_check and aspect_coverage are always submittable and hold no gate of their own; " +
				"business_review and architecture_review (the judge's must-be activities, 0.86/0.92) and the opt-in " +
				"security_review (0.46) are submittable review stages that run the fixed question set the controller owns",
		},
		courseMechanism: "per-requirement claim markings and per-aspect coverage markings, both against quoted artifacts",
		mechanisms: [
			{
				stage: "code_review",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "accept" },
					{ verdict: "revise", outcome: "rework" },
					{ verdict: "insufficient_evidence", outcome: "escalate" },
					{ verdict: "ask_user", outcome: "escalate" },
				],
			},
			{
				stage: "important_decision",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "accept" },
					{ verdict: "revise", outcome: "rework" },
					{ verdict: "insufficient_evidence", outcome: "escalate" },
					{ verdict: "ask_user", outcome: "escalate" },
				],
			},
			{
				stage: "claim_check",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "accept" },
					{ verdict: "revise", outcome: "rework" },
					{ verdict: "insufficient_evidence", outcome: "escalate" },
					{ verdict: "ask_user", outcome: "escalate" },
				],
			},
			{
				stage: "aspect_coverage",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "accept" },
					{ verdict: "revise", outcome: "rework" },
					{ verdict: "insufficient_evidence", outcome: "escalate" },
					{ verdict: "ask_user", outcome: "escalate" },
				],
			},
			{
				stage: "business_review",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "accept" },
					{ verdict: "revise", outcome: "rework" },
					{ verdict: "insufficient_evidence", outcome: "escalate" },
					{ verdict: "ask_user", outcome: "escalate" },
				],
			},
			{
				stage: "architecture_review",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "accept" },
					{ verdict: "revise", outcome: "rework" },
					{ verdict: "insufficient_evidence", outcome: "escalate" },
					{ verdict: "ask_user", outcome: "escalate" },
				],
			},
			{
				stage: "security_review",
				wiring: ["stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "accept" },
					{ verdict: "revise", outcome: "rework" },
					{ verdict: "insufficient_evidence", outcome: "escalate" },
					{ verdict: "ask_user", outcome: "escalate" },
				],
			},
		],
	},
	completion: {
		id: "completion",
		purpose: "Establish that the task is finished, with artifact evidence for every requirement.",
		entersWhen: "session stop",
		evidenceRequired: "execution/code/log evidence per requirement plus the capability inventory",
		outcomes: ["complete", "incomplete", "insufficient_evidence", "ask_user"],
		invariants: [
			"no completion without artifact evidence; a report alone never completes",
			"the requirement list is the completion checklist",
		],
		verdictActions: {
			complete: "continue",
			incomplete: "return_to_activity",
			insufficient_evidence: "escalate",
			ask_user: "escalate",
		},
		enforcement: {
			mode: "gate",
			armedBy: "gates.completion (default on)",
		},
		courseMechanism: "the requirement list is the completion checklist checked at the stop boundary (unmetStopGates)",
		mechanisms: [
			{
				stage: "completion_review",
				wiring: ["gate", "stage"],
				outcomeEdges: [
					{ verdict: "approve", outcome: "complete" },
					{ verdict: "revise", outcome: "incomplete" },
					{ verdict: "insufficient_evidence", outcome: "insufficient_evidence" },
					{ verdict: "ask_user", outcome: "ask_user" },
				],
			},
		],
	},
};

export interface ActivityRegistryProblem {
	code: string;
	activity?: string;
	stage?: string;
	detail: string;
}

/** A registry the controller may substitute (tests inject a doctored one to prove enforcement). */
export type ActivityRegistry = Readonly<Record<string, Activity>>;

const ENGINE_VERDICTS: readonly DecisionVerdict[] = [
	"approve",
	"revise",
	"insufficient_evidence",
	"ask_user",
];

const VERDICT_ACTION_MEMBER: Readonly<Record<string, true>> = {
	continue: true,
	return_to_activity: true,
	replan: true,
	escalate: true,
	block: true,
};
const WIRING_MEMBER: Readonly<Record<string, true>> = { gate: true, stage: true, controller: true };

/**
 * Report every way the registry can be a defect: a declared activity without a wired
 * mechanism, a mechanism whose stage the engine does not know, a wiring that contradicts the
 * control point's trigger, a declared outcome no edge can produce, an outcome/action map that
 * does not match the outcome set, or an engine verdict no edge answers. An empty array means
 * every declared activity is wired and answerable.
 */
export function validateActivityRegistry(
	registry: ActivityRegistry,
	extra: ReadonlyMap<string, ControlPoint> = new Map(),
): ActivityRegistryProblem[] {
	const problems: ActivityRegistryProblem[] = [];
	const push = (code: string, detail: string, where: { activity?: string; stage?: string } = {}): void => {
		problems.push({ code, detail, ...where });
	};
	for (const id of ACTIVITY_IDS) {
		if (!(id in registry)) push("activity_missing", `activity "${id}" is not declared`, { activity: id });
	}
	for (const id of Object.keys(registry)) {
		if (!(ACTIVITY_IDS as readonly string[]).includes(id)) {
			push("activity_unknown", `"${id}" is not one of the ${ACTIVITY_IDS.length} activities`, { activity: id });
		}
	}

	for (const [id, activity] of Object.entries(registry)) {
		const outcomes = activity.outcomes ?? [];
		if (outcomes.length === 0) push("activity_without_outcomes", "the activity declares no outcome set", { activity: id });
		if (new Set(outcomes).size !== outcomes.length) {
			push("duplicate_outcome", `duplicate outcome in [${outcomes.join(", ")}]`, { activity: id });
		}
		const actions = activity.verdictActions ?? {};
		for (const outcome of outcomes) {
			if (!(outcome in actions)) {
				push("outcome_without_action", `outcome "${outcome}" has no verdict action`, { activity: id });
			}
		}
		for (const outcome of Object.keys(actions)) {
			if (!outcomes.includes(outcome)) {
				push("action_for_undeclared_outcome", `action declared for outcome "${outcome}" outside the outcome set`, {
					activity: id,
				});
			}
			if (!VERDICT_ACTION_MEMBER[actions[outcome]!]) {
				push("unknown_verdict_action", `outcome "${outcome}" maps to unknown action "${actions[outcome]}"`, {
					activity: id,
				});
			}
		}

		const mechanisms = activity.mechanisms ?? [];
		if (mechanisms.length === 0) {
			push("activity_without_mechanism", "declared activity has no wired mechanism (decorative entry)", { activity: id });
			continue;
		}
		const seenStages = new Set<string>();
		const reachable = new Set<string>();
		let hasGateWiring = false;
		for (const mechanism of mechanisms) {
			const stage = mechanism.stage;
			if (typeof stage !== "string" || !STAGE_NAME_PATTERN.test(stage)) {
				push("mechanism_stage_invalid", `mechanism stage "${String(stage)}" is not a stage name`, { activity: id });
				continue;
			}
			if (seenStages.has(stage)) {
				push("duplicate_mechanism_stage", `stage "${stage}" is declared twice in one activity`, { activity: id, stage });
				continue;
			}
			seenStages.add(stage);
			const wiring = mechanism.wiring ?? [];
			if (wiring.length === 0) {
				push("mechanism_without_wiring", `stage "${stage}" declares no wiring`, { activity: id, stage });
				continue;
			}
			for (const w of wiring) {
				if (!WIRING_MEMBER[w]) push("unknown_wiring", `stage "${stage}" declares unknown wiring "${w}"`, { activity: id, stage });
			}
			const point = lookupControlPoint(stage, extra);
			if (wiring.includes("gate")) {
				hasGateWiring = true;
				if (point === undefined) {
					push("mechanism_stage_not_registered", `gate mechanism "${stage}" is not a registered control point`, {
						activity: id,
						stage,
					});
				} else if (point.trigger !== "mutation_gate" && point.trigger !== "session_stop") {
					push(
						"gate_wiring_trigger_mismatch",
						`stage "${stage}" is wired as a gate but its trigger is "${point.trigger}"`,
						{ activity: id, stage },
					);
				}
			}
			if (wiring.includes("stage") && point === undefined) {
				push("mechanism_stage_not_registered", `submittable mechanism "${stage}" is not a registered control point`, {
					activity: id,
					stage,
				});
			}
			if (wiring.includes("controller")) {
				if (typeof mechanism.consultedBy !== "string" || mechanism.consultedBy.trim().length === 0) {
					push("controller_wiring_without_location", `stage "${stage}" claims controller wiring without consultedBy`, {
						activity: id,
						stage,
					});
				}
				if (point === undefined && CONTROLLER_CONSULTED_STAGES[stage] !== true) {
					push(
						"controller_stage_not_consulted",
						`stage "${stage}" is neither a registered control point nor a controller-consulted stage`,
						{ activity: id, stage },
					);
				}
			}

			const edges = mechanism.outcomeEdges ?? [];
			for (const verdict of ENGINE_VERDICTS) {
				if (!edges.some(e => e.verdict === verdict)) {
					push("verdict_without_edge", `stage "${stage}" answers no ${verdict}`, { activity: id, stage });
				}
			}
			for (const edge of edges) {
				if (!ENGINE_VERDICTS.includes(edge.verdict)) {
					push("unknown_edge_verdict", `stage "${stage}" has an edge for unknown verdict "${edge.verdict}"`, {
						activity: id,
						stage,
					});
				}
				if (!outcomes.includes(edge.outcome)) {
					push(
						"edge_outcome_undeclared",
						`stage "${stage}" maps to outcome "${edge.outcome}" outside the declared set [${outcomes.join(", ")}]`,
						{ activity: id, stage },
					);
					continue;
				}
				reachable.add(edge.outcome);
			}
		}
		for (const outcome of outcomes) {
			if (!reachable.has(outcome)) {
				push("outcome_unreachable", `outcome "${outcome}" is unreachable from every mechanism edge`, { activity: id });
			}
		}
		if (activity.enforcement?.mode === "gate" && !hasGateWiring) {
			push("gate_enforcement_without_gate", "enforcement is a gate but no mechanism is wired as one", { activity: id });
		}
	}
	return problems;
}

/** The activity that owns a judge stage, with the mechanism that fires it (first match wins). */
export function findActivityForStage(
	stage: string,
	registry: ActivityRegistry = ACTIVITY_REGISTRY,
): { activity: Activity; mechanism: ActivityMechanism } | undefined {
	for (const activity of Object.values(registry)) {
		for (const mechanism of activity.mechanisms ?? []) {
			if (mechanism.stage === stage) return { activity, mechanism };
		}
	}
	return undefined;
}

export interface ResolvedActivityOutcome {
	activityId: string;
	stage: string;
	/** The declared outcome the engine answer resolved to. */
	outcome: string;
	/** False when the answer is NOT inside the activity's declared outcome set -> fails closed. */
	declared: boolean;
	/** Present only for a declared outcome. */
	action?: VerdictAction;
}

/**
 * Resolve one engine answer (verdict + selected option) to the activity's declared outcome.
 * Returns undefined when no activity owns the stage (config-declared points). A resolved
 * outcome with `declared: false` is the defect the caller must fail closed on: the activity
 * cannot answer what its own mechanism just answered.
 */
export function resolveActivityOutcome(
	stage: string,
	verdict: DecisionVerdict,
	selectedOption: string | undefined,
	registry: ActivityRegistry = ACTIVITY_REGISTRY,
): ResolvedActivityOutcome | undefined {
	const found = findActivityForStage(stage, registry);
	if (found === undefined) return undefined;
	const { activity, mechanism } = found;
	const edges = mechanism.outcomeEdges ?? [];
	const edge =
		(selectedOption !== undefined
			? edges.find(e => e.verdict === verdict && e.option === selectedOption)
			: undefined) ?? edges.find(e => e.verdict === verdict && e.option === undefined);
	const outcome = edge?.outcome;
	if (outcome === undefined) {
		// No edge answers this verdict: the mechanism is not answerable here -> not declared.
		return { activityId: activity.id, stage, outcome: `unmapped:${verdict}`, declared: false };
	}
	const declared = (activity.outcomes ?? []).includes(outcome);
	return {
		activityId: activity.id,
		stage,
		outcome,
		declared,
		action: declared ? activity.verdictActions?.[outcome] : undefined,
	};
}

/**
 * Registered control-point stages no activity claims. The spec calls a declared-but-unwired
 * activity a defect; the reverse (a mechanism that belongs to no activity) is a decorative
 * control point, so the test suite asserts this stays empty.
 */
export function stagesWithoutActivity(
	registry: ActivityRegistry = ACTIVITY_REGISTRY,
	points: Readonly<Record<string, ControlPoint>> = CONTROL_POINT_REGISTRY,
): string[] {
	const claimed = new Set<string>();
	for (const activity of Object.values(registry)) {
		for (const mechanism of activity.mechanisms ?? []) claimed.add(mechanism.stage);
	}
	return Object.keys(points).filter(stage => !claimed.has(stage));
}
