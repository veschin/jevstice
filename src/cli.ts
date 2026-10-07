/**
 * CLI: prepares the same production judge call from JSON args (file, "-" for
 * stdin, or literal JSON). Exit codes: 0 = judge answered (any verdict, revise
 * included), 2 = usage/invalid input, 4 = config/transport/payload errors.
 * `jev probe` performs one minimal synthetic live call for reachability proof.
 *
 * Config: TYPESAFE_API_KEY (or JEVI_API_KEY) or TYPESAFE_API_KEY_COMMAND
 * (shell command whose stdout is the key, e.g. `pass show token/jev`);
 * TYPESAFE_API_URL overrides the endpoint. The key never reaches stdout,
 * stderr, or the request body - only the Authorization header.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DecisionRequest, DecisionStage } from "./types";
import { createJudge, JevApiError, REASON_CODES } from "./client";
import { validateDecisionRequest } from "./evidence";

export { REASON_CODES };

export interface CliDeps {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
}

export interface CliOutcome {
  exitCode: 0 | 2 | 4;
  stdout: string;
  stderr: string;
}

const execFileP = promisify(execFile);

async function readKey(env: Record<string, string | undefined>): Promise<string | undefined> {
  const direct = env["TYPESAFE_API_KEY"] ?? env["JEVI_API_KEY"];
  if (direct) return direct;
  const command = env["TYPESAFE_API_KEY_COMMAND"];
  if (command) {
    // single command string run through the shell; stdout trimmed is the key
    let stdout: string;
    try {
      ({ stdout } = await execFileP("/bin/sh", ["-c", command], { timeout: 15000 }));
    } catch (err) {
      throw new JevApiError(
        "config",
        `TYPESAFE_API_KEY_COMMAND failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const key = stdout.trim();
    return key.length > 0 ? key : undefined;
  }
  return undefined;
}

const USAGE =
  "usage: jev decide <request.json | - | '{...json...}'>\n" +
  "       jev probe\n" +
  "env: TYPESAFE_API_KEY | TYPESAFE_API_KEY_COMMAND (e.g. 'pass show token/jev'), TYPESAFE_API_URL";

function errorLine(code: string, message: string, status?: number): string {
  return `${JSON.stringify({ error: code, ...(status !== undefined ? { status } : {}), message })}\n`;
}

/** One minimal synthetic classification call; no private project data. */
export const PROBE_REQUEST: DecisionRequest = {
  stage: "task_classification" as DecisionStage,
  task: "Classify this synthetic probe request.",
  proposal: "A one-line synthetic ping used to verify judge reachability.",
  options: [
    { id: "development", label: "Development", meaning: "writing or changing software" },
    { id: "analytics", label: "Analytics", meaning: "analyzing data or a system" },
    { id: "query", label: "Query", meaning: "a plain question" },
  ],
  evidence: [{ kind: "user", source: "jev probe", quote: "synthetic probe, classify this" }],
};

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(new TextDecoder().decode(chunk));
  return chunks.join("");
}

async function readRequestText(arg: string | undefined): Promise<string> {
  if (arg === undefined || arg === "-") return readStdin();
  if (arg.trimStart().startsWith("{")) return arg;
  return Bun.file(arg).text();
}

export async function runCli(args: string[], deps: CliDeps = {}): Promise<CliOutcome> {
  const argv = args.filter((a) => a !== "--");
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  let apiKey: string | undefined;
  try {
    apiKey = await readKey(env);
  } catch (err) {
    return {
      exitCode: 4,
      stdout: "",
      stderr: errorLine(
        err instanceof JevApiError ? err.code : "config",
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
  const config = {
    apiKey: apiKey ?? "",
    apiUrl: env["TYPESAFE_API_URL"] || undefined,
    fetchFn: deps.fetchFn,
  };

  const command = argv[0];
  if (command === "probe") {
    return runProbe(config);
  }
  if (argv.length > 1) return usage();
  const arg = argv[0];
  if (arg === undefined && process.stdin.isTTY) return usage();

  let requestText: string;
  try {
    requestText = await readRequestText(arg);
  } catch (err) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `invalid input source: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }

  let request: DecisionRequest;
  try {
    request = JSON.parse(requestText) as DecisionRequest;
  } catch {
    if (arg === undefined && requestText.trim() === "") return usage();
    return { exitCode: 2, stdout: "", stderr: errorLine("invalid_input", "invalid JSON input") };
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { exitCode: 2, stdout: "", stderr: "invalid request: expected an object\n" };
  }

  const problems = validateDecisionRequest(request);
  if (problems.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${JSON.stringify({ error: "invalid_input", problems })}\n`,
    };
  }

  return decide(request, config);
}

async function decide(
  request: DecisionRequest,
  config: { apiKey: string; apiUrl?: string; fetchFn?: typeof fetch },
): Promise<CliOutcome> {
  let result;
  try {
    result = await createJudge(config)(request);
  } catch (err) {
    if (err instanceof JevApiError) {
      return { exitCode: 4, stdout: "", stderr: errorLine(err.code, err.message, err.status) };
    }
    return {
      exitCode: 4,
      stdout: "",
      stderr: errorLine("transport", err instanceof Error ? err.message : String(err)),
    };
  }
  return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
}

async function runProbe(config: {
  apiKey: string;
  apiUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<CliOutcome> {
  const problems = validateDecisionRequest(PROBE_REQUEST);
  if (problems.length > 0) {
    return { exitCode: 4, stdout: "", stderr: errorLine("config", "internal probe request invalid") };
  }
  const started = performance.now();
  const result = await decide(PROBE_REQUEST, config);
  if (result.exitCode !== 0) return result;
  const latencyMs = Math.round(performance.now() - started);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const probe = { ok: true, verdict: parsed["verdict"], latencyMs };
  return { exitCode: 0, stdout: `${JSON.stringify(probe, null, 2)}\n`, stderr: "" };
}

function usage(): CliOutcome {
  return { exitCode: 2, stdout: "", stderr: `${USAGE}\n` };
}

if (import.meta.main) {
  const out = await runCli(process.argv.slice(2));
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.exitCode);
}
