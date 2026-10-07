/**
 * Config merge regressions (live defect 2026-10-08): a user file that defines only the gate
 * switches silently dropped a project's destructive patterns, so the gate could not be armed from a
 * project config at all. The merge is per key now; patterns are a union.
 */
import { describe, expect, test } from "bun:test";
import { mergeTemplateConfigs } from "../src/config.js";

describe("config merge: gates and routing are per key, never whole-object", () => {
	test("a user file defining only the switches does not drop a project's destructive patterns", () => {
		const merged = mergeTemplateConfigs(
			{ gates: { mutation: false, completion: false } },
			{ gates: { destructive: { patterns: ["rm -rf"] } } },
		);
		expect(merged.gates?.mutation).toBe(false);
		expect(merged.gates?.completion).toBe(false);
		expect(merged.gates?.destructive?.patterns).toEqual(["rm -rf"]);
	});

	test("patterns are a union: a project may add, never remove the user's", () => {
		const merged = mergeTemplateConfigs(
			{ gates: { destructive: { patterns: ["git push --force"] } } },
			{ gates: { destructive: { patterns: ["rm -rf", "git push --force"] } } },
		);
		expect(merged.gates?.destructive?.patterns).toEqual(["git push --force", "rm -rf"]);
	});

	test("the switches stay user-owned when both files set them", () => {
		const merged = mergeTemplateConfigs(
			{ gates: { mutation: false } },
			{ gates: { mutation: true, completion: true } },
		);
		expect(merged.gates?.mutation).toBe(false);
		expect(merged.gates?.completion).toBe(true);
	});

	test("a user routing list does not drop a different list a project supplies", () => {
		const skills = [{ id: "s", label: "S", meaning: "m" }];
		const models = [{ id: "mod", label: "M", meaning: "m" }];
		const merged = mergeTemplateConfigs({ routing: { skills } }, { routing: { models } });
		expect(merged.routing?.skills).toEqual(skills);
		expect(merged.routing?.models).toEqual(models);
	});

	test("both files absent leaves the block absent", () => {
		const merged = mergeTemplateConfigs({}, {});
		expect(merged.gates).toBeUndefined();
		expect(merged.routing).toBeUndefined();
	});
});
