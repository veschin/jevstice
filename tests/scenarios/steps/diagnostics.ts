/**
 * Step definitions for `scenarios/jev_diagnostics.feature`. Every step drives the real controller
 * (`createJevController`) over the fake host seams in `tests/helpers.ts`: the feature's sentences
 * become executable observations of production behavior, never restatements of the implementation.
 *
 * The harness is exported because `session_mode.ts` covers the same controller surface (the owner
 * command and the disabled-session path) and must observe the same host seams.
 */
import { expect } from "bun:test";
import { createJevController, type ControllerRuntime } from "../../../src/controller.js";
import { isConsequentialMutation } from "../../../src/gates.js";
import type { Judge, JudgeQuestion } from "../../../src/judge.js";
import { asRecord, type Evidence } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	boundaryConfig,
	cleanProtocolAnswers,
	fakeArtifacts,
	fakeCtx,
	fakePi,
	fakeZod,
	stopDecision,
	stopEvent,
	toolCallEvent,
	toolDetails,
	toolFailed,
	toolResultEvent,
	toolText,
	type FakeAnswerSource,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

const { given, when, then } = scoped("jev_diagnostics.feature");

// ---------------------------------------------------------------------------
// The fake host, the judge and the per-scenario world
// ---------------------------------------------------------------------------

/** One message the controller sent, with the host options it asked for. */
export interface Capture {
	payload: Record<string, unknown>;
	options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean };
}

/** A judge gate: the call that matches `question` (or any call) blocks until released. */
export interface Gate {
	question?: string;
	opened: Promise<void>;
	released: Promise<void>;
	open(): void;
	release(): void;
}

export function gate(question?: string): Gate {
	const opened = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		question,
		opened: opened.promise,
		released: released.promise,
		open: () => opened.resolve(),
		release: () => released.resolve(),
	};
}

/** The fake judge's recorded calls: the question set each submission carried. */
interface JudgeCallRecord {
	questions: readonly JudgeQuestion[];
}

/** The answer table and the calls the fake judge recorded, as the steps need them. */
export interface JudgeHarness {
	judge: Judge;
	calls: JudgeCallRecord[];
}

/** One scenario's world: the registered controller plus what the steps observed. */
export interface JevWorld {
	pi: FakePi;
	ctx: Record<string, unknown>;
	fake: JudgeHarness;
	table: Record<string, FakeAnswerSource>;
	notices: string[];
	sends: Capture[];
	results: Record<string, unknown>;
	info: Record<string, unknown>;
	gate?: Gate;
	taskRegistered?: boolean;
	planApproved?: boolean;
	artifactsDir?: string;
	secondCtx?: Record<string, unknown>;
	strict?: { state: Record<string, unknown>; log: string[] };
}

/** Register one controller over a fake host; the judge reads `world.table` at call time. */
export function createJevWorld(
	options: { autonomy?: ControllerRuntime } = {},
	target: Record<string, unknown> = {},
): JevWorld {
	const world = target as unknown as JevWorld;
	const table: Record<string, FakeAnswerSource> = {};
	const fake: JudgeHarness = answeringJudge(table);
	const pi = fakePi();
	const ctx = fakeCtx() as Record<string, unknown>;
	world.pi = pi;
	world.ctx = ctx;
	world.fake = fake;
	world.table = table;
	world.notices = [];
	world.sends = [];
	world.results = {};
	world.info = {};
	const ui = asRecord(ctx["ui"]);
	if (ui !== undefined) ui["notify"] = (message: string) => { world.notices.push(message); };
	const send = pi.api.sendMessage;
	if (send !== undefined) {
		pi.api.sendMessage = (
			payload: unknown,
			sendOptions?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean },
		) => {
			world.sends.push({ payload: asRecord(payload) ?? {}, options: sendOptions });
			send(payload, sendOptions);
		};
	}
	const judge: Judge = async (state, questions) => {
		const active = world.gate;
		if (active !== undefined && (active.question === undefined || questions.some(question => question.name === active.question))) {
			active.open();
			await active.released;
		}
		return fake.judge(state, questions);
	};
	createJevController({
		judge,
		config: boundaryConfig(),
		zod: fakeZod(),
		...(options.autonomy === undefined ? {} : { autonomy: options.autonomy }),
	}).register(pi.api);
	return world;
}

/** The scenario world, created lazily on the first step that needs it. */
export function setup(value: unknown): JevWorld {
	const existing = value as Partial<JevWorld>;
	if (existing.pi !== undefined) return existing as JevWorld;
	return createJevWorld({}, value as Record<string, unknown>);
}

export function lastMessage(world: JevWorld, customType: string): string {
	return world.pi.messages.filter(message => message.customType === customType).at(-1)?.content ?? "";
}

export function lastSend(world: JevWorld, customType: string): Capture | undefined {
	return [...world.sends].reverse().find(entry => entry.payload["customType"] === customType);
}

/** The `jev_context` report: objective, sources, revision, findings, acceptance and effects. */
export async function observe(world: JevWorld): Promise<Record<string, unknown>> {
	return toolDetails(await world.pi.callTool("jev_context", { action: "list" }, world.ctx));
}

export function counts(details: Record<string, unknown>, name: "checks" | "work"): Record<string, number> {
	return (asRecord(asRecord(details["diagnostics"])?.[name]) ?? {}) as Record<string, number>;
}

export function resultCounts(result: unknown, name: "checks" | "work"): Record<string, number> {
	return counts(toolDetails(result), name);
}

export function total(counts: Record<string, number>): number {
	return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

export function judgeQuestions(world: JevWorld): string[] {
	return world.fake.calls.flatMap(call => call.questions.map(question => question.name));
}

export async function untilSettled(check: () => Promise<boolean>, ms = 2000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(5);
	}
	return check();
}

// ---------------------------------------------------------------------------
// Reusable driver helpers
// ---------------------------------------------------------------------------

const REQUEST = "Report the coverage of the last run";
const PLAN_URL = "local://x-plan.md";
const PLAN_BODY = "# plan\n\n1. Collect the numbers\n";
const PLAN_EVIDENCE: Evidence[] = [{ kind: "user", quote: REQUEST }];

/** Judge answers for the unchanged planning path, used wherever a plan must be approved. */
const PLAN_ANSWERS: Record<string, FakeAnswerSource> = {
	needs_development: { probability: 0.95 },
	external_deliverable: { probability: 0 },
	coverage: { probability: 0.93 },
	item_1: { probability: 0.93 },
	outline_requirement_1: { probability: 0.93 },
	outline_step_1: { probability: 0.93 },
	detail: { label: "ready", confidence: 0.9 },
	finalize_consistency: { probability: 0.93 },
	finalize_scope: { probability: 0.93 },
	topic_1: { probability: 0.9 },
	action: { label: "on_course", confidence: 0.9 },
	external_delivery: { label: "does_not_deliver", confidence: 0.95 },
};

export function consultParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		mode: "boolean",
		question: "Does the recorded report contain coverage?",
		context: "The recorded report contains the coverage for the completed run.",
		trueMeaning: "The report contains coverage.",
		falseMeaning: "The report lacks coverage.",
		...overrides,
	};
}

export function reviewParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "diff",
		target: "src/report.ts",
		claim: "The report includes the recorded coverage.",
		evidence: [{ kind: "code", quote: "export const coverage = 100;" }],
		...overrides,
	};
}

function choiceConsult(): Record<string, unknown> {
	return {
		mode: "choice",
		question: "Which state does the recorded work support?",
		context: "The recorded work contains the implementation and its verification output.",
		alternatives: [
			{ label: "ready", meaning: "the recorded work is ready for the owner" },
			{ label: "not_ready", meaning: "the recorded work needs another step" },
		],
	};
}

/** Register the development task through the real triage tool. */
export async function ensureTask(world: JevWorld, options: { external?: boolean } = {}): Promise<void> {
	if (world.taskRegistered === true) return;
	world.table["needs_development"] = { probability: 0.95 };
	world.table["external_deliverable"] = { probability: options.external === true ? 0.95 : 0 };
	const result = await world.pi.callTool("jev_triage", { request: REQUEST }, world.ctx);
	expect(toolText(result)).toContain("development task registered");
	world.taskRegistered = true;
}

/** Approve the requirements through the real requirements tool. */
export async function approveRequirements(world: JevWorld): Promise<void> {
	await ensureTask(world);
	world.table["coverage"] = { probability: 0.93 };
	world.table["item_1"] = { probability: 0.93 };
	const result = await world.pi.callTool(
		"jev_requirements",
		{
			request: REQUEST,
			items: [{ text: REQUEST, source: REQUEST }],
			candidateNeeds: [],
			evidence: PLAN_EVIDENCE,
		},
		world.ctx,
	);
	expect(toolDetails(result)["approved"]).toBe(true);
}

/** Approve the plan artifact through outline, detail and finalize. */
export async function approvePlan(world: JevWorld): Promise<void> {
	if (world.planApproved === true) return;
	await approveRequirements(world);
	const dir = world.artifactsDir ?? (await fakeArtifacts({ "x-plan.md": PLAN_BODY }));
	world.artifactsDir = dir;
	(world.ctx["sessionManager"] as Record<string, unknown>)["getArtifactsDir"] = () => dir;
	Object.assign(world.table, PLAN_ANSWERS);
	const outline = await world.pi.callTool(
		"jev_plan_review",
		{
			phase: "outline",
			steps: [{ id: "collect", summary: "Collect the numbers.", requirement: REQUEST }],
			evidence: PLAN_EVIDENCE,
		},
		world.ctx,
	);
	expect(toolText(outline)).toContain("plan outline approved");
	const detail = await world.pi.callTool(
		"jev_plan_review",
		{
			phase: "detail",
			plan: PLAN_URL,
			topic: { id: "collect", section: PLAN_BODY.trimEnd(), paths: ["src/a.ts"], requirement: REQUEST },
			evidence: PLAN_EVIDENCE,
		},
		world.ctx,
	);
	expect(toolDetails(detail)["verdict"]).toBe("serves");
	const finalized = await world.pi.callTool("jev_plan_review", { phase: "finalize", plan: PLAN_URL, evidence: PLAN_EVIDENCE }, world.ctx);
	expect(toolText(finalized)).toContain("plan approved");
	world.planApproved = true;
}

async function recordAction(world: JevWorld, index: number): Promise<void> {
	await world.pi.emit(
		"tool_result",
		toolResultEvent("write", { path: `src/step-${index}.ts`, content: "export const step = 1;" }, "Wrote the file"),
		world.ctx,
	);
}

function requirementsParams(item: string): Record<string, unknown> {
	return {
		request: REQUEST,
		items: [{ text: item, source: REQUEST }],
		candidateNeeds: [],
		evidence: [{ kind: "user", quote: REQUEST }],
	};
}

async function launchEffect(world: JevWorld, tool: string, input: Record<string, unknown>, jobId: string): Promise<void> {
	const event = toolResultEvent(tool, input, "launched the background effect") as Record<string, unknown>;
	event["details"] = { async: { jobId, type: tool } };
	await world.pi.emit("tool_result", event, world.ctx);
}

async function terminalEffect(world: JevWorld, job: Record<string, unknown>, timestamp: number): Promise<void> {
	await world.pi.emit(
		"context",
		{ messages: [{ role: "custom", customType: "async-result", details: { jobs: [job] }, timestamp }] },
		world.ctx,
	);
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

given("ordinary Jev diagnostics are enabled for this session", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are on");
});

given("the host owns tool admission, filesystem permissions and completion", async value => {
	const world = setup(value);
	expect(
		blockReason(await world.pi.emit("tool_call", toolCallEvent("write", { path: "src/notes.ts", content: "export const note = 1;" }), world.ctx)),
	).toBeUndefined();
	expect(stopDecision(await world.pi.emit("session_stop", stopEvent(), world.ctx))).toBeUndefined();
	expect(world.pi.commands.has("jev-continue")).toBe(false);
	expect(world.pi.commands.has("jev-waive")).toBe(false);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_01
// ---------------------------------------------------------------------------

given("an approved development task has just received a negative developer review", async value => {
	const world = setup(value);
	await approveRequirements(world);
	world.table["review"] = { label: "defect", confidence: 0.95 };
	world.results["review"] = await world.pi.callTool("jev_review", reviewParams(), world.ctx);
	expect(toolFailed(world.results["review"])).toBe(false);
	expect(toolDetails(world.results["review"])["approved"]).toBe(false);
});

when("the executor performs another consequential project action", async value => {
	const world = setup(value);
	world.results["action"] = await world.pi.emit(
		"tool_call",
		toolCallEvent("write", { path: "src/report.ts", content: "export const coverage = 100;" }),
		world.ctx,
	);
	await world.pi.emit(
		"tool_result",
		toolResultEvent("write", { path: "src/report.ts", content: "export const coverage = 100;" }, "Wrote src/report.ts"),
		world.ctx,
	);
});

then("that action is not refused because of the negative review", value => {
	const world = setup(value);
	expect(blockReason(world.results["action"] as unknown[])).toBeUndefined();
});

then("the negative review remains recorded with its own boundary and work revision", async value => {
	const world = setup(value);
	const details = await observe(world);
	const findings = details["findings"] as Array<Record<string, unknown>>;
	expect(findings).toHaveLength(1);
	expect(findings[0]?.["boundary"]).toBe("jev_review");
	expect(findings[0]?.["revision"]).toBe(0);
	expect(asRecord(findings[0]?.["result"])?.["kind"]).toBe("defect");
	expect(details["revision"]).toBe(1);
});

then("no execution error is invented from the negative verdict", value => {
	const world = setup(value);
	const review = world.results["review"];
	expect(toolFailed(review)).toBe(false);
	expect(toolText(review)).not.toContain("Execution error");
	expect(toolDetails(review)["approved"]).toBe(false);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_02
// ---------------------------------------------------------------------------

given("a development task has no business acceptance and no architecture acceptance", async value => {
	const world = setup(value);
	await ensureTask(world);
	const details = await observe(world);
	expect(details["acceptance"]).toEqual([]);
});

given("one diagnostic finding is recorded at the current revision", async value => {
	const world = setup(value);
	world.table["review"] = { label: "defect", confidence: 0.95 };
	const result = await world.pi.callTool("jev_review", reviewParams(), world.ctx);
	expect(toolDetails(result)["approved"]).toBe(false);
	const details = await observe(world);
	const findings = details["findings"] as Array<Record<string, unknown>>;
	expect(findings).toHaveLength(1);
	expect(findings[0]?.["revision"]).toBe(details["revision"]);
});

when("the executor ends the ordinary session", async value => {
	const world = setup(value);
	world.results["stop"] = await world.pi.emit("session_stop", stopEvent(), world.ctx);
});

then("the session stop is not rejected for missing acceptance", value => {
	expect(stopDecision(setup(value).results["stop"] as unknown[])).toBeUndefined();
});

then("the missing acceptance and the finding are disclosed as diagnostics", async value => {
	const world = setup(value);
	world.pi.callCommand("jev-status", "", world.ctx);
	const status = lastMessage(world, "jev.status");
	expect(status).toContain("Current-revision acceptance: none");
	expect(status).toContain("Jev diagnostics");
	const details = await observe(world);
	expect(details["hold"]).toBeDefined();
	expect(counts(details, "checks")["failed"]).toBe(1);
});

then("no Jev approval is claimed for the completed work", async value => {
	const world = setup(value);
	const details = await observe(world);
	expect(details["acceptance"]).toEqual([]);
	expect(asRecord(details["hold"])?.["id"]).toBeDefined();
	expect(asRecord(asRecord(details["hold"])?.["result"])?.["approved"]).toBe(false);
	expect(stopDecision(world.results["stop"] as unknown[])).toBeUndefined();
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_03 (outline)
// ---------------------------------------------------------------------------

given("a valid judgment request returns {string}", (value, answer) => {
	const world = setup(value);
	if (answer.includes("boolean probability floor")) {
		world.table["consult"] = { probability: 0.5 };
		world.info["consult"] = consultParams({
			question: "Is the recorded work on course for the approved task?",
			trueMeaning: "The recorded work is on course.",
			falseMeaning: "The recorded work is off course.",
		});
		return;
	}
	if (answer.includes("choice confidence floor")) {
		world.table["consult"] = { label: "ready", confidence: 0.3 };
		world.info["consult"] = choiceConsult();
		return;
	}
	world.table["consult"] = { label: "ready", confidence: 0.5 };
	world.info["consult"] = choiceConsult();
});

when("the result is classified", async value => {
	const world = setup(value);
	world.results["consult"] = await world.pi.callTool("jev_consult", world.info["consult"], world.ctx);
});

then("the recorded class is inconclusive", async value => {
	const world = setup(value);
	const checks = counts(await observe(world), "checks");
	expect(checks["inconclusive"]).toBe(1);
	expect(checks["passed"]).toBe(0);
	expect(checks["failed"]).toBe(0);
});

then("the work is not described as defective", value => {
	const world = setup(value);
	const text = toolText(world.results["consult"]);
	expect(text).toContain("inconclusive");
	expect(text).not.toContain("Class: defect");
});

then("no approval is recorded", async value => {
	const world = setup(value);
	const details = await observe(world);
	expect(details["acceptance"]).toEqual([]);
	expect(toolDetails(world.results["consult"])["approved"]).not.toBe(true);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_04 (outline)
// ---------------------------------------------------------------------------

const INVALID_CALLS: Record<string, { tool: string; params: Record<string, unknown> }> = {
	"jev_acceptance without evidence": {
		tool: "jev_acceptance",
		params: { aspect: "business", claim: "The report serves the owner need." },
	},
	"jev_review without a target": {
		tool: "jev_review",
		params: { kind: "diff", claim: "The report includes coverage.", evidence: [{ kind: "code", quote: "export const coverage = 100;" }] },
	},
	"jev_search_relevance with one candidate": {
		tool: "jev_search_relevance",
		params: {
			query: "coverage report",
			candidates: [{ title: "Coverage report", evidence: "bun test: 87 pass", reason: "names the recorded coverage" }],
		},
	},
	"jev_text_review with an empty rule list": {
		tool: "jev_text_review",
		params: { text: "The report is complete.\n\nAll checks pass.", rules: [] },
	},
};

given("the executor submits {string} to a Jev tool", async (value, submission) => {
	const world = setup(value);
	const call = INVALID_CALLS[submission];
	expect(call).toBeDefined();
	world.info["invalid"] = call;
	world.info["callsBefore"] = world.fake.calls.length;
	world.results["invalid"] = await world.pi.callTool(call!.tool, call!.params, world.ctx);
});

when("the submission is rejected locally", value => {
	const world = setup(value);
	expect(toolFailed(world.results["invalid"])).toBe(true);
	expect(toolDetails(world.results["invalid"])["kind"]).toBe("invalid");
	expect(toolText(world.results["invalid"])).toContain("invalid input");
});

then("no judge request is made", value => {
	const world = setup(value);
	const before = world.info["callsBefore"];
	if (typeof before !== "number") throw new Error(`the recorded judge call count is missing: ${String(before)}`);
	expect(world.fake.calls.length).toBe(before);
});

then("the result is recorded as not checked", async value => {
	const world = setup(value);
	expect(counts(await observe(world), "checks")["not_checked"]).toBe(1);
});

then("no diagnostic finding is created", async value => {
	const world = setup(value);
	const details = await observe(world);
	expect(details["findings"]).toEqual([]);
	expect(details["hold"]).toBeUndefined();
});

then("the corrected call remains possible", async value => {
	const world = setup(value);
	const call = world.info["invalid"] as { tool: string };
	switch (call.tool) {
		case "jev_acceptance":
			world.results["corrected"] = await world.pi.callTool(
				"jev_acceptance",
				{
					aspect: "business",
					claim: "The report serves the owner need.",
					evidence: [
						{ kind: "execution", quote: "bun test: 1 pass, 0 fail" },
						{ kind: "code", quote: "export const coverage = 100;" },
					],
				},
				world.ctx,
			);
			break;
		case "jev_review":
			world.table["review"] = { label: "sound", confidence: 0.9 };
			world.results["corrected"] = await world.pi.callTool("jev_review", reviewParams(), world.ctx);
			break;
		case "jev_search_relevance":
			world.table["candidate"] = { label: "candidate_1", confidence: 0.9 };
			world.results["corrected"] = await world.pi.callTool(
				"jev_search_relevance",
				{
					query: "coverage report",
					candidates: [
						{ title: "Coverage report", evidence: "bun test: 87 pass", reason: "names the recorded coverage" },
						{ title: "Release notes", evidence: "CHANGELOG entry", reason: "describes the release" },
					],
				},
				world.ctx,
			);
			break;
		default:
			world.table["text_rule_1"] = { probability: 0.05 };
			world.results["corrected"] = await world.pi.callTool(
				"jev_text_review",
				{ text: "The report is complete.", rules: [{ class: "clarity", rule: "Prefer direct statements." }] },
				world.ctx,
			);
	}
	expect(toolText(world.results["corrected"])).not.toContain("invalid input");
	const details = await observe(world);
	expect(details["findings"]).toEqual([]);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_05
// ---------------------------------------------------------------------------

given("a judgment is in flight for revision 4 of the current task", async value => {
	const world = setup(value);
	for (let index = 0; index < 4; index += 1) await recordAction(world, index);
	expect((await observe(world))["revision"]).toBe(4);
	world.table["consult"] = { probability: 0.9 };
	world.gate = gate();
	world.info["pending"] = world.pi.callTool("jev_consult", consultParams(), world.ctx);
	await world.gate.opened;
});

when("the work advances to revision 5 before the answer returns", async value => {
	const world = setup(value);
	await recordAction(world, 4);
	expect((await observe(world))["revision"]).toBe(5);
});

then("the returned answer is recorded as stale and discarded", async value => {
	const world = setup(value);
	world.gate?.release();
	const result = await (world.info["pending"] as Promise<unknown>);
	world.results["consult"] = result;
	expect(toolDetails(result)["kind"]).toBe("stale");
	expect(toolText(result)).toContain("stale");
});

then("it does not approve or condemn revision 5", async value => {
	const world = setup(value);
	const details = await observe(world);
	const checks = counts(details, "checks");
	expect(checks["passed"]).toBe(0);
	expect(checks["failed"]).toBe(0);
	expect(checks["inconclusive"]).toBe(0);
	expect(details["acceptance"]).toEqual([]);
	expect(details["revision"]).toBe(5);
});

then("no diagnostic finding is created for the stale answer", async value => {
	const world = setup(value);
	const details = await observe(world);
	expect(details["findings"]).toEqual([]);
	expect(details["hold"]).toBeUndefined();
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_06
// ---------------------------------------------------------------------------

given("a requirements submission was refused with exact material at revision 3", async value => {
	const world = setup(value);
	await ensureTask(world);
	for (let index = 0; index < 3; index += 1) await recordAction(world, index);
	expect((await observe(world))["revision"]).toBe(3);
	world.table["coverage"] = { probability: 0.05 };
	world.table["item_1"] = { probability: 0.05 };
	world.info["original"] = requirementsParams("Collect the coverage numbers.");
	world.results["requirements"] = await world.pi.callTool("jev_requirements", world.info["original"], world.ctx);
	expect(toolDetails(world.results["requirements"])["approved"]).toBe(false);
	const details = await observe(world);
	const findings = details["findings"] as Array<Record<string, unknown>>;
	expect(findings).toHaveLength(1);
	world.info["findingId"] = findings[0]?.["id"];
});

when("the executor submits materially different requirements at revision 4", async value => {
	const world = setup(value);
	await recordAction(world, 3);
	expect((await observe(world))["revision"]).toBe(4);
	world.results["laterRequirements"] = await world.pi.callTool(
		"jev_requirements",
		requirementsParams("Publish the coverage summary."),
		world.ctx,
	);
});

then("the later submission does not overwrite the original failed material", async value => {
	const world = setup(value);
	const details = await observe(world);
	const findings = details["findings"] as Array<Record<string, unknown>>;
	expect(findings).toHaveLength(2);
	expect(asRecord(details["hold"])?.["id"]).toBe(world.info["findingId"]);
});

then("the original boundary, revision, submitted JSON and result remain readable", async value => {
	const world = setup(value);
	const findings = (await observe(world))["findings"] as Array<Record<string, unknown>>;
	const original = findings[0];
	expect(original?.["boundary"]).toBe("jev_requirements");
	expect(original?.["revision"]).toBe(3);
	expect(String(original?.["material"])).toContain("Collect the coverage numbers");
	const result = asRecord(original?.["result"]);
	expect(result?.["kind"]).toBe("refusal");
	expect(typeof result?.["text"]).toBe("string");
});

then("the later attempt appears in the activity diagnostics without replacing that finding", async value => {
	const world = setup(value);
	const details = await observe(world);
	const findings = details["findings"] as Array<Record<string, unknown>>;
	expect(findings[1]?.["revision"]).toBe(4);
	expect(String(findings[1]?.["material"])).toContain("Publish the coverage summary");
	expect(counts(details, "checks")["failed"]).toBe(2);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_07
// ---------------------------------------------------------------------------

given("diagnostics are on and at least one Jev tool has run", async value => {
	const world = setup(value);
	world.table["consult"] = { probability: 0.9 };
	world.results["consult"] = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	expect(toolDetails(world.results["consult"])["diagnostics"]).toBeDefined();
	await recordAction(world, 0);
});

when("the executor reads any Jev tool result", async value => {
	const world = setup(value);
	world.results["context"] = await world.pi.callTool("jev_context", { action: "list" }, world.ctx);
});

then("details.diagnostics contains a checks group and a work group", value => {
	const world = setup(value);
	for (const result of [world.results["consult"], world.results["context"]]) {
		const diagnostics = asRecord(toolDetails(result)["diagnostics"]);
		expect(diagnostics).toBeDefined();
		expect(asRecord(diagnostics?.["checks"])).toBeDefined();
		expect(asRecord(diagnostics?.["work"])).toBeDefined();
	}
});

then("each group contains exactly passed, failed, inconclusive, unavailable and not_checked", value => {
	const world = setup(value);
	const diagnostics = asRecord(toolDetails(world.results["context"])["diagnostics"]);
	for (const name of ["checks", "work"]) {
		expect(Object.keys(asRecord(diagnostics?.[name]) ?? {}).sort()).toEqual([
			"failed",
			"inconclusive",
			"not_checked",
			"passed",
			"unavailable",
		]);
	}
});

then("checks counts judged activity results", value => {
	const world = setup(value);
	const checks = resultCounts(world.results["context"], "checks");
	expect(checks["passed"]).toBe(1);
	expect(checks["failed"]).toBe(0);
});

then("work counts coverage of consequential tool results", value => {
	const world = setup(value);
	const work = resultCounts(world.results["context"], "work");
	expect(work["not_checked"]).toBe(1);
	expect(work["passed"]).toBe(0);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_08
// ---------------------------------------------------------------------------

given("an approved plan is current for the task", async value => {
	const world = setup(value);
	await approvePlan(world);
});

when("a consequential tool result completes", async value => {
	const world = setup(value);
	world.gate = gate("action");
	await world.pi.emit(
		"tool_result",
		toolResultEvent("write", { path: "src/a.ts", content: "export const coverage = 100;" }, "Wrote src/a.ts"),
		world.ctx,
	);
});

then("the work coverage first counts that result as not checked", async value => {
	const world = setup(value);
	const work = counts(await observe(world), "work");
	expect(work["not_checked"]).toBe(1);
	expect(work["passed"]).toBe(0);
});

then("an action-conformance diagnostic runs in the background", async value => {
	const world = setup(value);
	expect(world.gate).toBeDefined();
	await world.gate?.opened;
	// The action judgment is blocked at the gate; admission and completion must not wait for it.
	let admission: unknown[] | undefined;
	let stop: unknown[] | undefined;
	void world.pi
		.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "export const more = 1;" }), world.ctx)
		.then(result => { admission = result; });
	void world.pi.emit("session_stop", stopEvent(), world.ctx).then(result => { stop = result; });
	const checkpoint = Promise.withResolvers<void>();
	setImmediate(() => checkpoint.resolve());
	await checkpoint.promise;
	world.info["admissionResolved"] = admission !== undefined;
	world.info["stopResolved"] = stop !== undefined;
	world.info["admission"] = admission;
	world.info["stop"] = stop;
	world.gate?.release();
	expect(await untilSettled(async () => judgeQuestions(world).includes("action"))).toBe(true);
});

then("the next tool call and the session stop do not wait for that background check", async value => {
	const world = setup(value);
	expect(world.info["admissionResolved"]).toBe(true);
	expect(world.info["stopResolved"]).toBe(true);
	expect(blockReason(world.info["admission"] as unknown[])).toBeUndefined();
	expect(stopDecision(world.info["stop"] as unknown[])).toBeUndefined();
	expect(await untilSettled(async () => counts(await observe(world), "work")["passed"] === 1)).toBe(true);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_09
// ---------------------------------------------------------------------------

given("a consequential invocation starts a background effect", async value => {
	const world = setup(value);
	await launchEffect(world, "bash", { command: "bun run deploy" }, "job-1");
});

when("only the launch result has been observed", () => {
	// Nothing else is observed; the launch result is the whole record.
});

then("the work coverage for that invocation remains not checked", async value => {
	const world = setup(value);
	const details = await observe(world);
	expect(counts(details, "work")["not_checked"]).toBe(1);
	const pending = details["pendingEffects"] as Array<Record<string, unknown>>;
	expect(pending).toHaveLength(1);
	expect(pending[0]?.["jobId"]).toBe("job-1");
});

then("no passed diagnostic is attributed to the unfinished effect", async value => {
	const world = setup(value);
	const details = await observe(world);
	expect(counts(details, "work")["passed"]).toBe(0);
	expect(counts(details, "checks")["passed"]).toBe(0);
});

then("observing the later terminal result does not by itself become an approval", async value => {
	const world = setup(value);
	await terminalEffect(world, { jobId: "job-1", status: "completed", type: "bash" }, Date.now());
	const details = await observe(world);
	expect(details["pendingEffects"]).toEqual([]);
	expect(details["acceptance"]).toEqual([]);
	expect(details["hold"]).toBeUndefined();
	expect(counts(details, "work")["passed"]).toBe(0);
	expect(counts(details, "work")["not_checked"]).toBe(1);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_10
// ---------------------------------------------------------------------------

given("checks have passed, failed and been left not checked in this session", async value => {
	const world = setup(value);
	await ensureTask(world);
	world.table["consult"] = { probability: 0.9 };
	await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	world.table["review"] = { label: "defect", confidence: 0.95 };
	await world.pi.callTool("jev_review", reviewParams(), world.ctx);
	await world.pi.callTool("jev_review", { kind: "diff", claim: "The report changed." }, world.ctx);
	const checks = counts(await observe(world), "checks");
	expect(checks["passed"]).toBeGreaterThan(0);
	expect(checks["failed"]).toBe(1);
	expect(checks["not_checked"]).toBeGreaterThan(0);
});

given("business acceptance is recorded while architecture acceptance is missing", async value => {
	const world = setup(value);
	await approvePlan(world);
	Object.assign(world.table, {
		acceptance: { label: "serves_business_need", confidence: 0.95 },
		execution_evidence: { probability: 0.95 },
		code_evidence: { probability: 0.95 },
		topic_1: { probability: 0.95 },
		topic_1_execution: { label: "evidence_1", confidence: 0.95 },
		topic_1_code: { label: "evidence_2", confidence: 0.95 },
	});
	const accepted = await world.pi.callTool(
		"jev_acceptance",
		{
			aspect: "business",
			claim: "The approved work serves the owner's coverage request.",
			evidence: [
				{ kind: "execution", quote: "bun test: 1 pass, 0 fail" },
				{ kind: "code", quote: "export const coverage = 100;" },
			],
		},
		world.ctx,
	);
	expect(toolDetails(accepted)["approved"]).toBe(true);
	const acceptance = (await observe(world))["acceptance"] as Array<Record<string, unknown>>;
	expect(acceptance.map(entry => entry["aspect"])).toEqual(["business"]);
});

when("the owner runs /jev-status", value => {
	const world = setup(value);
	world.pi.callCommand("jev-status", "", world.ctx);
});

then("the report shows the work group and the checks group separately", value => {
	const status = lastMessage(setup(value), "jev.status");
	expect(status).toContain("Work:");
	expect(status).toContain("Checks:");
	expect(status.indexOf("Work:")).toBeLessThan(status.indexOf("Checks:"));
});

then("it names current-revision business and architecture acceptance separately", value => {
	const status = lastMessage(setup(value), "jev.status");
	// The status lists the current-revision aspects that are recorded as approved and discloses a
	// missing aspect by omission; see the contradiction reported with this file.
	expect(status).toContain("Current-revision acceptance: business");
	expect(status).not.toContain("Current-revision acceptance: business, architecture");
	expect(status).not.toContain("Current-revision acceptance: architecture");
});

then("it reports judge calls and estimated spend", value => {
	const status = lastMessage(setup(value), "jev.status");
	expect(status).toContain("Judge requests:");
	expect(status).toContain("Estimated spend");
});

then("no passed action check is presented as proof of the implementation", value => {
	const status = lastMessage(setup(value), "jev.status");
	expect(status).toContain("Passed action checks do not prove a successful implementation.");
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_11
// ---------------------------------------------------------------------------

given("a valid judgment established a defect at a named boundary", async value => {
	const world = setup(value);
	await ensureTask(world);
	world.table["review"] = { label: "defect", confidence: 0.95 };
	world.results["review"] = await world.pi.callTool("jev_review", reviewParams(), world.ctx);
	world.table["consult"] = { probability: 0.5 };
	world.results["uncertain"] = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
});

when("the executor reports that finding", async value => {
	const world = setup(value);
	world.results["report"] = await world.pi.callTool("jev_context", { action: "list" }, world.ctx);
});

then("the report names the boundary, work revision and decision class", value => {
	const details = toolDetails(setup(value).results["report"]);
	const findings = details["findings"] as Array<Record<string, unknown>>;
	expect(findings).toHaveLength(2);
	expect(findings[0]?.["boundary"]).toBe("jev_review");
	expect(findings[0]?.["revision"]).toBe(0);
	expect(asRecord(findings[0]?.["result"])?.["kind"]).toBe("defect");
	expect(toolText(setup(value).results["report"])).toContain("\"boundary\": \"jev_review\"");
});

then("it does not call uncertainty a defect", value => {
	const findings = toolDetails(setup(value).results["report"])["findings"] as Array<Record<string, unknown>>;
	const uncertain = findings[1];
	expect(uncertain?.["boundary"]).toBe("jev_consult");
	expect(asRecord(uncertain?.["result"])?.["kind"]).toBe("unclear");
	expect(String(uncertain?.["reason"])).not.toContain("defect");
});

then("it states that the finding grants no approval and blocks no work or completion", value => {
	const world = setup(value);
	const report = toolText(world.results["report"]);
	expect(report).toContain("Jev diagnostics, not execution permission");
	expect(report).toContain("Findings never block continued work or completion");
	expect(toolDetails(world.results["report"])["acceptance"]).toEqual([]);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_12
// ---------------------------------------------------------------------------

given("a submission was judged and its material was recorded", async value => {
	const world = setup(value);
	world.table["consult"] = { probability: 0.5 };
	world.results["first"] = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	expect(toolDetails(world.results["first"])["kind"]).toBe("unclear");
	world.info["calls"] = world.fake.calls.length;
	expect(world.info["calls"]).toBe(1);
});

when("the executor resubmits byte-identical material at the same binding", async value => {
	const world = setup(value);
	world.results["second"] = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
});

then("no additional judge request is made", value => {
	const world = setup(value);
	const before = world.info["calls"];
	if (typeof before !== "number") throw new Error(`the recorded judge call count is missing: ${String(before)}`);
	expect(world.fake.calls.length).toBe(before);
});

then("the earlier result is returned as the recorded diagnostic", value => {
	const world = setup(value);
	const text = toolText(world.results["second"]);
	expect(text).toContain("already judged");
	expect(text).toContain("consult");
});

then("neither repetition nor an attempt count becomes permission or an approval", async value => {
	const world = setup(value);
	const details = await observe(world);
	expect(details["acceptance"]).toEqual([]);
	expect(toolDetails(world.results["second"])["approved"]).not.toBe(true);
	expect(world.pi.commands.has("jev-continue")).toBe(false);
	expect(stopDecision(await world.pi.emit("session_stop", stopEvent(), world.ctx))).toBeUndefined();
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_13
// ---------------------------------------------------------------------------

given("the executor reads a project file or runs a recognized literal read command", async value => {
	const world = setup(value);
	await world.pi.emit(
		"tool_result",
		toolResultEvent("read", { path: "src/report.ts" }, "export const coverage = 100;"),
		world.ctx,
	);
	await world.pi.emit("tool_result", toolResultEvent("bash", { command: "ls src" }, "report.ts"), world.ctx);
});

when("the tool result is observed", async value => {
	const world = setup(value);
	world.results["context"] = await world.pi.callTool("jev_context", { action: "list" }, world.ctx);
});

then("no consequential work coverage is recorded for that call", value => {
	const work = resultCounts(setup(value).results["context"], "work");
	expect(total(work)).toBe(0);
});

then("no judgment is requested merely to observe existing state", value => {
	expect(setup(value).fake.calls).toHaveLength(0);
});

then("the observation is not held for missing planning", async value => {
	const world = setup(value);
	expect(
		blockReason(await world.pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "export const a = 1;" }), world.ctx)),
	).toBeUndefined();
	expect(stopDecision(await world.pi.emit("session_stop", stopEvent(), world.ctx))).toBeUndefined();
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_14 (outline)
// ---------------------------------------------------------------------------

const OPERATIONS: Record<string, { tool: string; input: Record<string, unknown> }> = {
	"an unknown tool or MCP route": { tool: "mcp__custom_route", input: { spreadsheetId: "sheet-1" } },
	"eval or delegated task code": { tool: "eval", input: { language: "python", code: "print(1)" } },
	"an LSP action that can apply an edit": { tool: "lsp", input: { action: "rename", file: "src/a.ts", new_name: "b" } },
	"a shell command that changes the tree": { tool: "bash", input: { command: "rm -rf build" } },
	"a publication command": { tool: "bash", input: { command: "npm publish" } },
};

given("the executor invokes {string}", (value, operation) => {
	const world = setup(value);
	const call = OPERATIONS[operation];
	expect(call).toBeDefined();
	world.info["operation"] = call;
});

when("the call is classified", async value => {
	const world = setup(value);
	const operation = world.info["operation"] as { tool: string; input: Record<string, unknown> } | undefined;
	if (operation !== undefined) {
		world.info["consequential"] = isConsequentialMutation(operation.tool, operation.input);
		world.info["admission"] = await world.pi.emit("tool_call", toolCallEvent(operation.tool, operation.input), world.ctx);
		await world.pi.emit("tool_result", toolResultEvent(operation.tool, operation.input, "the invocation completed"), world.ctx);
		return;
	}
	// A write to an `xd://` Jev device names a diagnostic tool, not a project path.
	const input = world.info["write"] as Record<string, unknown>;
	world.info["consequential"] = isConsequentialMutation("write", input);
	const details = await observe(world);
	world.info["revisionBefore"] = details["revision"];
	world.info["checksBefore"] = { ...counts(details, "checks") };
	await world.pi.emit("tool_result", toolResultEvent("write", input, "dispatched to xd://jev_anti_slop"), world.ctx);
});

then("it is recorded as consequential work", async value => {
	const world = setup(value);
	expect(world.info["consequential"]).toBe(true);
	expect(counts(await observe(world), "work")["not_checked"]).toBe(1);
});

then("it is eligible for a diagnostic judgment on its actual payload", value => {
	expect(setup(value).info["consequential"]).toBe(true);
});

then("the classification does not itself refuse the call", value => {
	expect(blockReason(setup(value).info["admission"] as unknown[])).toBeUndefined();
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_15
// ---------------------------------------------------------------------------

given("an asynchronous launch recorded a pending effect with job id, tool type and start time", async value => {
	const world = setup(value);
	await approvePlan(world);
	await launchEffect(world, "bash", { command: "bun run deploy" }, "job-1");
	const details = await observe(world);
	const pending = details["pendingEffects"] as Array<Record<string, unknown>>;
	expect(pending).toHaveLength(1);
	expect(pending[0]?.["jobId"]).toBe("job-1");
	expect(pending[0]?.["tool"]).toBe("bash");
	world.info["revisionAfterLaunch"] = details["revision"];
});

when("a terminal async result with the same job id and type arrives later", async value => {
	const world = setup(value);
	await terminalEffect(world, { jobId: "job-1", status: "completed", type: "bash" }, Date.now());
});

then("the pending effect settles and its action diagnostic runs", async value => {
	const world = setup(value);
	const settled = await untilSettled(async () => {
		const pending = (await observe(world))["pendingEffects"] as unknown[];
		return pending.length === 0 && judgeQuestions(world).includes("action");
	});
	expect(settled).toBe(true);
	expect((await observe(world))["pendingEffects"]).toEqual([]);
});

then("the settled effect advances work evidence once", async value => {
	const world = setup(value);
	expect(
		await untilSettled(async () => counts(await observe(world), "work")["passed"] === 1),
	).toBe(true);
	const details = await observe(world);
	expect(details["revision"]).toBe((world.info["revisionAfterLaunch"] as number) + 1);
	world.info["revisionAfterSettle"] = details["revision"];
});

then("replaying the same terminal result does not count it twice", async value => {
	const world = setup(value);
	await terminalEffect(world, { jobId: "job-1", status: "completed", type: "bash" }, Date.now());
	const details = await observe(world);
	expect(details["revision"]).toBe(world.info["revisionAfterSettle"]);
	expect(counts(details, "work")["passed"]).toBe(1);
});

then("a mismatched job id, mismatched tool type or earlier timestamp does not settle it", async value => {
	const world = setup(value);
	const started = Date.now();
	await launchEffect(world, "task", { context: "collect the numbers", tasks: [{ task: "read only", solutionSpace: "one fix" }] }, "job-2");
	await terminalEffect(world, { jobId: "other-job", status: "completed", type: "task" }, Date.now() + 1);
	await terminalEffect(world, { jobId: "job-2", status: "completed", type: "bash" }, Date.now() + 1);
	await terminalEffect(world, { jobId: "job-2", status: "completed", type: "task" }, started - 1000);
	const pending = (await observe(world))["pendingEffects"] as Array<Record<string, unknown>>;
	expect(pending.map(entry => entry["jobId"])).toContain("job-2");
});

then("the unsettled effect remains recorded as not checked", async value => {
	const world = setup(value);
	const details = await observe(world);
	const pending = details["pendingEffects"] as Array<Record<string, unknown>>;
	expect(pending.map(entry => entry["jobId"])).toContain("job-2");
	expect(counts(details, "work")["not_checked"]).toBe(1);
});

// ---------------------------------------------------------------------------
// @jev_diagnostics_16
// ---------------------------------------------------------------------------

given("the executor invokes a Jev tool through write with path xd://jev_anti_slop", async value => {
	const world = setup(value);
	await ensureTask(world, { external: true });
	world.info["write"] = {
		path: "xd://jev_anti_slop",
		content: JSON.stringify({ artifact: "Coverage reached 87 percent in the last recorded run." }),
	};
});

then("it is treated as a Jev diagnostic call rather than a project change", value => {
	expect(setup(value).info["consequential"]).toBe(false);
});

then("it does not advance the project work revision", async value => {
	const world = setup(value);
	const details = await observe(world);
	expect(details["revision"]).toBe(world.info["revisionBefore"]);
	expect(total(counts(details, "work"))).toBe(0);
});

then("its own judgment is recorded on the checks ledger", async value => {
	const world = setup(value);
	Object.assign(world.table, {
		...cleanProtocolAnswers(),
		claim_1: { label: "supported", confidence: 0.95 },
		language_1: { probability: 0.05 },
		meta_1: { probability: 0.05 },
		relevance_1: { label: "serves", confidence: 0.95 },
		rule_1_1: { probability: 0.05 },
	});
	world.results["antiSlop"] = await world.pi.callTool(
		"jev_anti_slop",
		{
			artifact: "Coverage reached 87 percent in the last recorded run.",
			language: "English",
			register: "technical",
			purpose: "report coverage to the project owner",
			audience: "the project owner",
			rules: [{ class: "clarity", rule: "Prefer direct statements." }],
			claims: [
				{
					id: "c1",
					text: "Coverage reached 87 percent in the last recorded run.",
					kind: "fact",
					evidence: [{ kind: "execution", quote: "bun test: 87 pass", sourceClass: "primary" }],
				},
			],
		},
		world.ctx,
	);
	expect(toolFailed(world.results["antiSlop"])).toBe(false);
	const details = await observe(world);
	const before = world.info["checksBefore"] as Record<string, number>;
	expect(total(counts(details, "checks"))).toBe(total(before) + 1);
	expect(total(counts(details, "work"))).toBe(0);
});
