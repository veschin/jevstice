/**
 * Effective configuration: the project file `<cwd>/.omp/jev.config.json` overrides the user file
 * `~/.omp/agent/jev.config.json`.
 *
 * Only the keys the extension reads are validated and unknown keys are ignored, so a file written
 * for an older shape still loads. An invalid value keeps the value already in force and is reported
 * with the file and the key it came from: a bad file never loosens a boundary the owner did ask for.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, POLICY, type AntiSlopMode, type JevConfig } from "./types.js";

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
	antiSlop: { mode: "advisory" },
	billing: {
		inputCostPerMillion: POLICY.modelInputCostPerMillion,
		outputCostPerMillion: POLICY.modelOutputCostPerMillion,
	},
	problems: [],
};

type ConfigReader = (path: string) => string | null;

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

/** The offending value as it appears in the file: strings quoted, structured values as JSON. */
function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	try {
		const rendered = JSON.stringify(value);
		if (rendered !== undefined) return rendered;
	} catch {
		// Fall through to the plain string form for a value JSON cannot render.
	}
	return String(value);
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
	problems.push(`${file}: ${key} must be true or false, got ${describeValue(value)} - kept ${fallback}`);
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
	problems.push(`${file}: courseCheck.mode must be "interval" or "completion", got ${describeValue(value)} - kept ${JSON.stringify(fallback)}`);
	return fallback;
}

function intervalValue(value: unknown, fallback: number, file: string, problems: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	problems.push(`${file}: courseCheck.interval must be an integer of 1 or more actions, got ${describeValue(value)} - kept ${fallback}`);
	return fallback;
}

function antiSlopModeValue(
	value: unknown,
	fallback: AntiSlopMode,
	file: string,
	problems: string[],
): AntiSlopMode {
	if (value === undefined) return fallback;
	if (value === "off" || value === "advisory" || value === "enforce") return value;
	problems.push(`${file}: antiSlop.mode must be "off", "advisory" or "enforce", got ${describeValue(value)} - kept ${JSON.stringify(fallback)}`);
	return fallback;
}

function nonNegativeNumberValue(
	value: unknown,
	fallback: number,
	file: string,
	key: string,
	problems: string[],
): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	problems.push(`${file}: ${key} must be a non-negative number, got ${describeValue(value)} - kept ${fallback}`);
	return fallback;
}

function optionalNonNegativeNumberValue(
	value: unknown,
	fallback: number | undefined,
	file: string,
	key: string,
	problems: string[],
): number | undefined {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	problems.push(
		`${file}: ${key} must be a non-negative number, got ${describeValue(value)} - kept ${fallback === undefined ? "unset" : fallback}`,
	);
	return fallback;
}

/** Read both configuration files and return the effective configuration with any problems found. */
export function loadJevConfig(options: { cwd: string; home?: string; read?: ConfigReader }): JevConfig {
	const read = options.read ?? readFileOrNull;
	let mutationGate = DEFAULT_CONFIG.gates.mutation;
	let completionGate = DEFAULT_CONFIG.gates.completion;
	let courseMode = DEFAULT_CONFIG.courseCheck.mode;
	let interval = DEFAULT_CONFIG.courseCheck.interval;
	let antiSlopMode = DEFAULT_CONFIG.antiSlop.mode;
	let billingBalance = DEFAULT_CONFIG.billing.balance;
	let inputCostPerMillion = DEFAULT_CONFIG.billing.inputCostPerMillion;
	let outputCostPerMillion = DEFAULT_CONFIG.billing.outputCostPerMillion;
	const problems: string[] = [];
	for (const path of configPaths(options)) {
		const text = read(path);
		if (text === null) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			problems.push(`${path}: not valid JSON (${reason}) - no values were changed`);
			continue;
		}
		const root = asRecord(parsed);
		if (root === undefined) {
			problems.push(`${path}: the top level must be a JSON object, got ${describeValue(parsed)} - no values were changed`);
			continue;
		}
		const gatesValue = root["gates"];
		const gates = asRecord(gatesValue);
		if (gatesValue !== undefined && gates === undefined) {
			problems.push(
				`${path}: gates must be a JSON object, got ${describeValue(gatesValue)} - kept gates.mutation=${mutationGate}, gates.completion=${completionGate}`,
			);
		} else {
			mutationGate = booleanValue(gates?.["mutation"], mutationGate, path, "gates.mutation", problems);
			completionGate = booleanValue(gates?.["completion"], completionGate, path, "gates.completion", problems);
		}
		const courseCheckValue = root["courseCheck"];
		const courseCheck = asRecord(courseCheckValue);
		if (courseCheckValue !== undefined && courseCheck === undefined) {
			problems.push(
				`${path}: courseCheck must be a JSON object, got ${describeValue(courseCheckValue)} - kept courseCheck.mode=${JSON.stringify(courseMode)}, courseCheck.interval=${interval}`,
			);
		} else {
			courseMode = courseModeValue(courseCheck?.["mode"], courseMode, path, problems);
			interval = intervalValue(courseCheck?.["interval"], interval, path, problems);
		}
		const antiSlopValue = root["antiSlop"];
		const antiSlop = asRecord(antiSlopValue);
		if (antiSlopValue !== undefined && antiSlop === undefined) {
			problems.push(
				`${path}: antiSlop must be a JSON object, got ${describeValue(antiSlopValue)} - kept antiSlop.mode=${JSON.stringify(antiSlopMode)}`,
			);
		} else {
			antiSlopMode = antiSlopModeValue(antiSlop?.["mode"], antiSlopMode, path, problems);
		}
		const billingValue = root["billing"];
		const billing = asRecord(billingValue);
		if (billingValue !== undefined && billing === undefined) {
			problems.push(
				`${path}: billing must be a JSON object, got ${describeValue(billingValue)} - kept billing.balance=${billingBalance === undefined ? "unset" : billingBalance}, billing.inputCostPerMillion=${inputCostPerMillion}, billing.outputCostPerMillion=${outputCostPerMillion}`,
			);
		} else {
			billingBalance = optionalNonNegativeNumberValue(billing?.["balance"], billingBalance, path, "billing.balance", problems);
			inputCostPerMillion = nonNegativeNumberValue(
				billing?.["inputCostPerMillion"],
				inputCostPerMillion,
				path,
				"billing.inputCostPerMillion",
				problems,
			);
			outputCostPerMillion = nonNegativeNumberValue(
				billing?.["outputCostPerMillion"],
				outputCostPerMillion,
				path,
				"billing.outputCostPerMillion",
				problems,
			);
		}
	}
	return {
		gates: { mutation: mutationGate, completion: completionGate },
		courseCheck: { mode: courseMode, interval },
		antiSlop: { mode: antiSlopMode },
		billing: {
			...(billingBalance === undefined ? {} : { balance: billingBalance }),
			inputCostPerMillion,
			outputCostPerMillion,
		},
		problems,
	};
}
