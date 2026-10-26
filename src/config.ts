/**
 * Effective configuration: the project file `<cwd>/.omp/jev.config.json` overrides the user file
 * `~/.omp/agent/jev.config.json`.
 *
 * Only the keys the extension reads are validated and unknown keys are ignored, so a file written
 * for an older shape still loads. An invalid value keeps the default in force and is reported with
 * the file and the key it came from: a bad file never loosens a boundary the owner did ask for.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, type JevConfig } from "./types.js";

const CONFIG_FILE_NAME = "jev.config.json";

/**
 * The shipped defaults: both gates on - a request that reaches the working tree waits for triage,
 * and developed work waits for acceptance - with the course question deferred to completion, so a
 * developed task is judged once at the end instead of on every third consequential change. What
 * actually reaches a gate is what the request screen and the command classifier let through, and
 * a plain question, an inspection, a commit or a push is neither.
 */
export const DEFAULT_CONFIG: JevConfig = {
	gates: { mutation: true, completion: true },
	courseCheck: { mode: "completion", interval: 3 },
	problems: [],
};

export type ConfigReader = (path: string) => string | null;

const readFileOrNull: ConfigReader = path => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

/** The two files in load order: user first, project last so the project value wins. */
export function configPaths(options: { cwd: string; home?: string }): string[] {
	return [
		join(options.home ?? homedir(), ".omp", "agent", CONFIG_FILE_NAME),
		join(options.cwd, ".omp", CONFIG_FILE_NAME),
	];
}

function describeValue(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function booleanValue(
	value: unknown,
	fallback: boolean,
	file: string,
	key: string,
	problems: string[],
): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	problems.push(`${file}: ${key} must be true or false, got ${describeValue(value)} - the default ${String(fallback)} stays in force`);
	return fallback;
}

function courseModeValue(
	value: unknown,
	fallback: "interval" | "completion",
	file: string,
	problems: string[],
): "interval" | "completion" {
	if (value === undefined) return fallback;
	if (value === "interval" || value === "completion") return value;
	problems.push(`${file}: courseCheck.mode must be "interval" or "completion", got ${describeValue(value)} - the default "${fallback}" stays in force`);
	return fallback;
}

function intervalValue(value: unknown, fallback: number, file: string, problems: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	problems.push(`${file}: courseCheck.interval must be a whole number of actions of 1 or more, got ${describeValue(value)} - the default ${fallback} stays in force`);
	return fallback;
}

/** Read both configuration files and return the effective configuration with any problems found. */
export function loadJevConfig(options: { cwd: string; home?: string; read?: ConfigReader }): JevConfig {
	const read = options.read ?? readFileOrNull;
	let mutationGate = DEFAULT_CONFIG.gates.mutation;
	let completionGate = DEFAULT_CONFIG.gates.completion;
	let courseMode = DEFAULT_CONFIG.courseCheck.mode;
	let interval = DEFAULT_CONFIG.courseCheck.interval;
	const problems: string[] = [];
	for (const path of configPaths(options)) {
		const text = read(path);
		if (text === null) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			problems.push(`${path}: not valid JSON (${reason}) - the fail-closed defaults stay in force`);
			continue;
		}
		const root = asRecord(parsed);
		if (root === undefined) {
			problems.push(`${path}: a JSON object is expected at the top level - the fail-closed defaults stay in force`);
			continue;
		}
		const gates = asRecord(root["gates"]);
		mutationGate = booleanValue(gates?.["mutation"], mutationGate, path, "gates.mutation", problems);
		completionGate = booleanValue(gates?.["completion"], completionGate, path, "gates.completion", problems);
		const courseCheck = asRecord(root["courseCheck"]);
		courseMode = courseModeValue(courseCheck?.["mode"], courseMode, path, problems);
		interval = intervalValue(courseCheck?.["interval"], interval, path, problems);
	}
	return {
		gates: { mutation: mutationGate, completion: completionGate },
		courseCheck: { mode: courseMode, interval },
		problems,
	};
}
