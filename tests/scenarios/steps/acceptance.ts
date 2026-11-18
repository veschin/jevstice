import { expect } from "bun:test";
import { acceptance, courseCheck, review, type ActivityDeps } from "../../../src/activities.js";
import { createJevController } from "../../../src/controller.js";
import {
	acceptanceAt,
	freshState,
	invalidatePlan,
	recordAcceptance,
	recordAction,
	registerTask,
	type JevState,
} from "../../../src/state.js";
import type { JudgeQuestion } from "../../../src/judge.js";
import { asRecord, type Aspect, type Evidence, type PlanTopic, type ToolOutcome } from "../../../src/types.js";
import {
	answeringJudge,
	boundaryConfig,
	blockReason,
	fakeArtifacts,
	fakeCtx,
	fakePi,
	fakeZod,
	stopDecision,
	stopEvent,
	toolDetails,
	toolResultEvent,
	toolText,
	until,
	type FakeAnswerSource,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/** Steps for `scenarios/jev_acceptance.feature`, driving the production acceptance activity. */

const { given, then, when } = scoped("jev_acceptance.feature");

type JudgeCalls = Array<{ state: unknown; questions: readonly JudgeQuestion[] }>;

interface AcceptanceWorld {
	state: JevState;
	deps: ActivityDeps;
	calls: JudgeCalls;
	outcome?: ToolOutcome;
	outcomes?: ToolOutcome[];
	changedStates?: JevState[];
	pi?: FakePi;
	ctx?: unknown;
	evidenceText?: string;
	claim?: string;
	answerText?: string;
	classText?: string;
	reviewOutcome?: ToolOutcome;
	courseOutcome?: ToolOutcome;
	autoMessages?: Array<{ customType: string; content: string }>;
	autoCalls?: JudgeCalls;
	refusalText?: string;
	block?: string;
	stop?: string;
	contextText?: string;
	contextDetails?: Record<string, unknown>;
	toolResult?: unknown;
}

const REQUEST = "Report the coverage of the last run";
const SECTION = "## Collect the numbers\n\nRead the run data and report the count.";
const EVIDENCE: Evidence[] = [
	{ kind: "execution", quote: "bun test: 12 pass / 0 fail" },
	{ kind: "code", quote: "export const count = 1;" },
];

function topic(id: string, requirement: string, section = SECTION): PlanTopic {
	return { id, section, paths: ["src/report.ts"], requirement };
}

/** The background state: a registered task at revision 0 with approved requirements and plan. */
function registeredState(): JevState {
	const state = freshState();
	const task = registerTask(state, REQUEST);
	state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Report coverage"] };
	state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://coverage-plan.md", planDigest: "digest" };
	state.planTopics = [topic("collect", "Report coverage")];
	return state;
}

function w(value: unknown): AcceptanceWorld {
	const world = value as Partial<AcceptanceWorld>;
	world.state ??= registeredState();
	world.calls ??= [];
	world.deps ??= { judge: answeringJudge({}).judge, config: boundaryConfig() };
	return world as AcceptanceWorld;
}

/** The base judge table: the aspect and both literal-observation answers approve, topic 1 is met. */
function table(overrides: Record<string, FakeAnswerSource> = {}): Record<string, FakeAnswerSource> {
	return {
		acceptance: { label: "serves_business_need", confidence: 0.93 },
		execution_evidence: { probability: 0.95 },
		code_evidence: { probability: 0.95 },
		topic_1: { probability: 0.95 },
		topic_1_execution: { label: "evidence_1", confidence: 0.9 },
		topic_1_code: { label: "evidence_2", confidence: 0.9 },
		...overrides,
	};
}

function configure(value: unknown, overrides: Record<string, FakeAnswerSource> = {}): AcceptanceWorld {
	const world = w(value);
	const fake = answeringJudge(table(overrides));
	world.deps = { judge: fake.judge, config: boundaryConfig() };
	world.calls = fake.calls;
	return world;
}

function submit(
	world: AcceptanceWorld,
	options: { aspect?: Aspect; claim?: string; evidence?: Evidence[] } = {},
): Promise<ToolOutcome> {
	return acceptance(world.deps, world.state, {
		aspect: options.aspect ?? "business",
		claim: options.claim ?? "the report serves the owner's need",
		evidence: options.evidence ?? EVIDENCE,
	});
}

// Background ---------------------------------------------------------------

given("a development task is registered at the current work revision", value => {
	w(value).state = registeredState();
});

given("ordinary Jev diagnostics are enabled", value => {
	w(value);
});

// Scenario 1 ---------------------------------------------------------------

given("the executor submits business acceptance with execution and code evidence", async value => {
	const world = configure(value);
	world.outcome = await submit(world);
});

when("that aspect passes at its floor", value => {
	expect(w(value).outcome?.details?.["approved"]).toBe(true);
});

then("business acceptance is recorded for the current revision", value => {
	const world = w(value);
	const record = acceptanceAt(world.state, "business");
	expect(record?.approved).toBe(true);
	expect(record?.revision).toBe(world.state.revision);
});

then("architecture acceptance remains a separate missing record", value => {
	expect(acceptanceAt(w(value).state, "architecture")).toBeUndefined();
});

then("the result names the missing aspect without manufacturing it", value => {
	const world = w(value);
	expect(world.outcome?.text).toContain("architecture");
	expect(world.outcome?.text).toContain("missing");
	expect(world.state.acceptance).toHaveLength(1);
});

// Scenario 2 ---------------------------------------------------------------

given("both aspects were accepted at revision 5", value => {
	const world = w(value);
	world.state = registeredState();
	world.state.revision = 5;
	recordAcceptance(world.state, { aspect: "business", revision: 5, label: "serves_business_need", approved: true, confidence: 0.9 });
	recordAcceptance(world.state, { aspect: "architecture", revision: 5, label: "sound_for_next_change", approved: true, confidence: 0.9 });
});

when("business is submitted again at revision 5 and changes its verdict", async value => {
	const world = configure(value, { acceptance: { label: "business_gap", confidence: 0.9 } });
	world.outcome = await submit(world);
});

then("the business record is replaced", value => {
	const record = acceptanceAt(w(value).state, "business");
	expect(record?.label).toBe("business_gap");
	expect(record?.approved).toBe(false);
	expect(record?.revision).toBe(5);
});

then("the architecture record at revision 5 is unchanged", value => {
	const record = acceptanceAt(w(value).state, "architecture");
	expect(record).toEqual({ aspect: "architecture", revision: 5, label: "sound_for_next_change", approved: true, confidence: 0.9 });
});

// Scenario 3 (outline) -----------------------------------------------------

given("an acceptance submission carries {string}", (value, evidence) => {
	const world = w(value);
	world.state = registeredState();
	world.evidenceText = evidence;
});

when("the tool validates it", async value => {
	const world = configure(value);
	const evidence =
		world.evidenceText === "only a claim"
			? [{ kind: "user" as const, quote: "the export feature works" }]
			: world.evidenceText === "only code quotes"
				? [{ kind: "code" as const, quote: "export const count = 1;" }]
				: world.evidenceText === "only execution quotes"
					? [{ kind: "execution" as const, quote: "bun test: 12 pass" }]
					: [];
	world.outcome = await submit(world, { evidence });
});

then("no judge request is made", value => {
	expect(w(value).calls).toEqual([]);
});

then("the result names the missing evidence class", value => {
	const world = w(value);
	const text = world.outcome?.text ?? "";
	expect(world.outcome?.ok).toBe(false);
	if (world.evidenceText === "nothing") {
		expect(text).toContain("at least one quoted evidence item");
	} else {
		expect(text).toContain("execution");
		expect(text).toContain("code");
	}
});

then("no acceptance is recorded", value => {
	expect(w(value).state.acceptance).toEqual([]);
});

// Scenario 4 ---------------------------------------------------------------

given("the claim asserts that a feature works", value => {
	const world = w(value);
	world.state = registeredState();
	world.claim = "the export feature works";
});

when("the submission carries that claim text and no execution or code item", async value => {
	const world = configure(value);
	world.outcome = await submit(world, { evidence: [{ kind: "user", quote: world.claim ?? "the export feature works" }] });
});

then("it is refused before judgment", value => {
	const world = w(value);
	expect(world.outcome?.ok).toBe(false);
	expect(asRecord(world.outcome?.details)?.["kind"]).toBe("invalid");
	expect(world.calls).toEqual([]);
});

then("the result states that a claim about the work is not observation of the work", value => {
	expect(w(value).outcome?.text).toContain("A claim about the work is not evidence for it");
});

// Scenario 5 ---------------------------------------------------------------

given("an acceptance submission includes an execution item", value => {
	w(value).state = registeredState();
});

when("that item is validated", async value => {
	const world = w(value);
	const valid = configure(value);
	world.outcome = await submit(valid, {
		evidence: [
			{ kind: "execution", quote: "bun test\n12 pass / 0 fail" },
			{ kind: "code", quote: "export const count = 1;" },
		],
	});
	const recorded = world.outcome;

	const bare = configure(value, { execution_evidence: { probability: 0.1 } });
	const bareOutcome = await submit(bare, {
		evidence: [
			{ kind: "execution", quote: "bun test" },
			{ kind: "code", quote: "export const count = 1;" },
		],
	});

	const mislabeled = configure(value, { code_evidence: { probability: 0.1 } });
	const mislabeledOutcome = await submit(mislabeled, {
		evidence: [
			{ kind: "execution", quote: "bun test\n12 pass / 0 fail" },
			{ kind: "code", quote: "bun test" },
		],
	});
	world.outcomes = [recorded, bareOutcome, mislabeledOutcome];
});

then("the item contains the command that ran and its observed output", value => {
	const world = w(value);
	const valid = world.outcomes?.[0];
	expect(valid?.details?.["approved"]).toBe(true);
	const basis = asRecord((valid?.details?.["basis"] as unknown[] | undefined)?.[0]);
	expect(asRecord(basis?.["execution"])).toMatchObject({ status: "selected", id: "evidence_1", quote: "bun test\n12 pass / 0 fail" });
});

then("a bare proposed command without output does not satisfy execution evidence", value => {
	const world = w(value);
	const bare = world.outcomes?.[1];
	expect(bare?.details?.["approved"]).not.toBe(true);
	expect(bare?.text).toContain("literal command");
	expect(asRecord(bare?.details)?.["evidenceQuestions"]).toMatchObject({ execution: 0.1 });
});

then("a mislabeled command-only quote does not reach judgment", value => {
	const world = w(value);
	const mislabeled = world.outcomes?.[2];
	expect(mislabeled?.details?.["approved"]).not.toBe(true);
	expect(asRecord(mislabeled?.details)?.["evidenceQuestions"]).toMatchObject({ code: 0.1 });
	expect(mislabeled?.text).toContain("literal command");
});

// Scenario 6 ---------------------------------------------------------------

given("the approved plan has three topics", value => {
	const world = w(value);
	world.state = registeredState();
	world.state.planTopics = [
		topic("collect", "Report coverage"),
		topic("render", "Render the report"),
		topic("verify", "Verify the report"),
	];
});

when("acceptance is judged", async value => {
	const world = configure(value, {
		topic_1: { probability: 0.9 },
		topic_1_execution: { label: "evidence_1", confidence: 0.9 },
		topic_1_code: { label: "evidence_2", confidence: 0.9 },
		topic_2: { probability: 0.9 },
		topic_2_execution: { label: "evidence_1", confidence: 0.9 },
		topic_2_code: { label: "evidence_2", confidence: 0.9 },
		topic_3: { probability: 0.2 },
		topic_3_execution: { label: "none", confidence: 0.9 },
		topic_3_code: { label: "evidence_2", confidence: 0.9 },
	});
	world.outcome = await submit(world);
});

then("each topic receives its own verdict", value => {
	const basis = w(value).outcome?.details?.["basis"] as Array<Record<string, unknown>> | undefined;
	expect(basis?.map(entry => entry["topic"])).toEqual(["collect", "render", "verify"]);
	expect(basis?.map(entry => entry["met"])).toEqual([true, true, false]);
});

then("each passed topic identifies the submitted evidence that establishes it", value => {
	const basis = w(value).outcome?.details?.["basis"] as Array<Record<string, unknown>> | undefined;
	expect(basis?.[0]?.["execution"]).toEqual({ status: "selected", id: "evidence_1", quote: "bun test: 12 pass / 0 fail" });
	expect(basis?.[0]?.["code"]).toEqual({ status: "selected", id: "evidence_2", quote: "export const count = 1;" });
	expect(basis?.[1]?.["execution"]).toMatchObject({ status: "selected", id: "evidence_1" });
});

then("a topic without supporting evidence is not reported as met", value => {
	const world = w(value);
	const basis = world.outcome?.details?.["basis"] as Array<Record<string, unknown>> | undefined;
	expect(basis?.[2]?.["met"]).toBe(false);
	expect(basis?.[2]?.["execution"]).toEqual({ status: "none" });
	expect(world.outcome?.details?.["unmet"]).toEqual(["verify"]);
});

// Scenario 7 ---------------------------------------------------------------

given("the aspect-level answer approves the claim", value => {
	const world = w(value);
	world.state = registeredState();
	world.state.planTopics = [topic("collect", "Report coverage"), topic("verify", "Verify the report")];
	configure(value, {
		topic_1: { probability: 0.95 },
		topic_1_execution: { label: "evidence_1", confidence: 0.9 },
		topic_1_code: { label: "evidence_2", confidence: 0.9 },
		topic_2: { probability: 0.2 },
		topic_2_execution: { label: "evidence_1", confidence: 0.9 },
		topic_2_code: { label: "evidence_2", confidence: 0.9 },
	});
});

when("at least one plan topic remains below its floor", async value => {
	const world = w(value);
	world.outcome = await submit(world);
});

then("the aspect is not accepted", value => {
	const world = w(value);
	expect(world.outcome?.details?.["approved"]).toBe(false);
	expect(acceptanceAt(world.state, "business")?.approved).toBe(false);
});

then("the result lists the unmet topic ids and requirements", value => {
	const world = w(value);
	expect(world.outcome?.details?.["unmet"]).toEqual(["verify"]);
	expect(world.outcome?.text).toContain("verify");
	expect(world.outcome?.text).toContain("Verify the report");
});

then("the evidence gap is named as the next correction", value => {
	expect(w(value).outcome?.text).toContain("Next: observe the behavior named above");
});

// Scenario 8 (outline) -----------------------------------------------------

given("the judge returns {string}", (value, answer) => {
	const world = w(value);
	world.state = registeredState();
	world.answerText = answer;
});

when("the acceptance result is recorded", async value => {
	const world = w(value);
	const spec =
		world.answerText === "the approving label below the confidence floor"
			? { aspect: "business" as const, label: "serves_business_need", confidence: 0.3 }
			: world.answerText === "the unsupported label at any confidence"
				? { aspect: "business" as const, label: "unsupported", confidence: 0.95 }
				: world.answerText === "a business_gap label at the floor"
					? { aspect: "business" as const, label: "business_gap", confidence: 0.9 }
					: { aspect: "architecture" as const, label: "architecture_defect", confidence: 0.9 };
	configure(value, { acceptance: { label: spec.label, confidence: spec.confidence } });
	world.outcome = await submit(world, { aspect: spec.aspect });
});

then("the class is {string}", (value, expected) => {
	const world = w(value);
	world.classText = expected;
	const kind = w(value).outcome?.details?.["kind"];
	expect(kind).toBe(expected === "inconclusive" ? "unclear" : "defect");
});

then("the work is not described more strongly than the answer supports", value => {
	const world = w(value);
	expect(world.outcome?.details?.["approved"]).not.toBe(true);
	if (world.classText === "inconclusive") {
		expect(world.outcome?.text).not.toContain("Class: defect");
	} else {
		expect(world.outcome?.text).toContain("Class: defect");
	}
});

// Scenario 9 ---------------------------------------------------------------

given("both aspects were accepted at revision 4", value => {
	const world = w(value);
	world.state = registeredState();
	world.state.revision = 4;
	recordAcceptance(world.state, { aspect: "business", revision: 4, label: "serves_business_need", approved: true, confidence: 0.9 });
	recordAcceptance(world.state, { aspect: "architecture", revision: 4, label: "sound_for_next_change", approved: true, confidence: 0.9 });
});

when("a consequential implementation action advances the work to revision 5", value => {
	recordAction(w(value).state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report counter" });
	expect(w(value).state.revision).toBe(5);
});

then("neither earlier acceptance counts for revision 5", value => {
	const state = w(value).state;
	expect(acceptanceAt(state, "business")).toBeUndefined();
	expect(acceptanceAt(state, "architecture")).toBeUndefined();
});

then("fresh execution and code evidence are required for a new acceptance", async value => {
	const world = w(value);
	const deps = { judge: answeringJudge({}).judge, config: boundaryConfig() };
	const outcome = await acceptance(deps, world.state, { aspect: "business", claim: "the report serves the owner's need", evidence: [] });
	expect(outcome.ok).toBe(false);
	expect(outcome.text).toContain("at least one quoted evidence item");
	expect(acceptanceAt(world.state, "business")).toBeUndefined();
});

then("a plan revision also invalidates the previous acceptance", value => {
	const state = w(value).state;
	recordAcceptance(state, { aspect: "business", revision: state.revision, label: "serves_business_need", approved: true, confidence: 0.9 });
	recordAcceptance(state, { aspect: "architecture", revision: state.revision, label: "sound_for_next_change", approved: true, confidence: 0.9 });
	invalidatePlan(state);
	expect(state.acceptance).toEqual([]);
	expect(state.planTopics).toEqual([]);
});

// Scenario 10 --------------------------------------------------------------

given("an acceptance judgment is refused", async value => {
	const world = w(value);
	const fake = answeringJudge({ needs_development: { probability: 0.95 } });
	world.pi = fakePi();
	world.ctx = fakeCtx();
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(world.pi.api);
	const pi = world.pi;
	await pi.callTool("jev_triage", { request: REQUEST, evidence: [{ kind: "user", quote: REQUEST }] }, world.ctx);
	const refusal = await pi.callTool(
		"jev_acceptance",
		{ aspect: "business", claim: "the report serves the owner's need", evidence: [{ kind: "user", quote: "the report is done" }] },
		world.ctx,
	);
	expect(toolText(refusal)).toContain("A claim about the work is not evidence for it");
	world.refusalText = toolText(refusal);
});

when("the executor continues implementation and ends the session", async value => {
	const world = w(value);
	const pi = world.pi;
	expect(pi).toBeDefined();
	if (pi === undefined) return;
	world.block = blockReason(await pi.emit("tool_call", { type: "tool_call", toolCallId: "call-write", toolName: "write", input: { path: "src/report.ts", content: "export const count = 2;" } }, world.ctx));
	world.stop = stopDecision(await pi.emit("session_stop", stopEvent(), world.ctx));
	const context = await pi.callTool("jev_context", { action: "list" }, world.ctx);
	world.contextText = toolText(context);
	world.contextDetails = toolDetails(context);
});

then("neither action is blocked by the refusal", value => {
	const world = w(value);
	expect(world.block).toBeUndefined();
	expect(world.stop).toBeUndefined();
});

then("completion is not presented as accepted work", value => {
	const world = w(value);
	expect(world.contextDetails?.["acceptance"]).toEqual([]);
	expect(world.contextText).toContain("Current-revision acceptance: none");
	expect(world.pi?.messages.every(message => !/accepted work/iu.test(message.content))).toBe(true);
});

then("the refusal remains disclosed as a diagnostic", value => {
	const world = w(value);
	expect(world.refusalText).toContain("A claim about the work is not evidence for it");
	expect(world.contextText).toContain("not checked");
	expect(world.pi?.messages.length).toBeGreaterThan(0);
});

// Scenario 11 --------------------------------------------------------------

given("a developer review passed and a course check reported on course", async value => {
	const world = w(value);
	world.state = registeredState();
	const fake = answeringJudge({ review: { label: "sound", confidence: 0.9 }, course: { label: "on_course", confidence: 0.9 } });
	const deps: ActivityDeps = { judge: fake.judge, config: boundaryConfig() };
	world.calls = fake.calls;
	world.reviewOutcome = await review(deps, world.state, {
		kind: "diff",
		target: "src/report.ts",
		claim: "the report counts every covered line",
		evidence: [{ kind: "code", quote: "export const count = 1;" }],
	});
	world.courseOutcome = await courseCheck(deps, world.state, { claim: "Implement the report counter under the approved plan" });
});

when("the executor relies on them as acceptance", value => {
	const world = w(value);
	expect(world.reviewOutcome?.ok).toBe(true);
	expect(world.courseOutcome?.ok).toBe(true);
	expect(world.calls.some(call => call.questions.some(question => question.name === "acceptance"))).toBe(false);
});

then("business and architecture acceptance remain missing", value => {
	const state = w(value).state;
	expect(acceptanceAt(state, "business")).toBeUndefined();
	expect(acceptanceAt(state, "architecture")).toBeUndefined();
});

then("neither check is reported as approval of the delivered outcome", value => {
	const world = w(value);
	expect(world.reviewOutcome?.text).toContain("not approval");
	expect(world.courseOutcome?.text).toContain("does not authorize a change or replace acceptance");
	expect(world.reviewOutcome?.text).not.toContain("approval of the delivered outcome");
	expect(world.courseOutcome?.text).not.toContain("approval of the delivered outcome");
});

// Scenario 12 --------------------------------------------------------------

const COMPLETION_PLAN = "## Collect the numbers\n\nRead the run data and report the count.\n";

async function developedTask(value: unknown): Promise<AcceptanceWorld> {
	const world = w(value);
	const artifactsDir = await fakeArtifacts({ "coverage-plan.md": COMPLETION_PLAN });
	let phase: "manual" | "auto" = "manual";
	const fake = answeringJudge({
		needs_development: { probability: 0.95 },
		coverage: { probability: 0.95 },
		item_1: { probability: 0.95 },
		outline_requirement_1: { probability: 0.95 },
		outline_step_1: { probability: 0.95 },
		detail: { label: "ready", confidence: 0.95 },
		finalize_consistency: { probability: 0.95 },
		finalize_scope: { probability: 0.95 },
		action: { label: "on_course", confidence: 0.9 },
		acceptance: question => {
			const options = question.options ?? {};
			const label = Object.keys(options).find(name => name === "serves_business_need" || name === "sound_for_next_change");
			return { label: label ?? "unclear", confidence: 0.93 };
		},
		execution_evidence: { probability: 0.95 },
		code_evidence: { probability: 0.95 },
		topic_1: () => ({ probability: phase === "manual" ? 0.95 : 0.2 }),
		topic_1_execution: () => ({ label: phase === "manual" ? "evidence_1" : "evidence_2", confidence: 0.9 }),
		topic_1_code: () => ({ label: phase === "manual" ? "evidence_2" : "evidence_1", confidence: 0.9 }),
	});
	world.autoCalls = fake.calls;
	const pi = fakePi();
	const ctx = fakeCtx({ artifactsDir });
	world.pi = pi;
	world.ctx = ctx;
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const evidence = [{ kind: "user" as const, quote: COMPLETION_REQUEST }];
	const triaged = toolDetails(await pi.callTool("jev_triage", { request: COMPLETION_REQUEST, evidence }, ctx));
	expect(triaged["needsDevelopment"]).toBe(true);
	const requirements = toolDetails(await pi.callTool("jev_requirements", {
		request: COMPLETION_REQUEST,
		items: [{ text: "Report coverage", source: COMPLETION_REQUEST }],
		evidence,
	}, ctx));
	expect(requirements["approved"]).toBe(true);
	await pi.callTool("jev_plan_review", {
		phase: "outline",
		steps: [{ id: "collect", summary: "Collect the numbers", requirement: "Report coverage" }],
		evidence,
	}, ctx);
	await pi.callTool("jev_plan_review", {
		phase: "detail",
		plan: "local://coverage-plan.md",
		topic: { id: "collect", section: "Collect the numbers", paths: ["src/report.ts"], requirement: "Report coverage" },
		evidence,
	}, ctx);
	const finalized = toolDetails(await pi.callTool("jev_plan_review", { phase: "finalize", plan: "local://coverage-plan.md", evidence }, ctx));
	expect(finalized["verdict"]).toBe("serves");
	await pi.emit("tool_result", toolResultEvent("write", { path: "src/report.ts", content: "export const count = 1;" }, "Wrote src/report.ts"), ctx);
	await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test" }, "12 pass / 0 fail"), ctx);
	const accepted = await pi.callTool("jev_acceptance", {
		aspect: "business",
		claim: "the report serves the owner's need",
		evidence: [{ kind: "execution", quote: "12 pass / 0 fail" }, { kind: "code", quote: "export const count = 1;" }],
	}, ctx);
	expect(toolDetails(accepted)["approved"]).toBe(true);
	phase = "auto";
	return world;
}

const COMPLETION_REQUEST = "Report the coverage of the last run";

given("a developed task reaches completion with one aspect missing", async value => {
	await developedTask(value);
});

when("the ordinary completion boundary is observed", async value => {
	const world = w(value);
	const pi = world.pi;
	expect(pi).toBeDefined();
	if (pi === undefined) return;
	await pi.emit("session_stop", stopEvent(), world.ctx);
	const seen = await until(() => pi.messages.some(message => message.customType === "jev.acceptance"));
	expect(seen).toBe(true);
	world.autoMessages = pi.messages.filter(message => message.customType === "jev.acceptance");
});

then("the addon collects observed code and execution evidence", value => {
	const world = w(value);
	const acceptanceCalls = (world.autoCalls ?? []).filter(call => call.questions.some(question => question.name === "acceptance"));
	const automatic = acceptanceCalls.at(-1);
	expect(automatic).toBeDefined();
	const judged = JSON.stringify(automatic?.state);
	expect(judged).toContain("Wrote src/report.ts");
	expect(judged).toContain("12 pass / 0 fail");
});

then("it submits the missing architecture acceptance automatically", value => {
	const world = w(value);
	const messages = world.autoMessages ?? [];
	expect(messages).toHaveLength(1);
	expect(messages[0]?.content).toContain("Jev · Architecture");
	expect(messages[0]?.content).toContain("architecture acceptance:");
});

then("it returns the unmet obligations without requiring manual acceptance calls", value => {
	const world = w(value);
	const content = world.autoMessages?.[0]?.content ?? "";
	expect(content).toContain("does not establish every plan topic");
	expect(content).toContain("collect");
	expect(content).toContain("approved verification section:");
	expect(content).toContain("Read the run data and report the count.");
	expect(content).toContain("observe the behavior");
});

// Scenario 13 --------------------------------------------------------------

given("acceptance evidence is missing or unsuitable for one requirement", value => {
	const world = w(value);
	world.state = registeredState();
	world.state.planTopics = [topic("collect", "Report coverage")];
});

when("the result is returned", async value => {
	const world = w(value);
	const fake = answeringJudge(table({ topic_1: { probability: 0.2 } }));
	world.deps = { judge: fake.judge, config: boundaryConfig() };
	world.calls = fake.calls;
	const gap = await submit(world);
	const defectFake = answeringJudge(table({ acceptance: { label: "business_gap", confidence: 0.9 }, topic_1: { probability: 0.2 } }));
	const defectDeps: ActivityDeps = { judge: defectFake.judge, config: boundaryConfig() };
	const defect = await submit(
		{ ...world, deps: defectDeps, calls: defectFake.calls },
		{ claim: "the report does not yet serve the owner's need" },
	);
	world.outcomes = [gap, defect];
});

then("it names the unmet requirement", value => {
	const gap = w(value).outcomes?.[0];
	expect(gap?.text).toContain("Report coverage");
	expect(gap?.text).toContain("collect");
	expect(gap?.details?.["unmet"]).toEqual(["collect"]);
});

then("it names that requirement's approved verification section", value => {
	const gap = w(value).outcomes?.[0];
	expect(gap?.text).toContain("Read the run data and report the count.");
	expect(gap?.details?.["unmetSections"]).toEqual([{ id: "collect", requirement: "Report coverage", section: SECTION }]);
});

then("it directs the executor to observe that behavior before changing implementation", value => {
	expect(w(value).outcomes?.[0]?.text).toContain("do not change the implementation before that observation");
});

then("only an established defect directs an implementation repair", value => {
	const world = w(value);
	expect(world.outcomes?.[0]?.text).not.toContain("Class: defect");
	expect(world.outcomes?.[1]?.text).toContain("Class: defect");
	expect(world.outcomes?.[1]?.text).toContain("complete the unmet business obligation");
});

// Scenario 14 --------------------------------------------------------------

given("an acceptance judgment is in flight", value => {
	w(value).state = registeredState();
});

when("the task, revision or approved plan changes before the answer returns", async value => {
	const world = w(value);
	const changes: Array<(state: JevState) => void> = [
		state => {
			state.revision += 1;
		},
		state => {
			registerTask(state, "Replace the report with a dashboard");
		},
		state => {
			state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://other-plan.md", planDigest: "other" };
		},
	];
	const outcomes: ToolOutcome[] = [];
	const changed: JevState[] = [];
	for (const change of changes) {
		const state = registeredState();
		const base = answeringJudge(table());
		const deps: ActivityDeps = {
			judge: async (material, questions) => {
				change(state);
				return base.judge(material, questions);
			},
			config: boundaryConfig(),
		};
		outcomes.push(await acceptance(deps, state, { aspect: "business", claim: "the report serves the owner's need", evidence: EVIDENCE }));
		changed.push(state);
	}
	world.outcomes = outcomes;
	world.changedStates = changed;
});

then("the answer is discarded as stale", value => {
	for (const outcome of w(value).outcomes ?? []) {
		expect(outcome.details?.["kind"]).toBe("stale");
		expect(outcome.text).toContain("No answer was kept");
		expect(outcome.text).toContain("Class: stale");
	}
});

then("it is not recorded as acceptance or as a defect", value => {
	for (const state of w(value).changedStates ?? []) {
		expect(state.acceptance).toEqual([]);
		expect(state.findings).toEqual([]);
		expect(state.hold).toBeUndefined();
	}
});

then("the current revision remains without that acceptance", value => {
	for (const state of w(value).changedStates ?? []) {
		expect(acceptanceAt(state, "business")).toBeUndefined();
		expect(acceptanceAt(state, "architecture")).toBeUndefined();
	}
});

// Scenario 15 --------------------------------------------------------------

given("an asynchronous project effect has been launched and not yet settled", async value => {
	const world = w(value);
	const fake = answeringJudge({});
	world.pi = fakePi();
	world.ctx = fakeCtx();
	world.calls = fake.calls;
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(world.pi.api);
	const pi = world.pi;
	await pi.emit(
		"tool_result",
		{
			type: "tool_result",
			toolCallId: "call-bash",
			toolName: "bash",
			input: { command: "bun test > coverage.txt" },
			content: [{ type: "text", text: "background job started" }],
			isError: false,
			details: { async: { jobId: "job-1", type: "bash" } },
		},
		world.ctx,
	);
	const listed = toolDetails(await pi.callTool("jev_context", { action: "list" }, world.ctx));
	expect(listed["pendingEffects"]).toEqual([{ jobId: "job-1", tool: "bash" }]);
});

when("the executor submits acceptance", async value => {
	const world = w(value);
	const pi = world.pi;
	expect(pi).toBeDefined();
	if (pi === undefined) return;
	world.toolResult = await pi.callTool(
		"jev_acceptance",
		{ aspect: "business", claim: "the report serves the owner's need", evidence: EVIDENCE },
		world.ctx,
	);
});

then("the result names unobserved background effects as the prerequisite", value => {
	const result = w(value).toolResult;
	expect(toolText(result)).toContain("background effects are unobserved");
	expect(toolDetails(result)["prerequisite"]).toBe(true);
});

then("no acceptance judgment is made and no finding is recorded", async value => {
	const world = w(value);
	expect(world.calls).toEqual([]);
	const pi = world.pi;
	if (pi === undefined) return;
	const listed = toolDetails(await pi.callTool("jev_context", { action: "list" }, world.ctx));
	expect(listed["acceptance"]).toEqual([]);
	expect(listed["findings"]).toEqual([]);
});

then("ordinary work and completion continue", async value => {
	const world = w(value);
	const pi = world.pi;
	if (pi === undefined) return;
	const block = blockReason(await pi.emit("tool_call", { type: "tool_call", toolCallId: "call-write", toolName: "write", input: { path: "src/report.ts", content: "export const count = 2;" } }, world.ctx));
	const stop = stopDecision(await pi.emit("session_stop", stopEvent(), world.ctx));
	expect(block).toBeUndefined();
	expect(stop).toBeUndefined();
});
