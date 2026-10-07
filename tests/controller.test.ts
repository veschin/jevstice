/**
 * Behavioral tests for the Jev decision controller (extension slice).
 * Drafted before implementation (TDD); runs under `bun test`.
 */
import { describe, expect, test } from "bun:test";
import { createJevController, type JevState } from "../src/controller.js";
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

function validDecisionInput(overrides: Record<string, unknown> = {}) {
	return {
		stage: "completion_review",
		task: "Implement feature X",
		proposal: "Feature X implemented: module added, tests pass.",
		options: OPTIONS,
		evidence: [evidence("execution", "$ bun test\n42 pass"), evidence("code", "export function x() {}")],
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
				return judgeResult({});
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
		const allowed = (await runStop(harness));
		expect(allowed?.decision).toBeUndefined();
	});

	test("stale approval: work changed after approval re-blocks stop", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		await controller.submitDecision(validDecisionInput());
		expect(stopResult(await runStop(harness))?.decision).toBeUndefined();
		// new work lands after the approval
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "write", input: {} });
		const res = (await runStop(harness));
		expect(res?.decision).toBe("block");
		expect(String(res?.reason)).toContain("stale");
	});

	test("changed task (new user prompt) invalidates prior approval", async () => {
		const harness = makeFakePi();
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "task one", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		await controller.submitDecision(validDecisionInput());
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

	test("requirement coverage: refactor completion needs every capability evidenced", async () => {
		const controller = createJevController({ judge: async () => judgeResult({}) });
		const missing = await controller.submitDecision(
			validDecisionInput({
				stage: "completion_review",
				capabilities: ["auth-retry", "csv-export"],
				evidence: [evidence("code", "handles auth-retry path"), evidence("execution", "tests pass")],
			}),
		);
		expect(missing.verdict).toBe("revise");
		expect(missing.reasons.join(" ")).toContain("csv-export");
		const covered = await controller.submitDecision(
			validDecisionInput({
				stage: "completion_review",
				capabilities: ["auth-retry", "csv-export"],
				evidence: [evidence("code", "auth-retry and csv-export both implemented"), evidence("execution", "tests pass")],
			}),
		);
		expect(covered.verdict).toBe("approve");
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
		const controller = createJevController({ judge: async () => judgeResult({}) });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work task: implement feature X", systemPrompt: [] });
		await approvePlan(controller);
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: {} });
		await controller.submitDecision(validDecisionInput());
		const saved = harness.appended.filter(a => a.customType === "jev.state");
		expect(saved.length).toBeGreaterThan(0);
		// simulate restart: new controller, same session entries
		const harness2 = makeFakePi();
		const controller2 = createJevController({ judge: async () => judgeResult({}) });
		controller2.register(harness2.pi);
		controller2.onSessionStart(saved.map(a => ({ customType: a.customType, data: a.data as JevState })));
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
		const controller = createJevController({ judge: async () => judgeResult({}) });
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
		expect(stopResult(await runStop(harness))?.decision).toBeUndefined();
	});

	const COURSE_OPTIONS = [
		{ id: "continue", label: "Continue", meaning: "keep going" },
		{ id: "return_to_requirement", label: "Return", meaning: "re-read requirement" },
		{ id: "replan", label: "Replan", meaning: "new plan" },
		{ id: "ask_user", label: "Ask", meaning: "escalate" },
		{ id: "verify_before_proceeding", label: "Verify", meaning: "run checks first" },
	];

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

	test("course_check: end-to-end verdict mapping (record/redirect/escalate, counter burn)", async () => {
		const harness = makeFakePi();
		let next: DecisionResult = judgeResult({ selectedOption: "continue" });
		const controller = createJevController({ judge: async () => next });
		controller.register(harness.pi);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "requirement work", systemPrompt: [] });

		// fixed option set enforced when no template override
		const bad = await controller.submitDecision(courseInput({ options: OPTIONS }));
		expect(bad.verdict).toBe("insufficient_evidence");
		expect(bad.judged).toBe(false);

		// continue: recorded, approves nothing
		const cont = await controller.submitDecision(courseInput());
		expect(cont.verdict).toBe("approve");
		expect(controller.getState().lastCourseCheck?.selectedOption).toBe("continue");
		expect(controller.getState().approvals.some(a => a.stage === "course_check")).toBe(false);

		// return_to_requirement: revise + same-session feedback + counter burn
		next = judgeResult({ selectedOption: "return_to_requirement" });
		const redirect = await controller.submitDecision(courseInput());
		expect(redirect.verdict).toBe("revise");
		expect(redirect.reasons.join(" ")).toContain("return_to_requirement");
		expect(harness.sentMessages.length).toBeGreaterThan(0);

		// verify_before_proceeding recorded
		next = judgeResult({ selectedOption: "verify_before_proceeding" });
		await controller.submitDecision(courseInput());
		expect(controller.getState().lastCourseCheck?.selectedOption).toBe("verify_before_proceeding");

		// ask_user (judge choice) escalates with recorded blocker
		next = judgeResult({ selectedOption: "ask_user" });
		const esc = await controller.submitDecision(courseInput());
		expect(esc.verdict).toBe("ask_user");
		expect(controller.getState().blockers.join(" ")).toContain("course_check");

		// The 4th call (ask_user) exhausts the bounded-rework bound (3): escalated without
		// a further judge call, blocker names the stage, never fake success.
		expect(Object.values(controller.getState().iterations).reduce((a, b) => a + b, 0)).toBe(3);
	});

	test("course_check: judge error fail-closed; client-enforced low confidence arrives as verify_before_proceeding", async () => {
		const controller = createJevController({
			judge: async (req: DecisionRequest) => {
				if (req.task === "transport down") throw new Error("endpoint down");
				// Post-client normalization: floor already enforced, confidence stripped.
				return judgeResult({ selectedOption: "verify_before_proceeding", reasons: ["low_confidence"] });
			},
		});
		const errOutcome = await controller.submitDecision(courseInput({ task: "transport down" }));
		expect(errOutcome.verdict).toBe("insufficient_evidence");
		expect(errOutcome.judged).toBe(false);
		expect(controller.getState().lastCourseCheck).toBeUndefined();

		const low = await controller.submitDecision(courseInput());
		expect(low.verdict).toBe("approve");
		expect(controller.getState().lastCourseCheck?.selectedOption).toBe("verify_before_proceeding");
		// recorded, but grants no approval
		expect(controller.getState().approvals.length).toBe(0);
	});

	test("C1 wired course_check: per-requirement drift via injected courseCheckJudge", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async () => {
				throw new Error("standard judge must not be consulted for wired course_check");
			},
			courseCheckJudge: async req => {
				expect(req.requirements.length).toBe(2);
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
					evidence("user", "REQ-1 user quote: login must persist"),
					evidence("spec", "REQ-2 spec quote: export to csv"),
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
			courseCheckJudge: async () => ({
				onTrack: { REQ1: true },
				nextAction: "continue",
				reasons: [],
				judged: true,
			}),
		});
		const outcome = await controller.submitDecision(
			courseInput({ evidence: [evidence("user", "REQ-1 user quote: login must persist"), evidence("execution", "tests pass")] }),
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
				return { onTrack: { REQ: true, "REQ#2": true }, nextAction: "continue", reasons: [], judged: true };
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
});
