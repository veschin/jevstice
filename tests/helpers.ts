/**
 * Shared test seams: a fake judge, a fake schema builder, a fake omp host and the artifacts a plan
 * review reads. Nothing here touches the network.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Judge, JudgeAnswer, JudgeFailureKind, JudgeQuestion } from "../src/judge.js";
import type { PiApi, PiToolDefinition, SchemaBuilder, SchemaLike } from "../src/controller.js";
import { asRecord } from "../src/types.js";

export interface JudgeCall {
	state: unknown;
	questions: readonly JudgeQuestion[];
}

/** One typed fake answer: a choice label, a score, a yes probability and its confidence. */
export interface FakeAnswer {
	label?: string;
	probability?: number;
	score?: number;
	confidence?: number;
}

export interface FakeJudge {
	judge: Judge;
	calls: JudgeCall[];
}

/** One fake answer, given directly or derived from the question the activity submitted. */
export type FakeAnswerSource = FakeAnswer | ((question: JudgeQuestion) => FakeAnswer | undefined);

/** A judge that answers the named questions from a table; an unlisted question fails the outcome. */
export function answeringJudge(table: Record<string, FakeAnswerSource>): FakeJudge {
	const calls: JudgeCall[] = [];
	const judge: Judge = async (state, questions) => {
		calls.push({ state, questions });
		const answers: JudgeAnswer[] = [];
		for (const question of questions) {
			const source = table[question.name];
			const spec = typeof source === "function" ? source(question) : source;
			if (spec === undefined) return { ok: false, kind: "unusable", problem: `no fake answer for '${question.name}'` };
			const confidence = spec.confidence ?? 0.95;
			if (question.mode === "choice") {
				const label = spec.label;
				if (label === undefined || question.options?.[label] === undefined) {
					return { ok: false, kind: "unusable", problem: `fake label '${label ?? "(none)"}' was not offered for '${question.name}'` };
				}
				answers.push({ name: question.name, mode: "choice", label, confidence });
				continue;
			}
			if (question.mode === "score") {
				answers.push({ name: question.name, mode: "score", score: spec.score ?? spec.probability ?? 0, confidence });
				continue;
			}
			answers.push({ name: question.name, mode: "noul", probability: spec.probability ?? 0, confidence });
		}
		return { ok: true, model: "fake", answers };
	};
	return { judge, calls };
}

/** A judge that always fails, for the fail-closed paths. */
export function failingJudge(problem: string, kind: JudgeFailureKind = "unavailable"): Judge {
	return async () => ({ ok: false, problem, kind });
}

/** The schema builder the host injects; it only has to build, never validate. */
export function fakeZod(): SchemaBuilder {
	const node = (): SchemaLike => ({ describe: () => node(), optional: () => node() });
	return {
		object: () => node(),
		array: () => node(),
		string: () => node(),
		boolean: () => node(),
		number: () => node(),
		enum: () => node(),
	};
}

export interface EmittedMessage {
	customType: string;
	content: string;
	deliverAs?: string;
}

export interface FakePi {
	api: PiApi;
	tools: Map<string, PiToolDefinition>;
	messages: EmittedMessage[];
	/** Run every handler registered for an event and collect the returned results. */
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
	/** Run one registered tool the way the host does, with an injected context. */
	callTool(name: string, params: unknown, ctx: unknown): Promise<unknown>;
}

export function fakePi(): FakePi {
	const tools = new Map<string, PiToolDefinition>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const messages: EmittedMessage[] = [];
	const api: PiApi = {
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		sendMessage(payload, options) {
			const record = asRecord(payload) ?? {};
			messages.push({
				customType: typeof record["customType"] === "string" ? record["customType"] : "",
				content: typeof record["content"] === "string" ? record["content"] : "",
				deliverAs: options?.deliverAs,
			});
		},
		logger: { warn: () => {} },
	};
	return {
		api,
		tools,
		messages,
		async emit(event, payload, ctx) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
			return results;
		},
		async callTool(name, params, ctx) {
			const tool = tools.get(name);
			if (tool === undefined) throw new Error(`tool '${name}' is not registered`);
			return tool.execute("call-1", params, undefined, undefined, ctx);
		},
	};
}

/** The text of a tool result. */
export function toolText(result: unknown): string {
	const content = asRecord(result)?.["content"];
	if (!Array.isArray(content)) return "";
	const first = asRecord(content[0]);
	const text = first?.["text"];
	return typeof text === "string" ? text : "";
}

/** Whether a tool result was flagged as an error. */
export function toolFailed(result: unknown): boolean {
	return asRecord(result)?.["isError"] === true;
}

/** The details object of a tool result. */
export function toolDetails(result: unknown): Record<string, unknown> {
	return asRecord(asRecord(result)?.["details"]) ?? {};
}

/** A host context with a session id and an artifact root. */
export function fakeCtx(options: { artifactsDir?: string | null; sessionId?: string } = {}): unknown {
	return {
		ui: { notify: () => {} },
		sessionManager: {
			getArtifactsDir: () => options.artifactsDir ?? null,
			getSessionId: () => options.sessionId ?? "session-1",
		},
	};
}

/**
 * A host context whose session can be switched the way the host switches it: `newSession` mints a
 * fresh session id and a fresh artifact root, and the plan approval copies the artifacts over only
 * after the switch has been emitted.
 */
export interface SwitchableHost {
	ctx: unknown;
	switchTo(next: { artifactsDir?: string | null; sessionId?: string }): void;
}

export function switchableCtx(options: { artifactsDir?: string | null; sessionId?: string } = {}): SwitchableHost {
	let artifactsDir = options.artifactsDir ?? null;
	let sessionId = options.sessionId ?? "session-1";
	const ctx = {
		ui: { notify: () => {} },
		sessionManager: {
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => sessionId,
		},
	};
	return {
		ctx,
		switchTo(next) {
			if (next.artifactsDir !== undefined) artifactsDir = next.artifactsDir;
			if (next.sessionId !== undefined) sessionId = next.sessionId;
		},
	};
}

/** Create a session artifact root and write the given `local://` files into it. */
export async function fakeArtifacts(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "jev-artifacts-"));
	await mkdir(join(dir, "local"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		await writeFile(join(dir, "local", name), content, "utf8");
	}
	return dir;
}

export function toolCallEvent(toolName: string, input: unknown): unknown {
	return { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input };
}

export function toolResultEvent(toolName: string, input: unknown, text: string, isError = false): unknown {
	return {
		type: "tool_result",
		toolCallId: `call-${toolName}`,
		toolName,
		input,
		content: [{ type: "text", text }],
		isError,
	};
}

export function stopEvent(): unknown {
	return { type: "session_stop", messages: [], turn_id: 1, session_id: "session-1", stop_hook_active: false };
}

/** The first returned gate result that blocks, or undefined when no handler blocked. */
export function blockReason(results: readonly unknown[]): string | undefined {
	for (const result of results) {
		const record = asRecord(result);
		if (record?.["block"] === true) {
			const reason = record["reason"];
			return typeof reason === "string" ? reason : "";
		}
	}
	return undefined;
}

/** The stop result that carries a decision, or undefined when the session was allowed to settle. */
export function stopDecision(results: readonly unknown[]): string | undefined {
	for (const result of results) {
		const record = asRecord(result);
		if (record?.["decision"] === "block") return typeof record["reason"] === "string" ? record["reason"] : "";
	}
	return undefined;
}

/** Poll until `check` passes or the budget runs out; used for the fire-and-forget course check. */
export async function until(check: () => boolean, ms = 500): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await Bun.sleep(5);
	}
	return check();
}
