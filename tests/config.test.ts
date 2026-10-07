/**
 * Template-override config tests: load precedence, merge, fail-closed invalid cases,
 * defaults unchanged when absent (R1-R6).
 */
import { describe, expect, test } from "bun:test";
import {
	JevConfigError,
	loadJevTemplateConfig,
	mergeTemplateConfigs,
	validateTemplateConfig,
	type JevTemplateConfig,
} from "../src/config.js";

function loader(files: Record<string, string>) {
	return (p: string) => files[p];
}

const HOME = "/home/test";
const CWD = "/work/project";
const USER_FILE = `${HOME}/.omp/agent/jev.config.json`;
const PROJECT_FILE = `${CWD}/.omp/jev.config.json`;

describe("jev template config", () => {
	test("defaults unchanged when no files exist", () => {
		const cfg = loadJevTemplateConfig(CWD, HOME, loader({}));
		expect(cfg.stages).toBeUndefined();
		expect(cfg.confidenceThreshold).toBeUndefined();
		expect(cfg.capabilities).toBeUndefined();
	});

	test("project overrides user per-key; missing user file fine", () => {
		const cfg = loadJevTemplateConfig(
			CWD,
			HOME,
			loader({
				[USER_FILE]: JSON.stringify({
					stages: { completion_review: { instructions: "user wording" } },
					confidenceThreshold: 0.9,
					capabilities: ["a"],
				}),
				[PROJECT_FILE]: JSON.stringify({
					stages: { completion_review: { instructions: "project wording" } },
				}),
			}),
		);
		expect(cfg.stages?.completion_review?.instructions).toBe("project wording");
		expect(cfg.confidenceThreshold).toBe(0.9);
		expect(cfg.capabilities).toEqual(["a"]);
	});

	test("R4 trust split: project cannot replace user confidenceThreshold", () => {
		const cfg = loadJevTemplateConfig(
			CWD,
			HOME,
			loader({
				[USER_FILE]: JSON.stringify({ confidenceThreshold: 0.95 }),
				[PROJECT_FILE]: JSON.stringify({ confidenceThreshold: 0.81 }),
			}),
		);
		expect(cfg.confidenceThreshold).toBe(0.95);
	});

	test("fail-closed: invalid JSON names the file", () => {
		try {
			loadJevTemplateConfig(CWD, HOME, loader({ [PROJECT_FILE]: "{not json" }));
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(JevConfigError);
			expect((err as JevConfigError).file).toBe(PROJECT_FILE);
			expect((err as Error).message).toContain(PROJECT_FILE);
			expect((err as Error).message).toContain("invalid JSON");
		}
	});

	test("fail-closed: unknown stage key names file and key", () => {
		expect(() =>
			loadJevTemplateConfig(
				CWD,
				HOME,
				loader({ [PROJECT_FILE]: JSON.stringify({ stages: { nonsense_stage: {} } }) }),
			),
		).toThrow(/nonsense_stage/);
	});

	test("fail-closed: confidenceThreshold outside 0..1", () => {
		for (const bad of [-0.1, 1.5, "high"]) {
			expect(() =>
				validateTemplateConfig(PROJECT_FILE, { confidenceThreshold: bad }),
			).toThrow(JevConfigError);
		}
	});

	test("fail-closed: wrong types in stages", () => {
		expect(() =>
			validateTemplateConfig(PROJECT_FILE, { stages: { completion_review: { instructions: "" } } }),
		).toThrow(/instructions/);
		expect(() =>
			validateTemplateConfig(PROJECT_FILE, { stages: { completion_review: { options: [{ id: "a" }] } } }),
		).toThrow(/options/);
	});

	test("R3: options overrides need at least 2 unique-id options", () => {
		expect(() =>
			validateTemplateConfig(PROJECT_FILE, {
				stages: { completion_review: { options: [{ id: "a", label: "A", meaning: "m" }] } },
			}),
		).toThrow(/at least 2/);
		expect(() =>
			validateTemplateConfig(PROJECT_FILE, {
				stages: {
					completion_review: {
						options: [
							{ id: "a", label: "A", meaning: "m" },
							{ id: "a", label: "A2", meaning: "m2" },
						],
					},
				},
			}),
		).toThrow(/unique/);
	});

	test("fail-closed: capabilities must be non-empty strings", () => {
		expect(() => validateTemplateConfig(PROJECT_FILE, { capabilities: ["ok", ""] })).toThrow(/capabilities/);
	});

	test("controlPoints: on_demand accepted, gate triggers fail-closed naming file+key", () => {
		const cfg = validateTemplateConfig(PROJECT_FILE, {
			controlPoints: {
				risk_assessment: { trigger: "on_demand", instructions: "weigh blast radius" },
			},
		});
		expect(cfg.controlPoints?.risk_assessment?.trigger).toBe("on_demand");
		try {
			validateTemplateConfig(PROJECT_FILE, {
				controlPoints: { cut_files: { trigger: "mutation_gate" } },
			});
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(JevConfigError);
			expect((err as Error).message).toContain(PROJECT_FILE);
			expect((err as Error).message).toContain("cut_files");
			expect((err as Error).message).toContain("on_demand");
		}
	});

	test("merge is per-key and keeps untouched keys", () => {
		const user: JevTemplateConfig = {
			stages: {
				completion_review: { instructions: "u" },
				important_decision: { instructions: "keep" },
			},
			capabilities: ["x"],
		};
		const project: JevTemplateConfig = {
			stages: { completion_review: { options: [{ id: "a", label: "A", meaning: "m" }, { id: "b", label: "B", meaning: "n" }] } },
		};
		const merged = mergeTemplateConfigs(user, project);
		expect(merged.stages?.completion_review?.options?.length).toBe(2);
		expect(merged.stages?.completion_review?.instructions).toBeUndefined();
		expect(merged.stages?.important_decision?.instructions).toBe("keep");
		expect(merged.capabilities).toEqual(["x"]);
	});
});
