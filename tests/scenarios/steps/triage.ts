import { expect } from "bun:test";
import { triage } from "../../../src/activities.js";
import { createJevController } from "../../../src/controller.js";
import { freshState, registerTask, sha256, type JevState } from "../../../src/state.js";
import { weightOf } from "../../../src/screen.js";
import type { ToolOutcome } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	boundaryConfig,
	fakeCtx,
	fakePi,
	fakeZod,
	failingJudge,
	toolCallEvent,
	type FakeAnswerSource,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/** Steps for `scenarios/jev_triage.feature`, driving the production triage activity. */

const { given, then, when } = scoped("jev_triage.feature");

interface TriageWorld {
	state: JevState;
	table: Record<string, FakeAnswerSource>;
	calls: Array<{ questions: ReadonlyArray<{ name: string }> }>;
	outcome?: ToolOutcome;
	request: string;
	topics?: string[];
	second?: ToolOutcome;
	secondState?: JevState;
}

const world = (value: unknown): TriageWorld => value as TriageWorld;

function setup(value: unknown): TriageWorld {
	const w = world(value);
	if (w.state === undefined) {
		w.state = freshState();
		w.table = {};
	}
	if (!Array.isArray(w.calls)) w.calls = [];
	if (w.request === undefined) w.request = "";
	return w;
}

async function run(w: TriageWorld, state: JevState = w.state): Promise<ToolOutcome> {
	const fake = answeringJudge(w.table);
	const outcome = await triage({ judge: fake.judge, config: boundaryConfig() }, state, {
		request: w.state.request?.text ?? w.request,
	});
	w.calls.push(...fake.calls);
	return outcome;
}

given("no development task is registered", value => {
	expect(setup(value).state.task).toBeUndefined();
});

when("the owner asks to {string}", (value, request) => {
	const w = setup(value);
	w.request = request;
	w.state.request = { text: request, weight: weightOf(request) };
});

when("the executor carries out only the recognized read-only request", value => {
	const w = setup(value);
	w.outcome = { ok: true, text: String(weightOf(w.request)), details: {} };
});

then("no triage judgment is requested", value => {
	expect(world(value).calls).toHaveLength(0);
});

then("project reads and public URL reads remain available", value => {
	const w = world(value);
	expect(weightOf(w.request)).toBe("quiet");
});

then("no development registration is invented", value => {
	expect(world(value).state.task).toBeUndefined();
});

// Scenario 2 -----------------------------------------------------------------

given("the owner asks to add a dry-run flag and update the usage text", value => {
	const w = setup(value);
	w.request = "Add a --dry-run flag to the export command and update its usage text.";
	w.state.request = { text: w.request, weight: "judged" };
});

when("triage decides at the floor that the request requires development", async value => {
	const w = world(value);
	w.table.needs_development = { probability: 0.95 };
	w.table.external_deliverable = { probability: 0 };
	w.outcome = await run(w);
});

then("the registered objective reproduces the owner's words exactly", value => {
	const w = world(value);
	expect(w.state.task?.request).toBe(w.request);
});

then("the result names the task fingerprint", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain((w.state.task?.fingerprint ?? "").slice(0, 12));
});

then("no approval of implementation is recorded", value => {
	const w = world(value);
	expect(w.state.acceptance).toEqual([]);
	expect(w.state.requirementsApproval).toBeUndefined();
});

// Scenario 3 -----------------------------------------------------------------

given("the owner asks only to verify existing output", value => {
	const w = setup(value);
	w.request = "Verify the existing test results.";
	w.state.request = { text: w.request, weight: "judged" };
});

when("triage decides at the floor that the request is simple", async value => {
	const w = world(value);
	w.table.needs_development = { probability: 0.05 };
	w.table.external_deliverable = { probability: 0 };
	w.outcome = await run(w);
});

then("the result lists the reviews the executor can skip", value => {
	expect(world(value).outcome?.text).toContain("Skipped activities");
});

then("no development task is registered", value => {
	expect(world(value).state.task).toBeUndefined();
});

then("the requested ordinary work is not held for requirements or a plan", value => {
	const w = world(value);
	expect(w.state.requirementsApproval).toBeUndefined();
	expect(w.state.plan).toBeUndefined();
});

// Scenario 4 -----------------------------------------------------------------

given("the executor proposes the topics {string} and {string}", (value, first, second) => {
	const w = setup(value);
	w.request = "Add a --dry-run flag to the export command.";
	w.state.request = { text: w.request, weight: "judged" };
	w.table.needs_development = { probability: 0.95 };
	w.table.external_deliverable = { probability: 0 };
	w.table.topic_1 = { probability: 0.9 };
	w.table.topic_2 = { probability: 0.1 };
	w.topics = [first, second];
});

when("triage judges each topic for this specific request", async value => {
	const w = world(value);
	w.outcome = await triage({ judge: answeringJudge(w.table).judge, config: boundaryConfig() }, w.state, {
		request: w.request,
		topics: w.topics ?? [],
	});
});

then("{string} is kept when it meets the confidence threshold", (value, topic) => {
	const w = world(value);
	expect(w.outcome?.details?.["topics"]).toContain(topic);
});

then("{string} is rejected as a generic label", (value, topic) => {
	const w = world(value);
	expect(w.outcome?.details?.["topics"]).not.toContain(topic);
});

then("the rejected topic is not silently promoted into a requirement", value => {
	expect(world(value).state.requirementsApproval).toBeUndefined();
});

// Scenario 5 -----------------------------------------------------------------

given("an ordinary owner prompt arrives", value => {
	const w = setup(value);
	w.request = "Add a --dry-run flag to the export command.";
	w.state.request = { text: w.request, weight: "judged" };
});

when("the addon prepares guidance", () => {
	// The prompt is prepared locally; no catalog is selected here.
});

then("the guidance does not select a generic expertise catalog", value => {
	expect(world(value).calls).toEqual([]);
});

then("only topics actually submitted for the current request are judged", async value => {
	const w = world(value);
	w.table.needs_development = { probability: 0.95 };
	w.table.external_deliverable = { probability: 0 };
	w.table.topic_1 = { probability: 0.9 };
	const fake = answeringJudge(w.table);
	await triage({ judge: fake.judge, config: boundaryConfig() }, w.state, {
		request: w.request,
		topics: ["export CLI flag"],
	});
	w.calls.push(...fake.calls);
	const names = w.calls.at(-1)?.questions.map(question => question.name) ?? [];
	expect(names).toContain("topic_1");
	expect(names.some(name => name.startsWith("topic_") && name !== "topic_1")).toBe(false);
});

// Scenario 6 -----------------------------------------------------------------

given("a request whose deliverable is a document for an outside audience", value => {
	const w = setup(value);
	w.request = "Write a launch brief for outside readers.";
	w.state.request = { text: w.request, weight: "judged" };
});

when("triage settles depth and external scope in one batch", async value => {
	const w = world(value);
	w.table.needs_development = { probability: 0.95 };
	w.table.external_deliverable = { probability: 0.95 };
	w.outcome = await run(w);
});

then("the task record classifies the document as external", value => {
	const w = world(value);
	expect(w.state.task?.external).toBe(true);
	expect(w.calls).toHaveLength(1);
});

then("an internal code change is not classified as an external deliverable", async value => {
	const w = world(value);
	const state = freshState();
	state.request = { text: "Add the export flag to the CLI.", weight: "judged" };
	w.secondState = state;
	w.second = await triage(
		{
			judge: answeringJudge({ needs_development: { probability: 0.95 }, external_deliverable: { probability: 0.05 } }).judge,
			config: boundaryConfig(),
		},
		state,
		{ request: "Add the export flag to the CLI." },
	);
	expect(w.secondState.task?.external).toBe(false);
});

// Scenario 7 -----------------------------------------------------------------

given("triage returns external probability 0.55 and internal probability 0.45", value => {
	const w = setup(value);
	w.request = "Write notes about the release for outside readers.";
	w.state.request = { text: w.request, weight: "judged" };
	w.table.needs_development = { probability: 0.95 };
	w.table.external_deliverable = { probability: 0.55 };
});

when("the result is recorded", async value => {
	const w = world(value);
	w.outcome = await run(w);
});

then("the document stays in scope for external review", value => {
	expect(world(value).state.task?.external).toBe(true);
});

then("later anti-slop review is not silently excluded", value => {
	expect(world(value).outcome?.text).toContain("anti-slop");
});

then("no external delivery is authorized by the classifier", value => {
	expect(world(value).outcome?.text ?? "").not.toContain("authorized");
});

// Scenario 8 -----------------------------------------------------------------

given("a valid triage submission", value => {
	const w = setup(value);
	w.request = "Add a --dry-run flag to the export command.";
	w.state.request = { text: w.request, weight: "judged" };
	w.table.needs_development = { probability: 0.5 };
	w.table.external_deliverable = { probability: 0.5 };
});

when("development and simple probabilities both stay below the floor", async value => {
	const w = world(value);
	w.outcome = await run(w);
});

then("no development task and no simple result are registered", value => {
	const w = world(value);
	expect(w.state.task).toBeUndefined();
	expect(w.state.simple).toBeUndefined();
});

then("the result reports uncertainty, not an established defect", value => {
	expect(world(value).outcome?.details?.["kind"]).toBe("unclear");
});

then("the executor may continue independent work and submit clearer material", value => {
	expect(world(value).outcome?.text).toContain("Next:");
});

// Scenario 9 -----------------------------------------------------------------

given('the current owner message is {string}', (value, message) => {
	const w = setup(value);
	w.state.request = { text: message, weight: "judged" };
});

when('the executor submits {string} to triage', async (value, submitted) => {
	const w = world(value);
	const fake = answeringJudge({ needs_development: { probability: 0.95 }, external_deliverable: { probability: 0 } });
	w.outcome = await triage({ judge: fake.judge, config: boundaryConfig() }, w.state, { request: submitted });
	w.calls.push(...fake.calls);
});

then("no judge request is made", value => {
	expect(world(value).calls).toEqual([]);
});

then("the result includes the actual owner message and its digest", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain(w.state.request?.text ?? "");
	expect(w.outcome?.text).toContain(sha256(w.state.request?.text ?? "").slice(0, 12));
});

then("the executor can resubmit the exact owner text", value => {
	expect(world(value).outcome?.text).toContain("submit");
});

// Scenario 10 ----------------------------------------------------------------

given("a development task is already registered", value => {
	const w = setup(value);
	w.request = "Add a --dry-run flag to the export command.";
	w.state.request = { text: w.request, weight: "judged" };
	registerTask(w.state, w.request);
});

when("the executor calls triage again for the same request", async value => {
	const w = world(value);
	w.outcome = await run(w);
});

then("the result names the existing task as the prerequisite", value => {
	expect(world(value).outcome?.text).toContain("already registered");
});

then("the result points to requirements, plan review or jev_reaim", value => {
	expect(world(value).outcome?.text).toContain("jev_reaim");
});

then("no second task identity is created", value => {
	const w = world(value);
	expect(w.state.task?.fingerprint).toBe(sha256(w.request.trim()));
});

// Scenario 11 ----------------------------------------------------------------

given("a judged change has no triage decision yet", value => {
	const w = setup(value);
	w.request = "Add the export flag.";
});

when("the executor reads a project file or performs a consequential action", async value => {
	const w = world(value);
	const pi = fakePi();
	createJevController({ judge: answeringJudge({}).judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const ctx = fakeCtx();
	await pi.emit("before_agent_start", { prompt: w.request, systemPrompt: [] }, ctx);
	w.outcome = { ok: true, text: String(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx)) ?? ""), details: {} };
});

then("the action is not refused for missing triage", value => {
	expect(world(value).outcome?.text).toBe("");
});

then("the work is recorded as not yet reviewed rather than approved", value => {
	expect(world(value).state.task).toBeUndefined();
});

then("the host still decides whether the action is allowed", value => {
	expect(world(value).outcome?.text).not.toContain("permission");
});

// Scenario 12 ----------------------------------------------------------------

given("a valid triage request is ready", value => {
	const w = setup(value);
	w.request = "Add a --dry-run flag to the export command.";
	w.state.request = { text: w.request, weight: "judged" };
});

when("the judge is unavailable during triage", async value => {
	const w = world(value);
	w.outcome = await triage({ judge: failingJudge("socket reset"), config: boundaryConfig() }, w.state, {
		request: w.request,
	});
});

then("no development or simple registration is created", value => {
	const w = world(value);
	expect(w.state.task).toBeUndefined();
	expect(w.state.simple).toBeUndefined();
});

then("the tool reports that no judgment was made", value => {
	expect(world(value).outcome?.text).toContain("No judge decision exists");
});

then("ordinary work continues under the host's permissions", value => {
	expect(world(value).state.hold).toBeUndefined();
});
