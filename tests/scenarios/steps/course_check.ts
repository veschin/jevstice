import { expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionCheck, courseCheck, type ActivityDeps } from "../../../src/activities.js";
import { DEFAULT_CONFIG, loadJevConfig } from "../../../src/config.js";
import { createJevController } from "../../../src/controller.js";
import { createToolCatalog } from "../../../src/guidance.js";
import type { Judge, JudgeQuestion } from "../../../src/judge.js";
import {
	freshState,
	recordAction,
	recordDiagnostic,
	recordRecovery,
	recoveryFeedback,
	registerTask,
	type JevState,
} from "../../../src/state.js";
import { asRecord, type JevConfig, type PlanTopic, type ToolOutcome } from "../../../src/types.js";
import {
	answeringJudge,
	boundaryConfig,
	blockReason,
	failingJudge,
	fakeCtx,
	fakePi,
	fakeZod,
	stopDecision,
	stopEvent,
	toolDetails,
	toolResultEvent,
	type FakeAnswerSource,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/** Steps for `scenarios/jev_course_check.feature`, driving the production course diagnostics. */

const { given, then, when } = scoped("jev_course_check.feature");

type JudgeCalls = Array<{ state: unknown; questions: readonly JudgeQuestion[] }>;

interface CourseWorld {
	state: JevState;
	deps: ActivityDeps;
	calls: JudgeCalls;
	outcome?: ToolOutcome;
	pi?: FakePi;
	ctx?: unknown;
	config?: JevConfig;
	configDir?: string;
	revisionAfterFailure?: number;
	asyncDetails?: Record<string, unknown>;
}

const REQUEST = "Report the coverage of the last run";

function topic(id: string, requirement: string): PlanTopic {
	return {
		id,
		section: "## Collect the numbers\n\nRead the run data and report the count.",
		paths: ["src/report.ts"],
		requirement,
	};
}

/** A world whose state is lazily created; every step may be the first to touch it. */
function w(value: unknown): CourseWorld {
	const world = value as Partial<CourseWorld>;
	world.state ??= freshState();
	world.calls ??= [];
	world.deps ??= { judge: failingJudge("no judge configured for this step"), config: boundaryConfig() };
	return world as CourseWorld;
}

/** Install one fake judge table for the submission this step submits. */
function configure(value: unknown, table: Record<string, FakeAnswerSource>): CourseWorld {
	const world = w(value);
	const fake = answeringJudge(table);
	world.deps = { judge: fake.judge, config: boundaryConfig() };
	world.calls = fake.calls;
	return world;
}

/** A registered task with approved requirements, an approved plan and one plan topic. */
function plannedState(): JevState {
	const state = freshState();
	const task = registerTask(state, REQUEST);
	state.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["Report coverage"] };
	state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://coverage-plan.md", planDigest: "digest" };
	state.planTopics = [topic("collect", "Report coverage")];
	return state;
}

function submit(world: CourseWorld, claim = "Implement the report counter under the approved plan"): Promise<ToolOutcome> {
	return courseCheck(world.deps, world.state, { claim });
}

// Background ---------------------------------------------------------------

given("ordinary Jev diagnostics are enabled", value => {
	w(value);
});

// Scenario 1 ---------------------------------------------------------------

given("the task has an approved plan and at least one plan topic", value => {
	w(value).state = plannedState();
});

given("no implementation action has been recorded yet", value => {
	expect(w(value).state.actions).toEqual([]);
});

when("the executor submits a concise claim about the planned work", async value => {
	const world = configure(value, { course: { label: "on_course", confidence: 0.95 } });
	world.outcome = await submit(world);
});

then("the claim is judged against the objective, requirements and plan", value => {
	const world = w(value);
	expect(world.calls).toHaveLength(1);
	expect(world.calls[0]?.questions[0]?.name).toBe("course");
	const judged = JSON.stringify(world.calls[0]?.state);
	expect(judged).toContain(REQUEST);
	expect(judged).toContain("Report coverage");
	expect(judged).toContain("collect");
});

then("the result gives the course verdict and its confidence", value => {
	const outcome = w(value).outcome;
	expect(outcome?.details?.["label"]).toBe("on_course");
	expect(typeof outcome?.details?.["confidence"]).toBe("number");
	expect(outcome?.text).toContain("on_course");
});

then("no file change is authorized by the answer", value => {
	const world = w(value);
	expect(world.outcome?.text).toContain("does not authorize a change");
	expect(world.state.revision).toBe(0);
	expect(world.state.acceptance).toEqual([]);
});

// Scenario 2 ---------------------------------------------------------------

given("the task has no approved plan or plan topic", value => {
	const world = w(value);
	world.state = freshState();
	registerTask(world.state, REQUEST);
});

when("the executor calls jev_course_check with a claim", async value => {
	const world = configure(value, {});
	world.outcome = await submit(world);
});

then("the tool says an approved plan is needed for the check", value => {
	const outcome = w(value).outcome;
	expect(outcome?.ok).toBe(false);
	expect(outcome?.text).toContain("approved plan");
	expect(outcome?.details?.["prerequisite"]).toBe("approved plan");
});

then("it states that nothing was judged and no finding was recorded", value => {
	const world = w(value);
	expect(world.outcome?.text).toContain("nothing was judged and no finding is recorded");
	expect(world.calls).toEqual([]);
	expect(world.state.findings).toEqual([]);
	expect(world.state.hold).toBeUndefined();
});

then("it does not report the work as on course", value => {
	const world = w(value);
	expect(world.outcome?.details?.["approved"]).not.toBe(true);
	expect(world.outcome?.text).not.toContain("on_course");
});

// Scenario 3 ---------------------------------------------------------------

given("the executor calls jev_course_check without claim text", async value => {
	const world = configure(value, {});
	world.outcome = await courseCheck(world.deps, world.state, {});
});

when("the tool validates the submission", value => {
	expect(w(value).outcome).toBeDefined();
});

then("no judge request is made", value => {
	expect(w(value).calls).toEqual([]);
});

then("the tool asks for a concise claim", value => {
	const text = w(value).outcome?.text ?? "";
	expect(text).toContain("claim is required");
	expect(text).toContain("state concisely");
});

then("no finding is recorded", value => {
	const world = w(value);
	expect(world.state.findings).toEqual([]);
	expect(world.state.hold).toBeUndefined();
});

// Scenario 4 ---------------------------------------------------------------

given("a valid course-check submission", value => {
	w(value).state = plannedState();
});

when("the judge answers off_course at the choice floor", async value => {
	const world = configure(value, { course: { label: "off_course", confidence: 0.9 } });
	world.outcome = await submit(world);
});

then("the result names the departure as an established defect", value => {
	const outcome = w(value).outcome;
	expect(outcome?.ok).toBe(false);
	expect(outcome?.details?.["kind"]).toBe("defect");
	expect(outcome?.text).toContain("Class: defect");
});

then("the finding identifies the checked boundary and revision", value => {
	const world = w(value);
	const finding = world.state.findings?.[0];
	expect(finding).toBeDefined();
	expect(finding?.boundary).toBe("course-check");
	expect(finding?.revision).toBe(world.state.revision);
	expect(finding?.id).toBe(asRecord(world.outcome?.details)?.["finding"] as string | undefined);
});

then("the result states that it blocks no other work", value => {
	const world = w(value);
	// The activity result calls the outcome a diagnostic; the finding's own disclosure is the
	// no-block statement the executor reads through jev_context.
	expect(world.outcome?.text).toContain("recorded as a diagnostic");
	expect(recoveryFeedback(world.state)).toContain("blocks no action or completion");
});

// Scenario 5 ---------------------------------------------------------------

when("the judge answers on_course below the choice floor", async value => {
	const world = configure(value, { course: { label: "on_course", confidence: 0.56 } });
	world.outcome = await submit(world);
});

then("the tool reports the answer as inconclusive", value => {
	const outcome = w(value).outcome;
	expect(outcome?.ok).toBe(false);
	expect(outcome?.details?.["kind"]).toBe("unclear");
	expect(outcome?.text).toContain("Class: inconclusive");
	expect(outcome?.text).not.toContain("Class: defect");
});

then("it is not treated as a reliable approval or a proven deviation", value => {
	const outcome = w(value).outcome;
	expect(outcome?.details?.["approved"]).not.toBe(true);
	expect(outcome?.details?.["confidence"]).toBe(0.56);
	expect(outcome?.text).toContain("reliability floor");
	expect(outcome?.text).toContain("not a proven deviation");
});

then("the executor may submit clearer observable evidence", value => {
	expect(w(value).outcome?.text).toContain("Next: quote the evidence");
});

// Scenario 6 ---------------------------------------------------------------

given("an unrelated diagnostic finding is recorded for the task", value => {
	const world = w(value);
	world.state = plannedState();
	const finding = recordRecovery(
		world.state,
		"review",
		{ target: "src/other.ts" },
		{ ok: false, text: "a developer review defect", details: { approved: false, kind: "defect" } },
	);
	expect(finding).toBeDefined();
});

when("the executor obtains an on-course answer at the floor", async value => {
	const world = configure(value, { course: { label: "on_course", confidence: 0.9 } });
	world.outcome = await submit(world);
});

then("the previous finding stays on record", value => {
	const world = w(value);
	const earlier = world.state.findings?.[0];
	expect(earlier?.boundary).toBe("review");
	expect(world.state.hold?.id).toBe(earlier?.id);
});

then("the approving check does not authorize a file change", value => {
	const world = w(value);
	expect(world.outcome?.ok).toBe(true);
	expect(world.outcome?.text).toContain("does not authorize a change");
	expect(world.state.revision).toBe(0);
});

then("it does not replace business or architecture acceptance", value => {
	const world = w(value);
	expect(world.outcome?.text).toContain("replace acceptance");
	expect(world.state.acceptance).toEqual([]);
});

// Scenario 7 ---------------------------------------------------------------

given("the plan has several topics", value => {
	const world = w(value);
	world.state = plannedState();
	world.state.planTopics = [
		topic("collect", "Report coverage"),
		topic("render", "Render the report"),
		topic("verify", "Verify the report"),
	];
});

given("one recent action serves one approved requirement", value => {
	recordAction(w(value).state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report counter" });
});

when("the automatic course diagnostic evaluates that action", async value => {
	const world = configure(value, { action: { label: "on_course", confidence: 0.9 } });
	const action = { tool: "write", target: "src/report.ts", change: "wrote the report counter" };
	world.outcome = await actionCheck(world.deps, world.state, action, { path: "src/report.ts", content: "export const count = 1;" });
	recordDiagnostic(world.state, world.outcome, true);
});

then("it judges the action against the whole approved task", value => {
	const world = w(value);
	const judged = JSON.stringify(world.calls[0]?.state);
	expect(judged).toContain(REQUEST);
	expect(judged).toContain("Report coverage");
	expect(judged).toContain("render");
	expect(judged).toContain("verify");
	expect(world.calls[0]?.questions[0]?.instructions).toContain("approved task plan");
});

then("the action need not address every plan topic at once", value => {
	const world = w(value);
	expect(world.calls[0]?.questions).toHaveLength(1);
	expect(world.calls[0]?.questions[0]?.name).toBe("action");
	expect(world.outcome?.details?.["approved"]).toBe(true);
});

then("the verdict is recorded as diagnostic coverage", value => {
	const work = w(value).state.diagnostics?.work;
	expect(work?.["passed"]).toBe(1);
});

// Scenario 8 ---------------------------------------------------------------

given("a consequential action fails or starts a background effect", value => {
	const world = w(value);
	const fake = answeringJudge({});
	world.pi = fakePi();
	world.ctx = fakeCtx();
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(world.pi.api);
});

when("the result is observed", async value => {
	const world = w(value);
	const pi = world.pi;
	expect(pi).toBeDefined();
	if (pi === undefined) return;
	await pi.emit(
		"tool_result",
		toolResultEvent("write", { path: "src/report.ts", content: "export const count = 1;" }, "Write failed: permission denied", true),
		world.ctx,
	);
	const afterFailure = toolDetails(await pi.callTool("jev_context", { action: "list" }, world.ctx));
	world.revisionAfterFailure = afterFailure["revision"] as number;
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
	world.asyncDetails = toolDetails(await pi.callTool("jev_context", { action: "list" }, world.ctx));
});

then("a failed action advances the work revision", value => {
	expect(w(value).revisionAfterFailure).toBe(1);
});

then("an unfinished background effect remains not checked", value => {
	const details = w(value).asyncDetails ?? {};
	expect(details["pendingEffects"]).toEqual([{ jobId: "job-1", tool: "bash" }]);
	const work = asRecord(asRecord(details["diagnostics"])?.["work"]);
	expect(work?.["not_checked"]).toBeGreaterThanOrEqual(1);
});

then("the record shows no passing course check for either case", value => {
	const details = w(value).asyncDetails ?? {};
	const work = asRecord(asRecord(details["diagnostics"])?.["work"]);
	expect(work?.["passed"]).toBe(0);
});

// Scenario 9 ---------------------------------------------------------------

when("the judge is unavailable", async value => {
	const world = w(value);
	world.deps = { judge: failingJudge("Judge service unavailable"), config: boundaryConfig() };
	world.calls = [];
	world.outcome = await submit(world);
});

then("the result says there was no judgment", value => {
	const outcome = w(value).outcome;
	expect(outcome?.ok).toBe(false);
	expect(outcome?.details?.["kind"]).toBe("unavailable");
	expect(outcome?.text).toContain("No judge decision exists");
});

then("no defect is invented", value => {
	const world = w(value);
	expect(world.outcome?.details?.["kind"]).not.toBe("defect");
	expect(world.outcome?.text).not.toContain("Class: defect");
	expect(world.state.findings).toEqual([]);
	expect(world.state.hold).toBeUndefined();
});

then("ordinary work and completion remain available", value => {
	const world = w(value);
	expect(world.outcome?.details?.["approved"]).not.toBe(true);
	expect(world.state.hold).toBeUndefined();
	expect(world.state.revision).toBe(0);
});

// Scenario 10 --------------------------------------------------------------

given("a course check is in flight for revision 6", value => {
	const world = w(value);
	world.state = plannedState();
	world.state.revision = 6;
});

when("the task or revision changes before the answer returns", async value => {
	const world = w(value);
	const base = answeringJudge({ course: { label: "on_course", confidence: 0.95 } });
	const judge: Judge = async (material, questions) => {
		world.state.revision = 7;
		return base.judge(material, questions);
	};
	world.deps = { judge, config: boundaryConfig() };
	world.calls = base.calls;
	world.outcome = await submit(world);
});

then("the check discards the answer as stale", value => {
	const outcome = w(value).outcome;
	expect(outcome?.ok).toBe(false);
	expect(outcome?.details?.["kind"]).toBe("stale");
	expect(outcome?.text).toContain("No answer was kept");
	expect(outcome?.text).toContain("Class: stale");
});

then("it neither approves nor condemns the new revision", value => {
	const world = w(value);
	expect(world.outcome?.details?.["approved"]).not.toBe(true);
	expect(world.outcome?.details?.["kind"]).not.toBe("defect");
	expect(world.state.findings).toEqual([]);
	expect(world.state.hold).toBeUndefined();
});

then("no current course decision is recorded", value => {
	const world = w(value);
	expect(world.state.acceptance).toEqual([]);
	expect(world.state.findings).toEqual([]);
	expect(world.state.hold).toBeUndefined();
});

// Scenario 11 --------------------------------------------------------------

given("a configuration file contains courseCheck.mode or courseCheck.interval", async value => {
	const world = w(value);
	const dir = await mkdtemp(join(tmpdir(), "jev-config-"));
	await mkdir(join(dir, ".omp"), { recursive: true });
	await writeFile(join(dir, ".omp", "jev.config.json"), JSON.stringify({ courseCheck: { mode: "interval", interval: 5 } }), "utf8");
	world.configDir = dir;
});

when("the configuration is loaded", value => {
	const world = w(value);
	world.config = loadJevConfig({ cwd: world.configDir ?? tmpdir(), home: join(world.configDir ?? tmpdir(), "home") });
});

then("the settings schedule neither periodic nor completion-only checks", value => {
	const config = w(value).config as unknown as Record<string, unknown>;
	expect("courseCheck" in config).toBe(false);
	expect(config["problems"]).toEqual([]);
});

then("only the callable jev_course_check remains available", () => {
	const names = createToolCatalog(fakeZod()).map(entry => entry.name);
	expect(names.filter(name => name.includes("course"))).toEqual(["jev_course_check"]);
});

then("the obsolete keys change no execution or completion behavior", value => {
	const world = w(value);
	expect(world.config).toEqual(DEFAULT_CONFIG);
	const pi = fakePi();
	const ctx = fakeCtx();
	createJevController({ judge: failingJudge("not needed"), config: world.config ?? DEFAULT_CONFIG, zod: fakeZod() }).register(pi.api);
	expect(pi.tools.has("jev_course_check")).toBe(true);
	return pi.emit("session_stop", stopEvent(), ctx).then(results => {
		expect(stopDecision(results)).toBeUndefined();
		expect(blockReason(results)).toBeUndefined();
	});
});
