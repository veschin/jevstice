/**
 * The one gate/review mechanism (D1): one descriptor registry, one consult runner, and the two
 * host-order defects the live omp 18.6.3 smoke found in the hand-off gate (F1, F2).
 *
 * These tests exist because they fail when the behaviour breaks:
 *  - F1: the captured work order must survive the task tool's own `tool_result`, which omp emits
 *    BEFORE `before_subagent_spawn` (a regression retires the order and the dispatch consult
 *    silently never fires);
 *  - F2: the spawn acknowledgement must never be judged as the delegated result, and the result
 *    the host actually delivers must be judged when the acceptance side is opted in;
 *  - the registry validator: a descriptor whose refusal option is not offered, an advisory gate
 *    with a refusal path, or a deadline at the host's ceiling must be reported, so adding a gate
 *    is adding a descriptor rather than a new code path.
 */
import { describe, expect, test } from "bun:test";
import { CONTROL_POINT_REGISTRY } from "../src/control-points.js";
import { createJevController } from "../src/controller.js";
import { HOST_HANDLER_TIMEOUT_MS } from "../src/deadline.js";
import {
	GATE_REGISTRY,
	decisionGate,
	validateGateRegistry,
	type GateDescriptor,
} from "../src/gates.js";
import { isRecord } from "../src/guards.js";
import type { JevTemplateConfig } from "../src/config.js";
import type { DecisionRequest, DecisionResult, Evidence } from "../src/types.js";

// ---------- a minimal host stand-in (same merge semantics as runner.ts emit*) ----------

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
	sentMessages: Array<{ payload: unknown; options?: unknown }>;
}

function makeFakePi(): FakePiHarness {
	const handlers = new Map<string, Handler[]>();
	const sentMessages: Array<{ payload: unknown; options?: unknown }> = [];
	const pi: FakePiHarness["pi"] = {
		on(event, handler) {
			const list = handlers.get(event);
			if (list === undefined) handlers.set(event, [handler]);
			else list.push(handler);
		},
		registerTool() {},
		appendEntry() {},
		sendMessage(payload, options) {
			sentMessages.push({ payload, options });
		},
	};
	async function emit(event: string, ev: unknown, ctx?: unknown): Promise<unknown> {
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
	}
	return { pi, emit, sentMessages };
}

function evidence(kind: Evidence["kind"], quote: string, source = "test"): Evidence {
	return { kind, source, quote };
}

/** What omp's task tool returns for a background spawn (the delegated report arrives later). */
const SPAWN_ACK = "Spawned agent `task-1`... Results auto-deliver; NEVER poll; the report will arrive as a job delivery.";

const REQUIREMENT = "Keep the existing export working while you add the dashboard view.";
const WORK_ORDER = "Implement the dashboard view module and keep the export suite green.";
const HANDOFF_WIRED: JevTemplateConfig = { stages: { subagent_handoff: { instructions: "Judge the hand-off." } } };
const HANDOFF_ACCEPTING: JevTemplateConfig = {
	stages: { subagent_handoff: { instructions: "Judge the hand-off." } },
	gates: { handoffAcceptance: true },
};

function approve(selectedOption: string, confidence = 0.95): DecisionResult {
	return { verdict: "approve", selectedOption, reasons: ["approved"], confidence };
}

/** The real host order: task tool_call, then the tool's acknowledgement, then the spawn event. */
async function dispatch(
	harness: FakePiHarness,
	source: string,
	respond: (req: DecisionRequest) => DecisionResult,
): Promise<DecisionRequest[]> {
	const calls: DecisionRequest[] = [];
	const controller = createJevController({
		template: source === "wired" ? HANDOFF_WIRED : HANDOFF_ACCEPTING,
		judge: async req => {
			calls.push(req);
			return respond(req);
		},
	});
	controller.register(harness.pi);
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: REQUIREMENT, systemPrompt: [] });
	await harness.emit("tool_call", {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "task",
		input: { task: WORK_ORDER, agent: "task" },
	});
	await harness.emit("tool_result", {
		type: "tool_result",
		toolName: "task",
		toolCallId: "t1",
		input: { task: WORK_ORDER },
		content: [{ type: "text", text: SPAWN_ACK }],
		isError: false,
	});
	await harness.emit("before_subagent_spawn", {
		type: "before_subagent_spawn",
		agent: "task",
		invocationKind: "task",
		patterns: ["@task"],
		spawnKey: "t1:0",
	});
	return calls;
}

/** The delivery omp builds for a settled background job (session/async-job-delivery.ts). */
async function deliver(harness: FakePiHarness, text: string): Promise<unknown> {
	return await harness.emit("message_end", {
		type: "message_end",
		message: {
			role: "custom",
			customType: "async-result",
			content: [{ type: "text", text }],
			details: { jobs: [{ jobId: "job-1", type: "task", label: "task" }] },
		},
	});
}

describe("gate mechanism: the hand-off gate in real host order (F1, F2)", () => {
	test("F1: the captured work order survives the task tool_result and judges the spawn", async () => {
		const harness = makeFakePi();
		const calls = await dispatch(harness, "wired", () => ({
			verdict: "revise",
			reasons: ["the work order omits the export requirement"],
			confidence: 0.93,
		}));
		// The dispatch consult ran: the order was not retired by the tool's own result.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.stage).toBe("subagent_handoff");
		expect(calls[0]?.evidence.some(e => e.quote.includes(WORK_ORDER))).toBe(true);
		expect(calls[0]?.evidence.some(e => e.quote.includes(REQUIREMENT))).toBe(true);
	});

	test("F2: the spawn acknowledgement is never judged as the delegated result", async () => {
		const harness = makeFakePi();
		const calls = await dispatch(harness, "wired", () => approve("approve"));
		expect(calls).toHaveLength(1);
		expect(calls.some(req => req.evidence.some(e => e.quote.includes("auto-deliver")))).toBe(false);
	});

	test("F2: the delivered result is judged when acceptance is opted in, and never blocks", async () => {
		const harness = makeFakePi();
		const calls: DecisionRequest[] = [];
		let answer: DecisionResult = approve("approve");
		const controller = createJevController({
			template: HANDOFF_ACCEPTING,
			judge: async req => {
				calls.push(req);
				return answer;
			},
		});
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: REQUIREMENT, systemPrompt: [] });
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "t1", toolName: "task", input: { task: WORK_ORDER } });
		await harness.emit("tool_result", {
			type: "tool_result",
			toolName: "task",
			toolCallId: "t1",
			input: { task: WORK_ORDER },
			content: [{ type: "text", text: SPAWN_ACK }],
			isError: false,
		});
		await harness.emit("before_subagent_spawn", {
			type: "before_subagent_spawn",
			agent: "task",
			invocationKind: "task",
			patterns: ["@task"],
			spawnKey: "t1:0",
		});
		expect(calls).toHaveLength(1);
		// The delegated result arrives later, as the host's async-result delivery.
		await deliver(harness, "Implemented the dashboard view module; the export suite passes.");
		await controller.handoffAcceptanceSettled();
		expect(calls).toHaveLength(2);
		expect(calls.at(-1)?.evidence.some(e => e.quote.includes("the export suite passes"))).toBe(true);
		expect(controller.getState().lastHandoff?.phase).toBe("acceptance");
		expect(controller.getState().lastHandoff?.verdict).toBe("approve");
		expect(controller.getState().blockers).toEqual([]);
		// A confident negative on the delivered result records a blocker and still refuses nothing.
		answer = { verdict: "revise", reasons: ["the report shows no run of the export test"], confidence: 0.91 };
		const result = await deliver(harness, "Dashboard module added; I renamed the export helper.");
		await controller.handoffAcceptanceSettled();
		expect(result).toBeUndefined();
		expect(controller.getState().blockers.join(" ")).toContain("did not accept the delegated result");
	});

	test("acceptance stays off by default: the delivery is not judged and the state is untouched", async () => {
		const harness = makeFakePi();
		const calls: DecisionRequest[] = [];
		const controller = createJevController({
			template: HANDOFF_WIRED,
			judge: async req => {
				calls.push(req);
				return approve("approve");
			},
		});
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: REQUIREMENT, systemPrompt: [] });
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "t1", toolName: "task", input: { task: WORK_ORDER } });
		await harness.emit("before_subagent_spawn", {
			type: "before_subagent_spawn",
			agent: "task",
			invocationKind: "task",
			patterns: ["@task"],
			spawnKey: "t1:0",
		});
		const after = controller.getState().lastHandoff;
		await deliver(harness, "Implemented the dashboard view module; the export suite passes.");
		await controller.handoffAcceptanceSettled();
		expect(calls).toHaveLength(1);
		expect(controller.getState().lastHandoff).toEqual(after);
	});
});

describe("gate mechanism: the descriptor registry", () => {
	test("the six descriptors are consistent with the control points and the host timeout", () => {
		expect(Object.keys(GATE_REGISTRY).sort()).toEqual([
			"architecture_review",
			"business_review",
			"destructive_action",
			"plan_mutation",
			"security_review",
			"subagent_handoff",
		]);
		expect(validateGateRegistry(GATE_REGISTRY, CONTROL_POINT_REGISTRY)).toEqual([]);
	});

	test("an inconsistent descriptor is reported instead of shipping (refusal, mode, deadline)", () => {
		const destructive = decisionGate("destructive_action");
		const frame = destructive.consult.frames["execution"]!;
		const doctored: Readonly<Record<string, GateDescriptor>> = {
			...GATE_REGISTRY,
			destructive_action: {
				...destructive,
				consult: { ...destructive.consult, refusalOption: "not_offered" },
			},
		};
		expect(validateGateRegistry(doctored, CONTROL_POINT_REGISTRY).map(p => p.code)).toContain(
			"refusal_option_not_offered",
		);
		// An advisory gate would be a descriptor without a refusal path: only a review may be advisory.
		const advisory: Readonly<Record<string, GateDescriptor>> = {
			...GATE_REGISTRY,
			destructive_action: { ...destructive, mode: "advisory" },
		};
		expect(validateGateRegistry(advisory, CONTROL_POINT_REGISTRY).map(p => p.code)).toContain(
			"advisory_without_refusal_path_shape",
		);
		// The deadline must beat the host's handler timeout, or the gate never decides.
		const slow: Readonly<Record<string, GateDescriptor>> = {
			...GATE_REGISTRY,
			destructive_action: {
				...destructive,
				consult: { ...destructive.consult, frames: { execution: { ...frame, deadlineMs: HOST_HANDLER_TIMEOUT_MS } } },
			},
		};
		expect(validateGateRegistry(slow, CONTROL_POINT_REGISTRY).map(p => p.code)).toContain(
			"deadline_at_or_above_host_timeout",
		);
	});
});
