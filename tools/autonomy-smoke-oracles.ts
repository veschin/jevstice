/**
 * Pure oracles for the live autonomy smoke harness.
 *
 * The harness itself needs real processes, cgroups and a native host; these helpers decide only
 * what recorded evidence proves, so the exact false positives a live run produced can be tested
 * offline without starting a native actor.
 */
import type { AutonomyScope, AutonomyScopeFence } from "../autonomy/scope.js";
import type { AutonomyEvent, ProcessIdentity } from "../autonomy/store.js";
import { asRecord } from "../src/types.js";


function json(value: unknown): string {
	return JSON.stringify(value ?? null) ?? "null";
}

/** Full canonical scope identity; a unit name or a subset is never evidence of the same scope. */
export function sameScope(left: AutonomyScope | undefined, right: AutonomyScope | undefined): boolean {
	if (left === undefined || right === undefined) return false;
	return (
		left.runId === right.runId &&
		left.epoch === right.epoch &&
		left.unit === right.unit &&
		left.bootId === right.bootId &&
		left.controlGroup === right.controlGroup &&
		left.device === right.device &&
		left.inode === right.inode &&
		left.invocationId === right.invocationId
	);
}

/** The durable receipt that covers exactly these pending identities for exactly this scope. */
export function receiptCovering(
	fences: readonly AutonomyScopeFence[],
	scope: AutonomyScope,
	intentIds: readonly string[],
): AutonomyScopeFence | undefined {
	const wanted = [...intentIds].sort();
	return fences.find(fence => {
		if (!sameScope(fence.scope, scope)) return false;
		const covered = [...fence.intentIds].sort();
		return covered.length === wanted.length && covered.every((id, index) => id === wanted[index]);
	});
}

export function scopeBrief(scope: AutonomyScope | undefined): Record<string, unknown> {
	return scope === undefined
		? { scope: null }
		: {
				runId: scope.runId,
				epoch: scope.epoch,
				unit: scope.unit,
				bootId: scope.bootId,
				controlGroup: scope.controlGroup,
				device: scope.device,
				inode: scope.inode,
				invocationId: scope.invocationId,
			};
}

export interface ScopeProofEntry {
	name: string;
	ok: boolean;
	detail: string;
}

/**
 * Terminal runs are proven by the durable fence, not by a live child. By the time the driver
 * reports a terminal status it has already fenced the whole executor scope: the unit and its
 * control group are gone and the recorded child is dead. Requiring live canonical membership
 * here would reject exactly the state the fence is supposed to produce.
 */
export function terminalScopeProof(input: {
	scope: AutonomyScope;
	fences: readonly AutonomyScopeFence[];
	pendingIds: readonly string[];
	child: ProcessIdentity | undefined;
	childAlive: boolean;
	empty: boolean;
	emptyProblem?: string;
}): ScopeProofEntry[] {
	const receipt = input.fences.find(fence => sameScope(fence.scope, input.scope));
	const covered = receiptCovering(input.fences, input.scope, input.pendingIds) !== undefined;
	return [
		{
			name: "the terminal run has a durable receipt for the exact canonical scope",
			ok: receipt !== undefined,
			detail: json({ scope: scopeBrief(input.scope), receipt: receipt ?? null }),
		},
		{
			name: "the terminal receipt covers the exact pending identities for this scope",
			ok: covered,
			detail: json({ pending: [...input.pendingIds], receipt: receipt?.intentIds ?? null }),
		},
		{
			name: "the fenced whole-executor scope is positively quiescent",
			ok: input.empty,
			detail: input.empty
				? json({ scope: scopeBrief(input.scope) })
				: input.emptyProblem ?? json({ scope: scopeBrief(input.scope) }),
		},
		{
			name: "the recorded child is no longer executable",
			ok: input.child !== undefined && !input.childAlive,
			detail: json({ child: input.child ?? null, alive: input.childAlive }),
		},
	];
}

export interface NativeToolCall {
	callId: string;
	tool: string;
	command: string;
	result?: { isError: boolean; text: string };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const record = asRecord(item);
		if (typeof record?.["text"] === "string") parts.push(record["text"]);
	}
	return parts.join("\n");
}

/**
 * The exact bash calls and results the native session retained. Messages may be wrapped in
 * `.message` or delivered at the top level; both shapes are read, and a result is bound only by
 * its own toolCallId.
 */
export function nativeBashCalls(entries: readonly Record<string, unknown>[]): NativeToolCall[] {
	const calls = new Map<string, NativeToolCall>();
	const order: string[] = [];
	for (const entry of entries) {
		const message = asRecord(entry["message"]) ?? entry;
		const content = message["content"];
		if (message["role"] !== "assistant" || !Array.isArray(content)) continue;
		for (const item of content) {
			const call = asRecord(item);
			if (call === undefined || call["type"] !== "toolCall" || call["name"] !== "bash") continue;
			const callId = call["id"];
			const args = asRecord(call["arguments"]);
			if (typeof callId !== "string" || typeof args?.["command"] !== "string") continue;
			if (calls.has(callId)) continue;
			calls.set(callId, { callId, tool: "bash", command: args["command"] });
			order.push(callId);
		}
	}
	for (const entry of entries) {
		const message = asRecord(entry["message"]) ?? entry;
		if (message["role"] !== "toolResult" || message["toolName"] !== "bash") continue;
		const callId = message["toolCallId"];
		const call = typeof callId === "string" ? calls.get(callId) : undefined;
		if (call === undefined || call.result !== undefined) continue;
		call.result = { isError: message["isError"] === true, text: contentText(message["content"]) };
	}
	const result: NativeToolCall[] = [];
	for (const callId of order) {
		const call = calls.get(callId);
		if (call !== undefined) result.push(call);
	}
	return result;
}

/** The calls whose actual payload is exactly this command; no substring or target inference. */
export function exactCommandCalls(entries: readonly Record<string, unknown>[], command: string): NativeToolCall[] {
	return nativeBashCalls(entries).filter(call => call.command === command);
}

export interface ExactResultRecord {
	id: string;
	target: string;
	matched: boolean;
	completed: boolean;
}

/** Stored results whose recorded target is exactly this command, with their authorization field. */
export function exactTargetRecords(events: readonly AutonomyEvent[], command: string): ExactResultRecord[] {
	const records: ExactResultRecord[] = [];
	for (const event of events) {
		if (event.kind !== "result.recorded") continue;
		const data = asRecord(event.data);
		if (data === undefined || data["target"] !== command) continue;
		records.push({
			id: typeof data["id"] === "string" ? data["id"] : "",
			target: command,
			matched: data["matched"] === true,
			completed: data["completed"] === true,
		});
	}
	return records;
}
