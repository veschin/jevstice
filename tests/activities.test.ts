import { describe, expect, test } from "bun:test";
import {
	acceptance,
	completionCheck,
	consult,
	courseCheck,
	planReview,
	requirements,
	review,
	searchRelevance,
	triage,
	type ActivityDeps,
} from "../src/activities.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { mutationGate, proposeGate } from "../src/gates.js";
import { acceptanceAt, freshState, recordAction, registerTask, sha256 } from "../src/state.js";
import { POLICY } from "../src/types.js";
import { answeringJudge, failingJudge, type FakeAnswer } from "./helpers.js";

/** Activity dependencies over a fake judge table and an optional artifact reader. */
function depsFor(table: Record<string, FakeAnswer>, readArtifact?: ActivityDeps["readArtifact"]) {
	const fake = answeringJudge(table);
	const deps: ActivityDeps = { judge: fake.judge, config: DEFAULT_CONFIG, readArtifact };
	return { deps, calls: fake.calls };
}

const PLAN_URL = "local://coverage-report-plan.md";
const PLAN_BODY = "# Coverage report\n\n1. Collect the numbers\n";

function planReader(body: string | null): ActivityDeps["readArtifact"] {
	return async url => (url === PLAN_URL ? body : null);
}

describe("T2 - triage decides whether the deeper activities apply (FR-01, FR-02, FR-10)", () => {
	test("FR-01: a development request registers the task and returns only the narrow topics the judge selected", async () => {
		const { deps } = depsFor({
			needs_development: { probability: 0.94 },
			topic_1: { probability: 0.93 },
			topic_2: { probability: 0.07 },
		});
		const state = freshState();

		const outcome = await triage(deps, state, {
			request: "Keep the report available while a node fails",
			topics: ["high availability", "general"],
			evidence: [{ kind: "user", quote: "keep the report available" }],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("high availability");
		expect(outcome.text).not.toContain("general");
		expect(outcome.details?.["needsDevelopment"]).toBe(true);
		expect(state.task?.request).toBe("Keep the report available while a node fails");
		expect(mutationGate(state, DEFAULT_CONFIG, "write", { path: "src/a.ts" }).block).toBe(true);
	});

	test("FR-02: a simple request names the skipped activities and registers no task", async () => {
		const { deps } = depsFor({ needs_development: { probability: 0.04 } });
		const state = freshState();

		const outcome = await triage(deps, state, { request: "Search the web for the release date of the library" });

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("simple task");
		expect(outcome.text).toContain("plan review");
		expect(outcome.text).toContain("course checks");
		expect(outcome.text).toContain("architecture acceptance");
		expect(state.task).toBeUndefined();
		expect(mutationGate(state, DEFAULT_CONFIG, "write", { path: "src/a.ts" }).block).toBe(false);
	});

	test("FR-02: an answer the judge cannot settle is refused and registers nothing", async () => {
		const { deps } = depsFor({ needs_development: { probability: 0.5 } });
		const state = freshState();

		const outcome = await triage(deps, state, { request: "Something in between" });

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("did not settle");
		expect(state.task).toBeUndefined();
	});

	test("a failing judge registers no development task", async () => {
		const state = freshState();
		const deps: ActivityDeps = { judge: failingJudge("socket reset"), config: DEFAULT_CONFIG };

		const outcome = await triage(deps, state, { request: "Build the thing" });

		expect(outcome.ok).toBe(false);
		expect(state.task).toBeUndefined();
	});

	test("a request without text is refused before any judge call", async () => {
		const { deps, calls } = depsFor({});

		const outcome = await triage(deps, freshState(), { request: "   " });

		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe("T2 - search relevance returns the submitted candidate-and-reason pair (FR-03)", () => {
	test("FR-03: the selected candidate comes back with the executor's own reason, judged from the submitted material", async () => {
		const { deps, calls } = depsFor({ candidate: { label: "candidate_2", confidence: 0.92 } });

		const outcome = await searchRelevance(deps, freshState(), {
			query: "how to report node failure",
			candidates: [
				{ title: "Generic blog", evidence: "a post about uptime", reason: "it mentions nodes" },
				{ title: "Failure playbook", evidence: "the runbook for node loss", reason: "it describes exactly this report step" },
			],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("Failure playbook");
		expect(outcome.text).toContain("it describes exactly this report step");
		expect(outcome.details?.["reason"]).toBe("it describes exactly this report step");
		expect(JSON.stringify(calls[0]?.state)).toContain("it mentions nodes");
	});

	test("FR-03: fewer than two candidates and a candidate without a submitted reason are refused", async () => {
		const { deps, calls } = depsFor({ candidate: { label: "candidate_1" } });

		expect((await searchRelevance(deps, freshState(), { query: "x", candidates: [{ title: "one", evidence: "e", reason: "r" }] })).ok).toBe(false);
		const withoutReason = await searchRelevance(deps, freshState(), {
			query: "x",
			candidates: [
				{ title: "one", evidence: "e", reason: "r" },
				{ title: "two", evidence: "e" },
			],
		});
		expect(withoutReason.ok).toBe(false);
		expect(withoutReason.text).toContain("candidate 2");
		expect(calls).toHaveLength(0);
	});

	test("FR-03: a selection below the confidence floor is unusable, not a selection", async () => {
		const { deps } = depsFor({ candidate: { label: "candidate_1", confidence: POLICY.minConfidenceToApprove - 0.1 } });

		const outcome = await searchRelevance(deps, freshState(), {
			query: "x",
			candidates: [
				{ title: "one", evidence: "e1", reason: "r1" },
				{ title: "two", evidence: "e2", reason: "r2" },
			],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("below the");
	});

	test("FR-03: the judge is offered a none-relevant option, and choosing it selects no candidate", async () => {
		const { deps, calls } = depsFor({ candidate: { label: "none_relevant", confidence: 0.91 } });

		const outcome = await searchRelevance(deps, freshState(), {
			query: "x",
			candidates: [
				{ title: "one", evidence: "e1", reason: "r1" },
				{ title: "two", evidence: "e2", reason: "r2" },
			],
		});

		expect(calls[0]?.questions[0]?.options?.["none_relevant"]).toBeDefined();
		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("no submitted candidate");
		expect(outcome.details?.["selected"]).toBeNull();
	});

	test("FR-03: choosing none below the floor is unusable, not a vote for a candidate", async () => {
		const { deps } = depsFor({ candidate: { label: "none_relevant", confidence: POLICY.minConfidenceToApprove - 0.2 } });

		const outcome = await searchRelevance(deps, freshState(), {
			query: "x",
			candidates: [
				{ title: "one", evidence: "e1", reason: "r1" },
				{ title: "two", evidence: "e2", reason: "r2" },
			],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("below the");
	});
});

describe("T3 - requirement planning: per item, coverage and omitted needs (FR-04, FR-05, FR-06)", () => {
	test("FR-05, FR-06: supported items, a rejected item and an omitted owner need are reported separately", async () => {
		const { deps, calls } = depsFor({
			coverage: { probability: 0.12 },
			item_1: { probability: 0.95 },
			item_2: { probability: 0.06 },
			need_1: { probability: 0.91 },
		});
		const state = freshState();

		const outcome = await requirements(deps, state, {
			request: "Report the coverage of the last run and mail the summary",
			items: [
				{ text: "the report lists coverage per file", source: "report the coverage of the last run" },
				{ text: "the report also renders a chart", source: "report the coverage of the last run" },
			],
			candidateNeeds: ["the summary must be mailed to the owner"],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("item_1 supported");
		expect(outcome.text).toContain("item_2 rejected");
		expect(outcome.text).toContain("coverage: NOT established");
		expect(outcome.text).toContain("the summary must be mailed to the owner");
		expect(outcome.details?.["uncoveredNeeds"]).toEqual(["the summary must be mailed to the owner"]);
		expect(state.task?.request).toBe("Report the coverage of the last run and mail the summary");
		// The original request is submitted as a user quote, so the check is against the request itself.
		expect(JSON.stringify(calls[0]?.state)).toContain("[user]");
	});

	test("FR-06: coverage that is not established without candidate needs asks for them by name", async () => {
		const { deps } = depsFor({ coverage: { probability: 0.1 }, item_1: { probability: 0.9 } });

		const outcome = await requirements(deps, freshState(), {
			request: "Report the coverage",
			items: [{ text: "the report lists coverage", source: "report the coverage" }],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("candidateNeeds");
		expect(outcome.details?.["covered"]).toBe(false);
	});

	test("FR-05: an item without the quote it derives from is refused before any judge call", async () => {
		const { deps, calls } = depsFor({});

		const outcome = await requirements(deps, freshState(), {
			request: "Report the coverage",
			items: [{ text: "the report lists coverage" }],
		});

		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("FR-06: a settled coverage and every item supported is reported as established", async () => {
		const { deps } = depsFor({ coverage: { probability: 0.96 }, item_1: { probability: 0.97 } });
		const state = freshState();

		const outcome = await requirements(deps, state, {
			request: "Report the coverage",
			items: [{ text: "the report lists coverage", source: "report the coverage" }],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("coverage: established");
		expect(outcome.details?.["covered"]).toBe(true);
	});
});

describe("T1 - the flexible consultation (FR-08, FR-09, FR-13)", () => {
	test("FR-08: choice, score and boolean each return their typed answer with the reported confidence", async () => {
		const choice = depsFor({ consult: { label: "keep", confidence: 0.9 } });
		const choiceOutcome = await consult(choice.deps, freshState(), {
			mode: "choice",
			question: "Should the parser be replaced?",
			context: "the parser is stable but slow",
			alternatives: [
				{ label: "keep", meaning: "keep the parser and optimise it" },
				{ label: "replace", meaning: "rewrite the parser" },
			],
		});
		expect(choiceOutcome.ok).toBe(true);
		expect(choiceOutcome.details?.["label"]).toBe("keep");
		expect(choiceOutcome.text).toContain("keep the parser and optimise it");

		const score = depsFor({ consult: { score: 1.4, confidence: 0.88 } });
		const scoreOutcome = await consult(score.deps, freshState(), {
			mode: "score",
			question: "How risky is the change?",
			context: "one call site, covered by tests",
			criteria: ["no risk", "small risk", "large risk"],
		});
		expect(scoreOutcome.ok).toBe(true);
		expect(scoreOutcome.details?.["score"]).toBeCloseTo(1.4);
		expect(scoreOutcome.text).toContain("small risk");

		const boolean = depsFor({ consult: { probability: 0.9 } });
		const booleanOutcome = await consult(boolean.deps, freshState(), {
			mode: "boolean",
			question: "Is the evidence enough to proceed?",
			context: "three runs pass",
			trueMeaning: "proceed",
			falseMeaning: "gather more evidence",
		});
		expect(booleanOutcome.ok).toBe(true);
		expect(booleanOutcome.details?.["verdict"]).toBe("yes");
	});

	test("FR-13: a judge-supported corrective consultation clears the finding that held the gate, an unusable one does not", async () => {
		const usable = depsFor({ consult: { label: "fix", confidence: 0.9 }, resolves_hold: { probability: 0.93 } });
		const state = freshState();
		state.hold = { reason: "the course check answered off_course" };

		const cleared = await consult(usable.deps, state, {
			mode: "choice",
			question: "How does the work return to the registered direction?",
			context: "the last three actions left the task; the finding is off_course",
			alternatives: [
				{ label: "fix", meaning: "return to the registered task" },
				{ label: "change", meaning: "change the direction" },
			],
		});

		expect(cleared.ok).toBe(true);
		expect(state.hold).toBeUndefined();

		state.hold = { reason: "the course check answered off_course" };
		const weak = depsFor({ consult: { label: "fix", confidence: POLICY.minConfidenceToApprove - 0.2 }, resolves_hold: { probability: 0.93 } });
		const weakOutcome = await consult(weak.deps, state, {
			mode: "choice",
			question: "Is the direction right?",
			context: "unclear",
			alternatives: [
				{ label: "fix", meaning: "return to the registered task" },
				{ label: "change", meaning: "change the direction" },
			],
		});

		expect(weakOutcome.ok).toBe(false);
		expect(state.hold).toBeDefined();
	});

	test("FR-13: an unrelated consultation never clears a finding, however usable its own answer", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://x-plan.md", planDigest: "d", confidence: 0.9 };
		state.hold = { reason: 'the course check at revision 2 answered "off_course" (confidence 0.91)' };

		const unrelated = depsFor({ consult: { label: "tabs", confidence: 0.92 }, resolves_hold: { probability: 0.08 } });
		const outcome = await consult(unrelated.deps, state, {
			mode: "choice",
			question: "Which indentation should the new module use?",
			context: "style only; the direction is unchanged",
			alternatives: [
				{ label: "tabs", meaning: "indent with tabs" },
				{ label: "spaces", meaning: "indent with spaces" },
			],
		});

		expect(outcome.ok).toBe(true);
		expect(state.hold).toBeDefined();
		expect(mutationGate(state, DEFAULT_CONFIG, "write", { path: "src/a.ts" }).block).toBe(true);
	});

	test("FR-13: a negative answer does not clear a finding either", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.hold = { reason: "the developer review answered defect" };

		const negative = depsFor({ consult: { probability: 0.03 }, resolves_hold: { probability: 0.1 } });
		const outcome = await consult(negative.deps, state, {
			mode: "boolean",
			question: "Should the work continue as it stands?",
			context: "the review found a defect",
			trueMeaning: "continue",
			falseMeaning: "the defect stands",
		});

		expect(outcome.ok).toBe(true);
		expect(state.hold).toBeDefined();
	});

	test("FR-09: a consultation without alternatives, context or a judge answer is refused", async () => {
		const { deps, calls } = depsFor({});

		expect((await consult(deps, freshState(), { mode: "choice", question: "q", context: "c", alternatives: [{ label: "one", meaning: "m" }] })).ok).toBe(false);
		expect((await consult(deps, freshState(), { mode: "choice", question: "q", context: "", alternatives: [{ label: "one", meaning: "m" }, { label: "two", meaning: "m" }] })).ok).toBe(false);
		expect(calls).toHaveLength(0);

		const failing: ActivityDeps = { judge: failingJudge("the judge call failed (socket reset)"), config: DEFAULT_CONFIG };
		const outcome = await consult(failing, freshState(), {
			mode: "boolean",
			question: "q",
			context: "c",
			trueMeaning: "yes",
			falseMeaning: "no",
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("socket reset");
	});
});

describe("T3 - the plan review binds the approval to the artifact (FR-07)", () => {
	test("FR-07: an approved artifact approves this task and this artifact only", async () => {
		const { deps, calls } = depsFor({ plan: { label: "serves", confidence: 0.93 } }, planReader(PLAN_BODY));
		const state = freshState();
		const task = registerTask(state, "Report the coverage of the last run");

		const outcome = await planReview(deps, state, {
			plan: PLAN_URL,
			claim: "the plan delivers the coverage report requirement",
			evidence: [{ kind: "user", quote: "report the coverage of the last run" }],
		});

		expect(outcome.ok).toBe(true);
		expect(state.plan?.planUrl).toBe(PLAN_URL);
		expect(state.plan?.planDigest).toBe(sha256(PLAN_BODY));
		expect(state.plan?.taskFingerprint).toBe(task.fingerprint);
		expect(proposeGate(state, DEFAULT_CONFIG, { path: "xd://propose", content: "coverage-report" }).block).toBe(false);
		expect(proposeGate(state, DEFAULT_CONFIG, { path: "xd://propose", content: "another-plan" }).block).toBe(true);
		// The artifact text reaches the judge as material, not as a caller-supplied summary.
		expect(JSON.stringify(calls[0]?.state)).toContain("Collect the numbers");
	});

	test("FR-07: an artifact that cannot be read binds nothing", async () => {
		const { deps, calls } = depsFor({ plan: { label: "serves", confidence: 0.93 } }, planReader(null));
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");

		const outcome = await planReview(deps, state, {
			plan: PLAN_URL,
			claim: "the plan delivers the requirement",
			evidence: [{ kind: "user", quote: "report the coverage" }],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain(PLAN_URL);
		expect(state.plan).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("FR-07: a revise verdict records no approval and the proposal stays held", async () => {
		const { deps } = depsFor({ plan: { label: "revise", confidence: 0.9 } }, planReader(PLAN_BODY));
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");

		const outcome = await planReview(deps, state, {
			plan: PLAN_URL,
			claim: "the plan delivers the requirement",
			evidence: [{ kind: "user", quote: "report the coverage" }],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("No plan approval is recorded");
		expect(state.plan).toBeUndefined();
		expect(proposeGate(state, DEFAULT_CONFIG, { path: "xd://propose", content: "coverage-report" }).block).toBe(true);
	});

	test("FR-07: a plan longer than the submitted limit is refused before the judge sees it", async () => {
		const long = `# plan\n${"x".repeat(POLICY.maxArtifactChars)}`;
		const { deps, calls } = depsFor({ plan: { label: "serves", confidence: 0.93 } }, async () => long);
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");

		const outcome = await planReview(deps, state, {
			plan: PLAN_URL,
			claim: "the plan delivers the requirement",
			evidence: [{ kind: "user", quote: "report the coverage" }],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain(String(POLICY.maxArtifactChars));
		expect(calls).toHaveLength(0);
		expect(state.plan).toBeUndefined();
	});

	test("FR-07: a plan review before the task is registered, or without quotes, is refused", async () => {
		const { deps, calls } = depsFor({ plan: { label: "serves" } }, planReader(PLAN_BODY));

		expect((await planReview(deps, freshState(), { plan: PLAN_URL, claim: "c", evidence: [{ kind: "user", quote: "q" }] })).ok).toBe(false);

		const state = freshState();
		registerTask(state, "task");
		expect((await planReview(deps, state, { plan: PLAN_URL, claim: "c", evidence: [] })).ok).toBe(false);
		expect((await planReview(deps, state, { plan: "src/plan.md", claim: "c", evidence: [{ kind: "user", quote: "q" }] })).ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe("T5 - acceptance and developer review (FR-14, FR-15, FR-16)", () => {
	test("FR-14: business acceptance is recorded at the work revision and names the aspect still missing", async () => {
		const { deps } = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.91 } });
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });

		const outcome = await acceptance(deps, state, {
			aspect: "business",
			claim: "the owner can read the coverage of the last run",
			evidence: [{ kind: "execution", source: "bun test", quote: "12 pass" }],
		});

		expect(outcome.ok).toBe(true);
		expect(acceptanceAt(state, "business")?.approved).toBe(true);
		expect(acceptanceAt(state, "business")?.revision).toBe(state.revision);
		expect(outcome.text).toContain("architecture");
	});

	test("FR-15: an architectural defect is recorded as no approval", async () => {
		const { deps } = depsFor({ acceptance: { label: "architecture_defect", confidence: 0.9 } });
		const state = freshState();
		registerTask(state, "Report the coverage");
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });

		const outcome = await acceptance(deps, state, {
			aspect: "architecture",
			claim: "the report can absorb the next metric",
			evidence: [{ kind: "code", quote: "class Report { ... }" }],
		});

		expect(outcome.ok).toBe(true);
		expect(acceptanceAt(state, "architecture")?.approved).toBe(false);
		expect(outcome.text).toContain("not recorded");
	});

	test("FR-14: acceptance without a registered task or without quotes is refused", async () => {
		const { deps, calls } = depsFor({ acceptance: { label: "serves_business_need" } });

		expect((await acceptance(deps, freshState(), { aspect: "business", claim: "c", evidence: [{ kind: "user", quote: "q" }] })).ok).toBe(false);

		const state = freshState();
		registerTask(state, "task");
		expect((await acceptance(deps, state, { aspect: "business", claim: "c", evidence: [] })).ok).toBe(false);
		expect((await acceptance(deps, state, { aspect: "quality", claim: "c", evidence: [{ kind: "user", quote: "q" }] })).ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("FR-16: a defect holds consequential changes and a sound verdict clears the finding", async () => {
		const defect = depsFor({ review: { label: "defect", confidence: 0.9 } });
		const state = freshState();
		registerTask(state, "Report the coverage");
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: PLAN_URL, planDigest: "d", confidence: 0.9 };

		const outcome = await review(defect.deps, state, {
			kind: "diff",
			target: "HEAD~1..HEAD",
			claim: "the report writer is thread safe",
			evidence: [{ kind: "code", quote: "shared Map without a lock" }],
		});

		expect(outcome.ok).toBe(true);
		expect(state.hold?.reason).toContain("defect");
		expect(mutationGate(state, DEFAULT_CONFIG, "write", { path: "src/a.ts" }).block).toBe(true);

		const sound = depsFor({ review: { label: "sound", confidence: 0.92 } });
		await review(sound.deps, state, {
			kind: "diff",
			target: "HEAD~1..HEAD",
			claim: "the report writer is thread safe",
			evidence: [{ kind: "code", quote: "the map is guarded by a lock" }],
		});

		expect(state.hold).toBeUndefined();
		expect(mutationGate(state, DEFAULT_CONFIG, "write", { path: "src/a.ts" }).block).toBe(false);
	});

	test("FR-16: a review without a target, a kind or quotes is refused", async () => {
		const { deps, calls } = depsFor({ review: { label: "sound" } });
		const state = freshState();

		expect((await review(deps, state, { kind: "commit", claim: "c", evidence: [{ kind: "code", quote: "q" }] })).ok).toBe(false);
		expect((await review(deps, state, { kind: "guess", target: "t", claim: "c", evidence: [{ kind: "code", quote: "q" }] })).ok).toBe(false);
		expect((await review(deps, state, { kind: "commit", target: "t", claim: "c", evidence: [] })).ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe("T4 - the automatic checks (FR-11, FR-12, FR-17)", () => {
	test("FR-11: the course check judges the registered direction from the recorded action results", async () => {
		const { deps, calls } = depsFor({ direction: { label: "on_course", confidence: 0.9 } });
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });

		const outcome = await courseCheck(deps, state);

		expect(outcome.ok).toBe(true);
		expect(state.courseCheck?.approved).toBe(true);
		expect(JSON.stringify(calls[0]?.state)).toContain("wrote the report");
	});

	test("FR-11: an off-course verdict holds consequential changes until a consultation clears it", async () => {
		const { deps } = depsFor({ direction: { label: "off_course", confidence: 0.9 } });
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		recordAction(state, { tool: "write", target: "src/other.ts", excerpt: "wrote something else" });

		await courseCheck(deps, state);

		expect(state.courseCheck?.approved).toBe(false);
		expect(state.hold?.reason).toContain("off_course");
	});

	test("FR-12, FR-17: the completion check asks whether the work follows the requirements, and the direction only when configured for completion-only", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });

		const interval = depsFor({ follows_requirements: { label: "follows", confidence: 0.94 } });
		const intervalOutcome = await completionCheck(interval.deps, state, { course: false });

		expect(intervalOutcome.ok).toBe(true);
		expect(state.completion?.approved).toBe(true);
		expect(interval.calls[0]?.questions.map(question => question.name)).toEqual(["follows_requirements"]);

		const completionOnly = depsFor({
			follows_requirements: { label: "follows", confidence: 0.94 },
			direction: { label: "on_course", confidence: 0.9 },
		});
		await completionCheck(completionOnly.deps, state, { course: true });

		expect(completionOnly.calls[0]?.questions.map(question => question.name)).toEqual(["follows_requirements", "direction"]);
		expect(state.completion?.approved).toBe(true);
	});

	test("FR-17: a deviating completion check is recorded as no approval", async () => {
		const { deps } = depsFor({ follows_requirements: { label: "deviates", confidence: 0.9 } });
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });

		const outcome = await completionCheck(deps, state, { course: false });

		expect(outcome.ok).toBe(true);
		expect(state.completion?.approved).toBe(false);
		expect(outcome.text).toContain("not approved for completion");
	});
});
