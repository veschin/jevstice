import { describe, expect, test } from "bun:test";
import type { AutonomyScope, AutonomyScopeFence } from "../autonomy/scope.js";
import type { AutonomyEvent, ProcessIdentity } from "../autonomy/store.js";
import {
	exactCommandCalls,
	exactTargetRecords,
	nativeBashCalls,
	receiptCovering,
	terminalScopeProof,
} from "../tools/autonomy-smoke-oracles.js";

const BOOT = "00000000-0000-4000-8000-000000000001";

const SCOPE: AutonomyScope = {
	runId: "run-1",
	epoch: 1,
	unit: "jevstice-run-1-1-cff42d4a.scope",
	bootId: BOOT,
	controlGroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/jevstice-run-1-1-cff42d4a.scope",
	device: "33",
	inode: "33133",
	invocationId: "0123456789abcdef0123456789abcdef",
};

const CHILD: ProcessIdentity = { pid: 116167, start: "3715322", group: 116167, parent: 116145, bootId: BOOT };

function fenceOf(intentIds: string[], scope: AutonomyScope = SCOPE): AutonomyScopeFence {
	return { scope, recordedEpoch: 1, generation: 1, observedAt: 1, intentIds };
}

describe("terminal scope proof", () => {
	test("accepts the fenced state a terminal driver actually leaves: no live child, exact receipt, quiescent scope", () => {
		const proofs = terminalScopeProof({
			scope: SCOPE,
			fences: [fenceOf([])],
			pendingIds: [],
			child: CHILD,
			childAlive: false,
			empty: true,
		});
		expect(proofs.every(proof => proof.ok)).toBe(true);
	});

	test("rejects a live child instead of treating it as terminal evidence", () => {
		const proofs = terminalScopeProof({
			scope: SCOPE,
			fences: [fenceOf([])],
			pendingIds: [],
			child: CHILD,
			childAlive: true,
			empty: true,
		});
		expect(proofs.every(proof => proof.ok)).toBe(false);
	});

	test("rejects a terminal run with no recorded child", () => {
		const proofs = terminalScopeProof({
			scope: SCOPE,
			fences: [fenceOf([])],
			pendingIds: [],
			child: undefined,
			childAlive: false,
			empty: true,
		});
		expect(proofs.every(proof => proof.ok)).toBe(false);
	});

	test("rejects a receipt for another canonical scope even when the unit name matches", () => {
		const other = { ...SCOPE, invocationId: "fedcba9876543210fedcba9876543210" };
		const proofs = terminalScopeProof({
			scope: SCOPE,
			fences: [fenceOf([], other)],
			pendingIds: [],
			child: CHILD,
			childAlive: false,
			empty: true,
		});
		expect(proofs.every(proof => proof.ok)).toBe(false);
	});

	test("rejects a receipt that does not cover the exact pending identities", () => {
		const covered = terminalScopeProof({
			scope: SCOPE,
			fences: [fenceOf(["a", "b"])],
			pendingIds: ["b", "a"],
			child: CHILD,
			childAlive: false,
			empty: true,
		});
		expect(covered.every(proof => proof.ok)).toBe(true);

		const uncovered = terminalScopeProof({
			scope: SCOPE,
			fences: [fenceOf(["a"])],
			pendingIds: ["b"],
			child: CHILD,
			childAlive: false,
			empty: true,
		});
		expect(uncovered.every(proof => proof.ok)).toBe(false);
	});

	test("fails closed when quiescence cannot be proven", () => {
		const proofs = terminalScopeProof({
			scope: SCOPE,
			fences: [fenceOf([])],
			pendingIds: [],
			child: CHILD,
			childAlive: false,
			empty: false,
			emptyProblem: "scope unit has no control group while its unit is active",
		});
		expect(proofs.every(proof => proof.ok)).toBe(false);
	});

	test("receiptCovering compares the full canonical identity", () => {
		expect(receiptCovering([fenceOf([])], SCOPE, [])).toBeDefined();
		expect(receiptCovering([fenceOf([], { ...SCOPE, device: "34" })], SCOPE, [])).toBeUndefined();
	});
});

function sessionEntries(): Array<Record<string, unknown>> {
	return [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_read",
						name: "bash",
						arguments: { command: "sha256sum async-effect.sh async-extra.sh; ls -la" },
					},
					{ type: "toolCall", id: "call_probe", name: "bash", arguments: { command: "sh async-extra.sh" } },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call_read",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "a1d8c46d  async-extra.sh" }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call_probe",
				toolName: "bash",
				isError: true,
				content: [
					{
						type: "text",
						text: "Jevstice refuses this change while an earlier effect is still running or has an unobserved outcome: call_00_ZLBXPxbsn5Zt8938AjXN9437.",
					},
				],
			},
		},
	];
}

describe("exact probe invocation", () => {
	test("selects only the actual probe payload, never the read-only command that mentions the script", () => {
		const calls = exactCommandCalls(sessionEntries(), "sh async-extra.sh");
		expect(calls.map(call => call.callId)).toEqual(["call_probe"]);
		expect(calls[0]?.result?.isError).toBe(true);
		expect(calls[0]?.result?.text).toContain("still running or has an unobserved outcome");
	});

	test("binds every result by its own toolCallId", () => {
		const calls = nativeBashCalls(sessionEntries());
		expect(calls.map(call => [call.callId, call.result?.isError])).toEqual([
			["call_read", false],
			["call_probe", true],
		]);
	});

	test("reads a message delivered at the top level as well as one wrapped in .message", () => {
		const wrapped = exactCommandCalls(sessionEntries(), "sh async-extra.sh");
		const topLevel = exactCommandCalls(
			[
				{ role: "assistant", content: [{ type: "toolCall", id: "call_top", name: "bash", arguments: { command: "sh async-extra.sh" } }] },
				{ role: "toolResult", toolCallId: "call_top", toolName: "bash", isError: true, content: "refused" },
			],
			"sh async-extra.sh",
		);
		expect(wrapped.length).toBe(1);
		expect(topLevel.map(call => [call.callId, call.result?.text])).toEqual([["call_top", "refused"]]);
	});

	test("a call without its blocked result is not proof of refusal", () => {
		const calls = exactCommandCalls(sessionEntries().slice(0, 1), "sh async-extra.sh");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.result).toBeUndefined();
	});
});

describe("exact recorded target", () => {
	const events: AutonomyEvent[] = [
		{
			sequence: 112,
			kind: "result.recorded",
			data: {
				id: "call_read",
				tool: "bash",
				target: "sha256sum async-effect.sh async-extra.sh; ls -la",
				matched: false,
				completed: true,
			},
		},
		{
			sequence: 120,
			kind: "result.recorded",
			data: { id: "call_probe", tool: "bash", target: "sh async-extra.sh", matched: false, completed: true },
		},
	];

	test("ignores a result whose target merely contains the probe script name", () => {
		expect(exactTargetRecords(events, "sh async-extra.sh").map(record => record.id)).toEqual(["call_probe"]);
	});

});
