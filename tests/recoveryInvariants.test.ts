import { expect, test } from "bun:test";
import { actionCheck, courseCheck } from "../src/activities.js";
import { createJevController } from "../src/controller.js";
import { clearResolvedHold, freshState, recordRecovery, recordRefusal, registerTask, submissionLedger } from "../src/state.js";
import { asRecord } from "../src/types.js";
import { answeringJudge, boundaryConfig, fakeCtx, fakePi, fakeZod, toolDetails } from "./helpers.js";

test("FR-22: creating a finding does not buy another judgment for the identical diagnostic", async () => {
	const fake = answeringJudge({ consult: { label: "left", confidence: 0.55 } });
	const pi = fakePi();
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	const ctx = fakeCtx();
	const input = {
		mode: "choice", question: "Which implementation serves the recorded requirement?",
		context: "The implementation must produce the recorded coverage report.",
		alternatives: [{ label: "left", meaning: "Read the recorded coverage." }, { label: "right", meaning: "Generate unrelated sample coverage." }],
	};
	const first = await pi.callTool("jev_consult", input, ctx);
	const second = await pi.callTool("jev_consult", input, ctx);
	expect(toolDetails(first)["approved"]).not.toBe(true);
	expect(toolDetails(second)["approved"]).not.toBe(true);
	expect(fake.calls).toHaveLength(1);
});

test("FR-67: resolution retires its exact ledger record and preserves unrelated refused material", () => {
	const state = freshState();
	registerTask(state, "Repair the recorded report.");
	recordRefusal(state, { boundary: "review", digest: "resolved-material" });
	recordRefusal(state, { boundary: "review", digest: "other-material" });
	recordRefusal(state, { boundary: "search", digest: "search-material" });
	const hold = recordRecovery(state, "jev_review", { target: "report.ts" }, {
		ok: false, text: "The report evidence is inconclusive.",
		details: { kind: "unclear", approved: false, submission: { boundary: "review", digest: "resolved-material" } },
	});
	expect(clearResolvedHold(state, hold?.id ?? "")).toBe(true);
	expect(submissionLedger(state, "review", "resolved-material").repeat).toBe(false);
	expect(submissionLedger(state, "review", "other-material").repeat).toBe(true);
	expect(submissionLedger(state, "search", "search-material").repeat).toBe(true);
});

test("FR-67: an arbitrary held diagnostic never prevents a new substantive check", async () => {
	const state = freshState();
	const task = registerTask(state, "Repair the recorded report.");
	state.planTopics = [{ id: "report", section: "## Report", paths: ["src/report.ts"], requirement: "repair the recorded report" }];
	state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://report-plan.md", planDigest: "bound" };
	recordRecovery(state, "review", { target: "report.ts" }, {
		ok: false,
		text: "the developer review found an unrelated parser defect",
		details: { kind: "defect", approved: false, label: "defect" },
	});
	expect(state.hold?.id).toBeDefined();

	const judge = answeringJudge({ action: { label: "on_course", confidence: 0.95 } });
	const outcome = await actionCheck(
		{ judge: judge.judge, config: boundaryConfig() },
		state,
		{ tool: "write", target: "src/report.ts", change: JSON.stringify({ path: "src/report.ts", content: "the report" }) },
		{ path: "src/report.ts", content: "the report" },
	);

	expect(outcome.ok).toBe(true);
	expect(outcome.details?.["approved"]).toBe(true);
	expect(judge.calls).toHaveLength(1);
	expect(state.hold?.id).toBeDefined();
});

test("FR-67: an inconclusive action finding still lets the corrected invocation be judged", async () => {
	const state = freshState();
	const task = registerTask(state, "Repair the recorded report.");
	state.planTopics = [{ id: "report", section: "## Report", paths: ["src/report.ts"], requirement: "repair the recorded report" }];
	state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://report-plan.md", planDigest: "bound" };
	recordRecovery(state, "action:4", { action: { tool: "write" } }, {
		ok: true, text: "the proposed invocation answered unclear",
		details: { kind: "unclear", approved: false, label: "on_course", confidence: 0.38 },
	});

	const judge = answeringJudge({ action: { label: "on_course", confidence: 0.96 } });
	const outcome = await actionCheck(
		{ judge: judge.judge, config: boundaryConfig() },
		state,
		{ tool: "write", target: "src/report.ts", change: JSON.stringify({ path: "src/report.ts", content: "the corrected report" }) },
	);

	expect(outcome.details?.["approved"]).toBe(true);
	expect(judge.calls).toHaveLength(1);
	expect(asRecord(state.hold?.result)?.["kind"]).toBe("unclear");
});

test("diagnostics do not stop automatic checks after an unrelated finding", async () => {
	const state = freshState();
	const task = registerTask(state, "Report the coverage of the last run.");
	state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://coverage-plan.md", planDigest: "d" };
	state.planTopics = [{ id: "collect", section: "## Collect", paths: ["src/report.ts"], requirement: "report the coverage of the last run" }];
	state.actions = [{ tool: "write", target: "src/report.ts", excerpt: "reads the recorded coverage" }];
	recordRecovery(state, "review", { target: "a.ts" }, { ok: false, text: "a defect", details: { kind: "defect", approved: false } });

	const judge = answeringJudge({ "direction:1": { label: "on_course", confidence: 0.93 } });
	const outcome = await courseCheck({ judge: judge.judge, config: boundaryConfig() }, state);

	expect(outcome.ok).toBe(true);
	expect(outcome.details?.["approved"]).toBe(true);
	expect(judge.calls).toHaveLength(1);
});
