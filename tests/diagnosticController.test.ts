import { describe, expect, test } from "bun:test";
import { createJevController } from "../src/controller.js";
import type { Judge } from "../src/judge.js";
import { asRecord } from "../src/types.js";
import { answeringJudge, blockReason, boundaryConfig, fakeCtx, fakePi, fakeZod, stopDecision, stopEvent, toolCallEvent, toolDetails, toolFailed, toolResultEvent } from "./helpers.js";

const controller = (judge: Judge) => {
	const pi = fakePi();
	createJevController({ judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	return pi;
};

describe("diagnostic-only execution", () => {
	test("missing planning checks never prevent implementation or completion", async () => {
		const pi = controller(answeringJudge({}).judge);
		const ctx = fakeCtx();
		await pi.emit("before_agent_start", { prompt: "Implement the coverage report", systemPrompt: [] }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "report.ts", content: "export const count = 1;" }), ctx))).toBeUndefined();
		await pi.emit("tool_result", toolResultEvent("write", { path: "report.ts", content: "export const count = 1;" }, "Wrote report.ts"), ctx);
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		const details = toolDetails(await pi.callTool("jev_context", { action: "list" }, ctx));
		const work = asRecord(asRecord(details["diagnostics"])?.["work"]);
		expect(work?.["not_checked"]).toBe(1);
		expect(work?.["passed"]).toBe(0);
	});

	test("an unavailable judgment is a normal diagnostic result and cannot hold later work", async () => {
		const pi = controller(async () => ({ ok: false, kind: "unavailable", problem: "Judge service unavailable" }));
		const ctx = fakeCtx();
		expect(toolFailed(await pi.callTool("jev_consult", {
			mode: "boolean", question: "Does the report match the observed coverage?",
			context: "The report contains the coverage from the observed test run.",
			trueMeaning: "The report matches.", falseMeaning: "The report does not match.",
		}, ctx))).toBe(false);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "report.ts", content: "corrected" }), ctx))).toBeUndefined();
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		const diagnostics = asRecord(toolDetails(await pi.callTool("jev_context", { action: "list" }, ctx))["diagnostics"]);
		expect(asRecord(diagnostics?.["checks"])?.["unavailable"]).toBe(1);
		expect(asRecord(diagnostics?.["checks"])?.["passed"]).toBe(0);
	});

	test.each([
		{ confidence: 0.99, kind: "failed" },
		{ confidence: 0.30, kind: "inconclusive" },
	])("a negative review is a normal diagnostic result counted as $kind", async ({ confidence, kind }) => {
		const pi = controller(answeringJudge({ review: { label: "defect", confidence } }).judge);
		const ctx = fakeCtx();
		expect(toolFailed(await pi.callTool("jev_review", {
			kind: "diff", target: "report.ts", claim: "The report handles empty input.",
			evidence: [{ kind: "code", quote: "return report.value;" }, { kind: "execution", quote: "Empty report throws." }],
		}, ctx))).toBe(false);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "report.ts", content: "corrected" }), ctx))).toBeUndefined();
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		const diagnostics = asRecord(toolDetails(await pi.callTool("jev_context", { action: "list" }, ctx))["diagnostics"]);
		expect(asRecord(diagnostics?.["checks"])?.[kind]).toBe(1);
		expect(asRecord(diagnostics?.["checks"])?.["passed"]).toBe(0);
	});

	test("a pending judge cannot delay evidence inspection, execution, or completion", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pi = controller(async (state, questions) => {
			entered.resolve();
			await release.promise;
			return answeringJudge({ consult: { probability: 0.95 } }).judge(state, questions);
		});
		const ctx = fakeCtx();
		const judgment = pi.callTool("jev_consult", {
			mode: "boolean", question: "Does the report match the observed coverage?",
			context: "The report contains the coverage from the observed test run.",
			trueMeaning: "The report matches.", falseMeaning: "The report does not match.",
		}, ctx);
		await entered.promise;
		const progress = Promise.all([
			pi.callTool("jev_context", { action: "list" }, ctx),
			pi.emit("tool_call", toolCallEvent("write", { path: "report.ts", content: "corrected" }), ctx),
			pi.emit("session_stop", stopEvent(), ctx),
		]);
		let observed: Awaited<typeof progress> | undefined;
		void progress.then(result => { observed = result; });
		try {
			const checkpoint = Promise.withResolvers<void>();
			setImmediate(checkpoint.resolve);
			await checkpoint.promise;
			expect(observed).toBeDefined();
			if (observed !== undefined) {
				expect(toolFailed(observed[0])).toBe(false);
				expect(blockReason(observed[1])).toBeUndefined();
				expect(stopDecision(observed[2])).toBeUndefined();
			}
		} finally {
			release.resolve();
			await Promise.all([judgment, progress]);
		}
	});

	test("continuation is not an owner command because findings never grant or revoke permission", () => {
		const pi = controller(answeringJudge({}).judge);
		expect(pi.commands.has("jev-continue")).toBe(false);
	});
});
