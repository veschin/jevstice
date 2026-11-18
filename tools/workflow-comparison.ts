#!/usr/bin/env bun
/**
 * Matched workflow comparison for the Jevstice addon.
 *
 * Runs the same small coding tasks through native `omp` twice: once with the frozen
 * pre-edit working-tree extension and once with the current checkout extension. Every run
 * uses the same model, thinking level, wall cap and prompt in a fresh disposable workspace.
 * Only the `-e <extension>` value differs between arms.
 *
 * Scoring is independent of the model's prose: each task requirement is checked against the
 * files and commands observed in the run workspace. Delivery and diagnostic call counts come
 * from the omp NDJSON event stream. Provider failures are recorded, never replaced with a
 * guessed outcome.
 *
 * Usage:
 *   bun tools/workflow-comparison.ts --arm baseline --out evidence/workflow-comparison/run-...
 *   bun tools/workflow-comparison.ts --arm both --out evidence/workflow-comparison/run-... \
 *     --baseline evidence/workflow-comparison/baseline-...
 *   bun tools/workflow-comparison.ts --summarize evidence/workflow-comparison/run-...
 *
 * The API key is read from `omp token deepseek`, passed only in the child environment and
 * redacted from every saved file. It never appears in command arguments or this runner's stdout.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL = "deepseek/deepseek-flash";
const DEFAULT_THINKING = "low";
const DEFAULT_MAX_TIME = 300;
const DEFAULT_REPEATS = 2;

type Arm = "baseline" | "candidate";

interface RequirementResult {
	id: string;
	text: string;
	pass: boolean;
	observed: string;
}

interface TaskSpec {
	id: string;
	title: string;
	prompt: string;
	requirements: { id: string; text: string }[];
	verify: (workspace: string) => Promise<RequirementResult[]>;
}

interface Options {
	arm: Arm | "both";
	out: string;
	baseline: string;
	candidate: string;
	model: string;
	thinking: string;
	maxTime: number;
	repeats: number;
	tasks: string[];
	summarize?: string;
}

function fail(message: string): never {
	throw new Error(message);
}

function argValue(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`);
	return value;
}

function parseOptions(argv: string[]): Options {
	const latestBaselineFile = join(CHECKOUT, "evidence", "workflow-comparison", "LATEST-BASELINE.txt");
	const baseline = argValue(argv, "--baseline")
		?? (existsSync(latestBaselineFile) ? readFileSync(latestBaselineFile, "utf8").trim() : "");
	const summarize = argValue(argv, "--summarize");
	const arm = (argValue(argv, "--arm") ?? "both") as Arm | "both";
	if (!["baseline", "candidate", "both"].includes(arm)) fail(`unknown --arm ${arm}`);
	const tasks = (argValue(argv, "--tasks") ?? "all").split(",").filter(value => value.length > 0);
	return {
		arm,
		out: resolve(argValue(argv, "--out") ?? join(CHECKOUT, "evidence", "workflow-comparison", `run-${stamp()}`)),
		baseline: baseline === "" ? "" : resolve(baseline),
		candidate: resolve(argValue(argv, "--candidate") ?? CHECKOUT),
		model: argValue(argv, "--model") ?? DEFAULT_MODEL,
		thinking: argValue(argv, "--thinking") ?? DEFAULT_THINKING,
		maxTime: Number(argValue(argv, "--max-time") ?? DEFAULT_MAX_TIME),
		repeats: Number(argValue(argv, "--repeats") ?? DEFAULT_REPEATS),
		tasks,
		summarize: summarize === undefined ? undefined : resolve(summarize),
	};
}

function stamp(): string {
	return new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function decoded(value: string | Uint8Array | undefined): string {
	if (typeof value === "string") return value;
	return value === undefined ? "" : new TextDecoder().decode(value);
}

function textOfMessage(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as Record<string, unknown>)["content"];
	if (!Array.isArray(content)) return "";
	return content
		.filter(part => typeof part === "object" && part !== null && (part as Record<string, unknown>)["type"] === "text")
		.map(part => String((part as Record<string, unknown>)["text"] ?? ""))
		.join("\n")
		.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function redacted(value: string, secret: string | undefined): string {
	let out = value;
	if (secret !== undefined && secret.length > 0) out = out.split(secret).join("<redacted>");
	return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, "<redacted>");
}

/** A path is either a checkout root or the extension file itself. */
function extensionPath(root: string): string {
	if (root === "") fail("no baseline checkout: pass --baseline or create evidence/workflow-comparison/LATEST-BASELINE.txt");
	const stats = statSync(root);
	if (stats.isFile()) return root;
	return join(root, "src", "index.ts");
}

function extensionFingerprint(root: string): { path: string; digest: string; files: string[] } {
	const entry = extensionPath(root);
	const srcDir = dirname(entry);
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			const path = join(dir, name);
			const stats = statSync(path);
			if (stats.isDirectory()) walk(path);
			else if (name.endsWith(".ts") || name.endsWith(".md")) files.push(relative(srcDir, path));
		}
	};
	walk(srcDir);
	const digest = sha256(files.map(file => `${file}\0${readFileSync(join(srcDir, file), "utf8")}`).join("\0"));
	return { path: entry, digest, files };
}

/* ------------------------------------------------------------------ tasks */

function requirement(task: TaskSpec, id: string): { id: string; text: string } {
	const found = task.requirements.find(item => item.id === id);
	if (found === undefined) fail(`task ${task.id} has no requirement ${id}`);
	return found;
}

function result(task: TaskSpec, id: string, pass: boolean, observed: string): RequirementResult {
	return { ...requirement(task, id), pass, observed };
}

function runBunScript(workspace: string, script: string, timeoutMs = 60_000): { exitCode: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync({
		cmd: ["bun", "-e", script],
		cwd: workspace,
		timeout: timeoutMs,
		env: { ...process.env, NO_COLOR: "1" },
	});
	return { exitCode: proc.exitCode ?? -1, stdout: decoded(proc.stdout), stderr: decoded(proc.stderr) };
}

function runBunTest(workspace: string, file: string): { command: string; exitCode: number; output: string; timedOut: boolean } {
	const command = `bun test ${file}`;
	const proc = Bun.spawnSync({
		cmd: ["bun", "test", file],
		cwd: workspace,
		timeout: 90_000,
		env: { ...process.env, NO_COLOR: "1" },
	});
	return {
		command,
		exitCode: proc.exitCode ?? -1,
		output: `${decoded(proc.stdout)}${decoded(proc.stderr)}`.slice(-4_000),
		timedOut: proc.exitedDueToTimeout === true,
	};
}

function moduleProbe(workspace: string, moduleFile: string, expression: string): { ok: boolean; value?: unknown; error?: string } {
	const url = pathToFileURL(join(workspace, moduleFile)).href;
	const script = `
try {
	const mod = await import(${JSON.stringify(url)});
	const fn = mod.mergeRanges ?? mod.slugify ?? mod.default;
	if (typeof fn !== "function") throw new Error("no exported function");
	${expression}
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: String(error && error.stack ? error.stack : error) }));
}
`;
	const run = runBunScript(workspace, script);
	const line = run.stdout.trim().split("\n").at(-1) ?? "";
	try {
		return JSON.parse(line) as { ok: boolean; value?: unknown; error?: string };
	} catch {
		return { ok: false, error: `${run.stderr || run.stdout}`.slice(0, 800) };
	}
}

function workspacesFiles(workspace: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			if (name === "node_modules" || name === ".omp-state" || name.startsWith(".git")) continue;
			const path = join(dir, name);
			const stats = statSync(path);
			if (stats.isDirectory()) walk(path);
			else files.push(relative(workspace, path));
		}
	};
	walk(workspace);
	return files;
}

function copyArtifacts(workspace: string, runDir: string): void {
	const target = join(runDir, "artifacts");
	mkdirSync(target, { recursive: true });
	for (const name of ["src", "tests"]) {
		const path = join(workspace, name);
		if (existsSync(path)) cpSync(path, join(target, name), { recursive: true });
	}
	for (const name of ["package.json", "bun.lock", "README.md"]) {
		const path = join(workspace, name);
		if (existsSync(path) && statSync(path).isFile()) cpSync(path, join(target, name));
	}
}

const SLUG: TaskSpec = {
	id: "slug",
	title: "slugify edge cases",
	prompt: [
		"Create src/slug.ts with `export function slugify(input: string): string`.",
		"It lowercases ASCII letters, replaces each maximal run of characters that are not ASCII letters or digits with one hyphen, and trims leading and trailing hyphens.",
		"Create tests/slug.test.ts with bun:test cases for slugify(\"Hello World\") === \"hello-world\", slugify(\"  A  B  \") === \"a-b\", slugify(\"--Already--Slugged--\") === \"already-slugged\", and slugify(\"\") === \"\".",
		"Run the tests.",
	].join(" "),
	requirements: [
		{ id: "r1", text: "src/slug.ts exports slugify as a function." },
		{ id: "r2", text: "slugify lowercases ASCII letters." },
		{ id: "r3", text: "Each maximal run of non-ASCII-alphanumeric characters becomes one hyphen." },
		{ id: "r4", text: "slugify trims leading and trailing hyphens, including empty output." },
		{ id: "r5", text: "tests/slug.test.ts contains the four requested cases and passes under bun test." },
	],
	verify: async workspace => {
		const file = "src/slug.ts";
		const results: RequirementResult[] = [];
		if (!existsSync(join(workspace, file))) {
			for (const req of SLUG.requirements) results.push(result(SLUG, req.id, false, `${file} is missing; no module assertions ran`));
			return results;
		}
		const probe = moduleProbe(workspace, file, `
	const cases = [
		{ input: "Hello World", expected: "hello-world" },
		{ input: "  A  B  ", expected: "a-b" },
		{ input: "--Already--Slugged--", expected: "already-slugged" },
		{ input: "", expected: "" },
		{ input: "A__-- B!!C", expected: "a-b-c" },
		{ input: "A1 __ B2", expected: "a1-b2" }
	];
	console.log(JSON.stringify({ ok: true, value: cases.map(c => ({ ...c, actual: fn(c.input) })) }));
`);
		if (probe.ok !== true) {
			for (const req of SLUG.requirements.slice(0, 4)) results.push(result(SLUG, req.id, false, `module import/call failed: ${probe.error ?? "unknown"}`));
		} else {
			const values = Array.isArray(probe.value) ? probe.value as { input: string; expected: string; actual: unknown }[] : [];
			const actual = (input: string): unknown => values.find(item => item.input === input)?.actual;
			results.push(result(SLUG, "r1", true, "slugify is exported and callable"));
			results.push(result(SLUG, "r2", actual("Hello World") === "hello-world" && actual("--Already--Slugged--") === "already-slugged", `observed ${JSON.stringify({ hello: actual("Hello World"), already: actual("--Already--Slugged--") })}`));
			results.push(result(SLUG, "r3", actual("A__-- B!!C") === "a-b-c" && actual("A1 __ B2") === "a1-b2", `observed ${JSON.stringify({ punctuation: actual("A__-- B!!C"), digits: actual("A1 __ B2") })}`));
			results.push(result(SLUG, "r4", actual("  A  B  ") === "a-b" && actual("") === "", `observed ${JSON.stringify({ padded: actual("  A  B  "), empty: actual("") })}`));
		}
		const testFile = "tests/slug.test.ts";
		if (!existsSync(join(workspace, testFile))) {
			results.push(result(SLUG, "r5", false, `${testFile} is missing`));
		} else {
			const text = readFileSync(join(workspace, testFile), "utf8");
			const run = runBunTest(workspace, testFile);
			const hasCases = text.includes("Hello World") && text.includes("  A  B  ") && text.includes("slugify");
			results.push(result(SLUG, "r5", hasCases && run.exitCode === 0, `cases=${hasCases}; ${run.command} exit=${run.exitCode}`));
		}
		return results;
	},
};

const RANGES: TaskSpec = {
	id: "ranges",
	title: "mergeRanges edge cases",
	prompt: [
		"Create src/ranges.ts with `export function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]>`.",
		"It returns a new array sorted by start, merging ranges that overlap or touch at an endpoint (for example [1, 2] and [2, 3] become [1, 3]).",
		"It keeps disjoint ranges separate, returns [] for empty input, and throws RangeError when a range has start greater than end.",
		"Create tests/ranges.test.ts with bun:test cases for unsorted overlapping input, touching ranges, a disjoint pair, empty input, and an inverted range.",
		"Run the tests.",
	].join(" "),
	requirements: [
		{ id: "r1", text: "src/ranges.ts exports mergeRanges as a function." },
		{ id: "r2", text: "mergeRanges sorts unordered input by start." },
		{ id: "r3", text: "mergeRanges merges overlapping and endpoint-touching ranges." },
		{ id: "r4", text: "mergeRanges keeps disjoint ranges separate." },
		{ id: "r5", text: "mergeRanges returns [] for empty input." },
		{ id: "r6", text: "mergeRanges throws RangeError when start is greater than end." },
		{ id: "r7", text: "tests/ranges.test.ts contains the five requested cases and passes under bun test." },
	],
	verify: async workspace => {
		const file = "src/ranges.ts";
		const results: RequirementResult[] = [];
		if (!existsSync(join(workspace, file))) {
			for (const req of RANGES.requirements) results.push(result(RANGES, req.id, false, `${file} is missing; no module assertions ran`));
			return results;
		}
		const probe = moduleProbe(workspace, file, `
	const call = (value) => { try { return { value: fn(value) }; } catch (error) { return { error: String(error && error.name ? error.name : error) }; } };
	console.log(JSON.stringify({
		ok: true,
		value: {
			unsorted: call([[5, 7], [1, 3], [2, 4]]),
			touching: call([[1, 2], [2, 3]]),
			disjoint: call([[1, 2], [4, 5]]),
			empty: call([]),
			inverted: call([[5, 1]])
		}
	}));
`);
		if (probe.ok !== true) {
			for (const req of RANGES.requirements.slice(0, 6)) results.push(result(RANGES, req.id, false, `module import/call failed: ${probe.error ?? "unknown"}`));
		} else {
			const value: Record<string, unknown> = asRecord(probe.value) ?? {};
			const call = (key: string): Record<string, unknown> => asRecord(value[key]) ?? {};
			const same = (key: string, expected: unknown): boolean => JSON.stringify(call(key)["value"]) === JSON.stringify(expected);
			results.push(result(RANGES, "r1", true, "mergeRanges is exported and callable"));
			results.push(result(RANGES, "r2", same("unsorted", [[1, 4], [5, 7]]), `observed ${JSON.stringify(call("unsorted"))}`));
			results.push(result(RANGES, "r3", same("unsorted", [[1, 4], [5, 7]]) && same("touching", [[1, 3]]), `observed ${JSON.stringify({ unsorted: call("unsorted"), touching: call("touching") })}`));
			results.push(result(RANGES, "r4", same("disjoint", [[1, 2], [4, 5]]), `observed ${JSON.stringify(call("disjoint"))}`));
			results.push(result(RANGES, "r5", same("empty", []), `observed ${JSON.stringify(call("empty"))}`));
			results.push(result(RANGES, "r6", call("inverted")["error"] === "RangeError", `observed ${JSON.stringify(call("inverted"))}`));
		}
		const testFile = "tests/ranges.test.ts";
		if (!existsSync(join(workspace, testFile))) {
			results.push(result(RANGES, "r7", false, `${testFile} is missing`));
		} else {
			const text = readFileSync(join(workspace, testFile), "utf8");
			const run = runBunTest(workspace, testFile);
			const hasCases = text.includes("mergeRanges") && text.includes("[1, 2]") && text.includes("[2, 3]") && text.includes("RangeError") && text.includes("[]");
			results.push(result(RANGES, "r7", hasCases && run.exitCode === 0, `cases=${hasCases}; ${run.command} exit=${run.exitCode}`));
		}
		return results;
	},
};

const TASKS: TaskSpec[] = [SLUG, RANGES];

function selectedTasks(ids: string[]): TaskSpec[] {
	if (ids.length === 1 && ids[0] === "all") return TASKS;
	return ids.map(id => {
		const task = TASKS.find(candidate => candidate.id === id);
		if (task === undefined) fail(`unknown task ${id}; known: ${TASKS.map(item => item.id).join(", ")}`);
		return task;
	});
}

/* --------------------------------------------------------------- execution */

interface RunResult {
	runId: string;
	arm: Arm;
	task: string;
	taskTitle: string;
	repeat: number;
	model: string;
	thinking: string;
	maxTimeSeconds: number;
	extension: string;
	extensionFingerprint: string;
	workspace: string;
	exitCode: number;
	timedOut: boolean;
	elapsedMs: number;
	eventCount: number;
	delivered: boolean;
	delivery: Record<string, unknown>;
	toolCalls: Record<string, unknown>;
	providerErrors: string[];
	failureNotes: string[];
	requirements: RequirementResult[];
	requirementsMet: number;
	requirementsTotal: number;
	testRun?: { command: string; exitCode: number; output: string; timedOut: boolean };
	workspaceFiles: string[];
	stderrExcerpt: string;
	evidenceDir: string;
}

function resolveToken(): string | undefined {
	const probe = Bun.spawnSync({ cmd: ["omp", "token", "deepseek"], env: process.env });
	const token = decoded(probe.stdout).trim();
	return token.length > 0 ? token : undefined;
}

function parseEvents(stdout: string): Record<string, unknown>[] {
	const events: Record<string, unknown>[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			const record = asRecord(parsed);
			if (record !== undefined) events.push(record);
		} catch {
			// omp may write a plain diagnostic line; keep it out of the event stream.
		}
	}
	return events;
}

function detectDelivery(events: Record<string, unknown>[]): { delivered: boolean; detail: Record<string, unknown> } {
	const ends = events.filter(event => event["type"] === "agent_end");
	const agentEnd = ends.at(-1);
	const messages = Array.isArray(agentEnd?.["messages"]) ? agentEnd!["messages"] as unknown[] : [];
	const final = [...messages].reverse().map(asRecord).find(message => message?.["role"] === "assistant");
	const finalText = textOfMessage(final);
	const finalStop = typeof final?.["stopReason"] === "string" ? final["stopReason"] : undefined;
	const providerErrors: string[] = [];
	for (const event of events) {
		if (event["type"] !== "turn_end") continue;
		const message = asRecord(event["message"]);
		const stop = message?.["stopReason"];
		const error = message?.["errorMessage"];
		if (stop === "error" || typeof error === "string" && error.length > 0) {
			providerErrors.push(String(error ?? stop).slice(0, 500));
		}
	}
	return {
		delivered: agentEnd !== undefined && finalStop === "stop" && finalText.length > 0,
		detail: {
			agentEnd: agentEnd !== undefined,
			yielded: agentEnd?.["yielded"] === true,
			finalStop: finalStop ?? null,
			finalText: finalText.slice(0, 4_000),
			providerErrors,
		},
	};
}

function summarizeToolCalls(events: Record<string, unknown>[]): Record<string, unknown> {
	const counts: Record<string, number> = {};
	const failures: Record<string, number> = {};
	const sequence: string[] = [];
	const byId = new Map<string, string>();
	for (const event of events) {
		if (event["type"] === "tool_execution_start") {
			const raw = String(event["toolName"] ?? "tool");
			const args = asRecord(event["args"]);
			const path = typeof args?.["path"] === "string" ? args["path"] : undefined;
			const logical = path?.startsWith("xd://") === true ? path.slice("xd://".length) : raw;
			counts[logical] = (counts[logical] ?? 0) + 1;
			sequence.push(logical);
			const id = String(event["toolCallId"] ?? `${logical}-${sequence.length}`);
			byId.set(id, logical);
		} else if (event["type"] === "tool_execution_end") {
			const id = String(event["toolCallId"] ?? "");
			const logical = byId.get(id);
			if (logical === undefined) continue;
			const result = asRecord(event["result"]);
			if (event["isError"] === true || result?.["isError"] === true) failures[logical] = (failures[logical] ?? 0) + 1;
		}
	}
	const diagnostics = Object.keys(counts).filter(name => name.startsWith("jev_"));
	const diagnosticCalls = diagnostics.reduce((sum, name) => sum + (counts[name] ?? 0), 0);
	const diagnosticFailures = diagnostics.reduce((sum, name) => sum + (failures[name] ?? 0), 0);
	return {
		counts,
		failures,
		sequence,
		diagnosticCalls,
		diagnosticFailures,
		diagnostics: Object.fromEntries(diagnostics.map(name => [name, counts[name]])),
	};
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runOne(task: TaskSpec, arm: Arm, repeat: number, extension: { path: string; digest: string }, options: Options, token: string | undefined, outRoot: string): Promise<RunResult> {
	const runId = `${arm}-${task.id}-r${repeat}`;
	const runDir = join(outRoot, "runs", runId);
	const workspace = join(tmpdir(), `jev-wc-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const agentDir = join(runDir, "agent");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(runDir, { recursive: true });

	const args = [
		"omp",
		"-p",
		"--mode", "json",
		"--no-extensions",
		"-e", extension.path,
		"--no-context-files",
		"--no-rules",
		"--no-skills",
		"--no-lsp",
		"--model", options.model,
		"--thinking", options.thinking,
		"--no-title",
		"--auto-approve",
		"--cwd", workspace,
		"--max-time", String(options.maxTime),
		"--no-session",
		task.prompt,
	];
	writeFileSync(join(runDir, "command.txt"), `${args.map(shellQuote).join(" ")}\n`, "utf8");
	writeFileSync(join(runDir, "prompt.txt"), `${task.prompt}\n`, "utf8");

	const started = Date.now();
	const proc = Bun.spawn({
		cmd: args,
		cwd: workspace,
		env: {
			...process.env,
			NO_COLOR: "1",
			PI_CODING_AGENT_DIR: agentDir,
			...(token === undefined ? {} : { DEEPSEEK_API_KEY: token }),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, (options.maxTime + 60) * 1_000);
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
	const elapsedMs = Date.now() - started;
	const events = parseEvents(stdout);
	const delivery = detectDelivery(events);
	const toolCalls = summarizeToolCalls(events);
	const requirements = await task.verify(workspace);
	const testRun = task.id === "slug" && existsSync(join(workspace, "tests", "slug.test.ts"))
		? runBunTest(workspace, "tests/slug.test.ts")
		: task.id === "ranges" && existsSync(join(workspace, "tests", "ranges.test.ts"))
			? runBunTest(workspace, "tests/ranges.test.ts")
			: undefined;
	const workspaceFiles = workspacesFiles(workspace);
	copyArtifacts(workspace, runDir);

	const failureNotes: string[] = [];
	if (timedOut) failureNotes.push(`killed after ${options.maxTime + 60}s wall guard`);
	if (exitCode !== 0) failureNotes.push(`omp exited with code ${exitCode}`);
	if (!delivery.delivered) failureNotes.push("no agent_end with a non-empty final assistant stop");
	const providerErrors = Array.isArray(delivery.detail["providerErrors"]) ? delivery.detail["providerErrors"] as string[] : [];
	if (providerErrors.length > 0) failureNotes.push(`${providerErrors.length} provider error event(s)`);

	writeFileSync(join(runDir, "events.ndjson"), redacted(stdout, token), "utf8");
	writeFileSync(join(runDir, "stderr.txt"), redacted(stderr, token), "utf8");
	writeFileSync(join(runDir, "test-output.txt"), redacted(testRun?.output ?? "", token), "utf8");

	const result: RunResult = {
		runId,
		arm,
		task: task.id,
		taskTitle: task.title,
		repeat,
		model: options.model,
		thinking: options.thinking,
		maxTimeSeconds: options.maxTime,
		extension: extension.path,
		extensionFingerprint: extension.digest,
		workspace,
		exitCode,
		timedOut,
		elapsedMs,
		eventCount: events.length,
		delivered: delivery.delivered,
		delivery: delivery.detail,
		toolCalls,
		providerErrors,
		failureNotes,
		requirements,
		requirementsMet: requirements.filter(item => item.pass).length,
		requirementsTotal: requirements.length,
		...(testRun === undefined ? {} : { testRun }),
		workspaceFiles,
		stderrExcerpt: redacted(stderr, token).slice(-2_000),
		evidenceDir: runDir,
	};
	writeJson(join(runDir, "result.json"), result);
	return result;
}

/* --------------------------------------------------------------- summary */

function summarizeResults(results: RunResult[], meta: Record<string, unknown>): Record<string, unknown> {
	const byArm: Record<string, Record<string, unknown>> = {};
	for (const arm of ["baseline", "candidate"] as const) {
		const runs = results.filter(item => item.arm === arm);
		if (runs.length === 0) continue;
		const requirementsMet = runs.reduce((sum, item) => sum + item.requirementsMet, 0);
		const requirementsTotal = runs.reduce((sum, item) => sum + item.requirementsTotal, 0);
		const diagnosticCalls = runs.reduce((sum, item) => sum + Number(item.toolCalls["diagnosticCalls"] ?? 0), 0);
		byArm[arm] = {
			runs: runs.length,
			delivered: runs.filter(item => item.delivered).length,
			completed: runs.filter(item => item.delivered && !item.timedOut && item.exitCode === 0).length,
			fullyPassing: runs.filter(item => item.requirementsMet === item.requirementsTotal && item.requirementsTotal > 0).length,
			requirementsMet,
			requirementsTotal,
			diagnosticCalls,
			diagnosticCallsPerRun: runs.length === 0 ? 0 : diagnosticCalls / runs.length,
			meanSeconds: runs.reduce((sum, item) => sum + item.elapsedMs, 0) / runs.length / 1_000,
			providerErrors: runs.reduce((sum, item) => sum + item.providerErrors.length, 0),
			failureNotes: runs.reduce((sum, item) => sum + (item.failureNotes?.length ?? 0), 0),
			perRequirement: Object.fromEntries(
				[...new Set(runs.flatMap(item => item.requirements.map(req => req.id)))].sort().map(id => {
					const matches = runs.flatMap(item => item.requirements.filter(req => req.id === id));
					return [id, { pass: matches.filter(req => req.pass).length, total: matches.length }];
				}),
			),
		};
	}
	const byTask: Record<string, Record<string, unknown>> = {};
	for (const task of [...new Set(results.map(item => item.task))]) {
		byTask[task] = {};
		for (const arm of ["baseline", "candidate"] as const) {
			const runs = results.filter(item => item.arm === arm && item.task === task);
			if (runs.length === 0) continue;
			(byTask[task] as Record<string, unknown>)[arm] = {
				runs: runs.length,
				delivered: runs.filter(item => item.delivered).length,
				requirementsMet: runs.reduce((sum, item) => sum + item.requirementsMet, 0),
				requirementsTotal: runs.reduce((sum, item) => sum + item.requirementsTotal, 0),
				meanSeconds: runs.reduce((sum, item) => sum + item.elapsedMs, 0) / runs.length / 1_000,
				diagnosticCalls: runs.reduce((sum, item) => sum + Number(item.toolCalls["diagnosticCalls"] ?? 0), 0),
			};
		}
	}
	const comparison = byArm["baseline"] !== undefined && byArm["candidate"] !== undefined
		? {
			requirementsMetDelta: Number(byArm["candidate"]["requirementsMet"]) - Number(byArm["baseline"]["requirementsMet"]),
			requirementsTotalDelta: Number(byArm["candidate"]["requirementsTotal"]) - Number(byArm["baseline"]["requirementsTotal"]),
			deliveredDelta: Number(byArm["candidate"]["delivered"]) - Number(byArm["baseline"]["delivered"]),
			meanSecondsDelta: Number(byArm["candidate"]["meanSeconds"]) - Number(byArm["baseline"]["meanSeconds"]),
			diagnosticCallsDelta: Number(byArm["candidate"]["diagnosticCalls"]) - Number(byArm["baseline"]["diagnosticCalls"]),
		}
		: undefined;
	return { ...meta, comparison, runs: results, byArm, byTask };
}

function loadResults(root: string): RunResult[] {
	const runsDir = join(root, "runs");
	if (!existsSync(runsDir)) return [];
	const results: RunResult[] = [];
	for (const name of readdirSync(runsDir).sort()) {
		const path = join(runsDir, name, "result.json");
		if (!existsSync(path)) continue;
		results.push(JSON.parse(readFileSync(path, "utf8")) as RunResult);
	}
	return results;
}

async function main(): Promise<void> {
	const options = parseOptions(Bun.argv.slice(2));
	if (options.summarize !== undefined) {
		const results = loadResults(options.summarize);
		if (results.length === 0) fail(`no runs under ${options.summarize}`);
		const manifests = ["manifest-baseline.json", "manifest-candidate.json"]
			.map(name => join(options.summarize, name))
			.filter(path => existsSync(path))
			.map(path => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
		const mergedExtensions: Record<string, unknown> = {};
		for (const manifest of manifests) {
			for (const [arm, value] of Object.entries(asRecord(manifest["extensions"]) ?? {})) mergedExtensions[arm] = value;
		}
		const first: Record<string, unknown> = manifests[0] ?? {};
		const baselineExtension = asRecord(mergedExtensions["baseline"]);
		const summary = summarizeResults(results, {
			mode: "summarize",
			generatedAt: new Date().toISOString(),
			source: options.summarize,
			model: first["model"],
			thinking: first["thinking"],
			maxTimeSeconds: first["maxTimeSeconds"],
			repeats: first["repeats"],
			extensions: mergedExtensions,
			baselineFingerprint: baselineExtension?.["digest"],
			protocol: first["protocol"],
		});
		writeJson(join(options.summarize, "summary.json"), summary);
		console.log(JSON.stringify(summary.byArm, null, 2));
		return;
	}
	const arms: Arm[] = options.arm === "both" ? ["baseline", "candidate"] : [options.arm];
	if (arms.includes("baseline") && options.baseline === "") fail("baseline arm needs --baseline");
	if (!existsSync(options.candidate) && arms.includes("candidate")) fail(`candidate checkout not found: ${options.candidate}`);

	const frozenBaseline = options.baseline !== "" && existsSync(options.baseline) ? extensionFingerprint(options.baseline) : undefined;
	const baselineExtension = arms.includes("baseline") ? frozenBaseline : undefined;
	const candidateExtension = arms.includes("candidate") ? extensionFingerprint(options.candidate) : undefined;
	if (arms.includes("candidate") && frozenBaseline !== undefined && candidateExtension !== undefined && frozenBaseline.digest === candidateExtension.digest) {
		fail(`candidate extension is identical to the frozen baseline (${candidateExtension.digest}); no new implementation has landed yet`);
	}
	const extensions: Record<string, { path: string; digest: string }> = {};
	if (baselineExtension !== undefined) extensions["baseline"] = baselineExtension;
	if (candidateExtension !== undefined) extensions["candidate"] = candidateExtension;
	const token = resolveToken();
	const tasks = selectedTasks(options.tasks);
	mkdirSync(join(options.out, "runs"), { recursive: true });

	const meta = {
		mode: "run",
		generatedAt: new Date().toISOString(),
		model: options.model,
		thinking: options.thinking,
		maxTimeSeconds: options.maxTime,
		repeats: options.repeats,
		arms,
		extensions,
		baseline: options.baseline,
		baselineFingerprint: frozenBaseline?.digest,
		candidate: options.candidate,
		tasks: tasks.map(task => ({ id: task.id, title: task.title, prompt: task.prompt, requirements: task.requirements })),
		protocol: "Same prompt, model, thinking level, wall cap and fresh disposable workspace per run; only -e extension differs.",
		credential: token === undefined ? "omp token deepseek returned no key; provider runs would fail closed" : "omp token deepseek returned a key (not saved)",
		identicalExtensions: frozenBaseline !== undefined && candidateExtension !== undefined && frozenBaseline.digest === candidateExtension.digest,
		notRun: token === undefined ? "No provider key; no native omp run was attempted." : undefined,
	};
	writeJson(join(options.out, "manifest.json"), meta);
	writeJson(join(options.out, `manifest-${options.arm}.json`), meta);
	if (token === undefined) {
		const summary = summarizeResults([], meta);
		writeJson(join(options.out, "summary.json"), summary);
		console.log(`No provider key; wrote not-run manifest at ${options.out}`);
		return;
	}

	const results: RunResult[] = [];
	for (const task of tasks) {
		for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
			const order: Arm[] = repeat % 2 === 1 ? arms : [...arms].reverse();
			for (const arm of order) {
				const extension = extensions[arm];
				if (extension === undefined) fail(`no extension registered for arm ${arm}`);
				console.log(`[${arm}] ${task.id} repeat ${repeat} started`);
				const result = await runOne(task, arm, repeat, extension, options, token, options.out);
				results.push(result);
				console.log(`[${arm}] ${task.id} repeat ${repeat}: exit=${result.exitCode} delivered=${result.delivered} requirements=${result.requirementsMet}/${result.requirementsTotal} seconds=${(result.elapsedMs / 1000).toFixed(1)} diagnostics=${Number(result.toolCalls["diagnosticCalls"] ?? 0)}`);
			}
		}
	}
	const summary = summarizeResults(loadResults(options.out), meta);
	writeJson(join(options.out, "summary.json"), summary);
	console.log(`\nResults: ${options.out}`);
	console.log(JSON.stringify(summary.byArm, null, 2));
}

if (import.meta.main) await main();
