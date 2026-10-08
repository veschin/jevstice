/**
 * Effective configuration: the project file `<cwd>/.omp/jev.config.json` overrides the user file
 * `~/.omp/agent/jev.config.json`.
 *
 * Only the keys the MVP reads are validated and unknown keys are ignored, so a file written for an
 * older shape still loads. An invalid value never loosens a gate: the fail-closed default stays in
 * force and the problem is recorded with the file it came from.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, type JevConfig } from "./types.js";

const CONFIG_FILE_NAME = "jev.config.json";

/** Fail-closed defaults: both gates on, an interval check every third consequential action. */
export const DEFAULT_CONFIG: JevConfig = {
	gates: { mutation: true, completion: true },
	courseCheck: { mode: "interval", interval: 3 },
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

function modeValue(
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
	let mode = DEFAULT_CONFIG.courseCheck.mode;
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
		mode = modeValue(courseCheck?.["mode"], mode, path, problems);
		interval = intervalValue(courseCheck?.["interval"], interval, path, problems);
	}
	return { gates: { mutation: mutationGate, completion: completionGate }, courseCheck: { mode, interval }, problems };
}
