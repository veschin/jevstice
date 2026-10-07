/**
 * The answer obliges (PRD section 1.1 and FR-10, the owner's own words: "если ты спросил судью и он
 * сказал переделать значит выясняй что не так и переделывай").
 *
 * These tests exist because they fail when the behaviour breaks:
 *  - a confident refusal records the reasons the judge named as the STANDING PROBLEMS of that stage
 *    and delivers them into the same session as a numbered list;
 *  - the next consultation of that stage shows the judge the problems and the declared answers
 *    verbatim, so an approve is an answer about the named problem, not a fresh reading of the work;
 *  - no approval and no pass of that stage is recorded while a standing problem is unanswered - the
 *    plan gate (even when an older approval exists), the completion gate and the course-check pass
 *    all stay shut, and the refusal names the problems again;
 *  - an approve whose submission answers every problem is recorded and clears the obligation, and
 *    nothing else clears it (an abstention, a judge error and a sub-floor answer leave it standing);
 *  - a refusal below the confidence floor, an unquantified refusal and a frame escape create no
 *    obligation at all: the fail-closed rule decides, so uncertainty is never turned into one;
 *  - a review finding is an obligation of that review stage, and the review stays advisory - no
 *    blocker, no boundary moves;
 *  - the standing problems survive a session restart and a malformed record is dropped.
 */
import { describe, expect, test } from "bun:test";
import { createJevController } from "../src/controller.js";
import { isRecord } from "../src/guards.js";
import type {
	AspectCoverageResult,
	CourseCheckResult,
	DecisionRequest,
	DecisionResult,
	Evidence,
	RefactorMarkingResult,
	ReviewAnswer,
	ReviewQuestionWire,
} from "../src/types.js";
import type { JevState } from "../src/controller.js";

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
	appended: Array<{ customType: string; data: unknown }>;
	feedback(): string;
}

function makeFakePi(): FakePiHarness {
	const handlers = new Map<string, Handler[]>();
	const sentMessages: Array<{ payload: unknown; options?: unknown }> = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const pi: FakePiHarness["pi"] = {
		on(event, handler) {
			const list = handlers.get(event);
			if (list === undefined) handlers.set(event, [handler]);
			else list.push(handler);
		},
		registerTool() {},
		appendEntry(customType, data) {
			appended.push({ customType, data });
		},
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
	return {
		pi,
		emit,
		sentMessages,
		appended,
		feedback: () =>
			sentMessages
				.map(m => (isRecord(m.payload) && typeof m.payload["content"] === "string" ? m.payload["content"] : ""))
				.join("\n"),
	};
}

function evidence(kind: Evidence["kind"], quote: string, source = "test"): Evidence {
	return { kind, source, quote };
}

const OPTIONS = [
	{ id: "a", label: "Option A", meaning: "do A" },
	{ id: "b", label: "Option B", meaning: "do B" },
];

const COURSE_OPTIONS = [
	{ id: "continue", label: "Continue", meaning: "keep going" },
	{ id: "return_to_requirement", label: "Return", meaning: "re-read requirement" },
	{ id: "replan", label: "Replan", meaning: "new plan" },
	{ id: "ask_user", label: "Ask", meaning: "escalate" },
	{ id: "verify_before_proceeding", label: "Verify", meaning: "run checks first" },
];

const PLAN_QUOTE = "Implement feature X for the dashboard";

function approve(option = "a", confidence = 0.95): DecisionResult {
	return { verdict: "approve", selectedOption: option, reasons: ["ok"], confidence };
}

/** A grounded plan-stage submission: the requirement quote appears verbatim inside the proposal. */
function planInput(overrides: Record<string, unknown> = {}) {
	return {
		stage: "understanding_review",
		task: "Implement feature X",
		proposal: `Claim: module M satisfies the requirement "${PLAN_QUOTE}".`,
		options: OPTIONS,
		evidence: [evidence("user", PLAN_QUOTE), evidence("execution", "dry-run plan output ok")],
		...overrides,
	};
}

function completionInput(overrides: Record<string, unknown> = {}) {
	return {
		stage: "completion_review",
		task: "Implement feature X",
		proposal: "Feature X is implemented: module M is added and the suite is green.",
		options: OPTIONS,
		evidence: [evidence("execution", "$ bun test - 42 passing, 0 failing"), evidence("code", "export function x() {}")],
		...overrides,
	};
}

function courseInput(overrides: Record<string, unknown> = {}) {
	return {
		stage: "course_check",
		task: "on-track check",
		proposal: "continuing the approved plan; evidence attached and checks green",
		options: COURSE_OPTIONS,
		evidence: [evidence("user", "requirement quote: implement feature X for the dashboard", "REQ")],
		...overrides,
	};
}

/** The judge stub: one scripted answer per call, recording every request it was asked. */
function scriptedJudge(answers: DecisionResult[]): { judge: (req: DecisionRequest) => Promise<DecisionResult>; calls: DecisionRequest[] } {
	const calls: DecisionRequest[] = [];
	return {
		calls,
		judge: async req => {
			calls.push(req);
			const next = answers.shift();
			if (next === undefined) throw new Error("the judge was consulted more often than scripted");
			return next;
		},
	};
}

async function startTask(harness: FakePiHarness): Promise<void> {
	await harness.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: "work task: implement feature X",
		systemPrompt: [],
	});
}

function mutationResult(v: unknown): { block?: boolean; reason?: string } {
	if (!isRecord(v)) return {};
	const out: { block?: boolean; reason?: string } = {};
	if (typeof v["block"] === "boolean") out.block = v["block"];
	if (typeof v["reason"] === "string") out.reason = v["reason"];
	return out;
}

function stopResult(v: unknown): { decision?: string; reason?: string } {
	if (!isRecord(v)) return {};
	const out: { decision?: string; reason?: string } = {};
	if (typeof v["decision"] === "string") out.decision = v["decision"];
	if (typeof v["reason"] === "string") out.reason = v["reason"];
	return out;
}

/** The host's session_stop event, emitted once. */
async function runStop(harness: FakePiHarness): Promise<{ decision?: string; reason?: string }> {
	return stopResult(
		await harness.emit("session_stop", {
			type: "session_stop",
			messages: [],
			turn_id: 1,
			session_id: "s",
			stop_hook_active: false,
		}),
	);
}

const PROBLEM_ONE = "the plan leaves the export requirement without any work";
const PROBLEM_TWO = "no acceptance check is named for the dashboard view";

describe("the answer obliges: standing problems of a confident refusal (PRD 1.1 / FR-10)", () => {
	test("a confident refusal records its named reasons and delivers them numbered into the same session", async () => {
		const harness = makeFakePi();
		const { judge } = scriptedJudge([
			{ verdict: "revise", reasons: [PROBLEM_ONE, PROBLEM_TWO], confidence: 0.91 },
		]);
		const controller = createJevController({ judge });
		controller.register(harness.pi);
		await startTask(harness);

		const refused = await controller.submitDecision(planInput());
		expect(refused.verdict).toBe("revise");

		const records = Object.entries(controller.getState().outstandingRework);
		expect(records).toHaveLength(1);
		const [key, record] = records[0]!;
		expect(key.endsWith(":understanding_review")).toBe(true);
		expect(record.problems).toEqual([PROBLEM_ONE, PROBLEM_TWO]);
		expect(record.refusals).toBe(1);
		expect(record.taskFingerprint).toBe(controller.getState().taskFingerprint);

		// The reasons reach the same session as the thing to fix, numbered, with the fix named.
		const feedback = harness.feedback();
		expect(feedback).toContain(`1. ${PROBLEM_ONE}`);
		expect(feedback).toContain(`2. ${PROBLEM_TWO}`);
		expect(feedback).toContain("answers");
		expect(feedback).toContain("выясняй что не так и переделывай");
		expect(feedback).toContain("confidence 0.91");
	});

	test("the next consult shows the judge the standing problems and the declared answers verbatim", async () => {
		const harness = makeFakePi();
		const { judge, calls } = scriptedJudge([
			{ verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.9 },
			{ verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.9 },
			approve(),
		]);
		const controller = createJevController({ judge });
		controller.register(harness.pi);
		await startTask(harness);

		await controller.submitDecision(planInput());
		const ANSWER = "the plan now adds the export module and its own test, per the requirement quote";
		await controller.submitDecision(planInput({ proposal: `Claim: the plan adds the export module.\n${PLAN_QUOTE}`, answers: [ANSWER] }));

		const second = calls[1]!;
		expect(second.proposal).toContain(PROBLEM_ONE);
		expect(second.proposal).toContain(ANSWER);
		expect(second.proposal).toContain("does the quoted evidence show every named problem resolved");
		// A submission that answered nothing reaches the judge with that visible, never as a fresh question.
		await controller.submitDecision(planInput({ proposal: `Claim: nothing changed.\n${PLAN_QUOTE}` }));
		const third = calls[2]!;
		expect(third.proposal).toContain("<not answered>");
	});

	test("no approval of the stage is recorded while a standing problem is unanswered; an answered approve is recorded and clears it", async () => {
		const harness = makeFakePi();
		const { judge } = scriptedJudge([
			{ verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.9 },
			approve(),
			approve(),
		]);
		const controller = createJevController({ judge });
		controller.register(harness.pi);
		await startTask(harness);
		await controller.submitDecision(planInput());

		// The judge approves, but the submission answers none of the standing problems: not recorded.
		const withheld = await controller.submitDecision(planInput({ proposal: `Claim: a different plan wording.\n${PLAN_QUOTE}` }));
		expect(withheld.verdict).toBe("insufficient_evidence");
		expect(withheld.reasons.join(" ")).toContain("outstanding_rework_unanswered");
		expect(withheld.reasons.join(" ")).toContain(PROBLEM_ONE);
		expect(controller.getState().approvals.some(a => a.stage === "understanding_review")).toBe(false);
		expect(harness.feedback()).toContain("approval withheld");
		// A withheld approval is real rework: the bounded budget counts the consultation it spent
		// (the changed content reset the counter first, so it stands at one).
		const boundKey = Object.keys(controller.getState().iterations)[0]!;
		expect(Object.keys(controller.getState().iterations)).toHaveLength(1);
		expect(controller.getState().iterations[boundKey]).toBe(1);
		// The obligation still stands, extended by nothing (the refusal named the same problem once).
		expect(Object.values(controller.getState().outstandingRework)[0]?.problems).toEqual([PROBLEM_ONE]);

		// Answered: the judge's own approve is recorded and is what clears the obligation.
		const approved = await controller.submitDecision(
			planInput({ proposal: `Claim: the plan now adds the export module.\n${PLAN_QUOTE}`, answers: ["the export module and its test are now in the plan"] }),
		);
		expect(approved.verdict).toBe("approve");
		expect(controller.getState().approvals.some(a => a.stage === "understanding_review")).toBe(true);
		expect(controller.getState().outstandingRework).toEqual({});
		expect(harness.feedback()).toContain("the standing problems are settled");
	});

	test("the mutation boundary stays shut on a plan-stage problem even when an older approval exists", async () => {
		const harness = makeFakePi();
		const { judge } = scriptedJudge([
			approve(),
			{ verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.93 },
			approve(),
		]);
		const controller = createJevController({ judge });
		controller.register(harness.pi);
		await startTask(harness);
		await controller.submitDecision(planInput());

		const open = mutationResult(await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} }));
		expect(open?.block).toBeUndefined();

		// The plan is re-consulted (a decision that changes the plan) and refused at 0.93.
		const refused = await controller.submitDecision(planInput({ proposal: `Claim: the plan changes the export work.\n${PLAN_QUOTE}` }));
		expect(refused.verdict).toBe("revise");

		// The older approval is still in state, and the boundary still refuses to treat it as the answer.
		expect(controller.getState().approvals.some(a => a.stage === "understanding_review")).toBe(true);
		const blocked = mutationResult(await harness.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "edit", input: {} }));
		expect(blocked?.block).toBe(true);
		expect(String(blocked?.reason)).toContain(PROBLEM_ONE);

		// Answering the problem and being approved opens it again.
		const approved = await controller.submitDecision(
			planInput({ proposal: `Claim: the plan adds the export work.\n${PLAN_QUOTE}`, answers: ["the export work is now planned"] }),
		);
		expect(approved.verdict).toBe("approve");
		expect(
			mutationResult(await harness.emit("tool_call", { type: "tool_call", toolCallId: "3", toolName: "edit", input: {} }))?.block,
		).toBeUndefined();
	});

	test("the course-check pass is not recorded while a standing problem is unanswered", async () => {
		const harness = makeFakePi();
		const { judge } = scriptedJudge([
			{ verdict: "approve", selectedOption: "return_to_requirement", reasons: ["the work drifted"], confidence: 0.9 },
			{ verdict: "approve", selectedOption: "continue", reasons: ["ok"], confidence: 0.9 },
		]);
		const controller = createJevController({ judge });
		controller.register(harness.pi);
		await startTask(harness);

		const redirect = await controller.submitDecision(courseInput());
		expect(redirect.verdict).toBe("revise");
		expect(Object.values(controller.getState().outstandingRework)[0]?.problems).toContain("the work drifted");

		// continue would satisfy the completion boundary: it is withheld, and the problems are named.
		const withheld = await controller.submitDecision(courseInput({ proposal: "continuing, nothing changed" }));
		expect(withheld.verdict).toBe("insufficient_evidence");
		expect(withheld.reasons.join(" ")).toContain("outstanding_rework_unanswered");
		expect(controller.getState().lastCourseCheck).toBeUndefined();

		// The wired per-requirement judge is bound by the same rule, and it reads the problems and
		// the declared answers verbatim beside the action under check.
		const wiredHarness = makeFakePi();
		const seen: Array<{ currentAction: string }> = [];
		const wiredAnswers: CourseCheckResult[] = [
			{ onTrack: { REQ: true }, nextAction: "return_to_requirement", reasons: ["the requirement is not served"], confidence: 0.9, judged: true },
			{ onTrack: { REQ: true }, nextAction: "continue", reasons: [], confidence: 0.9, judged: true },
		];
		const wired = createJevController({
			judge: async () => {
				throw new Error("the standard judge must not be called for a wired course_check");
			},
			courseCheckJudge: async (req: { currentAction: string }) => {
				seen.push(req);
				return wiredAnswers.shift()!;
			},
		});
		wired.register(wiredHarness.pi);
		await startTask(wiredHarness);
		const wiredRedirect = await wired.submitDecision(courseInput());
		expect(wiredRedirect.verdict).toBe("revise");
		expect(Object.values(wired.getState().outstandingRework)[0]?.problems).toContain("the requirement is not served");
		const wiredWithheld = await wired.submitDecision(courseInput({ proposal: "continuing, nothing changed" }));
		expect(wiredWithheld.verdict).toBe("insufficient_evidence");
		expect(wiredWithheld.reasons.join(" ")).toContain("outstanding_rework_unanswered");
		expect(wired.getState().lastCourseCheck).toBeUndefined();
		expect(seen).toHaveLength(2);
		expect(seen[1]?.currentAction).toContain("the requirement is not served");
		expect(seen[1]?.currentAction).toContain("<not answered>");
	});

	test("the obliged attempt still runs through the rework journal: a spent approach is refused before the judge", async () => {
		const harness = makeFakePi();
		const { judge, calls } = scriptedJudge([
			{ verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.9 },
		]);
		const controller = createJevController({ judge });
		controller.register(harness.pi);
		await startTask(harness);
		await controller.submitDecision(planInput({ approach: "tighten the trigger" }));
		expect(calls).toHaveLength(1);

		const repeated = await controller.submitDecision(
			planInput({ approach: "  Tighten the   trigger ", answers: ["answered, but with the same move"] }),
		);
		expect(repeated.verdict).toBe("insufficient_evidence");
		expect(repeated.judged).toBe(false);
		expect(repeated.reasons.join(" ")).toContain("approach_already_spent");
		expect(calls).toHaveLength(1);
	});

	test("exhausting the attempt bound does not settle the problems: only the judge's approval or an escalation does", async () => {
		const harness = makeFakePi();
		const { judge, calls } = scriptedJudge([
			{ verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.9 },
			{ verdict: "revise", reasons: [PROBLEM_TWO], confidence: 0.9 },
			{ verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.9 },
		]);
		const controller = createJevController({ judge, maxReworkIterations: 3 });
		controller.register(harness.pi);
		await startTask(harness);

		await controller.submitDecision(planInput({ approach: "tighten the trigger" }));
		await controller.submitDecision(
			planInput({ approach: "split into narrower items", answers: ["the export item is now two items"], proposal: `Claim: two narrower items.\n${PLAN_QUOTE}` }),
		);
		await controller.submitDecision(
			planInput({
				approach: "state the outcome plus the evidence",
				answers: ["the export item is planned", "the dashboard check is named"],
				proposal: `Claim: the outcome and its evidence are stated.\n${PLAN_QUOTE}`,
			}),
		);
		expect(calls).toHaveLength(3);
		const standing = Object.values(controller.getState().outstandingRework)[0]!;
		expect(standing.problems).toEqual([PROBLEM_ONE, PROBLEM_TWO]);
		expect(standing.refusals).toBe(3);

		// The bound is spent: the next attempt escalates without being judged, and the problems of a
		// refusal nobody converted into an answer stay standing - exhausting attempts settles nothing.
		const exhausted = await controller.submitDecision(
			planInput({ approach: "ask the user instead", answers: ["a", "b"], proposal: `Claim: another move.\n${PLAN_QUOTE}` }),
		);
		expect(exhausted.verdict).toBe("ask_user");
		expect(exhausted.judged).toBe(false);
		expect(calls).toHaveLength(3);
		expect(Object.values(controller.getState().outstandingRework)[0]?.problems).toEqual([PROBLEM_ONE, PROBLEM_TWO]);
		expect(controller.getState().blockers.join(" ")).toContain("rework bound exhausted");
	});

	test("a sub-floor, unquantified or escaped refusal creates no obligation: the fail-closed rule decides", async () => {
		const cases: Array<{ why: string; result: DecisionResult }> = [
			{ why: "confidence below the floor", result: { verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.5 } },
			{ why: "no confidence at all", result: { verdict: "revise", reasons: [PROBLEM_ONE] } },
			{ why: "frame escape", result: { verdict: "revise", reasons: ["meta_option", PROBLEM_ONE], confidence: 0.95 } },
			{ why: "abstention", result: { verdict: "insufficient_evidence", reasons: [PROBLEM_ONE], confidence: 0.95 } },
		];
		for (const { why, result } of cases) {
			const harness = makeFakePi();
			const { judge } = scriptedJudge([result, approve()]);
			const controller = createJevController({ judge });
			controller.register(harness.pi);
			await startTask(harness);
			await controller.submitDecision(planInput());
			expect(controller.getState().outstandingRework, why).toEqual({});
			// ... and an approve without answers is recorded exactly as before.
			const approved = await controller.submitDecision(planInput({ proposal: `Claim: a reworded plan.\n${PLAN_QUOTE}` }));
			expect(approved.verdict, why).toBe("approve");
			expect(controller.getState().approvals.some(a => a.stage === "understanding_review"), why).toBe(true);
		}
	});

	test("a review finding is an obligation of that review stage and the review stays advisory", async () => {
		const harness = makeFakePi();
		const answers: ReviewAnswer[][] = [
			[
				{ id: "outcome", kind: "score", score: 3.1, confidence: 0.62 },
				{ id: "goal_met", kind: "score", score: 4.7, confidence: 0.09 },
				{ id: "risk", kind: "choice", choice: "no_enforcement", confidence: 0.47 },
				{ id: "value_unverified", kind: "noul", noul: 0.96, confidence: 0.94 },
				{ id: "decision-1", kind: "noul", noul: 0.31 },
			],
			[
				{ id: "outcome", kind: "score", score: 6.4, confidence: 0.71 },
				{ id: "goal_met", kind: "score", score: 6.1, confidence: 0.55 },
				{ id: "risk", kind: "choice", choice: "no_enforcement", confidence: 0.44 },
				{ id: "value_unverified", kind: "noul", noul: 0.22, confidence: 0.83 },
				{ id: "decision-1", kind: "noul", noul: 0.91 },
			],
		];
		const asked: Array<{ task: string; questions: ReviewQuestionWire[] }> = [];
		const judge = async () => {
			throw new Error("a review must not use the single-decision judge");
		};
		const controller = createJevController({
			judge,
			reviewJudge: async (req: { task: string; questions: ReviewQuestionWire[] }) => {
				asked.push(req);
				const forCall = answers.shift() ?? [];
				return { judged: true, answers: forCall, reasons: [] };
			},
		});
		controller.register(harness.pi);
		await startTask(harness);
		const reviewInput = (overrides: Record<string, unknown> = {}) => ({
			stage: "business_review",
			task: "Review the product as it stands against the customer's promised outcome",
			proposal: "the product state, its customer goal and the executor's decisions, as quoted",
			options: [{ id: "no_enforcement", label: "No enforcement", meaning: "value is unverified" }],
			evidence: [
				evidence("spec", "the product's value is unverified - nothing measures whether it improves the customer's result"),
				evidence("execution", "bun test: the suite protects the behaviour, not the implementation"),
			],
			claims: ["business and architecture are agreed with the judge"],
			...overrides,
		});

		const finding = await controller.submitDecision(reviewInput());
		expect(finding.verdict).toBe("revise");
		expect(controller.getState().blockers).toEqual([]);
		expect(controller.getState().approvals).toEqual([]);
		const standing = Object.values(controller.getState().outstandingRework);
		expect(standing).toHaveLength(1);
		expect(standing[0]?.problems.join(" ")).toContain("value_unverified");

		// The next review of the stage, with no answers, is not recorded as a pass: still advisory.
		const still = await controller.submitDecision(reviewInput({ proposal: "the material as it stands, unchanged" }));
		expect(still.verdict).toBe("insufficient_evidence");
		expect(still.reasons.join(" ")).toContain("outstanding_rework_unanswered");
		expect(controller.getState().blockers).toEqual([]);
		expect(Object.values(controller.getState().outstandingRework)).toHaveLength(1);
		// The review judge was shown the finding and the missing answer, verbatim, in the request.
		expect(asked).toHaveLength(2);
		expect(asked[0]?.questions.length).toBeGreaterThan(0);
		expect(asked[1]?.task).toContain("value_unverified");
		expect(asked[1]?.task).toContain("<not answered>");
	});

	test("the standing problems survive a restart, an abstention leaves them standing, and a malformed record is dropped", async () => {
		const harness = makeFakePi();
		const { judge } = scriptedJudge([
			{ verdict: "revise", reasons: [PROBLEM_ONE], confidence: 0.9 },
			{ verdict: "insufficient_evidence", reasons: ["judge_insufficient_evidence"], confidence: 0.4 },
			approve(),
		]);
		const controller = createJevController({ judge });
		controller.register(harness.pi);
		await startTask(harness);
		await controller.submitDecision(planInput());

		const saved = harness.appended.filter(a => a.customType === "jev.state");
		expect(saved.length).toBeGreaterThan(0);
		const restartedHarness = makeFakePi();
		const restarted = createJevController({ judge: async () => approve() });
		restarted.register(restartedHarness.pi);
		restarted.onSessionStart(saved.map(a => ({ customType: a.customType, data: a.data as JevState })));
		expect(Object.values(restarted.getState().outstandingRework)[0]?.problems).toEqual([PROBLEM_ONE]);
		const withheld = await restarted.submitDecision(
			planInput({ proposal: `Claim: a reworded plan after the restart.\n${PLAN_QUOTE}` }),
		);
		expect(withheld.verdict).toBe("insufficient_evidence");
		expect(withheld.reasons.join(" ")).toContain("outstanding_rework_unanswered");

		// An abstention neither clears the record nor adds to it.
		await controller.submitDecision(planInput({ proposal: `Claim: a reworded plan.\n${PLAN_QUOTE}` }));
		expect(Object.values(controller.getState().outstandingRework)[0]?.problems).toEqual([PROBLEM_ONE]);
		expect(Object.values(controller.getState().outstandingRework)[0]?.refusals).toBe(1);
		// ... and the answered approve still clears it.
		const cleared = await controller.submitDecision(
			planInput({ proposal: `Claim: the plan adds the export work.\n${PLAN_QUOTE}`, answers: ["the export work is planned"] }),
		);
		expect(cleared.verdict).toBe("approve");
		expect(controller.getState().outstandingRework).toEqual({});

		for (const malformed of [
			{ stage: "understanding_review", problems: [], refusals: 1, at: 1 },
			{ stage: 7, problems: [PROBLEM_ONE], refusals: 1, at: 1 },
			{ stage: "understanding_review", problems: [42], refusals: 1, at: 1 },
			"not a record",
		]) {
			const fresh = createJevController({ judge: async () => approve() });
			fresh.onSessionStart([
				{
					customType: "jev.state",
					data: { outstandingRework: { "fp:understanding_review": malformed } },
				},
			]);
			expect(fresh.getState().outstandingRework).toEqual({});
		}
	});

	test("the completion boundary names a standing problem of the stop stage even with an older approval", async () => {
		const harness = makeFakePi();
		const { judge, calls } = scriptedJudge([
			approve(), // plan
			{ verdict: "approve", selectedOption: "continue", reasons: ["on track"], confidence: 0.9 }, // course_check
			approve(), // completion_review
			{ verdict: "revise", reasons: [PROBLEM_TWO], confidence: 0.9 }, // completion_review, re-consulted
		]);
		const controller = createJevController({ judge });
		controller.register(harness.pi);
		await startTask(harness);
		await controller.submitDecision(planInput());
		await controller.submitDecision(courseInput());
		await controller.submitDecision(completionInput());
		expect((await runStop(harness)).decision).toBeUndefined();

		// The same work is re-consulted and refused: the older approval does not carry the refusal.
		const refused = await controller.submitDecision(completionInput({ proposal: "the same result, re-described" }));
		expect(refused.verdict).toBe("revise");
		expect(calls).toHaveLength(4);
		const stop = await runStop(harness);
		expect(stop.decision).toBe("block");
		expect(String(stop.reason)).toContain(PROBLEM_TWO);
	});

	test("the aspect-coverage pass and the refactor-marking pass are withheld while a problem stands", async () => {
		// aspect_coverage: the gap clearance IS the pass of this stage, so it is not written.
		const aspectHarness = makeFakePi();
		const aspectAnswers: AspectCoverageResult[] = [
			{ markings: { "topic-a": "applicable_and_addressed", "topic-b": "applicable_not_addressed" }, reasons: ["b missed"], confidence: 0.9, judged: true },
			{ markings: { "topic-a": "applicable_and_addressed", "topic-b": "applicable_and_addressed" }, reasons: [], confidence: 0.9, judged: true },
		];
		const aspects = createJevController({
			judge: async () => {
				throw new Error("the standard judge must not be called");
			},
			catalogIds: new Set(["topic-a", "topic-b"]),
			aspectCoverageJudge: async () => aspectAnswers.shift()!,
		});
		aspects.register(aspectHarness.pi);
		await startTask(aspectHarness);
		const aspectInput = (overrides: Record<string, unknown> = {}) => ({
			stage: "aspect_coverage",
			task: "check the declared aspects",
			proposal: "the work as it stands",
			options: OPTIONS,
			evidence: [evidence("code", "src/dashboard.ts: the view renders the export table")],
			aspects: ["topic-a", "topic-b"],
			...overrides,
		});
		const missed = await aspects.submitDecision(aspectInput());
		expect(missed.verdict).toBe("revise");
		expect(Object.values(aspects.getState().outstandingRework)[0]?.problems.join(" ")).toContain("topic-b");
		// The judge now addresses both aspects, but the submission answered no problem: no pass.
		const withheldAspects = await aspects.submitDecision(aspectInput({ proposal: "the export table is now rendered" }));
		expect(withheldAspects.verdict).toBe("insufficient_evidence");
		expect(withheldAspects.reasons.join(" ")).toContain("outstanding_rework_unanswered");
		expect(aspects.getState().openAspectGaps?.missed).toEqual(["topic-b"]);

		// refactor_marking: a complete marking is the pass this stage records, so it is not written.
		const markingHarness = makeFakePi();
		const markings: RefactorMarkingResult[] = [
			{ markings: { "export-json": "preserved", "cli-flag": "not_evidenced" }, reasons: ["cli-flag has no material"], confidence: 0.9, judged: true },
			{ markings: { "export-json": "preserved", "cli-flag": "preserved" }, reasons: [], confidence: 0.9, judged: true },
		];
		const refactor = createJevController({
			judge: async () => approve(),
			refactorMarkingJudge: async () => markings.shift()!,
		});
		refactor.register(markingHarness.pi);
		await startTask(markingHarness);
		const inventory = {
			stage: "refactor_inventory",
			task: "Implement feature X",
			proposal: "Record the old functions this refactoring touches before the first edit.",
			options: OPTIONS,
			evidence: [evidence("user", PLAN_QUOTE)],
			inventory: [
				{ id: "export-json", name: "exportJson()", verification: "bun test tests/export.test.ts -t json" },
				{ id: "cli-flag", name: "cli --export", verification: "bun run src/cli.ts --export --dry-run" },
			],
		};
		await refactor.submitDecision(inventory);
		const markingInput = (overrides: Record<string, unknown> = {}) => ({
			stage: "refactor_marking",
			task: "Implement feature X",
			proposal: "The refactoring is done; every item was checked with its own verification.",
			options: OPTIONS,
			evidence: [evidence("user", PLAN_QUOTE)],
			inventoryMarks: [
				{ id: "export-json", evidence: [evidence("code", "export function exportJson() { return json; }")] },
				{ id: "cli-flag", evidence: [evidence("execution", "$ bun run src/cli.ts --export --dry-run: ok")] },
			],
			...overrides,
		});
		const notEvidenced = await refactor.submitDecision(markingInput());
		expect(notEvidenced.verdict).toBe("revise");
		expect(Object.values(refactor.getState().outstandingRework)[0]?.problems.join(" ")).toContain("cli-flag");
		const withheldMarking = await refactor.submitDecision(
			markingInput({ proposal: "the same refactoring, re-described for the judge" }),
		);
		expect(withheldMarking.verdict).toBe("insufficient_evidence");
		expect(withheldMarking.reasons.join(" ")).toContain("outstanding_rework_unanswered");
		// The pass marking was not written: the recorded marks are still the refused ones.
		expect(refactor.getState().lastRefactorMarking?.marks.map(m => m.outcome)).toEqual(["preserved", "not_evidenced"]);
	});

	test("a blank or malformed `answers` array is refused before any judge call", async () => {
		let called = 0;
		const controller = createJevController({
			judge: async () => {
				called++;
				return approve();
			},
		});
		const blank = await controller.submitDecision(planInput({ answers: ["   "] }));
		expect(blank.verdict).toBe("insufficient_evidence");
		expect(blank.judged).toBe(false);
		expect(blank.reasons.join(" ")).toContain("answers must be an array of non-empty strings");
		const wrongType = await controller.submitDecision(planInput({ answers: "the plan changed" }));
		expect(wrongType.verdict).toBe("insufficient_evidence");
		expect(called).toBe(0);
	});
});
