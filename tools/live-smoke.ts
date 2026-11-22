#!/usr/bin/env bun
/**
 * Live smoke for the diagnostic Jevstice contract.
 *
 * `direct` builds the real controller over the production judge (or an injected deterministic judge
 * for the `diagnostics` scenario), drives the registered tools and host events through the same
 * seams the tests use, and records every judge question, typed answer, tool outcome and diagnostic
 * snapshot. `host` launches the real omp CLI with the extension loaded (`-e src/index.ts`) and
 * verifies the native calls it produced.
 *
 * No mode treats a Jev verdict as execution permission. A negative verdict is recorded as a failed
 * diagnostic and later work still executes; an outage is recorded as unavailable and later work
 * still executes. A run fails when the record hides an observed outcome, when an expected native
 * call or write never happened, or when the diagnostic shape is missing.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoizedApiKeyResolver } from "../src/apikey.js";
import { loadJevConfig } from "../src/config.js";
import { createJevController } from "../src/controller.js";
import { createTypeSafeJudge, type Judge } from "../src/judge.js";
import { asRecord, type Evidence } from "../src/types.js";
import {
	answeringJudge,
	blockReason,
	fakeCtx,
	type FakeAnswerSource,
	type FakePi,
	fakePi,
	fakeZod,
	failingJudge,
	stopDecision,
	toolCallEvent,
	toolDetails,
	toolFailed,
	toolResultEvent,
	toolText,
	until,
} from "../tests/helpers.js";

const WORKFLOW_REQUEST =
	"Add src/slug.ts exporting slugify(input: string): string that lowercases ASCII letters, replaces each run of non-alphanumeric characters with one hyphen, and trims leading and trailing hyphens. Add tests/slug.test.ts with bun tests for slugify(\"Hello World\") === \"hello-world\" and slugify(\"  A  B  \") === \"a-b\".";

const FACTORIO_REQUEST = "Напиши Factorio в этом каталоге.";

const DIAGNOSTIC_KEYS = ["passed", "failed", "inconclusive", "unavailable", "not_checked"] as const;
type DiagnosticKey = (typeof DIAGNOSTIC_KEYS)[number];

interface RequirementSpec {
	text: string;
	source: string;
}

interface StepSpec {
	id: string;
	summary: string;
	requirement: string;
	paths: string[];
}

interface Scenario {
	name: "workflow" | "factorio";
	request: string;
	topics: string[];
	requirements: RequirementSpec[];
	steps: StepSpec[];
	artifactName: string;
	artifact: string;
	probePath: string;
	/** Present only for a scenario that implements something; absent means planning only. */
	implementation?: {
		files: Record<string, string>;
		command: string[];
		claims: { business: string; architecture: string };
	};
}

function sectionOf(artifact: string, id: string): string {
	const start = artifact.indexOf(`## ${id}`);
	if (start < 0) throw new Error(`artifact has no section '${id}'`);
	const next = artifact.indexOf("\n## ", start + 1);
	return artifact.slice(start, next < 0 ? undefined : next).trim();
}

function workflowScenario(): Scenario {
	const artifact = `# Slugify plan

## slug-module

Create \`src/slug.ts\` with \`export function slugify(input: string): string\`.
The module has no imports and no side effects; \`slugify\` is the only export.

Check: after implementation, \`bun -e 'import { slugify } from "./src/slug.ts"; console.log(typeof slugify)'\` prints \`function\`.

## slug-normalization

Implement \`slugify\` as \`input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")\`.
Lowercasing first makes the ASCII alphanumeric class sufficient; the final replace strips both ends.

Check: \`bun -e 'import { slugify } from "./src/slug.ts"; if (slugify("  A  B  ") !== "a-b") process.exit(1)'\` exits 0.

## slug-tests

Add \`tests/slug.test.ts\` importing \`slugify\` from \`../src/slug.ts\` and asserting exactly the two requested cases with \`bun:test\`.

Check: \`bun test tests/slug.test.ts\` reports two passing expectations and exits 0.`;
	const requirements: RequirementSpec[] = [
		{
			text: "src/slug.ts exists and exports slugify(input: string): string.",
			source: "Add src/slug.ts exporting slugify(input: string): string",
		},
		{
			text: "slugify lowercases ASCII letters, replaces each run of non-alphanumeric characters with one hyphen, and trims leading and trailing hyphens.",
			source:
				"lowercases ASCII letters, replaces each run of non-alphanumeric characters with one hyphen, and trims leading and trailing hyphens",
		},
		{
			text: "tests/slug.test.ts passes under bun with slugify(\"Hello World\") === \"hello-world\" and slugify(\"  A  B  \") === \"a-b\".",
			source:
				"Add tests/slug.test.ts with bun tests for slugify(\"Hello World\") === \"hello-world\" and slugify(\"  A  B  \") === \"a-b\"",
		},
	];
	return {
		name: "workflow",
		request: WORKFLOW_REQUEST,
		topics: ["string slug normalization", "bun test coverage"],
		requirements,
		steps: [
			{
				id: "slug-module",
				summary: "Create src/slug.ts exporting slugify",
				requirement: requirements[0]?.text ?? "",
				paths: ["src/slug.ts"],
			},
			{
				id: "slug-normalization",
				summary: "Implement lowercase, separator collapse and hyphen trimming",
				requirement: requirements[1]?.text ?? "",
				paths: ["src/slug.ts"],
			},
			{
				id: "slug-tests",
				summary: "Add and run the two stated bun test cases",
				requirement: requirements[2]?.text ?? "",
				paths: ["tests/slug.test.ts"],
			},
		],
		artifactName: "slug-plan.md",
		artifact,
		probePath: "src/slug.ts",
		implementation: {
			files: {
				"src/slug.ts":
					'export function slugify(input: string): string {\n\treturn input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n',
				"tests/slug.test.ts":
					'import { expect, test } from "bun:test";\nimport { slugify } from "../src/slug.ts";\n\ntest("slugify", () => {\n\texpect(slugify("Hello World")).toBe("hello-world");\n\texpect(slugify("  A  B  ")).toBe("a-b");\n});\n',
			},
			command: ["bun", "test", "tests/slug.test.ts"],
			claims: {
				business:
					"The finished work provides the requested exported slugify helper and the two stated bun test cases pass.",
				architecture:
					"slugify is a single exported pure function with no dependencies, and its tests exercise it through that public export.",
			},
		},
	};
}

function factorioScenario(): Scenario {
	const artifact = `# Browser-playable 2D factory game plan

Every section below is product behavior; its observed check is browser-based verification of that behavior, not a separate product feature.

## browser-shell

Serve a browser entry point (\`index.html\` plus \`src/main.ts\`) that renders a tile grid on a canvas. Camera pan (drag or WASD), zoom (wheel) and build placement (mouse click with a build toolbar) act on the grid; the camera transform stays separate from world coordinates.

Observed check: a browser check loads the page, places one building, pans and zooms, and asserts the building moved on screen while its grid coordinates stayed fixed.

## mining-and-belts

Resource patches hold ore. A mining drill placed on a patch emits ore onto an adjacent belt every tick. A belt is an ordered lane that advances items one tile per tick and stops when the next lane is occupied.

Observed check: a browser check places a drill on a patch and a belt line beside it, waits for game-loop ticks, and asserts ore appears and advances along the belt.

## inserters-and-inventory

Inserters move one item per tick between a belt, a machine and the player inventory, respecting facing and target input capacity. The inventory panel shows live item counts.

Observed check: a browser check places a belt, inserter and chest, observes one item transferred into the inventory, and asserts the displayed count changes by one.

## recipes-and-smelting

Define data-driven recipes for smelting (ore to plate) and assembly (plates to components). Machines hold input and output slots, consume a recipe only when inputs are present, and show progress; counts live in the inventory and machine slots.

Observed check: a browser check feeds ore into a furnace and plates into an assembler, observes progress complete, and asserts the output appears in the inventory while inputs decrease.

## electricity

Generators produce a shared power supply and machines declare a power demand. Demand above supply lowers satisfaction, and unpowered machines pause without consuming inputs.

Observed check: a browser check runs consumers with no generator, observes paused progress, adds a generator, and asserts progress resumes while the power panel reports demand within supply.

## research-and-goal

Research labs consume science packs to unlock technologies along a progression chain. Completing the final technology sets an explicit victory state shown in the UI and stops the run loop.

Observed check: a browser check supplies the required packs through game actions, completes the chain, and asserts the victory banner appears and further ticks no longer advance production. An end-to-end journey check also drives the rendered game from initial placement through mining, belt transport, insertion, smelting, assembly and power into the research victory state.

## save-and-load

Serialize world entities, belt items, inventory, power and research progress to browser storage. Loading restores the same state and continues ticking from it.

Observed check: a browser check builds and progresses a world, reloads the page, and asserts entity positions, inventory counts and research progress match the pre-reload snapshot.`;
	const requirements: RequirementSpec[] = [
		{
			text: "A browser-playable 2D factory game starts from this directory and renders a buildable tile grid with camera pan, zoom and placement controls.",
			source: "Напиши Factorio в этом каталоге.",
		},
		{
			text: "Mining drills extract ore from resource patches and deposit it onto adjacent belts.",
			source: "Напиши Factorio в этом каталоге.",
		},
		{
			text: "Belts move items and inserters transfer them among belts, machines and the player inventory.",
			source: "Напиши Factorio в этом каталоге.",
		},
		{
			text: "Smelting converts ore into plates, assembling machines apply recipes to turn inputs into outputs, and the inventory shows item counts.",
			source: "Напиши Factorio в этом каталоге.",
		},
		{
			text: "Electricity is produced by generators and consumed by machines, which pause when unpowered.",
			source: "Напиши Factorio в этом каталоге.",
		},
		{
			text: "Research consumes science packs to unlock technologies, and a progression chain leads to an explicit victory end goal.",
			source: "Напиши Factorio в этом каталоге.",
		},
		{
			text: "The game saves and loads world, inventory, power and research state across browser reloads.",
			source: "Напиши Factorio в этом каталоге.",
		},
	];
	return {
		name: "factorio",
		request: FACTORIO_REQUEST,
		topics: ["2d grid factory simulation", "browser game controls", "production and power simulation"],
		requirements,
		steps: [
			{
				id: "browser-shell",
				summary: "Serve the browser entry point with grid, camera and build controls",
				requirement: requirements[0]?.text ?? "",
				paths: ["index.html", "src/main.ts"],
			},
			{
				id: "mining-and-belts",
				summary: "Implement drills, ore patches and moving belts",
				requirement: requirements[1]?.text ?? "",
				paths: ["src/world/mining.ts", "src/world/belts.ts"],
			},
			{
				id: "inserters-and-inventory",
				summary: "Implement inserters and the live inventory panel",
				requirement: requirements[2]?.text ?? "",
				paths: ["src/world/inserters.ts", "src/ui/inventory.ts"],
			},
			{
				id: "recipes-and-smelting",
				summary: "Implement data-driven smelting and assembly recipes with machine slots",
				requirement: requirements[3]?.text ?? "",
				paths: ["src/data/recipes.ts", "src/world/machines.ts"],
			},
			{
				id: "electricity",
				summary: "Implement generators, demand and unpowered machine pausing",
				requirement: requirements[4]?.text ?? "",
				paths: ["src/world/power.ts"],
			},
			{
				id: "research-and-goal",
				summary: "Implement the research chain and the victory end goal",
				requirement: requirements[5]?.text ?? "",
				paths: ["src/game/research.ts", "src/game/goal.ts"],
			},
			{
				id: "save-and-load",
				summary: "Persist and restore the full game state in browser storage",
				requirement: requirements[6]?.text ?? "",
				paths: ["src/game/save.ts"],
			},
		],
		artifactName: "factorio-plan.md",
		artifact,
		probePath: "index.html",
	};
}

export function scenarioOf(name: string): Scenario {
	if (name === "workflow") return workflowScenario();
	if (name === "factorio") return factorioScenario();
	throw new Error(`unknown scenario '${name}' (expected workflow, factorio or diagnostics)`);
}

function parseArgs(argv: string[]): { mode: string; scenario: string; out?: string; model?: string; maxTime: number } {
	const [mode, ...rest] = argv;
	const options = { mode: mode ?? "", scenario: "workflow", out: undefined as string | undefined, model: undefined as string | undefined, maxTime: 900 };
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		const value = rest[index + 1];
		if (arg === "--scenario" && value !== undefined) {
			options.scenario = value;
			index += 1;
			continue;
		}
		if (arg === "--out" && value !== undefined) {
			options.out = value;
			index += 1;
			continue;
		}
		if (arg === "--model" && value !== undefined) {
			options.model = value;
			index += 1;
			continue;
		}
		if (arg === "--max-time" && value !== undefined) {
			options.maxTime = Number.parseInt(value, 10);
			index += 1;
			continue;
		}
		throw new Error(`unknown argument '${arg}'`);
	}
	if (!Number.isInteger(options.maxTime) || options.maxTime <= 0) throw new Error("--max-time must be a positive whole number of seconds");
	return options;
}

function outputDir(requested: string | undefined): string {
	const dir = requested ?? mkdtempSync(join(tmpdir(), "jev-live-smoke-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** One structured line of evidence, also returned so a failed run explains itself in the summary. */
interface EvidenceLog {
	path: string;
	entries: Record<string, unknown>[];
}

function evidenceLog(path: string): EvidenceLog {
	return { path, entries: [] };
}

function addEvidence(log: EvidenceLog, entry: Record<string, unknown>): void {
	log.entries.push(entry);
	appendFileSync(log.path, `${JSON.stringify(entry)}\n`, "utf8");
}

interface ToolReply {
	text: string;
	details: Record<string, unknown>;
	failed: boolean;
}

interface DiagnosticCounts {
	checks: Record<DiagnosticKey, number>;
	work: Record<DiagnosticKey, number>;
}

function countsOf(value: unknown): Record<DiagnosticKey, number> | undefined {
	const record = asRecord(value);
	if (record === undefined) return undefined;
	const counts = {} as Record<DiagnosticKey, number>;
	for (const key of DIAGNOSTIC_KEYS) {
		const count = record[key];
		if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return undefined;
		counts[key] = count;
	}
	return counts;
}

/** The five-key diagnostic snapshot attached to every ordinary Jev tool result, or undefined. */
export function diagnosticsOf(details: unknown): DiagnosticCounts | undefined {
	const record = asRecord(details);
	if (record === undefined) return undefined;
	const diagnostics = asRecord(record["diagnostics"]);
	if (diagnostics === undefined) return undefined;
	const checks = countsOf(diagnostics["checks"]);
	const work = countsOf(diagnostics["work"]);
	return checks === undefined || work === undefined ? undefined : { checks, work };
}

/** Problem statements for a result that does not carry the current diagnostic shape. */
export function diagnosticProblems(label: string, details: unknown): string[] {
	const record = asRecord(details);
	if (record === undefined) return [`${label} returned no details object`];
	const diagnostics = asRecord(record["diagnostics"]);
	if (diagnostics === undefined) return [`${label} returned no details.diagnostics`];
	const problems: string[] = [];
	for (const group of ["checks", "work"] as const) {
		const counts = asRecord(diagnostics[group]);
		if (counts === undefined) {
			problems.push(`${label} returned no details.diagnostics.${group}`);
			continue;
		}
		for (const key of DIAGNOSTIC_KEYS) {
			if (typeof counts[key] !== "number") problems.push(`${label} diagnostics.${group}.${key} is not a number`);
		}
	}
	return problems;
}

function parseCount(summary: string, key: DiagnosticKey, section: "Checks" | "Work"): number | undefined {
	const match = new RegExp(`${section}: [^.]*?(\\d+) ${key}`).exec(summary);
	if (match === null) return undefined;
	return Number.parseInt(match[1] ?? "", 10);
}

function planEvidence(scenario: Scenario, quote: string): Evidence[] {
	return [{ kind: "documentation", quote, source: `local://${scenario.artifactName}` }];
}

function writeEvidenceFile(root: string, path: string, content: string): string {
	const absolute = join(root, path);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content, "utf8");
	return absolute;
}

async function callTool(pi: FakePi, ctx: unknown, name: string, params: unknown, log: EvidenceLog): Promise<ToolReply> {
	const gate = await pi.emit("tool_call", toolCallEvent(name, params), ctx);
	const blocked = blockReason(gate);
	if (blocked !== undefined) {
		addEvidence(log, { kind: "tool_call", name, params, blocked });
		throw new Error(`the addon blocked the ${name} diagnostic call: ${blocked}`);
	}
	const result = await pi.callTool(name, params, ctx);
	const text = toolText(result);
	const details = toolDetails(result);
	const failed = toolFailed(result);
	addEvidence(log, { kind: "tool", name, params, text, details, failed });
	return { text, details, failed };
}

/**
 * Execute one consequential call the way the host does: the gate handler runs first, the effect is
 * performed for real, then the terminal result is reported. The gate must not block: ordinary Jev
 * diagnostics never hold execution.
 */
async function performWrite(
	pi: FakePi,
	ctx: unknown,
	workspace: string,
	input: { path: string; content: string },
	log: EvidenceLog,
): Promise<void> {
	const gate = await pi.emit("tool_call", toolCallEvent("write", input), ctx);
	const blocked = blockReason(gate);
	if (blocked !== undefined) throw new Error(`the addon blocked the write to '${input.path}': ${blocked}`);
	const absolute = writeEvidenceFile(workspace, input.path, input.content);
	if (readFileSync(absolute, "utf8") !== input.content) throw new Error(`the executed write did not produce the approved bytes for ${input.path}`);
	await pi.emit("tool_result", toolResultEvent("write", input, `wrote ${input.content.length} bytes`), ctx);
	addEvidence(log, { kind: "effect", tool: "write", path: input.path, bytes: input.content.length });
}

async function runPlanning(
	scenario: Scenario,
	pi: FakePi,
	ctx: unknown,
	log: EvidenceLog,
): Promise<void> {
	const triage = await callTool(pi, ctx, "jev_triage", { request: scenario.request, topics: scenario.topics }, log);
	if (triage.details["needsDevelopment"] !== true && !triage.text.includes("development task registered")) {
		throw new Error(`triage did not register a development task: ${triage.text}`);
	}
	const requirements = await callTool(pi, ctx, "jev_requirements", {
		request: scenario.request,
		items: scenario.requirements,
		candidateNeeds: [],
	}, log);
	if (requirements.failed || requirements.details["approved"] !== true) {
		throw new Error(`requirements were not approved: ${requirements.text}`);
	}
	const outline = await callTool(pi, ctx, "jev_plan_review", {
		phase: "outline",
		steps: scenario.steps.map(step => ({ id: step.id, summary: step.summary, requirement: step.requirement })),
		evidence: planEvidence(scenario, sectionOf(scenario.artifact, scenario.steps[0]?.id ?? "")),
	}, log);
	const outlineVerdict = outline.details["verdict"];
	if (
		outline.details["phase"] !== "detail" &&
		outlineVerdict !== "serves" &&
		!(typeof outlineVerdict === "string" && outlineVerdict !== "revise" && outlineVerdict !== "unsupported")
	) {
		throw new Error(`the outline was not approved: ${outline.text}`);
	}
	for (const step of scenario.steps) {
		const section = sectionOf(scenario.artifact, step.id);
		const detail = await callTool(pi, ctx, "jev_plan_review", {
			phase: "detail",
			plan: `local://${scenario.artifactName}`,
			topic: { id: step.id, section, paths: step.paths, requirement: step.requirement },
			evidence: planEvidence(scenario, section),
		}, log);
		const verdict = detail.details["verdict"];
		if (
			detail.failed ||
			(typeof verdict === "string" &&
				["revise", "missing_operation", "missing_check", "scope_expansion", "conflict", "unclear"].includes(verdict))
		) {
			throw new Error(`detail for '${step.id}' was not approved: ${detail.text}`);
		}
	}
	const finalize = await callTool(pi, ctx, "jev_plan_review", {
		phase: "finalize",
		plan: `local://${scenario.artifactName}`,
		evidence: planEvidence(scenario, scenario.artifact),
	}, log);
	if (typeof finalize.details["planDigest"] !== "string" && !finalize.text.includes("plan approved")) {
		throw new Error(`the final plan was not approved: ${finalize.text}`);
	}
	addEvidence(log, { kind: "stage", name: "plan", status: "approved" });
}

async function runImplementationCommand(
	scenario: Scenario,
	pi: FakePi,
	ctx: unknown,
	workspace: string,
	log: EvidenceLog,
): Promise<string> {
	const implementation = scenario.implementation;
	if (implementation === undefined) throw new Error(`'${scenario.name}' has no implementation command`);
	for (const [path, content] of Object.entries(implementation.files)) {
		await performWrite(pi, ctx, workspace, { path, content }, log);
	}
	const command = implementation.command;
	const commandText = command.join(" ");
	const gate = await pi.emit("tool_call", toolCallEvent("bash", { command: commandText }), ctx);
	const blocked = blockReason(gate);
	if (blocked !== undefined) throw new Error(`the addon blocked the implementation command: ${blocked}`);
	// The smoke executes exactly the reported command once; the smoke itself must not be a failure
	// only because the implementation is wrong, but an exit code is recorded truthfully.
	const run = spawnSync(command[0] ?? "bun", command.slice(1), { cwd: workspace, encoding: "utf8" });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "").trim();
	await pi.emit("tool_result", toolResultEvent("bash", { command: commandText }, output.slice(0, 4000), run.status !== 0), ctx);
	addEvidence(log, { kind: "effect", tool: "bash", command: commandText, status: run.status, output });
	if (run.status !== 0) throw new Error(`the implementation command failed (${String(run.status)}): ${output}`);
	return output;
}

async function runAcceptance(
	scenario: Scenario,
	pi: FakePi,
	ctx: unknown,
	output: string,
	log: EvidenceLog,
): Promise<Record<string, unknown>> {
	const implementation = scenario.implementation;
	if (implementation === undefined) throw new Error(`'${scenario.name}' has no acceptance claims`);
	const commandText = implementation.command.join(" ");
	const codeQuote = Object.entries(implementation.files)
		.map(([path, content]) => `${path}\n${content}`)
		.join("\n\n");
	const evidence: Evidence[] = [
		{ kind: "execution", quote: `$ ${commandText}\n${output}`, source: "smoke workspace" },
		{ kind: "code", quote: codeQuote, source: "written files" },
	];
	const verdicts: Record<string, unknown> = {};
	for (const aspect of ["business", "architecture"] as const) {
		const acceptance = await callTool(pi, ctx, "jev_acceptance", {
			aspect,
			claim: implementation.claims[aspect],
			evidence,
		}, log);
		if (typeof acceptance.details["approved"] !== "boolean") {
			throw new Error(`${aspect} acceptance returned no typed approved verdict: ${acceptance.text}`);
		}
		verdicts[aspect] = acceptance.details["approved"];
		addEvidence(log, { kind: "stage", name: `acceptance:${aspect}`, approved: acceptance.details["approved"], confidence: acceptance.details["confidence"], revision: acceptance.details["revision"] });
	}
	return verdicts;
}

function expectDiagnosticShape(label: string, details: Record<string, unknown>): DiagnosticCounts {
	const problems = diagnosticProblems(label, details);
	if (problems.length > 0) throw new Error(problems.join("; "));
	const snapshot = diagnosticsOf(details);
	if (snapshot === undefined) throw new Error(`${label} returned no readable diagnostics`);
	return snapshot;
}

async function statusTextOf(pi: FakePi, ctx: unknown): Promise<string> {
	const first = pi.messages.length;
	let message: FakePi["messages"][number] | undefined;
	pi.callCommand("jev-status", "", ctx);
	await until(() => {
		message = pi.messages.find((entry, index) => index >= first && entry.customType === "jev.status");
		return message !== undefined;
	});
	if (message === undefined) throw new Error("/jev-status emitted no new status message within 500 ms");
	return message.content;
}

function assertStatusTruth(summary: string, label: string): void {
	if (!summary.includes("Jev diagnostics, not execution permission.")) throw new Error(`${label} status does not state that diagnostics are not permission: ${summary}`);
	if (!summary.includes("Findings never block continued work or completion.")) throw new Error(`${label} status denies continuation independence: ${summary}`);
	if (!summary.includes("Current-revision acceptance:")) throw new Error(`${label} status omits current-revision acceptance: ${summary}`);
	const shown: Record<DiagnosticKey, string> = {
		passed: "passed",
		failed: "failed",
		inconclusive: "inconclusive",
		unavailable: "unavailable",
		not_checked: "not checked",
	};
	for (const key of DIAGNOSTIC_KEYS) {
		if (!summary.includes(` ${shown[key]}`)) throw new Error(`${label} status omits the '${shown[key]}' count: ${summary}`);
	}
}

function assertCommandSurface(pi: FakePi): void {
	if (!pi.commands.has("jev")) throw new Error("/jev is not registered");
	if (!pi.commands.has("jev-status")) throw new Error("/jev-status is not registered");
	if (pi.commands.has("jev-continue")) throw new Error("/jev-continue is still registered");
	if (pi.commands.has("jev-waive")) throw new Error("/jev-waive is still registered");
}

async function controllerFor(
	judge: Judge,
	workspace: string,
	artifactsDir: string,
	sessionId: string,
): Promise<{ pi: FakePi; ctx: unknown }> {
	const config = loadJevConfig({ cwd: workspace, home: join(workspace, "home") });
	if (config.problems.length > 0) throw new Error(`the default configuration did not load cleanly: ${config.problems.join("; ")}`);
	const pi = fakePi();
	createJevController({ judge, config, zod: fakeZod() }).register(pi.api);
	const ctx = fakeCtx({ artifactsDir, sessionId });
	return { pi, ctx };
}

async function direct(scenario: Scenario, dir: string): Promise<{ judgeCalls: number; diagnostics: DiagnosticCounts; acceptance: Record<string, unknown> }> {
	const workspace = mkdtempSync(join(tmpdir(), "jev-smoke-work-"));
	const artifactsDir = mkdtempSync(join(tmpdir(), "jev-smoke-artifacts-"));
	mkdirSync(join(artifactsDir, "local"), { recursive: true });
	writeFileSync(join(artifactsDir, "local", scenario.artifactName), scenario.artifact, "utf8");
	mkdirSync(join(dir, "artifacts"), { recursive: true });
	writeFileSync(join(dir, "artifacts", scenario.artifactName), scenario.artifact, "utf8");

	const log = evidenceLog(join(dir, "transcript.jsonl"));
	const judgeLog = evidenceLog(join(dir, "judge.jsonl"));
	const baseJudge = createTypeSafeJudge({ resolveKey: memoizedApiKeyResolver(process.env) });
	let judgeCalls = 0;
	const judge: Judge = async (state, questions) => {
		judgeCalls += 1;
		const outcome = await baseJudge(state, questions);
		addEvidence(judgeLog, { call: judgeCalls, questions, state, outcome });
		return outcome;
	};
	const { pi, ctx } = await controllerFor(judge, workspace, artifactsDir, "live-smoke");
	await pi.emit("session_start", {}, ctx);
	await pi.emit("before_agent_start", { prompt: scenario.request }, ctx);
	assertCommandSurface(pi);

	// A pre-triage write must actually execute: diagnostics are not an admission gate.
	await performWrite(pi, ctx, workspace, {
		path: scenario.probePath,
		content: scenario.implementation?.files[scenario.probePath] ?? "probe\n",
	}, log);

	await runPlanning(scenario, pi, ctx, log);
	const implementation = scenario.implementation;
	if (implementation === undefined) {
		addEvidence(log, { kind: "stage", name: "planning", status: "plan approved; implementation intentionally not performed" });
		const snapshot = expectDiagnosticShape("jev_context", (await callTool(pi, ctx, "jev_context", { action: "list" }, log)).details);
		assertStatusTruth(await statusTextOf(pi, ctx), "planning-only");
		return { judgeCalls, diagnostics: snapshot, acceptance: {} };
	}

	const output = await runImplementationCommand(scenario, pi, ctx, workspace, log);
	mkdirSync(join(dir, "workspace"), { recursive: true });
	for (const [path, content] of Object.entries(implementation.files)) writeEvidenceFile(join(dir, "workspace"), path, content);
	writeFileSync(join(dir, "workspace", "command-output.txt"), output, "utf8");

	const afterWork = await callTool(pi, ctx, "jev_context", { action: "list" }, log);
	expectDiagnosticShape("jev_context", afterWork.details);
	const acceptance = await runAcceptance(scenario, pi, ctx, output, log);

	// Completion is independent from the typed acceptance verdicts.
	const stop = await pi.emit("session_stop", {}, ctx);
	const held = stopDecision(stop);
	if (held !== undefined) throw new Error(`the addon held ordinary completion: ${held}`);
	addEvidence(log, { kind: "stage", name: "completion", status: "settled without a Jev hold" });
	assertStatusTruth(await statusTextOf(pi, ctx), scenario.name);
	const final = expectDiagnosticShape(
		"jev_context",
		(await callTool(pi, ctx, "jev_context", { action: "list" }, log)).details,
	);
	return { judgeCalls, diagnostics: final, acceptance };
}

/**
 * Deterministic continuation coverage: an injected judge produces a negative review and a negative
 * acceptance, then a separate controller produces an outage. Both must be recorded truthfully while
 * the real controller keeps executing and settles completion. This is not a production-judge result.
 */
async function diagnosticsScenario(dir: string): Promise<{ judgeCalls: number; negative: DiagnosticCounts; outage: DiagnosticCounts }> {
	const scenario = workflowScenario();
	const workspace = mkdtempSync(join(tmpdir(), "jev-smoke-diag-"));
	const artifactsDir = mkdtempSync(join(tmpdir(), "jev-smoke-diag-artifacts-"));
	mkdirSync(join(artifactsDir, "local"), { recursive: true });
	writeFileSync(join(artifactsDir, "local", scenario.artifactName), scenario.artifact, "utf8");
	mkdirSync(join(dir, "artifacts"), { recursive: true });
	writeFileSync(join(dir, "artifacts", scenario.artifactName), scenario.artifact, "utf8");

	const log = evidenceLog(join(dir, "transcript.jsonl"));
	const judgeLog = evidenceLog(join(dir, "judge.jsonl"));
	const table: Record<string, FakeAnswerSource> = {
		needs_development: { probability: 0.95 },
		external_deliverable: { probability: 0 },
		topic_1: { probability: 0.95 },
		topic_2: { probability: 0.95 },
		coverage: { probability: 0.95 },
		item_1: { probability: 0.95 },
		item_2: { probability: 0.95 },
		item_3: { probability: 0.95 },
		outline_requirement_1: { probability: 0.95 },
		outline_requirement_2: { probability: 0.95 },
		outline_requirement_3: { probability: 0.95 },
		outline_step_1: { probability: 0.95 },
		outline_step_2: { probability: 0.95 },
		outline_step_3: { probability: 0.95 },
		detail: { label: "ready", confidence: 0.95 },
		finalize_consistency: { probability: 0.95 },
		finalize_scope: { probability: 0.95 },
		topic_3: { probability: 0.95 },
		execution_evidence: { probability: 0.95 },
		code_evidence: { probability: 0.95 },
		topic_1_execution: { label: "evidence_1", confidence: 0.95 },
		topic_1_code: { label: "evidence_2", confidence: 0.95 },
		topic_2_execution: { label: "evidence_1", confidence: 0.95 },
		topic_2_code: { label: "evidence_2", confidence: 0.95 },
		topic_3_execution: { label: "evidence_1", confidence: 0.95 },
		topic_3_code: { label: "evidence_2", confidence: 0.95 },
		review: { label: "defect", confidence: 0.9 },
		acceptance: question => ({
			label: question.options?.["business_gap"] === undefined ? "sound_for_next_change" : "business_gap",
			confidence: 0.9,
		}),
	};
	const fake = answeringJudge(table);
	let judgeCalls = 0;
	const judge: Judge = async (state, questions) => {
		judgeCalls += 1;
		const outcome = await fake.judge(state, questions);
		addEvidence(judgeLog, { call: judgeCalls, questions, state, outcome, injected: true });
		return outcome;
	};
	const { pi, ctx } = await controllerFor(judge, workspace, artifactsDir, "live-smoke-diagnostics");
	await pi.emit("session_start", {}, ctx);
	await pi.emit("before_agent_start", { prompt: scenario.request }, ctx);
	assertCommandSurface(pi);

	await runPlanning(scenario, pi, ctx, log);

	const output = await runImplementationCommand(scenario, pi, ctx, workspace, log);

	// Negative developer review: typed defect, recorded as a failed diagnostic. This deliberately
	// starts while the last background action diagnostic may still be in flight, so a diagnostic
	// finding must not invalidate this judgment; a stale result here is a source regression.
	const review = await callTool(pi, ctx, "jev_review", {
		kind: "diff",
		target: "src/slug.ts",
		claim: "The slug helper normalizes separators.",
		evidence: [
			{ kind: "code", quote: 'replace(/[^a-z0-9]+/g, "-")', source: "src/slug.ts" },
			{ kind: "execution", quote: `$ ${scenario.implementation?.command.join(" ")}\n${output}`, source: "smoke workspace" },
		],
	}, log);
	if (review.details["approved"] !== false || review.details["kind"] !== "defect") {
		throw new Error(`the injected negative review was not recorded as a defect: ${review.text}`);
	}

	// Negative business acceptance: the call still returns and records approved:false.
	const acceptance = await runAcceptance(scenario, pi, ctx, output, log);
	if (acceptance["business"] !== false) throw new Error("the injected business gap was not recorded as not approved");

	// A write after the negative verdict and acceptance must execute normally.
	await performWrite(pi, ctx, workspace, { path: "src/after-negative.ts", content: "export const continued = true;\n" }, log);
	if (!existsSync(join(workspace, "src/after-negative.ts"))) throw new Error("the write after a negative verdict did not execute");

	const stop = await pi.emit("session_stop", {}, ctx);
	if (stopDecision(stop) !== undefined) throw new Error("the addon held completion after a negative verdict");
	const status = await statusTextOf(pi, ctx);
	assertStatusTruth(status, "negative");
	if ((parseCount(status, "failed", "Checks") ?? 0) < 2) throw new Error(`the negative diagnostics were not counted as failed: ${status}`);
	const negative = expectDiagnosticShape("jev_context", (await callTool(pi, ctx, "jev_context", { action: "list" }, log)).details);

	// A local recovery consultation is not a current mechanism and costs no judge call.
	const beforeRecovery = judgeCalls;
	const recovery = await callTool(pi, ctx, "jev_consult", {
		mode: "recovery",
		recovery: { phase: "repair", findingId: "f", diagnosis: "d", correction: "c", nextAction: { tool: "write", input: {} } },
		evidence: [{ kind: "execution", quote: "observed", source: "smoke" }],
	}, log);
	if (!recovery.failed || judgeCalls !== beforeRecovery) throw new Error("a recovery consultation reached the judge or was not refused locally");
	addEvidence(log, { kind: "assertion", name: "recovery-consultation-removed", pass: true });

	// Outage path: a separate controller cannot reach the judge, yet work and completion continue.
	const outageWorkspace = mkdtempSync(join(tmpdir(), "jev-smoke-outage-"));
	const outageArtifacts = mkdtempSync(join(tmpdir(), "jev-smoke-outage-artifacts-"));
	const outage = await controllerFor(failingJudge("injected judge outage", "unavailable"), outageWorkspace, outageArtifacts, "live-smoke-outage");
	await outage.pi.emit("session_start", {}, outage.ctx);
	const consult = await callTool(outage.pi, outage.ctx, "jev_consult", {
		mode: "boolean",
		question: "Does the submitted report match the observed coverage?",
		context: "The report contains the coverage observed in the test run.",
		trueMeaning: "The report matches the observation.",
		falseMeaning: "The report does not match the observation.",
	}, log);
	if (consult.failed || consult.details["kind"] !== "unavailable" || consult.details["approved"] !== false) {
		throw new Error("the injected outage did not produce an advisory unavailable judgment");
	}
	await performWrite(outage.pi, outage.ctx, outageWorkspace, { path: "after-outage.ts", content: "export const continued = true;\n" }, log);
	if (!existsSync(join(outageWorkspace, "after-outage.ts"))) throw new Error("the write after an outage did not execute");
	if (stopDecision(await outage.pi.emit("session_stop", {}, outage.ctx)) !== undefined) throw new Error("the addon held completion after an outage");
	const outageStatus = await statusTextOf(outage.pi, outage.ctx);
	assertStatusTruth(outageStatus, "outage");
	if ((parseCount(outageStatus, "unavailable", "Checks") ?? 0) < 1) throw new Error(`the outage was not counted as unavailable: ${outageStatus}`);
	const outageDiagnostics = expectDiagnosticShape("jev_context", (await callTool(outage.pi, outage.ctx, "jev_context", { action: "list" }, log)).details);
	addEvidence(log, { kind: "assertion", name: "continued-work-after-negative-and-outage", pass: true });

	return { judgeCalls, negative, outage: outageDiagnostics };
}

interface HostEvent {
	type?: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	[key: string]: unknown;
}

function eventText(event: HostEvent): string {
	if (typeof event.result === "string") return event.result;
	const result = asRecord(event.result);
	const content = result?.["content"];
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			const record = asRecord(block);
			const text = record?.["text"];
			if (typeof text === "string") parts.push(text);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	const text = result?.["text"];
	return typeof text === "string" ? text : JSON.stringify(event.result ?? "");
}

function eventDetails(event: HostEvent): Record<string, unknown> {
	return asRecord(asRecord(event.result)?.["details"]) ?? {};
}

function parseHostEvents(raw: string): HostEvent[] {
	const events: HostEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed = asRecord(JSON.parse(trimmed));
			if (parsed !== undefined) events.push(parsed as HostEvent);
		} catch {
			// Print mode may add a human line; it is kept in the saved output, not parsed.
		}
	}
	return events;
}

/** The exact autonomous prompt; a pre-plan write is expected to execute, not to be refused. */
export function hostPrompt(scenario: Scenario): string {
	if (scenario.implementation === undefined) {
		return `You are the executor in a Jevstice live smoke. There is no human: never ask for confirmation and never wait for a reply. Work autonomously in this empty project.

1. First write the file '${scenario.probePath}' with content 'probe'. The write is expected to execute; read the result and continue. Jev results are diagnostics, never permission.
2. Call jev_triage with request ${JSON.stringify(scenario.request)} and topics ${JSON.stringify(scenario.topics)}.
3. Call jev_requirements with the same request and these items: ${JSON.stringify(scenario.requirements)}. candidateNeeds may be [].
4. Call jev_plan_review with phase "outline" and these steps: ${JSON.stringify(scenario.steps.map(step => ({ id: step.id, summary: step.summary, requirement: step.requirement })))}. Include evidence [{"kind":"spec","quote":${JSON.stringify(scenario.request)},"source":"smoke prompt"}].
5. Write the session artifact local://${scenario.artifactName} with exactly this content:
${scenario.artifact}
6. Call jev_plan_review once per step with phase "detail", plan "local://${scenario.artifactName}", topic {id, section, paths, requirement} where section is the exact artifact section for that id, plus the same spec evidence item.
7. Call jev_plan_review with phase "finalize", plan "local://${scenario.artifactName}", and the same spec evidence item.
8. Do not create or modify any project file beyond the probe write in step 1, do not implement the game, and do not call acceptance. Stop immediately after the final plan review.`;
	}
	const firstPath = Object.keys(scenario.implementation.files)[0] ?? "";
	const fileBlocks = Object.entries(scenario.implementation.files)
		.map(([path, content]) => `--- ${path} ---\n${content}--- end ${path} ---`)
		.join("\n");
	return `You are the executor in a Jevstice live smoke. There is no human: never ask for confirmation and never wait for a reply. Work autonomously in this empty project.

1. First write the file '${scenario.probePath}' with content 'probe'. The write is expected to execute; read the result and continue. Jev results are diagnostics, never permission.
2. Call jev_triage with request ${JSON.stringify(scenario.request)} and topics ${JSON.stringify(scenario.topics)}.
3. Call jev_requirements with the same request and these items: ${JSON.stringify(scenario.requirements)}. candidateNeeds may be [].
4. Call jev_plan_review with phase "outline" and these steps: ${JSON.stringify(scenario.steps.map(step => ({ id: step.id, summary: step.summary, requirement: step.requirement })))}. Include evidence [{"kind":"spec","quote":${JSON.stringify(scenario.request)},"source":"smoke prompt"}].
5. Write the session artifact local://${scenario.artifactName} with exactly this content:
${scenario.artifact}
6. Call jev_plan_review once per step with phase "detail", plan "local://${scenario.artifactName}", topic {id, section, paths, requirement} where section is the exact artifact section for that id, plus the same spec evidence item.
7. Call jev_plan_review with phase "finalize", plan "local://${scenario.artifactName}", and the same spec evidence item.
8. After the plan review calls, write these exact files:
${fileBlocks}
Run '${scenario.implementation.command.join(" ")}' and read its output.
9. Call jev_acceptance for aspect "business" with claim ${JSON.stringify(scenario.implementation.claims.business)} and for aspect "architecture" with claim ${JSON.stringify(scenario.implementation.claims.architecture)}. Each call's evidence must contain {"kind":"execution","quote":"$ ${scenario.implementation.command.join(" ")} and the command output"} and {"kind":"code","quote":"the contents of ${firstPath} shown above"}.
10. Stop. Do not ask any question.`;
}

/**
 * The host can route an extension tool through the `write xd://...` device. That call's result then
 * carries the logical tool, its parsed arguments and its inner details under `details.xdev`. Expose
 * that consumer-visible wrapper as the logical tool event so verification sees `jev_*` calls.
 */
export function normalizeHostEvent(event: HostEvent): HostEvent {
	if (event.type !== "tool_execution_end") return event;
	const xdev = asRecord(eventDetails(event)["xdev"]);
	if (xdev === undefined || typeof xdev["tool"] !== "string") return event;
	const inner = asRecord(xdev["inner"]);
	const outer = asRecord(event.result) ?? {};
	return {
		...event,
		toolName: xdev["tool"],
		args: xdev["args"],
		result: { ...outer, details: inner ?? {} },
	};
}

export function normalizeHostEvents(events: HostEvent[]): HostEvent[] {
	const normalized: HostEvent[] = [];
	for (const event of events) {
		normalized.push(normalizeHostEvent(event));
		if (event.type !== "tool_execution_end" || event.toolName !== "bash") continue;
		const commands = eventDetails(event)["toolCommands"];
		if (!Array.isArray(commands)) continue;
		for (const value of commands) {
			const receipt = asRecord(value);
			const tool = receipt?.["tool"];
			if (typeof tool !== "string" || !tool.startsWith("jev_") || receipt?.["mode"] !== "execute") continue;
			normalized.push({
				...event,
				toolName: tool,
				args: receipt["args"],
				isError: receipt["exitCode"] !== 0,
				result: { ...asRecord(event.result), details: asRecord(receipt["inner"]) ?? {} },
			});
		}
	}
	return normalized;
}

/**
 * Verify a saved host event stream against the diagnostic contract. Exported for offline checks
 * and for the focused tests; it makes no network call.
 */
export function verifyHost(scenario: Scenario, rawEvents: HostEvent[]): { pass: boolean; problems: string[] } {
	const events = normalizeHostEvents(rawEvents);
	const problems: string[] = [];
	const ends = events.filter(event => event.type === "tool_execution_end");
	const starts = events.filter(event => event.type === "tool_execution_start");
	const argsById = new Map<string, unknown>();
	for (const start of starts) if (typeof start.toolCallId === "string") argsById.set(start.toolCallId, start.args);
	const argsOf = (event: HostEvent): Record<string, unknown> | undefined =>
		asRecord(event.args) ?? (typeof event.toolCallId === "string" ? asRecord(argsById.get(event.toolCallId)) : undefined);

	const jevEnds = ends.filter(event => typeof event.toolName === "string" && event.toolName.startsWith("jev_"));
	if (jevEnds.length === 0) {
		problems.push("no jev_* tool executed: the extension was not loaded or never exercised");
		return { pass: false, problems };
	}

	const finalizeIndex = ends.findIndex(
		event => event.toolName === "jev_plan_review" && eventDetails(event)["planDigest"] !== undefined,
	);
	const planApprovedEnd = finalizeIndex >= 0 ? ends[finalizeIndex] : undefined;
	if (planApprovedEnd === undefined) problems.push("jev_plan_review never returned details.planDigest");

	const finalizeEventIndex = planApprovedEnd === undefined ? -1 : events.indexOf(planApprovedEnd);
	const probeWrite = ends.find(event => {
		if (event.toolName !== "write" || argsOf(event)?.["path"] !== scenario.probePath) return false;
		const index = events.indexOf(event);
		return finalizeEventIndex < 0 || index < finalizeEventIndex;
	});
	if (probeWrite === undefined) {
		problems.push(`the pre-plan write to '${scenario.probePath}' never executed`);
	} else if (probeWrite.isError === true) {
		problems.push(`the pre-plan write to '${scenario.probePath}' failed: ${eventText(probeWrite).slice(0, 300)}`);
	}

	const triageAttempts = ends.filter(event => event.toolName === "jev_triage");
	const lastTriage = triageAttempts.at(-1);
	if (lastTriage === undefined) problems.push("jev_triage did not run");
	else if (!triageAttempts.some(event => eventDetails(event)["needsDevelopment"] === true)) {
		problems.push(`jev_triage details.needsDevelopment was never true: ${eventText(lastTriage).slice(0, 300)}`);
	}

	const requirementsAttempts = ends.filter(event => event.toolName === "jev_requirements");
	if (requirementsAttempts.length === 0) problems.push("jev_requirements did not run");

	for (const jevEnd of jevEnds) {
		const label = `${String(jevEnd.toolName)} result`;
		problems.push(...diagnosticProblems(label, eventDetails(jevEnd)));
	}
	const lastJev = jevEnds.at(-1);
	const lastDiagnostics = lastJev === undefined ? undefined : diagnosticsOf(eventDetails(lastJev));
	const negativeRecorded = jevEnds.some(event => {
		const details = eventDetails(event);
		return event.isError === true || details["approved"] === false || details["verdict"] === "revise" || details["kind"] === "defect";
	});
	if (negativeRecorded && (lastDiagnostics?.checks.failed ?? 0) < 1) {
		problems.push("a negative Jev verdict was observed but the recorded checks.failed count stayed zero");
	}

	if (scenario.implementation === undefined) {
		const writes = ends.filter(
			event =>
				(event.toolName === "write" || event.toolName === "edit") &&
				event.isError !== true &&
				typeof argsOf(event)?.["path"] === "string",
		);
		for (const write of writes) {
			const path = String(argsOf(write)?.["path"] ?? "");
			if (!path.startsWith("local://") && !path.startsWith("xd://") && !path.startsWith("agent://") && !path.startsWith("proc://") && path !== scenario.probePath) {
				problems.push(`planning-only scenario wrote a project file: ${path}`);
			}
		}
	} else {
		const wroteModule = ends.find(
			event =>
				event.toolName === "write" &&
				argsOf(event)?.["path"] === "src/slug.ts" &&
				event.isError !== true &&
				(finalizeEventIndex < 0 || events.indexOf(event) > finalizeEventIndex),
		);
		if (wroteModule === undefined) problems.push("the workflow never wrote src/slug.ts after the plan review");
		const testRun = ends.find(event => {
			const command = argsOf(event)?.["command"];
			return event.toolName === "bash" && typeof command === "string" && command.includes("bun test");
		});
		if (testRun === undefined) problems.push("the workflow never ran the bun test command");
		else if (testRun.isError === true) problems.push("the bun test command failed");
		const acceptedRevisions: number[] = [];
		for (const aspect of ["business", "architecture"]) {
			const attempts = ends.filter(event => event.toolName === "jev_acceptance" && argsOf(event)?.["aspect"] === aspect);
			const last = attempts[attempts.length - 1];
			if (last === undefined) {
				problems.push(`jev_acceptance did not run for ${aspect}`);
				continue;
			}
			const details = eventDetails(last);
			if (typeof details["approved"] !== "boolean") problems.push(`${aspect} acceptance returned no typed approved verdict: ${eventText(last).slice(0, 300)}`);
			if (typeof details["revision"] === "number") acceptedRevisions.push(details["revision"]);
		}
		if (acceptedRevisions.length === 2 && acceptedRevisions[0] !== acceptedRevisions[1]) {
			problems.push(`acceptance aspects were recorded at different revisions: ${acceptedRevisions.join(" and ")}`);
		}
	}
	return { pass: problems.length === 0, problems };
}

/** Revalidate one saved host run without a model, judge or network call. */
export function verifyExistingHostRun(
	dir: string,
	scenarioName: string,
): { scenario: string; events: number; pass: boolean; problems: string[] } {
	const scenario = scenarioOf(scenarioName);
	const events = parseHostEvents(readFileSync(join(dir, "omp-events.jsonl"), "utf8"));
	const verdict = verifyHost(scenario, events);
	return { scenario: scenario.name, events: events.length, ...verdict };
}

async function host(scenario: Scenario, dir: string, model: string | undefined, maxTime: number): Promise<void> {
	const workspace = mkdtempSync(join(tmpdir(), "jev-smoke-host-"));
	const extension = join(import.meta.dir, "..", "src", "index.ts");
	const args = [
		"omp",
		"-p",
		"--no-extensions",
		"-e",
		extension,
		"--mode=json",
		"--no-skills",
		"--no-rules",
		"--no-context-files",
		"--auto-approve",
		"--max-time",
		String(maxTime),
	];
	if (model !== undefined) args.push("--model", model);
	args.push("--append-system-prompt", hostPrompt(scenario), scenario.request);

	const proc = Bun.spawn({ cmd: args, cwd: workspace, env: process.env, stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	// The CLI has its own --max-time; this external kill also bounds a hung provider or tool loop.
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, (maxTime + 60) * 1000);
	let stdout = "";
	let stderr = "";
	let exitCode = 0;
	try {
		[stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
	} finally {
		clearTimeout(timer);
	}
	writeFileSync(join(dir, "omp-events.jsonl"), stdout, "utf8");
	writeFileSync(join(dir, "omp-stderr.txt"), stderr, "utf8");
	writeFileSync(join(dir, "prompt.txt"), `${hostPrompt(scenario)}\n\n--- user request ---\n${scenario.request}\n`, "utf8");
	if (timedOut) throw new Error(`omp exceeded ${maxTime + 60}s and was killed`);

	const events = parseHostEvents(stdout);
	const verdict = verifyHost(scenario, events);
	if (exitCode !== 0) {
		verdict.problems.push(`omp exited with code ${exitCode}`);
		verdict.pass = false;
	}
	writeJson(join(dir, "summary.json"), {
		mode: "host",
		scenario: scenario.name,
		exitCode,
		events: events.length,
		pass: verdict.pass,
		problems: verdict.problems,
		evidence: dir,
	});
	if (!verdict.pass) {
		throw new Error(`host smoke failed:\n- ${verdict.problems.join("\n- ")}\nEvidence: ${dir}`);
	}
}

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));
	if (options.mode !== "direct" && options.mode !== "host" && options.mode !== "verify-existing") {
		throw new Error("usage: bun tools/live-smoke.ts <direct|host|verify-existing> [--scenario workflow|factorio|diagnostics] [--out DIR] [--model NAME] [--max-time SECONDS]");
	}
	if (options.scenario === "diagnostics" && options.mode !== "direct") {
		throw new Error("the diagnostics scenario uses an injected judge and requires direct mode");
	}
	const dir = outputDir(options.out);
	try {
		if (options.mode === "verify-existing") {
			if (options.out === undefined) throw new Error("usage: bun tools/live-smoke.ts verify-existing --out DIR [--scenario workflow|factorio]");
			const result = verifyExistingHostRun(options.out, options.scenario);
			console.log(JSON.stringify(result, null, 2));
			process.exitCode = result.pass ? 0 : 1;
			return;
		}
		if (options.mode === "direct") {
			if (options.scenario === "diagnostics") {
				const stats = await diagnosticsScenario(dir);
				writeJson(join(dir, "summary.json"), {
					mode: "direct",
					scenario: "diagnostics",
					judge: "injected",
					pass: true,
					judgeCalls: stats.judgeCalls,
					diagnostics: { negative: stats.negative, outage: stats.outage },
					evidence: dir,
				});
				console.log(`PASS direct diagnostics: negative verdict and outage stayed truthful while work continued. Evidence: ${dir}`);
				return;
			}
			const scenario = scenarioOf(options.scenario);
			const stats = await direct(scenario, dir);
			writeJson(join(dir, "summary.json"), {
				mode: "direct",
				scenario: scenario.name,
				judge: "production",
				pass: true,
				planningOnly: scenario.implementation === undefined,
				judgeCalls: stats.judgeCalls,
				diagnostics: stats.diagnostics,
				acceptance: stats.acceptance,
				evidence: dir,
			});
			console.log(`PASS direct ${scenario.name}: typed results recorded; work and completion proceeded. Evidence: ${dir}`);
			return;
		}
		const scenario = scenarioOf(options.scenario);
		await host(scenario, dir, options.model, options.maxTime);
		console.log(`PASS host ${scenario.name}: native calls executed and diagnostics were recorded. Evidence: ${dir}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeJson(join(dir, "summary.json"), {
			mode: options.mode,
			scenario: options.scenario,
			pass: false,
			error: message,
			evidence: dir,
		});
		console.error(`FAIL ${options.mode} ${options.scenario}: ${message}\nEvidence: ${dir}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
