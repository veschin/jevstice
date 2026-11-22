import { expect } from "bun:test";
import { review } from "../../../src/activities.js";
import { createJevController } from "../../../src/controller.js";
import { acceptanceAt, freshState, registerTask, type JevState } from "../../../src/state.js";
import { POLICY, type ToolOutcome } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	boundaryConfig,
	failingJudge,
	fakeCtx,
	fakePi,
	fakeZod,
	stopDecision,
	stopEvent,
	toolCallEvent,
	toolDetails,
	toolText,
	type FakeAnswerSource,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/**
 * Step definitions for `scenarios/jev_review.feature`. Every verdict, refusal and replay is driven
 * through the production `review`; the defect scenario runs the production controller so the
 * recorded finding and the unblocked next call/completion are observed instead of restated.
 */

const { given, when, then } = scoped("jev_review.feature");

interface ReviewWorld {
	state: JevState;
	table: Record<string, FakeAnswerSource>;
	calls: number;
	callStates: unknown[];
	params?: Record<string, unknown>;
	outcome?: ToolOutcome;
	firstOutcome?: ToolOutcome;
	outcomes?: ToolOutcome[];
	result?: unknown;
	details?: Record<string, unknown>;
	text?: string;
	pi?: FakePi;
	ctx?: unknown;
	block?: string;
	stop?: string;
	kind?: string;
	target?: string;
	field?: string;
}

const world = (value: unknown): ReviewWorld => value as ReviewWorld;

function setup(value: unknown): ReviewWorld {
	const w = world(value);
	if (w.state === undefined) {
		w.state = freshState();
		w.table = {};
		w.calls = 0;
		w.callStates = [];
	}
	return w;
}

async function run(w: ReviewWorld): Promise<ToolOutcome> {
	const fake = answeringJudge(w.table);
	w.outcome = await review({ judge: fake.judge, config: boundaryConfig() }, w.state, w.params ?? {});
	w.calls += fake.calls.length;
	w.callStates.push(...fake.calls.map(call => call.state));
	return w.outcome;
}

function validParams(kind: string, target: string): Record<string, unknown> {
	return {
		kind,
		target,
		claim: "the report writer returns an empty report for a run with no samples",
		evidence: [
			{ kind: "code", quote: "diff --git a/src/report.ts b/src/report.ts\n@@\n+if (!run.samples.length) return emptyReport(run);" },
			{ kind: "execution", quote: "bun test tests/report.test.ts: 12 pass / 0 fail" },
		],
	};
}

function targetFor(kind: string): string {
	return kind === "checkpoint" ? "checkpoint-7" : kind === "commit" ? "9f3c2a1" : "HEAD~1..HEAD";
}

// Background ---------------------------------------------------------------

given("ordinary Jev diagnostics are enabled", value => {
	// The shipped config is the ordinary diagnostic mode; the state below is that mode's fresh state.
	setup(value);
});

// Scenario 1 (outline) -------------------------------------------------------

given("a current {word} target with changed-code quotes and observed verification output", (value, kind) => {
	const w = setup(value);
	w.kind = kind;
	w.target = targetFor(kind);
	w.params = validParams(kind, w.target);
	w.table.review = { label: "sound", confidence: POLICY.minConfidenceToApprove };
});

when("the executor requests a review of that target with the claim and evidence", async value => {
	await run(world(value));
});

when("the judge approves the claim at the choice floor", value => {
	const w = world(value);
	expect(w.calls).toBe(1);
	expect(w.outcome?.details?.["verdict"]).toBe("sound");
	expect(w.outcome?.details?.["confidence"]).toBe(POLICY.minConfidenceToApprove);
});

then("the result reports a sound developer review for that target", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(true);
	expect(w.outcome?.details?.["kind"]).toBe(w.kind);
	expect(w.outcome?.details?.["target"]).toBe(w.target);
	expect(w.outcome?.details?.["verdict"]).toBe("sound");
	expect(w.outcome?.text).toContain(`developer review of ${w.kind} ${w.target}: sound`);
});

then("the review remains evidence for the developer question only", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("This is evidence, not approval");
	expect(w.outcome?.text).toContain("business and architecture acceptance decide completion");
	expect(w.state.acceptance).toEqual([]);
	expect(w.state.completion).toBeUndefined();
});

// Scenario 2 (outline) -------------------------------------------------------

given("the review request has no {string}", (value, field) => {
	const w = setup(value);
	const params = validParams("diff", "HEAD~1..HEAD");
	if (field === "kind") delete params["kind"];
	else if (field === "target") delete params["target"];
	else if (field === "claim") delete params["claim"];
	else params["evidence"] = [];
	w.params = params;
	w.field = field;
});

when("the tool validates the submission", async value => {
	await run(world(value));
});

then("no judge request is made", value => {
	expect(world(value).calls).toBe(0);
});

then("the result names the missing field", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text.toLowerCase()).toContain(w.field ?? "");
});

then("no finding is recorded", value => {
	const w = world(value);
	expect(w.outcome?.details?.["kind"]).toBe("invalid");
	expect(w.state.submissions).toEqual([]);
	expect(w.state.hold).toBeUndefined();
});

// Scenario 3 -----------------------------------------------------------------

given("the executor submits kind {string}", (value, kind) => {
	const w = setup(value);
	const params = validParams("diff", "HEAD~1..HEAD");
	params["kind"] = kind;
	w.params = params;
});

when("Jev checks the review kind", async value => {
	await run(world(value));
});

then("the result accepts only checkpoint, commit or diff", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text).toContain("checkpoint");
	expect(w.outcome?.text).toContain("commit");
	expect(w.outcome?.text).toContain("diff");
});

// Scenario 4 -----------------------------------------------------------------

given("a valid developer review", value => {
	const w = setup(value);
	w.params = validParams("diff", "HEAD~1..HEAD");
});

when("the judge establishes a defect at the floor", async value => {
	const w = world(value);
	w.table.review = { label: "defect", confidence: POLICY.minConfidenceToApprove };
	const fake = answeringJudge(w.table);
	const pi = fakePi();
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const ctx = fakeCtx({ sessionId: "review-defect-session" });
	w.result = await pi.callTool("jev_review", w.params, ctx);
	w.details = toolDetails(w.result);
	w.text = toolText(w.result);
	w.calls += fake.calls.length;
	w.pi = pi;
	w.ctx = ctx;
});

then("the finding is recorded with the target and class", value => {
	const w = world(value);
	const hold = w.details?.["hold"] as { boundary?: string; result?: Record<string, unknown> } | undefined;
	expect(hold?.boundary).toBe("jev_review");
	expect(hold?.result?.["kind"]).toBe("defect");
	expect(hold?.result?.["target"]).toBe(w.params?.["target"]);
	expect(hold?.result?.["reviewKind"]).toBe(w.params?.["kind"]);
});

then("the result asks the executor to correct the quoted change", value => {
	expect(world(value).text).toContain("correct the quoted change");
});

then("the next tool call and session completion are not blocked", async value => {
	const w = world(value);
	expect(w.pi).toBeDefined();
	expect(w.ctx).toBeDefined();
	w.block = blockReason(await w.pi!.emit("tool_call", toolCallEvent("write", { path: "src/next.ts", content: "x" }), w.ctx));
	w.stop = stopDecision(await w.pi!.emit("session_stop", stopEvent(), w.ctx));
	expect(w.block).toBeUndefined();
	expect(w.stop).toBeUndefined();
});

// Scenario 5 -----------------------------------------------------------------

when("the answer is below the floor or reports unsupported material", async value => {
	const w = world(value);
	w.table.review = { label: "unsupported", confidence: 0.9 };
	w.params = validParams("diff", "HEAD~2..HEAD~1");
	const first = await run(w);
	w.params = validParams("diff", "HEAD~3..HEAD~2");
	w.table.review = { label: "sound", confidence: POLICY.minConfidenceToApprove - 0.1 };
	const second = await run(w);
	w.outcomes = [first, second];
});

then("the result is inconclusive", value => {
	const w = world(value);
	for (const outcome of w.outcomes ?? []) {
		expect(outcome.ok).toBe(false);
		expect(outcome.details?.["kind"]).toBe("unclear");
		expect(outcome.text).toContain("Class: inconclusive");
	}
});

then("the quoted change is not called defective", value => {
	const w = world(value);
	for (const outcome of w.outcomes ?? []) {
		expect(outcome.details?.["kind"]).not.toBe("defect");
		expect(outcome.text).not.toContain("Class: defect");
	}
});

then("the executor may submit materially better changed-code evidence", async value => {
	const w = world(value);
	w.params = validParams("diff", "HEAD~4..HEAD~3");
	(w.params["evidence"] as Array<{ kind: string; quote: string }>)[0] = { kind: "code", quote: "diff --git a/src/report.ts b/src/report.ts\n+const report = run.samples.length === 0 ? emptyReport(run) : build(run);" };
	w.table.review = { label: "sound", confidence: POLICY.minConfidenceToApprove };
	const better = await run(w);
	expect(better.ok).toBe(true);
	expect(better.details?.["verdict"]).toBe("sound");
});

// Scenario 6 -----------------------------------------------------------------

given("a developer review reports the change sound to keep", async value => {
	const w = setup(value);
	registerTask(w.state, "Report the coverage of the last run");
	w.params = validParams("diff", "HEAD~1..HEAD");
	w.table.review = { label: "sound", confidence: POLICY.minConfidenceToApprove };
	await run(w);
	expect(w.outcome?.ok).toBe(true);
});

when("both acceptance aspects are missing", value => {
	const w = world(value);
	expect(acceptanceAt(w.state, "business")).toBeUndefined();
	expect(acceptanceAt(w.state, "architecture")).toBeUndefined();
});

then("the review explicitly distinguishes its verdict from acceptance", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("This is evidence, not approval");
	expect(w.outcome?.text).toContain("business and architecture acceptance decide completion");
});

then("business and architecture records remain missing", value => {
	const w = world(value);
	expect(acceptanceAt(w.state, "business")).toBeUndefined();
	expect(acceptanceAt(w.state, "architecture")).toBeUndefined();
	expect(w.state.acceptance).toEqual([]);
});

then("the sound review does not authorize publication or completion", value => {
	const w = world(value);
	expect(Object.keys(w.outcome?.details ?? {}).sort()).toEqual(["confidence", "kind", "target", "verdict"]);
	expect(w.outcome?.text).not.toMatch(/authorize|publish|approved completion/i);
	expect(w.state.completion).toBeUndefined();
	expect(w.state.acceptance).toEqual([]);
});

// Scenario 7 -----------------------------------------------------------------

given("the executor quotes a diff and a command's observed output", value => {
	const w = setup(value);
	w.params = validParams("diff", "HEAD~1..HEAD");
});

when("the review is judged", async value => {
	const w = world(value);
	w.table.review = { label: "sound", confidence: POLICY.minConfidenceToApprove };
	await run(w);
	w.firstOutcome = w.outcome;
});

then("the judge receives the two quotes unchanged", value => {
	const w = world(value);
	const received = w.callStates[0] as Record<string, unknown> | undefined;
	expect(received?.["quotes"]).toEqual([
		"[code] diff --git a/src/report.ts b/src/report.ts\n@@\n+if (!run.samples.length) return emptyReport(run);",
		"[execution] bun test tests/report.test.ts: 12 pass / 0 fail",
	]);
});

then("a claim without those quotes is insufficient evidence", async value => {
	const w = world(value);
	const before = w.calls;
	const fake = answeringJudge(w.table);
	const params = { ...validParams("diff", "HEAD~1..HEAD"), evidence: [] };
	const refused = await review({ judge: fake.judge, config: boundaryConfig() }, w.state, params);
	expect(fake.calls).toHaveLength(0);
	expect(w.calls).toBe(before);
	expect(refused.ok).toBe(false);
	expect(refused.text).toContain("needs at least one quoted evidence item");
});

then("no judge-authored explanation is returned", value => {
	const w = world(value);
	expect(Object.keys(w.firstOutcome?.details ?? {}).sort()).toEqual(["confidence", "kind", "target", "verdict"]);
	expect(w.firstOutcome?.text.endsWith("This is evidence, not approval - business and architecture acceptance decide completion.")).toBe(true);
});

// Scenario 8 -----------------------------------------------------------------

when("the judge is unavailable", async value => {
	const w = setup(value);
	w.outcome = await review(
		{ judge: failingJudge("socket reset", "unavailable"), config: boundaryConfig() },
		w.state,
		w.params ?? {},
	);
});

then("Jev reports that no decision exists", value => {
	expect(world(value).outcome?.text).toContain("No judge decision exists");
});

then("no defect is invented", value => {
	const w = world(value);
	expect(w.outcome?.details?.["kind"]).not.toBe("defect");
	expect(w.outcome?.text).not.toContain("Class: defect");
	expect(w.state.submissions).toEqual([]);
});

then("work continues under the host's permissions", value => {
	const w = world(value);
	expect(w.state.hold).toBeUndefined();
	expect(w.state.exhausted).toEqual([]);
	expect(w.outcome?.text).toContain("An outage is not a defect and releases nothing.");
});

// Scenario 9 -----------------------------------------------------------------

given("a developer review was already judged for a target", async value => {
	const w = setup(value);
	w.params = validParams("diff", "HEAD~1..HEAD");
	w.table.review = { label: "defect", confidence: POLICY.minConfidenceToApprove };
	await run(w);
	expect(w.calls).toBe(1);
	expect(w.state.submissions).toHaveLength(1);
});

when("the executor resubmits the identical target, claim and evidence", async value => {
	await run(world(value));
});

then("no additional judge request is made", value => {
	expect(world(value).calls).toBe(1);
});

then("Jev returns the previously recorded review", value => {
	const w = world(value);
	// The ledger reports the recorded refusal rather than re-emitting the first result object; the
	// prior finding is what the repeated submission receives.
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text).toContain("already judged and refused");
	expect(w.outcome?.text).toContain("the finding stands as a diagnostic record");
	expect(w.state.submissions).toHaveLength(1);
});

then("no attempt count grants permission", value => {
	const w = world(value);
	expect(w.outcome?.details?.["approved"]).not.toBe(true);
	expect(w.outcome?.text).toContain("which is informational and changes no decision");
	expect(w.state.exhausted).toEqual([]);
});
