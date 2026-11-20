import { describe, expect, test } from "bun:test";
import {
	acceptance,
	actionCheck,
	antiSlop,
	completionCheck,
	consult,
	courseCheck,
	observedOutcome,
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
import {
	acceptanceAt,
	freshState,
	queueOwnerMessage,
	recordAction,
	recordRecovery,
	registerTask,
	sha256,
	type JevState,
} from "../src/state.js";
import { asRecord, POLICY, type PlanTopic } from "../src/types.js";
import {
	answeringJudge,
	boundaryConfig,
	cleanProtocolAnswers,
	failingJudge,
	type FakeAnswerSource,
} from "./helpers.js";

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

	test("FR-29: a historical message that merely contains the words cannot re-aim", async () => {
		const state = freshState();
		registerTask(state, "Ship the export flag");
		state.ownerMessages = ["Do not replace the export flag work with a dashboard."];
		state.request = { text: "Continue the export flag work.", weight: "judged" };
		const { deps, calls } = depsFor({ reaim: { probability: 0.99 } });

		const outcome = await reaim(deps, state, {
			interjection: "replace the export flag work with a dashboard",
			evidence: [{ kind: "user", quote: "replace the export flag work with a dashboard" }],
		});

		expect(outcome.ok).toBe(false);
		expect(state.task?.request).toBe("Ship the export flag");
		expect(calls).toHaveLength(0);
	});

	test("FR-29: the classified replacement's own message opens the re-aim", async () => {
		const state = freshState();
		registerTask(state, "Build a coverage report");
		queueOwnerMessage(state, "Stop the report and build a dashboard instead");
		const classified = await ownerUpdate(depsFor({ owner_update: { label: "replace", confidence: 0.97 } }).deps, state);
		expect(classified.ok).toBe(true);
		expect(state.directionPending?.text).toBe("Stop the report and build a dashboard instead");
		const { deps } = depsFor({ reaim: { probability: 0.92 } });

		const outcome = await reaim(deps, state, {
			interjection: "Stop the report and build a dashboard instead",
			evidence: [{ kind: "user", quote: "Stop the report and build a dashboard instead" }],
		});

		expect(outcome.ok).toBe(true);
		expect(state.task?.request).toBe("Stop the report and build a dashboard instead");
		expect(state.directionPending).toBeUndefined();
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
			execution_evidence: { probability: 0.9 },
			code_evidence: { probability: 0.9 },
			topic_1: { probability: 0.2 },
			topic_1_execution: { label: "evidence_1", confidence: 0.9 },
			topic_1_code: { label: "evidence_2", confidence: 0.9 },
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
		expect(calls[0]?.questions.map(question => question.name)).toEqual(["acceptance", "execution_evidence", "code_evidence", "topic_1", "topic_1_execution", "topic_1_code"]);
	});

	test("FR-26: narrated execution and code quotes do not approve the submission", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = PLAN_TOPICS;
		const { deps } = depsFor({
			acceptance: { label: "serves_business_need", confidence: 0.93 },
			execution_evidence: { probability: 0.1 },
			code_evidence: { probability: 0.2 },
			topic_1: { probability: 0.95 },
			topic_1_execution: { label: "evidence_1", confidence: 0.9 },
			topic_1_code: { label: "evidence_2", confidence: 0.9 },
		});

		const outcome = await acceptance(deps, state, {
			aspect: "business",
			claim: "the report serves the owner's need",
			evidence: [
				{ kind: "execution", quote: "The test suite passes and the report looks correct." },
				{ kind: "code", quote: "The implementation reports coverage correctly." },
			],
		});

		expect(outcome.details?.["approved"]).not.toBe(true);
		expect(outcome.text).toContain("literal command");
		expect(asRecord(outcome.details)?.["kind"]).toBe("refusal");
	});

	test("inconclusive aspect results distinguish missing and ambiguous literal evidence", async () => {
		const state = freshState();
		registerTask(state, "Report coverage for the last run");
		const { deps } = depsFor({
			acceptance: { label: "unsupported", confidence: 0.95 },
			execution_evidence: { probability: 0.1 },
			code_evidence: { probability: 0.52 },
		});
		const result = await acceptance(deps, state, {
			aspect: "business",
			claim: "The report contains the coverage count.",
			evidence: [{ kind: "execution", quote: "12 pass" }, { kind: "code", quote: "return result.coverage;" }],
		});
		expect(result.details).toMatchObject({ kind: "unclear", approved: false, evidenceQuestions: { execution: 0.1, code: 0.52 } });
		expect(result.text).toContain("literal command with its observed output: missing");
		expect(result.text).toContain("code, diff, static diagnostic or measurement: inconclusive");
		expect(result.text).not.toContain("ask the owner");
	});

	test("FR-26: a topic with no identified execution basis is not approved", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = PLAN_TOPICS;
		const { deps } = depsFor({
			acceptance: { label: "serves_business_need", confidence: 0.93 },
			execution_evidence: { probability: 0.9 },
			code_evidence: { probability: 0.9 },
			topic_1: { probability: 0.95 },
			topic_1_execution: { label: "none", confidence: 0.9 },
			topic_1_code: { label: "evidence_2", confidence: 0.9 },
		});

		const outcome = await acceptance(deps, state, {
			aspect: "business",
			claim: "the report serves the owner's need",
			evidence: [
				{ kind: "execution", quote: "bun test: 132 pass" },
				{ kind: "code", quote: "0 diagnostics" },
			],
		});

		const basis = outcome.details?.["basis"];
		expect(outcome.details?.["approved"]).not.toBe(true);
		expect(outcome.text).toContain("collect");
		expect(outcome.text).toContain("execution");
		expect(Array.isArray(basis)).toBe(true);
		expect((basis as Array<Record<string, unknown>>)[0]?.["execution"]).toEqual({ status: "none" });
	});

	test("FR-26: a batch over the question limit is not checked instead of dropping the basis questions", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = Array.from({ length: 67 }, (_, index) => ({
			id: `topic-${index}`,
			section: `## Topic ${index}`,
			paths: ["src/report.ts"],
			requirement: "Report the coverage",
		}));
		const { deps, calls } = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.9 } });

		const outcome = await acceptance(deps, state, {
			aspect: "business",
			claim: "the report serves the owner's need",
			evidence: [
				{ kind: "execution", quote: "bun test: 132 pass" },
				{ kind: "code", quote: "0 diagnostics" },
			],
		});

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["kind"]).toBe("invalid");
		expect(calls).toHaveLength(0);
	});

	test("FR-43: an unmet topic returns its approved verification section before any repair", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		const section = "## Collect\nRead the run data and verify the count.";
		state.planTopics = [{ id: "collect", section, paths: ["src/report.ts"], requirement: "Collect run data" }];
		const { deps } = depsFor({
			acceptance: { label: "serves_business_need", confidence: 0.93 },
			execution_evidence: { probability: 0.9 },
			code_evidence: { probability: 0.9 },
			topic_1: { probability: 0.2 },
			topic_1_execution: { label: "evidence_1", confidence: 0.9 },
			topic_1_code: { label: "evidence_2", confidence: 0.9 },
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
		expect(outcome.text).toContain("Collect run data");
		expect(outcome.text).toContain("Read the run data and verify the count.");
		expect(outcome.text).toContain("do not change the implementation");
		expect(asRecord(outcome.details)?.["unmetSections"]).toEqual([{ id: "collect", requirement: "Collect run data", section }]);
	});
});

test("planned review keeps a proven task, a weak task and a contradiction distinct", async () => {
	const request = "Show coverage and cap page size at five.";
	const state = freshState();
	const task = registerTask(state, request);
	const source = "## Coverage\nShow 98%.\n\n## Polish\nImprove display polish.\n\n## Cap\nCap at five.";
	state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://plan.md", planDigest: sha256(source) };
	state.planTopics = [
		{ id: "coverage", section: "Show 98%.", requirement: "Show coverage.", paths: ["report.ts"] },
		{ id: "polish", section: "Improve display polish.", requirement: "Show coverage.", paths: ["report.ts"] },
		{ id: "cap", section: "Cap at five.", requirement: "Cap page size at five.", paths: ["report.ts"] },
	];
	const calls: string[] = [];
	const result = await observedOutcome({
		config: boundaryConfig(),
		readArtifact: async () => source,
		judge: (material, questions) => {
			const id = String(asRecord(asRecord(material)?.["task"])?.["id"]);
			calls.push(id);
			return answeringJudge({
				task_definition: { label: id === "polish" ? "uncheckable" : "checkable" },
				task_review: { label: id === "cap" ? "deviates" : "observed" },
				task_basis: { label: "evidence_2" },
				cleanup_evidence_1: { label: "none" },
			}).judge(material, questions);
		},
	}, state, [
		{ kind: "code", quote: "export const display = '98%'; export const limit = 10;" },
		{ kind: "execution", quote: "bun test report.test.ts\nCoverage 98%; expected page limit 5, got 10" },
	]);
	expect(result.details).toMatchObject({
		approved: false,
		tasks: [
			{ id: "coverage", status: "approved" },
			{ id: "polish", status: "bad_task", reason: expect.stringContaining("Improve display polish.") },
			{ id: "cap", status: "defect", basis: expect.arrayContaining([expect.objectContaining({ quote: expect.stringContaining("expected page limit 5, got 10") })]) },
		],
		overall: { status: "not_checked" },
	});
	expect(result.text).toContain("Name one scenario");
	expect(calls).toEqual(["coverage", "polish", "cap"]);
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
		const deps = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.95 }, execution_evidence: { probability: 0.95 }, code_evidence: { probability: 0.95 } }).deps;
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

	test("FR-38: the action judgment retains decisions outside approved step sections", async () => {
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
	});

	test("FR-38: changed approved plan bytes cannot supply an action conformance verdict", async () => {
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

	test("an off-task proposed action is recorded without changing revision or history", async () => {
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
	});
});

describe("FR-23 - staged plan refusal remains an open item", () => {
	test("repeated material costs no call and new evidence is judged after the refusal count", async () => {
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
			const fake = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.95 }, execution_evidence: { probability: 0.95 }, code_evidence: { probability: 0.95 } });
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
		const { deps } = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.91 }, execution_evidence: { probability: 0.9 }, code_evidence: { probability: 0.9 } });
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
		const { deps } = depsFor({ acceptance: { label: "architecture_defect", confidence: 0.9 }, execution_evidence: { probability: 0.9 }, code_evidence: { probability: 0.9 } });
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

	test("FR-16: a defect finding stays recorded as a diagnostic and a sound review does not erase it", async () => {
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
		expect(state.hold?.id).toBe(hold?.id);

		const sound = depsFor({ review: { label: "sound", confidence: 0.92 } });
		const second = await review(sound.deps, state, {
			kind: "diff",
			target: "HEAD~1..HEAD",
			claim: "the report writer is thread safe",
			evidence: [{ kind: "code", quote: "the map is guarded by a lock" }],
		});

		expect(second.ok).toBe(true);
		expect(state.hold?.id).toBe(hold?.id);
		expect(asRecord(state.hold?.result)?.["kind"]).toBe("defect");
	});

	test("an unrelated background finding does not invalidate an in-flight review", async () => {
		const state = freshState();
		const background = { id: "background", reason: "an unrelated action was not checked" };
		const { deps } = depsFor({
			review: () => {
				state.hold = background;
				return { label: "sound", confidence: 0.92 };
			},
		});
		const outcome = await review(deps, state, {
			kind: "diff", target: "src/report.ts", claim: "empty reports are handled",
			evidence: [{ kind: "code", quote: "if (!report) return null;" }],
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["verdict"]).toBe("sound");
		expect(state.hold).toBe(background);
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

describe("FR-09 - a below-floor answer is uncertainty, not approval", () => {
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
		const { deps } = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.3 }, execution_evidence: { probability: 0.9 }, code_evidence: { probability: 0.9 } });

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
	test("an on-plan action outside the owner envelope records a refusal diagnostic", async () => {
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

	test("new action evidence after three refusals is judged from its own content", async () => {
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
		const { deps } = depsFor({ owner_update: { label: "continue", confidence: 0.94 }, owner_requirement_1: { probability: 0.95 } });

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
		const { deps } = depsFor({ owner_update: { label: "amend", confidence: 0.93 }, owner_requirement_1: { probability: 0.95 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(true);
		expect(state.task?.request).toContain("Also keep the previous format");
		expect(state.task?.request).toContain("Build a coverage report");
		expect(state.task?.fingerprint).not.toBe(task.fingerprint);
		expect(state.requirementsApproval).toBeUndefined();
		expect(state.requirementsRetained?.taskFingerprint).toBe(state.task?.fingerprint);
		expect(state.requirementsRetained?.items).toEqual(["Report coverage"]);
		expect(state.plan).toBeUndefined();
		expect(state.hold?.id).toBe(hold?.id);
		expect(state.submissions).toHaveLength(submissionCount);
	});

	test("FR-42: an unaffected outline step and its accepted section stay accepted", async () => {
		const state = freshState();
		const task = registerTask(state, "Build a coverage report");
		const items = ["Report coverage", "Keep the JSON format"];
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items };
		state.planDraft = {
			taskFingerprint: task.fingerprint,
			requirementsDigest: sha256(JSON.stringify(items)),
			steps: [
				{ id: "collect", summary: "Collect coverage.", requirement: "Report coverage" },
				{ id: "format", summary: "Keep JSON output.", requirement: "Keep the JSON format" },
			],
			outlineApproved: true,
			details: [
				{ id: "collect", section: "## Collect", paths: ["src/report.ts"], requirement: "Report coverage" },
				{ id: "format", section: "## Format", paths: ["src/format.ts"], requirement: "Keep the JSON format" },
			],
		};
		state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://x-plan.md", planDigest: "d" };
		queueOwnerMessage(state, "Also print coverage per file");
		const { deps } = depsFor({ owner_update: { label: "amend", confidence: 0.93 }, owner_requirement_1: { probability: 0.95 }, owner_requirement_2: { probability: 0.1 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(true);
		expect(state.requirementsRetained?.items).toEqual(["Report coverage"]);
		expect(state.planDraft?.steps.map(step => step.id)).toEqual(["collect"]);
		expect(state.planDraft?.details.map(detail => detail.id)).toEqual(["collect"]);
		expect(state.planDraft?.outlineApproved).toBe(true);
		expect(state.plan).toBeUndefined();
	});

	test("a replacement sets the reaim requirement without clearing approvals", async () => {
		const state = freshState();
		const task = registerTask(state, "Build a coverage report");
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Report coverage"] };
		queueOwnerMessage(state, "Stop the report and build a dashboard instead");
		const { deps } = depsFor({ owner_update: { label: "replace", confidence: 0.97 }, owner_requirement_1: { probability: 0.95 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(true);
		expect(state.directionPending?.text).toContain("dashboard");
		expect(state.task?.request).toBe("Build a coverage report");
		expect(state.requirementsApproval?.items).toEqual(["Report coverage"]);
	});

	test("an unclear classification records the uncertainty as a diagnostic", async () => {
		const state = freshState();
		registerTask(state, "Build a coverage report");
		queueOwnerMessage(state, "Do the thing we discussed");
		const { deps } = depsFor({ owner_update: { label: "unclear", confidence: 0.55 } });

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(false);
		expect(state.hold?.boundary).toBe("owner-update");
		expect(state.hold?.reason).toContain("owner-update");
	});

	test("a below-floor classification label changes nothing and records a diagnostic", async () => {
		const state = freshState();
		const task = registerTask(state, "Build a coverage report");
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Report coverage"] };
		queueOwnerMessage(state, "Also keep the previous format as an option");
		const { deps } = depsFor({ owner_update: { label: "amend", confidence: POLICY.minConfidenceToApprove - 0.2 }, owner_requirement_1: { probability: 0.95 } });

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

describe("FR-42 - a judged owner correction retains unaffected decisions", () => {
	function amendmentState() {
		const state = freshState();
		const task = registerTask(state, "Report the line coverage of the last run");
		const kept = "Count the covered lines";
		const changed = "Print the coverage percentage";
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: [kept, changed] };
		state.planDraft = {
			taskFingerprint: task.fingerprint,
			requirementsDigest: sha256(JSON.stringify([kept, changed])),
			steps: [
				{ id: "count", summary: "Count the covered lines.", requirement: kept },
				{ id: "print", summary: "Print the coverage percentage.", requirement: changed },
			],
			outlineApproved: true,
			details: [
				{ id: "count", section: "## Count\nCount the covered lines.", paths: ["src/report.ts"], requirement: kept },
				{ id: "print", section: "## Print\nPrint the coverage percentage.", paths: ["src/report.ts"], requirement: changed },
			],
		};
		state.plan = { taskFingerprint: task.fingerprint, planUrl: PLAN_URL, planDigest: sha256("old plan") };
		state.planTopics = PLAN_TOPICS;
		return { state, task, kept, changed };
	}

	test("an amendment retains unaffected requirements, steps and details and reopens only dependents", async () => {
		const { state, task, kept, changed } = amendmentState();
		const hold = recordRecovery(state, "review", { target: "a.ts" }, { ok: false, text: "a defect", details: { approved: false } });
		const submissionCount = state.submissions.length;
		queueOwnerMessage(state, "Also print the coverage percentage for each file");
		const { deps, calls } = depsFor({
			owner_update: { label: "amend", confidence: 0.94 },
			owner_requirement_1: { probability: 0.9 },
			owner_requirement_2: { probability: 0.3 },
		});

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(true);
		expect(asRecord(outcome.details)?.["classification"]).toBe("amend");
		expect(asRecord(outcome.details)?.["retained"]).toEqual([kept]);
		expect(asRecord(outcome.details)?.["reReview"]).toEqual([changed]);
		expect(calls[0]?.questions.map(question => question.name)).toEqual(["owner_update", "owner_requirement_1", "owner_requirement_2"]);
		expect(state.task?.request).toBe("Report the line coverage of the last run\n\nAlso print the coverage percentage for each file");
		expect(state.task?.fingerprint).not.toBe(task.fingerprint);
		expect(state.requirementsApproval).toBeUndefined();
		expect(state.requirementsRetained?.taskFingerprint).toBe(state.task?.fingerprint);
		expect(state.requirementsRetained?.items).toEqual([kept]);
		expect(state.planDraft?.steps.map(step => step.id)).toEqual(["count"]);
		expect(state.planDraft?.details.map(detail => detail.id)).toEqual(["count"]);
		expect(state.planDraft?.details[0]?.section).toBe("## Count\nCount the covered lines.");
		// The surviving step already had an accepted section, so it stays accepted; the final review
		// still has to cover the extended objective, which is what reopens the dependent decision.
		expect(state.planDraft?.outlineApproved).toBe(true);
		expect(state.planDraft?.taskFingerprint).toBe(state.task?.fingerprint);
		expect(state.planDraft?.requirementsDigest).toBe(sha256(JSON.stringify([kept])));
		expect(state.plan).toBeUndefined();
		expect(state.planTopics).toEqual([]);
		expect(state.hold?.id).toBe(hold?.id);
		expect(state.submissions).toHaveLength(submissionCount);
	});

	test("a below-floor retention answer manufactures no approval and erases no established work", async () => {
		const { state } = amendmentState();
		queueOwnerMessage(state, "Also print the coverage percentage for each file");
		const { deps } = depsFor({
			owner_update: { label: "amend", confidence: 0.94 },
			owner_requirement_1: { probability: 0.5 },
			owner_requirement_2: { probability: 0.5 },
		});

		const outcome = await ownerUpdate(deps, state);

		expect(outcome.ok).toBe(true);
		expect(state.requirementsApproval).toBeUndefined();
		expect(state.requirementsRetained).toBeUndefined();
		expect(state.planDraft).toBeUndefined();
		expect(state.hold).toBeUndefined();
		expect(state.task?.request).toContain("Also print the coverage percentage for each file");
	});

	test("a re-reviewed corrected obligation finalizes with retained independent details", async () => {
		const artifact = "# Plan\n\n## Count\nCount the covered lines.\n\n## Print\nPrint the coverage percentage for each file.\n";
		const { state, kept, changed } = amendmentState();
		queueOwnerMessage(state, "Also print the coverage percentage for each file");
		await ownerUpdate(depsFor({
			owner_update: { label: "amend", confidence: 0.94 },
			owner_requirement_1: { probability: 0.9 },
			owner_requirement_2: { probability: 0.2 },
		}).deps, state);
		const corrected = "Print the coverage percentage for each file";
		expect(changed).not.toBe(corrected);
		const { deps, calls } = depsFor(
			{
				coverage: { probability: 0.92 },
				item_2: { probability: 0.93 },
				outline_requirement_1: { probability: 0.94 },
				outline_requirement_2: { probability: 0.94 },
				outline_step_1: { probability: 0.93 },
				detail: { label: "ready", confidence: 0.92 },
				finalize_consistency: { probability: 0.94 },
				finalize_scope: { probability: 0.93 },
			},
			planReader(artifact),
		);

		const declared = await requirements(deps, state, {
			request: state.task!.request,
			items: [
				{ text: kept, source: "Report the line coverage of the last run" },
				{ text: corrected, source: "Also print the coverage percentage for each file" },
			],
		});
		expect(declared.details?.["approved"]).toBe(true);
		expect(calls[0]?.questions.map(question => question.name)).toEqual(["coverage", "item_2"]);
		expect(state.requirementsApproval?.items).toEqual([kept, corrected]);
		expect(state.requirementsRetained).toBeUndefined();
		expect(state.planDraft?.steps.map(step => step.id)).toEqual(["count"]);
		expect(state.planDraft?.details.map(detail => detail.id)).toEqual(["count"]);
		expect(state.planDraft?.outlineApproved).toBe(false);

		const outline = await planReview(deps, state, {
			phase: "outline",
			steps: [{ id: "print", summary: "Print the coverage percentage for each file.", requirement: corrected }],
			evidence: [{ kind: "user", quote: "Also print the coverage percentage for each file" }],
		});
		expect(outline.ok).toBe(true);
		expect(state.planDraft?.outlineApproved).toBe(true);
		expect(state.planDraft?.details.map(detail => detail.id)).toEqual(["count"]);

		const reviewed = await planReview(deps, state, {
			phase: "detail",
			plan: PLAN_URL,
			topic: { id: "print", section: "## Print\nPrint the coverage percentage for each file.", paths: ["src/report.ts"], requirement: corrected },
			evidence: [{ kind: "user", quote: "Also print the coverage percentage for each file" }],
		});
		expect(reviewed.text).toContain("detail approved");
		expect(calls.filter(call => call.questions.some(question => question.name === "detail"))).toHaveLength(1);

		const finalized = await planReview(deps, state, {
			phase: "finalize",
			plan: PLAN_URL,
			evidence: [{ kind: "user", quote: "Also print the coverage percentage for each file" }],
		});
		expect(finalized.ok).toBe(true);
		expect(state.plan?.taskFingerprint).toBe(state.task?.fingerprint);
		expect(state.plan?.planDigest).toBe(sha256(artifact));
		expect(state.planTopics.map(topic => topic.id)).toEqual(["count", "print"]);
		expect(JSON.stringify(calls.at(-1)?.state)).toContain("Count the covered lines.");
	});
});

describe("FR-06 - the callable course check", () => {
	test.each(["explicit", "interval"] as const)("FR-25: a below-floor off-course %s check remains uncertainty and records a diagnostic", async mode => {
		const state = freshState();
		const task = registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: task.fingerprint, planUrl: PLAN_URL, planDigest: "d" };
		state.planTopics = PLAN_TOPICS;
		if (mode === "interval") recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "Reads the recorded coverage" });
		const { deps } = depsFor({
			course: { label: "off_course", confidence: 0.56 },
			"direction:1": { label: "off_course", confidence: 0.56 },
		});
		const outcome = await courseCheck(deps, state, mode === "explicit" ? { claim: "render the coverage report" } : undefined);
		expect(outcome.details?.["approved"]).toBe(false);
		expect(outcome.text).toContain("inconclusive");
		expect(outcome.text).not.toContain("Class: defect");
		expect(asRecord(state.hold?.result)?.["kind"]).toBe("unclear");
	});
	test("an uncertain developer defect verdict does not establish a defect", async () => {
		const state = freshState();
		const { deps } = depsFor({ review: { label: "defect", confidence: 0.56 } });
		const outcome = await review(deps, state, {
			kind: "diff", target: "src/report.ts", claim: "The coverage reader guards empty input.",
			evidence: [{ kind: "code", quote: "if (!report) return 0;" }],
		});
		expect(outcome.details?.["approved"]).toBe(false);
		expect(outcome.details?.["kind"]).toBe("unclear");
		expect(outcome.text).not.toContain("Class: defect");
	});

	test.each([
		["follows", "off_course", 0.56, "unclear"],
		["deviates", "on_course", 0.94, "defect"],
	] as const)("completion classifies %s with direction %s at %s as %s", async (follows, direction, confidence, kind) => {
		const state = freshState();
		const task = registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: task.fingerprint, planUrl: PLAN_URL, planDigest: "d" };
		state.planTopics = PLAN_TOPICS;
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "Reads recorded coverage" });
		const { deps } = depsFor({
			follows_requirements: { label: follows, confidence: 0.94 },
			"direction:1": { label: direction, confidence },
		});
		const outcome = await completionCheck(deps, state, { course: true });
		expect(outcome.details?.["approved"]).toBe(false);
		expect(asRecord(state.hold?.result)?.["kind"]).toBe(kind);
		expect(outcome.text).toContain(kind === "defect" ? "Class: defect" : "Class: inconclusive");
	});


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

	test("an off-course claim records a diagnostic finding", async () => {
		const state = freshState();
		const task = registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: task.fingerprint, planUrl: PLAN_URL, planDigest: "d" };
		state.planTopics = PLAN_TOPICS;
		const off = depsFor({ course: { label: "off_course", confidence: 0.92 } });

		const outcome = await courseCheck(off.deps, state, { claim: "wrote an unrelated marketing page" });

		expect(outcome.ok).toBe(false);
		expect(state.hold?.boundary).toBe("course-check");
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

describe("stale answers, uncertain triage and exact submitted content", () => {
	const externalState = () => {
		const state = freshState();
		state.request = { text: "Write the legal memo", weight: "judged" };
		registerTask(state, "Write the legal memo", true);
		return state;
	};
	const memo = "The agreement takes effect on 1 January 2027. The supplier must deliver within 30 days.";
	const memoClaim = {
		id: "claim-1",
		text: "The agreement takes effect on 1 January 2027.",
		kind: "fact" as const,
		evidence: [
			{
				kind: "documentation" as const,
				quote: "Commencement: 1 January 2027.",
				source: "contract",
				sourceClass: "official" as const,
			},
		],
	};
	const memoParams = (overrides: Record<string, unknown> = {}) => ({
		artifact: memo,
		language: "en",
		register: "formal legal English",
		purpose: "supplier agreement",
		audience: "external",
		rules: [{ class: "register", rule: "Use formal legal English." }],
		claims: [memoClaim],
		inferences: [],
		...overrides,
	});

	test("a stale judge answer is reported as stale and records no hold", async () => {
		const state = freshState();
		const { deps } = depsFor({ consult: { probability: 0.93 } });
		const judge = deps.judge;
		deps.judge = async (material, questions) => {
			queueOwnerMessage(state, "A newer owner message");
			return judge(material, questions);
		};

		const outcome = await consult(deps, state, {
			mode: "boolean",
			question: "Is the evidence enough to proceed?",
			context: "one run passed",
			trueMeaning: "proceed",
			falseMeaning: "gather more evidence",
		});

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["kind"]).toBe("stale");
		expect(state.hold).toBeUndefined();
	});

	test("a stale completion answer records no completion and no hold", async () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		state.planTopics = PLAN_TOPICS;
		recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });
		const { deps } = depsFor({ follows_requirements: { label: "follows", confidence: 0.94 } });
		const judge = deps.judge;
		deps.judge = async (material, questions) => {
			queueOwnerMessage(state, "A newer owner message");
			return judge(material, questions);
		};

		const outcome = await completionCheck(deps, state, { course: false });

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["kind"]).toBe("stale");
		expect(state.completion).toBeUndefined();
		expect(state.hold).toBeUndefined();
	});

	test("triage treats an uncertain external answer as external", async () => {
		const { deps } = depsFor({
			needs_development: { probability: 0.93 },
			external_deliverable: { probability: 0.5 },
		});
		const state = freshState();

		const outcome = await triage(deps, state, { request: "Write the legal memo" });

		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["externalDeliverable"]).toBe(true);
		expect(state.task?.external).toBe(true);
	});

	test("triage keeps a topic whose answer is not confidently negative", async () => {
		const { deps } = depsFor({
			needs_development: { probability: 0.93 },
			external_deliverable: { probability: 0.05 },
			topic_1: { probability: 0.5 },
			topic_2: { probability: 0.05 },
		});

		const outcome = await triage(deps, freshState(), {
			request: "Keep the report available while a node fails",
			topics: ["high availability", "general"],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["topics"]).toEqual(["high availability"]);
	});

	test("triage refuses a malformed topics array before judging", async () => {
		const { deps, calls } = depsFor({});

		const outcome = await triage(deps, freshState(), { request: "Build the thing", topics: [42] });

		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("anti-slop below-floor fragment check leaves the review inconclusive", async () => {
		const state = externalState();
		const { deps } = depsFor({
			...cleanProtocolAnswers(),
			claim_1: { label: "supported", confidence: 0.95 },
			language_1: { probability: 0.05 },
			meta_1: { probability: 0.05 },
			relevance_1: { label: "serves", confidence: 0.95 },
			rule_1_1: { probability: 0.5 },
		});

		const outcome = await antiSlop(deps, state, memoParams());

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["kind"]).toBe("unclear");
		expect(state.antiSlopReviews).toHaveLength(0);
		expect(outcome.text).toContain("inconclusive");
	});

	test("anti-slop below-floor inference answer leaves the review inconclusive", async () => {
		const state = externalState();
		const { deps } = depsFor({
			...cleanProtocolAnswers(),
			claim_1: { label: "supported", confidence: 0.95 },
			inference_1: { label: "follows", confidence: 0.5 },
			language_1: { probability: 0.05 },
			meta_1: { probability: 0.05 },
			relevance_1: { label: "serves", confidence: 0.95 },
			rule_1_1: { probability: 0.05 },
		});

		const outcome = await antiSlop(
			deps,
			state,
			memoParams({
				inferences: [
					{
						id: "inf-1",
						premises: ["The supplier must deliver within 30 days."],
						warrant: "A delivery deadline creates liability for delay.",
						conclusion: "The supplier must deliver within 30 days.",
					},
				],
			}),
		);

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["kind"]).toBe("unclear");
		expect(state.antiSlopReviews).toHaveLength(0);
	});

	test("text review preserves the submitted text and rule line verbatim", async () => {
		const text = "  \nThe report is ready.\n  ";
		const rule = "  Claims must follow the evidence.  ";
		const { deps, calls } = depsFor({ text_rule_1: { probability: 0.95 } });

		const outcome = await textReview(deps, freshState(), { text, rules: [{ class: "accuracy", rule }] });

		expect(outcome.ok).toBe(false);
		expect(asRecord(calls[0]?.state)?.["text"]).toBe(text);
		expect(outcome.details?.["defects"]).toEqual([{ class: "accuracy", rule, fragment: text }]);
	});

	test("search relevance returns the submitted reason and evidence verbatim", async () => {
		const reason = "  it describes exactly this report step  ";
		const evidence = "  the runbook for node loss  ";
		const { deps, calls } = depsFor({ candidate: { label: "candidate_2", confidence: 0.92 } });

		const outcome = await searchRelevance(deps, freshState(), {
			query: "how to report node failure",
			candidates: [
				{ title: "Generic blog", evidence: "a post about uptime", reason: "it mentions nodes" },
				{ title: "Failure playbook", evidence, reason },
			],
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["reason"]).toBe(reason);
		expect(outcome.details?.["evidence"]).toBe(evidence);
		expect(JSON.stringify(calls[0]?.state)).toContain(reason);
	});

	test("anti-slop preserves the submitted artifact and rule line verbatim", async () => {
		const state = externalState();
		const artifact = `  ${memo}  `;
		const rule = "  Use formal legal English.  ";
		const { deps, calls } = depsFor({
			...cleanProtocolAnswers(),
			claim_1: { label: "supported", confidence: 0.95 },
			language_1: { probability: 0.05 },
			meta_1: { probability: 0.05 },
			relevance_1: { label: "serves", confidence: 0.95 },
			rule_1_1: { probability: 0.95 },
		});

		const outcome = await antiSlop(deps, state, memoParams({ artifact, rules: [{ class: "register", rule }] }));

		expect(outcome.ok).toBe(true);
		expect(asRecord(asRecord(calls[0]?.state)?.["antiSlop"])?.["artifact"]).toBe(artifact);
		expect((outcome.details?.["findings"] as Array<Record<string, unknown>>)[0]?.["rule"]).toBe(rule);
		expect(state.antiSlopReviews[0]?.partDigest).toBe(sha256(artifact));
	});

	test("an approved artifact changed during judgment cannot approve acceptance", async () => {
		const artifact = "# Plan\n\n## Collect\nRead the run data.\n";
		const state = planState("Report coverage", ["Collect run data"]);
		state.plan = { taskFingerprint: state.task!.fingerprint, planUrl: PLAN_URL, planDigest: sha256(artifact) };
		let current = artifact;
		const { deps } = depsFor({ acceptance: { label: "serves_business_need", confidence: 0.95 }, execution_evidence: { probability: 0.95 }, code_evidence: { probability: 0.95 } }, async () => current);
		const judge = deps.judge;
		deps.judge = async (material, questions) => {
			current = "# Plan\n\n## Collect\nDelete the source files.\n";
			return judge(material, questions);
		};

		const outcome = await acceptance(deps, state, {
			aspect: "business",
			claim: "The report reads the run data.",
			evidence: [
				{ kind: "execution", quote: "bun test: 3 pass" },
				{ kind: "code", quote: "reads the run data" },
			],
		});

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["kind"]).toBe("stale");
		expect(acceptanceAt(state, "business")).toBeUndefined();
	});
});
