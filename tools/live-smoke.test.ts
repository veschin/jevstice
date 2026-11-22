import { describe, expect, test } from "bun:test";
import {
	diagnosticProblems,
	diagnosticsOf,
	hostPrompt,
	normalizeHostEvent,
	scenarioOf,
	verifyHost,
} from "./live-smoke";

const counts = (failed = 0, passed = 0, notChecked = 0) => ({
	checks: { passed, failed, inconclusive: 0, unavailable: 0, not_checked: notChecked },
	work: { passed: 0, failed: 0, inconclusive: 0, unavailable: 0, not_checked: notChecked },
});

const end = (toolName: string, details: Record<string, unknown>, args: Record<string, unknown> = {}, isError = false) => ({
	type: "tool_execution_end",
	toolCallId: `call-${toolName}`,
	toolName,
	args,
	isError,
	result: { content: [{ type: "text", text: `${toolName} result` }], details },
});

describe("host event normalization", () => {
	test("an xdev-routed extension call becomes the logical jev tool", () => {
		const raw = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "write",
			isError: true,
			result: {
				content: [{ type: "text", text: "business acceptance was not approved" }],
				details: {
					xdev: {
						tool: "jev_acceptance",
						args: { aspect: "business" },
						inner: { approved: false, revision: 3, diagnostics: counts(1, 0, 0) },
					},
				},
			},
		};

		const normalized = normalizeHostEvent(raw);

		expect(normalized.toolName).toBe("jev_acceptance");
		expect(normalized.args).toEqual({ aspect: "business" });
		expect(normalized.isError).toBe(true);
		const result = normalized.result as { content: unknown; details: unknown };
		expect(result.details).toEqual({ approved: false, revision: 3, diagnostics: counts(1, 0, 0) });
		expect(result.content).toEqual(raw.result.content);
	});

	test("a native call is left unchanged", () => {
		const raw = {
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "write",
			isError: false,
			result: { content: [], details: {} },
		};

		expect(normalizeHostEvent(raw)).toBe(raw);
	});
});

describe("diagnostic shape", () => {
	test("all five keys are required in both groups", () => {
		expect(diagnosticsOf({ diagnostics: counts(1, 2, 3) })).toEqual(counts(1, 2, 3));
		expect(diagnosticProblems("result", { diagnostics: counts() })).toEqual([]);
	});

	test("a missing key is named, not treated as a zero", () => {
		const broken = { diagnostics: { checks: { passed: 1, failed: 0, inconclusive: 0, unavailable: 0 }, work: counts().work } };
		const problems = diagnosticProblems("result", broken);
		expect(problems).toContain("result diagnostics.checks.not_checked is not a number");
		expect(diagnosticsOf(broken)).toBeUndefined();
	});

	test("a result without diagnostics is rejected", () => {
		expect(diagnosticsOf({ approved: true })).toBeUndefined();
		expect(diagnosticProblems("jev_context", { approved: true })).toEqual(["jev_context returned no details.diagnostics"]);
	});
});

describe("host verification", () => {
	test("a pre-plan write is expected to execute and a negative verdict is recorded as failed", () => {
		const scenario = scenarioOf("workflow");
		const diagnostics = counts(1, 4, 0);
		const events = [
			end("write", {}, { path: "src/slug.ts", content: "probe" }),
			end("jev_triage", { needsDevelopment: true, diagnostics }, { request: scenario.request }),
			end("jev_requirements", { approved: true, diagnostics }),
			end("jev_plan_review", { planDigest: "digest", diagnostics }),
			end("write", {}, { path: "src/slug.ts", content: "export function slugify() {}" }),
			end("bash", {}, { command: "bun test tests/slug.test.ts" }),
			end("jev_acceptance", { aspect: "business", approved: false, revision: 1, diagnostics }, { aspect: "business" }),
			end("jev_acceptance", { aspect: "architecture", approved: true, revision: 1, diagnostics }, { aspect: "architecture" }),
		];

		const verdict = verifyHost(scenario, events);
		expect(verdict.pass).toBe(true);
		expect(verdict.problems).toEqual([]);
	});

	test("OMP 19.1 mounted verdicts satisfy the same verification as direct calls", () => {
		const scenario = scenarioOf("workflow");
		const diagnostics = counts(1, 4, 0);
		const execute = (tool: string, args: Record<string, unknown>, inner: Record<string, unknown>) => ({
			tool, mode: "execute", tier: "read", exitCode: 0, args, inner: { ...inner, diagnostics },
		});
		const events = [
			end("write", {}, { path: scenario.probePath }),
			end("bash", { toolCommands: [
				{ tool: "jev_triage", mode: "help", exitCode: 0 },
				execute("jev_triage", { request: scenario.request }, { needsDevelopment: true }),
			] }),
			end("bash", { toolCommands: [
				execute("jev_requirements", {}, { approved: true }),
				execute("jev_plan_review", { phase: "finalize" }, { planDigest: "digest" }),
			] }),
			end("write", {}, { path: "src/slug.ts" }),
			end("bash", {}, { command: "bun test tests/slug.test.ts" }),
			end("bash", { toolCommands: [
				execute("jev_acceptance", { aspect: "business" }, { approved: false, revision: 1 }),
				execute("jev_acceptance", { aspect: "architecture" }, { approved: true, revision: 1 }),
			] }),
		];
		expect(verifyHost(scenario, events)).toEqual({ pass: true, problems: [] });
	});

	test("a failed pre-plan write and a hidden negative are reported", () => {
		const scenario = scenarioOf("workflow");
		const passedOnly = counts(0, 4, 0);
		const events = [
			end("write", {}, { path: "src/slug.ts", content: "probe" }, true),
			end("jev_triage", { needsDevelopment: true, diagnostics: passedOnly }),
			end("jev_requirements", { approved: false, diagnostics: passedOnly }),
			end("jev_plan_review", { planDigest: "digest", diagnostics: passedOnly }),
		];

		const verdict = verifyHost(scenario, events);
		expect(verdict.pass).toBe(false);
		expect(verdict.problems.some(problem => problem.includes("pre-plan write"))).toBe(true);
		expect(verdict.problems.some(problem => problem.includes("checks.failed count stayed zero"))).toBe(true);
	});

	test("the prompt asks for execution rather than a refusal", () => {
		const prompt = hostPrompt(scenarioOf("workflow"));
		expect(prompt).toContain("expected to execute");
		expect(prompt).toContain("Jev results are diagnostics, never permission");
		expect(prompt).not.toContain("must refuse");
		expect(prompt).not.toContain("jev-continue");
	});
});
