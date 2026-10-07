/**
 * Activities framework tests: the registry answers "what does jev do in this activity and what
 * can it answer", and a declared-but-unwired entry (or a decorative control point) fails the
 * suite instead of shipping.
 */
import { describe, expect, test } from "bun:test";
import {
	ACTIVITY_IDS,
	ACTIVITY_REGISTRY,
	CONTROLLER_CONSULTED_STAGES,
	VERDICT_ACTIONS,
	findActivityForStage,
	resolveActivityOutcome,
	stagesWithoutActivity,
	validateActivityRegistry,
	type Activity,
} from "../src/activities.js";
import { CONTROL_POINT_REGISTRY } from "../src/control-points.js";
import type { DecisionStage, DecisionVerdict } from "../src/types.js";

/** The registry with one activity replaced (a doctored declaration the validator must catch). */
function withActivity(id: string, patch: Partial<Activity>): Record<string, Activity> {
	const activity = ACTIVITY_REGISTRY[id]!;
	return { ...ACTIVITY_REGISTRY, [id]: { ...activity, ...patch } };
}

const ENGINE_VERDICTS: readonly DecisionVerdict[] = ["approve", "revise", "insufficient_evidence", "ask_user"];

describe("activity registry", () => {
	test("the six activities are declared and every declared activity maps to a wired mechanism", () => {
		expect(Object.keys(ACTIVITY_REGISTRY).sort()).toEqual([...ACTIVITY_IDS].sort());
		expect(validateActivityRegistry(ACTIVITY_REGISTRY, new Map())).toEqual([]);
	});

	test("a declared-but-unwired activity is a defect (the spec calls it one)", () => {
		const problems = validateActivityRegistry(withActivity("planning", { mechanisms: [] }), new Map());
		expect(problems.map(p => p.code)).toContain("activity_without_mechanism");
		expect(problems.find(p => p.code === "activity_without_mechanism")?.activity).toBe("planning");
	});

	test("a mechanism whose stage the engine does not know is a defect", () => {
		const problems = validateActivityRegistry(
			withActivity("development", {
				mechanisms: [
					{
						stage: "not_a_real_stage" as DecisionStage,
						wiring: ["stage"],
						outcomeEdges: [
							{ verdict: "approve", outcome: "continue" },
							{ verdict: "revise", outcome: "replan" },
							{ verdict: "insufficient_evidence", outcome: "verify_before_proceeding" },
							{ verdict: "ask_user", outcome: "ask_user" },
						],
					},
				],
			}),
			new Map(),
		);
		expect(problems.map(p => p.code)).toContain("mechanism_stage_not_registered");
		// The same registry with the real development mechanisms is clean.
		expect(validateActivityRegistry(ACTIVITY_REGISTRY, new Map())).toEqual([]);
	});

	test("a gate wiring on a point with an on_demand trigger is a defect", () => {
		const review = ACTIVITY_REGISTRY["review"]!;
		const mechanism = review.mechanisms[0]!;
		const problems = validateActivityRegistry(
			withActivity("review", { mechanisms: [{ ...mechanism, wiring: ["gate"] }] }),
			new Map(),
		);
		expect(problems.map(p => p.code)).toContain("gate_wiring_trigger_mismatch");
	});

	test("an outcome no edge can produce, and an edge outside the outcome set, are defects", () => {
		const unreachable = validateActivityRegistry(
			withActivity("completion", { outcomes: ["complete", "incomplete", "insufficient_evidence", "ask_user", "ghost"] }),
			new Map(),
		);
		expect(unreachable.map(p => p.code)).toContain("outcome_unreachable");
		expect(unreachable.map(p => p.code)).toContain("outcome_without_action");

		const completion = ACTIVITY_REGISTRY["completion"]!;
		const problems = validateActivityRegistry(
			withActivity("completion", {
				mechanisms: [
					{
						...completion.mechanisms[0]!,
						outcomeEdges: [{ verdict: "approve", outcome: "shipped" }],
					},
				],
			}),
			new Map(),
		);
		expect(problems.map(p => p.code)).toContain("edge_outcome_undeclared");
		expect(problems.map(p => p.code)).toContain("verdict_without_edge");
	});

	test("a controller-wired mechanism must name where the consult lives", () => {
		const development = ACTIVITY_REGISTRY["development"]!;
		const course = development.mechanisms.find(m => m.stage === "course_check")!;
		const problems = validateActivityRegistry(
			withActivity("development", { mechanisms: [{ ...course, consultedBy: "  " }] }),
			new Map(),
		);
		expect(problems.map(p => p.code)).toContain("controller_wiring_without_location");
	});

	test("every outcome and verdict action is inside the declared vocabulary", () => {
		for (const activity of Object.values(ACTIVITY_REGISTRY)) {
			for (const outcome of activity.outcomes) {
				expect(Object.keys(activity.verdictActions)).toContain(outcome);
				expect(VERDICT_ACTIONS).toContain(activity.verdictActions[outcome]!);
			}
			// No action may be declared for an outcome outside the fixed set.
			for (const outcome of Object.keys(activity.verdictActions)) {
				expect(activity.outcomes).toContain(outcome);
			}
		}
	});

	test("every mechanism answers every engine verdict (no silent answer)", () => {
		for (const activity of Object.values(ACTIVITY_REGISTRY)) {
			for (const mechanism of activity.mechanisms) {
				for (const verdict of ENGINE_VERDICTS) {
					expect(
						mechanism.outcomeEdges.some(e => e.verdict === verdict),
						`${activity.id}/${mechanism.stage} answers no ${verdict}`,
					).toBe(true);
				}
			}
		}
	});

	test("every registered control point belongs to an activity (no decorative mechanisms)", () => {
		expect(stagesWithoutActivity()).toEqual([]);
		// The reverse direction of the same rule: every registry stage resolves to an activity.
		for (const stage of Object.keys(CONTROL_POINT_REGISTRY)) {
			expect(findActivityForStage(stage)).toBeDefined();
		}
	});

	test("the new framework stages are claimed by the framework", () => {
		expect(findActivityForStage("requirements_formalization")?.activity.id).toBe("requirements_formalization");
		expect(findActivityForStage("plan_mapping")?.activity.id).toBe("planning");
		// A config-declared on_demand point belongs to no activity: it is not framed, only recorded.
		expect(findActivityForStage("my_checkpoint")).toBeUndefined();
	});

	test("a controller-consulted stage outside the control-point registry is declared where it is consulted", () => {
		// The catalog stages are real judge consults the controller runs itself, so they must be
		// declared as such (and a typo must not pass as one).
		expect(CONTROLLER_CONSULTED_STAGES["task_classification"]).toBe(true);
		expect(CONTROLLER_CONSULTED_STAGES["topic_selection"]).toBe(true);
		expect(findActivityForStage("task_classification")?.activity.id).toBe("task_definition");
		expect(findActivityForStage("topic_selection")?.activity.id).toBe("planning");
		expect(findActivityForStage("task_classificaton")).toBeUndefined();
	});

	test("an engine answer resolves to a declared outcome (with its action)", () => {
		const resolved = resolveActivityOutcome("completion_review", "approve", "a");
		expect(resolved).toMatchObject({ activityId: "completion", outcome: "complete", declared: true, action: "continue" });
		// course_check: only a judged continue is continue; anything else never records it.
		expect(resolveActivityOutcome("course_check", "approve", "continue")).toMatchObject({
			outcome: "continue",
			action: "continue",
		});
		expect(resolveActivityOutcome("course_check", "approve", "verify_before_proceeding")).toMatchObject({
			outcome: "verify_before_proceeding",
			action: "block",
		});
		expect(resolveActivityOutcome("course_check", "insufficient_evidence", undefined)).toMatchObject({
			outcome: "verify_before_proceeding",
			declared: true,
		});
		// An answer with no edge at all is resolved as undeclared, never guessed.
		const doctored = withActivity("development", {
			mechanisms: ACTIVITY_REGISTRY["development"]!.mechanisms.map(m =>
				m.stage === "course_check" ? { ...m, outcomeEdges: [{ verdict: "approve", outcome: "continue" }] } : m,
			),
		});
		expect(resolveActivityOutcome("course_check", "ask_user", undefined, doctored)).toMatchObject({
			outcome: "unmapped:ask_user",
			declared: false,
		});
	});

	test("an outcome outside the declared set resolves as undeclared (the signal to fail closed)", () => {
		const doctored = withActivity("planning", {
			outcomes: ["revise"],
			verdictActions: { revise: "return_to_activity" },
		});
		const resolved = resolveActivityOutcome("claim_check", "approve", undefined, doctored);
		expect(resolved).toMatchObject({ activityId: "planning", outcome: "approved", declared: false });
		expect(resolved?.action).toBeUndefined();
	});

	test("the framework spec table is represented verbatim: six activities, spec outcomes and actions", () => {
		expect(ACTIVITY_REGISTRY["task_definition"]!.outcomes).toEqual(["understood", "incomplete", "wrong", "ask_user"]);
		expect(ACTIVITY_REGISTRY["requirements_formalization"]!.outcomes).toEqual([
			"formalized",
			"item_untraceable",
			"coverage_missing",
			"ask_user",
		]);
		expect(ACTIVITY_REGISTRY["planning"]!.outcomes).toEqual([
			"approved",
			"revise",
			"insufficient_evidence",
			"ask_user",
		]);
		expect(ACTIVITY_REGISTRY["development"]!.outcomes).toEqual([
			"continue",
			"return_to_requirement",
			"replan",
			"ask_user",
			"verify_before_proceeding",
		]);
		expect(ACTIVITY_REGISTRY["review"]!.outcomes).toEqual(["accept", "rework", "escalate"]);
		expect(ACTIVITY_REGISTRY["completion"]!.outcomes).toEqual([
			"complete",
			"incomplete",
			"insufficient_evidence",
			"ask_user",
		]);
		expect(ACTIVITY_REGISTRY["completion"]!.enforcement.mode).toBe("gate");
		expect(ACTIVITY_REGISTRY["planning"]!.enforcement.mode).toBe("gate");
		expect(ACTIVITY_REGISTRY["requirements_formalization"]!.enforcement.mode).toBe("advisory");
		// Every activity states its purpose, entrance, required evidence, invariants and course mechanism.
		for (const activity of Object.values(ACTIVITY_REGISTRY)) {
			expect(activity.purpose.length).toBeGreaterThan(0);
			expect(activity.entersWhen.length).toBeGreaterThan(0);
			expect(activity.evidenceRequired.length).toBeGreaterThan(0);
			expect(activity.invariants.length).toBeGreaterThan(0);
			expect(activity.courseMechanism.length).toBeGreaterThan(0);
			expect(activity.enforcement.armedBy.length).toBeGreaterThan(0);
		}
	});
});
