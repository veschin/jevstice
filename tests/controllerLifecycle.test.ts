import { describe, expect, test } from "bun:test";
import { createJevController } from "../src/controller.js";
import { answeringJudge, boundaryConfig, fakeArtifacts, fakeCtx, fakePi, fakeZod, stopEvent, toolDetails, toolResultEvent, until, type FakePi } from "./helpers.js";
import type { Judge } from "../src/judge.js";

const harness = () => {
	const pi = fakePi();
	createJevController({ judge: answeringJudge({}).judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	return { pi, ctx: fakeCtx() };
};
const launch = (jobId: string) => ({
	type: "tool_result", toolName: "bash", toolCallId: `call-${jobId}`,
	input: { command: "generate-report" }, content: [{ type: "text", text: "Started in background" }],
	isError: false, details: { async: { jobId, type: "bash", state: "running" } },
});
const completed = (jobId: string, type = "bash") => ({
	role: "custom", customType: "async-result", timestamp: Date.now() + 100,
	content: [{ type: "text", text: "The generated report was written" }],
	details: { jobs: [{ jobId, type, status: "completed" }] },
});
const inspect = async (pi: FakePi, ctx: unknown) => toolDetails(await pi.callTool("jev_context", { action: "list" }, ctx));

test("issue readback can use a verified host spill but not a clipped result", async () => {
	const { pi } = harness();
	const target = { platform: "github", host: "github.example.test", destination: "team/project" };
	const title = "Export drops the final row";
	const body = "A".repeat(1200);
	const url = "https://github.example.test/team/project/issues/42";
	const complete = JSON.stringify({ html_url: url, number: 42, title, body });
	const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "1.log": complete }) });
	const source = "gh api --hostname github.example.test repos/team/project/issues/42";
	const check = async (artifactId: string) => {
		const event = toolResultEvent("bash", { command: source }, complete.slice(0, 768)) as Record<string, unknown>;
		await pi.emit("tool_result", { ...event, details: { meta: { limits: { columnTruncated: { artifactId } } } } }, ctx);
		return toolDetails(await pi.callTool("jev_issue", { phase: "verify", target, title, body, readback: { source } }, ctx));
	};
	await pi.emit("before_agent_start", { reason: "prompt", prompt: "Inspect the tracker issue." }, ctx);
	expect(await check("0")).toMatchObject({ status: "unverified" });
	expect(await check("1")).toMatchObject({ status: "filed", url });
});

test("issue acceptance follows the vetted requirement and requires a run after the last edit", async () => {
	const pi = fakePi();
	const ctx = fakeCtx();
	let coverageSettled = true;
	const judge: Judge = async (_, questions) => ({
		ok: true, answers: questions.map(question => ({ name: question.name, mode: "choice", label: "supported",
			confidence: question.name === "coverage" && !coverageSettled ? 0.3 : 1 })),
	});
	createJevController({ judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const target = { platform: "github", host: "github.example.test", destination: "team/project" };
	const title = "Reimport creates a duplicate";
	const expected = "A repeated import must leave one stored record.";
	const hypothesis = "The cache caused both writes.";
	const body = `${expected}\n${hypothesis}`;
	const url = "https://github.example.test/team/project/issues/42";
	const source = "gh api --hostname github.example.test repos/team/project/issues/42";
	const command = "bun test imports.test.ts";
	await pi.emit("before_agent_start", { reason: "prompt", prompt: "Inspect and fix the import issue." }, ctx);
	const readIssue = (text: string) => pi.emit("tool_result", toolResultEvent("bash", { command: source },
		`${JSON.stringify({ html_url: url, number: 42, title, body: text })}\n`), ctx);
	await readIssue(body);
	await pi.emit("tool_result", toolResultEvent("read", { path: "contract.md" }, expected), ctx);
	await pi.emit("tool_result", toolResultEvent("read", { path: "control.log" }, "Duplicate reproduced with the cache disabled."), ctx);
	const act = (phase: string, payload: Record<string, unknown> = {}) =>
		pi.callTool("jev_issue", { phase, target, title, body, readback: { source }, ...payload }, ctx).then(toolDetails);
	expect(await act("verify", { readback: { source, quote: JSON.stringify({ html_url: url, number: 42, title, body }) } }))
		.toMatchObject({ status: "filed", url });
	const segments = [
		{ kind: "expected", quote: expected, disposition: "accept", basis: "The repository contract specifies this behavior.",
			evidence: [{ source: "contract.md", quote: expected }] },
		{ kind: "hypothesis", quote: hypothesis, disposition: "disagree", basis: "The control reproduces without the cache.",
			evidence: [{ source: "control.log", quote: "Duplicate reproduced with the cache disabled." }] },
	];
	const review = await act("understand", { segments });
	expect(review).toMatchObject({ status: "understood", obligations: [{ id: "segment-1", outcome: expected }] });
	const steps = [{ segment: "segment-1", change: "Keep an existing record on reimport.", command,
		expected: "The test reports exactly one stored record after two imports.", rejects: "The test would see a duplicate record." }];
	const development = await act("develop", { priorResult: review["resultId"], steps });
	expect(development).toMatchObject({ status: "development_ready" });
	expect(await act("develop", { priorResult: review["resultId"], steps: [{ ...steps[0], segment: "segment-2" }] }))
		.not.toMatchObject({ status: "development_ready" });
	const accept = () => act("accept", { priorResult: development["resultId"] });
	const edit = (content: string) => pi.emit("tool_result", toolResultEvent("write", { path: "imports.ts", content }, "Wrote imports.ts"), ctx);
	const testRun = () => pi.emit("tool_result", toolResultEvent("bash", { command }, "1 pass, 0 fail; after two imports stored exactly one record"), ctx);
	await edit("const keep = true;");
	expect(await accept()).toMatchObject({ status: "not_accepted" });
	await testRun();
	const accepted = await accept();
	expect(accepted).toMatchObject({ status: "accepted", checks: [{ segment: "segment-1", verdict: "supported" }] });
	const record = toolDetails(await pi.callTool("jev_context", { action: "result", sourceId: accepted["resultId"] }, ctx));
	expect(record["result"]).toMatchObject({ applicability: "current", prior: [development["resultId"]] });
	const revisedDevelopment = await act("develop", { priorResult: review["resultId"], steps });
	const acceptRevision = () => act("accept", { priorResult: revisedDevelopment["resultId"] });
	expect(await acceptRevision()).toMatchObject({ status: "not_accepted", missing: [command] });
	await testRun();
	expect(await acceptRevision()).toMatchObject({ status: "accepted" });
	await edit("const keep = false;");
	expect(await accept()).toMatchObject({ status: "not_accepted" });
	const historical = toolDetails(await pi.callTool("jev_context", { action: "result", sourceId: accepted["resultId"] }, ctx));
	expect(historical["result"]).toMatchObject({ applicability: "historical" });
	await testRun();
	const changedBody = `${body}\nThis issue now covers a different version.`;
	await readIssue(changedBody);
	expect(await act("accept", { body: changedBody, priorResult: development["resultId"] })).not.toMatchObject({ status: "accepted" });
	coverageSettled = false;
	const partial = await act("understand", { body: changedBody, segments });
	expect(partial).toMatchObject({ status: "partially_understood", coverage: "unclear", open: ["issue coverage"] });
	const partialDevelopment = await act("develop", { body: changedBody, priorResult: partial["resultId"], steps });
	expect(partialDevelopment).toMatchObject({ status: "development_ready", open: ["issue coverage"] });
	await testRun();
	expect(await act("accept", { body: changedBody, priorResult: partialDevelopment["resultId"] }))
		.toMatchObject({ status: "not_accepted", open: ["issue coverage"], missing: [] });
});

describe("ordinary background effects", () => {
	test("a background launch invalidates previous work evidence before its unknown effect finishes", async () => {
		const { pi, ctx } = harness();
		await pi.emit("tool_result", launch("bg-report"), ctx);
		const state = await inspect(pi, ctx);
		expect(state["revision"]).toBe(1);
		expect(state["pendingEffects"]).toEqual([{ jobId: "bg-report", tool: "bash" }]);
	});

	test("only a matching terminal job settles the original effect and advances evidence once", async () => {
		const { pi, ctx } = harness();
		await pi.emit("tool_result", launch("bg-report"), ctx);
		await pi.emit("context", { messages: [completed("other"), completed("bg-report", "eval")] }, ctx);
		expect((await inspect(pi, ctx))["revision"]).toBe(1);
		const delivery = { messages: [completed("bg-report")] };
		await pi.emit("context", delivery, ctx);
		const settled = await inspect(pi, ctx);
		expect(settled["revision"]).toBe(2);
		expect(settled["pendingEffects"]).toEqual([]);
		await pi.emit("context", delivery, ctx);
		expect((await inspect(pi, ctx))["revision"]).toBe(2);
		expect(settled["diagnostics"]).toMatchObject({ work: { not_checked: 1, passed: 0 } });
	});

	test("the native wait receipt and later delivery cannot count the same effect twice", async () => {
		const { pi, ctx } = harness();
		await pi.emit("tool_result", launch("bg-report"), ctx);
		await pi.emit("tool_result", {
			toolName: "wait", toolCallId: "wait-1", input: {}, content: [], isError: false,
			details: { op: "wait", jobs: [{ id: "bg-report", type: "bash", status: "completed", resultText: "Report written" }] },
		}, ctx);
		expect((await inspect(pi, ctx))["revision"]).toBe(2);
		await pi.emit("context", { messages: [completed("bg-report")] }, ctx);
		expect((await inspect(pi, ctx))["revision"]).toBe(2);
	});
});

test("re-observing the same request while two checks are queued does not stale either", async () => {
	const pi = fakePi();
	const ctx = fakeCtx();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const answers = answeringJudge({ consult: { probability: 0.98 } });
	const judge: Judge = async (material, questions) => {
		started.resolve();
		await release.promise;
		return answers.judge(material, questions);
	};
	createJevController({ judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const prompt = { reason: "prompt", prompt: "Implement report totals." };
	await pi.emit("before_agent_start", prompt, ctx);
	const consult = (question: string) => pi.callTool("jev_consult", {
		mode: "boolean", question, context: "The reports use fixed example data.",
		trueMeaning: "Use the current layout.", falseMeaning: "Use a different layout.",
	}, ctx).then(toolDetails);
	const first = consult("Does the first report use the input?");
	await started.promise;
	const second = consult("Does the second report use the input?");
	await pi.emit("before_agent_start", prompt, ctx);
	release.resolve();
	const checked = await Promise.all([first, second]);
	expect(checked[0]).toMatchObject({ verdict: "yes", confidence: 0.98 });
	expect(checked[1]).toMatchObject({ verdict: "yes", confidence: 0.98 });
	expect(answers.calls).toHaveLength(2);
});

describe("lean ordinary workflow", () => {
	test("a quiet read does not receive the development manual", async () => {
		const { pi, ctx } = harness();
		const [result] = await pi.emit("before_agent_start", {
			reason: "prompt", prompt: "Read the existing report", systemPrompt: ["host policy"],
		}, ctx);
		expect(result).toEqual({ systemPrompt: ["host policy"] });
	});

	test("requirements can start a task without a separate triage call", async () => {
		const pi = fakePi();
		const judge = answeringJudge({ coverage: { probability: 0.95 }, item_1: { probability: 0.95 } });
		createJevController({ judge: judge.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx();
		const request = "Implement a coverage report exported as `coverage`.";
		await pi.emit("before_agent_start", { reason: "prompt", prompt: request, systemPrompt: [] }, ctx);
		const result = await pi.callTool("jev_requirements", { items: [{ text: request, source: "coverage report" }] }, ctx);
		expect(toolDetails(result)["approved"]).toBe(true);
		expect(judge.calls.map(call => call.questions.map(question => question.name))).toEqual([["coverage", "item_1"]]);
	});

	test("work done while checks are off does not enter their ledgers", async () => {
		const { pi, ctx } = harness();
		pi.callCommand("jev", "off", ctx);
		await pi.emit("tool_result", launch("off-job"), ctx);
		await pi.emit("context", { messages: [completed("off-job")] }, ctx);
		pi.callCommand("jev", "on", ctx);
		const state = await inspect(pi, ctx);
		expect(state["revision"]).toBe(0);
		expect(state["pendingEffects"]).toEqual([]);
		expect(state["diagnostics"]).toMatchObject({ work: { not_checked: 0 } });
	});

	test("only a terminal verification supplies ordinary outcome evidence, and replay spends no new judge call", async () => {
		const pi = fakePi();
		const judge = answeringJudge({
			coverage: { probability: 0.95 }, item_1: { probability: 0.95 },
			requirement_1: { label: "observed" },
			requirement_1_execution: { label: "evidence_2" }, requirement_1_code: { label: "evidence_1" },
		});
		createJevController({ judge: judge.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx();
		const request = "Implement the coverage dashboard";
		await pi.emit("before_agent_start", { reason: "prompt", prompt: request, systemPrompt: [] }, ctx);
		await pi.callTool("jev_requirements", { request, items: [{ text: request, source: request }] }, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "coverage.ts", content: "export const coverage = 100;" }, "Wrote coverage.ts"), ctx);
		await pi.emit("tool_result", { ...launch("verify"), input: { command: "bun test coverage.test.ts" } }, ctx);
		const pending = toolDetails(await pi.callTool("jev_acceptance", { aspect: "outcome" }, ctx));
		expect(pending["prerequisite"]).toBeDefined();
		expect(judge.calls).toHaveLength(1);
		await pi.emit("context", { messages: [{ ...completed("verify"), content: "2 pass, 0 fail" }] }, ctx);
		const result = toolDetails(await pi.callTool("jev_acceptance", { aspect: "outcome" }, ctx));
		expect(result).toMatchObject({ approved: true, requirements: [{
			status: "met", code: { quote: expect.stringContaining("export const coverage = 100;") },
			execution: { quote: expect.stringContaining("2 pass, 0 fail") },
		}] });
		expect(toolDetails(await pi.callTool("jev_acceptance", { aspect: "outcome" }, ctx))).toMatchObject({ replayed: true, approved: true });
		await pi.emit("session_stop", stopEvent(), ctx);
		expect(judge.calls).toHaveLength(2);
		await pi.emit("tool_result", toolResultEvent("write", { path: "coverage.ts", content: "export const coverage = 0;" }, "Changed coverage.ts"), ctx);
		const changed = toolDetails(await pi.callTool("jev_acceptance", { aspect: "outcome" }, ctx));
		expect(changed["missingEvidence"]).toEqual(["execution"]);
		expect(judge.calls).toHaveLength(2);
	});

	test("outcome retries an outage but retains its original diagnostic history", async () => {
		const pi = fakePi();
		const ctx = fakeCtx();
		const request = "Implement and verify the report count.";
		const answers = answeringJudge({
			coverage: { probability: 0.95 }, item_1: { probability: 0.95 },
			requirement_1: { label: "observed" },
			requirement_1_execution: { label: "evidence_2" }, requirement_1_code: { label: "evidence_1" },
		});
		let offline = true;
		const judge: Judge = (state, questions) => offline && questions.some(question => question.name === "requirement_1")
			? Promise.resolve({ ok: false, kind: "unavailable", problem: "offline" }) : answers.judge(state, questions);
		createJevController({ judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
		await pi.emit("before_agent_start", { reason: "prompt", prompt: request }, ctx);
		const requirement = toolDetails(await pi.callTool("jev_requirements", { items: [{ text: request, source: request }] }, ctx));
		await pi.emit("tool_result", toolResultEvent("write", { path: "report.ts", content: "export const count = 1;" }, "Wrote report.ts"), ctx);
		await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test report.test.ts" }, "1 pass, 0 fail"), ctx);
		const outcome = () => pi.callTool("jev_acceptance", { aspect: "outcome" }, ctx).then(toolDetails);
		const unavailable = await outcome();
		const firstId = unavailable["resultId"];
		expect(unavailable["kind"]).toBe("unavailable");
		expect(typeof firstId).toBe("string");
		offline = false;
		const passed = await outcome();
		expect(passed).toMatchObject({ approved: true });
		expect((await outcome())["resultId"]).toBe(passed["resultId"]);
		const history = toolDetails(await pi.callTool("jev_context", { action: "result", sourceId: firstId }, ctx));
		expect(history["result"]).toMatchObject({
			status: "unavailable", applicability: "historical", prior: [requirement["resultId"]],
			input: { observations: [expect.objectContaining({ kind: "code" }), expect.objectContaining({ kind: "execution" })] },
			result: { details: { kind: "unavailable" } },
		});
	});

	test("automatic completion does not publish a status strip, notice or transcript message", async () => {
		const { pi } = harness();
		const status = new Map<string, string>();
		const notices: string[] = [];
		const ctx = { hasUI: true, isIdle: () => false, ui: {
			setStatus: (key: string, text: string) => status.set(key, text),
			notify: (text: string) => notices.push(text),
		} };
		await pi.emit("before_agent_start", { reason: "prompt", prompt: "Implement headline counts" }, ctx);
		await pi.emit("session_stop", stopEvent(), ctx);
		await pi.emit("session_stop", stopEvent(), ctx);
		expect([...status]).toEqual([]);
		expect(notices).toEqual([]);
		expect(pi.messages).toEqual([]);
	});

	test("background outcome feedback enters a natural provider step but does not follow a new objective", async () => {
		const pi = fakePi();
		const judge = answeringJudge({
			coverage: { probability: 0.95 }, item_1: { probability: 0.95 },
			requirement_1: { label: "deviates" },
			requirement_1_execution: { label: "evidence_2" }, requirement_1_code: { label: "evidence_1" },
		});
		createJevController({ judge: judge.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
		const status = new Map<string, string>();
		const ctx = fakeCtx({ setStatus: (key, text) => { if (text !== undefined) status.set(key, text); } });
		let reported = false;
		pi.api.appendEntry = type => { if (type === "jev.acceptance") reported = true; };
		const start = (prompt: string) => pi.emit("before_agent_start", { reason: "prompt", prompt, systemPrompt: [] }, ctx);
		const request = "Implement headline counts";
		await start(request);
		await pi.callTool("jev_requirements", { request, items: [{ text: request, source: request }] }, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "headlines.ts", content: "export const headlines = 0;" }, "Wrote headlines.ts"), ctx);
		await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test headlines.test.ts" }, "Expected 1, received 0", true), ctx);
		expect(await pi.emit("session_stop", stopEvent(), ctx)).toEqual([undefined]);
		expect(await until(() => reported, 200)).toBe(true);
		expect([...status]).toEqual([]);
		expect(await pi.emit("context", { messages: [] }, ctx)).toEqual([{ messages: [
			expect.objectContaining({ customType: "jev.feedback", display: false, content: expect.stringContaining(request) }),
		] }]);
		expect(pi.messages).toEqual([]);
		pi.callCommand("jev-status", "", ctx);
		expect(pi.messages[0]?.content).toContain("Outcome: Findings");
		const newRequest = "Implement daily totals";
		await start(newRequest);
		expect(await pi.emit("context", { messages: [] }, ctx)).toEqual([undefined]);
		const next = await pi.callTool("jev_requirements", { request: newRequest, items: [{ text: newRequest, source: newRequest }] }, ctx);
		expect(toolDetails(next)).toMatchObject({ approved: true });
		expect((await inspect(pi, ctx))["outcome"]).toBeUndefined();
	});
});
