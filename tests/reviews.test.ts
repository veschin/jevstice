/**
 * Review activities (D5): `business_review`, `architecture_review` and the opt-in
 * `security_review` are stages with the spec's fixed question sets, in advisory mode.
 *
 * These tests exist because they fail when the behaviour breaks:
 *  - the recorded result must carry the per-item verdicts (scores with their confidences, the
 *    chosen candidate, one verdict per declared item), not a summary;
 *  - a review never refuses anything and never records a gate approval or a blocker;
 *  - an abstention, a judge error and a candidate-frame escape record uncertainty with no
 *    per-item results kept;
 *  - the shipped question set is the default, an owner override replaces it, and a malformed
 *    override is refused rather than shipped;
 *  - a malformed persisted review never becomes a result after a restart.
 */
import { describe, expect, test } from "bun:test";
import { validateTemplateConfig } from "../src/config.js";
import { createJevController } from "../src/controller.js";
import { isRecord } from "../src/guards.js";
import type { JevTemplateConfig } from "../src/config.js";
import type { ReviewRecord } from "../src/reviews.js";
import type { Evidence, ReviewAnswer, ReviewQuestionWire, ReviewRequest, ReviewResult } from "../src/types.js";

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface FakePiHarness {
	pi: {
		on(event: string, handler: Handler): void;
		registerTool(tool: unknown): void;
		appendEntry(customType: string, data?: unknown): void;
		sendMessage(payload: unknown, options?: unknown): void;
	};
	emit(event: string, ev: unknown, ctx?: unknown): Promise<unknown>;
	sentMessages: Array<{ payload: unknown; options?: unknown }>;
}

function makeFakePi(): FakePiHarness {
	const handlers = new Map<string, Handler[]>();
	const sentMessages: Array<{ payload: unknown; options?: unknown }> = [];
	const pi: FakePiHarness["pi"] = {
		on(event, handler) {
			const list = handlers.get(event);
			if (list === undefined) handlers.set(event, [handler]);
			else list.push(handler);
		},
		registerTool() {},
		appendEntry() {},
		sendMessage(payload, options) {
			sentMessages.push({ payload, options });
		},
	};
	async function emit(event: string, ev: unknown, ctx?: unknown): Promise<unknown> {
		let merged: Record<string, unknown> | undefined;
		for (const handler of handlers.get(event) ?? []) {
			const result = await handler(ev, ctx);
			if (!isRecord(result)) continue;
			if (result["block"] === true) return result;
			for (const [key, value] of Object.entries(result)) {
				if (value === undefined) continue;
				merged = { ...(merged ?? {}), [key]: value };
			}
		}
		return merged;
	}
	return { pi, emit, sentMessages };
}

function evidence(kind: Evidence["kind"], quote: string, source = "test"): Evidence {
	return { kind, source, quote };
}

/** A review judge that answers the asked questions from `bank`, with sane defaults elsewhere. */
function reviewJudge(
	bank: Record<string, Partial<ReviewAnswer>>,
	asked: ReviewQuestionWire[][] = [],
): (request: ReviewRequest) => Promise<ReviewResult> {
	return async request => {
		asked.push(request.questions);
		return {
			judged: true,
			answers: request.questions.map((question): ReviewAnswer => {
				const override = bank[question.id];
				if (override !== undefined) return { id: question.id, kind: question.kind, ...override };
				if (question.kind === "score") return { id: question.id, kind: "score", score: 5, confidence: 0.5 };
				if (question.kind === "choice") {
					return { id: question.id, kind: "choice", choice: Object.keys(question.options ?? { "candidate": null })[0]! };
				}
				return { id: question.id, kind: "noul", noul: 0.9 };
			}),
			reasons: [],
		};
	};
}

const RISK_CANDIDATES = [
	{ id: "judge_reliability", label: "Judge reliability", meaning: "abstentions and unreliable transport" },
	{ id: "no_enforcement", label: "No enforcement", meaning: "nothing forces the discipline the product exists for" },
];

const DECISIONS = [
	"the gates that deadlocked were switched off by the owner",
	"requirements formalization is the spine of the workflow",
];

function businessReviewInput(overrides: Record<string, unknown> = {}) {
	return {
		stage: "business_review",
		task: "Review the product as it stands against the customer's promised outcome",
		proposal: "the product state, its customer goal and the executor's decisions, as quoted",
		options: RISK_CANDIDATES,
		evidence: [
			evidence("spec", "the product's value is unverified - nothing measures whether it improves the customer's result"),
			evidence("execution", "bun test: the suite protects the behaviour, not the implementation"),
		],
		claims: DECISIONS,
		...overrides,
	};
}

describe("review activities: the recorded result and the advisory rule", () => {
	test("a business review records scores with confidences, the chosen risk and every declared decision", async () => {
		const harness = makeFakePi();
		const asked: ReviewQuestionWire[][] = [];
		const controller = createJevController({
			judge: async () => {
				throw new Error("a review must not use the single-decision judge");
			},
			reviewJudge: reviewJudge(
				{
					outcome: { score: 3.1, confidence: 0.62 },
					goal_met: { score: 4.7, confidence: 0.09 },
					risk: { choice: "no_enforcement", confidence: 0.47 },
					value_unverified: { noul: 0.96, confidence: 0.94 },
					"decision-1": { noul: 0.33 },
					"decision-2": { noul: 0.69 },
				},
				asked,
			),
		});
		controller.register(harness.pi);
		const outcome = await controller.submitDecision(businessReviewInput());
		// The fixed statements and every declared decision were asked in ONE request.
		expect(asked).toHaveLength(1);
		expect(asked[0]?.map(q => q.id)).toEqual([
			"outcome",
			"goal_met",
			"risk",
			"value_unverified",
			"decision-1",
			"decision-2",
		]);
		const record = controller.getState().reviews["business_review"];
		expect(record?.judged).toBe(true);
		expect(record?.scores).toEqual([
			{ questionId: "outcome", score: 3.1, confidence: 0.62 },
			{ questionId: "goal_met", score: 4.7, confidence: 0.09 },
		]);
		expect(record?.choice).toEqual({
			questionId: "risk",
			optionId: "no_enforcement",
			label: "No enforcement",
			confidence: 0.47,
		});
		expect(record?.items).toEqual([
			{ questionId: "value_unverified", item: "", verdict: true, noul: 0.96, confidence: 0.94, finding: true },
			{ questionId: "decision-1", item: DECISIONS[0]!, verdict: false, noul: 0.33, finding: true },
			{ questionId: "decision-2", item: DECISIONS[1]!, verdict: true, noul: 0.69, finding: false },
		]);
		expect(record?.findings).toEqual(["value_unverified", `decision-1 ("${DECISIONS[0]!}")`]);
		// A confident negative is a finding to answer - it refuses nothing.
		expect(outcome.verdict).toBe("revise");
		expect(controller.getState().blockers).toEqual([]);
		expect(controller.getState().approvals).toEqual([]);
		expect(harness.sentMessages.some(m => JSON.stringify(m.payload).includes("value_unverified"))).toBe(true);
	});

	test("an abstaining or failing review records uncertainty and keeps no per-item result", async () => {
		const abstaining = createJevController({
			judge: async () => {
				throw new Error("not used");
			},
			reviewJudge: async () => ({ judged: false, answers: [], reasons: ["bad_payload"] }),
		});
		const abstained = await abstaining.submitDecision(businessReviewInput());
		expect(abstained.verdict).toBe("insufficient_evidence");
		expect(abstained.judged).toBe(false);
		const abstainedRecord = abstaining.getState().reviews["business_review"];
		expect(abstainedRecord?.judged).toBe(false);
		expect(abstainedRecord?.scores).toEqual([]);
		expect(abstainedRecord?.items).toEqual([]);
		expect(abstainedRecord?.findings).toEqual([]);
		expect(abstaining.getState().blockers).toEqual([]);

		const failing = createJevController({
			judge: async () => {
				throw new Error("not used");
			},
			reviewJudge: async () => {
				throw new Error("socket connection was closed unexpectedly");
			},
		});
		const failed = await failing.submitDecision(businessReviewInput());
		expect(failed.judged).toBe(false);
		expect(failing.getState().reviews["business_review"]?.judged).toBe(false);
		expect(failing.getState().reviews["business_review"]?.reasons.join(" ")).toContain("socket connection was closed");
		expect(failing.getState().blockers).toEqual([]);
	});

	test("a statement's polarity decides the finding: declared defects marked true are findings", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async () => {
				throw new Error("not used");
			},
			reviewJudge: reviewJudge({
				quality: { score: 2.32, confidence: 0.82 },
				"defect-1": { noul: 0.81 },
				"defect-2": { noul: 0.2 },
				top_change: { choice: "generalize_gates", confidence: 0.91 },
			}),
		});
		controller.register(harness.pi);
		const outcome = await controller.submitDecision({
			stage: "architecture_review",
			task: "Review how well the implementation absorbs the next change",
			proposal: "the module inventory, the test inventory, the observed duplication and the invariants",
			options: [
				{ id: "measure_value", label: "Measure value", meaning: "instrument whether the product helps" },
				{ id: "generalize_gates", label: "Generalize the gates", meaning: "one parameterised mechanism" },
			],
			evidence: [evidence("code", "controller.ts holds the gates, the presets, the state and the tool registration")],
			claims: ["one class holds the three gates", "the registries are redundant"],
		});
		const record = controller.getState().reviews["architecture_review"];
		expect(record?.scores).toEqual([{ questionId: "quality", score: 2.32, confidence: 0.82 }]);
		expect(record?.choice).toEqual({
			questionId: "top_change",
			optionId: "generalize_gates",
			label: "Generalize the gates",
			confidence: 0.91,
		});
		expect(record?.items.map(i => [i.questionId, i.verdict, i.finding])).toEqual([
			["defect-1", true, true],
			["defect-2", false, false],
		]);
		expect(record?.findings).toEqual([`defect-1 ("one class holds the three gates")`]);
		expect(outcome.verdict).toBe("revise");
		expect(controller.getState().blockers).toEqual([]);
		expect(controller.getState().approvals).toEqual([]);
	});

	test("a candidate-frame escape is a review-level uncertainty, never a finding", async () => {
		const controller = createJevController({
			judge: async () => {
				throw new Error("not used");
			},
			reviewJudge: async (request: ReviewRequest) => ({
				judged: true,
				answers: request.questions.map((question): ReviewAnswer => {
					if (question.kind === "choice") return { id: question.id, kind: "choice", choice: "ALL_OPTIONS_WRONG" };
					if (question.kind === "score") return { id: question.id, kind: "score", score: 2, confidence: 0.6 };
					return { id: question.id, kind: "noul", noul: 0.9 };
				}),
				reasons: [],
			}),
		});
		const outcome = await controller.submitDecision(businessReviewInput());
		expect(outcome.judged).toBe(false);
		expect(outcome.reasons.join(" ")).toContain("declared candidates");
		expect(controller.getState().reviews["business_review"]?.items).toEqual([]);
		expect(controller.getState().blockers).toEqual([]);
	});

	test("the shipped question set is the default; an owner override replaces it, fail-closed when malformed", async () => {
		const harness = makeFakePi();
		const asked: ReviewQuestionWire[][] = [];
		const template: JevTemplateConfig = validateTemplateConfig("test.json", {
			stages: {
				business_review: {
					questions: [
						{
							id: "custom_outcome",
							kind: "score",
							question: "How likely is the promised outcome?",
							rubric: ["no", "unlikely", "even odds", "likely", "very likely", "certain"],
						},
						{
							id: "custom_choice",
							kind: "choice",
							question: "Which declared risk is worst?",
							candidates: true,
						},
						{
							id: "custom_item",
							kind: "noul",
							perItem: true,
							question: "Is this decision right?",
							noul: { true: "right", false: "wrong" },
							findingWhen: "false",
						},
					],
				},
			},
		});
		const controller = createJevController({
			template,
			judge: async () => {
				throw new Error("not used");
			},
			reviewJudge: reviewJudge({}, asked),
		});
		controller.register(harness.pi);
		const outcome = await controller.submitDecision(
			businessReviewInput({ claims: ["the destructive gate defaults to off"] }),
		);
		expect(asked[0]?.map(q => q.id)).toEqual(["custom_outcome", "custom_choice", "custom_item-1"]);
		expect(asked[0]?.[0]?.rubric).toEqual(["no", "unlikely", "even odds", "likely", "very likely", "certain"]);
		const record = controller.getState().reviews["business_review"];
		expect(record?.scores).toEqual([{ questionId: "custom_outcome", score: 5, confidence: 0.5 }]);
		expect(outcome.verdict).toBe("approve");
		// A malformed override is refused at load, never shipped.
		expect(() =>
			validateTemplateConfig("test.json", {
				stages: { business_review: { questions: [{ id: "no_kind", question: "?" }] } },
			}),
		).toThrow(/business_review\.questions/);
	});

	test("an owner's template options replace the executor's candidates for the review's choice", async () => {
		const harness = makeFakePi();
		const asked: ReviewQuestionWire[][] = [];
		const template = validateTemplateConfig("test.json", {
			stages: {
				business_review: {
					options: [
						{ id: "tpl_risk", label: "Template risk", meaning: "the risk the owner declared" },
						{ id: "tpl_second", label: "Template second", meaning: "the owner's other declared risk" },
					],
				},
			},
		});
		const controller = createJevController({
			template,
			judge: async () => {
				throw new Error("not used");
			},
			reviewJudge: reviewJudge({}, asked),
		});
		controller.register(harness.pi);
		await controller.submitDecision(businessReviewInput());
		// The template's candidates reach the judge; the executor's declared list no longer applies.
		const choice = asked[0]?.find(q => q.kind === "choice");
		expect(Object.keys(choice?.options ?? {})).toContain("tpl_risk");
		expect(Object.keys(choice?.options ?? {})).not.toContain("judge_reliability");
	});

	test("a malformed persisted review is dropped on restore; a well-formed one is restored", () => {
		const controller = createJevController({ judge: async () => ({ verdict: "revise", reasons: [], confidence: 0.9 }) });
		const valid: ReviewRecord = {
			review: "business_review",
			stage: "business_review",
			judged: true,
			scores: [{ questionId: "outcome", score: 3.1, confidence: 0.62 }],
			choice: { questionId: "risk", optionId: "no_enforcement", label: "No enforcement", confidence: 0.47 },
			items: [{ questionId: "value_unverified", item: "", verdict: true, noul: 0.96, finding: true }],
			findings: ["value_unverified"],
			reasons: [],
			at: 1,
			taskFingerprint: undefined,
			workRevision: 0,
		};
		controller.onSessionStart([{ customType: "jev.state", data: { reviews: { business_review: valid } } }]);
		expect(controller.getState().reviews["business_review"]).toEqual(valid);
		for (const malformed of [
			{ business_review: { stage: "business_review", judged: "yes" } },
			{ business_review: { stage: "business_review", judged: true, scores: [{ questionId: "outcome", score: "high" }] } },
			{ business_review: { stage: "business_review", judged: true, items: [{ questionId: "x", verdict: "true" }] } },
		]) {
			controller.onSessionStart([{ customType: "jev.state", data: { reviews: malformed } }]);
			expect(controller.getState().reviews["business_review"]).toBeUndefined();
		}
	});
});
