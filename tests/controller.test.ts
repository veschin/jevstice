/**
 * Behavioral tests for the Jev decision controller (extension slice).
 * Drafted before implementation (TDD); runs under `bun test`.
 */
import { describe, expect, test } from "bun:test";
import { createJevController, type JevState } from "../src/controller.js";
import type {
	AspectCoverageRequest,
	AspectCoverageResult,
	AspectMarking,
	CourseCheckResult,
	DecisionRequest,
	DecisionResult,
	Evidence,
} from "../src/types.js";

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
	pi: FakePi;
	emit(event: string, ev: unknown, ctx?: unknown): Promise<unknown>;
	getTool(): FakeToolDef | undefined;
	appended: Array<{ customType: string; data: unknown }>;
	sentMessages: Array<{ payload: unknown; options?: unknown }>;
}

function makeFakePi(): FakePiHarness {
	const handlers = new Map<string, Handler[]>();
	let registeredTool: FakeToolDef | undefined;
	const appended: Array<{ customType: string; data: unknown }> = [];
	const sentMessages: Array<{ payload: unknown; options?: unknown }> = [];
	const pi: FakePi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		registerTool(tool) {
			registeredTool = tool;
		},
		appendEntry(customType, data) {
			appended.push({ customType, data });
		},
		sendMessage(payload, options) {
			sentMessages.push({ payload, options });
		},
		sendUserMessage(_content, _options) {},
	};
	async function emit(event: string, ev: unknown, ctx?: unknown): Promise<unknown> {
		const hs = handlers.get(event) ?? [];
		let last: unknown;
		for (const h of hs) last = await h(ev, ctx);
		return last;
	}
	return { pi, emit, getTool: () => registeredTool, appended, sentMessages };
}

function evidence(kind: Evidence["kind"], quote: string, source = "test"): Evidence {
	return { kind, source, quote };
}

const OPTIONS = [
	{ id: "a", label: "Option A", meaning: "do A" },
	{ id: "b", label: "Option B", meaning: "do B" },
];

const COURSE_OPTIONS = [
	{ id: "continue", label: "Continue", meaning: "keep going" },
	{ id: "return_to_requirement", label: "Return", meaning: "re-read requirement" },
	{ id: "replan", label: "Replan", meaning: "new plan" },
	{ id: "ask_user", label: "Ask", meaning: "escalate" },
	{ id: "verify_before_proceeding", label: "Verify", meaning: "run checks first" },
];

function validDecisionInput(overrides: Record<string, unknown> = {}) {
	return {
		stage: "completion_review",
		task: "Implement feature X",
		proposal: "Feature X implemented: module added, tests pass.",
		options: OPTIONS,
		evidence: [evidence("execution", "$ bun test — 42 passing, 0 failing"), evidence("code", "export function x() {}")],
		...overrides,
	};
}

function judgeResult(partial: Partial<DecisionResult>): DecisionResult {
	return { verdict: "approve", selectedOption: "a", reasons: ["ok"], confidence: 0.95, ...partial };
}

/** Grant the plan gate so mutating tool calls are allowed (AC4a). */
async function approvePlan(controller: { submitDecision(input: unknown): Promise<unknown> }): Promise<unknown> {
	return controller.submitDecision(
		validDecisionInput({
			stage: "understanding_review",
			proposal: "Plan: implement feature X in module M.",
			evidence: [evidence("user", "Implement feature X for the dashboard"), evidence("execution", "dry-run plan output ok")],
		}),
	);
}

/** Judge answering every gate stage with the fixed happy-path option (course_check: continue). */
function gateJudge(): (req: DecisionRequest) => Promise<DecisionResult> {
	return async req =>
		req.stage === "course_check" ? judgeResult({ selectedOption: "continue" }) : judgeResult({});
}

/** Minimal on-track course_check submission (requirement id "REQ" via the evidence source). */
function courseCheckGateInput(overrides: Record<string, unknown> = {}) {
	return {
		stage: "course_check",
		task: "on-track check",
		proposal: "continuing the approved plan; evidence attached and checks green",
		options: COURSE_OPTIONS,
		evidence: [evidence("user", "requirement quote: implement feature X for the dashboard", "REQ")],
		...overrides,
	};
}

interface StopResult { decision?: string; reason?: string }

// Narrow controller stop result fields with runtime checks (unknown from fake emit).
function stopResult(v: unknown): StopResult {
	if (typeof v !== "object" || v === null) return {};
	const o = v as Record<string, unknown>; // homogeneous local fake result; fields narrowed below
	const out: StopResult = {};
	if (typeof o.decision === "string") out.decision = o.decision;
	if (typeof o.reason === "string") out.reason = o.reason;
	return out;
}

interface BlockResult { block?: boolean; reason?: string }

// Narrow tool_call gate result fields with runtime checks.
function blockResult(v: unknown): BlockResult {
	if (typeof v !== "object" || v === null) return {};
	const o = v as Record<string, unknown>; // homogeneous local fake result; fields narrowed below
	const out: BlockResult = {};
	if (typeof o.block === "boolean") out.block = o.block;
	if (typeof o.reason === "string") out.reason = o.reason;
	return out;
}

async function runStop(harness: FakePiHarness, stopHookActive = false): Promise<StopResult> {
	return stopResult(await harness.emit("session_stop", {
		type: "session_stop",
		messages: [],
		turn_id: 1,
		session_id: "s1",
		stop_hook_active: stopHookActive,
	}));
}

// ---------- tests ----------

describe("jev controller", () => {
	test("read-only session stops freely (evidence gathering stays possible)", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		const res = (await runStop(harness));
		expect(res?.decision).toBeUndefined();
	});

	test("mutations without completion approval => session_stop blocks with reasons", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		const gate = blockResult(
			await harness.emit("tool_call", { type: "tool_call", toolCallId: "0", toolName: "edit", input: {} }),
		);
		expect(gate?.block).toBe(true);
		expect(String(gate?.reason)).toContain("plan gate");
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		expect(
			blockResult(await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} }))
				?.block,
		).toBeUndefined();
		const res = (await runStop(harness));
		expect(res?.decision).toBe("block");
		expect(String(res?.reason)).toContain("completion_review");
		expect(String(res?.reason)).toContain("jev_decision");
	});

	test("approved completion with evidence-backed proposal allows stop", async () => {
		const harness = makeFakePi();
		let calls = 0;
		const controller = createJevController({
			judge: async (req: DecisionRequest) => {
				if (req.stage === "completion_review") calls++;
				return req.stage === "course_check" ? judgeResult({ selectedOption: "continue" }) : judgeResult({});
			},
		});
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		const blocked = (await runStop(harness));
		expect(blocked?.decision).toBe("block");
		const outcome = await controller.submitDecision(validDecisionInput());
		expect(outcome.verdict).toBe("approve");
		expect(calls).toBe(1);
		// completion alone does not unlock: the mutation must be followed by a fresh course check
		const withoutCheck = (await runStop(harness));
		expect(withoutCheck?.decision).toBe("block");
		expect(String(withoutCheck?.reason)).toContain("course_check");
		await controller.submitDecision(courseCheckGateInput());
		const allowed = (await runStop(harness));
		expect(allowed?.decision).toBeUndefined();
	});

	test("stale approval: work changed after approval re-blocks stop", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		await controller.submitDecision(validDecisionInput());
		await controller.submitDecision(courseCheckGateInput());
		expect(stopResult(await runStop(harness))?.decision).toBeUndefined();
		// new work lands after the approval: completion AND course check both go stale
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "write", input: {} });
		const res = (await runStop(harness));
		expect(res?.decision).toBe("block");
		expect(String(res?.reason)).toContain("stale");
	});

	test("changed task (new user prompt) invalidates prior approval", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "task one", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		await controller.submitDecision(validDecisionInput());
		await controller.submitDecision(courseCheckGateInput());
		expect(stopResult(await runStop(harness))?.decision).toBeUndefined();
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "task two: different", systemPrompt: [] });
		const res = (await runStop(harness));
		expect(res?.decision).toBe("block");
		expect(String(res?.reason)).toContain("task changed");
	});

	test("unavailable judge never approves and never records approval", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async (req: DecisionRequest) => {
				if (req.stage === "completion_review") throw new Error("ECONNREFUSED");
				return judgeResult({});
			},
		});
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		const outcome = await controller.submitDecision(validDecisionInput());
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(outcome.reasons.join(" ")).toContain("judge unavailable");
		expect(stopResult(await runStop(harness))?.decision).toBe("block");
	});

	test("invalid evidence: malformed input rejected before judge call", async () => {
		let called = false;
		const controller = createJevController({
			judge: async () => {
				called = true;
				return judgeResult({});
			},
		});
		const bad = await controller.submitDecision(validDecisionInput({ evidence: [] }));
		expect(bad.verdict).toBe("insufficient_evidence");
		expect(called).toBe(false);
		const badKind = await controller.submitDecision(
			validDecisionInput({ evidence: [{ kind: "rumor", source: "x", quote: "y" }] }),
		);
		expect(badKind.verdict).toBe("insufficient_evidence");
		const noQuote = await controller.submitDecision(
			validDecisionInput({ evidence: [{ kind: "code", source: "x", quote: "" }] }),
		);
		expect(noQuote.verdict).toBe("insufficient_evidence");
		expect(called).toBe(false);
	});

	test("completion requires execution/code/log evidence, report text alone insufficient", async () => {
		let called = false;
		const controller = createJevController({
			judge: async () => {
				called = true;
				return judgeResult({});
			},
		});
		const outcome = await controller.submitDecision(
			validDecisionInput({ evidence: [evidence("user", "I think it is done")] }),
		);
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(outcome.reasons.join(" ")).toContain("execution");
		expect(called).toBe(false);
	});

	test("exhausted iterations escalate to ask_user without further judge calls", async () => {
		let calls = 0;
		const controller = createJevController({
			judge: async () => {
				calls++;
				return { verdict: "revise", reasons: [`nope ${calls}`] };
			},
			maxReworkIterations: 3,
		});
		for (let i = 0; i < 3; i++) {
			const r = await controller.submitDecision(validDecisionInput({ proposal: `attempt ${i}` }));
			expect(r.verdict).toBe("revise");
		}
		expect(calls).toBe(3);
		const r4 = await controller.submitDecision(validDecisionInput({ proposal: "attempt 3" }));
		expect(r4.verdict).toBe("ask_user");
		expect(calls).toBe(3); // bound reached, no further judge calls
		expect(controller.getState().blockers.length).toBeGreaterThan(0);
	});

	test("completion capability coverage: coverage judge with requireAll over the union inventory; caller cannot narrow", async () => {
		const markings: Record<string, AspectMarking> = {
			"csv-export": "applicable_not_addressed",
			"auth-retry": "applicable_and_addressed",
		};
		let seen: AspectCoverageRequest | undefined;
		const controller = createJevController({
			judge: async () => judgeResult({}),
			template: { capabilities: ["csv-export"] },
			aspectCoverageJudge: async req => {
				seen = req;
				return { markings: { ...markings }, reasons: ["judged"], judged: true };
			},
		});
		const denied = await controller.submitDecision(
			validDecisionInput({ capabilities: ["auth-retry"] }),
		);
		expect(denied.verdict).toBe("revise");
		expect(denied.reasons.join(" ")).toContain("csv-export");
		expect(seen?.requireAll).toBe(true);
		expect([...(seen?.aspects.map(a => a.id) ?? [])].sort()).toEqual(["auth-retry", "csv-export"]);
		// once the coverage judge marks every declared capability addressed, completion proceeds
		markings["csv-export"] = "applicable_and_addressed";
		const ok = await controller.submitDecision(validDecisionInput({ capabilities: ["auth-retry"] }));
		expect(ok.verdict).toBe("approve");
		// caller cannot narrow the template inventory by omitting capabilities
		markings["csv-export"] = "applicable_not_addressed";
		const narrowed = await controller.submitDecision(validDecisionInput());
		expect(narrowed.verdict).toBe("revise");
		expect(narrowed.reasons.join(" ")).toContain("csv-export");
	});

	test("completion capability coverage: not_applicable cannot satisfy a required capability", async () => {
		const controller = createJevController({
			judge: async () => judgeResult({}),
			template: { capabilities: ["csv-export"] },
			aspectCoverageJudge: async () => ({
				markings: { "csv-export": "not_applicable" },
				reasons: ["judged"],
				judged: true,
			}),
		});
		const denied = await controller.submitDecision(validDecisionInput());
		expect(denied.verdict).toBe("revise");
		expect(denied.reasons.join(" ")).toContain("csv-export");
	});

	test("completion capability coverage fails closed: no wired judge, escape, unjudged, throw", async () => {
		const noJudge = createJevController({
			judge: async () => judgeResult({}),
			template: { capabilities: ["csv-export"] },
		});
		const unwired = await noJudge.submitDecision(validDecisionInput());
		expect(unwired.verdict).toBe("insufficient_evidence");
		expect(unwired.judged).toBe(false);
		expect(noJudge.getState().approvals.length).toBe(0);

		let mode: "escape" | "unjudged" | "throw" = "escape";
		const controller = createJevController({
			judge: async () => judgeResult({}),
			template: { capabilities: ["csv-export"] },
			aspectCoverageJudge: async (): Promise<AspectCoverageResult> => {
				if (mode === "escape") return { markings: {}, reasons: ["meta_option"], judged: true, escape: true };
				if (mode === "unjudged") return { markings: {}, reasons: ["bad_payload"], judged: false };
				throw new Error("coverage endpoint down");
			},
		});
		for (mode of ["escape", "unjudged", "throw"] as const) {
			const outcome = await controller.submitDecision(validDecisionInput());
			expect(outcome.verdict).toBe("insufficient_evidence");
			expect(controller.getState().approvals.length).toBe(0);
		}
	});

	test("low-confidence judge approval is demoted, never records approval", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async (req: DecisionRequest) =>
				req.stage === "completion_review" ? judgeResult({ confidence: 0.4 }) : judgeResult({}),
		});
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		const outcome = await controller.submitDecision(validDecisionInput());
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(stopResult(await runStop(harness))?.decision).toBe("block");
	});

	test("malformed judge payload never approves", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async () => ({ verdict: "approve", reasons: [] }), // no selectedOption
		});
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		const outcome = await controller.submitDecision(validDecisionInput());
		expect(outcome.verdict).toBe("insufficient_evidence");
	});

	test("tool_call pre-validation blocks malformed jev_decision input before execution", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		const res = blockResult(await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "jev_decision",
			input: { stage: "completion_review" },
		}));
		expect(res?.block).toBe(true);
		expect(String(res?.reason)).toContain("evidence");
	});

	test("subagent model routing only among host-listed models", () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		// no routing decision yet => no interference
		const none = controller.onBeforeSubagentSpawn(
			{ type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns: ["x/y"] },
			["a/b", "c/d"],
		);
		expect(none).toBeUndefined();
		controller.rememberModelRouting("m1/fast");
		const ok = controller.onBeforeSubagentSpawn(
			{ type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns: ["x/y"] },
			["m1/fast", "c/d"],
		);
		expect(ok?.model).toBe("m1/fast");
		const blocked = controller.onBeforeSubagentSpawn(
			{ type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns: ["x/y"] },
			["c/d"],
		);
		expect(blocked?.block).toBe(true);
		expect(String(blocked?.reason)).toContain("m1/fast");
	});

	test("session continuity: state restored from jev.state custom entries", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		await controller.submitDecision(validDecisionInput());
		await controller.submitDecision(courseCheckGateInput());
		const saved = harness.appended.filter(a => a.customType === "jev.state");
		expect(saved.length).toBeGreaterThan(0);
		// simulate restart: new controller, same session entries
		const harness2 = makeFakePi();
		const controller2 = createJevController({ judge: gateJudge() });
		controller2.register(harness2.pi);
		controller2.onSessionStart(saved.map(a => ({ customType: a.customType, data: a.data as JevState })));
		// the restored fresh course check keeps the completion boundary satisfied
		expect(stopResult(await runStop(harness2))?.decision).toBeUndefined();
	});

	test("stop_hook_active pass records explicit unresolved blocker, never fake success", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		const res = (await runStop(harness, true));
		expect(res?.decision).toBeUndefined();
		expect(controller.getState().blockers.join(" ")).toContain("completion_review");
	});

	test("revise verdicts reach the same session as feedback messages", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => ({ verdict: "revise", reasons: ["add logs"] }) });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		const outcome = await controller.submitDecision(validDecisionInput());
		expect(outcome.verdict).toBe("revise");
		expect(outcome.reasons).toContain("add logs");
		// revise reasons must have been pushed as a same-session message
		expect(harness.sentMessages.length).toBeGreaterThan(0);
	});

	test("plan gate: mutations blocked before plan approval, allowed after; full flow stops clean", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "build it", systemPrompt: [] });
		// read-only tools stay allowed under the gate (AC4)
		expect(controller.onToolCall({ type: "tool_call", toolCallId: "r", toolName: "read", input: {} })).toBeUndefined();
		for (const mutating of ["edit", "write", "ast_edit", "bash", "memory_edit", "manage_skill"]) {
			const res = blockResult(
				await harness.emit("tool_call", { type: "tool_call", toolCallId: `m-${mutating}`, toolName: mutating, input: {} }),
			);
			expect(res?.block).toBe(true);
		}
		const reasonSample = blockResult(
			await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} }),
		);
		expect(String(reasonSample?.reason)).toContain("plan gate");
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		expect(
			blockResult(await harness.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "edit", input: {} }))
				?.block,
		).toBeUndefined();
		await controller.submitDecision(validDecisionInput());
		await controller.submitDecision(courseCheckGateInput());
		expect(stopResult(await runStop(harness))?.decision).toBeUndefined();
	});


	function courseInput(overrides: Record<string, unknown> = {}) {
		return {
			stage: "course_check",
			task: "REQ-1 user quote: login must persist",
			proposal: "mid-progress status",
			evidence: [evidence("execution", "tests pass")],
			options: COURSE_OPTIONS,
			...overrides,
		};
	}

	test("course_check: end-to-end verdict mapping (record/redirect/escalate, rework-only burn)", async () => {
		const harness = makeFakePi();
		let next: DecisionResult = judgeResult({ selectedOption: "continue" });
		const controller = createJevController({ judge: async () => next });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "requirement work", systemPrompt: [] });

		// fixed option set enforced when no template override
		const bad = await controller.submitDecision(courseInput({ options: OPTIONS }));
		expect(bad.verdict).toBe("insufficient_evidence");
		expect(bad.judged).toBe(false);

		// continue: recorded, approves nothing, consumes no rework
		const cont = await controller.submitDecision(courseInput());
		expect(cont.verdict).toBe("approve");
		expect(controller.getState().lastCourseCheck?.selectedOption).toBe("continue");
		expect(controller.getState().approvals.some(a => a.stage === "course_check")).toBe(false);
		expect(Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0)).toBe(0);

		// return_to_requirement: revise + same-session feedback + rework burn
		next = judgeResult({ selectedOption: "return_to_requirement" });
		const redirect = await controller.submitDecision(courseInput());
		expect(redirect.verdict).toBe("revise");
		expect(redirect.reasons.join(" ")).toContain("return_to_requirement");
		expect(harness.sentMessages.length).toBeGreaterThan(0);
		expect(Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0)).toBe(1);

		// verify_before_proceeding recorded without consuming rework
		next = judgeResult({ selectedOption: "verify_before_proceeding" });
		await controller.submitDecision(courseInput());
		expect(controller.getState().lastCourseCheck?.selectedOption).toBe("verify_before_proceeding");
		expect(Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0)).toBe(1);

		// ask_user (judge choice) escalates with recorded blocker and burns rework
		next = judgeResult({ selectedOption: "ask_user" });
		const esc = await controller.submitDecision(courseInput());
		expect(esc.verdict).toBe("ask_user");
		expect(controller.getState().blockers.join(" ")).toContain("course_check");
		expect(Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0)).toBe(2);
	});

	test("generic course_check: judge error fail-closed, burns rework; verify_before_proceeding recorded without approval", async () => {
		const controller = createJevController({
			judge: async (req: DecisionRequest) => {
				if (req.task === "transport down") throw new Error("endpoint down");
				return judgeResult({ selectedOption: "verify_before_proceeding", confidence: 0.9 });
			},
		});
		const errOutcome = await controller.submitDecision(courseInput({ task: "transport down" }));
		expect(errOutcome.verdict).toBe("insufficient_evidence");
		expect(errOutcome.judged).toBe(false);
		expect(controller.getState().lastCourseCheck).toBeUndefined();
		// the failed consultation is rework
		expect(Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0)).toBe(1);

		const low = await controller.submitDecision(courseInput());
		expect(low.verdict).toBe("approve");
		expect(controller.getState().lastCourseCheck?.selectedOption).toBe("verify_before_proceeding");
		// recorded, but grants no approval and consumes no rework
		expect(controller.getState().approvals.length).toBe(0);
		expect(Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0)).toBe(1);
	});

	test("C1 wired course_check: per-requirement drift via injected courseCheckJudge", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async () => {
				throw new Error("standard judge must not be consulted for wired course_check");
			},
			courseCheckJudge: async req => {
				expect(req.requirements.map(r => r.id)).toEqual(["REQ1", "REQ2"]);
				expect(req.requirements[0]?.quote).toContain("login must persist");
				return {
					onTrack: { REQ1: true, REQ2: false },
					nextAction: "return_to_requirement",
					reasons: ["drift on REQ2"],
					judged: true,
				};
			},
		});
		controller.register(harness.pi);
		const outcome = await controller.submitDecision(
			courseInput({
				evidence: [
					evidence("user", "REQ-1 user quote: login must persist", "REQ1"),
					evidence("spec", "REQ-2 spec quote: export to csv", "REQ2"),
					evidence("execution", "tests pass"),
				],
			}),
		);
		expect(outcome.verdict).toBe("revise");
		expect(outcome.reasons.join(" ")).toContain("not on track: REQ2");
		expect(harness.sentMessages.length).toBeGreaterThan(0);
		expect(controller.getState().approvals.length).toBe(0);
	});

	test("C1 wired course_check: all on track + continue records without approval", async () => {
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			courseCheckJudge: async req => ({
				onTrack: Object.fromEntries(req.requirements.map(r => [r.id, true] as const)),
				nextAction: "continue",
				reasons: [],
				judged: true,
				confidence: 0.9,
			}),
		});
		const outcome = await controller.submitDecision(
			courseInput({ evidence: [evidence("user", "REQ-1 user quote: login must persist", "REQ1"), evidence("execution", "tests pass")] }),
		);
		expect(outcome.verdict).toBe("approve");
		expect(outcome.selectedOption).toBe("continue");
		expect(controller.getState().lastCourseCheck?.selectedOption).toBe("continue");
		expect(controller.getState().approvals.length).toBe(0);
	});

	test("C1 wired course_check: duplicate requirement ids deduped deterministically, none dropped", async () => {
		let seen: Array<{ id: string; quote: string }> = [];
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			courseCheckJudge: async req => {
				seen = req.requirements;
				return {
					onTrack: Object.fromEntries(req.requirements.map(r => [r.id, true] as const)),
					nextAction: "continue",
					reasons: [],
					judged: true,
					confidence: 0.9,
				};
			},
		});
		const outcome = await controller.submitDecision(
			courseInput({
				evidence: [
					evidence("user", "REQ user quote: login sessions must persist across restarts"),
					evidence("user", "REQ user quote: login sessions must persist across restarts"), // exact duplicate -> merged
					evidence("spec", "REQ spec quote: session expiry policy differs by tier"), // same id, different quote -> #2
					evidence("execution", "dry-run output: all checks green"),
				],
			}),
		);
		expect(outcome.verdict).toBe("approve");
		expect(seen.map(r => r.id)).toEqual(["test", "test#2"]);
		expect(seen[1]?.quote).toContain("session expiry");
	});

	test("polish5: drift ids named in summary; zero-drift summary unchanged", async () => {
		let drift = true;
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			courseCheckJudge: async req => ({
				onTrack: Object.fromEntries(req.requirements.map(r => [r.id, !drift] as const)),
				nextAction: "return_to_requirement",
				reasons: [],
				judged: true,
				confidence: 0.9,
			}),
		});
		const drifted = await controller.submitDecision(
			courseInput({
				evidence: [
					evidence("user", "REQ1 user quote: login sessions persist", "REQ1"),
					evidence("spec", "REQ2 spec quote: csv export columns", "REQ2"),
					evidence("execution", "dry-run output: all checks green"),
				],
			}),
		);
		expect(drifted.summary).toBe("course_check: revise — return_to_requirement: back to requirement (drifted: REQ1, REQ2)");

		drift = false;
		const redirect = { ...courseInput(), proposal: "second look, everything aligned" };
		const zero = await controller.submitDecision({
			...redirect,
			evidence: [
				evidence("user", "REQ1 user quote: login sessions persist", "REQ1"),
				evidence("execution", "dry-run output: all checks green"),
			],
		});
		expect(zero.summary).toBe("course_check: revise — return_to_requirement: back to requirement");
	});

	test("C1 wired course_check: fail-closed on judge throw and unjudged result", async () => {
		let mode: "throw" | "unjudged" = "throw";
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			courseCheckJudge: async () => {
				if (mode === "throw") throw new Error("endpoint down");
				return { onTrack: {}, nextAction: "continue", reasons: [], judged: false };
			},
		});
		const thrown = await controller.submitDecision(courseInput());
		expect(thrown.verdict).toBe("insufficient_evidence");
		expect(thrown.judged).toBe(false);
		expect(controller.getState().lastCourseCheck).toBeUndefined();
		mode = "unjudged";
		const unjudged = await controller.submitDecision(courseInput());
		expect(unjudged.verdict).toBe("insufficient_evidence");
		expect(controller.getState().lastCourseCheck).toBeUndefined();
	});

	test("C1 wired course_check: requirement-less submission rejected before judge", async () => {
		let called = false;
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			courseCheckJudge: async () => {
				called = true;
				return { onTrack: {}, nextAction: "continue", reasons: [], judged: true };
			},
		});
		const outcome = await controller.submitDecision(
			courseInput({ evidence: [evidence("execution", "tests pass")] }),
		);
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(called).toBe(false);
	});

	test("registry: config-declared on_demand control point fires end-to-end, grants no approval", async () => {
		const controller = createJevController({
			judge: async (req: DecisionRequest) => {
				expect(req.stage as string).toBe("risk_assessment");
				return judgeResult({});
			},
			template: {
				controlPoints: {
					risk_assessment: { trigger: "on_demand", instructions: "weigh blast radius" },
				},
			},
		});
		const outcome = await controller.submitDecision({
			stage: "risk_assessment",
			task: "migration cutover",
			proposal: "phased plan",
			evidence: [evidence("log", "dry-run ok")],
			options: OPTIONS,
		});
		expect(outcome.verdict).toBe("approve");
		expect(controller.getState().approvals.length).toBe(0);
	});

	test("templateError state fails closed on every submission (config corruption mid-session)", async () => {
		const controller = createJevController({
			judge: async () => judgeResult({}),
			templateError: 'controlPoints.cut_files must declare trigger "on_demand" (gate triggers are a roadmap item)',
		});
		const outcome = await controller.submitDecision(validDecisionInput());
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(outcome.judged).toBe(false);
		expect(outcome.reasons.join(" ")).toContain("fail-closed");
	});

	test("round6/7: openAspectGaps restored from persisted state keeps completion teeth", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			catalogIds: new Set(ASPECTS),
			aspectCoverageJudge: async () => ({
				markings: { "topic-a": "applicable_and_addressed", "topic-b": "applicable_not_addressed" },
				reasons: [],
				judged: true,
			}),
		});
		controller.register(harness.pi);
		await controller.submitDecision(
			aspectInput({
				evidence: [evidence("spec", "REQ spec quote covering both aspects here"), evidence("execution", "dry-run output ok")],
			}),
		);
		expect(controller.getState().openAspectGaps?.missed).toBeDefined();
		const saved = harness.appended.filter(a => a.customType === "jev.state");
		const harness2 = makeFakePi();
		const controller2 = createJevController({ judge: async () => judgeResult({}) });
		controller2.register(harness2.pi);
		const last = saved[saved.length - 1]?.data;
		controller2.onSessionStart([{ customType: "jev.state", data: last }]);
		expect(controller2.getState().openAspectGaps?.missed).toBeDefined();
	});

	test("round6/7 F1: raised threshold keeps single strict bar, no streak credit", async () => {
		const controller = createJevController({
			judge: async () => judgeResult({ confidence: 0.65 }),
			template: { confidenceThreshold: 0.9 },
		});
		const first = await controller.submitDecision(validDecisionInput());
		const second = await controller.submitDecision(validDecisionInput());
		expect(first.verdict).toBe("insufficient_evidence");
		expect(second.verdict).toBe("insufficient_evidence");
		expect(controller.getState().approvals.length).toBe(0);
		expect(controller.getState().consecutiveCompletionApproves).toBeUndefined();
	});

	test("P3: duplicate + short evidence rejected pre-judge without counter burn", async () => {
		const harness = makeFakePi();
		let conf = 0.7;
		const controller = createJevController({
			judge: async (req: DecisionRequest) =>
				req.stage === "course_check"
					? judgeResult({ selectedOption: "continue" })
					: judgeResult({ confidence: req.stage === "understanding_review" ? 0.95 : conf }),
		});
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		const first = await controller.submitDecision(validDecisionInput());
		expect(first.verdict).toBe("insufficient_evidence");
		expect(first.judged).toBe(true);
		expect(first.reasons.join(" ")).toContain("completion_pending_consecutive_approves");
		expect(first.reasons.join(" ")).toContain("n=1/2");
		conf = 0.75;
		const second = await controller.submitDecision(validDecisionInput());
		expect(second.verdict).toBe("approve");
		expect(second.reasons.join(" ")).toContain("consecutive_approves");
		expect(controller.getState().approvals.some(a => a.stage === "completion_review")).toBe(true);
		await controller.submitDecision(courseCheckGateInput());
		expect(stopResult(await runStop(harness))?.decision).toBeUndefined();
	});

	test("calibration rule: non-approve resets the streak; 0.59 below floor never counts", async () => {
		let mode: "mid" | "revise" | "low" = "mid";
		const controller = createJevController({
			judge: async () => {
				if (mode === "revise") return { verdict: "revise", reasons: ["no"] };
				return judgeResult({ confidence: mode === "low" ? 0.59 : 0.7 });
			},
		});
		await controller.submitDecision(validDecisionInput()); // n=1
		mode = "revise";
		await controller.submitDecision(validDecisionInput({ proposal: "changed after revise feedback" }));
		mode = "mid";
		const after = await controller.submitDecision(
			validDecisionInput({ proposal: "changed after revise feedback" }),
		);
		expect(after.reasons.join(" ")).toContain("n=1/2"); // streak restarted
		// Below-floor phase on a fresh controller (bound budget already spent above).
		mode = "low";
		const lowController = createJevController({
			judge: async () => judgeResult({ confidence: 0.59 }),
		});
		const low = await lowController.submitDecision(validDecisionInput());
		// Normalization demotes sub-floor confidence (its own message); streak never counts.
		expect(low.verdict).toBe("insufficient_evidence");
		expect(low.judged).toBe(true);
		expect(lowController.getState().consecutiveCompletionApproves).toBeUndefined();
		expect(lowController.getState().approvals.length).toBe(0);
	});

	test("calibration rule: template raise respected (count 3 clamp)", async () => {
		let calls = 0;
		const controller = createJevController({
			judge: async () => {
				calls++;
				return judgeResult({ confidence: 0.7 });
			},
			template: { completion: { consecutiveApproves: 3 } },
		});
		const first = await controller.submitDecision(validDecisionInput());
		const second = await controller.submitDecision(validDecisionInput());
		expect(first.verdict).toBe("insufficient_evidence");
		expect(second.reasons.join(" ")).toContain("n=2/3");
		expect(calls).toBe(2);
	});

	test("polish3: directive text present in description, block reason and pre-judge rejection", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		const tool = harness.getTool();
		expect(String(tool?.description)).toContain("your very next tool call MUST be jev_decision itself");
		const gate = blockResult(
			await harness.emit("tool_call", { type: "tool_call", toolCallId: "g", toolName: "edit", input: {} }),
		);
		expect(String(gate?.reason)).toContain("a normal registered tool call, exactly like read/write");
		const rejected = blockResult(
			await harness.emit("tool_call", {
				type: "tool_call",
				toolCallId: "j",
				toolName: "jev_decision",
				input: { stage: "completion_review" },
			}),
		);
		expect(String(rejected?.reason)).toContain("Fix the listed problems and call jev_decision again");
	});

	const ASPECTS = ["topic-a", "topic-b"];
	const aspectInput = (overrides: Record<string, unknown> = {}) => ({
		stage: "aspect_coverage",
		task: "coverage check",
		proposal: "built both aspects",
		options: OPTIONS,
		evidence: [evidence("code", "implemented topic-a handling fully here")],
		aspects: ASPECTS,
		...overrides,
	});

	test("aspect_coverage: three-way marking -> missed aspects revise with ids + completion teeth", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async () => {
				throw new Error("standard judge must not be called");
			},
			catalogIds: new Set(ASPECTS),
			aspectCoverageJudge: async () => ({
				markings: { "topic-a": "applicable_and_addressed", "topic-b": "applicable_not_addressed" },
				reasons: ["b missed"],
				judged: true,
			}),
		});
		controller.register(harness.pi);
		const outcome = await controller.submitDecision(aspectInput());
		expect(outcome.verdict).toBe("revise");
		expect(outcome.reasons.join(" ")).toContain("topic-b");
		expect(harness.sentMessages.length).toBeGreaterThan(0);

		// completion teeth: unmetStopGates names open gaps while fingerprint matches
		const gaps = controller.getState().openAspectGaps;
		expect(gaps?.missed).toEqual(["topic-b"]);
		const gates = await controller.onSessionStop({
			type: "session_stop",
			messages: [],
			turn_id: 1,
			session_id: "s",
			stop_hook_active: false,
		});
		// mutations not seen -> no gates; teeth apply only when completion gate is evaluated
		expect(controller.getState().openAspectGaps?.missed).toEqual(["topic-b"]);

		// resubmission clearing the gap
		const clearing = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			catalogIds: new Set(ASPECTS),
			aspectCoverageJudge: async () => ({
				markings: { "topic-a": "applicable_and_addressed", "topic-b": "applicable_and_addressed" },
				reasons: [],
				judged: true,
			}),
		});
		const ok = await clearing.submitDecision(aspectInput());
		expect(ok.verdict).toBe("approve");
		expect(ok.summary).toBe("aspect_coverage: approve — all applicable aspects addressed");
		expect(clearing.getState().openAspectGaps).toBeUndefined();
	});

	test("aspect_coverage: not_applicable + judged approve records no approval", async () => {
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			catalogIds: new Set(ASPECTS),
			aspectCoverageJudge: async () => ({
				markings: { "topic-a": "applicable_and_addressed", "topic-b": "not_applicable" },
				reasons: [],
				judged: true,
			}),
		});
		const outcome = await controller.submitDecision(aspectInput());
		expect(outcome.verdict).toBe("approve");
		expect(controller.getState().approvals.length).toBe(0);
	});

	test("aspect_coverage: catalog pre-check rejects unknown ids, no judge, no counter burn", async () => {
		let called = false;
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			catalogIds: new Set(ASPECTS),
			aspectCoverageJudge: async () => {
				called = true;
				return { markings: {}, reasons: [], judged: true };
			},
		});
		const outcome = await controller.submitDecision(aspectInput({ aspects: ["topic-a", "bogus-id"] }));
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(outcome.reasons.join(" ")).toContain("bogus-id");
		expect(outcome.judged).toBe(false);
		expect(called).toBe(false);
	});

	test("aspect_coverage: shard boundary handled inside judge (255 cap never reaches controller)", async () => {
		// Many aspects: controller forwards all; sharding is the judge's contract (<=255).
		const many = Array.from({ length: 300 }, (_, i) => `topic-${i}`);
		const seen: number[] = [];
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			catalogIds: new Set(many),
			aspectCoverageJudge: async req => {
				seen.push(req.aspects.length);
				return { markings: Object.fromEntries(req.aspects.map(a => [a.id, "not_applicable"])), reasons: [], judged: true };
			},
		});
		const outcome = await controller.submitDecision(aspectInput({ aspects: many }));
		expect(outcome.verdict).toBe("approve");
		expect(seen).toEqual([300]); // controller does not shard; judge contract owns sharding
	});

	test("aspect_coverage: judge escape / unjudged / throw all fail closed", async () => {
		let mode: "escape" | "unjudged" | "throw" = "escape";
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			catalogIds: new Set(ASPECTS),
			aspectCoverageJudge: async () => {
				if (mode === "escape") return { markings: {}, reasons: ["cannot judge"], judged: false, escape: true };
				if (mode === "unjudged") return { markings: {}, reasons: [], judged: false };
				throw new Error("endpoint down");
			},
		});
		for (mode of ["escape", "unjudged", "throw"] as const) {
			const outcome = await controller.submitDecision(aspectInput());
			expect(outcome.verdict).toBe("insufficient_evidence");
			expect(outcome.judged).toBe(false);
		}
	});

	test("aspect_coverage: unmarked aspect fails closed (judge contract violation)", async () => {
		const controller = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			catalogIds: new Set(ASPECTS),
			aspectCoverageJudge: async () => ({
				markings: { "topic-a": "applicable_and_addressed" },
				reasons: [],
				judged: true,
			}),
		});
		const outcome = await controller.submitDecision(aspectInput());
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(outcome.reasons.join(" ")).toContain("topic-b");
	});

	test("P3: duplicate + short evidence rejected pre-judge without counter burn", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		const before = Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0);
		const outcome = await controller.submitDecision(
			validDecisionInput({
				evidence: [
					evidence("execution", "same quote repeated twice here"),
					evidence("log", "same quote repeated twice here"),
					evidence("code", "tiny"),
				],
			}),
		);
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(outcome.judged).toBe(false);
		expect(outcome.reasons.join(" ")).toContain("duplicate_evidence_quote#1");
		expect(outcome.reasons.join(" ")).toContain("quote_too_short");
		const after = Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0);
		expect(after).toBe(before);
	});

	test("P3: plan stage without requirement evidence rejected", async () => {
		const controller = createJevController({ judge: async () => judgeResult({}) });
		const outcome = await controller.submitDecision(
			validDecisionInput({
				stage: "understanding_review",
				proposal: "Plan: implement feature X in module M.",
				evidence: [evidence("execution", "$ bun test run — 42 passing suites")],
			}),
		);
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(outcome.reasons).toContain("no_requirement_evidence");
	});

	test("P3: single short quote still judged with warnings populated", async () => {
		const controller = createJevController({ judge: async () => judgeResult({}) });
		const outcome = await controller.submitDecision(
			validDecisionInput({ evidence: [evidence("execution", "tiny"), evidence("code", "export function x() {}")] }),
		);
		expect(outcome.verdict).toBe("approve");
		expect(outcome.judged).toBe(true);
		expect(outcome.warnings?.[0]).toContain("quote_too_short");
	});

	test("P3: clean request carries no warnings", async () => {
		const controller = createJevController({ judge: async () => judgeResult({}) });
		const outcome = await controller.submitDecision(validDecisionInput());
		expect(outcome.verdict).toBe("approve");
		expect(outcome.warnings).toBeUndefined();
	});

	test("P2: summary templates across verdicts, meaning verbatim, tool text parses", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });

		const approve = await controller.submitDecision(validDecisionInput());
		expect(approve.summary).toBe("completion_review: approve — a: do A");

		const revising = createJevController({ judge: async () => ({ verdict: "revise", reasons: ["no"] }) });
		const rev = await revising.submitDecision(validDecisionInput());
		expect(rev.summary).toContain("completion_review: revise — sent back with reasons (iteration 1/3)");

		const bounded = createJevController({
			judge: async () => ({ verdict: "revise", reasons: ["no"] }),
			maxReworkIterations: 1,
		});
		await bounded.submitDecision(validDecisionInput());
		const esc = await bounded.submitDecision(validDecisionInput({ proposal: "attempt 2 differs entirely" }));
		expect(esc.verdict).toBe("ask_user");
		expect(esc.summary).toBe("completion_review: ask_user — escalate to the user");

		const bad = await controller.submitDecision({ stage: "completion_review" });
		expect(bad.summary).toContain("insufficient_evidence — judge not consulted");

		const tool = harness.getTool();
		expect(tool).toBeDefined();
		const result = (await tool!.execute("id", validDecisionInput(), undefined, undefined, undefined)) as {
			content: Array<{ type: string; text: string }>;
		};
		const text = result.content[0]?.text ?? "";
		const firstLine = text.split("\n")[0] ?? "";
		expect(firstLine).toBe("completion_review: approve — a: do A");
		const parsed = JSON.parse(text.slice(text.indexOf("{"))) as { verdict: string; summary: string };
		expect(parsed.verdict).toBe("approve");
		expect(parsed.summary).toBe(firstLine);
	});

	// ---------- remediation: read-only completion gate, course-check freshness, streak binding ----------

	test("read-only active task: stop demands plan, fresh course_check and completion once a task exists", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "analyze module M and report findings", systemPrompt: [] });
		const noPlan = await runStop(harness);
		expect(noPlan?.decision).toBe("block");
		expect(String(noPlan?.reason)).toContain("plan-stage approval");
		await controller.submitDecision(
			validDecisionInput({
				stage: "understanding_review",
				proposal: "Plan: analyze module M and report findings to the user.",
				evidence: [evidence("user", "analyze module M and report findings"), evidence("execution", "dry-run analysis checklist output")],
			}),
		);
		const noCheck = await runStop(harness);
		expect(noCheck?.decision).toBe("block");
		expect(String(noCheck?.reason)).toContain("course_check");
		await controller.submitDecision(courseCheckGateInput());
		const noCompletion = await runStop(harness);
		expect(noCompletion?.decision).toBe("block");
		expect(String(noCompletion?.reason)).toContain("completion_review");
		await controller.submitDecision(validDecisionInput());
		expect((await runStop(harness))?.decision).toBeUndefined();
	});

	test("work mutation after course_check makes it stale; fresh re-check re-unlocks", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		await controller.submitDecision(courseCheckGateInput());
		await controller.submitDecision(validDecisionInput());
		expect((await runStop(harness))?.decision).toBeUndefined();
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "write", input: {} });
		const stale = await runStop(harness);
		expect(stale?.decision).toBe("block");
		expect(String(stale?.reason)).toContain("course_check");
		await controller.submitDecision(courseCheckGateInput());
		await controller.submitDecision(validDecisionInput());
		expect((await runStop(harness))?.decision).toBeUndefined();
	});

	test("verify_before_proceeding is recorded but never satisfies the completion course check", async () => {
		const harness = makeFakePi();
		let pick = "verify_before_proceeding";
		const controller = createJevController({
			judge: async (req: DecisionRequest) =>
				judgeResult({ selectedOption: req.stage === "course_check" ? pick : "a" }),
		});
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		const rec = await controller.submitDecision(courseCheckGateInput());
		expect(rec.verdict).toBe("approve");
		expect(controller.getState().lastCourseCheck?.selectedOption).toBe("verify_before_proceeding");
		await controller.submitDecision(validDecisionInput());
		const blocked = await runStop(harness);
		expect(blocked?.decision).toBe("block");
		expect(String(blocked?.reason)).toContain("course_check");
		pick = "continue";
		await controller.submitDecision(courseCheckGateInput());
		expect((await runStop(harness))?.decision).toBeUndefined();
	});

	test("course_check rework bound: only redirects and failures consume it; benign never does", async () => {
		let mode: "continue" | "redirect" | "fail" | "verify" = "continue";
		let calls = 0;
		const controller = createJevController({
			judge: async () => {
				calls++;
				if (mode === "fail") throw new Error("endpoint down");
				const selected = mode === "redirect" ? "return_to_requirement" : mode === "verify" ? "verify_before_proceeding" : "continue";
				return judgeResult({ selectedOption: selected });
			},
		});
		const burn = () => Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0);
		mode = "continue";
		for (let i = 0; i < 5; i++) await controller.submitDecision(courseCheckGateInput());
		expect(burn()).toBe(0);
		mode = "redirect";
		await controller.submitDecision(courseCheckGateInput());
		expect(burn()).toBe(1);
		mode = "fail";
		const failed = await controller.submitDecision(courseCheckGateInput());
		expect(failed.verdict).toBe("insufficient_evidence");
		expect(burn()).toBe(2);
		mode = "verify";
		await controller.submitDecision(courseCheckGateInput());
		expect(burn()).toBe(2);
		mode = "redirect";
		await controller.submitDecision(courseCheckGateInput());
		expect(burn()).toBe(3);
		const exhausted = await controller.submitDecision(courseCheckGateInput());
		expect(exhausted.verdict).toBe("ask_user");
		expect(calls).toBe(9); // bound reached, no further judge calls
		expect(controller.getState().blockers.join(" ")).toContain("course_check");
	});

	test("wired course_check validates result contract: fixed action, exact onTrack keys, finite confidence at/above floor; drift never continues", async () => {
		const cases: Array<{ result: CourseCheckResult; why: string }> = [
			{ result: { onTrack: { REQ: true }, nextAction: "continue", reasons: [], judged: true }, why: "confidence missing" },
			{ result: { onTrack: { REQ: true }, nextAction: "continue", reasons: [], judged: true, confidence: Number.NaN }, why: "confidence NaN" },
			{ result: { onTrack: { REQ: true }, nextAction: "continue", reasons: [], judged: true, confidence: 0.5 }, why: "confidence below floor" },
			{ result: { onTrack: {}, nextAction: "continue", reasons: [], judged: true, confidence: 0.9 }, why: "onTrack missing requirement" },
			{ result: { onTrack: { REQ: true, EXTRA: true }, nextAction: "continue", reasons: [], judged: true, confidence: 0.9 }, why: "onTrack extra key" },
			{ result: { onTrack: { REQ: false }, nextAction: "continue", reasons: [], judged: true, confidence: 0.9 }, why: "drift must not continue" },
			{
				// deliberately outside the fixed action union: a contract violation
				result: { onTrack: { REQ: true }, nextAction: "proceed", reasons: [], judged: true, confidence: 0.9 } as unknown as CourseCheckResult,
				why: "unknown next action",
			},
		];
		for (const c of cases) {
			const controller = createJevController({
				judge: async () => {
					throw new Error("must not be called");
				},
				courseCheckJudge: async () => c.result,
			});
			const outcome = await controller.submitDecision(courseCheckGateInput());
			expect(outcome.verdict, c.why).toBe("insufficient_evidence");
			expect(controller.getState().lastCourseCheck, c.why).toBeUndefined();
		}
		const ok = createJevController({
			judge: async () => {
				throw new Error("must not be called");
			},
			courseCheckJudge: async req => ({
				onTrack: Object.fromEntries(req.requirements.map(r => [r.id, true] as const)),
				nextAction: "continue",
				reasons: ["judged"],
				judged: true,
				confidence: 0.6, // exactly at the floor still counts
			}),
		});
		const good = await ok.submitDecision(courseCheckGateInput());
		expect(good.verdict).toBe("approve");
		expect(ok.getState().lastCourseCheck?.selectedOption).toBe("continue");
	});

	test("typed completionCandidate: counted only at completion and default bar; promotion after streak records the approval", async () => {
		const midBand: DecisionResult = {
			verdict: "insufficient_evidence",
			reasons: ["raw approve demoted: mid-band"],
			confidence: 0.7,
			completionCandidate: { selectedOption: "a" },
		};
		const controller = createJevController({ judge: async () => midBand });
		// non-completion stage: the same shape is a plain insufficient, never counted
		const other = await controller.submitDecision({
			stage: "task_classification",
			task: "classify the workload",
			proposal: "development task classification",
			options: OPTIONS,
			evidence: [evidence("user", "classify this workload request for the dashboard")],
		});
		expect(other.verdict).toBe("insufficient_evidence");
		expect(controller.getState().consecutiveCompletionApproves).toBeUndefined();
		// completion: first candidate counts toward the streak
		const first = await controller.submitDecision(validDecisionInput());
		expect(first.verdict).toBe("insufficient_evidence");
		expect(first.reasons.join(" ")).toContain("n=1/2");
		expect(controller.getState().consecutiveCompletionApproves?.count).toBe(1);
		// changed content is a new revision: the streak restarts
		const changedProposal = "Feature X implemented differently: module rewritten end to end.";
		const changed = await controller.submitDecision(validDecisionInput({ proposal: changedProposal }));
		expect(changed.reasons.join(" ")).toContain("n=1/2");
		// same content again completes the streak and promotes the candidate
		const promoted = await controller.submitDecision(validDecisionInput({ proposal: changedProposal }));
		expect(promoted.verdict).toBe("approve");
		expect(promoted.selectedOption).toBe("a");
		expect(promoted.reasons.join(" ")).toContain("consecutive_approves");
		expect(controller.getState().approvals.some(a => a.stage === "completion_review")).toBe(true);
	});

	test("completionCandidate validation: unoffered option, sub-floor confidence and reason strings never count", async () => {
		const unoffered = createJevController({
			judge: async () => ({
				verdict: "insufficient_evidence",
				reasons: ["mid-band"],
				confidence: 0.7,
				completionCandidate: { selectedOption: "zz" },
			}),
		});
		const r1 = await unoffered.submitDecision(validDecisionInput());
		expect(r1.verdict).toBe("insufficient_evidence");
		expect(r1.reasons.join(" ")).not.toContain("completion_pending");
		expect(unoffered.getState().consecutiveCompletionApproves).toBeUndefined();

		const subFloor = createJevController({
			judge: async () => ({
				verdict: "insufficient_evidence",
				reasons: ["mid-band"],
				confidence: 0.5,
				completionCandidate: { selectedOption: "a" },
			}),
		});
		const r2 = await subFloor.submitDecision(validDecisionInput());
		expect(r2.verdict).toBe("insufficient_evidence");
		expect(subFloor.getState().consecutiveCompletionApproves).toBeUndefined();

		const sneaky = createJevController({
			judge: async () => ({
				verdict: "insufficient_evidence",
				reasons: ["completionCandidate selectedOption a mid-band approve"],
				confidence: 0.7,
			}),
		});
		const r3 = await sneaky.submitDecision(validDecisionInput());
		expect(r3.verdict).toBe("insufficient_evidence");
		expect(sneaky.getState().consecutiveCompletionApproves).toBeUndefined();
	});

	test("raised completion config applies on template reload", async () => {
		const controller = createJevController({ judge: async () => judgeResult({ confidence: 0.7 }) });
		const first = await controller.submitDecision(validDecisionInput());
		expect(first.reasons.join(" ")).toContain("n=1/2");
		controller.setTemplateState({ completion: { consecutiveApproves: 3 } });
		const second = await controller.submitDecision(validDecisionInput());
		expect(second.verdict).toBe("insufficient_evidence");
		expect(second.reasons.join(" ")).toContain("n=2/3");
	});

	test("completion streak breaks on revise, invalid submission and judge errors", async () => {
		let mode: "mid" | "revise" | "throw" = "mid";
		const controller = createJevController({
			judge: async () => {
				if (mode === "revise") return { verdict: "revise", reasons: ["rework needed"] };
				if (mode === "throw") throw new Error("transport down");
				return {
					verdict: "insufficient_evidence",
					reasons: ["mid-band"],
					confidence: 0.7,
					completionCandidate: { selectedOption: "a" },
				};
			},
			maxReworkIterations: 10, // interruptions are under test here, not the bound
		});
		const proposal = "Feature X implemented: module added, tests pass.";
		await controller.submitDecision(validDecisionInput({ proposal }));
		expect(controller.getState().consecutiveCompletionApproves?.count).toBe(1);
		mode = "revise";
		await controller.submitDecision(validDecisionInput({ proposal: "adjusted after revise feedback" }));
		expect(controller.getState().consecutiveCompletionApproves).toBeUndefined();
		mode = "mid";
		await controller.submitDecision(validDecisionInput({ proposal: "adjusted after revise feedback" }));
		expect(controller.getState().consecutiveCompletionApproves?.count).toBe(1); // restarted
		await controller.submitDecision(validDecisionInput({ proposal: "adjusted after revise feedback", evidence: [] }));
		expect(controller.getState().consecutiveCompletionApproves).toBeUndefined();
		await controller.submitDecision(validDecisionInput({ proposal: "adjusted after revise feedback" }));
		expect(controller.getState().consecutiveCompletionApproves?.count).toBe(1);
		mode = "throw";
		await controller.submitDecision(validDecisionInput({ proposal: "adjusted after revise feedback" }));
		expect(controller.getState().consecutiveCompletionApproves).toBeUndefined();
	});

	test("invalid template blocks mutations and stop even with restored approvals", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		await controller.submitDecision(validDecisionInput());
		await controller.submitDecision(courseCheckGateInput());
		expect(stopResult(await runStop(harness))?.decision).toBeUndefined();
		const saved = harness.appended.filter(a => a.customType === "jev.state");
		// restart: approvals (and the fresh course check) restore; stop stays free
		const harness2 = makeFakePi();
		const controller2 = createJevController({ judge: gateJudge() });
		controller2.register(harness2.pi);
		controller2.onSessionStart(saved.map(a => ({ customType: a.customType, data: a.data as JevState })));
		expect(stopResult(await runStop(harness2))?.decision).toBeUndefined();
		// config turns invalid mid-session: restored approvals no longer unlock anything
		controller2.setTemplateState(undefined, "jev.config.json: controlPoints.cut_files must declare trigger on_demand");
		const mutation = blockResult(await harness2.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "write", input: {} }));
		expect(mutation?.block).toBe(true);
		expect(String(mutation?.reason)).toContain("fail-closed");
		const stop = await runStop(harness2);
		expect(stop?.decision).toBe("block");
		expect(String(stop?.reason)).toContain("fail-closed");
		const outcome = await controller2.submitDecision(validDecisionInput());
		expect(outcome.verdict).toBe("insufficient_evidence");
		expect(outcome.judged).toBe(false);
	});

	test("jev_decision tool schema exposes aspects for the aspect_coverage preset", () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		const tool = harness.getTool();
		const params = tool?.parameters as { properties?: Record<string, unknown> } | undefined;
		expect(params?.properties?.["aspects"]).toBeDefined();
		expect(String(tool?.description)).toContain("course_check");
	});
});

describe("jev controller: gates.mutation switch", () => {
	test("gates.mutation=false lifts the plan gate for every mutating tool", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge(), template: { gates: { mutation: false } } });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "build it", systemPrompt: [] });
		for (const mutating of ["edit", "write", "ast_edit", "bash", "memory_edit", "manage_skill"]) {
			const res = blockResult(
				await harness.emit("tool_call", { type: "tool_call", toolCallId: `m-${mutating}`, toolName: mutating, input: {} }),
			);
			expect(res.block).toBeUndefined();
		}
	});

	test("gates.mutation=false: the stop gate drops the plan-approval requirement, keeps completion", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge(), template: { gates: { mutation: false } } });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "build it", systemPrompt: [] });
		const res = await runStop(harness);
		expect(res.decision).toBe("block");
		expect(String(res.reason)).not.toContain("plan-stage approval");
		expect(String(res.reason)).toContain("completion_review");
	});

	test("without the switch the plan gate still blocks", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "build it", systemPrompt: [] });
		const res = blockResult(
			await harness.emit("tool_call", { type: "tool_call", toolCallId: "m", toolName: "edit", input: {} }),
		);
		expect(res.block).toBe(true);
	});
});

describe("jev controller: eval coverage", () => {
	test("eval is blocked by the plan gate like the other mutation-capable builtins", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "build it", systemPrompt: [] });
		const res = blockResult(
			await harness.emit("tool_call", { type: "tool_call", toolCallId: "e", toolName: "eval", input: {} }),
		);
		expect(res.block).toBe(true);
		expect(String(res.reason)).toContain("plan gate");
	});
});

describe("jev controller: plan-stage directive text", () => {
	test("the tool description tells the executor to phrase plans as claims against quotes", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		const description = String(harness.getTool()?.description);
		expect(description).toContain("claims checked against the quoted evidence");
		expect(description).toContain("insufficient_evidence");
	});
});

describe("jev controller: submission language rule", () => {
	test("the tool description requires English submissions and verbatim quotes", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		const description = String(harness.getTool()?.description);
		expect(description).toContain("in English");
		expect(description).toContain("verbatim");
	});
});

describe("jev controller: gates.completion switch", () => {
	test("gates.completion=false lets the session stop with no approvals recorded", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge(), template: { gates: { completion: false } } });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "build it", systemPrompt: [] });
		const res = await runStop(harness);
		expect(res.decision).toBeUndefined();
	});

	test("without the switch the stop gate still demands completion evidence", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: gateJudge() });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "build it", systemPrompt: [] });
		const res = await runStop(harness);
		expect(res.decision).toBe("block");
		expect(String(res.reason)).toContain("course_check");
	});
});
