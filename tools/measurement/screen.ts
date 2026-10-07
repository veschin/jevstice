#!/usr/bin/env bun
/**
 * Control-arm screening tool for the failure search (not the measurement itself).
 *
 * The with/without harness in `run.ts` answers "does the addon change the outcome" and therefore
 * always runs both arms and consults the judge. Searching for a task that a cheap model actually
 * fails needs the opposite: many cheap control-only sessions, no addon, no judge traffic. This tool
 * runs exactly the control arm - the same binary, the same flags, the same prompt, the same scratch
 * layout and the same check scripts as `run.ts` - and reports the per-requirement machine verdicts.
 *
 * It is a search instrument: a task that defeats the control arm here is then measured with the real
 * two-arm harness (`bun run tools/measurement/run.ts --set <set> --only <task>`). Every attempt is
 * appended to a log, including the attempts whose task turned out to be too easy, so the search is
 * visible rather than only its winner.
 *
 * usage: bun run tools/measurement/screen.ts --set hard [--only ledger] [--attempt "A1 ..."]
 *          [--note "..."] [--repeats 2] [--model deepseek/deepseek-flash:low] [--timeout 420]
 *          [--log evidence/measurement-<date>-search.log] [--dry-run]
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isRecord } from "../../src/guards";
import { TASK_SETS, type TaskDef } from "./tasks";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MODEL = flagValue("--model") || "deepseek/deepseek-flash:low";

function flagValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	if (i === -1) return undefined;
	const v = process.argv[i + 1];
	return v === undefined || v.startsWith("--") ? "" : v;
}

const date = new Date();
const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const setName = flagValue("--set") || "hard";
const allTasks = TASK_SETS[setName];
if (allTasks === undefined) throw new Error(`--set must be one of ${Object.keys(TASK_SETS).join(", ")} (got "${setName}")`);
const only = (flagValue("--only") ?? "").split(",").map(s => s.trim()).filter(s => s.length > 0);
const selected = only.length > 0 ? allTasks.filter(t => only.includes(t.id)) : allTasks;
if (selected.length === 0) throw new Error(`--only matched no task; set "${setName}" has: ${allTasks.map(t => t.id).join(", ")}`);
const repeats = Math.max(1, Number.parseInt(flagValue("--repeats") ?? "1", 10));
const timeoutSec = Number.parseInt(flagValue("--timeout") ?? "420", 10);
const attempt = flagValue("--attempt") ?? "unlabelled attempt";
const note = flagValue("--note") ?? "";
const logFile = flagValue("--log") || join(REPO_ROOT, "evidence", `measurement-${today}-search.log`);
const dryRun = process.argv.includes("--dry-run");

const stamp = `${today.replace(/-/g, "")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
const root = `/tmp/jev-screen-${stamp}`;

const sha256 = (text: string | Uint8Array): string =>
	createHash("sha256").update(typeof text === "string" ? Buffer.from(text, "utf8") : text).digest("hex");
const log = (msg: string) => process.stderr.write(`${msg}\n`);

/** Content digest of the extension under test, identical to the measurement harness's. */
function extensionRevision(): { digest: string; files: number } {
	const dir = join(REPO_ROOT, "src");
	const rels: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) rels.push(relative(dir, full));
		}
	};
	walk(dir);
	rels.sort();
	const manifest = rels.map(rel => `${rel}:${sha256(readFileSync(join(dir, rel)))}`).join("\n");
	return { digest: sha256(manifest), files: rels.length };
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push(relative(dir, full));
		}
	};
	walk(dir);
	return out.sort();
}

const REQ_LINE = /^REQ\s+(\S+)\s+(PASS|FAIL)\b.*$/;

function parseRequirementVerdicts(output: string): Record<string, "pass" | "fail"> {
	const verdicts: Record<string, "pass" | "fail"> = {};
	for (const line of output.split("\n")) {
		const match = REQ_LINE.exec(line.trim());
		if (match !== null) verdicts[match[1]!] = match[2] === "PASS" ? "pass" : "fail";
	}
	return verdicts;
}

interface ProcResult { exitCode: number; timedOut: boolean; wallMs: number; stdout: string; stderr: string }

async function spawnCapture(cmd: string[], cwd: string, timeoutMs: number): Promise<ProcResult> {
	const started = Date.now();
	const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill(9);
	}, timeoutMs);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	clearTimeout(timer);
	return { exitCode, timedOut, wallMs: Date.now() - started, stdout, stderr };
}

interface SessionCapture {
	dir: string;
	cmd: string[];
	exitCode: number;
	timedOut: boolean;
	wallMs: number;
	turns: number;
	toolSequence: string[];
	usage: { input: number; output: number; totalTokens: number; cost: number };
	finalReport: string;
	checkOutput: string;
	checkExitCode: number;
	verdicts: Record<string, "pass" | "fail">;
	files: string[];
	reportReportedDrops: boolean;
}

function digestControlSession(stdout: string): { turns: number; toolSequence: string[]; usage: SessionCapture["usage"]; finalReport: string } {
	const usage = { input: 0, output: 0, totalTokens: 0, cost: 0 };
	const toolSequence: string[] = [];
	let turns = 0;
	let finalReport = "";
	for (const line of stdout.split("\n")) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		let event: unknown;
		try {
			event = JSON.parse(text);
		} catch {
			continue;
		}
		if (!isRecord(event)) continue;
		if (event["type"] === "turn_end") turns++;
		if (event["type"] === "tool_execution_start" && typeof event["toolName"] === "string") toolSequence.push(event["toolName"]);
		if (event["type"] !== "message_end" || !isRecord(event["message"])) continue;
		const message = event["message"];
		const u = message["usage"];
		if (isRecord(u)) {
			const num = (k: string): number => (typeof u[k] === "number" ? u[k] : 0);
			usage.input += num("input");
			usage.output += num("output");
			usage.totalTokens += num("totalTokens");
			const cost = u["cost"];
			if (isRecord(cost)) {
				for (const value of Object.values(cost)) if (typeof value === "number") usage.cost += value;
			} else if (typeof cost === "number") usage.cost += cost;
		}
		if (message["role"] !== "assistant" || !Array.isArray(message["content"])) continue;
		const parts = message["content"].filter(part => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string");
		const text2 = parts.map(part => String((part as Record<string, unknown>)["text"])).join("\n");
		if (text2.trim().length > 0) finalReport = text2;
	}
	return { turns, toolSequence, usage, finalReport };
}

const CONTROL_ARGV = (prompt: string): string[] => [
	"omp",
	"--mode",
	"json",
	"-p",
	"--no-extensions",
	"--model",
	MODEL,
	"--auto-approve",
	"--no-session",
	"--max-time",
	String(timeoutSec),
	prompt,
];

async function runControlSession(task: TaskDef, repeat: number, dir: string): Promise<SessionCapture> {
	mkdirSync(dir, { recursive: true });
	for (const [rel, content] of Object.entries(task.setup)) {
		const full = join(dir, rel);
		mkdirSync(resolve(full, ".."), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	const cmd = CONTROL_ARGV(task.prompt);
	const proc = await spawnCapture(cmd, dir, (timeoutSec + 60) * 1000);
	const digested = digestControlSession(proc.stdout);
	// Check files are written only now, exactly as in the measurement harness.
	for (const [rel, content] of Object.entries(task.checkFiles)) writeFileSync(join(dir, rel), content, "utf8");
	const verdicts: Record<string, "pass" | "fail"> = {};
	let checkOutput = "";
	let checkExitCode = 0;
	for (const check of task.checks) {
		const res = await spawnCapture(check.cmd, dir, 120_000);
		checkOutput += `${res.stdout}${res.stderr}`.trim();
		checkExitCode = res.exitCode;
		Object.assign(verdicts, parseRequirementVerdicts(checkOutput));
	}
	for (const rel of Object.keys(task.checkFiles)) rmSync(join(dir, rel), { force: true });
	return {
		dir,
		cmd,
		exitCode: proc.exitCode,
		timedOut: proc.timedOut,
		wallMs: proc.wallMs,
		turns: digested.turns,
		toolSequence: digested.toolSequence,
		usage: digested.usage,
		finalReport: digested.finalReport,
		checkOutput,
		checkExitCode,
		verdicts,
		files: listFiles(dir),
		reportReportedDrops: /dropped/i.test(digested.finalReport),
	};
}

if (dryRun) {
	process.stdout.write(`dry run: set=${setName}, ${selected.length} task(s), ${selected.length * repeats} control sessions, model=${MODEL}, log=${logFile}\n\n`);
	for (const t of selected) {
		process.stdout.write(`- ${t.id} (${(t.requirements ?? []).length} requirements): ${t.title}\n`);
	}
	process.exit(0);
}

const revisionBefore = extensionRevision();
log(`control-only screening - attempt "${attempt}" - ${new Date().toISOString()}`);
log(`scratch root: ${root}  |  log: ${logFile}  |  model: ${MODEL}`);
log(`extension revision under test: src/ digest ${revisionBefore.digest.slice(0, 16)}... over ${revisionBefore.files} files (control sessions do not load it)`);

const sections: string[] = [];
sections.push("");
sections.push(`## Attempt: ${attempt}`);
sections.push("");
sections.push(`- When: ${new Date().toISOString()}`);
if (note.length > 0) sections.push(`- Note: ${note}`);
sections.push(`- Model: \`${MODEL}\` (thinking level from the model spec on the command line, as in the measurement harness)`);
sections.push(`- Command per session: \`omp --mode json -p --no-extensions --model ${MODEL} --auto-approve --no-session --max-time ${timeoutSec} <prompt>\` (the control arm of \`run.ts\`; the extension is not loaded)`);
sections.push(`- Extension revision (\`src/\` content digest) before: \`${revisionBefore.digest}\` over ${revisionBefore.files} files`);
sections.push(`- Sessions: ${selected.length} task(s) x ${repeats} run(s) = ${selected.length * repeats} control-only session(s); scratch dirs under \`${root}\``);
sections.push("");

for (const task of selected) {
	let controlFailures = 0;
	let controlPasses = 0;
	for (let repeat = 1; repeat <= repeats; repeat++) {
		const dir = join(root, `${task.id}-control-r${repeat}`);
		log(`task ${task.id} control repeat ${repeat}: running...`);
		const session = await runControlSession(task, repeat, dir);
		const declared = task.requirements ?? [];
		const dropped = declared.filter(r => session.verdicts[r.id] !== "pass");
		if (dropped.length === 0) controlPasses++;
		else controlFailures++;
		log(`  exit ${session.exitCode}, ${(session.wallMs / 1000).toFixed(1)}s, check exit ${session.checkExitCode}, dropped: ${dropped.map(r => r.id).join(",") || "none"}`);
		sections.push(`### \`${task.id}\` control run ${repeat}/${repeats}`);
		sections.push("");
		sections.push(`- Scratch dir (kept): \`${session.dir}\``);
		sections.push(`- Prompt: identical to the one the measurement harness uses for this task (sha256 \`${sha256(task.prompt)}\`)`);
		sections.push(`- exit code: ${session.exitCode}${session.timedOut ? " (KILLED AT THE TIMEOUT)" : ""}; wall time: ${(session.wallMs / 1000).toFixed(1)}s`);
		sections.push(`- turns: ${session.turns}; agent model calls (message ends counted by usage): token usage input ${session.usage.input}, output ${session.usage.output}, total ${session.usage.totalTokens}, provider cost ${session.usage.cost.toFixed(4)}`);
		sections.push(`- tool calls, in order: ${session.toolSequence.join(" -> ") || "(none)"}`);
		sections.push(`- files left in the scratch dir: ${session.files.length === 0 ? "(none)" : session.files.join(", ")}`);
		sections.push(`- check: \`${task.checks.map(c => c.cmd.join(" ")).join(" | ")}\` -> exit ${session.checkExitCode} (expected ${task.checks[0]!.expectExit}) => ${session.checkExitCode === task.checks[0]!.expectExit ? "PASS" : "FAIL"}`);
		sections.push(`- final report mentions a dropped requirement: ${session.reportReportedDrops}`);
		sections.push("");
		sections.push("| requirement | kind | verdict | what it demands |");
		sections.push("| --- | --- | --- | --- |");
		for (const requirement of declared) {
			const verdict = session.verdicts[requirement.id] ?? "missing";
			sections.push(`| ${requirement.id} | ${requirement.kind} | ${verdict === "pass" ? "KEPT" : verdict === "fail" ? "**DROPPED**" : "not reported"} | ${requirement.text} |`);
		}
		sections.push("");
		sections.push(`**Control verdict for this run: ${dropped.length === 0 ? "PASSED - the task is too easy for this model" : `FAILED - dropped ${dropped.map(r => r.id).join(", ")}`}**`);
		sections.push("");
		sections.push("<details><summary>check output verbatim</summary>");
		sections.push("");
		sections.push("```");
		sections.push(session.checkOutput.replace(/\n$/, "") || "(no output)");
		sections.push("```");
		sections.push("");
		sections.push("</details>");
		sections.push("");
		sections.push("<details><summary>final report verbatim (last assistant message with text)</summary>");
		sections.push("");
		sections.push("```");
		sections.push(session.finalReport.replace(/\n$/, "") || "(empty)");
		sections.push("```");
		sections.push("");
		sections.push("</details>");
		sections.push("");
	}
	sections.push(`**Screening summary for \`${task.id}\`**: ${controlPasses}/${repeats} control run(s) passed, ${controlFailures}/${repeats} failed.`);
	sections.push("");
}

const revisionAfter = extensionRevision();
sections.push(`- Extension revision (\`src/\` content digest) after: \`${revisionAfter.digest}\` over ${revisionAfter.files} files - unchanged during the attempt: ${revisionAfter.digest === revisionBefore.digest}`);
sections.push("");

mkdirSync(resolve(logFile, ".."), { recursive: true });
const header = existsSync(logFile) ? "" : `# Failure search: control-arm-only attempts (search instrument)\n\nEach attempt below ran the CONTROL arm only (no extension, no judge) on a candidate task and reports the per-requirement machine verdicts from the task's own check script. A task is only carried into the two-arm measurement once this log shows the control arm dropping a requirement. Attempts whose task passed are kept here as evidence of the search: the shape was changed after each pass, never the wording of the same task.\n`;
appendFileSync(logFile, `${header}${sections.join("\n")}\n`, "utf8");
log(`screening log appended: ${logFile}`);
