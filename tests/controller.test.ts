import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createContextArchive } from "../src/context.js";
import { createJevController } from "../src/controller.js";
import type { Judge } from "../src/judge.js";
import type { MessagePresentationRenderer } from "../src/presentation.js";
import { asRecord, type JevConfig } from "../src/types.js";
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
} from "./helpers.js";


function config(): JevConfig {
	return DEFAULT_CONFIG;
}

/** A registered controller over a fake host, with the judge answers the test provides. */
function controllerFor(table: Record<string, FakeAnswerSource>) {
	const fake = answeringJudge(table);
	const pi = fakePi();
	createJevController({ judge: fake.judge, config: config(), zod: fakeZod() }).register(pi.api);
	return { pi, calls: fake.calls };
}

const ORDINARY_TOOLS = [
	"jev_acceptance",
	"jev_anti_slop",
	"jev_consult",
	"jev_context",
	"jev_course_check",
	"jev_fact_check",
	"jev_plan_review",
	"jev_reaim",
	"jev_requirements",
	"jev_review",
	"jev_search_relevance",
	"jev_text_review",
	"jev_triage",
];

const NEEDS_DEVELOPMENT: FakeAnswer = { probability: 0.95 };
/** Judge answers for the unchanged planning activities, used to reach a registered plan. */
const PLAN_APPROVED: Record<string, FakeAnswer> = {
	coverage: { probability: 0.93 },
	item_1: { probability: 0.93 },
	outline_requirement_1: { probability: 0.93 },
	outline_step_1: { probability: 0.93 },
	detail: { label: "ready", confidence: 0.9 },
	finalize_consistency: { probability: 0.93 },
	finalize_scope: { probability: 0.93 },
	topic_1: { probability: 0.9 },
	action: { label: "on_course", confidence: 0.9 },
};
const PLAN_ARTIFACT = "local://x-plan.md";
const PLAN_EVIDENCE = [{ kind: "user", quote: "report the coverage of the last run" }];
const PLAN_BODY = "# plan\n\n1. Collect the numbers\n";

function consultParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		mode: "boolean",
		question: "Does the recorded report contain coverage?",
		context: "The recorded report contains coverage for the completed run.",
		trueMeaning: "The report contains coverage.",
		falseMeaning: "The report lacks coverage.",
		...extra,
	};
}

async function triaged(pi: FakePi, ctx: unknown, request = "Report the coverage of the last run"): Promise<void> {
	const outcome = await pi.callTool("jev_triage", { request }, ctx);
	if (toolFailed(outcome)) throw new Error(toolText(outcome));
}

async function planned(pi: FakePi, ctx: unknown, request = "Report the coverage of the last run"): Promise<void> {
	await triaged(pi, ctx, request);
	const requirements = await pi.callTool(
		"jev_requirements",
		{
			request,
			items: [{ text: request, source: request }],
			candidateNeeds: [],
			evidence: PLAN_EVIDENCE,
		},
		ctx,
	);
	if (toolFailed(requirements)) throw new Error(toolText(requirements));
	const outline = await pi.callTool(
		"jev_plan_review",
		{
			phase: "outline",
			steps: [{ id: "collect", summary: "Collect the numbers.", requirement: request }],
			evidence: PLAN_EVIDENCE,
		},
		ctx,
	);
	if (toolFailed(outline)) throw new Error(toolText(outline));
	const detail = await pi.callTool(
		"jev_plan_review",
		{
			phase: "detail",
			plan: PLAN_ARTIFACT,
			topic: { id: "collect", section: PLAN_BODY.trimEnd(), paths: ["src/a.ts"], requirement: request },
			evidence: PLAN_EVIDENCE,
		},
		ctx,
	);
	if (toolFailed(detail)) throw new Error(toolText(detail));
	const finalized = await pi.callTool("jev_plan_review", { phase: "finalize", plan: PLAN_ARTIFACT, evidence: PLAN_EVIDENCE }, ctx);
	if (toolFailed(finalized)) throw new Error(toolText(finalized));
}

function promptOf(results: readonly unknown[]): unknown[] {
	const prompt = asRecord(results[0])?.["systemPrompt"];
	if (!Array.isArray(prompt)) throw new Error("before_agent_start did not return an instruction bundle");
	return prompt;
}

function lastMessage(pi: FakePi, customType: string): string | undefined {
	return pi.messages.filter(message => message.customType === customType).at(-1)?.content;
}

describe("T1 - the registered ordinary surface", () => {
	test("all ordinary tools are registered with no judgement at registration", () => {
		const { pi, calls } = controllerFor({});

		expect([...pi.tools.keys()].sort()).toEqual(ORDINARY_TOOLS);
		expect(calls).toHaveLength(0);
		expect(pi.messages).toHaveLength(0);
	});

	test("the removed approval and waiver commands are not registered", () => {
		const { pi } = controllerFor({});

		expect(pi.commands.has("jev")).toBe(true);
		expect(pi.commands.has("jev-status")).toBe(true);
		expect(pi.commands.has("jev-continue")).toBe(false);
		expect(pi.commands.has("jev-waive")).toBe(false);
	});
});

describe("compact user presentation", () => {
	const renderedText = (component: { render(width: number): readonly string[] } | undefined): string =>
		component?.render(100).join("\n") ?? "";
	const setup = () => {
		const pi = fakePi();
		const renderers = new Map<string, MessagePresentationRenderer>();
		// The host injects Text; this seam exposes the exact text handed to it.
		pi.api.pi = { Text: function (text = "") {
			return { render: () => [text], invalidate: () => {} };
		} as unknown as NonNullable<typeof pi.api.pi>["Text"] };
		pi.api.registerMessageRenderer = (name, renderer) => { renderers.set(name, renderer); };
		createJevController({ judge: answeringJudge({}).judge, config: config(), zod: fakeZod() }).register(pi.api);
		return { pi, renderers };
	};

	test("every tool hides arguments and full diagnostics without changing model content", async () => {
		const { pi } = setup();
		const result = await pi.callTool("jev_context", { action: "list" }, fakeCtx());
		for (const tool of pi.tools.values()) {
			expect(tool.mergeCallAndResult).toBe(true);
			const call = renderedText(tool.renderCall?.({ artifact: "PRIVATE LONG INPUT" }, { expanded: false }));
			expect(call).not.toContain("PRIVATE");
			expect(call.length).toBeLessThan(80);
			const short = renderedText(tool.renderResult?.(result, { expanded: false }));
			expect(short).toContain("Complete");
			expect(short).not.toContain("Current objective:");
			expect(short.length).toBeLessThanOrEqual(100);
			expect(renderedText(tool.renderResult?.(result, { expanded: true }))).toBe(toolText(result));
		}
		expect(toolText(result)).toContain("Current objective:");
		expect(toolDetails(result)["diagnostics"]).toBeDefined();
	});

	test("collapsed results distinguish failures, uncertainty and checks that never ran", () => {
		const { pi } = setup();
		const render = pi.tools.get("jev_review")!.renderResult!;
		for (const [details, isError, label] of [
			[{ kind: "unavailable" }, false, "Unavailable"],
			[{ kind: "unclear" }, false, "Inconclusive"],
			[{ approved: false }, false, "Findings"],
			[{ prerequisite: true }, false, "Not checked"],
			[{ kind: "stale" }, false, "Outdated"],
			[{ kind: "invalid" }, true, "Invalid input"],
			[{ kind: "invalid", prerequisite: true }, true, "Not checked"],
			[{ enabled: false, skipped: true }, false, "Off"],
		] as const) {
			const result = { content: [{ type: "text", text: "FULL DIAGNOSTIC" }], details, isError };
			expect(renderedText(render(result, { expanded: false }))).toContain(label);
			expect(renderedText(render(result, { expanded: true }))).toBe("FULL DIAGNOSTIC");
			const longText = "FULL DIAGNOSTIC\n".repeat(400);
			expect(renderedText(render({ ...result, content: [{ type: "text", text: longText }] }, { expanded: true }))).toBe(longText);
		}
	});

	test("explicit status shows details without a compact card or provider message", async () => {
		const { pi, renderers } = setup();
		expect(renderers.has("jev.status")).toBe(false);
		const ctx = fakeCtx();
		pi.callCommand("jev-status", "", ctx);
		expect(pi.messages).toHaveLength(1);
		const status = pi.messages[0]!;
		expect(status).toMatchObject({ customType: "jev.status", display: true, triggerTurn: false });
		const content = status.content;
		expect(content).toContain("Session mode: on");
		expect(content).toContain("Work: 0 total");
		expect(content).toContain("Checks: 0 total");
		expect(content).toContain("Outcome: Not checked");
		expect(content).toContain("Passed action checks do not prove");
		const ownerMessage = { role: "custom", ...status };
		const userMessage = { role: "user", content: "Continue the work" };
		expect(await pi.emit("context", { messages: [ownerMessage, userMessage] }, ctx)).toEqual([{ messages: [userMessage] }]);
		pi.callCommand("jev", "off", fakeCtx());
		expect(lastMessage(pi, "jev.mode")).toContain("supervisor safety limits");
		const mode = pi.messages.filter(message => message.customType === "jev.mode").at(-1)!;
		expect(renderedText(renderers.get("jev.mode")!(mode, { expanded: false }))).toBe("Jev · Off");
	});
});

describe("T2 - read-only work spends no judgment", () => {
	test("a plain web search and a read are neither gated nor judged", async () => {
		const { pi, calls } = controllerFor({});
		const ctx = fakeCtx();

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("web_search", { query: "release date" }), ctx))).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("read", { path: "src/a.ts" }), ctx))).toBeUndefined();
		await pi.emit("tool_result", toolResultEvent("web_search", { query: "release date" }, "results"), ctx);
		await pi.emit("tool_result", toolResultEvent("read", { path: "src/a.ts" }, "contents"), ctx);

		expect(calls).toHaveLength(0);
	});

	test("a read-only session settles with no acceptance call", async () => {
		const { pi, calls } = controllerFor({});
		const ctx = fakeCtx();

		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});

describe("diagnostic-only boundary: tool_call holds no ordinary work", () => {
	test.each([
		["write", { path: "src/report.ts", content: "report" }],
		["edit", { path: "src/report.ts", oldText: "a", newText: "b" }],
		["bash", { command: "rm -rf build" }],
		["eval", { language: "py", code: "print(1)" }],
		["task", { context: "c", tasks: [{ task: "read only", solutionSpace: "one fix" }] }],
		["lsp", { action: "rename", file: "src/a.ts", new_name: "b" }],
		["mcp__google_sheets_update_cells", { spreadsheetId: "s", range: "A1", values: [] }],
	] as const)("an untriaged %s is admitted without a judge call", async (tool, input) => {
		const { pi, calls } = controllerFor({});
		const ctx = fakeCtx();

		expect(blockReason(await pi.emit("tool_call", toolCallEvent(tool, input), ctx))).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("an ordinary consequential call does not wait for a judge", async () => {
		const slow: Judge = () => new Promise<never>(() => {});
		const pi = fakePi();
		createJevController({ judge: slow, config: config(), zod: fakeZod() }).register(pi.api);

		let admission: unknown[] | undefined;
		void pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), fakeCtx()).then(result => {
			admission = result;
		});
		const checkpoint = Promise.withResolvers<void>();
		setImmediate(checkpoint.resolve);
		await checkpoint.promise;

		expect(admission).toBeDefined();
		if (admission !== undefined) expect(blockReason(admission)).toBeUndefined();
	});

	test("a late plan diagnostic stays historical after another write", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const normal = answeringJudge({ needs_development: NEEDS_DEVELOPMENT, ...PLAN_APPROVED });
		const outdated = answeringJudge({ action: { label: "off_course", confidence: 0.95 } });
		const pi = fakePi();
		const historical: unknown[] = [];
		pi.api.appendEntry = (name, data) => { if (name === "jev.historical-diagnostic") historical.push(data); };
		const delayed = { started: false };
		const judge: Judge = async (material, questions) => {
			if (questions[0]?.name !== "action" || delayed.started) {
				return normal.judge(material, questions);
			}
			delayed.started = true;
			entered.resolve();
			await release.promise;
			return outdated.judge(material, questions);
		};
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		await planned(pi, ctx);
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts", content: "first" }, "Wrote first revision"), ctx);
		await entered.promise;
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts", content: "second" }, "Wrote second revision"), ctx);
		release.resolve();
		expect(await until(() => historical.length > 0, 200)).toBe(true);
		const context = toolDetails(await pi.callTool("jev_context", { action: "list" }, ctx));
		expect(context["revision"]).toBe(2);
		expect(context["findings"]).toEqual([]);
	});

	test("an advisory finding never turns tool_call or session_stop into a refusal", async () => {
		// No consult answer: the judgment fails and leaves an advisory record.
		const { pi } = controllerFor({});
		const ctx = fakeCtx();
		const advisory = await pi.callTool("jev_consult", consultParams(), ctx);
		expect(toolDetails(advisory)["approved"]).not.toBe(true);

		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
	});

	test("a negative course check after an approved plan never holds the next project call or completion", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({
			needs_development: NEEDS_DEVELOPMENT,
			...PLAN_APPROVED,
			course: { label: "off_course", confidence: 0.9 },
		});
		await planned(pi, ctx);

		const checked = await pi.callTool(
			"jev_course_check",
			{
				claim: "The current work implements the approved collection step.",
				nextAction: "Write the coverage report.",
				evidence: [{ kind: "execution", quote: "collected 12 records" }],
			},
			ctx,
		);

		expect(toolDetails(checked)["approved"]).toBe(false);
		expect(calls.some(call => call.questions.some(question => question.name === "course"))).toBe(true);
		const finding = asRecord(toolDetails(checked)["hold"]);
		expect(typeof finding?.["id"]).toBe("string");
		expect(pi.commands.has("jev-continue")).toBe(false);

		// The plan already passed, so the failed check is diagnostic only: no override releases work.
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "report" }), ctx))).toBeUndefined();
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
	});
});

describe("startup guidance and authentic owner capture", () => {
	test("development startup preserves host policy and injects only the ordinary workflow", async () => {
		const { pi } = controllerFor({});
		const ctx = fakeCtx();

		const event = { reason: "prompt", prompt: "Implement a coverage dashboard", systemPrompt: ["Host policy"] };
		const prompt = promptOf(await pi.emit("before_agent_start", event, ctx));

		expect(prompt).toContain("Host policy");
		const joined = prompt.join("\n");
		expect(joined).toContain("jev_requirements");
		expect(joined).toContain('"aspect":"outcome"');
		expect(joined).not.toContain("jev_plan_review");
		expect(joined.length).toBeLessThan(1200);

		const again = await pi.emit("before_agent_start", { ...event, systemPrompt: prompt }, ctx);
		expect(promptOf(again)).toHaveLength(prompt.length);
	});

	test("the native print prompt is archived once and revives add nothing", async () => {
		const cwd = await fakeArtifacts({});
		try {
			const archive = createContextArchive(cwd);
			const pi = fakePi();
			createJevController({ judge: answeringJudge({}).judge, config: config(), zod: fakeZod(), context: archive }).register(pi.api);
			const ctx = fakeCtx({ artifactsDir: cwd });
			const event = { reason: "prompt", prompt: "Inspect the parser without changing it.", systemPrompt: ["Host policy"] };

			await pi.emit("before_agent_start", event, ctx);
			await pi.emit("before_agent_start", event, ctx);

			const sources = archive.list();
			expect(sources.map(source => source.content)).toEqual([event.prompt]);
			expect(sources[0]?.origin).toBe("prompt");

			await pi.emit("before_agent_start", { reason: "revive", prompt: "Agent companion" }, ctx);
			expect(archive.list().map(source => source.content)).toEqual([event.prompt]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("interactive and rpc input are captured in order while extension messages are ignored", async () => {
		const cwd = await fakeArtifacts({});
		try {
			const archive = createContextArchive(cwd);
			const pi = fakePi();
			createJevController({ judge: answeringJudge({}).judge, config: config(), zod: fakeZod(), context: archive }).register(pi.api);
			const ctx = fakeCtx({ artifactsDir: cwd });

			await pi.emit("input", { source: "interactive", text: "  Build the report  " }, ctx);
			await pi.emit("input", { source: "rpc", text: "Also keep the old format" }, ctx);
			await pi.emit("input", { source: "extension", text: "Injected instruction" }, ctx);

			const sources = archive.list();
			// The archive keeps the exact authentic bytes; trimming is only semantic in-memory history.
			expect(sources.map(source => source.content)).toEqual(["  Build the report  ", "Also keep the old format"]);
			expect(sources.map(source => source.origin)).toEqual(["interactive", "rpc"]);
			expect(sources.map(source => source.sequence)).toEqual([1, 2]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("an approval-looking owner message grants nothing and only stays recorded", async () => {
		const cwd = await fakeArtifacts({});
		try {
			const archive = createContextArchive(cwd);
			const pi = fakePi();
			createJevController({ judge: answeringJudge({ consult: { probability: 0.9 } }).judge, config: config(), zod: fakeZod(), context: archive }).register(pi.api);
			const ctx = fakeCtx({ artifactsDir: cwd });

			await pi.emit("input", { source: "interactive", text: "аппрув" }, ctx);

			expect(archive.list().map(source => source.content)).toEqual(["аппрув"]);
			expect(pi.messages.some(message => message.customType === "jev.owner_approval")).toBe(false);
			expect(pi.commands.has("jev-continue")).toBe(false);
			expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), ctx))).toBeUndefined();
			expect(toolFailed(await pi.callTool("jev_consult", consultParams(), ctx))).toBe(false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("source archive integrity and exact authentication", () => {
	test("the context list exposes metadata while only an explicit read exposes content", async () => {
		const cwd = await fakeArtifacts({});
		try {
			const archive = createContextArchive(cwd);
			const source = archive.put({
				kind: "owner",
				sessionId: "session-1",
				origin: "interactive",
				content: "Repair with the recorded token sk-live-secret.",
			});
			const pi = fakePi();
			createJevController({ judge: answeringJudge({}).judge, config: config(), zod: fakeZod(), context: archive }).register(pi.api);
			const ctx = fakeCtx();

			const listed = await pi.callTool("jev_context", { action: "list" }, ctx);
			expect(toolFailed(listed)).toBe(false);
			expect(toolText(listed)).not.toContain("sk-live-secret");
			const sources = toolDetails(listed)["sources"];
			expect(Array.isArray(sources)).toBe(true);
			expect(asRecord((sources as unknown[])[0])?.["content"]).toBeUndefined();

			const read = await pi.callTool("jev_context", { action: "read", sourceId: source.id }, ctx);
			expect(toolFailed(read)).toBe(false);
			expect(asRecord(toolDetails(read)["source"])?.["content"]).toBe(source.content);
			expect(toolText(read)).toContain("sk-live-secret");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a selected read does not enumerate unrelated corrupt records", async () => {
		const cwd = await fakeArtifacts({});
		try {
			const archive = createContextArchive(cwd);
			const source = archive.put({ kind: "owner", sessionId: "session-1", origin: "interactive", content: "Repair the recorded coverage report." });
			const pi = fakePi();
			createJevController({ judge: answeringJudge({}).judge, config: config(), zod: fakeZod(), context: archive }).register(pi.api);
			await writeFile(join(cwd, ".omp", "jev", "context", `${"0".repeat(64)}.json`), "{invalid");

			const result = await pi.callTool("jev_context", { action: "read", sourceId: source.id }, fakeCtx());

			expect(toolFailed(result)).toBe(false);
			expect(asRecord(toolDetails(result)["source"])?.["content"]).toBe(source.content);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a valid source-bound judgment survives an unrelated corrupt archive entry with a disclosed provenance gap", async () => {
		const cwd = await fakeArtifacts({});
		try {
			const archive = createContextArchive(cwd);
			const owner = archive.put({ kind: "owner", sessionId: "session-1", origin: "interactive", content: "Repair the recorded coverage report." });
			await writeFile(join(cwd, ".omp", "jev", "context", `${"0".repeat(64)}.json`), "{invalid");
			const fake = answeringJudge({ consult: { probability: 0.9 } });
			const pi = fakePi();
			createJevController({ judge: fake.judge, config: config(), zod: fakeZod(), context: archive }).register(pi.api);
			const result = await pi.callTool("jev_consult", consultParams({
				evidence: [{ kind: "user", sourceId: owner.id, quote: owner.content }],
			}), fakeCtx());
			expect(toolFailed(result)).toBe(false);
			expect(fake.calls).toHaveLength(1);
			expect(toolDetails(result)["contextProblems"]).toEqual([expect.stringContaining("archive")]);
			const selected = asRecord(asRecord(fake.calls[0]?.state)?.["trustedContext"])?.["selectedSources"];
			expect(selected).toEqual([expect.objectContaining({ id: owner.id, content: owner.content })]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("an exact quote and a non-owner source are validated before any judge call", async () => {
		const cwd = await fakeArtifacts({});
		try {
			const archive = createContextArchive(cwd);
			const owner = archive.put({
				kind: "owner",
				sessionId: "session-1",
				origin: "interactive",
				content: "Repair the recorded coverage report.",
			});
			const plan = archive.put({
				kind: "plan",
				sessionId: "session-1",
				origin: "judge_approved",
				content: "The coverage report records the completed run.",
			});
			const { pi, calls } = (() => {
				const fake = answeringJudge({ consult: { probability: 0.9 } });
				const host = fakePi();
				createJevController({ judge: fake.judge, config: config(), zod: fakeZod(), context: archive }).register(host.api);
				return { pi: host, calls: fake.calls };
			})();
			const ctx = fakeCtx();

			const absent = await pi.callTool(
				"jev_consult",
				consultParams({ evidence: [{ kind: "user", sourceId: owner.id, quote: "not in the recorded message" }] }),
				ctx,
			);
			expect(toolFailed(absent)).toBe(true);
			expect(toolText(absent)).toContain("absent from archived source");
			expect(calls).toHaveLength(0);

			const notOwner = await pi.callTool(
				"jev_consult",
				consultParams({ evidence: [{ kind: "user", sourceId: plan.id, quote: "The coverage report records the completed run." }] }),
				ctx,
			);
			expect(toolFailed(notOwner)).toBe(true);
			expect(toolText(notOwner)).toContain("not an authentic owner message");
			expect(calls).toHaveLength(0);

			const accepted = await pi.callTool(
				"jev_consult",
				consultParams({ evidence: [{ kind: "user", sourceId: owner.id, quote: "Repair the recorded coverage report." }] }),
				ctx,
			);
			expect(toolFailed(accepted)).toBe(false);
			expect(calls).toHaveLength(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("context inspection stays available while an explicit judgment is in flight", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const judge: Judge = async (state, questions) => {
			started.resolve();
			await release.promise;
			return answeringJudge({ consult: { probability: 0.9 } }).judge(state, questions);
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx();
		const judgment = pi.callTool("jev_consult", consultParams(), ctx);
		await started.promise;

		let inspected = false;
		const inspection = pi.callTool("jev_context", { action: "list" }, ctx).then(result => {
			inspected = !toolFailed(result);
		});
		try {
			expect(await until(() => inspected, 100)).toBe(true);
		} finally {
			release.resolve();
			await Promise.all([judgment, inspection]);
		}
	});
});

describe("owner-controlled session mode", () => {
	test("off skips checks and judgments but never holds work", async () => {
		const { pi, calls } = controllerFor({ needs_development: NEEDS_DEVELOPMENT });
		const ctx = { ...asRecord(fakeCtx()), isIdle: () => false };
		const injected = await pi.emit("before_agent_start", { prompt: "Implement the report", systemPrompt: ["Host policy"] }, ctx);
		expect(promptOf(injected)).toHaveLength(2);

		pi.callCommand("jev", "off", ctx);

		const skipped = await pi.callTool("jev_triage", { request: "Implement another report" }, ctx);
		expect(toolDetails(skipped)["enabled"]).toBe(false);
		expect(toolDetails(skipped)["skipped"]).toBe(true);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "report" }), ctx))).toBeUndefined();
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
		expect(calls).toHaveLength(0);

		const announcement = pi.messages.find(message => message.customType === "jev.mode")!;
		expect(announcement.deliverAs).toBe("nextTurn");
		expect(await pi.emit("context", { messages: [{ ...announcement, role: "custom" }] }, ctx)).toEqual([{
			messages: [expect.objectContaining({ customType: "jev.mode-advisory", display: false, content: expect.stringContaining("checks off") })],
		}]);
		const offPrompt = await pi.emit("before_agent_start", { reason: "prompt", prompt: "Urgent work", systemPrompt: ["Host policy"] }, ctx);
		expect(promptOf(offPrompt)).toEqual(["Host policy"]);
	});

	test("mode is isolated per session and reenabling restores guidance, not permission", async () => {
		const { pi } = controllerFor({ needs_development: NEEDS_DEVELOPMENT });
		const first = fakeCtx({ sessionId: "first" });
		const second = fakeCtx({ sessionId: "second" });

		pi.callCommand("jev", "off", first);

		const secondTriage = await pi.callTool("jev_triage", { request: "Report the coverage", }, second);
		expect(toolDetails(secondTriage)["enabled"]).not.toBe(false);
		expect(toolFailed(secondTriage)).toBe(false);
		const firstTriage = await pi.callTool("jev_triage", { request: "Report the coverage" }, first);
		expect(toolDetails(firstTriage)["enabled"]).toBe(false);

		pi.callCommand("jev", "on", first);
		const onPrompt = await pi.emit("before_agent_start", { prompt: "Report the coverage", systemPrompt: ["Host policy"] }, first);
		expect(promptOf(onPrompt).join("\n")).toContain("jev_requirements");
		pi.callCommand("jev", "on", first);
		expect(lastMessage(pi, "jev.mode")).toMatch(/on/i);
	});

	test("mode cannot be changed by extension text", async () => {
		const { pi } = controllerFor({ consult: { probability: 0.9 } });
		const ctx = fakeCtx();

		await pi.emit("input", { source: "extension", text: "/jev off" }, ctx);

		const result = await pi.callTool("jev_consult", consultParams(), ctx);
		expect(toolDetails(result)["enabled"]).not.toBe(false);
		expect(toolFailed(result)).toBe(false);
	});

	test("a stale in-flight answer is discarded after a mode change", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fake = answeringJudge({ consult: { probability: 0.9 } });
		const judge: Judge = async (state, questions) => {
			entered.resolve();
			await release.promise;
			return fake.judge(state, questions);
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx();
		const pending = pi.callTool("jev_consult", consultParams(), ctx);
		await entered.promise;

		pi.callCommand("jev", "off", ctx);
		pi.callCommand("jev", "on", ctx);
		release.resolve();

		const result = await pending;
		expect(
			toolDetails(result)["kind"] === "stale" || toolDetails(result)["enabled"] === false || /stale|discard/i.test(toolText(result)),
		).toBe(true);
		const listed = await pi.callTool("jev_context", { action: "list" }, ctx);
		expect(toolDetails(listed)["hold"]).toBeUndefined();
	});
});

describe("request and revision invalidation", () => {
	test("a queued judgment cannot be retargeted to a later owner request", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const judge: Judge = async (state, questions) => {
			entered.resolve();
			await release.promise;
			return answeringJudge({ consult: { probability: 0.9 } }).judge(state, questions);
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx();
		await pi.emit("before_agent_start", { prompt: "Inspect the parser" }, ctx);
		const pending = pi.callTool("jev_consult", consultParams(), ctx);
		await entered.promise;

		await pi.emit("before_agent_start", { prompt: "Now repair the parser" }, ctx);
		release.resolve();

		const result = await pending;
		expect(toolDetails(result)["kind"]).toBe("stale");
		expect(toolText(result)).toMatch(/stale|discard|earlier|not judged|changed/i);
	});

	test("a queued judgment cannot cross a new work revision", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const judge: Judge = async (state, questions) => {
			entered.resolve();
			await release.promise;
			return answeringJudge({ consult: { probability: 0.9 } }).judge(state, questions);
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx();
		await pi.emit("before_agent_start", { prompt: "Inspect the parser" }, ctx);
		const pending = pi.callTool("jev_consult", consultParams(), ctx);
		await entered.promise;

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		release.resolve();

		const result = await pending;
		expect(toolDetails(result)["kind"]).toBe("stale");
		expect(toolText(result)).toMatch(/stale|discard|revision|not judged|changed/i);
	});
});

describe("automatic action diagnostics", () => {
	test("a planned snapshot runs one diagnostic in the background and never blocks the next action or stop", async () => {
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		const { pi, calls } = controllerFor({ needs_development: NEEDS_DEVELOPMENT, ...PLAN_APPROVED });
		await planned(pi, ctx);
		const before = calls.length;

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);

		expect(await until(() => calls.length > before, 1000)).toBe(true);
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx))).toBeUndefined();
		expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
	});

	test("without an approved plan a recorded action is unchecked, not judged", async () => {
		const { pi, calls } = controllerFor({});

		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), fakeCtx());

		expect(calls).toHaveLength(0);
	});

	test("a pending automatic diagnostic does not delay tool_call or session_stop", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const base = answeringJudge({ needs_development: NEEDS_DEVELOPMENT, ...PLAN_APPROVED });
		let holdAutomatic = false;
		const judge: Judge = async (state, questions) => {
			if (holdAutomatic) {
				entered.resolve();
				await release.promise;
			}
			return base.judge(state, questions);
		};
		const pi = fakePi();
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		const ctx = fakeCtx({ artifactsDir: await fakeArtifacts({ "x-plan.md": PLAN_BODY }) });
		await planned(pi, ctx);
		holdAutomatic = true;
		await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts" }, "Successfully wrote 4 bytes"), ctx);
		await entered.promise;

		let admission: unknown[] | undefined;
		let stop: unknown[] | undefined;
		void pi.emit("tool_call", toolCallEvent("write", { path: "src/b.ts", content: "x" }), ctx).then(result => {
			admission = result;
		});
		void pi.emit("session_stop", stopEvent(), ctx).then(result => {
			stop = result;
		});
		const checkpoint = Promise.withResolvers<void>();
		setImmediate(checkpoint.resolve);
		await checkpoint.promise;
		release.resolve();

		expect(admission).toBeDefined();
		if (admission !== undefined) expect(blockReason(admission)).toBeUndefined();
		expect(stop).toBeDefined();
		if (stop !== undefined) expect(stopDecision(stop)).toBeUndefined();
	});

	test("session_stop does not broadcast status or block after a diagnostic", async () => {
		const { pi } = controllerFor({ consult: { probability: 0.9 } });
		const status = new Map<string, string | undefined>();
		const ctx = fakeCtx({ setStatus: (key, text) => status.set(key, text) });
		expect(toolFailed(await pi.callTool("jev_consult", consultParams(), ctx))).toBe(false);

		const stop = await pi.emit("session_stop", stopEvent(), ctx);

		expect(stopDecision(stop)).toBeUndefined();
		expect([...status]).toEqual([]);
		expect(pi.messages).toEqual([]);
	});
});

describe("session switch carries no execution authority", () => {
	test("an approved plan in the previous session grants nothing to the replacement session", async () => {
		const cwd = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
		const host = switchableCtx({ artifactsDir: cwd, sessionId: "session-1" });
		const { pi } = controllerFor({ needs_development: NEEDS_DEVELOPMENT, ...PLAN_APPROVED });
		await triaged(pi, host.ctx, "Build the report");
		expect(toolText(await pi.callTool("jev_context", { action: "list" }, host.ctx))).toContain("Build the report");

		await pi.emit("session_before_switch", { reason: "new" }, host.ctx);
		host.switchTo({ sessionId: "session-2", artifactsDir: cwd });
		await pi.emit("session_switch", { reason: "new" }, host.ctx);

		const listed = await pi.callTool("jev_context", { action: "list" }, host.ctx);
		expect(toolText(listed)).toContain("not registered");
		expect(toolDetails(listed)["hold"]).toBeUndefined();
		expect(blockReason(await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), host.ctx))).toBeUndefined();
	});
});

describe("session accounting", () => {
	test("status shows per-tool outcomes, judge calls and spend", async () => {
		const { pi } = controllerFor({ consult: { probability: 0.9 } });
		const ctx = fakeCtx();
		const result = await pi.callTool("jev_consult", consultParams(), ctx);
		expect(toolFailed(result)).toBe(false);
		const diagnostics = asRecord(toolDetails(result)["diagnostics"]);
		expect(asRecord(diagnostics?.["checks"])?.["passed"]).toBe(1);

		pi.callCommand("jev-status", "", ctx);

		const status = lastMessage(pi, "jev.status") ?? "";
		expect(status).toContain("jev_consult");
		expect(status).toMatch(/completed|ok/i);
		expect(status).toMatch(/judge|requests/i);
		expect(status).toMatch(/spend/i);
	});

	test("session startup and mode commands never populate or clear a status strip", async () => {
		const { pi } = controllerFor({ consult: { probability: 0.9 } });
		const status = new Map<string, string | undefined>();
		const ctx = fakeCtx({ setStatus: (key, text) => status.set(key, text) });
		await pi.emit("session_start", {}, ctx);

		pi.callCommand("jev", "off", ctx);
		pi.callCommand("jev", "on", ctx);
		await pi.emit("session_stop", stopEvent(), ctx);

		expect([...status]).toEqual([]);
	});

	test("activity totals survive a mode round trip while findings do not", async () => {
		const { pi } = controllerFor({ consult: { probability: 0.9 } });
		const ctx = fakeCtx();
		expect(toolFailed(await pi.callTool("jev_consult", consultParams(), ctx))).toBe(false);

		pi.callCommand("jev", "off", ctx);
		pi.callCommand("jev", "on", ctx);
		pi.callCommand("jev-status", "", ctx);

		expect(lastMessage(pi, "jev.status") ?? "").toContain("jev_consult");
	});
});

describe("automatic evidence-based acceptance", () => {
	test("ordinary completion publishes task and integrated reviews without waiting for either", async () => {
		const pending = Promise.withResolvers<void>();
		const judge: Judge = async (material, questions) => {
			if (asRecord(material)?.["check"] === "plan_task") await pending.promise;
			return answeringJudge({
				needs_development: NEEDS_DEVELOPMENT, ...PLAN_APPROVED,
				task_definition: { label: "checkable" },
				task_review: { label: "observed" },
				task_basis: { label: "evidence_3" },
				cleanup_evidence_1: { label: "unnecessary_abstraction" },
				cleanup_evidence_2: { label: "out_of_scope" },
				integration: { label: "observed" },
				integration_basis: { label: "evidence_3" },
			}).judge(material, questions);
		};
		const pi = fakePi();
		const reports: unknown[] = [];
		pi.api.appendEntry = (type, data) => {
			if (type === "jev.acceptance") reports.push(data);
		};
		createJevController({ judge, config: config(), zod: fakeZod() }).register(pi.api);
		const cwd = await fakeArtifacts({ "x-plan.md": PLAN_BODY });
		const ctx = fakeCtx({ artifactsDir: cwd });
		try {
			await planned(pi, ctx);
			await pi.emit("tool_result", toolResultEvent("write", { path: "src/a.ts", content: "export const coverage = 100;" }, "Wrote src/a.ts"), ctx);
			await pi.emit("tool_result", toolResultEvent("edit", { input: "*** Begin Patch\n[src/extra.ts#A1B2]\nPUT >1:\n+export const extra = true;\n*** End Patch" }, "Edited src/extra.ts"), ctx);
			await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test" }, "1 pass, 0 fail: report records coverage"), ctx);
			expect(stopDecision(await pi.emit("session_stop", stopEvent(), ctx))).toBeUndefined();
			expect(reports).toHaveLength(0);
			pending.resolve();
			expect(await until(() => reports.length === 1)).toBe(true);
			expect(pi.messages).toEqual([]);
			const result = await pi.callTool("jev_acceptance", { aspect: "outcome" }, ctx);
			expect(toolDetails(result)).toMatchObject({
				approved: true,
				replayed: true,
				tasks: [{ id: "collect", status: "approved", cleanup: { recommendations: [
					{ basis: { source: "write: src/a.ts" }, recommendation: expect.stringContaining("Inline") },
					{ basis: { source: "edit: src/extra.ts" }, recommendation: expect.stringContaining("Remove") },
				] } }],
				overall: { status: "approved", cleanup: { recommendations: [expect.any(Object), expect.any(Object)] } },
			});
			const messages = await pi.emit("context", { messages: [] }, ctx);
			expect(JSON.stringify(messages)).toContain("src/a.ts");
			pi.callCommand("jev-status", "", ctx);
			expect(lastMessage(pi, "jev.status")).toContain("collect");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
