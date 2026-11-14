import { describe, expect, test } from "bun:test";
import {
	acceptance,
	actionCheck,
	completionCheck,
	consult,
	courseCheck,
	ownerUpdate,
	planReview,
	reaim,
	requirements,
	review,
	searchRelevance,
	textReview,
	triage,
	type ActivityDeps,
} from "../src/activities.js";
import { mutationGate } from "../src/gates.js";
import {
	acceptanceAt,
	continuationAllowed,
	freshState,
	queueOwnerMessage,
	recordAction,
	recordRecovery,
	registerTask,
	sha256,
	type JevState,
} from "../src/state.js";
import { asRecord, POLICY, type PlanTopic } from "../src/types.js";
import { answeringJudge, boundaryConfig, failingJudge, type FakeAnswerSource } from "./helpers.js";

/** A consultation binding for the standing finding, naming its exact id and a changed correction. */
function boundRecovery(state: JevState, correction: string) {
	return {
		recovery: {
			findingId: state.hold?.id ?? "legacy",
			diagnosis: "the refused material showed the named defect",
			correction,
			phase: "resolve" as const,
		},
		evidence: [{ kind: "code" as const, quote: correction }],
	};
}

/** Activity dependencies over a fake judge table and an optional artifact reader. */
function depsFor(table: Record<string, FakeAnswerSource>, readArtifact?: ActivityDeps["readArtifact"]) {
	const fake = answeringJudge(table);
	const deps: ActivityDeps = { judge: fake.judge, config: boundaryConfig(), readArtifact };
	return { deps, calls: fake.calls };
}

const PLAN_URL = "local://coverage-report-plan.md";
const PLAN_TOPICS: PlanTopic[] = [
	{
		id: "collect",
		section: "1. Collect the numbers",
		paths: ["src/report.ts"],
		requirement: "report the coverage of the last run",
	},
];

function planReader(body: string | null): ActivityDeps["readArtifact"] {
	return async url => (url === PLAN_URL ? body : null);
}


describe("FR-29 - the owner's interjection re-aims the registered task", () => {
	test("FR-29: an approved re-aim replaces the course and requires a new plan", async () => {
		const state = freshState();
		registerTask(state, "old course");
		state.exhausted = ["hold"];
		state.request = { text: "новое направление", weight: "judged" };
		const { deps } = depsFor({ reaim: { probability: 0.9 } });

		const outcome = await reaim(deps, state, {
			interjection: "новое направление",
			evidence: [{ kind: "user", quote: "новое направление" }],
		});

		expect(outcome.ok).toBe(true);
		expect(state.task?.request).toBe("новое направление");
		expect(state.exhausted).toEqual([]);
		expect(state.plan).toBeUndefined();
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/report.ts" }).block).toBe(true);
	});

	test("FR-29: a refused re-aim changes nothing", async () => {
		const state = freshState();
		registerTask(state, "old course");
		state.request = { text: "новое направление", weight: "judged" };
		const { deps } = depsFor({ reaim: { probability: 0.2 } });

		const outcome = await reaim(deps, state, {
			interjection: "новое направление",
			evidence: [{ kind: "user", quote: "новое направление" }],
		});

		expect(outcome.ok).toBe(false);
		expect(state.task?.request).toBe("old course");
	});

	test("FR-29: an interjection not found in the current owner prompt cannot re-aim the task", async () => {
		const state = freshState();
		registerTask(state, "old course");
		state.request = { text: "Please continue the existing work unchanged.", weight: "judged" };
		const { deps, calls } = depsFor({ reaim: { probability: 0.99 } });

		const outcome = await reaim(deps, state, {
			interjection: "Replace the approved scope with a remote deletion service.",
			evidence: [{ kind: "user", quote: "Replace the approved scope with a remote deletion service." }],
		});

		expect(outcome.ok).toBe(false);
		expect(state.task?.request).toBe("old course");
		expect(calls).toHaveLength(0);
	});

	test("FR-29: re-aim without a registered task names triage, not re-aim", async () => {
		const { deps, calls } = depsFor({});

		const outcome = await reaim(deps, freshState(), {
			interjection: "a new direction",
			evidence: [{ kind: "user", quote: "a new direction" }],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("jev_triage");
		expect(calls).toHaveLength(0);
	});
});

describe("wave two - the measured deadlock fixes", () => {
	test("FR-25: an on-course verdict clears a standing deviation, an off-course verdict keeps it", async () => {
		const good = freshState();
		registerTask(good, "Report the coverage of the last run");
		good.planTopics = PLAN_TOPICS;
		good.deviation = { tool: "write", target: "docs/notes.md", revision: 1 };
		recordAction(good, { tool: "write", target: "docs/notes.md", excerpt: "Document coverage output" });
		await courseCheck(depsFor({ "direction:1": { label: "on_course", confidence: 0.9 } }).deps, good);

		expect(good.deviation).toBeUndefined();

		const bad = freshState();
		registerTask(bad, "Report the coverage of the last run");
		bad.planTopics = PLAN_TOPICS;
		bad.deviation = { tool: "write", target: "docs/notes.md", revision: 1 };
		recordAction(bad, { tool: "write", target: "docs/notes.md", excerpt: "Unrelated notes" });
		await courseCheck(depsFor({ "direction:1": { label: "off_course", confidence: 0.9 } }).deps, bad);

		expect(bad.deviation).toBeDefined();
	});



});
describe("FR-27 - the text review names the fragment and the rule it violates", () => {
	const JARGON_RULE = "Жаргон в прозе не употребляется.";
	const BREVITY_RULE = "Минимум слов, сохраняющих смысл.";
	const RULES = [
		{ class: "jargon", rule: JARGON_RULE, scope: "fragment" as const },
		{ class: "brevity", rule: BREVITY_RULE, scope: "fragment" as const },
	];

	test("FR-27: a violating fragment returns the submitted rule line byte-identical", async () => {
		const { deps } = depsFor({ fragment_1_1: { probability: 0.93 }, fragment_1_2: { probability: 0.1 } });

		const outcome = await textReview(deps, freshState(), { text: "Мы осуществили оптимизацию пайплайна.", rules: RULES });

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain(JARGON_RULE);
		expect(outcome.text).not.toContain(BREVITY_RULE);
		expect(outcome.text).toContain("осуществили оптимизацию");
	});

	test("FR-27: a text that violates none of the submitted rules is approved", async () => {
		const { deps } = depsFor({ fragment_1_1: { probability: 0.1 }, fragment_1_2: { probability: 0.05 } });

		const outcome = await textReview(deps, freshState(), { text: "Отчёт готов.", rules: RULES });

		expect(outcome.ok).toBe(true);
	});

	test("FR-27: a review without rules, or over too many fragments, is refused without a judge call", async () => {
		const { deps, calls } = depsFor({});

		expect((await textReview(deps, freshState(), { text: "Отчёт готов." })).ok).toBe(false);
		const many = Array.from({ length: POLICY.maxTextFragments + 1 }, (_, index) => `Абзац номер ${index}.`).join("\n\n");
		const outcome = await textReview(deps, freshState(), { text: many, rules: RULES });

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain(String(POLICY.maxTextFragments));
		expect(calls).toHaveLength(0);
	});

	test("FR-27: a text-scoped rule judges the whole text and not its heading", async () => {
		const { deps, calls } = depsFor({ text_rule_1: { probability: 0.1 } });

		const outcome = await textReview(deps, freshState(), {
			text: "## Раздел\n\nАбзац с утверждением.\n\n| A | B |\n|---|---|\n| 1 | 2 |",
			rules: [{ class: "structure", rule: "Раздел называет процесс ГОСТ." }],
		});

		expect(outcome.ok).toBe(true);
		expect(calls[0]?.questions.map(question => question.name)).toEqual(["text_rule_1"]);
	});

	test("FR-27: a fragment rule judges prose, not headings or tables", async () => {
		const { deps, calls } = depsFor({ fragment_1_1: { probability: 0.9 } });

		const outcome = await textReview(deps, freshState(), {
			text: "## Заголовок\n\nПервое предложение.\n\n| A | B |\n|---|---|\n| 1 | 2 |",
			rules: [{ class: "language", rule: "Одна мысль в предложении.", scope: "fragment" }],
		});

		expect(outcome.ok).toBe(false);
		expect(calls[0]?.questions.map(question => question.name)).toEqual(["fragment_1_1"]);
		expect(outcome.text).toContain("Первое предложение.");
	});

	test.each([
		"## Heading\nProse requiring review.",
		"| Heading |\n|---|\n| Value |\nProse requiring review.",
		"```text\nExample, not prose.\n```\nProse requiring review.",
	])("FR-27: structural lines do not hide adjacent prose in %s", async text => {
		const { deps } = depsFor({ fragment_1_1: { probability: 0.95 } });
		const outcome = await textReview(deps, freshState(), {
			text,
			rules: [{ class: "register", rule: "Prose meets the declared register.", scope: "fragment" }],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.details?.["defects"]).toEqual([{
			class: "register",
			rule: "Prose meets the declared register.",
			fragment: "Prose requiring review.",
		}]);
	});

	test.each(["\n", "\r\n"])("FR-27: fenced examples spanning blank lines do not hide prose with line ending %j", async lineEnding => {
		const { deps } = depsFor({ fragment_1_1: { probability: 0.95 } });
		const outcome = await textReview(deps, freshState(), {
			text: "```text\nExample.\n\nStill an example.\n```\n\nProse requiring review.".replace(/\n/g, lineEnding),
			rules: [{ class: "register", rule: "Prose meets the declared register.", scope: "fragment" }],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.details?.["defects"]).toEqual([{
			class: "register",
			rule: "Prose meets the declared register.",
			fragment: "Prose requiring review.",
		}]);
	});

	test.each([
		{ example: "Code example.", prose: "UNCHECKED prose.", approved: false },
		{ example: "UNCHECKED example.", prose: "Reviewed prose.", approved: true },
	])("FR-27: numbered judgments refer to prose rather than the preceding example: %j", async ({ example, prose, approved }) => {
		const rule = "The prose must not contain the word UNCHECKED.";
		const deps: ActivityDeps = {
			config: boundaryConfig(),
			judge: async (material, questions) => {
				const fragments = asRecord(material)?.["fragments"];
				return {
					ok: true,
					answers: questions.map(question => {
						const index = Number(/^fragment_(\d+)_/.exec(question.name)?.[1]) - 1;
						const fragment = Array.isArray(fragments) ? fragments[index] : undefined;
						return {
							name: question.name,
							mode: "noul",
							probability: typeof fragment === "string" && fragment.includes("UNCHECKED") ? 0.99 : 0.01,
							confidence: 0.99,
						};
					}),
				};
			},
		};
		const outcome = await textReview(deps, freshState(), {
			text: ["```text", example, "```", "", prose].join("\n"),
			rules: [{ class: "register", rule, scope: "fragment" }],
		});

		expect(outcome.ok).toBe(approved);
		expect(outcome.details?.["defects"]).toEqual(approved ? [] : [{ class: "register", rule, fragment: prose }]);
	});

	test("FR-27: an unsettled review lists the failing fragment and rule", async () => {
		const { deps } = depsFor({ text_rule_1: { probability: 0.5 } });

		const outcome = await textReview(deps, freshState(), {
			text: "Утверждение.",
			rules: [{ class: "accuracy", rule: "Claims follow evidence." }],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("Claims follow evidence.");
		expect(outcome.text).toContain("Утверждение.");
	});

	test("FR-27: unsettled passes do not exhaust the text boundary", async () => {
		const { deps, calls } = depsFor({ text_rule_1: { probability: 0.5 } });
		const state = freshState();

		for (let index = 0; index < 4; index += 1) {
			const outcome = await textReview(deps, state, {
				text: `Утверждение ${index}.`,
				rules: [{ class: "accuracy", rule: "Claims follow evidence." }],
			});
			expect(outcome.ok).toBe(false);
		}

		expect(calls).toHaveLength(4);
		expect(state.exhausted).toEqual([]);
	});
});

describe("FR-26 - acceptance is judged from the submitted evidence", () => {
	test("FR-26: a claim without execution and code evidence is refused before any judge call", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		const { deps, calls } = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.9 } });

		const outcome = await acceptance(deps, state, {
			aspect: "business",
			claim: "the report serves the owner's need",
			evidence: [{ kind: "user", quote: "the report is done" }],
		});

		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("FR-26: the acceptance asks one question per plan topic and names the topic its evidence misses", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = PLAN_TOPICS;
		const { deps, calls } = depsFor({
			acceptance: { label: "serves_business_need", confidence: 0.9 },
			topic_1: { probability: 0.2 },
		});

		const outcome = await acceptance(deps, state, {
			aspect: "business",
			claim: "the report serves the owner's need",
			evidence: [
				{ kind: "execution", quote: "bun test: 132 pass" },
				{ kind: "code", quote: "0 diagnostics" },
			],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("collect");
		expect(acceptanceAt(state, "business")?.approved).toBe(false);
		expect(calls[0]?.questions.map(question => question.name)).toEqual(["acceptance", "topic_1"]);
	});
});

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
		expect(outcome.details?.["topics"]).toEqual(["high availability"]);
		expect(outcome.details?.["needsDevelopment"]).toBe(true);
		expect(state.task?.request).toBe("Keep the report available while a node fails");
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/a.ts" }).block).toBe(true);
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
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/a.ts" }).block).toBe(false);
	});

	test("FR-02: an answer the judge cannot settle is refused and registers nothing", async () => {
		const { deps } = depsFor({ needs_development: { probability: 0.5 } });
		const state = freshState();

		const outcome = await triage(deps, state, { request: "Search the web for the release date of the library" });

		expect(outcome.ok).toBe(false);
		expect(state.task).toBeUndefined();
	});

	test("FR-01: whitespace and line-ending variants of the owner request are accepted", async () => {
		const state = freshState();
		state.request = { text: "Line one.\r\nLine two.", weight: "judged" };
		const { deps } = depsFor({ needs_development: { probability: 0.95 } });

		const outcome = await triage(deps, state, { request: "Line one. Line two." });

		expect(outcome.ok).toBe(true);
		expect(state.task?.request).toBe("Line one.\r\nLine two.");
	});

	test("FR-01: a mismatched request shows the current owner message", async () => {
		const state = freshState();
		state.request = { text: "The real request.", weight: "judged" };
		const { deps, calls } = depsFor({});

		const outcome = await triage(deps, state, { request: "A simpler request." });

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("The real request.");
		expect(outcome.text).toContain("sha256");
		expect(calls).toHaveLength(0);
	});

	test("a failing judge registers no development task", async () => {
		const state = freshState();
		const deps: ActivityDeps = { judge: failingJudge("socket reset"), config: boundaryConfig() };

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
		expect(outcome.details?.["title"]).toBe("Failure playbook");
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
	});
});

describe("T3 - requirement planning: per item, coverage and omitted needs (FR-04, FR-05, FR-06)", () => {
	test("FR-34: requirements cannot replace the request registered by triage", async () => {
		const { deps, calls } = depsFor({ coverage: { probability: 0.95 }, item_1: { probability: 0.95 } });
		const state = freshState();
		registerTask(state, "Report coverage");

		const outcome = await requirements(deps, state, {
			request: "Add a remote account deletion operation",
			items: [{ text: "delete remote accounts", source: "Add a remote account deletion operation" }],
			evidence: [{ kind: "user", quote: "Add a remote account deletion operation" }],
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("match the development task");
		expect(state.task?.request).toBe("Report coverage");
		expect(calls).toHaveLength(0);
	});

	test("FR-04: whitespace-equivalent owner text is accepted and the judge sees the canonical registered request", async () => {
		const { deps, calls } = depsFor({ coverage: { probability: 0.96 }, item_1: { probability: 0.97 } });
		const state = freshState();
		registerTask(state, "Line one.\r\nLine two.");

		const outcome = await requirements(deps, state, {
			request: "Line one. Line two.",
			items: [{ text: "the report lists coverage", source: "Line one. Line two." }],
		});

		expect(outcome.ok).toBe(true);
		const judged = asRecord(calls[0]?.state);
		expect(judged?.["request"]).toBe("Line one.\r\nLine two.");
		expect(judged?.["quotes"]).toEqual(["[user] Line one.\r\nLine two."]);
	});

	test("FR-05, FR-06: supported items, a rejected item and an omitted owner need are reported separately", async () => {
		const { deps, calls } = depsFor({
			coverage: { probability: 0.12 },
			item_1: { probability: 0.95 },
			item_2: { probability: 0.06 },
			need_1: { probability: 0.91 },
		});
		const state = freshState();
		registerTask(state, "Report the coverage of the last run and mail the summary");

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

		const state = freshState();
		registerTask(state, "Report the coverage");
		const outcome = await requirements(deps, state, {
			request: "Report the coverage",
			items: [{ text: "the report lists coverage", source: "report the coverage" }],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("candidateNeeds");
		expect(outcome.details?.["covered"]).toBe(false);
	});

	test("FR-05: an item without the quote it derives from is refused before any judge call", async () => {
		const { deps, calls } = depsFor({});
		const state = freshState();
		registerTask(state, "Report the coverage");
		const outcome = await requirements(deps, state, {
			request: "Report the coverage",
			items: [{ text: "the report lists coverage" }],
		});

		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("FR-06: a settled coverage and every item supported is reported as established", async () => {
		const { deps } = depsFor({ coverage: { probability: 0.96 }, item_1: { probability: 0.97 } });
		const state = freshState();
		registerTask(state, "Report the coverage");

		const outcome = await requirements(deps, state, {
			request: "Report the coverage",
			items: [{ text: "the report lists coverage", source: "report the coverage" }],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toContain("coverage: established");
		expect(outcome.details?.["covered"]).toBe(true);
	});
	test("FR-06: coverage at the configured 0.6 floor establishes complete owner-approved scope", async () => {
		const { deps } = depsFor({ coverage: { probability: 0.6 }, item_1: { probability: 0.95 } });
		const state = freshState();
		registerTask(state, "Report the coverage");

		const outcome = await requirements(deps, state, {
			request: "Report the coverage",
			items: [{ text: "the report lists coverage", source: "report the coverage" }],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["approved"]).toBe(true);
		expect(state.requirementsApproval?.items).toEqual(["the report lists coverage"]);
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

	test("FR-13: a judge-supported bound consultation clears the named finding, an unusable one does not", async () => {
		const usable = depsFor({ consult: { label: "fix", confidence: 0.9 }, resolves_hold: { probability: 0.93 } });
		const state = freshState();
		const hold = recordRecovery(state, "course-check", { claim: "off course" }, {
			ok: true,
			text: 'the course check answered "off_course"',
			details: { approved: false, label: "off_course" },
		});

		const cleared = await consult(usable.deps, state, {
			mode: "recovery",
			...boundRecovery(state, "return to the registered task"),
			recovery: {
				findingId: hold?.id ?? "",
				diagnosis: "the last actions left the task",
				correction: "return to the registered task",
				phase: "resolve",
			},
			evidence: [{ kind: "code", quote: "the corrected branch serves the plan" }],
		});

		expect(cleared.ok).toBe(true);
		expect(state.hold).toBeUndefined();

		recordRecovery(state, "course-check", { claim: "off course again" }, {
			ok: true,
			text: 'the course check answered "off_course"',
			details: { approved: false, label: "off_course" },
		});
		const weak = depsFor({ resolves_hold: { probability: POLICY.minProbabilityToApprove - 0.2 } });
		const weakOutcome = await consult(weak.deps, state, {
			mode: "recovery",
			...boundRecovery(state, "return to the registered task"),
		});

		expect(weakOutcome.ok).toBe(false);
		expect(state.hold).toBeDefined();
	});

	test("FR-13: a diagnostic consultation stays usable without clearing the held finding", async () => {
		const state = freshState();
		const hold = recordRecovery(state, "course-check", { claim: "x" }, {
			ok: true,
			text: "off course",
			details: { approved: false },
		});
		const { deps, calls } = depsFor({ consult: { probability: 0.99 }, resolves_hold: { probability: 0.99 } });

		const unbound = await consult(deps, state, {
			mode: "boolean",
			question: "Does this fix it?",
			context: "a correction",
			trueMeaning: "yes",
			falseMeaning: "no",
			evidence: [{ kind: "code", quote: "a corrected branch" }],
		});
		expect(unbound.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(state.hold).toEqual(hold);

		const wrong = await consult(deps, state, {
			mode: "recovery",
			recovery: { phase: "resolve", findingId: "finding-other", diagnosis: "d", correction: "a new branch" },
			evidence: [{ kind: "code", quote: "a corrected branch" }],
		});
		expect(wrong.ok).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("FR-13: an unrelated consultation never clears a finding, however usable its own answer", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://x-plan.md", planDigest: "d" };
		recordRecovery(state, "course-check", { claim: "off course" }, {
			ok: true,
			text: 'the course check at revision 2 answered "off_course" (confidence 0.91)',
			details: { approved: false, label: "off_course" },
		});

		const unrelated = depsFor({ consult: { label: "tabs", confidence: 0.92 }, resolves_hold: { probability: 0.08 } });
		const outcome = await consult(unrelated.deps, state, {
			mode: "recovery",
			...boundRecovery(state, "indent with tabs"),
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("remains unresolved");
		expect(asRecord(outcome.details)?.["resolutionProbability"]).toBe(0.08);
		expect(state.hold).toBeDefined();
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/a.ts" }).block).toBe(true);
	});

	test("FR-22: rewording a held recovery buys no judge call without new evidence", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://x-plan.md", planDigest: "d" };
		const hold = recordRecovery(state, "review", { target: "parser.ts" }, {
			ok: false,
			text: "the developer review found an unresolved parser defect",
			details: { approved: false, label: "defect" },
		});
		const { deps, calls } = depsFor({ consult: { label: "keep", confidence: 0.95 }, resolves_hold: { probability: 0.05 } });

		for (const question of [
			"Which report format should be retained?",
			"Which source supports the coverage result?",
			"Which behavior needs verification?",
			"Which documentation needs an update?",
		]) {
			const outcome = await consult(deps, state, {
				mode: "recovery",
				...boundRecovery(state, question),
				evidence: [{ kind: "execution", quote: "The same parser regression still fails." }],
			});
			expect(outcome.ok).toBe(false);
			expect(state.hold).toEqual(hold);
			expect(continuationAllowed(state)).toBe(false);
			expect(mutationGate(state, boundaryConfig(), "write", { path: "src/a.ts" }).block).toBe(true);
		}
		expect(calls).toHaveLength(1);
		await consult(deps, state, {
			mode: "recovery",
			...boundRecovery(state, "Use the observed parser correction."),
			evidence: [{ kind: "execution", quote: "The parser regression now passes." }],
		});
		expect(calls).toHaveLength(2);
	});

	test("FR-22, FR-23: a spent consult budget keeps the finding OPEN and still judges materially new corrections", async () => {
		const state = freshState();
		registerTask(state, "Repair the parser");
		recordRecovery(state, "review", { target: "parser.ts" }, {
			ok: false,
			text: "the developer review found a parser defect",
			details: { approved: false, label: "defect" },
		});
		const { deps, calls } = depsFor({ consult: { probability: 0.5 }, resolves_hold: { probability: 0.05 } });
		const submission = (context: string) => ({
			mode: "recovery" as const,
			...boundRecovery(state, context),
		});
		const first = submission("The correction changes the empty-input branch.");
		expect((await consult(deps, state, first)).ok).toBe(false);
		expect((await consult(deps, state, first)).ok).toBe(false);
		expect(calls).toHaveLength(1);

		await consult(deps, state, submission("The correction changes the malformed-input branch."));
		await consult(deps, state, submission("The correction changes the incomplete-input branch."));
		expect(calls).toHaveLength(3);
		expect(continuationAllowed(state)).toBe(false);
		expect(state.hold).toBeDefined();

		// Recovery stays possible after the budget: new evidence is judged, the count authorizes nothing.
		await consult(deps, state, submission("The correction changes the trailing-input branch."));
		expect(calls).toHaveLength(4);
		expect(continuationAllowed(state)).toBe(false);
		expect(state.hold).toBeDefined();
		// An unchanged replay costs no judge call even after exhaustion.
		await consult(deps, state, submission("The correction changes the trailing-input branch."));
		expect(calls).toHaveLength(4);
	});

	test("FR-13: a negative answer does not clear a finding either", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		recordRecovery(state, "review", { target: "report.ts" }, {
			ok: false,
			text: "the developer review answered defect",
			details: { approved: false, label: "defect" },
		});

		const negative = depsFor({ consult: { probability: 0.03 }, resolves_hold: { probability: 0.1 } });
		const outcome = await consult(negative.deps, state, {
			mode: "recovery",
			...boundRecovery(state, "correct the reported defect"),
		});

		expect(outcome.ok).toBe(false);
		expect(state.hold).toBeDefined();
	});

	test("FR-09: a consultation without alternatives, context or a judge answer is refused", async () => {
		const { deps, calls } = depsFor({});

		expect((await consult(deps, freshState(), { mode: "choice", question: "q", context: "c", alternatives: [{ label: "one", meaning: "m" }] })).ok).toBe(false);
		expect((await consult(deps, freshState(), { mode: "choice", question: "q", context: "", alternatives: [{ label: "one", meaning: "m" }, { label: "two", meaning: "m" }] })).ok).toBe(false);
		expect(calls).toHaveLength(0);

		const failing: ActivityDeps = { judge: failingJudge("the judge call failed (socket reset)"), config: boundaryConfig() };
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

function planState(request: string, requirements: string[]) {
	const state = freshState();
	const task = registerTask(state, request);
	state.requirementsApproval = { taskFingerprint: task.fingerprint, items: requirements };
	return state;
}

describe("autonomous safety", () => {
	test("an uncertain text verdict is not a clean review", async () => {
		const { deps } = depsFor({ fragment_1_1: { probability: 0.5 } });
		const outcome = await textReview(deps, freshState(), {
			text: "The report is ready.",
			rules: [{ class: "accuracy", rule: "Claims must follow the evidence.", scope: "fragment" }],
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.details?.["approved"]).toBe(false);
	});

	test("a refused requirement submission cannot be judged repeatedly", async () => {
		const state = freshState();
		registerTask(state, "Build a coverage report");
		const { deps, calls } = depsFor({ coverage: { probability: 0.3 }, item_1: { probability: 0.95 } });
		const input = {
			request: "Build a coverage report",
			items: [{ text: "Read coverage results", source: "Build a coverage report" }],
		};
		await requirements(deps, state, input);
		await requirements(deps, state, input);
		expect(calls).toHaveLength(1);
		expect(state.requirementsApproval).toBeUndefined();
		expect(state.submissions).toHaveLength(1);
	});

	test("an approval for older work cannot accept a later revision", async () => {
		const state = freshState();
		registerTask(state, "Build a coverage report");
		recordAction(state, { tool: "write", target: "report.ts", excerpt: "first version" });
		const deps = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.95 } }).deps;
		const judge = deps.judge;
		deps.judge = async (material, questions) => {
			recordAction(state, { tool: "write", target: "report.ts", excerpt: "changed during review" });
			return judge(material, questions);
		};
		await acceptance(deps, state, {
			aspect: "business",
			claim: "The report is correct.",
			evidence: [{ kind: "execution", quote: "report output matches the fixture" }, { kind: "code", quote: "the report reads coverage results" }],
		});
		expect(acceptanceAt(state, "business")?.approved).not.toBe(true);
	});

	test("approved requirements allow an outline without a second owner message", async () => {
		const state = freshState();
		const task = registerTask(state, "Build a coverage report");
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Read coverage results"] };
		const { deps } = depsFor({ outline_requirement_1: { probability: 0.95 }, outline_step_1: { probability: 0.95 } });
		await planReview(deps, state, {
			phase: "outline",
			steps: [{ id: "read", summary: "Read coverage results from the previous run.", requirement: "Read coverage results" }],
			evidence: [{ kind: "user", quote: "Build a coverage report" }],
		});
		expect(state.planDraft?.outlineApproved).toBe(true);
	});

	test("FR-38: action and recovery judgments retain decisions outside approved step sections", async () => {
		const artifact = "# Plan\n\n## Decisions\nUse the configured provider key resolver, never a literal key.\n\n## Configure\nWrite the provider configuration.\n";
		const state = planState("Configure the provider", ["Write the provider configuration"]);
		state.planTopics = PLAN_TOPICS;
		state.plan = { taskFingerprint: state.task!.fingerprint, planUrl: PLAN_URL, planDigest: sha256(artifact) };
		const { deps } = depsFor({}, planReader(artifact));
		deps.judge = async (material, questions) => answeringJudge(Object.fromEntries(questions.map(question => [
			question.name,
			question.name === "action"
				? { label: asRecord(material)?.["approvedPlanArtifact"] === artifact ? "on_course" : "unclear", confidence: 0.95 }
				: { probability: asRecord(material)?.["approvedPlanArtifact"] === artifact ? 0.95 : 0.2 },
		]))).judge(material, questions);
		const input = { path: "src/report.ts", content: "apiKey: configured-resolver" };
		const outcome = await actionCheck(deps, state, { tool: "write", target: input.path, change: JSON.stringify(input) }, input);
		expect(outcome.details?.["approved"]).toBe(true);
		recordRecovery(state, "action:0", { input }, { ok: true, text: "The provider configuration needs authorization.", details: { kind: "unclear", approved: false } });
		const repair = await consult(deps, state, {
			mode: "recovery",
			recovery: {
				phase: "repair", findingId: state.hold?.id,
				diagnosis: "The decision outside the step section was missing from the action context.",
				correction: "Apply the configured resolver authorized by the complete approved plan.",
				nextAction: { tool: "write", input },
			},
			evidence: [{ kind: "spec", quote: "Use the configured provider key resolver, never a literal key." }],
		});
		expect(repair.details?.["repairApproved"]).toBe(true);
	});

	test("FR-38: changed approved plan bytes cannot supply action authorization", async () => {
		const state = planState("Configure the provider", ["Write the provider configuration"]);
		state.planTopics = PLAN_TOPICS;
		state.plan = { taskFingerprint: state.task!.fingerprint, planUrl: PLAN_URL, planDigest: sha256("approved plan") };
		const { deps, calls } = depsFor({ action: { label: "on_course", confidence: 0.99 } }, planReader("changed plan"));
		const outcome = await actionCheck(deps, state, { tool: "write", target: "src/report.ts", change: "{}" });
		expect(outcome.details?.["approved"]).not.toBe(true);
		expect(calls).toHaveLength(0);
	});

	test("FR-38: a below-floor off-course answer is uncertainty, not an established defect", async () => {
		const state = planState("Configure the provider", ["Write the provider configuration"]);
		state.planTopics = PLAN_TOPICS;
		state.plan = { taskFingerprint: state.task!.fingerprint, planUrl: PLAN_URL, planDigest: "bound" };
		const { deps } = depsFor({ action: { label: "off_course", confidence: 0.26 } });
		const outcome = await actionCheck(deps, state, { tool: "write", target: "src/report.ts", change: "{}" });
		expect(outcome.details?.["approved"]).toBe(false);
		expect(outcome.text).toContain("Class: inconclusive");
		expect(asRecord(state.hold?.result)?.["kind"]).toBe("unclear");
	});

	test("an off-task proposed action is blocked before it changes revision or history", async () => {
		const state = planState("Report coverage", ["Collect run data"]);
		state.planTopics = PLAN_TOPICS;
		state.plan = { taskFingerprint: state.task!.fingerprint, planUrl: PLAN_URL, planDigest: "bound" };
		const outcome = await actionCheck(depsFor({ action: { label: "off_course", confidence: 0.99 } }).deps, state, {
			tool: "eval", target: "unknown", change: "delete remote accounts",
		});
		expect(outcome.details?.["approved"]).toBe(false);
		expect(state.revision).toBe(0);
		expect(state.actions).toEqual([]);
		expect(state.hold?.boundary).toBe("action:0");
		expect(state.continuation).toBeUndefined();
	});
});

describe("FR-23 - staged plan refusal remains an open item", () => {
	test("repeated material costs no call and exhaustion keeps blocking while new evidence is judged", async () => {
		const state = planState("Report coverage", ["Collect run data"]);
		const { deps, calls } = depsFor({
			outline_requirement_1: { probability: 0.3 },
			outline_step_1: { probability: 0.93 },
		});
		const submission = (attempt: number) => ({
			phase: "outline",
			steps: [{ id: "collect", summary: "Read the run data.", requirement: "Collect run data" }],
			evidence: [{ kind: "user" as const, quote: `Report coverage, attempt ${attempt}` }],
		});
		const first = submission(1);
		await planReview(deps, state, first);
		await planReview(deps, state, first);
		expect(calls).toHaveLength(1);
		for (let attempt = 2; attempt <= POLICY.maxRefusalsPerStage; attempt += 1) {
			await planReview(deps, state, submission(attempt));
		}

		expect(calls).toHaveLength(POLICY.maxRefusalsPerStage);
		expect(state.openItem?.boundary).toBe("plan:outline");
		expect(state.exhausted).toContain("plan");
		expect(state.plan).toBeUndefined();
		expect(state.continuation).toBeUndefined();
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/report.ts" }).block).toBe(true);
		// Materially new plan evidence is still judged after the budget; the count releases nothing.
		expect((await planReview(deps, state, submission(99))).ok).toBe(true);
		expect(calls).toHaveLength(POLICY.maxRefusalsPerStage + 1);
		expect(state.plan).toBeUndefined();
	});
	test("FR-37: outline reports the exact confirmed requirement that its approved steps miss", async () => {
		const state = planState("Build a report", ["Collect run data", "Show coverage"]);
		const { deps } = depsFor({
			outline_requirement_1: { probability: 0.95 },
			outline_requirement_2: { probability: 0.2 },
			outline_step_1: { probability: 0.95 },
		});
		const outcome = await planReview(deps, state, {
			phase: "outline",
			steps: [{ id: "collect", summary: "Read the run data.", requirement: "Collect run data" }],
			evidence: [{ kind: "user", quote: "Build a report" }],
		});

		expect(outcome.text).toContain("Show coverage");
		expect(state.planDraft?.outlineApproved).toBe(false);
		expect(state.planDraft?.steps.map(step => step.id)).toEqual(["collect"]);
	});
});

describe("FR-37 - planning approvals accumulate across outline, detail and final review", () => {
	test("outline decisions are partial and approved steps become context for one-step detail reviews", async () => {
		const artifact = "# Report\n\n## Collect\nRead the run data.\n\n## Display\nShow the coverage.\n";
		let displayReviews = 0;
		const { deps, calls } = depsFor(
			{
				outline_requirement_1: { probability: 0.94 },
				outline_requirement_2: { probability: 0.94 },
				outline_step_1: { probability: 0.93 },
				outline_step_2: () => ({ probability: displayReviews++ === 0 ? 0.52 : 0.93 }),
				detail: { label: "ready", confidence: 0.91 },
				finalize_consistency: { probability: 0.94 },
				finalize_scope: { probability: 0.91 },
			},
			planReader(artifact),
		);
		const state = planState("Report coverage", ["Collect run data", "Show coverage"]);
		const evidence = [{ kind: "user" as const, quote: "Report coverage" }];
		const outline = await planReview(deps, state, {
			phase: "outline",
			steps: [
				{ id: "collect", summary: "Read and aggregate the run data.", requirement: "Collect run data" },
				{ id: "display", summary: "Show the result on a page.", requirement: "Show coverage" },
			],
			evidence,
		});

		expect(outline.ok).toBe(true);
		expect(outline.text).toContain("collect");
		expect(outline.text).toContain("display");
		expect(state.plan).toBeUndefined();
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/report.ts" }).block).toBe(true);

		const revisedOutline = await planReview(deps, state, {
			phase: "outline",
			steps: [{ id: "display", summary: "Render the aggregate in the report page.", requirement: "Show coverage" }],
			evidence,
		});
		expect(revisedOutline.ok).toBe(true);
		expect(JSON.stringify(calls[1]?.state)).toContain("Read and aggregate the run data.");

		const collect = await planReview(deps, state, {
			phase: "detail",
			plan: PLAN_URL,
			topic: { id: "collect", section: "## Collect\nRead the run data.", paths: ["src/report.ts"], requirement: "Collect run data" },
			evidence,
		});
		expect(collect.ok).toBe(true);
		expect(state.plan).toBeUndefined();

		const display = await planReview(deps, state, {
			phase: "detail",
			plan: PLAN_URL,
			topic: { id: "display", section: "## Display\nShow the coverage.", paths: ["src/report.ts"], requirement: "Show coverage" },
			evidence,
		});
		expect(display.ok).toBe(true);
		expect(JSON.stringify(calls[3]?.state)).toContain("Read the run data.");
		expect(JSON.stringify(calls[3]?.state)).toContain("Show the coverage.");
		expect(state.plan).toBeUndefined();

		const finalized = await planReview(deps, state, { phase: "finalize", plan: PLAN_URL, evidence });
		expect(finalized.ok).toBe(true);
		expect(state.plan?.planDigest).toBe(sha256(artifact));
		expect(state.planTopics).toHaveLength(2);
		expect(JSON.stringify(calls[4]?.state)).toContain("Read the run data.");
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/report.ts" }).block).toBe(false);
	});
	test("an assembly conflict blocks final approval without revoking accepted steps", async () => {
		const artifact = "# Plan\n\n## Collect\nRead the run data.\n";
		const state = planState("Report coverage", ["Collect run data"]);
		const evidence = [{ kind: "user" as const, quote: "Report coverage" }];
		const { deps } = depsFor(
			{
				outline_requirement_1: { probability: 0.94 },
				outline_step_1: { probability: 0.93 },
				detail: { label: "ready", confidence: 0.91 },
				finalize_consistency: { probability: 0.5 },
				finalize_scope: { probability: 0.95 },
			},
			planReader(artifact),
		);

		await planReview(deps, state, {
			phase: "outline",
			steps: [{ id: "collect", summary: "Read the run data.", requirement: "Collect run data" }],
			evidence,
		});
		await planReview(deps, state, {
			phase: "detail",
			plan: PLAN_URL,
			topic: { id: "collect", section: "## Collect\nRead the run data.", paths: ["src/report.ts"], requirement: "Collect run data" },
			evidence,
		});
		const finalized = await planReview(deps, state, { phase: "finalize", plan: PLAN_URL, evidence });

		expect(finalized.details?.["failed"]).toEqual(["cross-section consistency"]);
		expect(state.planDraft?.details.map(detail => detail.id)).toEqual(["collect"]);
		expect(state.plan).toBeUndefined();
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/report.ts" }).block).toBe(true);
	});
	test("a corrected detail can pass while the outline remains approved", async () => {
		let artifact = "# Plan\n\n## Collect\nRead the run data.\n";
		let detailReviews = 0;
		const { deps } = depsFor(
			{
				outline_requirement_1: { probability: 0.94 },
				outline_step_1: { probability: 0.93 },
				detail: () => ({ label: detailReviews++ === 0 ? "missing_check" : "ready", confidence: 0.92 }),
			},
			async () => artifact,
		);
		const state = planState("Report coverage", ["Collect run data"]);
		const evidence = [{ kind: "user" as const, quote: "Report coverage" }];
		await planReview(deps, state, {
			phase: "outline",
			steps: [{ id: "collect", summary: "Read the run data.", requirement: "Collect run data" }],
			evidence,
		});
		const firstSection = "## Collect\nRead the run data.";
		const first = await planReview(deps, state, {
			phase: "detail",
			plan: PLAN_URL,
			topic: { id: "collect", section: firstSection, paths: ["src/report.ts"], requirement: "Collect run data" },
			evidence,
		});
		expect(first.text).toContain("not approved");

		artifact = "# Plan\n\n## Collect\nRead the run data and calculate its coverage.\n";
		const revised = await planReview(deps, state, {
			phase: "detail",
			plan: PLAN_URL,
			topic: {
				id: "collect",
				section: "## Collect\nRead the run data and calculate its coverage.",
				paths: ["src/report.ts"],
				requirement: "Collect run data",
			},
			evidence,
		});

		expect(revised.text).toContain("detail approved");
		expect(state.planDraft?.outlineApproved).toBe(true);
		expect(state.planDraft?.details[0]?.section).toBe("## Collect\nRead the run data and calculate its coverage.");
	});
});

describe("approval content binding", () => {
	const evidence = [{ kind: "user", quote: "Report coverage" }];
	const requirement = "Collect run data";
	const section = "## Collect\nRead the run data and verify the count.";
	const topic = { id: "collect", section, paths: ["src/report.ts"], requirement };
	const answers = {
		outline_requirement_1: { probability: 0.95 },
		outline_step_1: { probability: 0.95 },
		detail: { label: "ready", confidence: 0.95 },
		finalize_consistency: { probability: 0.95 },
		finalize_scope: { probability: 0.95 },
	};
	const prepared = async (body = `# Plan\n\n${section}\n`) => {
		const document = { body };
		const state = planState("Report coverage", [requirement]);
		const fixture = depsFor(answers, async () => document.body);
		await planReview(fixture.deps, state, {
			phase: "outline", steps: [{ id: topic.id, summary: "Collect and verify the run data.", requirement }], evidence,
		});
		return { ...fixture, state, document };
	};

	test("a heading selector binds the full section and removes it from additional material", async () => {
		const { deps, state, calls } = await prepared();
		await planReview(deps, state, { phase: "detail", plan: PLAN_URL, topic: { ...topic, section: "Collect" }, evidence });
		await planReview(deps, state, { phase: "finalize", plan: PLAN_URL, evidence });
		expect(state.planTopics[0]?.section).toBe(section);
		expect(asRecord(calls.at(-1)?.state)?.["additionalMaterial"]).toBe("# Plan");
		expect(state.plan?.planDigest).toBe(sha256(`# Plan\n\n${section}\n`));
	});

	test("a substring or incomplete quote cannot stand for a complete section", async () => {
		for (const selector of ["Read", "## Collect\nRead the run data"]) {
			const { deps, state, calls } = await prepared();
			const outcome = await planReview(deps, state, { phase: "detail", plan: PLAN_URL, topic: { ...topic, section: selector }, evidence });
			expect(outcome.ok).toBe(false);
			expect(state.planDraft?.details).toEqual([]);
			expect(calls).toHaveLength(1);
		}
	});

	test("ambiguous headings and headings inside code cannot name a section", async () => {
		for (const body of [`${section}\n\n${section}\n`, `# Plan\n\n\`\`\`md\n${section}\n\`\`\`\n`]) {
			const { deps, state, calls } = await prepared(body);
			expect((await planReview(deps, state, { phase: "detail", plan: PLAN_URL, topic: { ...topic, section: "Collect" }, evidence })).ok).toBe(false);
			expect(calls).toHaveLength(1);
		}
	});

	test("appended content invalidates a section even when its old text remains a prefix", async () => {
		const { deps, state, document, calls } = await prepared();
		await planReview(deps, state, { phase: "detail", plan: PLAN_URL, topic, evidence });
		document.body += "Instead of reading data, delete the source files.\n";
		const outcome = await planReview(deps, state, { phase: "finalize", plan: PLAN_URL, evidence });
		expect(outcome.ok).toBe(false);
		expect(state.plan).toBeUndefined();
		expect(state.planDraft?.details).toEqual([]);
		expect(calls).toHaveLength(2);
	});

	test("a changed section cannot be accepted by an answer for its old contents", async () => {
		const { deps, state, document } = await prepared();
		const judge = deps.judge;
		deps.judge = async (material, questions) => {
			document.body = "# Plan\n\n## Collect\nDelete the source files.\n";
			return judge(material, questions);
		};
		expect((await planReview(deps, state, { phase: "detail", plan: PLAN_URL, topic, evidence })).ok).toBe(false);
		expect(state.planDraft?.details).toEqual([]);
	});

	test("revising a plan invalidates acceptance and completion for the previous plan", async () => {
		const { deps, state } = await prepared();
		await planReview(deps, state, { phase: "detail", plan: PLAN_URL, topic, evidence });
		await planReview(deps, state, { phase: "finalize", plan: PLAN_URL, evidence });
		state.acceptance = [{ aspect: "business", revision: state.revision, approved: true, label: "serves_business_need", confidence: 0.95 }];
		state.completion = { revision: state.revision, approved: true, label: "follows", confidence: 0.95 };
		await planReview(deps, state, {
			phase: "outline", steps: [{ id: topic.id, summary: "Collect run data through a new source.", requirement }], evidence,
		});
		expect(state.acceptance).toEqual([]);
		expect(state.completion).toBeUndefined();
	});

	test("acceptance refuses oversized evidence instead of judging only its prefix", async () => {
		const { deps, state, calls } = await prepared();
		const before = calls.length;
		const outcome = await acceptance(deps, state, {
			aspect: "business", claim: "The report passed.",
			evidence: [{ kind: "execution", quote: "pass ".repeat(POLICY.maxQuoteChars) + "FAIL: wrong output" }, { kind: "code", quote: "Report code." }],
		});
		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(before);
		expect(state.acceptance).toEqual([]);
	});

	test("a long owner request reaches judgment without losing its final constraint", async () => {
		const request = "Build a report. ".repeat(POLICY.maxQuoteChars) + "Do not publish it.";
		const state = freshState();
		const { deps, calls } = depsFor({ needs_development: { probability: 0.95 } });
		await triage(deps, state, { request });
		expect(asRecord(calls[0]?.state)?.["quotes"]).toEqual([`[user] ${request}`]);
	});

	test("a new owner request or changed requirements makes a pending acceptance stale", async () => {
		for (const change of [
			(state: JevState) => { state.request = { text: "Replace the report with a game.", weight: "judged" }; },
			(state: JevState) => { state.requirementsApproval = { taskFingerprint: state.task!.fingerprint, items: ["Publish a report"] }; },
		]) {
			const { deps, state } = await prepared();
			const fake = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.95 } });
			deps.judge = async (material, questions) => { change(state); return fake.deps.judge(material, questions); };
			const outcome = await acceptance(deps, state, {
				aspect: "business", claim: "The report works.",
				evidence: [{ kind: "execution", quote: "Report matches fixture." }, { kind: "code", quote: "Report code." }],
			});
			expect(outcome.ok).toBe(false);
			expect(state.acceptance).toEqual([]);
		}
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
			evidence: [
				{ kind: "execution", source: "bun test", quote: "12 pass" },
				{ kind: "code", source: "src/report.ts", quote: "0 diagnostics" },
			],
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
			evidence: [
				{ kind: "execution", quote: "bun test: 132 pass / 0 fail" },
				{ kind: "code", quote: "class Report { ... }" },
			],
		});

		expect(outcome.ok).toBe(true);
		expect(acceptanceAt(state, "architecture")?.approved).toBe(false);
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

	test("FR-16: a defect hold is cleared only by a bound consultation, not by a sound review", async () => {
		const defect = depsFor({ review: { label: "defect", confidence: 0.9 } });
		const state = freshState();
		registerTask(state, "Report the coverage");
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: PLAN_URL, planDigest: "d" };

		const outcome = await review(defect.deps, state, {
			kind: "diff",
			target: "HEAD~1..HEAD",
			claim: "the report writer is thread safe",
			evidence: [{ kind: "code", quote: "shared Map without a lock" }],
		});

		expect(outcome.ok).toBe(false);
		const hold = recordRecovery(state, "review", { target: "HEAD~1..HEAD" }, outcome);
		expect(hold?.reason).toContain("defect");
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/a.ts" }).block).toBe(true);

		const sound = depsFor({ review: { label: "sound", confidence: 0.92 }, resolves_hold: { probability: 0.95 } });
		await review(sound.deps, state, {
			kind: "diff",
			target: "HEAD~1..HEAD",
			claim: "the report writer is thread safe",
			evidence: [{ kind: "code", quote: "the map is guarded by a lock" }],
		});

		expect(state.hold).toBeDefined();

		const consultDeps = depsFor({ consult: { probability: 0.95 }, resolves_hold: { probability: 0.95 } });
		await consult(consultDeps.deps, state, {
			mode: "recovery",
			...boundRecovery(state, "guard the shared map with a lock"),
		});

		expect(state.hold).toBeUndefined();
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/a.ts" }).block).toBe(false);
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
	test("FR-11: a recent action may serve one topic without serving every topic", async () => {
		const { deps, calls } = depsFor({ "direction:1": { label: "on_course", confidence: 0.9 } });
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = PLAN_TOPICS;
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });

		const outcome = await courseCheck(deps, state);

		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["approved"]).toBe(true);
		expect(JSON.stringify(calls[0]?.state)).toContain("wrote the report");
	});

	test("FR-25: an off-course action is named in the hold", async () => {
		const { deps } = depsFor({
			"direction:1": { label: "off_course", confidence: 0.9 },
		});
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = [
			{ id: "good", section: "collect", paths: ["src/a.ts"], requirement: "report the coverage" },
			{ id: "bad", section: "format", paths: ["src/b.ts"], requirement: "format the report" },
		];
		recordAction(state, { tool: "write", target: "src/b.ts", excerpt: "wrote something else" });

		const outcome = await courseCheck(deps, state);

		expect(outcome.details?.["approved"]).toBe(false);
		expect(state.hold?.reason).toContain("off_course");
	});

	test("FR-25: without plan topics the course check asks nothing and holds nothing", async () => {
		const { deps, calls } = depsFor({});
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });

		const outcome = await courseCheck(deps, state);

		expect(outcome.ok).toBe(true);
		expect(calls).toHaveLength(0);
		expect(state.hold).toBeUndefined();
	});

	test("FR-12, FR-17: completion incorporates action judgments only in completion-only mode", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = PLAN_TOPICS;
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });

		const interval = depsFor({ follows_requirements: { label: "follows", confidence: 0.94 } });
		const intervalOutcome = await completionCheck(interval.deps, state, { course: false });

		expect(intervalOutcome.ok).toBe(true);
		expect(state.completion?.approved).toBe(true);

		const completionOnly = depsFor({
			follows_requirements: { label: "follows", confidence: 0.94 },
			"direction:1": { label: "on_course", confidence: 0.9 },
		});
		await completionCheck(completionOnly.deps, state, { course: true });

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

describe("FR-09 - a below-floor answer teaches recovery instead of stopping", () => {
	test("FR-09: a below-floor choice consult remains non-approving", async () => {
		const { deps } = depsFor({ consult: { label: "keep", confidence: 0.4 } });
		const outcome = await consult(deps, freshState(), {
			mode: "choice",
			question: "Keep or replace the parser?",
			context: "the parser is stable but slow",
			alternatives: [
				{ label: "keep", meaning: "keep the parser" },
				{ label: "replace", meaning: "rewrite the parser" },
			],
		});

		expect(outcome.ok).toBe(false);
	});

	test("FR-09: a below-floor boolean consult remains non-approving", async () => {
		const { deps } = depsFor({ consult: { probability: 0.5 } });
		const outcome = await consult(deps, freshState(), {
			mode: "boolean",
			question: "Is the evidence enough to proceed?",
			context: "one run passed",
			trueMeaning: "proceed",
			falseMeaning: "gather more evidence",
		});

		expect(outcome.ok).toBe(false);
	});

	test("FR-14: an acceptance below its confidence floor remains unapproved", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		const { deps } = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.3 } });

		const outcome = await acceptance(deps, state, {
			aspect: "business",
			claim: "the report serves the owner's need",
			evidence: [
				{ kind: "execution", quote: "the report was generated with every requested section" },
				{ kind: "code", quote: "0 diagnostics" },
			],
		});

		expect(outcome.ok).toBe(false);
	});
});

describe("FR-57 - strict autonomous decisions", () => {
	test("an on-plan action outside the owner envelope is not authorized", async () => {
		const state = planState("Update the project", ["Update the project files"]);
		state.autonomous = true;
		state.planTopics = PLAN_TOPICS;
		state.plan = { taskFingerprint: state.task!.fingerprint, planUrl: PLAN_URL, planDigest: "bound" };
		const { deps } = depsFor({
			action: { label: "on_course", confidence: 0.99 },
			within_authority: { probability: 0.02 },
		});

		const outcome = await actionCheck(deps, state, Object.assign({
			tool: "write", target: "/outside/project.txt", change: JSON.stringify({ path: "/outside/project.txt", content: "x" }),
		}, { callId: "outside-owner-envelope" }));

		expect(outcome.details?.["approved"]).toBe(false);
	});

	test("new action evidence after three refusals is judged without a continuation bypass", async () => {
		const state = planState("Update the project", ["Update the project files"]);
		state.autonomous = true;
		state.planTopics = PLAN_TOPICS;
		state.plan = { taskFingerprint: state.task!.fingerprint, planUrl: PLAN_URL, planDigest: "bound" };
		const rejected = depsFor({
			action: { label: "off_course", confidence: 0.99 },
			within_authority: { probability: 0.99 },
		});
		for (const version of [1, 2, 3]) {
			await actionCheck(rejected.deps, state, Object.assign({
				tool: "write", target: "src/report.ts", change: JSON.stringify({ path: "src/report.ts", content: `wrong ${version}` }),
			}, { callId: `rejected-${version}` }));
		}
		const accepted = depsFor({
			action: { label: "on_course", confidence: 0.99 },
			within_authority: { probability: 0.99 },
		});

		const outcome = await actionCheck(accepted.deps, state, Object.assign({
			tool: "write", target: "src/report.ts", change: JSON.stringify({ path: "src/report.ts", content: "corrected from actual evidence" }),
		}, { callId: "changed-evidence" }));

		expect(outcome.details?.["approved"]).toBe(true);
		expect(accepted.calls).toHaveLength(1);
		expect(continuationAllowed(state)).toBe(false);
	});

	test("a changed plan can be reviewed after strict refusal accounting reaches its limit", async () => {
		const state = planState("Report coverage", ["Collect run data"]);
		state.autonomous = true;
		state.exhausted = ["plan"];
		const { deps } = depsFor({
			outline_requirement_1: { probability: 0.99 },
			outline_step_1: { probability: 0.99 },
		});

		await planReview(deps, state, {
			phase: "outline",
			steps: [{ id: "collect", summary: "Collect the observed coverage results.", requirement: "Collect run data" }],
			evidence: [{ kind: "user", quote: "Report coverage" }],
		});

		expect(state.planDraft?.outlineApproved).toBe(true);
	});
});

describe("FR-25 - an unreliable action answer is no decision, not a deviation", () => {
	test("a below-floor on_course refuses the call without claiming a proven deviation", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = PLAN_TOPICS;
		state.plan = { taskFingerprint: state.task!.fingerprint, planUrl: PLAN_URL, planDigest: "d" };
		const { deps } = depsFor({ action: { label: "on_course", confidence: POLICY.minConfidenceToApprove - 0.2 } });

		const outcome = await actionCheck(deps, state, {
			tool: "bash",
			target: "git log",
			change: 'git log --oneline | head -3 && echo "---" && git diff --stat',
		});

		expect(outcome.details?.["approved"]).toBe(false);
		expect(asRecord(state.hold?.result)?.["kind"]).toBe("unclear");
		expect(outcome.text).toContain("no reliable decision");
		expect(outcome.text).toContain("not a proven deviation");
		expect(continuationAllowed(state)).toBe(false);
	});

	test("a missing plan is a prerequisite and creates no finding", async () => {
		const state = freshState();
		const { deps, calls } = depsFor({});

		const outcome = await actionCheck(deps, state, { tool: "write", target: "src/a.ts", change: "x" });

		expect(calls).toHaveLength(0);
		expect(asRecord(outcome.details)?.["prerequisite"]).toBe(true);
		expect(recordRecovery(state, "action", { tool: "write" }, outcome)).toBeUndefined();
		expect(state.hold).toBeUndefined();
	});
});

describe("FR-29 - owner follow-ups are classified, not automatically re-aimed", () => {
	test("a continuation preserves every approval", async () => {
		const state = freshState();
		const task = registerTask(state, "Build a coverage report");
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Report coverage"] };
		queueOwnerMessage(state, "Which format will it use?");
		const { deps } = depsFor({ owner_update: { label: "continue", confidence: 0.94 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(true);
		expect(asRecord(outcome.details)?.["classification"]).toBe("continue");
		expect(state.task?.fingerprint).toBe(task.fingerprint);
		expect(state.requirementsApproval?.items).toEqual(["Report coverage"]);
		expect(state.pendingOwnerMessages).toEqual([]);
	});

	test("an additive requirement extends the objective and invalidates only dependent reviews", async () => {
		const state = freshState();
		const task = registerTask(state, "Build a coverage report");
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Report coverage"] };
		state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://x-plan.md", planDigest: "d" };
		const hold = recordRecovery(state, "review", { target: "a.ts" }, {
			ok: false,
			text: "a defect",
			details: { approved: false },
		});
		const submissionCount = state.submissions.length;
		queueOwnerMessage(state, "Also keep the previous format as an option");
		const { deps } = depsFor({ owner_update: { label: "amend", confidence: 0.93 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(true);
		expect(state.task?.request).toContain("Also keep the previous format");
		expect(state.task?.request).toContain("Build a coverage report");
		expect(state.task?.fingerprint).not.toBe(task.fingerprint);
		expect(state.requirementsApproval).toBeUndefined();
		expect(state.plan).toBeUndefined();
		expect(state.hold?.id).toBe(hold?.id);
		expect(state.submissions).toHaveLength(submissionCount);
	});

	test("a replacement sets the reaim requirement without clearing approvals", async () => {
		const state = freshState();
		const task = registerTask(state, "Build a coverage report");
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Report coverage"] };
		queueOwnerMessage(state, "Stop the report and build a dashboard instead");
		const { deps } = depsFor({ owner_update: { label: "replace", confidence: 0.97 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(true);
		expect(state.directionPending?.text).toContain("dashboard");
		expect(state.task?.request).toBe("Build a coverage report");
		expect(state.requirementsApproval?.items).toEqual(["Report coverage"]);
	});

	test("an unclear classification holds execution for a bound consultation", async () => {
		const state = freshState();
		registerTask(state, "Build a coverage report");
		queueOwnerMessage(state, "Do the thing we discussed");
		const { deps } = depsFor({ owner_update: { label: "unclear", confidence: 0.55 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(false);
		expect(state.hold?.boundary).toBe("owner-update");
		expect(state.hold?.reason).toContain("owner-update");
	});

	test("a below-floor classification label changes nothing and holds execution", async () => {
		const state = freshState();
		const task = registerTask(state, "Build a coverage report");
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Report coverage"] };
		queueOwnerMessage(state, "Also keep the previous format as an option");
		const { deps } = depsFor({ owner_update: { label: "amend", confidence: POLICY.minConfidenceToApprove - 0.2 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["classification"]).toBe("unclear");
		expect(state.task?.request).toBe("Build a coverage report");
		expect(state.task?.fingerprint).toBe(task.fingerprint);
		expect(state.requirementsApproval?.items).toEqual(["Report coverage"]);
		expect(state.hold?.boundary).toBe("owner-update");
	});

	test("a message arriving during classification invalidates the result", async () => {
		const state = freshState();
		registerTask(state, "Build a coverage report");
		queueOwnerMessage(state, "Also keep the old format");
		const { deps } = depsFor({ owner_update: { label: "amend", confidence: 0.95 } });
		const base = deps.judge;
		deps.judge = async (material, questions) => {
			queueOwnerMessage(state, "A newer message");
			return base(material, questions);
		};

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(false);
		expect(state.task?.request).toBe("Build a coverage report");
		expect(state.pendingOwnerMessages).toEqual(["Also keep the old format", "A newer message"]);
	});
});

describe("FR-06 - the callable course check", () => {
	test("without an approved plan it names the prerequisite instead of passing", async () => {
		const state = freshState();
		registerTask(state, "Build a coverage report");
		const { deps, calls } = depsFor({});

		const outcome = await courseCheck(deps, state, { claim: "wrote the report reader" });

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["skipped"]).toBe(true);
		expect(asRecord(outcome.details)?.["prerequisite"]).toBe("approved plan");
		expect(calls).toHaveLength(0);
	});

	test("it works before any recent action once a plan exists", async () => {
		const state = freshState();
		const task = registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: task.fingerprint, planUrl: PLAN_URL, planDigest: "d" };
		state.planTopics = PLAN_TOPICS;
		const { deps, calls } = depsFor({ course: { label: "on_course", confidence: 0.9 } });

		const outcome = await courseCheck(deps, state, {
			claim: "the report reads the recorded coverage",
			nextAction: "render the table",
			evidence: [{ kind: "code", quote: "reads coverage.json" }],
		});

		expect(outcome.ok).toBe(true);
		expect(asRecord(outcome.details)?.["approved"]).toBe(true);
		expect(calls).toHaveLength(1);
		expect(state.hold).toBeUndefined();
	});

	test("an off-course claim records a finding and blocks consequential work", async () => {
		const state = freshState();
		const task = registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: task.fingerprint, planUrl: PLAN_URL, planDigest: "d" };
		state.planTopics = PLAN_TOPICS;
		const off = depsFor({ course: { label: "off_course", confidence: 0.92 } });

		const outcome = await courseCheck(off.deps, state, { claim: "wrote an unrelated marketing page" });

		expect(outcome.ok).toBe(false);
		expect(state.hold?.boundary).toBe("course-check");
		expect(mutationGate(state, boundaryConfig(), "write", { path: "src/a.ts" }).block).toBe(true);
	});

	test("an approving check leaves an unrelated finding alone", async () => {
		const state = freshState();
		const task = registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: task.fingerprint, planUrl: PLAN_URL, planDigest: "d" };
		state.planTopics = PLAN_TOPICS;
		const unrelated = recordRecovery(state, "review", { target: "a.ts" }, {
			ok: false,
			text: "a defect",
			details: { approved: false },
		});
		const on = depsFor({ course: { label: "on_course", confidence: 0.94 } });

		const outcome = await courseCheck(on.deps, state, { claim: "render the coverage table" });

		expect(outcome.ok).toBe(true);
		expect(state.hold?.id).toBe(unrelated?.id);
		expect(state.hold?.boundary).toBe("review");
	});
});

describe("FR-22 - repeated reaim attempts use the actual owner and task identity", () => {
	test("rewording the quote and evidence does not buy another judge call", async () => {
		const state = freshState();
		registerTask(state, "old course");
		state.request = { text: "replace the report with a dashboard", weight: "judged" };
		const { deps, calls } = depsFor({ reaim: { probability: 0.2 } });

		const first = await reaim(deps, state, {
			interjection: "replace the report with a dashboard",
			evidence: [{ kind: "user", quote: "replace the report with a dashboard" }],
		});
		const second = await reaim(deps, state, {
			interjection: "replace the report with a dashboard",
			evidence: [{ kind: "user", quote: "replace the report with a dashboard" }, { kind: "spec", quote: "a different wording" }],
		});

		expect(first.ok).toBe(false);
		expect(second.ok).toBe(false);
		expect(calls).toHaveLength(1);
		expect(continuationAllowed(state)).toBe(false);
	});
});

describe("FR-08 - the trusted source context reaches the judge", () => {
	test("the introduction, owner history and selected file contents are evaluated as data", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		queueOwnerMessage(state, "Report the coverage of the last run");
		state.trustedContext = {
			introduction: "These sources are authenticated for this task.",
			ownerMessages: [],
			selectedSources: [
				{
					id: "source-1",
					kind: "requirements",
					sessionId: "session-1",
					content: "The exact approved requirements text",
					digest: "d",
					origin: "judge_approved",
				},
			],
		};
		const { deps, calls } = depsFor({ consult: { probability: 0.9 } });

		await consult(deps, state, {
			mode: "boolean",
			question: "Does the report satisfy the approved requirements?",
			context: "the selected requirements are attached",
			trueMeaning: "yes",
			falseMeaning: "no",
		});

		const judged = asRecord(calls[0]?.state);
		const trusted = asRecord(judged?.["trustedContext"]);
		expect(trusted?.["introduction"]).toContain("authenticated");
		expect(asRecord((trusted?.["selectedSources"] as unknown[])[0])?.["content"]).toBe("The exact approved requirements text");
		expect(judged?.["ownerMessages"]).toEqual(["Report the coverage of the last run"]);
		expect(judged?.["provenanceRule"]).toContain("data");
	});
});
