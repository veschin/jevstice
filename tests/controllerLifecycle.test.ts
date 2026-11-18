import { describe, expect, test } from "bun:test";
import { createJevController } from "../src/controller.js";
import { answeringJudge, boundaryConfig, fakeCtx, fakePi, fakeZod, stopEvent, toolDetails, toolResultEvent, until, type FakePi } from "./helpers.js";

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

	test("completion shows status immediately without queuing a message while the host is busy", async () => {
		const { pi } = harness();
		const notices: string[] = [];
		const ctx = { hasUI: true, isIdle: () => false, ui: { notify: (text: string) => notices.push(text) } };
		await pi.emit("before_agent_start", { reason: "prompt", prompt: "Implement headline counts" }, ctx);
		await pi.emit("session_stop", stopEvent(), ctx);
		await pi.emit("session_stop", stopEvent(), ctx);
		expect(notices).toEqual([expect.stringContaining("Jev · On")]);
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
		const ctx = fakeCtx();
		const start = (prompt: string) => pi.emit("before_agent_start", { reason: "prompt", prompt, systemPrompt: [] }, ctx);
		const request = "Implement headline counts";
		await start(request);
		await pi.callTool("jev_requirements", { request, items: [{ text: request, source: request }] }, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "headlines.ts", content: "export const headlines = 0;" }, "Wrote headlines.ts"), ctx);
		await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test headlines.test.ts" }, "Expected 1, received 0", true), ctx);
		expect(await pi.emit("session_stop", stopEvent(), ctx)).toEqual([undefined]);
		expect(await until(() => pi.messages.some(message => message.customType === "jev.acceptance"), 200)).toBe(true);
		const history = pi.messages.map(message => ({ role: "custom", ...message }));
		expect(await pi.emit("context", { messages: history }, ctx)).toEqual([{ messages: [
			expect.objectContaining({ customType: "jev.feedback", display: false, content: expect.stringContaining(request) }),
		] }]);
		expect(pi.messages).toMatchObject([
			{ customType: "jev.status", display: true, deliverAs: "nextTurn", triggerTurn: false },
			{ customType: "jev.acceptance", display: true, deliverAs: "nextTurn", triggerTurn: false },
		]);
		const newRequest = "Implement daily totals";
		await start(newRequest);
		expect(await pi.emit("context", { messages: history }, ctx)).toEqual([{ messages: [] }]);
		const next = await pi.callTool("jev_requirements", { request: newRequest, items: [{ text: newRequest, source: newRequest }] }, ctx);
		expect(toolDetails(next)).toMatchObject({ approved: true });
		expect((await inspect(pi, ctx))["outcome"]).toBeUndefined();
	});
});
