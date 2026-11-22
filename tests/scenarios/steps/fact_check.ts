import { expect } from "bun:test";
import { createJevController } from "../../../src/controller.js";
import type { JudgeQuestion } from "../../../src/judge.js";
import { sha256 } from "../../../src/state.js";
import { POLICY } from "../../../src/types.js";
import { answeringJudge, boundaryConfig, fakeCtx, fakePi, fakeZod, toolDetails, toolResultEvent, toolText } from "../../helpers.js";
import { scoped } from "../registry.js";

const { given, when, then } = scoped("jev_fact_check.feature");
const source = "benchmark/table.md";
const headings = "| Model | Baseline recall | Recall with flag enabled |";
const row = "| Cedar | 70 | 85 |";
const caption = "Recall is measured in percent; the baseline has the flag disabled.";
const objective = "Fact-check Cedar's recall with the benchmark flag enabled.";

type Evidence = { source: string; quote: string };
interface World {
	statement: string;
	readReceipt: unknown;
	judgeCalls: { state: unknown; questions: readonly JudgeQuestion[] }[];
	result: unknown;
}

const allExcerpts = () => [headings, row, caption].map(quote => ({ source, quote }));

async function check(
	world: World, value: string, evidence: Evidence[], label: string, confidence: number = POLICY.antiSlopFloor,
): Promise<void> {
	world.statement = `Cedar achieved ${value} recall with the flag enabled.`;
	const fake = answeringJudge({
		coverage: { label: "complete" }, objective: { label: "answered" },
		fact_0: { label, confidence }, relevance_0: { label: "relevant" }, section_0: { label: "relevant" },
	});
	const pi = fakePi();
	world.judgeCalls = fake.calls;
	const ctx = fakeCtx();
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	await pi.emit("before_agent_start", { reason: "prompt", prompt: objective, systemPrompt: [] }, ctx);
	await pi.emit("tool_result", world.readReceipt, ctx);
	world.result = await pi.callTool("jev_fact_check", {
		artifact: world.statement,
		claims: [{ quote: world.statement, statement: world.statement, evidence }],
	}, ctx);
}

given("an opened benchmark table reports 70% baseline recall and 85% recall with the flag enabled", value => {
	(value as World).readReceipt = toolResultEvent("read", { path: source }, `${headings}\n${row}\n${caption}`);
});

when("the draft claims {word} recall with the flag enabled and cites the row, headings and caption", (value, recall) =>
	check(value as World, recall, allExcerpts(), recall === "85%" ? "supported" : "contradicted"));

when("the draft claims 85% recall with the flag enabled and cites only the table row", value =>
	check(value as World, "85%", [{ source, quote: row }], "insufficient_context"));

when("the draft claims 85% recall with the flag enabled and submits {string}", (value, scenario) => {
	const evidence: Record<string, Evidence[]> = {
		"no excerpts": [],
		"excerpts from an unopened source": [{ source: "benchmark/unopened.md", quote: row }],
		"a fabricated quote from the table": [{ source, quote: "| Cedar | 70 | 90 |" }],
	};
	const refs = evidence[scenario];
	if (refs === undefined) throw new Error(`Unknown evidence example: ${scenario}`);
	return check(value as World, "85%", refs, "supported");
});

when("complete excerpts accompany a claim of 85% recall but the judge is below the confidence floor", value =>
	check(value as World, "85%", allExcerpts(), "supported", POLICY.antiSlopFloor - 0.01));

then("the review marks the claim supported and recommends keeping it", value => {
	expect(toolDetails((value as World).result)).toMatchObject({
		kind: "reviewed", hasUnverified: false,
		claims: [{ verdict: "supported", nextAction: "keep", evidence: allExcerpts().map(ref => ({ ...ref, verified: true })) }],
	});
});

then("the review is limited to the submitted draft, not publication approval", value => {
	const { result, statement } = value as World;
	const details = toolDetails(result);
	expect(details["artifactDigest"]).toBe(sha256(statement));
	expect(details).not.toHaveProperty("approved");
	expect(toolText(result)).toContain("This review applies only to the submitted draft.");
	expect(toolText(result)).not.toMatch(/approv|authoriz|publish/iu);
});

then("the review marks the claim contradicted and recommends correcting or removing it", value => {
	const { result } = value as World;
	expect(toolDetails(result)).toMatchObject({ kind: "defect", claims: [{ verdict: "contradicted", nextAction: "correct_claim" }] });
	expect(toolText(result)).toContain("Correct or remove the assertion");
});

then("the judge receives the exact claim and must match its comparison condition", value => {
	const { judgeCalls, statement } = value as World;
	const call = judgeCalls.at(-1);
	const question = call?.questions.find(item => item.name === "fact_0");
	expect(call?.state).toMatchObject({ artifact: statement, ownerRequest: objective, claims: [{ statement, evidence: allExcerpts() }] });
	expect(question?.instructions).toContain(JSON.stringify(statement));
	expect(question?.instructions).toContain("Match entity, metric, comparison condition and unit");
	expect(question?.options?.["supported"]).toContain("A matching value in another condition does not count.");
});

then("the review marks the excerpt verified but asks for the missing table context", value => {
	const { result } = value as World;
	expect(toolDetails(result)).toMatchObject({
		kind: "unclear", hasUnverified: true,
		claims: [{ verdict: "insufficient_context", nextAction: "add_context", evidence: [{ source, quote: row, verified: true }] }],
	});
	expect(toolText(result)).toContain("headings, units, conditions and caption");
});

then("the review reports {string} and recommends {string} despite a supportive judge answer", (value, verdict, action) => {
	const { result, judgeCalls } = value as World;
	const details = toolDetails(result);
	expect(details).toMatchObject({ kind: "unclear", hasUnverified: true, claims: [{ verdict, nextAction: action }] });
	const claims = details["claims"] as { evidence: unknown[] }[];
	const evidence = claims[0]?.evidence;
	expect(evidence).toEqual(verdict === "undecidable" ? [] : [expect.objectContaining({ verified: false })]);
	expect(judgeCalls.at(-1)?.state).toMatchObject({ claims: [{ evidence: [] }] });
});

then("the claim stays unresolved despite its verified excerpts", value => {
	const { result } = value as World;
	expect(toolDetails(result)).toMatchObject({
		kind: "unclear", hasUnverified: true,
		claims: [{ verdict: "unclear", nextAction: "leave_unresolved", evidence: allExcerpts().map(ref => ({ ...ref, verified: true })) }],
	});
	expect(toolText(result)).toContain("did not meet the confidence floor");
});
