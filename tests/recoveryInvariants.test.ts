import { expect, test } from "bun:test";
import { createJevController } from "../src/controller.js";
import { recoveryGate } from "../src/gates.js";
import { clearResolvedHold, freshState, recordRecovery, recordRefusal, registerTask, submissionLedger } from "../src/state.js";
import { answeringJudge, boundaryConfig, fakeCtx, fakePi, fakeZod, toolFailed } from "./helpers.js";

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
	expect(toolFailed(await pi.callTool("jev_consult", input, ctx))).toBe(true);
	expect(toolFailed(await pi.callTool("jev_consult", input, ctx))).toBe(true);
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

test("FR-67: an inconclusive action finding admits the corrected invocation to fresh judgment", () => {
	const call = { path: "src/a.ts", content: "the recorded report" };
	const uncertain = freshState();
	registerTask(uncertain, "Repair the recorded report.");
	recordRecovery(uncertain, "action:4", { action: { tool: "write" } }, {
		ok: true, text: "the proposed invocation answered on_course",
		details: { kind: "unclear", approved: false, label: "on_course", confidence: 0.38 },
	});
	expect(recoveryGate(uncertain, "write", call).block).toBe(false);
	// A held judge step is still a judge step: an open finding never admits one.
	expect(recoveryGate(uncertain, "jev_acceptance", {}).block).toBe(true);

	const defect = freshState();
	registerTask(defect, "Repair the recorded report.");
	recordRecovery(defect, "action:4", { action: { tool: "write" } }, {
		ok: true, text: "the proposed invocation answered off_course",
		details: { kind: "defect", approved: false, label: "off_course", confidence: 0.94 },
	});
	expect(recoveryGate(defect, "write", call).block).toBe(true);

	const review = freshState();
	registerTask(review, "Repair the recorded report.");
	recordRecovery(review, "review", { target: "a.ts" }, {
		ok: false, text: "the review was inconclusive", details: { kind: "unclear", approved: false },
	});
	expect(recoveryGate(review, "write", call).block).toBe(true);
});
