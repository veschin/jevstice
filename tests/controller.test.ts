import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createJevController } from "../src/controller.js";
import type { Judge, JudgeQuestion } from "../src/judge.js";
import { POLICY, type JevConfig } from "../src/types.js";
import {
	answeringJudge,
	blockReason,
	fakeArtifacts,
	fakeCtx,
	fakePi,
	fakeZod,
	stopDecision,
	stopEvent,
	switchableCtx,
	toolCallEvent,
	toolDetails,
	toolFailed,
	toolResultEvent,
	toolText,
	until,
	type FakeAnswer,
	type FakeAnswerSource,
	type FakePi,
	type SwitchableHost,
} from "./helpers.js";

interface Options {
	interval?: number;
	mode?: "interval" | "completion";
	mutation?: boolean;
	completion?: boolean;
}

function config(options: Options = {}): JevConfig {
	return {
		gates: { mutation: options.mutation ?? true, completion: options.completion ?? true },
		courseCheck: {
			// The shipped default defers the course question to completion; these tests exercise the
			// interval check itself, so they ask for interval mode explicitly.
			mode: options.mode ?? "interval",
			interval: options.interval ?? DEFAULT_CONFIG.courseCheck.interval,
		},
		antiSlop: { mode: "advisory" },
		problems: [],
	};
}

/** A registered controller over a fake host, with the judge answers the test provides. */
function controllerFor(table: Record<string, FakeAnswerSource>, options: Options = {}) {
	const fake = answeringJudge(table);
	const pi = fakePi();
	createJevController({ judge: fake.judge, config: config(options), zod: fakeZod() }).register(pi.api);
	return { pi, calls: fake.calls };
}

const TRIAGE_DEEP: FakeAnswer = { probability: 0.95 };
/** Answers that pass requirement coverage and each plan topic (FR-24, FR-34). */
const PLAN_APPROVED: Record<string, FakeAnswer> = {
	coverage: { probability: 0.93 },
	item_1: { probability: 0.93 },
	outline_requirement_1: { probability: 0.93 },
	outline_step_1: { probability: 0.93 },
	detail: { label: "ready", confidence: 0.9 },
	finalize_consistency: { probability: 0.93 },
	finalize_scope: { probability: 0.93 },
	topic_1: { probability: 0.9 },
	// The pre-execution action check (FR-31): the admitted payload serves the approved plan.
	action: { label: "on_course", confidence: 0.9 },
};
const ON_COURSE: FakeAnswer = { label: "on_course", confidence: 0.9 };
const FOLLOWS: FakeAnswer = { label: "follows", confidence: 0.94 };

/** The approving option of an acceptance question, whichever aspect it asks about. */
const APPROVING_ACCEPTANCE: Record<string, string> = {
	business: "serves_business_need",
	architecture: "sound_for_next_change",
};

function approvingAcceptance(question: JudgeQuestion): FakeAnswer {
	if (question.mode === "noul") return { probability: 0.9 };
	return {
		label: Object.values(APPROVING_ACCEPTANCE).find(candidate => question.options?.[candidate] !== undefined),
		confidence: 0.92,
	};
}

const PLAN_ARTIFACT = "local://x-plan.md";
const PLAN_EVIDENCE = [{ kind: "user", quote: "report the coverage of the last run" }];
const PLAN_BODY = "# plan\n\n1. Collect the numbers\n";

async function triaged(pi: FakePi, ctx: unknown, request = "Report the coverage of the last run"): Promise<void> {
	await pi.callTool("jev_triage", { request }, ctx);
}

/** The obligation list is derived from the owner's request; no owner confirmation is read. */
async function requirementsReviewed(pi: FakePi, ctx: unknown, request = "Report the coverage of the last run"): Promise<void> {
	const outcome = await pi.callTool(
		"jev_requirements",
		{
			request,
			items: [{ text: request, source: request }],
			candidateNeeds: [],
			evidence: PLAN_EVIDENCE,
		},
		ctx,
	);
	expect(toolFailed(outcome)).toBe(false);
}
async function planReviewed(
	pi: FakePi,
	ctx: unknown,
	plan = PLAN_ARTIFACT,
	requirement = "Report the coverage of the last run",
	section = PLAN_BODY.trimEnd(),
): Promise<void> {
	const outline = await pi.callTool(
		"jev_plan_review",
		{
			phase: "outline",
			steps: [{ id: "collect", summary: "Collect the numbers.", requirement }],
			evidence: PLAN_EVIDENCE,
		},
		ctx,
	);
	if (toolFailed(outline)) throw new Error(toolText(outline));
	const detail = await pi.callTool(
		"jev_plan_review",
		{
			phase: "detail",
			plan,
			topic: { id: "collect", section, paths: ["src/a.ts"], requirement },
			evidence: PLAN_EVIDENCE,
		},
		ctx,
	);
	if (toolFailed(detail)) throw new Error(toolText(detail));
	const finalized = await pi.callTool("jev_plan_review", { phase: "finalize", plan, evidence: PLAN_EVIDENCE }, ctx);
	if (toolFailed(finalized)) throw new Error(toolText(finalized));
}

async function planned(pi: FakePi, ctx: unknown, request = "Report the coverage of the last run"): Promise<void> {
	await requirementsReviewed(pi, ctx, request);
	await planReviewed(pi, ctx, PLAN_ARTIFACT, request);
}

async function accepted(pi: FakePi, ctx: unknown): Promise<void> {
	await pi.callTool("jev_acceptance", { aspect: "business", claim: "c", evidence: [{ kind: "execution", quote: "12 pass" }, { kind: "code", quote: "no diagnostics" }] }, ctx);
	await pi.callTool("jev_acceptance", { aspect: "architecture", claim: "c", evidence: [{ kind: "execution", quote: "bun test: 132 pass" }, { kind: "code", quote: "class Report" }] }, ctx);
}

describe("T1 - the registered surface", () => {
	test("T1, T2, T3, T5: the judge tools are registered and nothing is consulted at registration", () => {
		const { pi, calls } = controllerFor({});

		expect(pi.commands.has("jev-continue")).toBe(true);
		expect(pi.commands.has("jev-waive")).toBe(true);
		expect([...pi.tools.keys()].sort()).toEqual([
			"jev_acceptance",
			"jev_anti_slop",
			"jev_consult",
			"jev_plan_review",
			"jev_reaim",
			"jev_requirements",
			"jev_review",
			"jev_search_relevance",
			"jev_text_review",
			"jev_triage",
		]);
		expect(calls).toHaveLength(0);
		expect(pi.messages).toHaveLength(0);
	});
});

describe("Jev prompt guidance", () => {

	test("the guidance describes an autonomous obligation list and no owner confirmation", () => {
		const { pi } = controllerFor({});
		const triage = pi.tools.get("jev_triage")?.description ?? "";
		const requirements = pi.tools.get("jev_requirements")?.description ?? "";

		expect(triage).toContain("No owner confirmation step exists");
		expect(requirements).toContain("one checkable item per obligation you derived from it");
		expect(requirements).not.toContain("After the owner confirms");
	});
});

describe("T2 - a read-only question costs nothing (FR-10, constraint on S2/S13/S14)", () => {
	test("a plain web search and a read are neither gated nor consulted", async () => {
		const { pi, calls } = controllerFor({});
		const ctx = fakeCtx();

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("web_search", { query: "release date" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("read", { path: "src/a.ts" }), ctx))).toBeUndefined();
		await pi.emit("tool_result", toolResultEvent("web_search", { query: "release date" }, "results"), ctx);
		await pi.emit("tool_result", toolResultEvent("read", { path: "src/a.ts" }, "contents"), ctx);

		expect(calls).toHaveLength(0);
		expect(pi.messages).toHaveLength(0);
	});

	test("T5: a read-only session settles without any acceptance call", async () => {
		const { pi, calls } = controllerFor({});
		const ctx = fakeCtx();

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});

describe("T3 - the plan-mode boundary (FR-07, FR-18)", () => {
	test("FR-18: a development task holds working-tree changes until the plan artifact is reviewed, then allows the proposal", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "coverage-report-plan.md": "# Coverage report\n\n1. Collect the numbers\n" }) });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });

		// Before any triage nothing passes: an untriaged session holds its first consequential change.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "x" }), ctx))).toContain("jev_triage");

		expect(toolFailed(await pi.callTool("jev_triage", { request: "Report the coverage of the last run" }, ctx))).toBe(false);
		await requirementsReviewed(pi, ctx);

		// A registered development task holds consequential changes.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "x" }), ctx))).toContain("jev_plan_review");

		// The plan artifact, the judge routes and agent messages pass the gate.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "local://coverage-report-plan.md", content: "# plan" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "agent://helper", content: "status?" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("jev_consult", {}), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://jev_consult", content: "{}" }), ctx))).toBeUndefined();

		await planReviewed(pi, ctx, "local://coverage-report-plan.md", undefined, "# Coverage report\n\n1. Collect the numbers");

		// The approved plan opens the working tree and the proposal of that artifact.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "x" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "coverage-report" }), ctx))).toBeUndefined();
	});

	test("FR-34: requirements pass from the owner's request alone, with no owner reply loop", async () => {
		const ctx = fakeCtx();
		const { pi, calls } = controllerFor({
			needs_development: TRIAGE_DEEP,
			coverage: { probability: 0.93 },
			item_1: { probability: 0.93 },
		});
		await triaged(pi, ctx);

		const submission = {
			request: "Report the coverage of the last run",
			items: [{ text: "report the coverage of the last run", source: "Report the coverage of the last run" }],
			candidateNeeds: [],
			evidence: PLAN_EVIDENCE,
		};
		// No prompt was recorded after triage, and none is required.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("jev_requirements", submission), ctx))).toBeUndefined();
		expect(toolFailed(await pi.callTool("jev_requirements", submission, ctx))).toBe(false);
		expect(calls).toHaveLength(2);
		const quotes = (calls[1]?.state as Record<string, unknown>)["quotes"];
		expect(quotes).toContain("[user] Report the coverage of the last run");
	});

	test("FR-34: a development plan waits for requirements to pass Jev", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "coverage-report-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			coverage: { probability: 0.93 },
			item_1: { probability: 0.93 },
			...PLAN_APPROVED,
		});
		await triaged(pi, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "local://plan.md", content: PLAN_BODY }), ctx))).toEqual(
			expect.stringContaining("jev_requirements"),
		);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("jev_plan_review", {}), ctx))).toEqual(expect.stringContaining("jev_requirements"));

		await requirementsReviewed(pi, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: PLAN_ARTIFACT, content: PLAN_BODY }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://jev_plan_review", content: "{}" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("jev_plan_review", {}), ctx))).toBeUndefined();
	});

	test("FR-34: a rejected obligation keeps the plan boundary closed", async () => {
		const ctx = fakeCtx();
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			coverage: { probability: 0.93 },
			item_1: { probability: 0.1 },
		});
		await triaged(pi, ctx);

		const outcome = await pi.callTool(
			"jev_requirements",
			{
				request: "Report the coverage of the last run",
				items: [{ text: "report the coverage of the last run", source: "Report the coverage of the last run" }],
				evidence: PLAN_EVIDENCE,
			},
			ctx,
		);

		expect(toolFailed(outcome)).toBe(false);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: PLAN_ARTIFACT, content: PLAN_BODY }), ctx))).toEqual(
			expect.stringContaining("jev_requirements"),
		);
	});

	test("FR-07: proposing a plan that was never reviewed is blocked", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({}) });
		const { pi } = controllerFor({});

		const held = await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "coverage-report" }), ctx);

		expect(blockReason(held)).toContain("jev_plan_review");
		expect(blockReason(held)).toContain("local://coverage-report-plan.md");
	});

	test("FR-07: changing the plan artifact invalidates the approval", async () => {
		const artifactsDir = await fakeArtifacts({ "coverage-report-plan.md": "# Coverage report\n\n1. Collect the numbers\n" });
		const ctx = fakeCtx({ artifactsDir });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });

		await triaged(pi, ctx);
		await requirementsReviewed(pi, ctx);
		await planReviewed(pi, ctx, "local://coverage-report-plan.md", undefined, "# Coverage report\n\n1. Collect the numbers");
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "coverage-report" }), ctx))).toBeUndefined();

		await writeFile(join(artifactsDir, "local", "coverage-report-plan.md"), "# A different plan\n", "utf8");

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "coverage-report" }), ctx))).toContain("changed after the plan review");
	});

	test("FR-07: a plan artifact rewritten after the review no longer authorises a project change", async () => {
		const artifactsDir = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
		const ctx = fakeCtx({ artifactsDir });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
		await triaged(pi, ctx);
		await planned(pi, ctx);

		await writeFile(join(artifactsDir, "local", "x-plan.md"), "# replaced\n", "utf8");

		const held = await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx);

		expect(blockReason(held)).toContain("changed after the plan review");
		expect(blockReason(held)).toContain("jev_plan_review");
	});

	test("FR-31: eval, delegation, an editing LSP action and an unknown MCP route are held before the plan and free after it", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });

		await pi.emit("before_agent_start", { prompt: "Build the report" }, ctx);
		await triaged(pi, ctx, "Build the report");

		for (const [tool, input] of [
			["eval", { language: "py", code: "1" }],
			["task", { context: "c", tasks: [{ task: "read only", solutionSpace: "one fix" }] }],
			["lsp", { action: "rename", file: "src/a.ts", new_name: "y" }],
			["mcp__google_sheets_update_cells", { spreadsheetId: "s", range: "A1", values: [] }],
			["multi_tool_use.parallel", { tool_uses: [{ recipient_name: "write", parameters: { path: "src/a.ts" } }] }],
		] as const) {
			const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
			await pi.emit("before_agent_start", { prompt: "Build the report" }, ctx);
			await triaged(pi, ctx, "Build the report");
			expect({ tool, reason: blockReason(await pi.emit("tool_call", toolCallEvent(tool, input), ctx)) }).toEqual({
				tool,
				reason: expect.stringContaining("jev_plan_review"),
			});
		}
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("lsp", { action: "diagnostics", file: "src/a.ts" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("mcp__google_sheets_get_sheet_data", { spreadsheetId: "s" }), ctx))).toBeUndefined();

		await planned(pi, ctx, "Build the report");

		for (const [tool, input] of [
			["eval", { language: "py", code: "1" }],
			["task", { context: "c", tasks: [{ task: "read only", solutionSpace: "one fix" }] }],
			["lsp", { action: "rename", file: "src/a.ts", new_name: "y" }],
			["mcp__google_sheets_update_cells", { spreadsheetId: "s", range: "A1", values: [] }],
		] as const) {
			expect({ tool, reason: blockReason(await pi.emit("tool_call", toolCallEvent(tool, input), ctx)) }).toEqual({ tool, reason: undefined });
		}
	});
});

describe("FR-31 - the admitted payload is judged before it runs", () => {
	test("an off-course payload is blocked unexecuted and the whole payload reaches the judge", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, action: { label: "off_course", confidence: 0.9 } });
		await triaged(pi, ctx);
		await planned(pi, ctx);

		const payload = `const hidden = "${"B".repeat(POLICY.maxActionExcerptChars + 200)}";`;
		const reason = blockReason(await pi.emit("tool_call", toolCallEvent("eval", { language: "js", code: payload }), ctx));

		expect(reason).toBeDefined();
		expect(reason).toContain("not executed");
		const judged = calls.filter(call => call.questions.some(question => question.name === "action")).at(-1);
		// The payload past the evidence cap is part of what the judge read, not truncated away.
		expect(JSON.stringify(judged?.state)).toContain("B".repeat(POLICY.maxActionExcerptChars + 100));
	});

	test("a judge that returns no action answer leaves the call unexecuted", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const table: Record<string, FakeAnswerSource> = { needs_development: TRIAGE_DEEP, ...PLAN_APPROVED };
		delete table["action"];
		const { pi } = controllerFor(table);
		await triaged(pi, ctx);
		await planned(pi, ctx);

		const reason = blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx));

		expect(reason).toContain("not executed");
	});

	test("an approved plan whose artifact is rewritten during the judgment stops the execution", async () => {
		const artifactsDir = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
		const ctx = fakeCtx({ artifactsDir });
		const fake = answeringJudge({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
		const judge: Judge = async (state, questions) => {
			if (questions.some(question => question.name === "action")) {
				await writeFile(join(artifactsDir, "local", "x-plan.md"), "# replaced mid-judgment\n", "utf8");
			}
			return fake.judge(state, questions);
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		await triaged(pi, ctx);
		await planned(pi, ctx);

		const reason = blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx));

		expect(reason).toContain("changed after the plan review");
		expect(reason).toContain("jev_plan_review");
	});
});

describe("T4 - implementation course checks (FR-11, FR-12, FR-13)", () => {
	test("FR-11: with an interval of two, one check runs after the second successful action and carries its result", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor(
			{ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:1": ON_COURSE, "direction:2": ON_COURSE },
			{ interval: 2 },
		);
		await triaged(pi, ctx);
		await planned(pi, ctx);
		const before = calls.length;

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 10 bytes to src/a.ts"), ctx);
		expect(calls.length).toBe(before);

		await pi.emit("tool_result", toolResultEvent("edit", { path: "src/a.ts" }, "applied 2 hunks"), ctx);
		expect(await until(() => calls.length > before)).toBe(true);

		const check = calls[calls.length - 1];
		expect(JSON.stringify(check?.state)).toContain("applied 2 hunks");
		expect(await until(() => pi.messages.some(message => message.customType === "jev.course_check"))).toBe(true);
	});

	test("FR-11: failed and read-only calls do not advance the interval", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:1": ON_COURSE }, { interval: 2 });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		const before = calls.length;

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "EACCES: permission denied", true), ctx);
		await pi.emit("tool_result", toolResultEvent("read", { path: "src/a.ts" }, "contents"), ctx);
		await pi.emit("tool_result", toolResultEvent("web_search", { query: "x" }, "results"), ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "agent://helper" }, "message delivered"), ctx);

		expect(calls.length).toBe(before);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		expect(calls.length).toBe(before);
	});

	test("FR-18, FR-11: a successful mutating shell command advances the revision and triggers a course check", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:1": ON_COURSE }, { interval: 1 });
		await triaged(pi, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("bash", { command: "rm -rf build" }), ctx))).toContain("jev_plan_review");

		await planned(pi, ctx);
		const before = calls.length;
		await pi.emit("tool_result", toolResultEvent("bash", { command: "rm -rf build" }, "removed build"), ctx);
		expect(await until(() => calls.length > before)).toBe(true);
		expect(JSON.stringify(calls[calls.length - 1]?.state)).toContain("rm -rf build");
		expect(JSON.stringify(calls[calls.length - 1]?.state)).toContain("removed build");
	});

	test("FR-11: no interval check runs without an approved plan", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP }, { interval: 1 });
		await triaged(pi, ctx);
		const before = calls.length;

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);

		expect(calls.length).toBe(before);
		// No marker is pending: the next change waits for the plan, not for a course check.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toContain("jev_plan_review");
		expect(pi.messages.some(message => message.customType === "jev.course_check")).toBe(false);
	});

	test("FR-29: an owner interjection clears the old approvals and the re-aimed task needs a fresh plan", async () => {
		const ctx = fakeCtx();
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, reaim: { probability: 0.9 } });
		await triaged(pi, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_plan_review");

		await pi.emit("before_agent_start", { prompt: "новой волной: закрой F-40" }, ctx);
		const outcome = await pi.callTool("jev_reaim", { interjection: "новой волной: закрой F-40", evidence: [{ kind: "user", quote: "новой волной: закрой F-40" }] }, ctx);
		expect(toolFailed(outcome)).toBe(false);

		// Re-aiming approves nothing: the new course waits for its own requirements and plan review.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_plan_review");
	});

	test("FR-29: an owner message during an approved task holds changes until a judged re-aim", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, reaim: { probability: 0.9 } });
		await pi.emit("before_agent_start", { prompt: "добавь отчёт по покрытию" }, ctx);
		await triaged(pi, ctx, "добавь отчёт по покрытию");
		await planned(pi, ctx, "добавь отчёт по покрытию");

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();

		await pi.emit("before_agent_start", { prompt: "теперь закрой F-40" }, ctx);
		const held = await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx);

		expect(blockReason(held)).toContain("jev_reaim");
		expect(blockReason(held)).toContain("direction");

		await pi.callTool("jev_reaim", { interjection: "теперь закрой F-40", evidence: [{ kind: "user", quote: "теперь закрой F-40" }] }, ctx);

		// The re-aim approves no plan: the re-aimed task waits for its own requirements and plan review.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_plan_review");
	});

	test("FR-18: a consequential shell command invalidates completed acceptance", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			...PLAN_APPROVED,
			"direction:1": ON_COURSE,
			follows_requirements: FOLLOWS,
			acceptance: approvingAcceptance,
		});
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		await accepted(pi, ctx);

		await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test" }, "141 pass"), ctx);

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toContain("acceptance has not passed");
	});

	test("FR-31: a failed consequential call may have touched the tree, so it invalidates acceptance", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			...PLAN_APPROVED,
			acceptance: approvingAcceptance,
			follows_requirements: FOLLOWS,
		});
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		await accepted(pi, ctx);

		// The command changed a file before failing: its non-zero exit is no reason to trust acceptance.
		await pi.emit("tool_result", toolResultEvent("bash", { command: "touch marker; false" }, "exit code 1", true), ctx);

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toContain("acceptance has not passed");
	});

	test("FR-10, FR-11: a session that registered no task accrues no actions, no hold and no call", async () => {
		const ctx = fakeCtx();
		const { pi, calls } = controllerFor({ "direction:1": { label: "off_course", confidence: 0.9 } }, { interval: 1 });

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		await pi.emit("tool_result", toolResultEvent("bash", { command: "rm -rf build" }, ""), ctx);

		expect(calls).toHaveLength(0);
		expect(pi.messages).toHaveLength(0);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toContain("jev_triage");
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("bash", { command: "rm -rf build" }), ctx))).toContain("jev_triage");
	});

	test("FR-13, FR-11: an off-course verdict holds the changes until the executor consults", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor(
			{
				needs_development: TRIAGE_DEEP,
				...PLAN_APPROVED,
				"direction:1": { label: "off_course", confidence: 0.9 },
				consult: { label: "fix", confidence: 0.91 },
				resolves_hold: { probability: 0.93 },
			},
			{ interval: 1 },
		);
		await triaged(pi, ctx);
		await planned(pi, ctx);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/other.ts" }, "Successfully wrote 3 bytes"), ctx);
		expect(await until(() => calls.some(call => call.questions[0]?.name === "direction:1"))).toBe(true);
		expect(await until(() => pi.messages.some(message => message.customType === "jev.course_check" && message.content.includes("off_course")))).toBe(true);

		const held = await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx);
		expect(blockReason(held)).toContain("off_course");

		await pi.callTool(
			"jev_consult",
			{
				mode: "choice",
				question: "Which direction should the work take?",
				context: "the last action left the registered task",
				alternatives: [
					{ label: "fix", meaning: "return to the registered task" },
					{ label: "keep", meaning: "continue as it is" },
				],
			},
			ctx,
		);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();
	});

	test("FR-23, FR-11: a spent hold permits work and spends no further check", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor(
			{
				needs_development: TRIAGE_DEEP,
				...PLAN_APPROVED,
				"direction:1": { label: "off_course", confidence: 0.9 },
				consult: { probability: 0.4 },
				resolves_hold: { probability: 0.5 },
			},
			{ interval: 1 },
		);
		await triaged(pi, ctx);
		await planned(pi, ctx);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		expect(await until(() => calls.some(call => call.questions.some(question => question.name === "direction:1")))).toBe(true);

		for (let attempt = 1; attempt <= POLICY.maxRefusalsPerStage; attempt += 1) {
			await pi.callTool(
				"jev_consult",
				{
					mode: "boolean",
					question: `clear the direction hold, attempt ${attempt}`,
					context: "the course check finding",
					evidence: [{ kind: "user", quote: "report the coverage of the last run" }],
					trueMeaning: "continue",
					falseMeaning: "stay held",
				},
				ctx,
			);
		}
		// The finding survives, but the attempt limit permits continuation of this request.

		const before = calls.length;
		const verdict = await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx);
		expect(blockReason(verdict)).toBeUndefined();

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 more bytes"), ctx);
		expect(calls.length).toBe(before);
	});

	test("FR-11: the judge material carries the change itself, bounded by the policy cap", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:1": ON_COURSE }, { interval: 1 });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		const long = "A".repeat(POLICY.maxActionExcerptChars + 500);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts", content: long }, "Successfully wrote many bytes"), ctx);
		expect(await until(() => calls.some(call => call.questions.some(question => question.name === "direction:1")))).toBe(true);

		const state = JSON.stringify(calls[calls.length - 1]?.state);
		expect(state).toContain("Successfully wrote many bytes");
		expect(state).toContain("A".repeat(POLICY.maxActionExcerptChars - 100));
		expect(state).not.toContain("A".repeat(POLICY.maxActionExcerptChars));
	});

	test("FR-12: completion-only mode makes no check before completion and one at completion", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor(
			{
				needs_development: TRIAGE_DEEP,
				...PLAN_APPROVED,
				"direction:1": ON_COURSE,
				follows_requirements: FOLLOWS,
				acceptance: approvingAcceptance,
			},
			{ mode: "completion", interval: 1 },
		);
		await triaged(pi, ctx);
		await planned(pi, ctx);
		const before = calls.length;

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		expect(calls.length).toBe(before);

		await pi.callTool("jev_acceptance", { aspect: "business", claim: "c", evidence: [{ kind: "execution", quote: "12 pass" }, { kind: "code", quote: "no diagnostics" }] }, ctx);

		// The acceptance check is an activity of its own: the aspect question and one per plan topic,
		// and the completion check runs once, at the stop.
		expect(calls[calls.length - 1]?.questions.map(question => question.name)).toEqual(["acceptance", "topic_1"]);
	});
});

describe("T5 - acceptance and completion (FR-14, FR-15, FR-17)", () => {
	test("FR-14, FR-17: developed work cannot settle while an acceptance aspect is missing", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);

		const reason = stopDecision(await pi.emit("session_stop", stopEvent(), ctx));

		expect(reason).toContain("business");
		expect(reason).toContain("architecture");
	});

	test("FR-17: a completion check that finds a deviation keeps the session from settling and is not re-asked", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({
			needs_development: TRIAGE_DEEP,
			...PLAN_APPROVED,
			follows_requirements: { label: "deviates", confidence: 0.9 },
			acceptance: approvingAcceptance,
		});
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		await accepted(pi, ctx);

		const reason = stopDecision(await pi.emit("session_stop", stopEvent(), ctx));
		expect(reason).toContain("deviates");

		const before = calls.length;
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toContain("deviates");
		expect(calls.length).toBe(before);
	});

	test("FR-14, FR-17: with both aspects approved and the completion check passing the session settles, and a new change re-opens the gate", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			...PLAN_APPROVED,
			follows_requirements: FOLLOWS,
			acceptance: approvingAcceptance,
		});
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		await accepted(pi, ctx);

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();

		await pi.emit("tool_result", toolResultEvent("edit", { path: "src/a.ts" }, "applied 1 hunk"), ctx);

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toContain("acceptance");
	});

	test("FR-14: repeated stop refusals permit stopping with the acceptance OPEN", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		const before = calls.length;

		for (let attempt = 0; attempt < POLICY.maxStopBlocks; attempt += 1) {
			expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeDefined();
		}
		// Past the bound the refusal remains OPEN, without claiming acceptance.
		const exhausted = stopDecision(await pi.emit("session_stop", stopEvent(), ctx));
		expect(exhausted).toBeUndefined();
		expect(pi.messages.some(message => message.customType === "jev.open_item")).toBe(true);
		expect(calls.length).toBe(before);
	});

	test("a disabled completion gate lets the session settle", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED }, { mutation: false, completion: false });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
	});
});

/**
 * Triage and plan in one session, approve the proposal, then let the host clear the session (a new
 * id and a new artifact root) and copy the artifacts over only after the switch - the order
 * `#approvePlan` uses for the default approve-and-execute path.
 */
async function approvedAcrossSwitch(
	options: { reason?: "new" | "resume"; copied?: string } = {},
): Promise<{ pi: FakePi; session: SwitchableHost }> {
	const oldRoot = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
	const newRoot = await fakeArtifacts({});
	const session = switchableCtx({ artifactsDir: oldRoot, sessionId: "session-old" });
	const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, direction: ON_COURSE });
	await triaged(pi, session.ctx);
	await planned(pi, session.ctx);
	expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "x" }), session.ctx))).toBeUndefined();

	session.switchTo({ artifactsDir: newRoot, sessionId: "session-new" });
	const reason = options.reason ?? "new";
	await pi.emit("session_before_switch", { type: "session_before_switch", reason }, session.ctx);
	await pi.emit("session_switch", { type: "session_switch", reason, previousSessionFile: "session.jsonl" }, session.ctx);
	const copied = options.copied ?? PLAN_BODY;
	if (copied.length > 0) await writeFile(join(newRoot, "local", "x-plan.md"), copied, "utf8");
	return { pi, session };
}

describe("T3 - the plan approval across the host session switch (FR-07, FR-18)", () => {
	test("FR-07: the approved plan and its requirements are restored in the new execution session", async () => {
		const { pi, session } = await approvedAcrossSwitch();

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), session.ctx))).toBeUndefined();
		// The carried requirements keep the plan artifact writable instead of reopening that gate.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "local://x-plan.md", content: PLAN_BODY }), session.ctx))).toBeUndefined();
	});

	test("FR-18: an artifact whose bytes differ from the approved ones restores nothing", async () => {
		const { pi, session } = await approvedAcrossSwitch({ copied: "# a different plan\n" });

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), session.ctx))).toContain("jev_triage");
		// The handoff is spent: no later operation revives it.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), session.ctx))).toContain("jev_triage");
	});

	test("FR-18: a switch that is not the approved execution never inherits the development approval", async () => {
		const { pi, session } = await approvedAcrossSwitch({ reason: "resume" });

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), session.ctx))).toContain("jev_triage");
	});

	test("FR-18: an ordinary clear of a planned session restores nothing", async () => {
		const oldRoot = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
		const newRoot = await fakeArtifacts({});
		const session = switchableCtx({ artifactsDir: oldRoot, sessionId: "session-old" });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
		await triaged(pi, session.ctx);
		await planned(pi, session.ctx);

		session.switchTo({ artifactsDir: newRoot, sessionId: "session-new" });
		await pi.emit("session_before_switch", { type: "session_before_switch", reason: "new" }, session.ctx);
		await pi.emit("session_switch", { type: "session_switch", reason: "new", previousSessionFile: "session.jsonl" }, session.ctx);
		await writeFile(join(newRoot, "local", "x-plan.md"), PLAN_BODY, "utf8");

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), session.ctx))).toContain("jev_triage");
	});
});

describe("T2, T3 - the first consequential change waits for triage (FR-02, FR-10, FR-18)", () => {
	test("FR-32: a development request is triaged before project inspection or requirement review", async () => {
		const ctx = fakeCtx();
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP });

		await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "Build the report", systemPrompt: [] }, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("read", { path: "skill://ready-first" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("read", { path: "src/index.ts" }), ctx))).toEqual(expect.stringContaining("jev_triage"));
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("bash", { command: "ls" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("jev_requirements", {}), ctx))).toEqual(expect.stringContaining("jev_triage"));

		await triaged(pi, ctx, "Build the report");
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("read", { path: "src/index.ts" }), ctx))).toBeUndefined();
	});

	test("FR-02, FR-10: a confirmed simple task admits a judged change, and a new prompt does not inherit it", async () => {
		const ctx = fakeCtx();
		const { pi, calls } = controllerFor({ needs_development: { probability: 0.04 }, action: ON_COURSE });

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_triage");
		// The judge routes and the read-only tools stay free while the gate is shut.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://jev_consult", content: "{}" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "local://x-plan.md", content: "# plan" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("read", { path: "src/a.ts" }), ctx))).toBeUndefined();

		expect(toolFailed(await pi.callTool("jev_triage", { request: "Search the web for the release date" }, ctx))).toBe(false);
		expect(calls).toHaveLength(1);
		// The simple verdict is no blanket pass: the exact change is judged before it runs.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();
		expect(calls).toHaveLength(2);

		await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "Now rewrite the parser", systemPrompt: [] }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toContain("jev_triage");
	});

	test("FR-02: a confirmed simple task proposes its plan without a plan review", async () => {
		const ctx = fakeCtx();
		const { pi, calls } = controllerFor({ needs_development: { probability: 0.04 } });

		expect(toolFailed(await pi.callTool("jev_triage", { request: "Write the release note" }, ctx))).toBe(false);
		expect(calls).toHaveLength(1);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "release note" }), ctx))).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	test("FR-02: a development triage replaces a simple verdict with the plan requirement", async () => {
		const ctx = fakeCtx();
		const judge: Judge = async (state, questions) => {
			const deep = (state as Record<string, unknown>)["request"] === "Build the report";
			return {
				ok: true,
				model: "fake",
				answers: questions.map(question =>
					question.mode === "choice"
						? { name: question.name, mode: "choice" as const, label: "on_course", confidence: 0.95 }
						: { name: question.name, mode: "noul" as const, probability: deep ? 0.95 : 0.04, confidence: deep ? 0.95 : 0.04 },
				),
			};
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		await pi.callTool("jev_triage", { request: "Search the web" }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();

		await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "Build the report", systemPrompt: [] }, ctx);
		await pi.callTool("jev_triage", { request: "Build the report" }, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_plan_review");
	});
});

describe("T4 - the interval check holds changes while it is in flight (FR-11)", () => {
	test("FR-11: a consequential change is blocked until the course check returns", async () => {
		let entered = false;
		const { promise: pending, resolve: release } = Promise.withResolvers<void>();
		const fake = answeringJudge({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:1": ON_COURSE });
		const judge: Judge = async (state, questions) => {
			if (questions.some(question => question.name === "direction:1")) {
				entered = true;
				await pending;
			}
			return fake.judge(state, questions);
		};
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const pi = fakePi();
		createJevController({ judge, config: config({ interval: 1 }), zod: fakeZod() }).register(pi.api);
		await triaged(pi, ctx);
		await planned(pi, ctx);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		expect(await until(() => entered)).toBe(true);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toContain("course check");
		// A stop also waits for the check in flight instead of settling work it has not seen.
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toContain("course check");

		release();
		expect(await until(() => pi.messages.some(message => message.customType === "jev.course_check"))).toBe(true);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toBeUndefined();
	});

	test("FR-11: two judged calls of one session are serialised, never raced", async () => {
		let inFlight = 0;
		let peak = 0;
		let entered = false;
		const { promise: firstRun, resolve: startFirst } = Promise.withResolvers<void>();
		const fake = answeringJudge({ consult: { label: "keep", confidence: 0.92 } });
		const judge: Judge = async (state, questions) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			try {
				if (!entered) {
					entered = true;
					await firstRun;
				}
				return await fake.judge(state, questions);
			} finally {
				inFlight -= 1;
			}
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx();
		const consult = (question: string) => ({
			mode: "choice" as const,
			question,
			context: "the design is stable",
			evidence: [{ kind: "code", quote: "one call site" }],
			alternatives: [
				{ label: "keep", meaning: "keep the design" },
				{ label: "replace", meaning: "replace it" },
			],
		});

		const first = pi.callTool("jev_consult", consult("Keep one?"), ctx);
		// The second call arrives while the first holds the session lock: it must queue, not race.
		const second = pi.callTool("jev_consult", consult("Keep two?"), ctx);
		startFirst();
		await Promise.all([first, second]);

		expect(fake.calls).toHaveLength(2);
		expect(peak).toBe(1);
	});
});

describe("FR-25 - the course check runs on a deviation or on the configured count", () => {
	const run = async (target: string) => {
		const artifacts = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
		const ctx = {
			ui: { notify: () => {} },
			sessionManager: { getArtifactsDir: () => artifacts, getSessionId: () => `session-${target}` },
		};
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:1": ON_COURSE }, { interval: 3 });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		const before = calls.length;
		await pi.emit("tool_result", toolResultEvent("write", { path: target }, "Successfully wrote 4 bytes"), ctx);
		await until(() => calls.length > before);
		return calls.slice(before).map(call => call.questions.map(question => question.name));
	};

	test("FR-25: a change outside the plan's paths is checked, one inside them is not", async () => {
		expect(await run("src/a.ts")).toEqual([]);
		expect(await run("docs/notes.md")).toEqual([["direction:1"]]);
	});
});

describe("FR-21, FR-28 - the extension tells the owner what the executor cannot report", () => {
	test("FR-21: exhausted transport attempts permit continuation and a new task is judged again", async () => {
		let mode: "down" | "deep" = "down";
		const judge: Judge = async (_state, questions) => {
			if (mode === "down") {
				return {
					ok: false,
					kind: "unavailable",
					problem: "the judge call failed (transport, authentication or service error)",
				};
			}
			return {
				ok: true,
				model: "fake",
				answers: questions.map(question => ({ name: question.name, mode: "noul" as const, probability: 0.95, confidence: 0.95 })),
			};
		};
		const notices: string[] = [];
		const ctx = {
			ui: { notify: (message: string) => notices.push(message) },
			sessionManager: { getArtifactsDir: () => null, getSessionId: () => "session-1" },
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);

		for (let call = 0; call < POLICY.maxJudgeFailures; call += 1) {
			expect(toolFailed(await pi.callTool("jev_triage", { request: "Report the coverage of the last run" }, ctx))).toBe(true);
		}

		// The availability budget permits continuation, but no task or approval was manufactured.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("could not be reached");

		// A usable answer restores the boundaries: the task is registered and the gate holds again.
		mode = "deep";
		await pi.callTool("jev_triage", { request: "Report the coverage of the last run" }, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_plan_review");
	});

	test("FR-28: one standing boundary delivers its instruction once and tells the owner when the executor keeps trying", async () => {
		const artifacts = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
		const notices: string[] = [];
		const ctx = {
			ui: { notify: (message: string) => notices.push(message) },
			sessionManager: { getArtifactsDir: () => artifacts, getSessionId: () => "session-1" },
		};
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
		await triaged(pi, ctx);
		const before = pi.messages.length;

		for (let call = 0; call < POLICY.maxIgnoredBoundaryCalls; call += 1) {
			const reason = blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: `src/a${call}.ts`, content: "x" }), ctx));
			expect(reason).toContain("Next call: write local://<slug>-plan.md");
		}

		const delivered = pi.messages.slice(before).filter(message => message.customType === "jev.boundary");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.deliverAs).toBe("aside");
		expect(notices).toHaveLength(1);
	});
});

describe("FR-30 - the request screen decides what is judged", () => {
	test("a request that only inspects or publishes costs no judge call, and a verification run costs one authorization", async () => {
		const { pi, calls } = controllerFor({ action: ON_COURSE });
		const ctx = fakeCtx();

		await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "закоммить и запушь текущее состояние" }, ctx);

		for (const command of ["git status", "git add -A", "git commit -m x", "git push"]) {
			expect(blockReason(await pi.emit("tool_call", toolCallEvent("bash", { command }), ctx))).toBeUndefined();
			await pi.emit("tool_result", toolResultEvent("bash", { command }, "ok"), ctx);
		}
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("read", { path: "src/a.ts" }), ctx))).toBeUndefined();
		expect(calls).toHaveLength(0);

		// `bun test` runs arbitrary code: it is admitted by one judged authorization, not by the screen.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("bash", { command: "bun test" }), ctx))).toBeUndefined();
		await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test" }, "ok"), ctx);
		expect(calls).toHaveLength(1);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("edit", { paths: ["src/a.ts", "src/b.ts"] }), ctx))).toBeUndefined();
		expect(calls).toHaveLength(2);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "Some plan" }), ctx))).toBeUndefined();
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		expect(pi.messages).toHaveLength(0);
	});

	test("a request that changes the project waits for triage, while its commits do not", async () => {
		const { pi, calls } = controllerFor({ needs_development: { probability: 0.04 }, action: ON_COURSE });
		const ctx = fakeCtx();

		await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "добавь отчёт по покрытию" }, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("bash", { command: "git add -A && git commit -m x" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "x" }), ctx))).toContain("jev_triage");
		expect(calls).toHaveLength(0);

		await triaged(pi, ctx, "добавь отчёт по покрытию");

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "x" }), ctx))).toBeUndefined();
	});

	test("once a task entered the workflow, a later quiet request does not tear it down", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
		await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "добавь отчёт по покрытию" }, ctx);
		await triaged(pi, ctx, "добавь отчёт по покрытию");

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_plan_review");

		await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "закоммить и запушь" }, ctx);

		// A routine follow-up keeps the task and its gate: nothing here opens a registered task's walls.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_plan_review");
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "coverage" }), ctx))).toContain("jev_plan_review");
	});

	test("a finished task is dropped for the next request, an unfinished one is not", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			...PLAN_APPROVED,
			follows_requirements: FOLLOWS,
			acceptance: approvingAcceptance,
		});
		await pi.emit("before_agent_start", { prompt: "добавь отчёт по покрытию" }, ctx);
		await triaged(pi, ctx, "добавь отчёт по покрытию");
		await planned(pi, ctx, "добавь отчёт по покрытию");
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		await accepted(pi, ctx);
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();

		// The completed task no longer holds the next prompt: it is triaged on its own.
		await pi.emit("before_agent_start", { prompt: "Now rewrite the parser" }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toContain("jev_triage");
	});

	test("the registered tools answer outside the workflow too, and a finding holds work until it is consulted", async () => {
		const { pi } = controllerFor({
			consult: { label: "keep", confidence: 0.92 },
			review: { label: "defect", confidence: 0.92 },
		});
		const ctx = fakeCtx();

		const consulted = await pi.callTool(
			"jev_consult",
			{
				mode: "choice",
				question: "Keep the current design?",
				context: "the design is stable and the change is small",
				evidence: [{ kind: "code", quote: "one call site" }],
				alternatives: [
					{ label: "keep", meaning: "keep the design as it is" },
					{ label: "replace", meaning: "replace it" },
				],
			},
			ctx,
		);
		expect(toolFailed(consulted)).toBe(false);
		expect(toolText(consulted)).toContain("keep");

		const reviewed = await pi.callTool(
			"jev_review",
			{ kind: "commit", target: "HEAD", claim: "it adds the guard", evidence: [{ kind: "code", quote: "+ if (!ready) return;" }] },
			ctx,
		);
		expect(toolText(reviewed)).toContain("defect");
		expect(toolText(reviewed)).toContain("held until you consult");

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("defect");
	});

	test("a commit and a push stay free while a real change waits for triage", async () => {
		const { pi } = controllerFor({});
		const ctx = fakeCtx();
		const published = await pi.emit("tool_call", toolCallEvent("bash", { command: "git commit -m x && git push origin master" }), ctx);
		const changed = await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx);

		expect(blockReason(published)).toBeUndefined();
		expect(blockReason(changed)).toContain("triaged");
	});

	test("a session that only inspects and publishes spends no judge call at all", async () => {
		const { pi, calls } = controllerFor({});
		const ctx = fakeCtx();

		for (const command of ["git status", "git diff HEAD", "git add -A", "git commit -m x", "git push"]) {
			expect(blockReason(await pi.emit("tool_call", toolCallEvent("bash", { command }), ctx))).toBeUndefined();
			await pi.emit("tool_result", toolResultEvent("bash", { command }, "ok"), ctx);
		}

		expect(blockReason(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});

describe("owner-authorized continuation", () => {
	test("a bounded file gate permits work and completion without manufacturing acceptance", async () => {
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP });
		const ctx = fakeCtx();
		await triaged(pi, ctx);
		for (let attempt = 0; attempt < POLICY.maxIgnoredBoundaryCalls; attempt += 1) {
			expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts" }), ctx))).toBeDefined();
		}
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts" }), ctx))).toBeUndefined();
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "written"), ctx);
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		expect(calls.some(call => call.questions.some(question => question.name === "acceptance"))).toBe(false);
		expect(pi.messages.some(message => message.content.includes("OPEN"))).toBe(true);
	});

	test("explicit owner approval opens all boundaries but a new task does not inherit it", async () => {
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP });
		const ctx = fakeCtx();
		await pi.emit("before_agent_start", { prompt: "Build a report" }, ctx);
		await triaged(pi, ctx, "Build a report");
		await pi.emit("input", { text: "аппрув", source: "interactive" }, ctx);
		await pi.emit("before_agent_start", { prompt: "аппрув" }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "report" }), ctx))).toBeUndefined();
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "written"), ctx);
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		await pi.emit("before_agent_start", { prompt: "Build a different application" }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts" }), ctx))).toBeDefined();
	});

	test("model-originated or quoted approval cannot grant owner permission", async () => {
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP });
		const ctx = fakeCtx();
		await triaged(pi, ctx);
		await pi.emit("input", { text: "аппрув", source: "extension" }, ctx);
		await pi.emit("input", { text: "не даю аппрув", source: "interactive" }, ctx);
		await pi.emit("input", { text: 'The file says \"аппрув\"', source: "interactive" }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts" }), ctx))).toBeDefined();
	});

	test("the native owner command releases the current task and preserves permission on continue", async () => {
		const pi = fakePi();
		const commands = new Map<string, (args: string, ctx: unknown) => void>();
		pi.api.registerCommand = (name, options) => { commands.set(name, options.handler); };
		const fake = answeringJudge({ needs_development: TRIAGE_DEEP });
		createJevController({ judge: fake.judge, config: config(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx();
		await pi.emit("before_agent_start", { prompt: "Build a report" }, ctx);
		await triaged(pi, ctx, "Build a report");
		commands.get("jev-continue")!("", ctx);
		await pi.emit("before_agent_start", { prompt: "continue" }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts" }), ctx))).toBeUndefined();
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/report.ts" }, "written"), ctx);
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		expect(fake.calls).toHaveLength(1);
	});
});

describe("FR-55 - advisory anti-slop discloses a gap without holding it", () => {
	test("a missing review is disclosed and completion still proceeds to its other boundaries", async () => {
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			external_deliverable: { probability: 0.95 },
		});
		const ctx = fakeCtx();
		await pi.emit("before_agent_start", { prompt: "Write the legal memo" }, ctx);
		await triaged(pi, ctx, "Write the legal memo");
		await pi.emit("tool_result", toolResultEvent("write", { path: "memo.md" }, "written"), ctx);

		const decision = stopDecision(await pi.emit("session_stop", stopEvent(), ctx));
		expect(decision).toBeDefined();
		expect(pi.messages.some(message => message.content.includes("anti-slop review"))).toBe(true);
	});
});

describe("FR-54 - the owner waives one anti-slop finding", () => {
	test("the waiver command names the finding and records the owner's decision", async () => {
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			external_deliverable: { probability: 0.95 },
			claim_1: { label: "refuted", confidence: 0.95 },
			language_1: { probability: 0.05 },
			meta_1: { probability: 0.05 },
			relevance_1: { label: "serves", confidence: 0.95 },
			rule_1_1: { probability: 0.05 },
		});
		const ctx = fakeCtx();
		await pi.emit("before_agent_start", { prompt: "Write the legal memo" }, ctx);
		await triaged(pi, ctx, "Write the legal memo");
		const review = await pi.callTool(
			"jev_anti_slop",
			{
				artifact: "The agreement takes effect on 1 January 2027.",
				language: "en",
				register: "formal legal English",
				purpose: "legal memo",
				audience: "external",
				rules: [{ class: "register", rule: "Use formal legal English." }],
				claims: [
					{
						id: "claim-1",
						text: "The agreement takes effect on 1 January 2027.",
						kind: "fact",
						evidence: [
							{
								kind: "documentation",
								quote: "Commencement: 1 January 2027.",
								source: "contract",
								sourceClass: "official",
							},
						],
					},
				],
				inferences: [],
			},
			ctx,
		);
		const finding = (toolDetails(review)["findings"] as Array<Record<string, unknown>>).find(
			entry => entry["severity"] === "blocker",
		);
		const findingId = String(finding?.["id"]);

		pi.callCommand("jev-waive", `${findingId} owner accepted`, ctx);

		expect(
			pi.messages.some(
				message => message.content.includes("waived") && message.content.includes(findingId),
			),
		).toBe(true);

		await pi.emit("input", { text: `одобряю ${findingId}`, source: "interactive" }, ctx);
		await pi.emit("before_agent_start", { prompt: `одобряю ${findingId}` }, ctx);
		const reason = blockReason(
			await pi.emit("tool_call", toolCallEvent("write", { path: "memo.md" }), ctx),
		);
		expect(reason ?? "").not.toContain("owner sent a message");
	});
});
