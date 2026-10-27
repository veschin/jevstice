#!/usr/bin/env bun
/**
 * One live smoke entry for the current Jevstice workflow.
 *
 * `direct` builds the real controller over `createTypeSafeJudge`, drives the registered tools and
 * gate events through the same fake-host seams the tests use, and records every judge question,
 * answer, tool outcome and plan artifact. `host` launches the real omp CLI with the extension
 * loaded (`-e src/index.ts`) and verifies the tool calls it produced.
 *
 * Neither mode retries a refused stage: a refusal is evidence, not a pass. The old measurement and
 * review harnesses imported deleted modules; this is the live verification that replaced them.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoizedApiKeyResolver } from "../src/apikey.js";
import { loadJevConfig } from "../src/config.js";
import { createJevController } from "../src/controller.js";
import { createTypeSafeJudge, type Judge } from "../src/judge.js";
import { asRecord, type Evidence } from "../src/types.js";
import {
	blockReason,
	fakeCtx,
	fakePi,
	fakeZod,
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

function scenarioOf(name: string): Scenario {
	if (name === "workflow") return workflowScenario();
	if (name === "factorio") return factorioScenario();
	throw new Error(`unknown scenario '${name}' (expected workflow or factorio)`);
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
	blocked?: string;
	text: string;
	details: Record<string, unknown>;
	failed: boolean;
}

function planEvidence(scenario: Scenario, quote: string): Evidence[] {
	return [{ kind: "documentation", quote, source: `local://${scenario.artifactName}` }];
}

async function direct(scenario: Scenario, dir: string): Promise<{ judgeCalls: number }> {
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

	mkdirSync(join(workspace, ".omp"), { recursive: true });
	writeFileSync(
		join(workspace, ".omp", "jev.config.json"),
		readFileSync(join(import.meta.dir, "armed.jev.config.json"), "utf8"),
		"utf8",
	);
	const tempHome = join(workspace, "home");
	mkdirSync(tempHome, { recursive: true });
	const config = loadJevConfig({ cwd: workspace, home: tempHome });
	const expectConfig = config.problems.length === 0 && config.courseCheck.mode === "interval" && config.courseCheck.interval === 1;
	if (!expectConfig) throw new Error(`the armed fixture did not load cleanly: ${config.problems.join("; ")}`);
	const pi = fakePi();
	createJevController({ judge, config, zod: fakeZod() }).register(pi.api);
	const ctx = fakeCtx({ artifactsDir, sessionId: "live-smoke" });

	const call = async (name: string, params: unknown): Promise<ToolReply> => {
		const gate = await pi.emit("tool_call", toolCallEvent(name, params), ctx);
		const blocked = blockReason(gate);
		if (blocked !== undefined) {
			addEvidence(log, { kind: "tool_call", name, params, blocked });
			return { blocked, text: blocked, details: {}, failed: true };
		}
		const result = await pi.callTool(name, params, ctx);
		const text = toolText(result);
		const details = toolDetails(result);
		const failed = toolFailed(result);
		await pi.emit("tool_result", toolResultEvent(name, params, text, failed), ctx);
		addEvidence(log, { kind: "tool", name, params, text, details, failed });
		return { blocked: undefined, text, details, failed };
	};

	const expect = (condition: unknown, message: string): void => {
		if (!condition) throw new Error(message);
	};

	const waitForCourseCheck = async (before: number, required: boolean): Promise<void> => {
		const seen = await until(
			() => pi.messages.slice(before).some(message => message.customType === "jev.course_check"),
			20000,
		);
		expect(!required || seen, "the interval course check did not run");
		// The check clears its in-flight flag after it sends the message.
		await Bun.sleep(50);
		for (const message of pi.messages.slice(before)) {
			if (message.customType !== "jev.course_check") continue;
			addEvidence(log, { kind: "course_check", text: message.content });
			expect(
				!message.content.includes("Consequential changes are held") && !message.content.includes("could not be answered"),
				`the course check refused: ${message.content}`,
			);
		}
	};

	await pi.emit("session_start", {}, ctx);
	await pi.emit("before_agent_start", { prompt: scenario.request }, ctx);

	const probeInput = {
		path: scenario.probePath,
		content: scenario.implementation?.files[scenario.probePath] ?? "probe\n",
	};
	const beforeTriage = await pi.emit("tool_call", toolCallEvent("write", probeInput), ctx);
	const triageRefusal = blockReason(beforeTriage);
	expect(triageRefusal !== undefined, "the mutation gate did not hold the first project write before triage");
	addEvidence(log, { kind: "gate", stage: "before-triage", path: scenario.probePath, reason: triageRefusal });

	const triage = await call("jev_triage", { request: scenario.request, topics: scenario.topics });
	expect(
		triage.details["needsDevelopment"] === true || triage.text.includes("development task registered"),
		`triage did not register a development task: ${triage.text}`,
	);

	const beforePlan = await pi.emit("tool_call", toolCallEvent("write", probeInput), ctx);
	const planRefusal = blockReason(beforePlan);
	expect(planRefusal !== undefined, "the mutation gate did not hold a project write after triage and before the plan approval");
	addEvidence(log, { kind: "gate", stage: "before-plan", path: scenario.probePath, reason: planRefusal });

	const requirements = await call("jev_requirements", {
		request: scenario.request,
		items: scenario.requirements,
		candidateNeeds: [],
	});
	expect(requirements.details["approved"] === true, `requirements were not approved: ${requirements.text}`);

	const outline = await call("jev_plan_review", {
		phase: "outline",
		steps: scenario.steps.map(step => ({ id: step.id, summary: step.summary, requirement: step.requirement })),
		evidence: planEvidence(scenario, sectionOf(scenario.artifact, scenario.steps[0]?.id ?? "")),
	});
	const outlineVerdict = outline.details["verdict"];
	expect(
		outline.details["phase"] === "detail" ||
			outlineVerdict === "serves" ||
			(typeof outlineVerdict === "string" && outlineVerdict !== "revise" && outlineVerdict !== "unsupported"),
		`the outline was not approved: ${outline.text}`,
	);

	for (const step of scenario.steps) {
		const section = sectionOf(scenario.artifact, step.id);
		const detail = await call("jev_plan_review", {
			phase: "detail",
			plan: `local://${scenario.artifactName}`,
			topic: { id: step.id, section, paths: step.paths, requirement: step.requirement },
			evidence: planEvidence(scenario, section),
		});
		const detailVerdict = detail.details["verdict"];
		expect(
			!detail.failed &&
				(typeof detailVerdict !== "string" ||
					!["revise", "missing_operation", "missing_check", "scope_expansion", "conflict", "unclear"].includes(detailVerdict)),
			`detail for '${step.id}' was not approved: ${detail.text}`,
		);
	}

	const finalize = await call("jev_plan_review", {
		phase: "finalize",
		plan: `local://${scenario.artifactName}`,
		evidence: planEvidence(scenario, scenario.artifact),
	});
	expect(
		typeof finalize.details["planDigest"] === "string" || finalize.text.includes("plan approved"),
		`the final plan was not approved: ${finalize.text}`,
	);
	addEvidence(log, { kind: "stage", name: "plan", status: "approved" });

	if (scenario.implementation === undefined) {
		// Planning-only: the approved plan is the deliverable. No game file is written, no acceptance
		// is claimed, and the probe ends without asserting completion.
		addEvidence(log, { kind: "stage", name: "planning", status: "plan approved; implementation intentionally not performed" });
		return { judgeCalls };
	}

	for (const [path, content] of Object.entries(scenario.implementation.files)) {
		const writeInput = { path, content };
		const gate = await pi.emit("tool_call", toolCallEvent("write", writeInput), ctx);
		const blocked = blockReason(gate);
		expect(blocked === undefined, `the approved plan did not release '${path}': ${blocked}`);
		const absolute = join(workspace, path);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, content, "utf8");
		const before = pi.messages.length;
		await pi.emit("tool_result", toolResultEvent("write", writeInput, `wrote ${content.length} bytes`), ctx);
		await waitForCourseCheck(before, true);
	}

	const command = scenario.implementation.command;
	const commandText = command.join(" ");
	const commandGate = await pi.emit("tool_call", toolCallEvent("bash", { command: commandText }), ctx);
	const commandBlocked = blockReason(commandGate);
	expect(commandBlocked === undefined, `the approved plan did not release '${commandText}': ${commandBlocked}`);
	const run = spawnSync(command[0] ?? "bun", command.slice(1), { cwd: workspace, encoding: "utf8" });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "").trim();
	expect(run.status === 0, `the implementation command failed (${String(run.status)}): ${output}`);
	const beforeCommand = pi.messages.length;
	await pi.emit("tool_result", toolResultEvent("bash", { command: commandText }, output.slice(0, 4000)), ctx);
	await waitForCourseCheck(beforeCommand, false);

	mkdirSync(join(dir, "workspace"), { recursive: true });
	for (const [path, content] of Object.entries(scenario.implementation.files)) {
		const target = join(dir, "workspace", path);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
	writeFileSync(join(dir, "workspace", "command-output.txt"), output, "utf8");

	const codeQuote = Object.entries(scenario.implementation.files)
		.map(([path, content]) => `${path}\n${content}`)
		.join("\n\n");
	const evidence: Evidence[] = [
		{ kind: "execution", quote: `$ ${commandText}\n${output}`, source: "smoke workspace" },
		{ kind: "code", quote: codeQuote, source: "written files" },
	];
	for (const aspect of ["business", "architecture"] as const) {
		const acceptance = await call("jev_acceptance", {
			aspect,
			claim: scenario.implementation.claims[aspect],
			evidence,
		});
		expect(
			acceptance.details["approved"] === true,
			`${aspect} acceptance was not approved: ${acceptance.text}`,
		);
		addEvidence(log, { kind: "stage", name: `acceptance:${aspect}`, status: "approved" });
	}

	const stop = await pi.emit("session_stop", {}, ctx);
	const decision = stopDecision(stop);
	expect(decision === undefined, `the completion boundary held the finished work: ${decision}`);
	addEvidence(log, { kind: "stage", name: "completion", status: "settled" });
	return { judgeCalls };
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

function hostPrompt(scenario: Scenario): string {
	if (scenario.implementation === undefined) {
		return `You are the executor in a Jevstice live smoke. There is no human: never ask for confirmation and never wait for a reply. Work autonomously in this empty project.

1. First attempt to write the file '${scenario.probePath}' with content 'probe'. The extension must refuse it because no request has been triaged. Continue after reading the refusal.
2. Call jev_triage with request ${JSON.stringify(scenario.request)} and topics ${JSON.stringify(scenario.topics)}.
3. Call jev_requirements with the same request and these items: ${JSON.stringify(scenario.requirements)}. candidateNeeds may be [].
4. Call jev_plan_review with phase "outline" and these steps: ${JSON.stringify(scenario.steps.map(step => ({ id: step.id, summary: step.summary, requirement: step.requirement })))}. Include evidence [{"kind":"spec","quote":${JSON.stringify(scenario.request)},"source":"smoke prompt"}].
5. Write the session artifact local://${scenario.artifactName} with exactly this content:
${scenario.artifact}
6. Call jev_plan_review once per step with phase "detail", plan "local://${scenario.artifactName}", topic {id, section, paths, requirement} where section is the exact artifact section for that id, plus the same spec evidence item.
7. Call jev_plan_review with phase "finalize", plan "local://${scenario.artifactName}", and the same spec evidence item.
8. Do not create or modify any project file, do not implement the game, and do not call acceptance. Stop immediately after the final plan approval.`;
	}
	const firstPath = Object.keys(scenario.implementation.files)[0] ?? "";
	const fileBlocks = Object.entries(scenario.implementation.files)
		.map(([path, content]) => `--- ${path} ---\n${content}--- end ${path} ---`)
		.join("\n");
	return `You are the executor in a Jevstice live smoke. There is no human: never ask for confirmation and never wait for a reply. Work autonomously in this empty project.

1. First attempt to write the file '${scenario.probePath}' with content 'probe'. The extension must refuse it because no request has been triaged. Continue after reading the refusal.
2. Call jev_triage with request ${JSON.stringify(scenario.request)} and topics ${JSON.stringify(scenario.topics)}.
3. Call jev_requirements with the same request and these items: ${JSON.stringify(scenario.requirements)}. candidateNeeds may be [].
4. Call jev_plan_review with phase "outline" and these steps: ${JSON.stringify(scenario.steps.map(step => ({ id: step.id, summary: step.summary, requirement: step.requirement })))}. Include evidence [{"kind":"spec","quote":${JSON.stringify(scenario.request)},"source":"smoke prompt"}].
5. Write the session artifact local://${scenario.artifactName} with exactly this content:
${scenario.artifact}
6. Call jev_plan_review once per step with phase "detail", plan "local://${scenario.artifactName}", topic {id, section, paths, requirement} where section is the exact artifact section for that id, plus the same spec evidence item.
7. Call jev_plan_review with phase "finalize", plan "local://${scenario.artifactName}", and the same spec evidence item.
8. After the final approval, write these exact files:
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
	return events.map(normalizeHostEvent);
}

function customOutcomeMessages(events: HostEvent[]): { customType: string; content: string }[] {
	const outcomes: { customType: string; content: string }[] = [];
	for (const event of events) {
		if (event.type !== "message_end") continue;
		const message = asRecord(event["message"]);
		if (message?.["role"] !== "custom") continue;
		outcomes.push({
			customType: typeof message["customType"] === "string" ? message["customType"] : "",
			content: typeof message["content"] === "string" ? message["content"] : "",
		});
	}
	return outcomes;
}

function verifyHost(scenario: Scenario, rawEvents: HostEvent[]): { pass: boolean; problems: string[] } {
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
	const probeBlocked = ends.some(event => {
		if (event.toolName !== "write" || event.isError !== true) return false;
		if (argsOf(event)?.["path"] !== scenario.probePath) return false;
		const index = events.indexOf(event);
		return finalizeEventIndex < 0 || index < finalizeEventIndex;
	});
	if (!probeBlocked) {
		problems.push(`the pre-plan write to '${scenario.probePath}' was not refused: the mutation gate was not exercised`);
	}

	const triageAttempts = ends.filter(event => event.toolName === "jev_triage");
	if (triageAttempts.length === 0) problems.push("jev_triage did not run");
	else if (!triageAttempts.some(event => eventDetails(event)["needsDevelopment"] === true)) {
		problems.push(`jev_triage details.needsDevelopment was never true: ${eventText(triageAttempts[triageAttempts.length - 1]).slice(0, 300)}`);
	}

	const requirementsAttempts = ends.filter(event => event.toolName === "jev_requirements");
	if (requirementsAttempts.length === 0) problems.push("jev_requirements did not run");
	else if (!requirementsAttempts.some(event => eventDetails(event)["approved"] === true)) {
		problems.push(`jev_requirements details.approved was never true: ${eventText(requirementsAttempts[requirementsAttempts.length - 1]).slice(0, 300)}`);
	}

	const customs = customOutcomeMessages(events);
	for (const message of customs) {
		if (message.customType === "jev.open_item") {
			problems.push(`the session released a boundary as OPEN: ${message.content.slice(0, 300)}`);
		}
		if (message.customType === "jev.course_check" && message.content.includes("Consequential changes are held")) {
			problems.push(`a course check refused the course: ${message.content.slice(0, 300)}`);
		}
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
			if (!path.startsWith("local://") && !path.startsWith("xd://") && !path.startsWith("agent://") && !path.startsWith("proc://")) {
				problems.push(`planning-only scenario wrote a project file: ${path}`);
			}
		}
	} else {
		const wroteModule = ends.find(
			event =>
				event.toolName === "write" &&
				argsOf(event)?.["path"] === "src/slug.ts" &&
				event.isError !== true,
		);
		if (wroteModule === undefined) problems.push("the workflow never wrote src/slug.ts after the plan approval");
		const testRun = ends.find(event => {
			const command = argsOf(event)?.["command"];
			return event.toolName === "bash" && typeof command === "string" && command.includes("bun test");
		});
		if (testRun === undefined) problems.push("the workflow never ran the bun test command");
		else if (testRun.isError === true) problems.push("the bun test command failed");
		const acceptedRevisions: number[] = [];
		for (const aspect of ["business", "architecture"]) {
			const attempts = ends.filter(
				event => event.toolName === "jev_acceptance" && argsOf(event)?.["aspect"] === aspect,
			);
			const last = attempts[attempts.length - 1];
			if (last === undefined) {
				problems.push(`jev_acceptance did not run for ${aspect}`);
				continue;
			}
			if (last.isError === true || eventDetails(last)["approved"] !== true) {
				problems.push(`${aspect} was not accepted at its last submission: ${eventText(last).slice(0, 300)}`);
				continue;
			}
			const revision = eventDetails(last)["revision"];
			if (typeof revision !== "number") problems.push(`${aspect} acceptance reported no work revision`);
			else acceptedRevisions.push(revision);
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
	mkdirSync(join(workspace, ".omp"), { recursive: true });
	writeFileSync(
		join(workspace, ".omp", "jev.config.json"),
		readFileSync(join(import.meta.dir, "armed.jev.config.json"), "utf8"),
		"utf8",
	);
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
		throw new Error("usage: bun tools/live-smoke.ts <direct|host|verify-existing> [--scenario workflow|factorio] [--out DIR] [--model NAME] [--max-time SECONDS]");
	}
	const scenario = scenarioOf(options.scenario);
	if (options.mode === "verify-existing") {
		if (options.out === undefined) throw new Error("usage: bun tools/live-smoke.ts verify-existing --out DIR [--scenario workflow|factorio]");
		const result = verifyExistingHostRun(options.out, options.scenario);
		console.log(JSON.stringify(result, null, 2));
		process.exitCode = result.pass ? 0 : 1;
		return;
	}
	const dir = outputDir(options.out);
	try {
		if (options.mode === "direct") {
			const stats = await direct(scenario, dir);
			writeJson(join(dir, "summary.json"), {
				mode: "direct",
				scenario: scenario.name,
				pass: true,
				planningOnly: scenario.implementation === undefined,
				judgeCalls: stats.judgeCalls,
				evidence: dir,
			});
			console.log(`PASS direct ${scenario.name}: real Jev flow approved. Evidence: ${dir}`);
			return;
		}
		await host(scenario, dir, options.model, options.maxTime);
		console.log(`PASS host ${scenario.name}: omp loaded and exercised the extension. Evidence: ${dir}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeJson(join(dir, "summary.json"), {
			mode: options.mode,
			scenario: scenario.name,
			pass: false,
			error: message,
			evidence: dir,
		});
		console.error(`FAIL ${options.mode} ${scenario.name}: ${message}\nEvidence: ${dir}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
