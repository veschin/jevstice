/**
 * FR-13 (refactoring), the three separately checkable parts:
 *  (1) the inventory of the old functions exists BEFORE the first code edit and every item carries
 *      a verification command;
 *  (2) after the refactoring every item carries a marking and the artifact material it was made
 *      from - a code quote or a command output, never the executor's report;
 *  (3) an item without such material keeps the completion boundary shut UNDER ITS OWN ID.
 *
 * Every test below fails when its part breaks: the inventory can be recorded after the first edit,
 * the per-item material stops being required, a `not_evidenced` item stops blocking, a marking
 * survives a later code edit, or a failed/escaped judge answer still records a marking.
 */
import { describe, expect, test } from "bun:test";
import { createRefactorMarkingJudge } from "../src/client.js";
import type { JevTemplateConfig } from "../src/config.js";
import { createJevController, type JevController, type JevState } from "../src/controller.js";
import { isRecord } from "../src/guards.js";
import type {
	DecisionResult,
	Evidence,
	RefactorMarkingJudge,
	RefactorMarkingRequest,
	RefactorMarkingResult,
} from "../src/types.js";

// ---------- a minimal host stand-in (the same shape the other suites use) ----------

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface FakeToolDef {
	name: string;
	execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
	[key: string]: unknown;
}

interface FakePiHarness {
	pi: {
		on(event: string, handler: Handler): void;
		registerTool(tool: FakeToolDef): void;
		appendEntry(customType: string, data?: unknown): void;
		sendMessage(payload: unknown, options?: unknown): void;
	};
	emit(event: string, ev: unknown, ctx?: unknown): Promise<unknown>;
	getTool(): FakeToolDef | undefined;
	sentMessages: Array<{ payload: unknown; options?: unknown }>;
}

function makeFakePi(): FakePiHarness {
	const handlers = new Map<string, Handler[]>();
	const sentMessages: Array<{ payload: unknown; options?: unknown }> = [];
	let registered: FakeToolDef | undefined;
	return {
		pi: {
			on(event, handler) {
				const list = handlers.get(event);
				if (list === undefined) handlers.set(event, [handler]);
				else list.push(handler);
			},
			registerTool(tool) {
				registered = tool;
			},
			appendEntry() {},
			sendMessage(payload, options) {
				sentMessages.push({ payload, options });
			},
		},
		getTool: () => registered,
		emit: async (event, ev, ctx) => {
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
		},
		sentMessages,
	};
}

// ---------- fixtures ----------

const TASK_PROMPT = "Refactor the export pipeline without breaking the JSON export.";

const OPTIONS = [
	{ id: "recorded", label: "Recorded", meaning: "the submission is recorded" },
	{ id: "refused", label: "Refused", meaning: "the submission is refused" },
];

const TASK_QUOTE: Evidence = { kind: "user", source: "task prompt", quote: TASK_PROMPT };

const INVENTORY = [
	{ id: "export-json", name: "exportJson()", verification: "bun test tests/export.test.ts -t json" },
	{ id: "cli-flag", name: "cli --export", verification: "bun run src/cli.ts --export --dry-run" },
];

const GATES_OPEN: JevTemplateConfig = { gates: { mutation: false } };

function inventorySubmission() {
	return {
		stage: "refactor_inventory",
		task: TASK_PROMPT,
		proposal: "Record the old functions this refactoring touches before the first edit.",
		options: OPTIONS,
		evidence: [TASK_QUOTE],
		inventory: INVENTORY,
	};
}

/** The material attached to one inventory item by the executor. */
function marks(entries: Array<{ id: string; evidence: Evidence[] }>) {
	return { inventoryMarks: entries };
}

function markingSubmission(entries: Array<{ id: string; evidence: Evidence[] }>) {
	return {
		stage: "refactor_marking",
		task: TASK_PROMPT,
		proposal: "The refactoring is done; every item was checked with its own verification.",
		options: OPTIONS,
		evidence: [TASK_QUOTE],
		...marks(entries),
	};
}

const CODE_MATERIAL: Evidence = {
	kind: "code",
	source: "src/export.ts",
	quote: "export function exportJson(rows: Row[]): string { return JSON.stringify(rows); }",
};
const COMMAND_OUTPUT: Evidence = {
	kind: "execution",
	source: "bun test tests/export.test.ts -t json",
	quote: "1 pass, 0 fail (export.test.ts)",
};
/** The executor's own report: a textual claim, which FR-13 part (3) refuses as evidence. */
const REPORT_ONLY: Evidence = {
	kind: "user",
	source: "executor report",
	quote: "I kept exportJson and the --export flag working; I checked both by hand while refactoring.",
};

/** Marking judge that records every request, so a test can prove which material reached it. */
interface RecordingMarkingJudge extends RefactorMarkingJudge {
	calls: RefactorMarkingRequest[];
}

function recordingMarkingJudge(
	answer: (request: RefactorMarkingRequest) => Promise<RefactorMarkingResult>,
): RecordingMarkingJudge {
	const calls: RefactorMarkingRequest[] = [];
	const judge = async (request: RefactorMarkingRequest): Promise<RefactorMarkingResult> => {
		calls.push(request);
		return answer(request);
	};
	return Object.assign(judge, { calls });
}

const markingJudge = (result: RefactorMarkingResult): RecordingMarkingJudge => recordingMarkingJudge(async () => result);

function judgeResult(partial: Partial<DecisionResult>): DecisionResult {
	return { verdict: "approve", selectedOption: "recorded", reasons: ["ok"], confidence: 0.95, ...partial };
}

/** The text a tool result carries to the executor (the host's own content shape). */
function toolText(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result["content"])) return "";
	return result["content"]
		.map(part => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
		.join("\n");
}

async function stopReason(controller: JevController): Promise<string> {
	const result = await controller.onSessionStop({
		type: "session_stop",
		messages: [],
		turn_id: 1,
		session_id: "s1",
		stop_hook_active: false,
	});
	return isRecord(result) && typeof result["reason"] === "string" ? result["reason"] : "";
}

/** Open a task, then allow one code edit (the first edit of the task). */
async function startTaskAndEdit(harness: FakePiHarness): Promise<void> {
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });
	await harness.emit("tool_call", { type: "tool_call", toolCallId: "t1", toolName: "edit", input: { path: "src/export.ts" } });
}

function controllerWith(
	harness: FakePiHarness,
	options: {
		judge?: () => Promise<DecisionResult>;
		refactorMarkingJudge?: RefactorMarkingJudge;
		template?: JevTemplateConfig;
	},
): JevController {
	const controller = createJevController({
		judge: options.judge ?? (async () => judgeResult({})),
		refactorMarkingJudge: options.refactorMarkingJudge,
		template: options.template ?? GATES_OPEN,
	});
	controller.register(harness.pi);
	return controller;
}

// ---------- part (1): the inventory exists before the first code edit ----------

describe("FR-13 part 1: the inventory is fixed before the first code edit", () => {
	test("the inventory is recorded with its verification commands and delivered into the session", async () => {
		const harness = makeFakePi();
		const controller = controllerWith(harness, {});
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });

		const out = await controller.submitDecision(inventorySubmission());

		expect(out.verdict).toBe("approve");
		const state: JevState = controller.getState();
		expect(state.refactorInventory?.items).toEqual(INVENTORY);
		expect(state.refactorInventory?.taskFingerprint).toBe(state.taskFingerprint);
		const delivered = harness.sentMessages
			.map(m => (isRecord(m.payload) ? m.payload["content"] : undefined))
			.filter((c): c is string => typeof c === "string");
		expect(delivered.length).toBe(1);
		expect(delivered[0]).toContain("export-json");
		expect(delivered[0]).toContain("bun test tests/export.test.ts -t json");
		expect(delivered[0]).toContain("cli-flag");
	});

	test("an inventory submitted after the first code edit is refused and nothing is recorded", async () => {
		const harness = makeFakePi();
		const controller = controllerWith(harness, {});
		await startTaskAndEdit(harness);

		const out = await controller.submitDecision(inventorySubmission());

		expect(out.verdict).toBe("insufficient_evidence");
		expect(out.judged).toBe(false);
		expect(out.reasons.join(" ")).toContain("before the first code edit");
		expect(controller.getState().refactorInventory).toBeUndefined();
		expect(harness.sentMessages).toEqual([]);
	});
});

// ---------- parts (2)+(3): per-item marking from that item's own material ----------

describe("FR-13 parts 2-3: per-item marking from the item's own artifact material", () => {
	test("the executor's report is not evidence: the submission is refused and completion stays blocked by name", async () => {
		const harness = makeFakePi();
		// A judge that would happily mark every item not_evidenced: the refusal must happen before
		// it is asked, because the material itself is the problem.
		const marking = markingJudge({
			markings: { "export-json": "not_evidenced", "cli-flag": "not_evidenced" },
			reasons: ["judged"],
			confidence: 0.9,
			judged: true,
		});
		const controller = controllerWith(harness, { refactorMarkingJudge: marking });
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });
		await controller.submitDecision(inventorySubmission());

		const out = await controller.submitDecision(
			markingSubmission([
				{ id: "export-json", evidence: [REPORT_ONLY] },
				{ id: "cli-flag", evidence: [REPORT_ONLY] },
			]),
		);

		expect(out.verdict).toBe("insufficient_evidence");
		expect(out.reasons.join(" ")).toContain("a textual report is not evidence");
		expect(controller.getState().lastRefactorMarking).toBeUndefined();
		const reason = await stopReason(controller);
		expect(reason).toContain("refactor inventory");
		expect(reason).toContain("export-json");
		expect(reason).toContain("cli-flag");
	});

	test("a marking of every item from its own material is recorded and stops blocking completion", async () => {
		const harness = makeFakePi();
		const marking = markingJudge({
			markings: { "export-json": "preserved", "cli-flag": "preserved" },
			reasons: ["judged"],
			confidence: 0.9,
			judged: true,
		});
		const controller = controllerWith(harness, { refactorMarkingJudge: marking });
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });
		await controller.submitDecision(inventorySubmission());

		const out = await controller.submitDecision(
			markingSubmission([
				{ id: "export-json", evidence: [CODE_MATERIAL] },
				{ id: "cli-flag", evidence: [COMMAND_OUTPUT] },
			]),
		);

		expect(out.verdict).toBe("approve");
		const state = controller.getState();
		expect(state.lastRefactorMarking?.marks.map(m => [m.id, m.outcome])).toEqual([
			["export-json", "preserved"],
			["cli-flag", "preserved"],
		]);
		expect(state.lastRefactorMarking?.workRevision).toBe(state.workRevision);
		// each item's own material reached the judge with that item (no shared evidence list)
		expect(marking.calls.length).toBe(1);
		expect(marking.calls[0]?.items.map(i => [i.id, i.evidence.length])).toEqual([
			["export-json", 1],
			["cli-flag", 1],
		]);
		expect(marking.calls[0]?.items[0]?.evidence).toEqual([CODE_MATERIAL]);
		expect(marking.calls[0]?.items[1]?.evidence).toEqual([COMMAND_OUTPUT]);
		// the refactor item no longer blocks whatever else the boundary is waiting for
		expect(await stopReason(controller)).not.toContain("refactor inventory");
	});

	test("an item the judge cannot mark from its material blocks completion under its own id", async () => {
		const harness = makeFakePi();
		const marking = markingJudge({
			markings: { "export-json": "preserved", "cli-flag": "not_evidenced" },
			reasons: ["judged"],
			confidence: 0.9,
			judged: true,
		});
		const controller = controllerWith(harness, { refactorMarkingJudge: marking });
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });
		await controller.submitDecision(inventorySubmission());

		const out = await controller.submitDecision(
			markingSubmission([
				{ id: "export-json", evidence: [CODE_MATERIAL] },
				{ id: "cli-flag", evidence: [COMMAND_OUTPUT] },
			]),
		);

		expect(out.verdict).toBe("revise");
		expect(out.reasons.join(" ")).toContain("cli-flag");
		const reason = await stopReason(controller);
		expect(reason).toContain("cli-flag");
		expect(reason).not.toContain("export-json");
	});

	test("a marking is stale after a later code edit and the boundary names the items again", async () => {
		const harness = makeFakePi();
		const marking = markingJudge({
			markings: { "export-json": "preserved", "cli-flag": "lost" },
			reasons: ["judged"],
			confidence: 0.9,
			judged: true,
		});
		const controller = controllerWith(harness, { refactorMarkingJudge: marking });
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });
		await controller.submitDecision(inventorySubmission());
		const approved = await controller.submitDecision(
			markingSubmission([
				{ id: "export-json", evidence: [CODE_MATERIAL] },
				{ id: "cli-flag", evidence: [COMMAND_OUTPUT] },
			]),
		);
		expect(approved.verdict).toBe("approve");

		await harness.emit("tool_call", { type: "tool_call", toolCallId: "t9", toolName: "edit", input: { path: "src/export.ts" } });

		const reason = await stopReason(controller);
		expect(reason).toContain("marked before the latest code edit");
		expect(reason).toContain("export-json");
		expect(reason).toContain("cli-flag");
	});

	test("a judge that fails or escapes the frame records no marking and the boundary stays shut", async () => {
		for (const answer of [
			async (): Promise<RefactorMarkingResult> => {
				throw new Error("transport closed");
			},
			async (): Promise<RefactorMarkingResult> => ({
				markings: {},
				reasons: ["meta_option"],
				confidence: 0.9,
				judged: true,
				escape: true,
			}),
		]) {
			const harness = makeFakePi();
			const controller = controllerWith(harness, { refactorMarkingJudge: recordingMarkingJudge(answer) });
			await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });
			await controller.submitDecision(inventorySubmission());

			const out = await controller.submitDecision(
				markingSubmission([
					{ id: "export-json", evidence: [CODE_MATERIAL] },
					{ id: "cli-flag", evidence: [COMMAND_OUTPUT] },
				]),
			);

			expect(out.verdict).toBe("insufficient_evidence");
			expect(out.judged).toBe(false);
			expect(controller.getState().lastRefactorMarking).toBeUndefined();
			const reason = await stopReason(controller);
			expect(reason).toContain("export-json");
			expect(reason).toContain("cli-flag");
		}
	});
});

// ---------- the registered tool path ----------

describe("FR-13: both steps run through the registered tool and are visible in its result", () => {
	test("the tool result names the inventory items and the per-item marking", async () => {
		const harness = makeFakePi();
		const marking = markingJudge({
			markings: { "export-json": "preserved", "cli-flag": "lost" },
			reasons: ["judged"],
			confidence: 0.9,
			judged: true,
		});
		const controller = controllerWith(harness, { refactorMarkingJudge: marking });
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });
		const tool = harness.getTool();
		expect(tool).toBeDefined();

		const recorded = await tool!.execute("c1", inventorySubmission(), undefined, undefined, undefined);
		const marked = await tool!.execute("c2", markingSubmission([
			{ id: "export-json", evidence: [CODE_MATERIAL] },
			{ id: "cli-flag", evidence: [COMMAND_OUTPUT] },
		]), undefined, undefined, undefined);

		expect(toolText(recorded)).toContain("export-json");
		expect(toolText(recorded)).toContain("cli-flag");
		expect(toolText(marked)).toContain("lost: cli-flag");
	});

	test("the tool result names the item left without evidence", async () => {
		const harness = makeFakePi();
		const marking = markingJudge({
			markings: { "export-json": "preserved", "cli-flag": "not_evidenced" },
			reasons: ["judged"],
			confidence: 0.9,
			judged: true,
		});
		const controller = controllerWith(harness, { refactorMarkingJudge: marking });
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: TASK_PROMPT, systemPrompt: [] });
		const tool = harness.getTool();
		await tool!.execute("c1", inventorySubmission(), undefined, undefined, undefined);

		const marked = await tool!.execute("c2", markingSubmission([
			{ id: "export-json", evidence: [CODE_MATERIAL] },
			{ id: "cli-flag", evidence: [COMMAND_OUTPUT] },
		]), undefined, undefined, undefined);

		expect(toolText(marked)).toContain("cli-flag");
	});
});

// ---------- the wire contract of the marking judge ----------

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const MARKING_REQUEST: RefactorMarkingRequest = {
	items: [
		{ ...INVENTORY[0]!, evidence: [CODE_MATERIAL] },
		{ ...INVENTORY[1]!, evidence: [COMMAND_OUTPUT] },
	],
	currentAction: "refactoring done",
};

describe("FR-13: refactor marking judge (wire contract)", () => {
	test("each item's material travels inside that item's own state entry", async () => {
		let sent: { state?: { items?: Array<{ id: string; evidence: unknown }> } } = {};
		const fetchFn = (async (_url: unknown, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body)) as typeof sent;
			return jsonResponse({
				model: "jev-1.13.0",
				answers: {
					"export-json": { type: "choice", choice: "preserved", confidence: 0.9 },
					"cli-flag": { type: "choice", choice: "lost", confidence: 0.9 },
				},
				usage: { input_tokens: 10, output_tokens: 5 },
			});
		}) as unknown as typeof fetch;
		const judge = createRefactorMarkingJudge({ apiKey: "k", fetchFn, retryDelayMs: 0 });

		const result = await judge(MARKING_REQUEST);

		expect(result.judged).toBe(true);
		expect(result.markings).toEqual({ "export-json": "preserved", "cli-flag": "lost" });
		expect(sent.state?.items?.map(i => [i.id, i.evidence])).toEqual([
			["export-json", [CODE_MATERIAL]],
			["cli-flag", [COMMAND_OUTPUT]],
		]);
	});

	test("an unjudged or escaped answer yields no marking at all", async () => {
		const lowConfidence = createRefactorMarkingJudge({
			apiKey: "k",
			retryDelayMs: 0,
			fetchFn: (async () =>
				jsonResponse({
					model: "jev-1.13.0",
					answers: {
						"export-json": { type: "choice", choice: "preserved", confidence: 0.2 },
						"cli-flag": { type: "choice", choice: "preserved", confidence: 0.9 },
					},
					usage: { input_tokens: 10, output_tokens: 5 },
				})) as unknown as typeof fetch,
		});
		const low = await lowConfidence(MARKING_REQUEST);
		expect(low.judged).toBe(false);
		expect(low.markings).toEqual({});

		const escaping = createRefactorMarkingJudge({
			apiKey: "k",
			retryDelayMs: 0,
			fetchFn: (async () =>
				jsonResponse({
					model: "jev-1.13.0",
					answers: {
						"export-json": { type: "choice", choice: "ALL_OPTIONS_WRONG", confidence: 0.9 },
						"cli-flag": { type: "choice", choice: "preserved", confidence: 0.9 },
					},
					usage: { input_tokens: 10, output_tokens: 5 },
				})) as unknown as typeof fetch,
		});
		const escaped = await escaping(MARKING_REQUEST);
		expect(escaped.escape).toBe(true);
		expect(escaped.markings).toEqual({});
	});
});
