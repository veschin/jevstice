import { expect } from "bun:test";
import { createJevController } from "../../../src/controller.js";
import type { JudgeQuestion } from "../../../src/judge.js";
import { answeringJudge, boundaryConfig, fakeCtx, fakePi, fakeZod, toolDetails, toolResultEvent, toolText, type FakePi } from "../../helpers.js";
import { scoped } from "../registry.js";

const { given, when, then } = scoped("jev_issue.feature");
const target = { platform: "github", host: "github.example.test", destination: "team/imports" };
const title = "Reimport creates a duplicate";
const requirement = "A repeated import must leave one stored record.";
const diagnosis = "The cache caused both writes.";
const body = `${requirement}\n${diagnosis}\n`;
const draftObservation = "The reporter saw two records with the same document ID.";
const draftExpectation = "The proposed behavior is to retain one record per document ID.";
const draftReproduction = "Import document A twice, then count rows for its ID.";
const draftBody = `${draftObservation}\n${draftExpectation}\n${draftReproduction}\n`;
const url = `https://${target.host}/${target.destination}/issues/42`;
const source = `gh api --hostname ${target.host} repos/${target.destination}/issues/42`;
const query = `gh api --hostname ${target.host} --paginate repos/${target.destination}/issues?state=all`;
const contract = { source: "contract.md", quote: requirement };
const control = { source: "control.log", quote: "Duplicate reproduced with the cache disabled." };
const command = "bun test imports.test.ts";
const resultLine = "PASS reimport: exactly one stored record after importing twice";
const step = {
	segment: "segment-1", change: "Keep the existing record when reimporting the same document.", command,
	expected: "One stored record after two imports.", rejects: "Two stored records sharing the document ID.",
};

interface IssueWorld {
	pi: FakePi;
	ctx: unknown;
	judgeCalls: { questions: readonly JudgeQuestion[] }[];
	readback: { source: string; quote?: string };
	inventory?: { source: string; quote: string };
	understanding: unknown;
	development: unknown;
	latest: unknown;
	judgeCallsBefore: number;
	revisionBefore: unknown;
}

const world = (value: unknown): IssueWorld => value as IssueWorld;
const details = (w: IssueWorld) => toolDetails(w.latest);
const context = async (w: IssueWorld, params: unknown = { action: "list" }) => toolDetails(await w.pi.callTool("jev_context", params, w.ctx));
const observe = async (w: IssueWorld, tool: string, input: unknown, text: string, failed = false) => {
	await w.pi.emit("tool_result", toolResultEvent(tool, input, text, failed), w.ctx);
};
const readIssue = async (w: IssueWorld, actualBody = body, actualUrl = url) => {
	await observe(w, "bash", { command: w.readback.source }, `${JSON.stringify({ html_url: actualUrl, number: 42, title, body: actualBody })}\n`);
};
const recordInventory = async (w: IssueWorld, problem?: string) => {
	const listedTarget = problem === "for another project" ? { ...target, destination: "team/exports" } : target;
	const listedQuery = query.replace(target.destination, listedTarget.destination);
	const source = `tracker-inventory '${listedQuery}'`;
	const issues = problem === "duplicate" ? [{ url, title, body: draftBody }]
		: problem === "equivalent" ? [{ url, title: "Same document is stored twice", body: "Importing a document twice yields two rows for the same ID." }]
			: [];
	const quote = JSON.stringify({ target: listedTarget, query: listedQuery, issues });
	w.inventory = { source, quote };
	if (problem !== "unobserved") await observe(w, "bash", { command: source }, quote);
};
const submit = async (w: IssueWorld, phase: string, params: Record<string, unknown> = {}) => {
	w.revisionBefore = (await context(w))["revision"];
	w.judgeCallsBefore = w.judgeCalls.length;
	w.latest = await w.pi.callTool("jev_issue", { phase, target, title, body, readback: w.readback, ...params }, w.ctx);
	return details(w);
};
const observeIndependentSources = async (w: IssueWorld) => {
	for (const ref of [contract, control]) await observe(w, "read", { path: ref.source }, ref.quote);
};
const understand = (w: IssueWorld, independent = true) => submit(w, "understand", { segments: [
	{ kind: "expected", quote: requirement, disposition: "accept", basis: "The repository contract specifies the outcome.", evidence: independent ? [contract] : [] },
	{ kind: "hypothesis", quote: diagnosis, disposition: "disagree", basis: "The cache-disabled control contradicts the diagnosis.",
		evidence: independent ? [control] : [{ source: w.readback.source, quote: diagnosis }] },
] });
const recordUnderstanding = async (w: IssueWorld) => {
	await readIssue(w);
	await observeIndependentSources(w);
	const result = await understand(w);
	expect(result["status"]).toBe("understood");
	expect(result["resultId"]).toBeString();
	w.understanding = result["resultId"];
};
const develop = (w: IssueWorld, params: Record<string, unknown> = {}) => submit(w, "develop", { priorResult: w.understanding, steps: [step], ...params });
const accept = (w: IssueWorld) => submit(w, "accept", { priorResult: w.development });
const editImplementation = async (w: IssueWorld, content: string) => observe(w, "write", { path: "imports.ts", content }, "Wrote imports.ts");
const runCheck = async (w: IssueWorld, passed: boolean) => observe(w, "bash", { command }, passed ? resultLine : "FAIL reimport: found two records", !passed);

given("a session is examining issue 42 in the import project's tracker", async raw => {
	const w = world(raw);
	w.pi = fakePi();
	w.ctx = fakeCtx();
	w.readback = { source };
	const supported = { label: "supported", confidence: 1 };
	const proposal = { label: "report_or_proposal", confidence: 1 };
	const answers = answeringJudge({ target: supported, inventory: supported, duplicate_0: { label: "duplicate", confidence: 1 },
		field_0: proposal, field_1: proposal, field_2: supported,
		overall: supported, coverage: supported, segment_0: supported, segment_1: supported, step_0: supported, check_0: supported });
	w.judgeCalls = answers.calls;
	createJevController({ judge: answers.judge, config: boundaryConfig(), zod: fakeZod() }).register(w.pi.api);
	await w.pi.emit("before_agent_start", { reason: "prompt", prompt: "Review the tracker issue about duplicate imports." }, w.ctx);
});

given("the scoped tracker inventory was observed with no candidates", async raw => recordInventory(world(raw)));
given("the observed inventory contains the exact draft as issue 42", async raw => recordInventory(world(raw), "duplicate"));
given("the scoped inventory contains a differently worded report of the same duplicate-record behavior", async raw => recordInventory(world(raw), "equivalent"));
given("the draft cites an inventory that is {string}", async (raw, problem) => recordInventory(world(raw), problem));
when("the author asks Jev to prepare the draft", async raw => {
	const w = world(raw);
	await submit(w, "prepare", { body: draftBody, inventory: w.inventory, fields: [
		{ kind: "observation", quote: draftObservation }, { kind: "expected", quote: draftExpectation }, { kind: "reproduction", quote: draftReproduction },
	] });
});
then("Jev returns the exact destination, title and body for a separate native handoff", raw => {
	expect(details(world(raw))).toMatchObject({ kind: "reviewed", status: "not_filed", handoff: { client: "gh", payload: { target, title, body: draftBody } } });
});
then("Jev says filing still requires exact owner authorization", async raw => {
	const w = world(raw);
	expect(toolText(w.latest)).toContain("Only after exact owner authorization");
	expect((await context(w))["revision"]).toBe(w.revisionBefore);
});
then("Jev returns issue 42 rather than a posting handoff", raw => {
	const result = details(world(raw));
	expect(result).toMatchObject({ kind: "defect", status: "not_filed", duplicate: url });
	expect(result["handoff"]).toBeUndefined();
});
then("Jev returns the equivalent issue rather than a posting handoff", raw => {
	const w = world(raw);
	expect(details(w)).toMatchObject({ kind: "defect", status: "not_filed", duplicate: url, duplicates: [{ url, verdict: "duplicate" }] });
	expect(details(w)["handoff"]).toBeUndefined();
});
then("Jev returns {string} and no posting handoff", (raw, kind) => {
	const result = details(world(raw));
	expect(result).toMatchObject({ kind, status: "not_filed" });
	expect(result["handoff"]).toBeUndefined();
});
then("the request does not reach the judge", raw => {
	const w = world(raw);
	expect(w.judgeCalls).toHaveLength(w.judgeCallsBefore);
});

given("the native client returned the complete matching issue", async raw => readIssue(world(raw)));
given("the issue evidence has {string}", async (raw, problem) => {
	const w = world(raw);
	switch (problem) {
		case "no observed output": return;
		case "a non-native command":
			w.readback = { source: "cat tracker-snapshot.json", quote: `${JSON.stringify({ html_url: url, number: 42, title, body })}\n` };
			break;
		case "a different body": return readIssue(w, body.trimEnd());
		case "a different project URL": return readIssue(w, body, url.replace("team/imports", "team/exports"));
		default: throw new Error(`Unknown readback problem: ${problem}`);
	}
	await readIssue(w);
});
when("the author asks Jev to verify filing", async raw => { await submit(world(raw), "verify"); });
then("Jev confirms issue 42 was filed without claiming who posted it", raw => {
	const w = world(raw);
	expect(details(w)).toMatchObject({ kind: "reviewed", status: "filed", id: 42, url });
	expect(toolText(w.latest)).toContain("does not establish who posted it");
});
then("filing remains unverified with a {string} result", (raw, kind) => {
	expect(details(world(raw))).toMatchObject({ kind, status: "unverified" });
});

given("a repository contract and a cache-disabled control run were observed", async raw => observeIndependentSources(world(raw)));
when("the developer asks Jev to review the requirement and the diagnosis separately", async raw => { await understand(world(raw)); });
then("the one-record requirement is a change obligation and the rejected diagnosis is not", raw => {
	const result = details(world(raw));
	expect(result).toMatchObject({ status: "understood", segments: [
		{ quote: requirement, disposition: "accept", verdict: "supported" },
		{ quote: diagnosis, disposition: "disagree", verdict: "supported" },
	] });
	expect(result["obligations"]).toEqual([{ id: "segment-1", outcome: requirement, mode: "change" }]);
});
when("the developer cites only the issue text to disagree with its diagnosis", async raw => { await understand(world(raw), false); });
then("Jev identifies the missing independent evidence even though the judge backed the disposition", raw => {
	const w = world(raw);
	expect(w.judgeCalls.at(-1)?.questions.map(question => question.name)).toContain("segment_1");
	expect(details(w)).toMatchObject({ kind: "defect", status: "partially_understood", segments: [
		{ quote: requirement, verdict: "supported" }, { quote: diagnosis, evidenceGap: true, verdict: "gap" },
	] });
	expect(toolText(w.latest)).toContain("Supply independent evidence for this disposition.");
});

given("Jev recorded the one-record requirement as an obligation for issue 42", async raw => recordUnderstanding(world(raw)));
when("the developer submits a change and a check that would detect duplicate records", async raw => { await develop(world(raw)); });
then("Jev records that proposal as ready for development, not as implemented", async raw => {
	const w = world(raw);
	expect(details(w)).toMatchObject({ kind: "reviewed", status: "development_ready", steps: [{ ...step, verdict: "supported" }] });
	expect((await context(w))["revision"]).toBe(w.revisionBefore);
});
when("the developer submits a plan that {string}", async (raw, problem) => {
	const w = world(raw);
	switch (problem) {
		case "names a filing verification as its prior": {
			const verified = await submit(w, "verify");
			expect(verified["status"]).toBe("filed");
			expect(verified["resultId"]).toBeString();
			await develop(w, { priorResult: verified["resultId"] });
			break;
		}
		case "reuses the review after the issue changed": {
			const changed = `${body}The report now covers imports from two accounts.\n`;
			await readIssue(w, changed);
			await develop(w, { body: changed });
			break;
		}
		case "treats the rejected diagnosis as required":
			await develop(w, { steps: [{ ...step, segment: "segment-2" }] });
			break;
		default: throw new Error(`Unknown development problem: ${problem}`);
	}
});
then("Jev returns {string} without marking development ready", (raw, kind) => {
	expect(details(world(raw))).toMatchObject({ kind, status: "not_ready" });
});

given("Jev recorded a development review for the one-record requirement", async raw => {
	const w = world(raw);
	await recordUnderstanding(w);
	const result = await develop(w);
	expect(result["status"]).toBe("development_ready");
	expect(result["resultId"]).toBeString();
	w.development = result["resultId"];
});
given("the developer edited the implementation after that review", async raw => editImplementation(world(raw), "const retainExisting = true;"));
when("the developer asks Jev to accept delivery before rerunning the check", async raw => { await accept(world(raw)); });
then("Jev names the missing terminal check and does not accept delivery", raw => {
	expect(details(world(raw))).toMatchObject({ status: "not_accepted", missing: [command] });
});
when("the check finishes with an error and the developer asks again", async raw => {
	const w = world(raw);
	await runCheck(w, false);
	await accept(w);
});
then("Jev does not accept the failed check even if the judge supports it", raw => {
	const w = world(raw);
	expect(w.judgeCalls).toHaveLength(w.judgeCallsBefore + 1);
	const result = details(w);
	expect(result).toMatchObject({ kind: "unclear", status: "not_accepted", checks: [{ command, verdict: "unclear" }] });
	const checks = result["checks"] as { execution: { quote: string } }[];
	expect(checks[0]?.execution.quote).toContain("FAIL reimport: found two records");
});
when("the check passes with the one-record result and the developer asks again", async raw => {
	const w = world(raw);
	await runCheck(w, true);
	await accept(w);
});
then("Jev accepts the recorded delivery against the development review", async raw => {
	const w = world(raw);
	const result = details(w);
	expect(result["resultId"]).toBeString();
	expect(result).toMatchObject({ status: "accepted", checks: [{ command, verdict: "supported" }] });
	const checks = result["checks"] as { execution: { quote: string } }[];
	expect(checks[0]?.execution.quote).toContain(resultLine);
	const record = await context(w, { action: "result", sourceId: result["resultId"] });
	expect(record["result"]).toMatchObject({ applicability: "current", prior: [w.development] });
});
then("no tracker status, publication or closure is changed", async raw => {
	const w = world(raw);
	expect(toolText(w.latest)).toContain("No tracker status, publication or closure is inferred or changed");
	expect(await context(w)).toMatchObject({ revision: w.revisionBefore, pendingEffects: [] });
});
given("delivery was accepted after the edit and passing check", async raw => {
	const w = world(raw);
	await editImplementation(w, "const retainExisting = true;");
	await runCheck(w, true);
	expect(await accept(w)).toMatchObject({ status: "accepted" });
});
when("the developer changes the implementation again and asks Jev to accept without a new run", async raw => {
	const w = world(raw);
	await editImplementation(w, "const retainExisting = false;");
	await accept(w);
});