import { describe, expect, test } from "bun:test";
import {
	acceptanceAt,
	boundaryExhausted,
	clearFinishedTask,
	clearResolvedHold,
	diagnosticSummary,
	exhaustBoundary,
	freshState,
	permitAfterIgnoredCalls,
	queueOwnerMessage,
	reaimTask,
	recoveryFeedback,
	recoveryHoldId,
	recordAcceptance,
	recordAction,
	recordActivityOutcome,
	recordDiagnostic,
	recordFailedAction,
	recordJudgeCall,
	recordRecovery,
	recordRefusal,
	recordRefusedCall,
	recordStopBlock,
	registerTask,
	sha256,
	submissionLedger,
	takePendingOwnerMessages,
	type DiagnosticKind,
	type JevState,
} from "../src/state.js";
import { asRecord, type ToolOutcome } from "../src/types.js";
import { POLICY } from "../src/types.js";

function emptyCounts(): Record<DiagnosticKind, number> {
	return { passed: 0, failed: 0, inconclusive: 0, unavailable: 0, not_checked: 0 };
}

/** A task with one approved plan, one accepted aspect and every task-bound marker set. */
function workedTask(): JevState {
	const state = freshState();
	registerTask(state, "first task");
	state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://a-plan.md", planDigest: "d" };
	state.requirementsApproval = { taskFingerprint: state.task?.fingerprint ?? "", items: ["an obligation"] };
	state.planDraft = { taskFingerprint: state.task?.fingerprint ?? "", requirementsDigest: "r", steps: [], outlineApproved: true, details: [] };
	state.planTopics = [{ id: "old", section: "old section", paths: ["src/old.ts"], requirement: "old requirement" }];
	state.hold = { reason: "a finding" };
	state.directionPending = { text: "a later owner message" };
	state.deviation = { tool: "write", target: "docs/x.md", revision: 0 };
	state.completion = { revision: 0, label: "follows", approved: true, confidence: 0.9 };
	state.checkPending = {};
	state.openItem = { boundary: "plan:outline", attempts: 3 };
	state.openItemNotified = "plan:outline:3";
	state.exhausted = ["plan"];
	state.stop = { signature: "a reason", blocks: 2 };
	state.refusedCalls.set("plan", 2);
	recordAcceptance(state, { aspect: "business", revision: 0, label: "serves_business_need", approved: true, confidence: 0.9 });
	return state;
}

describe("T3 - task registration and work revision", () => {
	test("the task fingerprint is the digest of the trimmed request", () => {
		const state = freshState();
		const task = registerTask(state, "  Build the reporter  ");

		expect(task.fingerprint).toBe(sha256("Build the reporter"));
		expect(registerTask(state, "Build the reporter").fingerprint).toBe(task.fingerprint);
	});

	test("a different request drops every approval, retry and exhaustion marker of the previous task", () => {
		const state = workedTask();

		registerTask(state, "second task");

		expect(state.plan).toBeUndefined();
		expect(state.requirementsApproval).toBeUndefined();
		expect(state.planDraft).toBeUndefined();
		expect(state.hold).toBeUndefined();
		expect(state.directionPending).toBeUndefined();
		expect(state.deviation).toBeUndefined();
		expect(state.completion).toBeUndefined();
		expect(state.checkPending).toBeUndefined();
		expect(state.openItem).toBeUndefined();
		expect(state.openItemNotified).toBeUndefined();
		expect(state.exhausted).toEqual([]);
		expect(state.stop).toBeUndefined();
		expect(recordRefusedCall(state, "plan")).toBe(1);
		expect(state.acceptance).toEqual([]);
		expect(state.actions).toEqual([]);
		expect(state.submissions).toEqual([]);
		expect(state.planTopics).toEqual([]);
		expect(state.revision).toBe(0);
		expect(state.actionsSinceCheck).toBe(0);
	});

	test("a successful action raises the revision and caps the kept action records", () => {
		const state = freshState();
		registerTask(state, "task");
		for (let index = 0; index < POLICY.maxActionRecords + 2; index += 1) {
			recordAction(state, { tool: "write", target: `src/f${index}.ts`, excerpt: `change ${index}` });
		}

		expect(state.revision).toBe(POLICY.maxActionRecords + 2);
		expect(state.actionsSinceCheck).toBe(POLICY.maxActionRecords + 2);
		expect(state.actions).toHaveLength(POLICY.maxActionRecords);
		expect(state.actions[0]?.target).toBe("src/f2.ts");
	});

	test("a verification command records evidence without moving the revision", () => {
		const state = freshState();
		registerTask(state, "task");
		state.completion = { revision: 0, label: "follows", approved: true, confidence: 0.9 };

		recordAction(state, { tool: "bash", target: "bun test", excerpt: "141 pass" }, false);

		expect(state.revision).toBe(0);
		expect(state.actionsSinceCheck).toBe(0);
		expect(state.completion).toBeDefined();
		expect(state.actions).toHaveLength(1);

		recordAction(state, { tool: "write", target: "src/a.ts", excerpt: "x" });

		expect(state.revision).toBe(1);
		expect(state.actionsSinceCheck).toBe(1);
		expect(state.completion).toBeUndefined();
	});

	test("a failed consequential call invalidates completion and acceptance without advancing the interval", () => {
		const state = freshState();
		registerTask(state, "task");
		state.completion = { revision: 0, label: "follows", approved: true, confidence: 0.9 };

		recordFailedAction(state, { tool: "bash", target: "touch marker; false", excerpt: "exit 1" });

		expect(state.revision).toBe(1);
		expect(state.actionsSinceCheck).toBe(0);
		expect(state.completion).toBeUndefined();
		expect(state.actions).toHaveLength(1);
	});
});

describe("T5 - acceptance is bound to the work revision", () => {
	test("acceptance recorded at an earlier revision no longer counts after a change", () => {
		const state = freshState();
		registerTask(state, "task");
		recordAcceptance(state, { aspect: "business", revision: state.revision, label: "serves_business_need", approved: true, confidence: 0.9 });
		recordAcceptance(state, { aspect: "architecture", revision: state.revision, label: "sound_for_next_change", approved: true, confidence: 0.9 });

		expect(acceptanceAt(state, "business")?.approved).toBe(true);

		recordAction(state, { tool: "edit", target: "src/a.ts", excerpt: "more work" });

		expect(acceptanceAt(state, "business")).toBeUndefined();
		expect(acceptanceAt(state, "architecture")).toBeUndefined();
	});

	test("recording one aspect replaces its earlier verdict without touching the other", () => {
		const state = freshState();
		registerTask(state, "task");
		recordAcceptance(state, { aspect: "business", revision: 0, label: "business_gap", approved: false, confidence: 0.9 });
		recordAcceptance(state, { aspect: "architecture", revision: 0, label: "sound_for_next_change", approved: true, confidence: 0.9 });
		recordAcceptance(state, { aspect: "business", revision: 0, label: "serves_business_need", approved: true, confidence: 0.9 });

		expect(state.acceptance).toHaveLength(2);
		expect(acceptanceAt(state, "business")?.approved).toBe(true);
		expect(acceptanceAt(state, "architecture")?.approved).toBe(true);
	});
});

describe("stop-block counting stays informational", () => {
	test("the same reason is counted past the bound and remains a count", () => {
		const state = freshState();
		const reason = sha256("acceptance missing");

		expect(recordStopBlock(state, reason)).toEqual({ blocks: 1, exhausted: false });
		expect(recordStopBlock(state, reason)).toEqual({ blocks: 2, exhausted: false });
		expect(recordStopBlock(state, reason)).toEqual({ blocks: 3, exhausted: false });
		expect(recordStopBlock(state, reason)).toEqual({ blocks: POLICY.maxStopBlocks + 1, exhausted: true });
		expect(recordStopBlock(state, reason)).toEqual({ blocks: POLICY.maxStopBlocks + 2, exhausted: true });
	});

	test("a different reason starts its own count", () => {
		const state = freshState();
		recordStopBlock(state, sha256("first reason"));
		recordStopBlock(state, sha256("first reason"));

		expect(recordStopBlock(state, sha256("second reason"))).toEqual({ blocks: 1, exhausted: false });
	});
});

describe("FR-22, FR-23 - the refusal ledger and the OPEN item", () => {
	test("the ledger counts every refusal of a boundary permanently and reports the exact material", () => {
		const state = freshState();
		registerTask(state, "task");
		recordRefusal(state, { boundary: "plan:outline", digest: "a" });

		expect(submissionLedger(state, "plan:outline", "a")).toEqual({ repeat: true, attempts: 1, exhausted: false });
		expect(submissionLedger(state, "plan:outline", "b")).toEqual({ repeat: false, attempts: 1, exhausted: false });
		expect(state.submissions).toHaveLength(1);
	});

	test("a spent budget records the boundary as an OPEN item and blocks it, never approves it", () => {
		const state = freshState();
		const task = registerTask(state, "task");
		for (const digest of ["a", "b", "c"]) {
			recordRefusal(state, { boundary: "plan:outline", digest });
		}

		expect(state.plan).toBeUndefined();
		expect(state.task?.fingerprint).toBe(task.fingerprint);
		expect(state.exhausted).toEqual(["plan"]);
		expect(boundaryExhausted(state, "plan:detail:abc")).toBe(true);
		expect(state.openItem).toEqual({ boundary: "plan:outline", attempts: 3 });
		// A new framing at the spent boundary is still exhausted: the budget ends automated retries.
		expect(submissionLedger(state, "plan:outline", "d").exhausted).toBe(true);
	});

	test("exhaustion is read from its own record, so a changed history cannot undo it", () => {
		const state = freshState();
		state.exhausted = ["plan"];
		state.submissions = [];

		expect(submissionLedger(state, "plan:finalize", "new").exhausted).toBe(true);
	});

	test("exhaustBoundary keeps the refusals it judged and nothing else", () => {
		const state = freshState();
		recordRefusal(state, { boundary: "hold", digest: "a" });

		const item = exhaustBoundary(state, "hold");

		expect(item).toEqual({ boundary: "hold", attempts: 1 });
		expect(state.hold).toBeUndefined();
		expect(state.exhausted).toEqual(["hold"]);
	});
});

describe("FR-23 - a refusal records a finding, never authority", () => {
	const refusalOutcome: ToolOutcome = {
		ok: false,
		text: "the judge selected defect (confidence 0.91)",
		details: { approved: false, label: "defect", confidence: 0.91, kind: "defect" },
	};

	test("a refusal records a stable finding with the exact failed material and result", () => {
		const state = freshState();
		registerTask(state, "Repair the parser");

		const hold = recordRecovery(state, "review", { kind: "diff", target: "a.ts" }, refusalOutcome);

		expect(hold?.id).toMatch(/^finding-/);
		expect(recoveryHoldId(state)).toBe(hold?.id);
		expect(hold?.boundary).toBe("review");
		expect(hold?.material).toContain("a.ts");
		expect(hold?.result).toMatchObject(refusalOutcome.details ?? {});
		expect(asRecord(hold?.result)?.["text"]).toBe(refusalOutcome.text);
		expect(recoveryFeedback(state)).toContain(hold?.id ?? "");
	});

	test("independent failed checks retain their own exact findings without replacing the first", () => {
		const state = freshState();
		const first = recordRecovery(state, "review", { target: "a.ts" }, refusalOutcome);
		recordRecovery(state, "course-check", { claim: "the parser handles empty input" }, {
			ok: false, text: "The evidence is inconclusive.", details: { kind: "unclear", approved: false },
		});
		expect(state.hold).toBe(first);
		expect(state.findings).toHaveLength(2);
		expect(state.findings?.[0]?.material).toBe(JSON.stringify({ target: "a.ts" }));
		expect(state.findings?.[1]?.material).toContain("empty input");
		expect(asRecord(state.findings?.[1]?.result)?.["text"]).toBe("The evidence is inconclusive.");
	});

	test("the recovery feedback is an advisory summary, not a stop or override instruction", () => {
		const state = freshState();
		registerTask(state, "Repair the parser");
		const hold = recordRecovery(state, "review", { kind: "diff", target: "a.ts" }, refusalOutcome);

		const feedback = recoveryFeedback(state);

		expect(feedback).toContain(hold?.id ?? "");
		expect(feedback).toContain("defect");
		expect(feedback.toLowerCase()).toContain("diagnostic");
		expect(feedback).toContain("blocks no action or completion");
		// The exact returned text stays in the finding; the feedback points at it instead of pasting it.
		expect(asRecord(hold?.result)?.["text"]).toBe(refusalOutcome.text);
		expect(feedback).not.toContain(refusalOutcome.text);
		expect(hold?.material).toBe(JSON.stringify({ kind: "diff", target: "a.ts" }));
		// No removed authority or blocking instruction survives in the advisory wording.
		expect(feedback).not.toContain("/jev-continue");
		expect(feedback).not.toContain("phase \"repair\"");
		expect(feedback).not.toContain("do not claim completion");
	});

	test("an inconclusive finding is reported as uncertainty, not a proven deviation", () => {
		const state = freshState();
		registerTask(state, "Repair the parser");
		recordRecovery(state, "course-check", { claim: "x" }, {
			ok: false,
			text: "the course check could not settle the relation",
			details: { kind: "unclear", approved: false },
		});

		const feedback = recoveryFeedback(state);

		expect(feedback).toContain("unclear");
		expect(feedback).toContain("blocks no action or completion");
		expect(feedback).not.toContain("proven deviation");
	});

	test("an ordinary well-formed answer and a skipped check record no finding", () => {
		const state = freshState();

		expect(recordRecovery(state, "consult", { question: "q" }, { ok: true, text: "yes", details: { verdict: "yes" } })).toBeUndefined();
		expect(recordRecovery(state, "course-check", {}, { ok: false, text: "prerequisite", details: { skipped: true } })).toBeUndefined();
		expect(recordRecovery(state, "triage", {}, { ok: false, text: "request is missing", details: { kind: "invalid" } })).toBeUndefined();
		expect(state.hold).toBeUndefined();
	});

	test("an unrelated refusal preserves the standing finding, and only its exact id clears it", () => {
		const state = freshState();
		registerTask(state, "Repair the parser");
		const first = recordRecovery(state, "review", { target: "a.ts" }, refusalOutcome);
		const other = recordRecovery(state, "action", { tool: "edit" }, refusalOutcome);
		recordRecovery(state, "review", { target: "rewritten-recovery" }, { ok: false, text: "recovery refused", details: { approved: false } });
		expect(state.hold?.material).toBe(JSON.stringify({ target: "a.ts" }));
		expect(state.hold?.result).toEqual(first?.result);

		expect(other?.id).toBe(first?.id);
		expect(state.hold?.boundary).toBe("review");
		expect(clearResolvedHold(state, "finding-other")).toBe(false);
		expect(state.hold).toBeDefined();
		expect(clearResolvedHold(state, first?.id ?? "")).toBe(true);
		expect(state.hold).toBeUndefined();
	});

	test("a spent budget records the boundary OPEN with no continuation authority in state", () => {
		const state = freshState();
		registerTask(state, "task");
		for (const digest of ["a", "b", "c"]) recordRefusal(state, { boundary: "plan:outline", digest });

		expect(state.exhausted).toEqual(["plan"]);
		expect(state.openItem).toEqual({ boundary: "plan:outline", attempts: 3 });
		expect(Object.hasOwn(state, "continuation")).toBe(false);
		expect(Object.hasOwn(state, "repair")).toBe(false);
	});

	test("owner messages keep chronological history and a takeable queue", () => {
		const state = freshState();

		queueOwnerMessage(state, "  Build the report  ");
		queueOwnerMessage(state, "Also keep the old format");

		expect(state.ownerMessages).toEqual(["Build the report", "Also keep the old format"]);
		expect(takePendingOwnerMessages(state)).toEqual(["Build the report", "Also keep the old format"]);
		expect(state.pendingOwnerMessages).toEqual([]);
	});
});

describe("FR-29 - re-aiming and finishing a task", () => {
	test("a re-aim clears every approval and does not exhaust the plan on the new course", () => {
		const state = freshState();
		registerTask(state, "first task");
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://a-plan.md", planDigest: "d" };
		state.requirementsApproval = { taskFingerprint: state.task?.fingerprint ?? "", items: ["an obligation"] };
		state.hold = { reason: "a finding" };
		state.directionPending = { text: "new direction" };
		for (const digest of ["a", "b", "c"]) {
			recordRefusal(state, { boundary: "plan:outline", digest });
		}

		const task = reaimTask(state, "new direction");

		expect(task.fingerprint).toBe(sha256("new direction"));
		expect(state.task?.request).toBe("new direction");
		expect(state.plan).toBeUndefined();
		expect(state.requirementsApproval).toBeUndefined();
		expect(state.hold).toBeUndefined();
		expect(state.directionPending).toBeUndefined();
		expect(state.exhausted).toEqual([]);
		expect(state.openItem).toBeUndefined();
		expect(Object.hasOwn(state, "continuation")).toBe(false);
	});

	test("a finished task is dropped for the next prompt; an unfinished one is kept", () => {
		const state = freshState();
		registerTask(state, "task");
		recordAction(state, { tool: "write", target: "src/a.ts", excerpt: "x" });

		expect(clearFinishedTask(state)).toBe(false);
		expect(state.task).toBeDefined();

		state.completion = { revision: state.revision - 1, label: "follows", approved: true, confidence: 0.9 };
		expect(clearFinishedTask(state)).toBe(false);

		state.completion = { revision: state.revision, label: "follows", approved: true, confidence: 0.9 };
		expect(clearFinishedTask(state)).toBe(true);
		expect(state.task).toBeUndefined();
		expect(state.revision).toBe(0);
		expect(state.completion).toBeUndefined();
	});
});

describe("session accounting and ignored-call records", () => {
	test("ignored gate calls record an OPEN item and authorize nothing", () => {
		const state = freshState();

		permitAfterIgnoredCalls(state, "triage", 3);

		expect(state.openItem).toEqual({ boundary: "triage", attempts: 3 });
		expect(boundaryExhausted(state, "triage")).toBe(false);
		expect(Object.hasOwn(state, "continuation")).toBe(false);
	});

	test("activity outcomes and judge usage survive a task change", () => {
		const state = freshState();
		recordActivityOutcome(state, "jev_text_review", true);
		recordActivityOutcome(state, "jev_text_review", false);
		recordJudgeCall(state, { inputTokens: 120, outputTokens: 12 });

		registerTask(state, "first task");
		registerTask(state, "second task");

		expect(state.stats).toEqual({ jev_text_review: { ok: 1, fail: 1 } });
		expect(state.usage).toEqual({ judgeCalls: 1, inputTokens: 120, outputTokens: 12 });
	});
});

describe("diagnostic state API", () => {
	test("fresh state starts with zeroed check and work diagnostic counts", () => {
		const state = freshState();

		expect(state.diagnostics?.checks).toEqual(emptyCounts());
		expect(state.diagnostics?.work).toEqual(emptyCounts());
	});

	test.each([
		["a passed verdict", { ok: true, text: "approved", details: { approved: true } } as ToolOutcome, "passed"],
		["a settled diagnostic consult", { ok: true, text: "yes", details: { verdict: "yes" } } as ToolOutcome, "passed"],
		["an explicit refusal", { ok: false, text: "no", details: { approved: false } } as ToolOutcome, "failed"],
		["a revise verdict", { ok: false, text: "revise", details: { verdict: "revise" } } as ToolOutcome, "failed"],
		["an unavailable check", { ok: false, text: "offline", details: { kind: "unavailable" } } as ToolOutcome, "unavailable"],
		["an unclear verdict", { ok: false, text: "unclear", details: { kind: "unclear" } } as ToolOutcome, "inconclusive"],
		["an unusable answer", { ok: false, text: "unusable", details: { kind: "unusable" } } as ToolOutcome, "inconclusive"],
		["an untyped uncertain answer", { ok: false, text: "unsettled", details: { verdict: "unclear" } } as ToolOutcome, "inconclusive"],
		["a skipped check", { ok: false, text: "skipped", details: { skipped: true } } as ToolOutcome, "not_checked"],
		["a missing prerequisite", { ok: false, text: "no plan", details: { prerequisite: "approved plan" } } as ToolOutcome, "not_checked"],
		["an invalid submission", { ok: false, text: "bad input", details: { kind: "invalid" } } as ToolOutcome, "not_checked"],
		["a stale answer", { ok: false, text: "stale", details: { kind: "stale" } } as ToolOutcome, "not_checked"],
		["an external review with blockers", { ok: true, text: "reviewed", details: { blocked: true, blockers: 1 } } as ToolOutcome, "failed"],
		["an unsettled fragment check", { ok: false, text: "unsettled", details: { approved: false, unsettled: [{ fragment: "claim" }] } } as ToolOutcome, "inconclusive"],
	] as const)("records %s as %s", (_label, outcome, expected) => {
		const state = freshState();

		expect(recordDiagnostic(state, outcome)).toBe(expected);
		expect(state.diagnostics?.checks[expected]).toBe(1);
		expect(state.diagnostics?.work[expected]).toBe(0);
	});

	test("an explicit approved:false fails even when the call itself succeeded", () => {
		const state = freshState();

		expect(recordDiagnostic(state, { ok: true, text: "rejected", details: { approved: false } })).toBe("failed");
		expect(state.diagnostics?.checks.failed).toBe(1);
	});

	test("work diagnostics count on both ledgers, explicit ones only as checks", () => {
		const state = freshState();
		const passed: ToolOutcome = { ok: true, text: "on course", details: { approved: true } };
		const unavailable: ToolOutcome = { ok: false, text: "offline", details: { kind: "unavailable" } };

		recordDiagnostic(state, passed);
		recordDiagnostic(state, passed);
		recordDiagnostic(state, unavailable, true);
		recordDiagnostic(state, passed, true);

		expect(state.diagnostics?.checks).toEqual({ ...emptyCounts(), passed: 3, unavailable: 1 });
		expect(state.diagnostics?.work).toEqual({ ...emptyCounts(), passed: 1, unavailable: 1 });
	});

	test("the summary reports diagnostic counts and total without claiming acceptance", () => {
		const state = freshState();
		recordDiagnostic(state, { ok: true, text: "approved", details: { approved: true } });
		recordDiagnostic(state, { ok: false, text: "offline", details: { kind: "unavailable" } }, true);

		const summary = diagnosticSummary(state);

		expect(summary).toContain("passed");
		expect(summary).toContain("unavailable");
		expect(summary).toMatch(/total/i);
		expect(summary).toMatch(/diagnostic/i);
		// Counts are evidence, never an acceptance or permission claim.
		expect(summary).not.toMatch(/acceptance (?:passed|approved)|is approved|approval granted/i);
	});

	test("an empty session summarizes zero diagnostics", () => {
		const state = freshState();

		const summary = diagnosticSummary(state);

		expect(summary).toMatch(/diagnostic/i);
		expect(summary).toMatch(/0/);
	});

	test("continuation and repair authority are not part of the state surface", async () => {
		const state = freshState();
		Object.assign(state, { autonomous: true as const });
		registerTask(state, "Implement the bound autonomous objective");
		for (const digest of ["first", "second", "third"]) {
			recordRefusal(state, { boundary: "action", digest });
		}
		exhaustBoundary(state, "action");

		expect(state.openItem).toEqual({ boundary: "action", attempts: 3 });
		expect(Object.hasOwn(state, "continuation")).toBe(false);
		expect(Object.hasOwn(state, "repair")).toBe(false);

		// Runtime import on purpose: naming a removed export in a static import would fail the build
		// before the test could demonstrate that the authority API is gone.
		const stateModule = await import("../src/state.js");
		for (const removed of ["allowContinuation", "continuationAllowed", "repairBinding", "permittedRepair"]) {
			expect(Object.hasOwn(stateModule, removed), `${removed} must be removed with the authority contract`).toBe(false);
		}
	});
});
