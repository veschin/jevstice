/**
 * Boundary visibility: the two write paths that used to be invisible to the gate.
 *
 *  (a) a `write`/`edit`/`ast_edit` call whose target is a plain path OUTSIDE the project root
 *      reaches a judgement through the destructive-action descriptor's second trigger and frame,
 *      armed by `gates.destructive.outsideProjectWrites` (off by default);
 *  (b) `learn` and `retain` are mutating tools, so the existing plan gate covers them the way it
 *      covers `memory_edit` and `manage_skill`.
 *
 * Every test here names the observable behaviour it pins, so the same file is the mutation check:
 * removing the guard it exercises makes it fail against the green baseline.
 */
import { describe, expect, test } from "bun:test";
import { createJevController, type DestructiveRecord, type JevController } from "../src/controller.js";
import type { JevTemplateConfig } from "../src/config.js";
import { mergeTemplateConfigs, validateTemplateConfig } from "../src/config.js";
import { isRecord } from "../src/guards.js";
import type { DecisionRequest, DecisionResult, Evidence } from "../src/types.js";

// ---------- fakes ----------

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface FakeToolDef {
	name: string;
	execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
	[key: string]: unknown;
}

interface FakePi {
	on(event: string, handler: Handler): void;
	registerTool(tool: FakeToolDef): void;
	appendEntry(customType: string, data?: unknown): void;
	sendMessage(payload: unknown, options?: unknown): void;
	sendUserMessage(content: unknown, options?: unknown): void;
}

interface FakePiHarness {
	emit(event: string, ev: unknown, ctx?: unknown): Promise<unknown>;
	sentMessages: Array<{ payload: unknown; options?: unknown }>;
}

/** Host merge semantics: the first handler returning `block: true` short-circuits the event. */
function makeFakePi(): { pi: FakePi; harness: FakePiHarness } {
	const handlers = new Map<string, Handler[]>();
	const sentMessages: Array<{ payload: unknown; options?: unknown }> = [];
	const pi: FakePi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		registerTool() {},
		appendEntry() {},
		sendMessage(payload, options) {
			sentMessages.push({ payload, options });
		},
		sendUserMessage() {},
	};
	const emit = async (event: string, ev: unknown, ctx?: unknown): Promise<unknown> => {
		let merged: Record<string, unknown> | undefined;
		for (const handler of handlers.get(event) ?? []) {
			const result = await handler(ev, ctx);
			if (!isRecord(result)) continue;
			if (result["block"] === true) return result;
			for (const [key, value] of Object.entries(result)) {
				if (value === undefined) continue;
				merged = { ...(merged ?? {}), [key]: value };
			}
		}
		return merged;
	};
	return { pi, harness: { emit, sentMessages } };
}

function evidence(kind: Evidence["kind"], quote: string, source = "test"): Evidence {
	return { kind, source, quote };
}

const OPTIONS = [
	{ id: "a", label: "Option A", meaning: "do A" },
	{ id: "b", label: "Option B", meaning: "do B" },
];

function judgeResult(partial: Partial<DecisionResult>): DecisionResult {
	return { verdict: "approve", selectedOption: "a", reasons: ["ok"], confidence: 0.95, ...partial };
}

interface Harness {
	harness: FakePiHarness;
	controller: JevController;
	calls: DecisionRequest[];
}

const TASK = "Extend the record parser in this project and keep the existing export working.";

/**
 * Controller with the boundary trigger armed, the plan gate lifted unless a test wants it, and a
 * pinned project root so the outside-root decision is deterministic.
 */
function makeHarness(
	respond: (req: DecisionRequest) => DecisionResult | Promise<DecisionResult>,
	overrides: { template?: JevTemplateConfig; destructiveDeadlineMs?: number } = {},
): Harness {
	const calls: DecisionRequest[] = [];
	const { pi, harness } = makeFakePi();
	const controller = createJevController({
		projectRoot: "/work/project",
		template: overrides.template ?? {
			gates: { mutation: false, destructive: { patterns: [], outsideProjectWrites: true } },
		},
		...(overrides.destructiveDeadlineMs !== undefined ? { destructiveDeadlineMs: overrides.destructiveDeadlineMs } : {}),
		judge: async req => {
			calls.push(req);
			return respond(req);
		},
	});
	controller.register(pi);
	return { harness, controller, calls };
}

async function setTask(harness: FakePiHarness): Promise<void> {
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK, systemPrompt: [] });
}

async function emitToolCall(
	harness: FakePiHarness,
	toolName: string,
	input: Record<string, unknown>,
): Promise<{ block?: boolean; reason?: string }> {
	const result = (await harness.emit("tool_call", {
		type: "tool_call",
		toolCallId: "t1",
		toolName,
		input,
	})) as { block?: boolean; reason?: string } | undefined;
	return result ?? {};
}

const OUT_PATH = "/tmp/jev-boundary/scratch.ts";
const OUT_CONTENT = "export const scratch = 1;\n";

function writeCall(path: string, content = OUT_CONTENT): Record<string, unknown> {
	return { path, content };
}

// ---------- (a) the outside-root write trigger ----------

describe("jev controller: out-of-root writes reach the destructive-action gate", () => {
	test("a confident revise refuses the write and quotes the tool, the path and the root", async () => {
		const { harness, controller, calls } = makeHarness(() => ({
			verdict: "revise",
			reasons: ["writes outside the project root are not what the task asked for"],
			confidence: 0.93,
		}));
		await setTask(harness);
		const res = await emitToolCall(harness, "write", writeCall(OUT_PATH));
		expect(res.block).toBe(true);
		expect(String(res.reason)).toContain("outside the project root");
		expect(String(res.reason)).toContain(OUT_PATH);
		expect(controller.getState().blockers.join(" ")).toContain("destructive-action gate refused");
		const record = controller.getState().lastDestructive;
		expect(record?.trigger).toBe("outsideProjectWrite");
		expect(record?.judged).toBe(true);
		expect(record?.verdict).toBe("revise");
		expect(record?.blocked).toBe(true);
		expect(record?.pattern).toContain(OUT_PATH);
		expect(record?.command).toBe(OUT_CONTENT.trim());
		// the judge saw the concrete fact: which tool, which path, outside which root
		expect(calls.length).toBe(1);
		expect(calls[0]?.stage).toBe("destructive_action");
		expect(calls[0]?.proposal).toContain(OUT_PATH);
		expect(calls[0]?.proposal).toContain("write");
		expect(calls[0]?.proposal).toContain("/work/project");
		expect(calls[0]?.evidence.some(e => e.kind === "code" && e.quote.includes(OUT_PATH))).toBe(true);
		expect(calls[0]?.evidence.some(e => e.quote.includes("export const scratch"))).toBe(true);
		expect(calls[0]?.evidence.some(e => e.kind === "user" && e.quote.includes("record parser"))).toBe(true);
	});

	test("an abstention, a judge error and a sub-floor revise all let the write run", async () => {
		const abstain = makeHarness(() => ({
			verdict: "insufficient_evidence",
			reasons: ["insufficient_evidence"],
			confidence: 0.31,
		}));
		await setTask(abstain.harness);
		expect((await emitToolCall(abstain.harness, "write", writeCall(OUT_PATH))).block).toBeUndefined();
		expect(abstain.controller.getState().lastDestructive?.judged).toBe(true);
		expect(abstain.controller.getState().lastDestructive?.blocked).toBe(false);
		expect(abstain.controller.getState().blockers).toEqual([]);
		expect(
			abstain.harness.sentMessages.some(m => JSON.stringify(m.payload).includes("destructive")),
		).toBe(true);

		const throwing = makeHarness(() => {
			throw new Error("socket connection was closed unexpectedly");
		});
		await setTask(throwing.harness);
		expect((await emitToolCall(throwing.harness, "write", writeCall(OUT_PATH))).block).toBeUndefined();
		expect(throwing.controller.getState().lastDestructive?.judged).toBe(false);
		expect(throwing.controller.getState().lastDestructive?.reasons.join(" ")).toContain(
			"socket connection was closed",
		);
		expect(throwing.controller.getState().lastDestructive?.trigger).toBe("outsideProjectWrite");
		expect(throwing.controller.getState().blockers).toEqual([]);

		for (const confidence of [0.35, undefined]) {
			const low = makeHarness(() => ({
				verdict: "revise",
				reasons: ["maybe"],
				...(confidence !== undefined ? { confidence } : {}),
			}));
			await setTask(low.harness);
			expect((await emitToolCall(low.harness, "write", writeCall(OUT_PATH))).block).toBeUndefined();
			expect(low.controller.getState().lastDestructive?.verdict).toBe("revise");
			expect(low.controller.getState().lastDestructive?.blocked).toBe(false);
			expect(low.controller.getState().blockers).toEqual([]);
		}
	});

	test("an answer after the deadline never blocks an out-of-root write", async () => {
		const calls: DecisionRequest[] = [];
		const { pi, harness } = makeFakePi();
		let answer: ((result: DecisionResult) => void) | undefined;
		const controller = createJevController({
			projectRoot: "/work/project",
			template: { gates: { mutation: false, destructive: { patterns: [], outsideProjectWrites: true } } },
			destructiveDeadlineMs: 0,
			judge: req => {
				calls.push(req);
				const { promise, resolve } = Promise.withResolvers<DecisionResult>();
				answer = resolve;
				return promise;
			},
		});
		controller.register(pi);
		expect((await emitToolCall(harness, "write", writeCall(OUT_PATH))).block).toBeUndefined();
		expect(controller.getState().lastDestructive?.judged).toBe(false);
		expect(controller.getState().lastDestructive?.reasons.join(" ")).toContain(
			"did not answer before the destructive-gate deadline",
		);
		answer?.(judgeResult({ verdict: "revise", reasons: ["too late"], confidence: 0.99 }));
		await Promise.resolve();
		await Promise.resolve();
		expect(controller.getState().blockers).toEqual([]);
		expect(controller.getState().lastDestructive?.blocked).toBe(false);
	});

	test("the trigger is off unless the owner switch arms it", async () => {
		for (const template of [
			{ gates: { mutation: false, destructive: { patterns: ["rm -rf"] } } },
			{ gates: { mutation: false, destructive: { patterns: ["rm -rf"], outsideProjectWrites: false } } },
			{ gates: { mutation: false } },
		] satisfies JevTemplateConfig[]) {
			const armedOnlyByPatterns = makeHarness(
				() => judgeResult({ verdict: "revise", reasons: ["no"], confidence: 0.99 }),
				{ template },
			);
			await setTask(armedOnlyByPatterns.harness);
			expect((await emitToolCall(armedOnlyByPatterns.harness, "write", writeCall(OUT_PATH))).block).toBeUndefined();
			expect(armedOnlyByPatterns.calls.length).toBe(0);
			expect(armedOnlyByPatterns.controller.getState().lastDestructive).toBeUndefined();
		}
	});

	test("arming the write trigger does not arm the command trigger, and the reverse holds", async () => {
		// an empty pattern list still means the command trigger does not exist
		const writeOnly = makeHarness(() => judgeResult({ verdict: "revise", reasons: ["no"], confidence: 0.99 }));
		await setTask(writeOnly.harness);
		expect((await emitToolCall(writeOnly.harness, "bash", { command: "rm -rf /tmp/x" })).block).toBeUndefined();
		expect(writeOnly.calls.length).toBe(0);

		// the boundary switch absent: the command trigger still works off the pattern list
		const commandOnly = makeHarness(() => judgeResult({ verdict: "revise", reasons: ["no"], confidence: 0.99 }), {
			template: { gates: { mutation: false, destructive: { patterns: ["rm -rf"] } } },
		});
		await setTask(commandOnly.harness);
		expect((await emitToolCall(commandOnly.harness, "bash", { command: "rm -rf /tmp/x" })).block).toBe(true);
		expect(commandOnly.calls.length).toBe(1);
		expect(commandOnly.controller.getState().lastDestructive?.trigger).toBe("command");
	});

	test("a write inside the project root is never judged, relative or absolute", async () => {
		const inside = makeHarness(() => judgeResult({ verdict: "revise", reasons: ["no"], confidence: 0.99 }));
		await setTask(inside.harness);
		for (const target of [
			writeCall("src/parser.ts"),
			writeCall("./src/parser.ts"),
			writeCall("/work/project/src/parser.ts"),
			writeCall("a/b/../../src/parser.ts"),
		]) {
			expect((await emitToolCall(inside.harness, "write", target)).block).toBeUndefined();
		}
		expect(inside.calls.length).toBe(0);
		expect(inside.controller.getState().lastDestructive).toBeUndefined();
	});

	test("reads stay free everywhere, including outside the root", async () => {
		const gate = makeHarness(() => judgeResult({ verdict: "revise", reasons: ["no"], confidence: 0.99 }));
		await setTask(gate.harness);
		for (const [toolName, input] of [
			["read", { path: "/etc/hosts" }],
			["grep", { pattern: "x", path: "/etc" }],
			["glob", { path: "/tmp/**/*.ts" }],
			["bash", { command: "cat /etc/hosts" }],
			["recall", { query: "anything" }],
		] as Array<[string, Record<string, unknown>]>) {
			expect((await emitToolCall(gate.harness, toolName, input)).block).toBeUndefined();
		}
		expect(gate.calls.length).toBe(0);
	});

	test("the trigger reads the target fields the write/edit/ast_edit calls name", async () => {
		const gate = makeHarness(() => judgeResult({ verdict: "revise", reasons: ["no"], confidence: 0.9 }));
		await setTask(gate.harness);

		// edit, hashline payload: a target INSIDE the root is not read as a judgement trigger
		const insideHashline = "[src/inside.ts#1A2B]\nPUT >$:\n+// note\n";
		expect((await emitToolCall(gate.harness, "edit", { input: insideHashline })).block).toBeUndefined();
		expect(gate.calls.length).toBe(0);

		// edit, hashline payload: the section header is the target, and an outside one is judged
		const outHashline = "[/tmp/jev-boundary/other.ts#1A2B]\nPUT >$:\n+// note\n";
		const refusedHashline = await emitToolCall(gate.harness, "edit", { input: outHashline });
		expect(refusedHashline.block).toBe(true);
		expect(gate.calls.length).toBe(1);
		expect(gate.calls[0]?.proposal).toContain("/tmp/jev-boundary/other.ts");
		expect(gate.calls[0]?.proposal).toContain("edit");
		// the patch text rides along as the content evidence
		expect(gate.calls[0]?.evidence.some(e => e.quote.includes("PUT >$:"))).toBe(true);

		// ast_edit: the paths array, with the rewrite ops as content evidence
		expect(
			(await emitToolCall(gate.harness, "ast_edit", { paths: ["/tmp/jev-boundary/a.ts"], ops: [{ pat: "x", out: "y" }] }))
				.block,
		).toBe(true);
		expect(gate.calls.length).toBe(2);
		expect(gate.calls[1]?.evidence.some(e => e.quote.includes("pat"))).toBe(true);

		// edit, apply-patch directive: its file header is the target
		expect(
			(
				await emitToolCall(gate.harness, "edit", {
					input: "*** Begin Patch\n*** Add File: /tmp/jev-boundary/b.ts\n+x\n*** End Patch",
				})
			).block,
		).toBe(true);
		expect(gate.calls.length).toBe(3);
		expect(gate.calls[2]?.proposal).toContain("/tmp/jev-boundary/b.ts");

		// the same apply-patch form, targeting a path inside the root, is not judged
		expect(
			(
				await emitToolCall(gate.harness, "edit", {
					input: "*** Begin Patch\n*** Update File: src/inside.ts\n+x\n*** End Patch",
				})
			).block,
		).toBeUndefined();
		expect(gate.calls.length).toBe(3);
	});

	test("a target carrying a scheme is not read as a filesystem path", async () => {
		const gate = makeHarness(() => judgeResult({ verdict: "revise", reasons: ["no"], confidence: 0.99 }));
		await setTask(gate.harness);
		for (const target of [
			writeCall("local://notes.md"),
			writeCall("xd://report_issue"),
			writeCall("agent://Peer"),
			// the scheme rule is what keeps this from resolving outside the root and being judged
			writeCall("/tmp/jev-boundary/arch://notes.md"),
		]) {
			expect((await emitToolCall(gate.harness, "write", target)).block).toBeUndefined();
		}
		expect(gate.calls.length).toBe(0);
	});

	test("an approve records the judgement and lets the write through", async () => {
		const gate = makeHarness(() => judgeResult({ selectedOption: "approve", confidence: 0.91 }));
		await setTask(gate.harness);
		expect((await emitToolCall(gate.harness, "write", writeCall(OUT_PATH))).block).toBeUndefined();
		const record = gate.controller.getState().lastDestructive;
		expect(record?.judged).toBe(true);
		expect(record?.verdict).toBe("approve");
		expect(record?.blocked).toBe(false);
		expect(record?.trigger).toBe("outsideProjectWrite");
		expect(gate.controller.getState().blockers).toEqual([]);
	});

	test("a persisted destructive record survives only when well-formed", () => {
		const { pi } = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(pi);
		const valid: DestructiveRecord = {
			trigger: "outsideProjectWrite",
			pattern: OUT_PATH,
			command: OUT_CONTENT.trim(),
			verdict: "revise",
			judged: true,
			confidence: 0.93,
			reasons: ["outside the project root"],
			blocked: true,
			at: 1,
		};
		controller.onSessionStart([{ customType: "jev.state", data: { lastDestructive: valid } }]);
		expect(controller.getState().lastDestructive).toEqual(valid);
		// a record persisted before the second trigger existed is read back without a trigger
		const legacy = { pattern: "rm -rf", command: "rm -rf /tmp/x", judged: true, blocked: false, at: 2 };
		controller.onSessionStart([{ customType: "jev.state", data: { lastDestructive: legacy } }]);
		expect(controller.getState().lastDestructive?.pattern).toBe("rm -rf");
		expect(controller.getState().lastDestructive?.trigger).toBeUndefined();
		for (const malformed of [
			{ ...valid, trigger: "bogus" },
			{ ...valid, trigger: 7 },
			{ ...valid, pattern: "" },
		]) {
			controller.onSessionStart([{ customType: "jev.state", data: { lastDestructive: malformed } }]);
			expect(controller.getState().lastDestructive).toBeUndefined();
		}
	});
});

// ---------- the new switch is validated and merged like every other gate switch ----------

describe("jev config: gates.destructive.outsideProjectWrites", () => {
	test("a non-boolean value is refused naming the key", () => {
		for (const value of ["yes", 1, null, {}]) {
			expect(() =>
				validateTemplateConfig("/work/project/.omp/jev.config.json", {
					gates: { destructive: { patterns: [], outsideProjectWrites: value } },
				}),
			).toThrow("gates.destructive.outsideProjectWrites");
		}
	});

	test("a boolean is kept, and the patterns union never carries the switch", () => {
		const parsed = validateTemplateConfig("/work/project/.omp/jev.config.json", {
			gates: { destructive: { patterns: ["rm -rf"], outsideProjectWrites: true } },
		});
		expect(parsed.gates?.destructive).toEqual({ patterns: ["rm -rf"], outsideProjectWrites: true });
		const merged = mergeTemplateConfigs(
			{ gates: { mutation: false, destructive: { patterns: ["git push --force"] } } },
			{ gates: { destructive: { patterns: ["rm -rf"], outsideProjectWrites: true } } },
		);
		expect(merged.gates?.mutation).toBe(false);
		expect(merged.gates?.destructive?.patterns).toEqual(["git push --force", "rm -rf"]);
		expect(merged.gates?.destructive?.outsideProjectWrites).toBe(true);
	});
});


describe("jev controller: learn and retain are mutating tools", () => {
	/** Plan gate armed (the default: `gates.mutation` absent), no approval yet. */
	function planGateHarness(): Harness {
		return makeHarness(() => judgeResult({ verdict: "approve", selectedOption: "a", confidence: 0.95 }), {
			template: {},
		});
	}

	test("learn, retain, memory_edit and manage_skill are all refused before a plan approval", async () => {
		for (const toolName of ["learn", "retain", "memory_edit", "manage_skill", "edit", "write"]) {
			const gate = planGateHarness();
			const res = await emitToolCall(gate.harness, toolName, { i: "recording a lesson", memory: "text" });
			expect(res.block).toBe(true);
			expect(String(res.reason)).toContain("plan gate");
			expect(gate.calls.length).toBe(0);
		}
	});

	test("an approved plan unlocks learn and retain like any other mutating call", async () => {
		const gate = planGateHarness();
		await setTask(gate.harness);
		await gate.controller.submitDecision({
			stage: "understanding_review",
			task: "Implement feature X",
			proposal: 'Claim: module M satisfies the requirement "Implement feature X for the dashboard".',
			options: OPTIONS,
			evidence: [
				evidence("user", "Implement feature X for the dashboard"),
				evidence("execution", "dry-run plan output ok"),
			],
		});
		for (const toolName of ["learn", "retain"]) {
			expect((await emitToolCall(gate.harness, toolName, { i: "recording a lesson" })).block).toBeUndefined();
		}
	});

	test("a recall is not a mutation and stays free", async () => {
		const gate = planGateHarness();
		expect((await emitToolCall(gate.harness, "recall", { query: "lesson" })).block).toBeUndefined();
	});
});
