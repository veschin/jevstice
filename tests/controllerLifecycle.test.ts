import { describe, expect, test } from "bun:test";
import { createJevController } from "../src/controller.js";
import { answeringJudge, boundaryConfig, fakeCtx, fakePi, fakeZod, toolDetails, type FakePi } from "./helpers.js";

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
