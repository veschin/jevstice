/**
 * Jev template-override configuration.
 *
 * Location precedence (project wins per-key over user):
 *   1. <cwd>/.omp/jev.config.json
 *   2. ~/.omp/agent/jev.config.json
 *
 * Invalid file (bad JSON, wrong types, confidenceThreshold outside 0..1, unknown stage key)
 * => JevConfigError naming file + problem. Callers MUST refuse to register the decision tool;
 * silent fallback to defaults is forbidden.
 */
import * as fs from "node:fs";
import { isRecord, nonEmptyString } from "./guards.js";
import { validateDeclaredControlPoint } from "./control-points.js";
import { STAGES } from "./stages.js";

export interface StageTemplate {
	/** Extra instructions prepended to the judge request for this stage. */
	instructions?: string;
	/** Fixed option set replacing the executor's options for this stage. */
	options?: Array<{ id: string; label: string; meaning: string }>;
}

export interface JevTemplateConfig {
	stages?: Record<string, StageTemplate>;
	/** Overrides POLICY.minConfidenceToApprove when within 0..1. */
	confidenceThreshold?: number;
	/** Default capability inventory applied when a submission omits capabilities. */
	capabilities?: string[];
	/**
	 * Config-declared on_demand control points (roadmap: gate triggers rejected fail-closed).
	 * They actually fire through submitDecision: advisory (record + feedback + bounded rework),
	 * never gate-granting.
	 */
	controlPoints?: Record<
		string,
		{ trigger: "on_demand"; instructions?: string; options?: Array<{ id: string; label: string; meaning: string }> }
	>;
}

export class JevConfigError extends Error {
	constructor(
		readonly file: string,
		problem: string,
	) {
		super(`jev config ${file}: ${problem}`);
	}
}

function parseStageTemplate(file: string, where: string, raw: unknown): StageTemplate {
	if (!isRecord(raw)) throw new JevConfigError(file, `${where} must be an object`);
	const out: StageTemplate = {};
	if (raw["instructions"] !== undefined) {
		if (!nonEmptyString(raw["instructions"])) {
			throw new JevConfigError(file, `${where}.instructions must be a non-empty string`);
		}
		out.instructions = raw["instructions"] as string;
	}
	if (raw["options"] !== undefined) {
		const opts = raw["options"];
		if (!Array.isArray(opts) || opts.length < 2) {
			throw new JevConfigError(file, `${where}.options must be an array of at least 2 options`);
		}
		out.options = opts.map((o, i) => {
			if (!isRecord(o) || !nonEmptyString(o["id"]) || !nonEmptyString(o["label"]) || !nonEmptyString(o["meaning"])) {
				throw new JevConfigError(file, `${where}.options[${i}] must have non-empty id, label and meaning`);
			}
			return { id: o["id"] as string, label: o["label"] as string, meaning: o["meaning"] as string };
		});
		const ids = new Set(out.options.map(o => o.id));
		if (ids.size !== out.options.length) {
			throw new JevConfigError(file, `${where}.options ids must be unique`);
		}
	}
	return out;
}

/** Validate one parsed config object; throws JevConfigError naming file + problem. */
export function validateTemplateConfig(file: string, raw: unknown): JevTemplateConfig {
	if (!isRecord(raw)) throw new JevConfigError(file, "top level must be a JSON object");
	const out: JevTemplateConfig = {};
	if (raw["stages"] !== undefined) {
		if (!isRecord(raw["stages"])) throw new JevConfigError(file, "stages must be an object keyed by stage name");
		const stages: Record<string, StageTemplate> = {};
		for (const [stage, value] of Object.entries(raw["stages"])) {
			if (!STAGES.has(stage)) {
				throw new JevConfigError(file, `unknown stage key "${stage}" (known: ${[...STAGES].join(", ")})`);
			}
			stages[stage] = parseStageTemplate(file, `stages.${stage}`, value);
		}
		out.stages = stages;
	}
	if (raw["confidenceThreshold"] !== undefined) {
		const t = raw["confidenceThreshold"];
		if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
			throw new JevConfigError(file, "confidenceThreshold must be a number in 0..1");
		}
		out.confidenceThreshold = t;
	}
	if (raw["controlPoints"] !== undefined) {
		if (!isRecord(raw["controlPoints"])) {
			throw new JevConfigError(file, "controlPoints must be an object keyed by stage name");
		}
		const points: JevTemplateConfig["controlPoints"] = {};
		for (const [stage, value] of Object.entries(raw["controlPoints"])) {
			if (!isRecord(value) || value["trigger"] !== "on_demand") {
				throw new JevConfigError(
					file,
					`controlPoints.${stage} must declare trigger "on_demand" (gate triggers are a roadmap item)`,
				);
			}
			// Structural naming/collision rules from the registry (throws with named problem).
			validateDeclaredControlPoint(stage, value);
			const parsed = parseStageTemplate(file, `controlPoints.${stage}`, value);
			points[stage] = { trigger: "on_demand", instructions: parsed.instructions, options: parsed.options };
		}
		out.controlPoints = points;
	}
	if (raw["capabilities"] !== undefined) {
		const caps = raw["capabilities"];
		if (!Array.isArray(caps) || caps.some(c => !nonEmptyString(c))) {
			throw new JevConfigError(file, "capabilities must be an array of non-empty strings");
		}
		out.capabilities = caps as string[];
	}
	return out;
}

/** Per-key merge; project values win over user values for the same key. */
export function mergeTemplateConfigs(user: JevTemplateConfig, project: JevTemplateConfig): JevTemplateConfig {
	return {
		stages:
			user.stages === undefined && project.stages === undefined
				? undefined
				: { ...(user.stages ?? {}), ...(project.stages ?? {}) },
		// R4 trust split: the approval floor is USER-owned; a project file cannot replace it.
		// (R1 additionally clamps the effective value to max(POLICY.minConfidenceToApprove, x).)
		confidenceThreshold: user.confidenceThreshold ?? project.confidenceThreshold,
		capabilities: project.capabilities ?? user.capabilities,
		controlPoints:
			user.controlPoints === undefined && project.controlPoints === undefined
				? undefined
				: { ...(user.controlPoints ?? {}), ...(project.controlPoints ?? {}) },
	};
}

function readJsonIfExists(path: string, readFile: (p: string) => string | undefined): unknown {
	const text = readFile(path);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch (err) {
		throw new JevConfigError(path, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export interface TemplateLoadPaths {
	projectFile: string;
	userFile: string;
}

export function templateLoadPaths(cwd: string, home: string): TemplateLoadPaths {
	return {
		projectFile: `${cwd}/.omp/jev.config.json`,
		userFile: `${home}/.omp/agent/jev.config.json`,
	};
}

/**
 * Load and merge template config. Missing files are fine (defaults apply);
 * present-but-invalid files throw JevConfigError (fail-closed, never silent defaults).
 */
export function loadJevTemplateConfig(
	cwd: string,
	home: string,
	readFile: (p: string) => string | undefined = defaultReadFile,
): JevTemplateConfig {
	const paths = templateLoadPaths(cwd, home);
	const userRaw = readJsonIfExists(paths.userFile, readFile);
	const projectRaw = readJsonIfExists(paths.projectFile, readFile);
	const user = userRaw === undefined ? {} : validateTemplateConfig(paths.userFile, userRaw);
	const project = projectRaw === undefined ? {} : validateTemplateConfig(paths.projectFile, projectRaw);
	return mergeTemplateConfigs(user, project);
}

function defaultReadFile(path: string): string | undefined {
	// Synchronous, bounded read; missing file is the normal case.
	try {
		return fs.readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}
