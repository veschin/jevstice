import { describe, expect, test } from "bun:test";
import {
	acceptanceAt,
	freshState,
	recordAcceptance,
	recordAction,
	recordStopBlock,
	registerTask,
	sha256,
} from "../src/state.js";
import { POLICY } from "../src/types.js";

describe("T3 - task registration and work revision", () => {
	test("the task fingerprint is the digest of the trimmed request", () => {
		const state = freshState();
		const task = registerTask(state, "  Build the reporter  ");

		expect(task.fingerprint).toBe(sha256("Build the reporter"));
		expect(registerTask(state, "Build the reporter").fingerprint).toBe(task.fingerprint);
	});

	test("a different request starts fresh work and drops every approval", () => {
		const state = freshState();
		registerTask(state, "first task");
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://a-plan.md", planDigest: "d", confidence: 0.9 };
		recordAcceptance(state, { aspect: "business", revision: 0, label: "serves_business_need", approved: true, confidence: 0.9 });
		recordAction(state, { tool: "write", target: "src/a.ts", excerpt: "wrote a" });

		registerTask(state, "second task");

		expect(state.plan).toBeUndefined();
		expect(state.acceptance).toEqual([]);
		expect(state.revision).toBe(0);
		expect(state.actions).toEqual([]);
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

describe("T5 - the stop refusal is bounded per unchanged reason", () => {
	test("the same reason blocks a bounded number of times and then stops blocking", () => {
		const state = freshState();
		const reason = sha256("acceptance missing");

		expect(recordStopBlock(state, reason)).toEqual({ block: true, blocks: 1 });
		expect(recordStopBlock(state, reason)).toEqual({ block: true, blocks: 2 });
		expect(recordStopBlock(state, reason)).toEqual({ block: true, blocks: 3 });
		expect(recordStopBlock(state, reason)).toEqual({ block: false, blocks: POLICY.maxStopBlocks + 1 });
		expect(recordStopBlock(state, reason)).toEqual({ block: false, blocks: POLICY.maxStopBlocks + 2 });
	});

	test("a different reason starts its own count", () => {
		const state = freshState();
		recordStopBlock(state, sha256("first reason"));
		recordStopBlock(state, sha256("first reason"));

		expect(recordStopBlock(state, sha256("second reason"))).toEqual({ block: true, blocks: 1 });
	});
});
