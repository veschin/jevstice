import { expect, test } from "bun:test";
import { createJevController } from "../src/controller.js";
import { answeringJudge, boundaryConfig, cleanProtocolAnswers, fakeCtx, fakePi, fakeZod, failingJudge, stopEvent, toolDetails, toolResultEvent, toolText } from "./helpers.js";
import { asRecord } from "../src/types.js";

const request = "Research whether this greenhouse trial establishes year-round water savings.";
const source = "trial/config.txt";
const excerpt = "valve_profile=cedar";
const artifact = "A Cedar valve was installed.\n\nThe greenhouse roof is green.";
const params = {
	artifact,
	claims: [
		{ quote: "A Cedar valve was installed.", statement: "The greenhouse trial physically installed a Cedar valve.", evidence: [{ source, quote: excerpt }] },
		{ quote: "The greenhouse roof is green.", statement: "The greenhouse roof is green.", evidence: [] },
	],
};
const start = async (prompt: string, judge = failingJudge("offline")) => {
	const pi = fakePi();
	const ctx = fakeCtx();
	createJevController({ judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const promptResult = await pi.emit("before_agent_start", { reason: "prompt", prompt, systemPrompt: [] }, ctx);
	return { pi, ctx, promptResult };
};

test("observed forwarded search requires exactly one continuation when the model skips fact-checking", async () => {
	const { pi, ctx } = await start("Summarize the results.");
	await pi.emit("tool_result", { ...toolResultEvent("write", {}, "results") as object, details: { xdev: { tool: "web_search", args: { query: "trial" } } } }, ctx);
	const context = await pi.emit("context", { messages: [] }, ctx);
	expect(JSON.stringify(context)).toContain("jev_fact_check");
	expect(await pi.emit("session_stop", stopEvent(), ctx)).toEqual([{ continue: true, additionalContext: expect.stringContaining("jev_fact_check") }]);
	expect(await pi.emit("session_stop", stopEvent(), ctx)).toEqual([undefined]);
	expect(pi.messages.some(message => message.content.includes("not checked"))).toBe(true);
});

test("a local read for ordinary coding does not require research review; an explicit request does", async () => {
	const { pi, ctx } = await start("Read the project settings.");
	await pi.emit("tool_result", toolResultEvent("read", { path: source }, excerpt), ctx);
	expect(await pi.emit("session_stop", stopEvent(), ctx)).toEqual([undefined]);
	const explicit = await start("Проверь факты в приложенном тексте.");
	expect(JSON.stringify(explicit.promptResult)).toContain("jev_fact_check");
});

test("review independently reports evidence scope, irrelevant material and a goal gap", async () => {
	const judge = answeringJudge({
		coverage: { label: "complete" }, objective: { label: "proxy" },
		fact_0: { label: "scope_error" }, fact_1: { label: "supported" },
		relevance_0: { label: "relevant" }, relevance_1: { label: "extraneous" },
		section_0: { label: "relevant" }, section_1: { label: "extraneous" },
	});
	const { pi, ctx } = await start(request, judge.judge);
	await pi.emit("tool_result", toolResultEvent("read", { path: source }, excerpt), ctx);
	const result = await pi.callTool("jev_fact_check", params, ctx);
	expect(toolDetails(result)["claims"]).toMatchObject([{ verdict: "scope_error" }, { verdict: "undecidable", relevance: "extraneous" }]);
	expect(toolDetails(result)["sections"]).toMatchObject([{ relevance: "relevant" }, { relevance: "extraneous" }]);
	expect(toolText(result)).toContain(request);
	expect(toolText(result)).toContain(excerpt);
	expect(toolText(result)).toContain("proxy");
	expect(await pi.emit("session_stop", stopEvent(), ctx)).toEqual([undefined]);
});

test("native follow-up preserves the original question and multiline read evidence", async () => {
	const judge = answeringJudge({
		coverage: { label: "complete" }, objective: { label: "answered" },
		fact_0: { label: "supported" }, relevance_0: { label: "relevant" },
		section_0: { label: "relevant" },
	});
	const { pi, ctx } = await start(request, judge.judge);
	const quote = "Cedar valve installed.\nTested in June only.";
	await pi.emit("tool_result", {
		...toolResultEvent("read", { path: source }, "[trial/config.txt#1234]\n1:Cedar valve installed.\n2:Tested in June only.") as object,
		details: { displayContent: { text: quote, lineNumbers: [1, 2] } },
	}, ctx);
	const [continuation] = await pi.emit("session_stop", stopEvent(), ctx) as { additionalContext: string }[];
	await pi.emit("before_agent_start", { reason: "prompt", prompt: continuation!.additionalContext, systemPrompt: [] }, ctx);
	const result = await pi.callTool("jev_fact_check", {
		artifact: params.claims[0]!.quote,
		claims: [{ ...params.claims[0], evidence: [{ source, quote }] }],
	}, ctx);
	expect(toolDetails(result)["claims"]).toMatchObject([{ verdict: "supported" }]);
	expect(toolText(result)).toContain(request);
});

test("fact-check sources survive a continuation, not an unrelated objective", async () => {
	const judge = answeringJudge({
		coverage: { label: "complete" }, objective: { label: "answered" },
		fact_0: { label: "supported" }, relevance_0: { label: "relevant" }, section_0: { label: "relevant" },
	});
	const { pi, ctx } = await start(request, judge.judge);
	const draft = params.claims[0]!;
	await pi.emit("tool_result", toolResultEvent("read", { path: source }, excerpt), ctx);
	const verify = () => pi.callTool("jev_fact_check", { artifact: draft.quote, claims: [draft] }, ctx).then(toolDetails);
	expect((await verify())["claims"]).toMatchObject([{ verdict: "supported" }]);
	await pi.emit("before_agent_start", { reason: "prompt", prompt: "Continue the same fact-check." }, ctx);
	expect((await verify())["claims"]).toMatchObject([{ verdict: "supported" }]);
	await pi.emit("before_agent_start", { reason: "prompt", prompt: "Research a separate greenhouse trial." }, ctx);
	expect((await verify())["claims"]).toMatchObject([{ verdict: "unverified_excerpt" }]);
});

test("anti-slop consumes the same draft's unresolved fact instead of trusting the submitted source label", async () => {
	const judge = answeringJudge({
		coverage: { label: "complete" }, objective: { label: "answered" },
		fact_0: { label: "supported" }, relevance_0: { label: "relevant" }, section_0: { label: "relevant" },
		...cleanProtocolAnswers(), language_1: { probability: 0.01 }, meta_1: { probability: 0.01 },
		relevance_1: { label: "serves" }, claim_1: { label: "supported" },
	});
	const { pi, ctx } = await start("Review and publish the report.", judge.judge);
	const artifact = "The report counted one record.";
	const ref = { source, quote: "Total records: one." };
	await pi.emit("tool_result", toolResultEvent("read", { path: source }, "Total records: two."), ctx);
	const fact = toolDetails(await pi.callTool("jev_fact_check", {
		artifact, claims: [{ quote: artifact, statement: artifact, evidence: [ref] }],
	}, ctx));
	expect(fact["claims"]).toMatchObject([{ verdict: "unverified_excerpt" }]);
	const review = toolDetails(await pi.callTool("jev_anti_slop", {
		artifact, language: "English", register: "plain", purpose: "report the count", audience: "readers", rules: [],
		claims: [{ id: "count", text: artifact, kind: "fact", evidence: [{ ...ref, kind: "documentation", sourceClass: "official" }] }],
	}, ctx));
	expect(review).toMatchObject({ kind: "unclear", claims: [{ trust: "unverified", verdict: "unverified_excerpt" }] });
	expect(judge.calls.at(-1)?.questions.map(question => question.name)).not.toContain("claim_1");
	const saved = toolDetails(await pi.callTool("jev_context", { action: "result", sourceId: review["resultId"] }, ctx));
	expect(saved["result"]).toMatchObject({ prior: [fact["resultId"]], applicability: "current" });
	await pi.emit("tool_result", toolResultEvent("read", { path: source }, ref.quote), ctx);
	const stale = toolDetails(await pi.callTool("jev_context", { action: "result", sourceId: review["resultId"] }, ctx));
	expect(stale["result"]).toMatchObject({ applicability: "historical" });
});

test("an excerpt invented for an observed source is not support; omitted claims are not covered", async () => {
	const judge = answeringJudge({
		coverage: { label: "incomplete" }, objective: { label: "answered" },
		fact_0: { label: "supported" }, relevance_0: { label: "relevant" },
		section_0: { label: "relevant" }, section_1: { label: "relevant" },
	});
	const { pi, ctx } = await start(request, judge.judge);
	await pi.emit("tool_result", toolResultEvent("read", { path: source }, excerpt), ctx);
	const result = await pi.callTool("jev_fact_check", { ...params, claims: [
		{ ...params.claims[0], evidence: [{ source, quote: "Installed a Cedar valve." }] },
	] }, ctx);
	expect(toolDetails(result)["coverage"]).toBe("incomplete");
	expect(toolDetails(result)["claims"]).toMatchObject([{
		verdict: "unverified_excerpt", nextAction: "reopen_source", evidence: [{ verified: false }],
	}]);
	expect(toolText(result)).toContain("Reopen");
});

test("judge outage remains unavailable and does not request a second attempt", async () => {
	const { pi, ctx } = await start(request);
	const result = await pi.callTool("jev_fact_check", params, ctx);
	expect(toolDetails(result)["kind"]).toBe("unavailable");
	expect(toolDetails(result)["artifactDigest"]).toMatch(/^[a-f0-9]{64}$/);
	expect(await pi.emit("session_stop", stopEvent(), ctx)).toEqual([undefined]);
});

const tableSource = "https://arxiv.org/pdf/2611.02155#page=10";
const tableRow = "|Jev 1.14|89.3 2.49|86.8 30.6|3.1|98.2 0.83|97.4 4.8|1.3 120|151 0.46|";
const tableHeadings = "||Def., single preamble|||Opus examples||Latency (ms)||\n|---|---|---|---|---|---|---|---|---|---|\n|Model|Recall FPR|J Intr.|Miss Recall|FPR|J Intr.|Miss p50|p95 $/1k|";
const tableCaption = "Def.: definitions alone with the single shared preamble; Opus: definitions with Opus-authored examples. Recall, FPR, Intr. and Miss are percentages;";

test.each([
	{ label: "unlabeled row", recall: "98.2%", excerpts: [tableRow], answer: "insufficient_context", confidence: 0.97, verdict: "insufficient_context", nextAction: "add_context", guidance: "headings" },
	{ label: "complete evidence", recall: "98.2%", excerpts: [tableRow, tableHeadings, tableCaption], answer: "supported", confidence: 0.97, verdict: "supported", nextAction: "keep", guidance: "supported" },
	{ label: "value from the wrong condition", recall: "89.3%", excerpts: [tableRow, tableHeadings, tableCaption], answer: "contradicted", confidence: 0.97, verdict: "contradicted", nextAction: "correct_claim", guidance: "Correct or remove" },
	{ label: "low confidence with verified context", recall: "98.2%", excerpts: [tableRow, tableHeadings, tableCaption], answer: "supported", confidence: 0.55, verdict: "unclear", nextAction: "leave_unresolved", guidance: "confidence" },
])("fact-check gives a distinct action for $label", async scenario => {
	const judge = answeringJudge({
		coverage: { label: "complete" }, objective: { label: "answered" },
		fact_0: { label: scenario.answer, confidence: scenario.confidence },
		relevance_0: { label: "relevant" }, section_0: { label: "relevant" },
	});
	const { pi, ctx } = await start("Fact-check the claimed recall under the Opus condition in Table 3.", judge.judge);
	await pi.emit("tool_result", toolResultEvent("read", { path: tableSource }, [tableHeadings, tableRow, tableCaption].join("\n")), ctx);
	const statement = `Under the Opus condition in Table 3, Jev 1.14 achieved ${scenario.recall} recall.`;
	const evidence = scenario.excerpts.map(quote => ({ source: tableSource, quote }));
	const result = await pi.callTool("jev_fact_check", { artifact: statement, claims: [{ quote: statement, statement, evidence }] }, ctx);
	expect(toolDetails(result)["claims"]).toMatchObject([{
		verdict: scenario.verdict, nextAction: scenario.nextAction,
		evidence: evidence.map(ref => ({ ...ref, verified: true })),
	}]);
	expect(toolText(result)).toContain(scenario.guidance);
	const submitted = asRecord(judge.calls[0]?.state)?.["claims"];
	expect(submitted).toMatchObject([{ statement, evidence }]);
});
