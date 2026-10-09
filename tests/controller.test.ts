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
	toolFailed,
	toolResultEvent,
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
			mode: options.mode ?? DEFAULT_CONFIG.courseCheck.mode,
			interval: options.interval ?? DEFAULT_CONFIG.courseCheck.interval,
		},
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
/** The answers a passing per-topic plan review needs: one coverage answer and one per topic (FR-24). */
const PLAN_APPROVED: Record<string, FakeAnswer> = { coverage: { probability: 0.93 }, topic_1: { probability: 0.9 } };
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
const PLAN_TOPICS = [
	{
		id: "collect",
		section: "1. Collect the numbers",
		paths: ["src/a.ts"],
		requirement: "report the coverage of the last run",
	},
];

async function triaged(pi: FakePi, ctx: unknown, request = "Report the coverage of the last run"): Promise<void> {
	await pi.callTool("jev_triage", { request }, ctx);
}

async function planned(pi: FakePi, ctx: unknown): Promise<void> {
	await pi.callTool("jev_plan_review", { plan: PLAN_ARTIFACT, claim: "the plan delivers the report", topics: PLAN_TOPICS, evidence: PLAN_EVIDENCE }, ctx);
}

describe("T1 - the registered surface", () => {
	test("T1, T2, T3, T5: the judge tools are registered and nothing is consulted at registration", () => {
		const { pi, calls } = controllerFor({});

		expect([...pi.tools.keys()].sort()).toEqual([
			"jev_acceptance",
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

		// A registered development task holds consequential changes.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "x" }), ctx))).toContain("jev_plan_review");

		// The plan artifact, the judge routes and agent messages pass the gate.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "local://coverage-report-plan.md", content: "# plan" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "agent://helper", content: "status?" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("jev_consult", {}), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://jev_consult", content: "{}" }), ctx))).toBeUndefined();

		expect(toolFailed(await pi.callTool("jev_plan_review", { plan: "local://coverage-report-plan.md", claim: "the plan delivers the report", topics: PLAN_TOPICS, evidence: PLAN_EVIDENCE }, ctx))).toBe(false);

		// The approved plan opens the working tree and the proposal of that artifact.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "x" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "coverage-report" }), ctx))).toBeUndefined();
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
		await pi.callTool("jev_plan_review", { plan: "local://coverage-report-plan.md", claim: "the plan delivers the report", topics: PLAN_TOPICS, evidence: PLAN_EVIDENCE }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "coverage-report" }), ctx))).toBeUndefined();

		await writeFile(join(artifactsDir, "local", "coverage-report-plan.md"), "# A different plan\n", "utf8");

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://propose", content: "coverage-report" }), ctx))).toContain("changed after the plan review");
	});
});

describe("T4 - implementation course checks (FR-11, FR-12, FR-13)", () => {
	test("FR-11: with an interval of two, one check runs after the second successful action and carries its result", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:collect": ON_COURSE }, { interval: 2 });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		const before = calls.length;

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 10 bytes to src/a.ts"), ctx);
		expect(calls.length).toBe(before);

		await pi.emit("tool_result", toolResultEvent("edit", { path: "src/a.ts" }, "applied 2 hunks"), ctx);
		expect(await until(() => calls.length > before)).toBe(true);

		const check = calls[calls.length - 1];
		expect(check?.questions.map(question => question.name)).toEqual(["direction:collect"]);
		expect(JSON.stringify(check?.state)).toContain("applied 2 hunks");
		expect(await until(() => pi.messages.some(message => message.customType === "jev.course_check"))).toBe(true);
	});

	test("FR-11: failed and read-only calls do not advance the interval", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:collect": ON_COURSE }, { interval: 2 });
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

	test("FR-18, FR-11: a shell command is held like any other change but records evidence without advancing the interval", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:collect": ON_COURSE }, { interval: 1 });
		await triaged(pi, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("bash", { command: "rm -rf build" }), ctx))).toContain("jev_plan_review");

		await planned(pi, ctx);
		const before = calls.length;
		await pi.emit("tool_result", toolResultEvent("bash", { command: "npm run build" }, "built in 2s"), ctx);
		expect(calls.length).toBe(before);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		expect(await until(() => calls.some(call => call.questions[0]?.name === "direction:collect"))).toBe(true);
		expect(JSON.stringify(calls[calls.length - 1]?.state)).toContain("npm run build");
		expect(JSON.stringify(calls[calls.length - 1]?.state)).toContain("built in 2s");
	});


	test("FR-29: an owner interjection re-aims the task and the walls stay down", async () => {
		const ctx = fakeCtx();
		const { pi } = controllerFor({ needs_development: TRIAGE_DEEP, reaim: { probability: 0.9 } });
		await triaged(pi, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_plan_review");

		await pi.callTool("jev_reaim", { interjection: "новой волной: закрой F-40", evidence: [{ kind: "user", quote: "новой волной: закрой F-40" }] }, ctx);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();
	});

	test("FR-18: a verification run keeps a recorded acceptance valid", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi } = controllerFor({
			needs_development: TRIAGE_DEEP,
			...PLAN_APPROVED,
			"direction:collect": ON_COURSE,
			follows_requirements: FOLLOWS,
			acceptance: approvingAcceptance,
		});
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		await pi.callTool("jev_acceptance", { aspect: "business", claim: "c", evidence: [{ kind: "execution", quote: "12 pass" }, { kind: "code", quote: "no diagnostics" }] }, ctx);
		await pi.callTool("jev_acceptance", { aspect: "architecture", claim: "c", evidence: [{ kind: "execution", quote: "bun test: 132 pass" }, { kind: "code", quote: "class Report" }] }, ctx);

		await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test" }, "141 pass"), ctx);

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
	});
	test("FR-10, FR-11: a session that registered no task accrues no actions, no hold and no call", async () => {
		const ctx = fakeCtx();
		const { pi, calls } = controllerFor({ "direction:collect": { label: "off_course", confidence: 0.9 } }, { interval: 1 });

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
				"direction:collect": { label: "off_course", confidence: 0.9 },
				consult: { label: "fix", confidence: 0.91 },
				resolves_hold: { probability: 0.93 },
			},
			{ interval: 1 },
		);
		await triaged(pi, ctx);
		await planned(pi, ctx);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/other.ts" }, "Successfully wrote 3 bytes"), ctx);
		expect(await until(() => calls.some(call => call.questions[0]?.name === "direction:collect"))).toBe(true);
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

	test("FR-23, FR-11: after the hold boundary released, no further interval course check fires", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor(
			{
				needs_development: TRIAGE_DEEP,
				...PLAN_APPROVED,
				"direction:collect": { label: "off_course", confidence: 0.9 },
				consult: { probability: 0.4 },
				resolves_hold: { probability: 0.5 },
			},
			{ interval: 1 },
		);
		await triaged(pi, ctx);
		await planned(pi, ctx);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		expect(await until(() => calls.some(call => call.questions.some(question => question.name === "direction:collect")))).toBe(true);

		for (let attempt = 1; attempt <= 3; attempt += 1) {
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
		// The third refusal released the hold boundary (FR-23): holds on it can no longer hold.

		const before = calls.length;
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 more bytes"), ctx);
		expect(calls.length).toBe(before);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();
	});

	test("FR-11: the judge material carries the change itself, bounded by the policy cap", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:collect": ON_COURSE }, { interval: 1 });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		const long = "A".repeat(POLICY.maxActionExcerptChars + 500);

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts", content: long }, "Successfully wrote many bytes"), ctx);
		expect(await until(() => calls.some(call => call.questions.some(question => question.name === "direction:collect")))).toBe(true);

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
				"direction:collect": ON_COURSE,
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
		await pi.callTool("jev_acceptance", { aspect: "business", claim: "c", evidence: [{ kind: "execution", quote: "12 pass" }, { kind: "code", quote: "no diagnostics" }] }, ctx);
		await pi.callTool("jev_acceptance", { aspect: "architecture", claim: "c", evidence: [{ kind: "execution", quote: "bun test: 132 pass" }, { kind: "code", quote: "class Report" }] }, ctx);

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
		await pi.callTool("jev_acceptance", { aspect: "business", claim: "c", evidence: [{ kind: "execution", quote: "12 pass" }, { kind: "code", quote: "no diagnostics" }] }, ctx);
		await pi.callTool("jev_acceptance", { aspect: "architecture", claim: "c", evidence: [{ kind: "execution", quote: "bun test: 132 pass" }, { kind: "code", quote: "class Report" }] }, ctx);

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();

		await pi.emit("tool_result", toolResultEvent("edit", { path: "src/a.ts" }, "applied 1 hunk"), ctx);

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toContain("acceptance");
	});

	test("FR-14: repeated refusals for one unchanged reason are bounded and recorded as an open item", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		const before = calls.length;

		for (let attempt = 0; attempt < POLICY.maxStopBlocks; attempt += 1) {
			expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeDefined();
		}
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();

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
	test("FR-07: the approved plan is restored in the new execution session, so the next change passes", async () => {
		const { pi, session } = await approvedAcrossSwitch();

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), session.ctx))).toBeUndefined();
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

describe("T2, T3 - the first consequential change waits for triage (FR-01, FR-02, FR-10, FR-18)", () => {
	test("FR-02, FR-10: a confirmed simple task proceeds, and a new prompt does not inherit it", async () => {
		const ctx = fakeCtx();
		const { pi, calls } = controllerFor({ needs_development: { probability: 0.04 } });

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toContain("jev_triage");
		// The judge routes and the read-only tools stay free while the gate is shut.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "xd://jev_consult", content: "{}" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "local://x-plan.md", content: "# plan" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("read", { path: "src/a.ts" }), ctx))).toBeUndefined();

		expect(toolFailed(await pi.callTool("jev_triage", { request: "Search the web for the release date" }, ctx))).toBe(false);
		expect(calls).toHaveLength(1);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();

		await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "Now rewrite the parser", systemPrompt: [] }, ctx);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toContain("jev_triage");
	});

	test("FR-01: a development triage replaces a simple verdict with the plan requirement", async () => {
		const ctx = fakeCtx();
		const judge: Judge = async (state, questions) => {
			const deep = (state as Record<string, unknown>)["request"] === "Build the report";
			return {
				ok: true,
				model: "fake",
				answers: [
					{
						name: questions[0]?.name ?? "needs_development",
						mode: "noul",
						probability: deep ? 0.95 : 0.04,
						confidence: deep ? 0.95 : 0.04,
					},
				],
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
		let release = (): void => {};
		const pending = new Promise<void>(resolve => {
			release = resolve;
		});
		const fake = answeringJudge({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:collect": ON_COURSE });
		const judge: Judge = async (state, questions) => {
			if (questions.some(question => question.name === "direction:collect")) {
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

		release();
		expect(await until(() => pi.messages.some(message => message.customType === "jev.course_check"))).toBe(true);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toBeUndefined();
	});
});

describe("FR-09 - the tools teach how to ask (FR-09)", () => {
	test("FR-09: every tool description carries the asking rule", () => {
		const pi = fakePi();
		createJevController({ judge: answeringJudge({}).judge, config: config(), zod: fakeZod() }).register(pi.api);
		for (const tool of pi.tools.values()) {
			expect(tool.description).toContain("one decision");
		}
	});

	test("FR-09: the consult description carries worked examples with measured scores", () => {
		const pi = fakePi();
		createJevController({ judge: answeringJudge({}).judge, config: config(), zod: fakeZod() }).register(pi.api);

		const description = pi.tools.get("jev_consult")?.description ?? "";
		expect(description).toContain("Example (good)");
		expect(description).toContain("Example (bad)");
		expect(description).toContain("not a no");
	});
});

describe("FR-25 - the course check runs on a deviation or on the configured count", () => {
	const run = async (target: string) => {
		const artifacts = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
		const ctx = {
			ui: { notify: () => {} },
			sessionManager: { getArtifactsDir: () => artifacts, getSessionId: () => `session-${target}` },
		};
		const { pi, calls } = controllerFor({ needs_development: TRIAGE_DEEP, ...PLAN_APPROVED, "direction:collect": ON_COURSE }, { interval: 3 });
		await triaged(pi, ctx);
		await planned(pi, ctx);
		const before = calls.length;
		await pi.emit("tool_result", toolResultEvent("write", { path: target }, "Successfully wrote 4 bytes"), ctx);
		await until(() => calls.length > before);
		return calls.slice(before).map(call => call.questions.map(question => question.name));
	};

	test("FR-25: a change outside the plan's paths is checked, one inside them is not", async () => {
		expect(await run("src/a.ts")).toEqual([]);
		expect(await run("docs/notes.md")).toEqual([["direction:collect"]]);
	});
});


describe("FR-21, FR-28 - the extension tells the owner what the executor cannot report", () => {
	test("FR-21: repeated judge failures pass the boundaries, tell the owner once, and a usable answer restores them", async () => {
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
		expect(notices[0]).toContain(`${POLICY.maxIgnoredBoundaryCalls} consequential calls were refused`);
		expect(notices[0]).toContain("src/a0.ts");
	});
});
