import { expect } from "bun:test";
import { consult } from "../../../src/activities.js";
import { createContextArchive, type ContextArchive } from "../../../src/context.js";
import { createJevController } from "../../../src/controller.js";
import type { Judge, JudgeQuestion } from "../../../src/judge.js";
import { freshState, registerTask, type JevState } from "../../../src/state.js";
import { asRecord, type Evidence, type ToolOutcome } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	boundaryConfig,
	fakeArtifacts,
	fakeCtx,
	fakePi,
	fakeZod,
	failingJudge,
	stopDecision,
	stopEvent,
	toolCallEvent,
	toolDetails,
	toolFailed,
	toolResultEvent,
	toolText,
	type FakeAnswer,
	type FakeAnswerSource,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/**
 * Steps for `scenarios/jev_consult.feature`, scoped to that file. Each step drives the production
 * `consult` activity, and the controller where the scenario is about the tool boundary.
 */

const { given, when, then } = scoped("jev_consult.feature");

const QUESTION = "Does the dry-run report name the planned writes on stdout?";
const CONTEXT = "The existing reporter writes progress to stderr and machine output to stdout.";
const TASK_REQUEST = "Add a --dry-run flag to the export command and update its usage text.";
const REQUIREMENTS = ["The export command supports --dry-run.", "The usage text names --dry-run."];
const ALTERNATIVES = [
	{ label: "stdout", meaning: "The dry-run report joins the machine output on stdout." },
	{ label: "stderr", meaning: "The dry-run report joins progress messages on stderr." },
];
const CRITERIA = ["absent", "partial", "complete"];
const TRUE_MEANING = "The report names the planned writes.";
const FALSE_MEANING = "The report omits the planned writes.";

/** The observable fields every step may read; the runner's world object is shared per scenario. */
interface Observed {
	ok: boolean;
	text: string;
	details?: Record<string, unknown>;
}

interface JudgeCall {
	state: unknown;
	questions: readonly JudgeQuestion[];
}

interface SequencedJudge {
	judge: Judge;
	calls: JudgeCall[];
}

interface World {
	state?: JevState;
	fake?: SequencedJudge;
	table?: Record<string, FakeAnswerSource>;
	calls?: JudgeCall[];
	outcome?: Observed;
	result?: unknown;
	pi?: FakePi;
	ctx?: unknown;
	mode?: string;
	question?: string;
	context?: string;
	params?: Record<string, unknown>;
	expectedField?: string;
	codeQuote?: string;
	ownerQuote?: string;
	ownerId?: string;
	first?: unknown;
	second?: unknown;
	blocks?: unknown[];
	firstHold?: Record<string, unknown>;
	[key: string]: unknown;
}

const world = (value: unknown): World => value as World;

function setup(value: unknown): World {
	const w = world(value);
	if (!Array.isArray(w.calls)) w.calls = [];
	if (w.table === undefined) w.table = {};
	return w;
}

const observed = (result: unknown): Observed => ({
	ok: !toolFailed(result),
	text: toolText(result),
	details: toolDetails(result),
});

function validConsult(mode: string, question = QUESTION, context = CONTEXT): Record<string, unknown> {
	const base = { mode, question, context };
	if (mode === "choice") return { ...base, alternatives: ALTERNATIVES };
	if (mode === "score") return { ...base, criteria: CRITERIA };
	return { ...base, trueMeaning: TRUE_MEANING, falseMeaning: FALSE_MEANING };
}

function usableAnswer(mode: string): FakeAnswer {
	if (mode === "choice") return { label: "stdout", confidence: 0.95 };
	if (mode === "score") return { score: 2, confidence: 0.95 };
	return { probability: 0.9, confidence: 0.95 };
}

function belowFloorAnswer(mode: string): FakeAnswer {
	if (mode === "choice") return { label: "stdout", confidence: 0.3 };
	if (mode === "score") return { score: 1, confidence: 0.3 };
	// 0.5 is below the yes floor and its complement is below the no floor too.
	return { probability: 0.5, confidence: 0.9 };
}

async function runConsult(w: World, params: Record<string, unknown>): Promise<Observed> {
	const fake = answeringJudge(w.table ?? {});
	w.state ??= freshState();
	w.outcome = await consult({ judge: fake.judge, config: boundaryConfig() }, w.state, params);
	w.calls = [...(w.calls ?? []), ...fake.calls];
	w.params = params;
	return w.outcome;
}

/** A controller whose judge answer sequence comes from `answers`; every tool result is observable. */
function controller(
	w: World,
	judge: Judge,
	options: { context?: ContextArchive } = {},
): FakePi {
	const pi = fakePi();
	createJevController({
		judge,
		config: boundaryConfig(),
		zod: fakeZod(),
		...(options.context === undefined ? {} : { context: options.context }),
	}).register(pi.api);
	w.pi = pi;
	w.ctx = fakeCtx({ artifactsDir: (w.cwd as string | undefined) ?? null });
	return pi;
}

// Background ---------------------------------------------------------------

given("ordinary Jev diagnostics are enabled", value => {
	// Diagnostics are the shipped default; only the world's observable collections are prepared.
	const w = setup(value);
	void w;
});

given("judge answers are bound to the current task and work revision", value => {
	// The fake judge answers are bound by the activity itself: material carries registeredTask and
	// workRevision, and a change during judgment makes the answer stale.
	setup(value);
});

// Scenario 1 ---------------------------------------------------------------

given("a valid {string} consultation with question, context and {string}", (value, mode, definition) => {
	const w = setup(value);
	w.state = freshState();
	w.mode = mode;
	w.question = QUESTION;
	w.context = CONTEXT;
	w.params = validConsult(mode);
	w.table = { consult: usableAnswer(mode) };
	w.definition = definition;
});

when("the judge returns a usable {string} at the applicable floor", async (value, answer) => {
	const w = setup(value);
	w.answer = answer;
	w.outcome = await runConsult(w, w.params!);
});

then("the consultation returns that typed answer", value => {
	const w = setup(value);
	expect(w.outcome?.ok).toBe(true);
	const details = w.outcome?.details ?? {};
	expect(details["mode"]).toBe(w.mode);
	if (w.mode === "choice") {
		expect(details["label"]).toBe("stdout");
		expect(details["meaning"]).toBe(ALTERNATIVES[0]?.meaning);
	} else if (w.mode === "score") {
		expect(details["score"]).toBe(2);
		expect(details["level"]).toBe(2);
	} else {
		expect(details["probability"]).toBe(0.9);
	}
	expect(w.outcome?.text.startsWith(`Consult (${w.mode})`)).toBe(true);
});

then("the judge receives the submitted question and context", value => {
	const w = setup(value);
	const call = w.calls?.[0];
	const material = asRecord(call?.state);
	expect(material?.["question"]).toBe(w.question);
	expect(material?.["context"]).toBe(w.context);
});

then("no project action, acceptance or completion is approved", value => {
	const w = setup(value);
	expect(w.state?.acceptance).toEqual([]);
	expect(w.state?.actions).toEqual([]);
	expect(w.state?.completion).toBeUndefined();
	expect(w.state?.plan).toBeUndefined();
	expect(w.outcome?.details?.["approved"]).not.toBe(true);
});

// Scenario 2 ---------------------------------------------------------------

function malformedConsult(defect: string): { params: Record<string, unknown>; field: string } {
	if (defect === "choice with one alternative") {
		return {
			params: { mode: "choice", question: QUESTION, context: CONTEXT, alternatives: [ALTERNATIVES[0]] },
			field: "alternatives",
		};
	}
	if (defect === "score with one criterion") {
		return { params: { mode: "score", question: QUESTION, context: CONTEXT, criteria: ["only"] }, field: "criteria" };
	}
	if (defect === "boolean without trueMeaning") {
		return {
			params: { mode: "boolean", question: QUESTION, context: CONTEXT, falseMeaning: FALSE_MEANING },
			field: "trueMeaning",
		};
	}
	if (defect === "missing question") {
		return {
			params: { mode: "boolean", context: CONTEXT, trueMeaning: TRUE_MEANING, falseMeaning: FALSE_MEANING },
			field: "question",
		};
	}
	if (defect === "missing context") {
		return {
			params: { mode: "boolean", question: QUESTION, trueMeaning: TRUE_MEANING, falseMeaning: FALSE_MEANING },
			field: "context",
		};
	}
	throw new Error(`unknown consultation defect: ${defect}`);
}

given("the executor submits a {string} consultation", (value, defect) => {
	const w = setup(value);
	w.state = freshState();
	const prepared = malformedConsult(defect);
	w.params = prepared.params;
	w.expectedField = prepared.field;
	w.table = { consult: usableAnswer("boolean") };
});

when("the tool validates the arguments", async value => {
	const w = setup(value);
	w.outcome = await runConsult(w, w.params!);
});

then("no judge request is made", value => {
	expect(setup(value).calls).toEqual([]);
});

then("the result points to the field that is invalid or missing", value => {
	const w = setup(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text).toContain(w.expectedField!);
});

then("no finding or approval is recorded", value => {
	const w = setup(value);
	expect(w.outcome?.details?.["kind"]).toBe("invalid");
	expect(w.outcome?.details?.["approved"]).toBe(false);
	expect(w.state?.hold).toBeUndefined();
	expect(w.state?.findings).toEqual([]);
	expect(w.state?.acceptance).toEqual([]);
});

// Scenario 3 ---------------------------------------------------------------

given('the executor submits mode "recovery" or a repair request', value => {
	const w = setup(value);
	w.state = freshState();
	// A repair consultation is the outdated shape the tool must refuse without a judge call.
	w.params = { ...validConsult("boolean"), recovery: { finding: "finding-abc123" } };
});

when("the consultation is validated", async value => {
	const w = setup(value);
	w.outcome = await runConsult(w, w.params!);
});

then("it is refused locally", value => {
	const w = setup(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.details?.["kind"]).toBe("invalid");
	expect(w.calls).toEqual([]);
});

then("the result directs the executor to continue work with the finding recorded", value => {
	const w = setup(value);
	expect(w.outcome?.text).toContain("continue the work");
	expect(w.outcome?.text).toContain("finding");
});

then("the tool creates neither a repair permit nor a finding-resolution phase", value => {
	const w = setup(value);
	const state = w.state as unknown as Record<string, unknown>;
	expect(w.state?.hold).toBeUndefined();
	expect(w.state?.findings).toEqual([]);
	expect(state["repair"]).toBeUndefined();
	expect(state["permit"]).toBeUndefined();
	expect(state["continuation"]).toBeUndefined();
	expect(state["waiver"]).toBeUndefined();
});

// Scenario 4 ---------------------------------------------------------------

given("a valid {word} consultation", (value, mode) => {
	const w = setup(value);
	w.state = freshState();
	w.mode = mode;
	w.params = validConsult(mode);
	w.table = { consult: belowFloorAnswer(mode) };
});

when("the judge answer stays below its approval floor", async value => {
	const w = setup(value);
	w.outcome = await runConsult(w, w.params!);
});

then("the result explicitly marks the answer inconclusive", value => {
	const w = setup(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.details?.["kind"]).toBe("unclear");
	expect(w.outcome?.text).toContain("inconclusive");
});

then("the result does not claim an approved decision or a proven defect", value => {
	const w = setup(value);
	expect(w.outcome?.text).not.toContain("approved");
	expect(w.outcome?.text).toContain("no defect is established");
	expect(w.outcome?.details?.["approved"]).not.toBe(true);
});

then("the executor may resubmit only with materially changed material", async value => {
	const w = setup(value);
	const before = w.calls?.length ?? 0;
	const repeated = await runConsult(w, w.params!);
	expect(w.calls?.length).toBe(before);
	expect(repeated.ok).toBe(false);
	expect(repeated.text).toContain("already judged");
	expect(repeated.text).toContain("change the material");
});

// Scenario 5 ---------------------------------------------------------------

given("one consultation question was refused or left unsettled", async value => {
	const w = setup(value);
	let answers = 0;
	const fake = answeringJudge({
		consult: () => (answers++ === 0 ? belowFloorAnswer("choice") : usableAnswer("choice")),
	});
	w.fake = fake;
	const pi = controller(w, fake.judge);
	w.first = await pi.callTool("jev_consult", validConsult("choice", QUESTION), w.ctx);
	w.outcome = observed(w.first);
	w.calls = [...fake.calls];
});

when("the executor asks a different question with different material", async value => {
	const w = setup(value);
	const second = await w.pi!.callTool(
		"jev_consult",
		validConsult("choice", "Does the report go to stderr with the progress messages?", "The reporter uses stderr for progress."),
		w.ctx,
	);
	w.second = second;
	w.result = second;
	w.calls = [...(w.fake?.calls ?? [])];
});

then("the judge considers the second question on its own submitted material", value => {
	const w = setup(value);
	expect(toolFailed(w.second)).toBe(false);
	expect(toolDetails(w.second)["mode"]).toBe("choice");
	expect(w.calls).toHaveLength(2);
	const material = asRecord(w.calls?.[1]?.state);
	expect(material?.["question"]).toBe("Does the report go to stderr with the progress messages?");
	expect(material?.["context"]).toBe("The reporter uses stderr for progress.");
});

then("the earlier result does not block or approve the second question", value => {
	const w = setup(value);
	expect(toolDetails(w.first)["kind"]).toBe("unclear");
	expect(toolDetails(w.second)["approved"]).not.toBe(true);
	expect(toolText(w.second)).not.toContain("stdout or stderr?");
});

then("the earlier finding remains recorded", value => {
	const w = setup(value);
	const hold = asRecord(toolDetails(w.first)["hold"]);
	expect(hold).toBeDefined();
	expect(asRecord(toolDetails(w.second)["hold"])).toEqual(hold);
	expect(String(hold?.["material"])).toContain(QUESTION);
});

// Scenario 6 ---------------------------------------------------------------

given("a diagnostic finding is recorded for the task", async value => {
	const w = setup(value);
	let answers = 0;
	const fake = answeringJudge({
		consult: () => (answers++ === 0 ? belowFloorAnswer("choice") : usableAnswer("choice")),
	});
	w.fake = fake;
	const pi = controller(w, fake.judge);
	w.first = await pi.callTool("jev_consult", validConsult("choice", QUESTION), w.ctx);
	expect(toolDetails(w.first)["hold"]).toBeDefined();
	w.calls = [...fake.calls];
});

when("the executor obtains a usable consultation answer", async value => {
	const w = setup(value);
	w.second = await w.pi!.callTool(
		"jev_consult",
		validConsult("choice", "Is the usage text updated?", "The usage text is part of the change."),
		w.ctx,
	);
	w.calls = [...(w.fake?.calls ?? [])];
});

then("the response says the existing finding remains on record", value => {
	const w = setup(value);
	expect(toolFailed(w.second)).toBe(false);
	expect(toolText(w.second)).toContain("stays a diagnostic record");
	expect(asRecord(toolDetails(w.second)["hold"])).toBeDefined();
});

then("the answer neither clears it nor authorizes or blocks an effect", value => {
	const w = setup(value);
	const hold = asRecord(toolDetails(w.first)["hold"]);
	expect(asRecord(toolDetails(w.second)["hold"])).toEqual(hold);
	expect(toolDetails(w.second)["approved"]).not.toBe(true);
});

then("the next tool call and completion do not wait for the finding", async value => {
	const w = setup(value);
	const blocks = await w.pi!.emit("tool_call", toolCallEvent("write", { path: "src/export.ts", content: "dry run" }), w.ctx);
	const stops = await w.pi!.emit("session_stop", stopEvent(), w.ctx);
	expect(blockReason(blocks)).toBeUndefined();
	expect(stopDecision(stops)).toBeUndefined();
	expect(asRecord(toolDetails(w.second)["hold"])).toBeDefined();
});

// Scenario 7 ---------------------------------------------------------------

given("the executor submits a question with quoted code and an archive sourceId", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	const archive = createContextArchive(w.cwd as string);
	const owner = archive.put({
		kind: "owner",
		sessionId: "session-1",
		origin: "interactive",
		content: "Machine output goes to stdout.\nProgress goes to stderr.",
	});
	w.ownerId = owner.id;
	w.codeQuote = "process.stderr.write(progress)";
	w.ownerQuote = "Machine output goes to stdout.";
	const evidence: Evidence[] = [
		{ kind: "code", source: "src/report.ts", quote: w.codeQuote },
		{ kind: "user", sourceId: owner.id, quote: w.ownerQuote },
	];
	w.params = { ...validConsult("boolean"), evidence };
	const fake = answeringJudge({ consult: usableAnswer("boolean") });
	w.fake = fake;
	controller(w, fake.judge, { context: archive });
});

when("the tool prepares the question and checks its evidence", async value => {
	const w = setup(value);
	w.result = await w.pi!.callTool("jev_consult", w.params, w.ctx);
	w.outcome = observed(w.result);
	w.calls = [...(w.fake?.calls ?? [])];
});

then("the exact quote is verified against the archived source before judging", value => {
	const w = setup(value);
	expect(w.calls).toHaveLength(1);
	const material = asRecord(w.calls?.[0]?.state);
	const selected = asRecord(material?.["trustedContext"])?.["selectedSources"];
	expect(selected).toEqual([expect.objectContaining({ id: w.ownerId, kind: "owner" })]);
});

then("the judge receives the submitted question, context and evidence", value => {
	const w = setup(value);
	const material = asRecord(w.calls?.[0]?.state);
	expect(material?.["question"]).toBe(QUESTION);
	expect(material?.["context"]).toBe(CONTEXT);
	const quotes = material?.["quotes"];
	expect(Array.isArray(quotes)).toBe(true);
	const joined = (quotes as unknown[]).join("\n");
	const codeQuote = w.codeQuote;
	const ownerQuote = w.ownerQuote;
	if (codeQuote === undefined || ownerQuote === undefined) throw new Error("the submitted quotes were not recorded");
	expect(joined).toContain(codeQuote);
	expect(joined).toContain(ownerQuote);
});

then("no unsubmitted private reasoning is invented as context", value => {
	const w = setup(value);
	const material = asRecord(w.calls?.[0]?.state);
	expect(material?.["context"]).toBe(CONTEXT);
	expect(material?.["ownerMessages"]).toEqual([]);
	expect(material?.["registeredTask"]).toBeNull();
});

// Scenario 8 ---------------------------------------------------------------

given("a development task is registered", value => {
	const w = setup(value);
	w.state = freshState();
	w.state.request = { text: TASK_REQUEST, weight: "judged" };
	const task = registerTask(w.state, TASK_REQUEST);
	w.state.requirementsApproval = { taskFingerprint: task.fingerprint, items: REQUIREMENTS };
	w.params = validConsult("boolean");
	w.table = { consult: usableAnswer("boolean") };
});

when("a consultation is judged", async value => {
	const w = setup(value);
	w.outcome = await runConsult(w, w.params!);
});

then("the registered objective and current approvals accompany the submitted material", value => {
	const w = setup(value);
	const material = asRecord(w.calls?.[0]?.state);
	expect(material?.["registeredTask"]).toBe(TASK_REQUEST);
	expect(material?.["requirements"]).toEqual(REQUIREMENTS);
	expect(material?.["workRevision"]).toBe(w.state?.revision);
});

then("the answer is bound to that task and work revision", value => {
	const w = setup(value);
	expect(w.outcome?.ok).toBe(true);
	const submission = asRecord(w.outcome?.details?.["submission"]);
	expect(String(submission?.["boundary"])).toMatch(/^consult:[0-9a-f]{12}$/);
	expect(String(submission?.["digest"])).toMatch(/^[0-9a-f]{64}$/);
});

async function staleConsult(mutate: (state: JevState) => void): Promise<ToolOutcome> {
	const state = freshState();
	state.request = { text: TASK_REQUEST, weight: "judged" };
	const task = registerTask(state, TASK_REQUEST);
	state.requirementsApproval = { taskFingerprint: task.fingerprint, items: REQUIREMENTS };
	const judge: Judge = async () => {
		mutate(state);
		return { ok: true, answers: [{ name: "consult", mode: "noul", probability: 0.9, confidence: 0.95 }] };
	};
	return consult({ judge, config: boundaryConfig() }, state, validConsult("boolean"));
}

then("a change to the task or revision makes that answer stale", async () => {
	const revisionChanged = await staleConsult(state => {
		state.revision += 1;
	});
	const taskChanged = await staleConsult(state => {
		registerTask(state, "Replace the export command entirely.");
	});
	for (const outcome of [revisionChanged, taskChanged]) {
		expect(outcome.ok).toBe(false);
		expect(outcome.details?.["kind"]).toBe("stale");
		expect(outcome.text).toContain("changed during judgment");
	}
});

// Scenario 9 ---------------------------------------------------------------

given("a valid consultation", value => {
	const w = setup(value);
	w.params = validConsult("boolean");
	w.table = { consult: usableAnswer("boolean") };
	w.fail = true;
	const pi = controller(w, failingJudge("socket reset", "unavailable"));
	w.onJudgeUnavailable = async () => {
		w.result = await pi.callTool("jev_consult", w.params, w.ctx);
		w.outcome = observed(w.result);
	};
});

when("the judge is unavailable", async value => {
	const w = setup(value);
	w.fail = true;
	const hook = w["onJudgeUnavailable"];
	expect(typeof hook).toBe("function");
	await (hook as () => Promise<void>)();
});

then("no decision is returned", value => {
	const w = setup(value);
	expect(w.outcome?.details?.["kind"]).toBe("unavailable");
	expect(toolText(w.result)).toContain("No judge decision exists");
	expect(w.outcome?.details?.["label"]).toBeUndefined();
	expect(w.outcome?.details?.["probability"]).toBeUndefined();
	expect(w.outcome?.details?.["approved"]).not.toBe(true);
});

then("the result says there was no judgment", value => {
	const w = setup(value);
	expect(w.outcome?.text).toContain("No judge decision exists");
});

then("ordinary work and completion remain available", async value => {
	const w = setup(value);
	const blocks = await w.pi!.emit("tool_call", toolCallEvent("write", { path: "src/export.ts", content: "dry run" }), w.ctx);
	const stops = await w.pi!.emit("session_stop", stopEvent(), w.ctx);
	expect(blockReason(blocks)).toBeUndefined();
	expect(stopDecision(stops)).toBeUndefined();
});

// Scenario 10 --------------------------------------------------------------

given("a consultation approved a proposed alternative", async value => {
	const w = setup(value);
	const fake = answeringJudge({ consult: usableAnswer("choice") });
	w.fake = fake;
	const pi = controller(w, fake.judge);
	w.params = validConsult("choice");
	w.result = await pi.callTool("jev_consult", w.params, w.ctx);
	w.outcome = observed(w.result);
	expect(w.outcome.ok).toBe(true);
});

when("the executor performs the corresponding project change", async value => {
	const w = setup(value);
	w.blocks = await w.pi!.emit(
		"tool_call",
		toolCallEvent("write", { path: "src/export.ts", content: "if (flags.dryRun) return reportPlannedWrites();" }),
		w.ctx,
	);
	await w.pi!.emit(
		"tool_result",
		toolResultEvent("write", { path: "src/export.ts", content: "if (flags.dryRun) return reportPlannedWrites();" }, "Wrote src/export.ts"),
		w.ctx,
	);
});

then("only the host's permissions determine whether the change can execute", value => {
	const w = setup(value);
	expect(blockReason(w.blocks ?? [])).toBeUndefined();
});

then("the consultant answer is not recorded as action authorization", value => {
	const w = setup(value);
	const details = toolDetails(w.result);
	expect(details["approved"]).not.toBe(true);
	expect(details["authorization"]).toBeUndefined();
	expect(toolText(w.result)).not.toContain("authorized");
});

then("any action diagnostic remains separate evidence", async value => {
	const w = setup(value);
	const listed = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
	const diagnostics = asRecord(toolDetails(listed)["diagnostics"]);
	const checks = asRecord(diagnostics?.["checks"]);
	const work = asRecord(diagnostics?.["work"]);
	expect(checks?.["passed"]).toBe(1);
	expect(work?.["passed"]).toBe(0);
	expect(Number(work?.["not_checked"])).toBeGreaterThanOrEqual(1);
});
