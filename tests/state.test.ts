import { describe, expect, test } from "bun:test";
import {
	acceptanceAt,
	boundaryExhausted,
	clearFinishedTask,
	clearResolvedHold,
	continuationAllowed,
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
	type JevState,
} from "../src/state.js";
import { asRecord, type ToolOutcome } from "../src/types.js";
import { POLICY } from "../src/types.js";

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

describe("T5 - a blocked stop never settles the session", () => {
	test("the same reason is counted past the bound and stays an OPEN item", () => {
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

describe("FR-23 - a refusal records a recoverable finding, never authority", () => {
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
		expect(recoveryFeedback(state)).toContain("findingId");
		expect(continuationAllowed(state)).toBe(false);
	});

	test("the recovery feedback names the class and where the original finding stays, not its payload", () => {
		const state = freshState();
		registerTask(state, "Repair the parser");
		const hold = recordRecovery(state, "review", { kind: "diff", target: "a.ts" }, refusalOutcome);

		const feedback = recoveryFeedback(state);

		expect(feedback).toContain(hold?.id ?? "");
		expect(feedback).toContain("Class: defect");
		expect(feedback).toContain('jev_context({"action":"list"})');
		// The exact returned text stays in the finding; the feedback points at it instead of pasting it.
		expect(asRecord(hold?.result)?.["text"]).toBe(refusalOutcome.text);
		expect(feedback).not.toContain(refusalOutcome.text);
		expect(hold?.material).toBe(JSON.stringify({ kind: "diff", target: "a.ts" }));
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

		expect(feedback).toContain("Class: unclear");
		expect(feedback).toContain("not a proven deviation");
		expect(feedback).toContain("/jev-continue");
		expect(continuationAllowed(state)).toBe(false);
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

	test("a spent budget records the boundary OPEN without continuation permission", () => {
		const state = freshState();
		registerTask(state, "task");
		for (const digest of ["a", "b", "c"]) recordRefusal(state, { boundary: "plan:outline", digest });

		expect(state.exhausted).toEqual(["plan"]);
		expect(state.openItem).toEqual({ boundary: "plan:outline", attempts: 3 });
		expect(continuationAllowed(state)).toBe(false);
		expect(state.continuation).toBeUndefined();
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

	test("a finding holds a finished task open", () => {
		const state = freshState();
		registerTask(state, "task");
		recordAction(state, { tool: "write", target: "src/a.ts", excerpt: "x" });
		state.completion = { revision: state.revision, label: "follows", approved: true, confidence: 0.9 };
		state.hold = { reason: "a defect" };

		expect(clearFinishedTask(state)).toBe(false);
		expect(state.task).toBeDefined();
	});
});

describe("session accounting and ignored-call continuation", () => {
	test("ignored gate calls record an OPEN item and authorize no continuation", () => {
		const state = freshState();

		permitAfterIgnoredCalls(state, "triage", 3);

		expect(state.openItem).toEqual({ boundary: "triage", attempts: 3 });
		expect(boundaryExhausted(state, "triage")).toBe(false);
		expect(continuationAllowed(state)).toBe(false);
		expect(state.continuation).toBeUndefined();
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

describe("FR-57 - strict autonomous authorization", () => {
	test("an exhausted boundary remains OPEN without authorizing autonomous continuation", () => {
		const state = Object.assign(freshState(), { autonomous: true as const });
		registerTask(state, "Implement the bound autonomous objective");
		for (const digest of ["first", "second", "third"]) {
			recordRefusal(state, { boundary: "action", digest });
		}

		exhaustBoundary(state, "action");

		expect(state.openItem).toEqual({ boundary: "action", attempts: 3 });
		expect(continuationAllowed(state)).toBe(false);
		expect(state.continuation).toBeUndefined();
	});
});
