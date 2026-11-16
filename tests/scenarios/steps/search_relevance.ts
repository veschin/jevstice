import { expect } from "bun:test";
import { searchRelevance } from "../../../src/activities.js";
import { createJevController } from "../../../src/controller.js";
import { freshState, type JevState } from "../../../src/state.js";
import { POLICY, type ToolOutcome } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	boundaryConfig,
	failingJudge,
	fakeCtx,
	fakePi,
	fakeZod,
	toolCallEvent,
	toolDetails,
	toolResultEvent,
	toolText,
	type FakeAnswerSource,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/**
 * Step definitions for `scenarios/jev_search_relevance.feature`. The selection, the none-relevant
 * option, the floor and the refusal ledger are all driven through the production `searchRelevance`;
 * the non-authority scenario additionally runs the production controller so its admission and
 * diagnostic recording are observed rather than described.
 */

const { given, when, then } = scoped("jev_search_relevance.feature");

interface Candidate {
	title: string;
	evidence: string;
	reason: string;
}

interface SearchWorld {
	state: JevState;
	table: Record<string, FakeAnswerSource>;
	calls: number;
	callStates: unknown[];
	params?: Record<string, unknown>;
	candidates?: Candidate[];
	defect?: string;
	expectedField?: string;
	outcome?: ToolOutcome;
	priorText?: string;
	result?: unknown;
	selection?: Record<string, unknown>;
	selectionNotChecked?: number;
	pi?: FakePi;
	ctx?: unknown;
	block?: string;
	context?: unknown;
}

const world = (value: unknown): SearchWorld => value as SearchWorld;

function setup(value: unknown): SearchWorld {
	const w = world(value);
	if (w.state === undefined) {
		w.state = freshState();
		w.table = {};
		w.calls = 0;
		w.callStates = [];
	}
	return w;
}

async function run(w: SearchWorld): Promise<ToolOutcome> {
	const fake = answeringJudge(w.table);
	w.outcome = await searchRelevance(
		{ judge: fake.judge, config: boundaryConfig() },
		w.state,
		w.params ?? {},
	);
	w.calls += fake.calls.length;
	w.callStates.push(...fake.calls.map(call => call.state));
	return w.outcome;
}

function twoCandidates(): Candidate[] {
	return [
		{ title: "Generic uptime blog", evidence: "a post that mentions nodes once", reason: "it mentions nodes" },
		{ title: "Failure playbook", evidence: "the runbook for reporting node loss", reason: "it describes exactly this report step" },
	];
}

function validParams(): Record<string, unknown> {
	return { query: "how to report node failure", candidates: twoCandidates() };
}

// Background ---------------------------------------------------------------

given("ordinary Jev diagnostics are enabled", value => {
	// The shipped config is the ordinary diagnostic mode; the state below is that mode's fresh state.
	setup(value);
});

// Scenario 1 -----------------------------------------------------------------

given("two candidates each carry an exact evidence excerpt and a submitted reason", value => {
	const w = setup(value);
	w.params = validParams();
	w.candidates = twoCandidates();
	w.table.candidate = { label: "candidate_2", confidence: POLICY.minConfidenceToApprove };
});

when("the judge selects the second candidate at the confidence floor", async value => {
	await run(world(value));
});

then("the result identifies only the second submitted candidate", value => {
	const w = world(value);
	const selected = w.candidates?.[1];
	expect(w.outcome?.ok).toBe(true);
	expect(w.outcome?.details?.["title"]).toBe(selected?.title);
	expect(w.outcome?.text).toContain(selected?.title ?? "");
	expect(w.outcome?.text).not.toContain(w.candidates?.[0]?.title ?? "");
});

then("the returned reason is byte-identical to the executor's second reason", value => {
	const w = world(value);
	const submitted = w.candidates?.[1]?.reason ?? "";
	expect(w.outcome?.details?.["reason"]).toBe(submitted);
	expect(w.outcome?.text.endsWith(submitted)).toBe(true);
});

then("no judge-authored explanation is added", value => {
	const w = world(value);
	expect(Object.keys(w.outcome?.details ?? {}).sort()).toEqual(["confidence", "evidence", "reason", "title"]);
	// The text ends with the executor's own reason: nothing follows it.
	expect(w.outcome?.text.endsWith(`the submitted reason was: ${w.candidates?.[1]?.reason ?? ""}`)).toBe(true);
});

// Scenario 2 (outline) -------------------------------------------------------

given("the submission has {string}", (value, defect) => {
	const w = setup(value);
	w.defect = defect;
	w.params =
		defect === "fewer than two candidates"
			? { query: "how to report node failure", candidates: [{ title: "only one", evidence: "an excerpt", reason: "a reason" }] }
			: defect === "a candidate without evidence"
				? { query: "how to report node failure", candidates: [{ title: "one", evidence: "an excerpt", reason: "a reason" }, { title: "two", reason: "another reason" }] }
				: defect === "a candidate without a submitted reason"
					? { query: "how to report node failure", candidates: [{ title: "one", evidence: "an excerpt", reason: "a reason" }, { title: "two", evidence: "another excerpt" }] }
					: { query: "   ", candidates: twoCandidates() };
	w.expectedField =
		defect === "fewer than two candidates"
			? "candidates"
			: defect === "an empty query"
				? "query"
				: defect === "a candidate without evidence"
					? "evidence"
					: "reason";
});

when("the tool validates the candidates", async value => {
	await run(world(value));
});

then("no judge request is made", value => {
	expect(world(value).calls).toBe(0);
});

then("the result names the invalid candidate field", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text.toLowerCase()).toContain(w.expectedField ?? "");
});

then("no selection is recorded", value => {
	const w = world(value);
	expect(w.outcome?.details?.["selected"]).toBeUndefined();
	expect(w.state.submissions).toEqual([]);
});

// Scenario 3 -----------------------------------------------------------------

given("the judge decides at the floor that no submitted candidate answers the query", value => {
	const w = setup(value);
	w.params = validParams();
	w.candidates = twoCandidates();
	w.table.candidate = { label: "none_relevant", confidence: POLICY.minConfidenceToApprove };
});

when("the result is returned", async value => {
	await run(world(value));
});

then("no candidate is selected", value => {
	const w = world(value);
	const details: Record<string, unknown> = w.outcome?.details ?? {};
	expect(details["selected"] ?? null).toBeNull();
	expect(details["title"]).toBeUndefined();
	expect(details["approved"]).not.toBe(true);
});

then("the result directs the executor to search again with better evidence", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("re-search");
	expect(w.outcome?.text).toContain("evidence");
});

then("no unrelated candidate is substituted", value => {
	const w = world(value);
	expect(w.outcome?.details?.["title"]).toBeUndefined();
	for (const candidate of w.candidates ?? []) expect(w.outcome?.text).not.toContain(candidate.title);
});

// Scenario 4 (outline) -------------------------------------------------------

given("the judge selects {string} below the confidence floor", (value, selection) => {
	const w = setup(value);
	w.params = validParams();
	w.candidates = twoCandidates();
	w.table.candidate = {
		label: selection === "one candidate" ? "candidate_1" : "none_relevant",
		confidence: POLICY.minConfidenceToApprove - 0.1,
	};
});

when("the result is classified", async value => {
	await run(world(value));
});

then("no candidate is treated as selected", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.details?.["selected"] ?? null).toBeNull();
	expect(w.outcome?.details?.["approved"]).toBe(false);
});

then("the result is inconclusive rather than a defect in a candidate", value => {
	const w = world(value);
	expect(w.outcome?.details?.["kind"]).toBe("unclear");
	expect(w.outcome?.text).toContain("Class: inconclusive");
	expect(w.outcome?.text).not.toContain("Class: defect");
});

then("a new judgment requires changed candidates or excerpts", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("change the material");
	expect(w.outcome?.text).toContain("the same material is refused without another judge call");
});

// Scenario 5 -----------------------------------------------------------------

given("a candidate was selected for the current query", async value => {
	const w = setup(value);
	w.params = validParams();
	w.candidates = twoCandidates();
	w.table.candidate = { label: "candidate_1", confidence: 0.9 };
	const fake = answeringJudge(w.table);
	const pi = fakePi();
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const ctx = fakeCtx({ sessionId: "search-session" });
	await pi.emit("before_agent_start", { prompt: "Report the coverage of the last run", systemPrompt: [] }, ctx);
	w.result = await pi.callTool("jev_search_relevance", { query: w.params["query"], candidates: w.candidates }, ctx);
	w.selection = toolDetails(w.result);
	w.selectionNotChecked = (w.selection["diagnostics"] as { work?: { not_checked?: number } } | undefined)?.work?.not_checked;
	w.calls += fake.calls.length;
	expect(w.selection["title"]).toBe(twoCandidates()[0]?.title);
	w.pi = pi;
	w.ctx = ctx;
});

when("the executor opens or cites that source", async value => {
	const w = world(value);
	expect(w.pi).toBeDefined();
	expect(w.ctx).toBeDefined();
	const input = { path: "docs/research-notes.md", content: `Source: ${String(w.selection?.["title"] ?? "")}` };
	w.block = blockReason(await w.pi!.emit("tool_call", toolCallEvent("write", input), w.ctx));
	await w.pi!.emit("tool_result", toolResultEvent("write", input, "written"), w.ctx);
	w.context = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
});

then("the selection does not itself authorize a project change or publication", value => {
	const w = world(value);
	expect(w.selection?.["approved"]).toBeUndefined();
	expect(toolText(w.result)).not.toMatch(/authoriz|permission/i);
	expect(w.selection?.["title"]).toBe(twoCandidates()[0]?.title);
});

then("host permissions and the current task remain authoritative", value => {
	const w = world(value);
	expect(w.block).toBeUndefined();
	expect(toolText(w.context)).toContain("Current objective: Report the coverage of the last run");
	// The write that cited the source moved the revision; the selection itself did not.
	expect(toolDetails(w.context)["revision"]).toBe(1);
});

then("any action diagnostic is recorded separately", value => {
	const w = world(value);
	const after = (toolDetails(w.context)["diagnostics"] as { work?: { not_checked?: number } } | undefined)?.work?.not_checked;
	expect(w.selectionNotChecked).toBe(0);
	expect(after).toBeGreaterThanOrEqual(1);
	expect(toolText(w.context)).toContain("not checked");
});

// Scenario 6 -----------------------------------------------------------------

given("a valid search-relevance submission", value => {
	const w = setup(value);
	w.params = validParams();
	w.candidates = twoCandidates();
});

when("the judge is unavailable", async value => {
	const w = setup(value);
	w.outcome = await searchRelevance(
		{ judge: failingJudge("socket reset", "unavailable"), config: boundaryConfig() },
		w.state,
		w.params ?? {},
	);
});

then("the result states that no judgment exists", value => {
	expect(world(value).outcome?.text).toContain("No judge decision exists");
});

then("the executor may continue independent work", value => {
	const w = world(value);
	expect(w.state.hold).toBeUndefined();
	expect(w.state.submissions).toEqual([]);
	expect(w.outcome?.text).toContain("An outage is not a defect and releases nothing.");
	expect(w.outcome?.text.toLowerCase()).not.toContain("block");
});

// Scenario 7 -----------------------------------------------------------------

given("the same query and candidates were already judged", async value => {
	const w = setup(value);
	w.params = validParams();
	w.candidates = twoCandidates();
	w.table.candidate = { label: "candidate_1", confidence: POLICY.minConfidenceToApprove - 0.3 };
	await run(w);
	expect(w.calls).toBe(1);
	expect(w.state.submissions).toHaveLength(1);
	w.priorText = w.outcome?.text;
});

when("the executor resubmits them unchanged", async value => {
	await run(world(value));
});

then("no additional judge request is made", value => {
	expect(world(value).calls).toBe(1);
});

then("the prior result is returned as the recorded answer", value => {
	const w = world(value);
	// The ledger returns the recorded refusal rather than re-emitting the first result object: the
	// previously recorded finding is what is reported, and it is the same refusal.
	expect(w.priorText).toContain("below the 0.6 reliability floor");
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text).toContain("already judged and refused");
	expect(w.outcome?.text).toContain("the finding stands as a diagnostic record");
	expect(w.state.submissions).toHaveLength(1);
});

then("the attempt count creates no permission", value => {
	const w = world(value);
	expect(w.outcome?.details?.["approved"]).not.toBe(true);
	expect(w.outcome?.text).toContain("which is informational and changes no decision");
	expect(w.state.exhausted).toEqual([]);
});
