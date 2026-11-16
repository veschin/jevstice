import { expect } from "bun:test";
import { textReview } from "../../../src/activities.js";
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
	toolFailed,
	toolResultEvent,
	toolText,
	type FakeAnswerSource,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/**
 * Step definitions for `scenarios/jev_text_review.feature`. Every scope, violation, unsettled check
 * and refusal is driven through the production `textReview`; the correction scenario runs the
 * production controller so the recorded finding and the unblocked next action are observed.
 */

const { given, when, then } = scoped("jev_text_review.feature");

interface TextRule {
	class: string;
	rule: string;
	scope?: string;
}

interface TextWorld {
	state: JevState;
	table: Record<string, FakeAnswerSource>;
	calls: number;
	callStates: unknown[];
	questionSets: string[][];
	params?: Record<string, unknown>;
	scope?: string;
	body?: string;
	rule?: string;
	prose?: string[];
	outcome?: ToolOutcome;
	outcomes?: ToolOutcome[];
	result?: unknown;
	details?: Record<string, unknown>;
	text?: string;
	hold?: Record<string, unknown>;
	pi?: FakePi;
	ctx?: unknown;
	block?: string;
	context?: unknown;
	violate?: boolean;
	expectedField?: string;
}

const world = (value: unknown): TextWorld => value as TextWorld;

function setup(value: unknown): TextWorld {
	const w = world(value);
	if (w.state === undefined) {
		w.state = freshState();
		w.table = {};
		w.calls = 0;
		w.callStates = [];
		w.questionSets = [];
	}
	return w;
}

async function run(w: TextWorld): Promise<ToolOutcome> {
	const fake = answeringJudge(w.table);
	w.outcome = await textReview({ judge: fake.judge, config: boundaryConfig() }, w.state, w.params ?? {});
	w.calls += fake.calls.length;
	w.callStates.push(...fake.calls.map(call => call.state));
	w.questionSets.push(...fake.calls.map(call => call.questions.map(question => question.name)));
	return w.outcome;
}

const STRUCTURED_TEXT = [
	"## Section",
	"",
	"First prose paragraph with a claim.",
	"",
	"| Column | Value |",
	"|---|---|",
	"| A | 1 |",
	"",
	"```text",
	"example code line",
	"```",
	"",
	"Second prose paragraph with another claim.",
].join("\n");

const STRUCTURED_PROSE = ["First prose paragraph with a claim.", "Second prose paragraph with another claim."];

// Background ---------------------------------------------------------------

given("ordinary Jev diagnostics are enabled", value => {
	// The shipped config is the ordinary diagnostic mode; the state below is that mode's fresh state.
	setup(value);
});

// Scenario 1 (outline) -------------------------------------------------------

given("the exact text contains a heading, a pipe table, fenced code and two prose paragraphs", value => {
	const w = setup(value);
	w.body = STRUCTURED_TEXT;
	w.prose = STRUCTURED_PROSE;
	expect(w.body).toContain("## Section");
	expect(w.body).toContain("| Column | Value |");
	expect(w.body).toContain("```text");
});

given("one submitted rule has scope {string}", (value, scope) => {
	const w = setup(value);
	w.scope = scope;
	const rule: TextRule = { class: "register", rule: "Пишите простыми словами." };
	if (scope === "text") rule.scope = "text";
	if (scope === "fragment") rule.scope = "fragment";
	w.params = { text: w.body, rules: [rule] };
	if (scope === "fragment") {
		w.table.fragment_1_1 = { probability: 0.05 };
		w.table.fragment_2_1 = { probability: 0.05 };
	} else {
		w.table.text_rule_1 = { probability: 0.05 };
	}
});

when("the text review runs", async value => {
	await run(world(value));
});

then("a {string} rule is applied to {string}", (value, submitted, target) => {
	const w = world(value);
	const material = w.callStates[0] as Record<string, unknown> | undefined;
	const expectedTarget = submitted === "fragment" ? "each canonical prose fragment" : "the complete exact text once";
	const expectedQuestions = submitted === "fragment" ? ["fragment_1_1", "fragment_2_1"] : ["text_rule_1"];
	const appliedScope = w.scope;
	if (appliedScope === undefined) throw new Error("the submitted rule scope was not recorded");
	expect(submitted).toBe(appliedScope);
	expect(target).toBe(expectedTarget);
	expect(w.outcome?.ok).toBe(true);
	expect(material?.["text"]).toBe(w.body);
	expect(material?.["fragments"]).toEqual(STRUCTURED_PROSE);
	expect(w.questionSets[0]).toEqual(expectedQuestions);
});

then("headings, tables and fenced code are never substituted for prose fragments", value => {
	const w = world(value);
	const call = w.callStates[0] as Record<string, unknown> | undefined;
	expect(call?.["fragments"]).toEqual(STRUCTURED_PROSE);
	for (const fragment of STRUCTURED_PROSE) {
		expect(String(fragment).startsWith("#")).toBe(false);
		expect(String(fragment).startsWith("|")).toBe(false);
		expect(String(fragment)).not.toContain("```");
	}
	expect(JSON.stringify(call?.["fragments"])).not.toContain("example code line");
});

// Scenario 2 -----------------------------------------------------------------

given("the judge establishes that one prose fragment violates a submitted rule", value => {
	const w = setup(value);
	w.body = "Мы осуществили оптимизацию пайплайна.";
	w.prose = [w.body];
	w.rule = "Жаргон в прозе не употребляется.";
	w.params = { text: w.body, rules: [{ class: "jargon", rule: w.rule, scope: "fragment" }] };
	w.table.fragment_1_1 = { probability: 0.93 };
});

when("the result is returned", async value => {
	await run(world(value));
});

then("the result names the violating fragment", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text).toContain(w.body ?? "");
	expect((w.outcome?.details?.["defects"] as Array<Record<string, unknown>> | undefined)?.[0]?.["fragment"]).toBe(w.body);
});

then("it reproduces the submitted rule text byte-identically", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain(w.rule ?? "");
	expect((w.outcome?.details?.["defects"] as Array<Record<string, unknown>> | undefined)?.[0]?.["rule"]).toBe(w.rule);
});

then("it adds no rewritten sentence or style advice", value => {
	const w = world(value);
	const defects = w.outcome?.details?.["defects"] as Array<Record<string, unknown>> | undefined;
	expect(defects).toHaveLength(1);
	expect(Object.keys(defects?.[0] ?? {}).sort()).toEqual(["class", "fragment", "rule"]);
	expect(w.outcome?.text).not.toMatch(/advice|suggest|should|rewrit/i);
});

// Scenario 3 -----------------------------------------------------------------

given("a valid text and rule set", value => {
	const w = setup(value);
	w.body = "Отчёт готов к проверке.";
	w.params = {
		text: w.body,
		rules: [
			{ class: "register", rule: "Пишите простыми словами." },
			{ class: "brevity", rule: "Минимум слов, сохраняющих смысл.", scope: "fragment" },
		],
	};
	w.table.text_rule_1 = { probability: 0.05 };
	w.table.fragment_1_2 = { probability: 0.05 };
});

when("every rule check is decisively satisfied", async value => {
	await run(world(value));
});

then("the result reports no violation for those rules", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(true);
	expect(w.outcome?.details?.["approved"]).toBe(true);
	expect(w.outcome?.details?.["defects"]).toEqual([]);
	expect(w.outcome?.text).toContain("no violation of the 2 submitted rules");
});

then("it does not claim general quality, truth or approval to publish", value => {
	const w = world(value);
	expect(w.outcome?.text).not.toMatch(/quality|truth|publish|approv/i);
});

// Scenario 4 -----------------------------------------------------------------

given("one fragment/rule answer stays between the decision floors", value => {
	const w = setup(value);
	const first = "Первый абзац с проблемой.";
	const second = "Второй абзац с нарушением.";
	w.body = `${first}\n\n${second}`;
	w.prose = [first, second];
	w.params = {
		text: w.body,
		rules: [
			{ class: "jargon", rule: "Жаргон в прозе не употребляется.", scope: "fragment" },
			{ class: "brevity", rule: "Минимум слов, сохраняющих смысл.", scope: "fragment" },
		],
	};
	w.table.fragment_1_1 = { probability: 0.5 };
	w.table.fragment_2_1 = { probability: 0.05 };
	w.table.fragment_1_2 = { probability: 0.05 };
	w.table.fragment_2_2 = { probability: 0.9 };
});

then("the result lists that unsettled fragment and rule", value => {
	const w = world(value);
	const unsettled = w.outcome?.details?.["unsettled"] as Array<Record<string, unknown>> | undefined;
	expect(w.outcome?.details?.["kind"]).toBe("unclear");
	expect(unsettled).toHaveLength(1);
	expect(unsettled?.[0]?.["fragment"]).toBe(w.prose?.[0]);
	const unsettledRule = unsettled?.[0]?.["rule"] as { class?: string; rule?: string } | undefined;
	expect(unsettledRule?.class).toBe("jargon");
	expect(unsettledRule?.rule).toBe("Жаргон в прозе не употребляется.");
	expect(w.outcome?.text).toContain(w.prose?.[0] ?? "");
	expect(w.outcome?.text).toContain("unsettled against [jargon]");
});

then("any separately established violations are listed as defects", value => {
	const w = world(value);
	const defects = w.outcome?.details?.["defects"] as Array<Record<string, unknown>> | undefined;
	expect(defects).toHaveLength(1);
	expect(defects?.[0]?.["fragment"]).toBe(w.prose?.[1]);
	const defectRule = defects?.[0]?.["rule"] as { class?: string; rule?: string } | undefined;
	expect(defectRule?.class).toBe("brevity");
	expect(defectRule?.rule).toBe("Минимум слов, сохраняющих смысл.");
	expect(w.outcome?.text).toContain(w.prose?.[1] ?? "");
	expect(w.outcome?.text).toContain("violates [brevity]");
});

then("the review is not reported as clean", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("no clean review is approved");
	expect(w.outcome?.details?.["approved"]).toBe(false);
});

// Scenario 5 -----------------------------------------------------------------

given("the submitted text has more fragments than the configured review bound", value => {
	const w = setup(value);
	w.body = Array.from({ length: POLICY.maxTextFragments + 1 }, (_, index) => `Абзац номер ${index + 1}.`).join("\n\n");
	w.params = { text: w.body, rules: [{ class: "register", rule: "Пишите простыми словами." }] };
});

when("the tool validates the text", async value => {
	await run(world(value));
});

then("the result asks the executor to split the text", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain(String(POLICY.maxTextFragments));
	expect(w.outcome?.text).toContain("split it");
});

then("no subset is silently approved", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.details?.["kind"]).toBe("invalid");
	expect(w.outcome?.details?.["approved"]).toBe(false);
	expect(w.state.submissions).toEqual([]);
});

// Scenario 6 (outline) -------------------------------------------------------

given("the submission has {string}", (value, defect) => {
	const w = setup(value);
	const rule: TextRule = { class: "register", rule: "Пишите простыми словами." };
	const params =
		defect === "empty text"
			? { text: "   ", rules: [rule] }
			: defect === "an empty rule list"
				? { text: "Отчёт готов.", rules: [] }
				: defect === "a rule without class or text"
					? { text: "Отчёт готов.", rules: [{ rule: "Пишите простыми словами." }] }
					: defect === "an unknown rule scope"
						? { text: "Отчёт готов.", rules: [{ class: "register", rule: "Пишите простыми словами.", scope: "paragraph" }] }
						: { text: "## Section\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```text\nexample\n```", rules: [{ ...rule, scope: "fragment" }] };
	w.params = params;
	w.expectedField =
		defect === "empty text"
			? "text"
			: defect === "an empty rule list"
				? "rules"
				: defect === "a rule without class or text"
					? "class"
					: defect === "an unknown rule scope"
						? "scope"
						: "prose";
});

when("the text review validates it", async value => {
	await run(world(value));
});

then("no judge request is made", value => {
	expect(world(value).calls).toBe(0);
});

then("the result names the invalid field", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text.toLowerCase()).toContain(w.expectedField ?? "");
});

then("no finding is recorded", value => {
	const w = world(value);
	expect(w.outcome?.details?.["kind"]).toBe("invalid");
	expect(w.state.submissions).toEqual([]);
	expect(w.state.hold).toBeUndefined();
});

// Scenario 7 -----------------------------------------------------------------

given("the text review establishes a violation", async value => {
	const w = setup(value);
	w.violate = true;
	w.rule = "Жаргон в прозе не употребляется.";
	w.params = {
		text: "Мы осуществили оптимизацию пайплайна.",
		rules: [{ class: "jargon", rule: w.rule, scope: "fragment" }],
	};
	w.table.fragment_1_1 = () => ({ probability: w.violate === true ? 0.9 : 0.05 });
	const fake = answeringJudge(w.table);
	const pi = fakePi();
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const ctx = fakeCtx({ sessionId: "text-defect-session" });
	w.result = await pi.callTool("jev_text_review", w.params, ctx);
	w.details = toolDetails(w.result);
	w.text = toolText(w.result);
	w.hold = w.details["hold"] as Record<string, unknown> | undefined;
	w.calls += fake.calls.length;
	w.pi = pi;
	w.ctx = ctx;
	expect(w.hold?.["boundary"]).toBe("jev_text_review");
});

when("the executor edits the text or performs another project action", async value => {
	const w = world(value);
	expect(w.pi).toBeDefined();
	expect(w.ctx).toBeDefined();
	const input = { path: "docs/report.md", content: "Правка после замечания." };
	w.block = blockReason(await w.pi!.emit("tool_call", toolCallEvent("write", input), w.ctx));
	await w.pi!.emit("tool_result", toolResultEvent("write", input, "written"), w.ctx);
	w.context = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
});

then("the next action is not refused by the text finding", value => {
	const w = world(value);
	expect(w.block).toBeUndefined();
	expect(toolFailed(w.result)).toBe(false);
});

then("the finding remains recorded as diagnostic evidence", value => {
	const w = world(value);
	expect(w.hold?.["boundary"]).toBe("jev_text_review");
	expect((w.hold?.["result"] as Record<string, unknown> | undefined)?.["kind"]).toBe("defect");
	const contextHold = toolDetails(w.context)["hold"] as Record<string, unknown> | undefined;
	expect(contextHold?.["boundary"]).toBe("jev_text_review");
});

then("the executor may resubmit corrected text at any time", async value => {
	const w = world(value);
	w.violate = false;
	const corrected = { text: "Мы проверили пайплайн.", rules: [{ class: "jargon", rule: w.rule, scope: "fragment" }] };
	const result = await w.pi!.callTool("jev_text_review", corrected, w.ctx);
	expect(toolText(result)).toContain("no violation");
	expect(toolDetails(result)["approved"]).toBe(true);
});

// Scenario 8 -----------------------------------------------------------------

given("a valid text review", value => {
	const w = setup(value);
	w.params = { text: "Отчёт готов.", rules: [{ class: "register", rule: "Пишите простыми словами." }] };
});

when("the judge is unavailable", async value => {
	const w = setup(value);
	w.outcome = await textReview(
		{ judge: failingJudge("socket reset", "unavailable"), config: boundaryConfig() },
		w.state,
		w.params ?? {},
	);
});

then("the result states that no judgment exists", value => {
	expect(world(value).outcome?.text).toContain("No judge decision exists");
});

then("the text is not reported as meeting the rules", value => {
	const w = world(value);
	expect(w.outcome?.details?.["approved"]).toBe(false);
	expect(w.outcome?.details?.["kind"]).toBe("unavailable");
	expect(w.outcome?.text).not.toContain("no violation");
});

then("ordinary work continues", value => {
	const w = world(value);
	expect(w.state.hold).toBeUndefined();
	expect(w.state.submissions).toEqual([]);
	expect(w.outcome?.text).toContain("An outage is not a defect and releases nothing.");
});

// Scenario 9 -----------------------------------------------------------------

given("the identical text and rules were already judged", async value => {
	const w = setup(value);
	w.params = { text: "Мы осуществили оптимизацию пайплайна.", rules: [{ class: "jargon", rule: "Жаргон в прозе не употребляется.", scope: "fragment" }] };
	w.table.fragment_1_1 = { probability: 0.93 };
	await run(w);
	expect(w.calls).toBe(1);
	expect(w.state.submissions).toHaveLength(1);
});

when("the executor resubmits them unchanged", async value => {
	await run(world(value));
});

then("no additional judge request is made", value => {
	expect(world(value).calls).toBe(1);
});

then("the recorded result is returned", value => {
	const w = world(value);
	// The ledger reports the recorded refusal rather than re-emitting the first result object; the
	// prior finding is what the repeated submission receives.
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text).toContain("already judged and refused");
	expect(w.outcome?.text).toContain("the finding stands as a diagnostic record");
	expect(w.state.submissions).toHaveLength(1);
});

then("the repetition grants no approval", value => {
	const w = world(value);
	expect(w.outcome?.details?.["approved"]).not.toBe(true);
	expect(w.outcome?.text).toContain("which is informational and changes no decision");
	expect(w.state.exhausted).toEqual([]);
});
