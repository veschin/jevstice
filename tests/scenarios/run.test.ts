import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFeature, type ParsedStep } from "./gherkin.js";
import { resolveStep } from "./registry.js";

// Step files are a runtime registry: each scenario file owns one module, and new files must load
// without editing this runner. That is why the import is dynamic and directory-driven.
const STEPS_DIR = join(import.meta.dir, "steps");
for (const name of readdirSync(STEPS_DIR).filter(entry => entry.endsWith(".ts")).sort()) {
	await import(pathToFileURL(join(STEPS_DIR, name)).href);
}

/**
 * Every scenario instance is turned into a test. An instance whose steps are all registered runs
 * against production code. A missing step fails the suite unless the scenario id is listed in
 * `KNOWN_UNSUPPORTED`, and that list is exact: an allowlisted scenario that becomes executable is
 * an error, not a silent pass. The contract tests below additionally keep whole features and
 * scenario identities from disappearing without an explicit edit to this file.
 */
const SCENARIO_DIR = join(import.meta.dir, "..", "..", "scenarios");

const features = readdirSync(SCENARIO_DIR)
	.filter(name => name.endsWith(".feature"))
	.sort()
	.map(name => parseFeature(readFileSync(join(SCENARIO_DIR, name), "utf8"), name));

/**
 * The only scenarios allowed to remain unimplemented. Each entry names the exact feature and the
 * observable reason the host boundary is absent. Keep this list minimal and delete an entry as
 * soon as its steps exist; the allowlist-equality test makes a stale entry fail.
 */
const KNOWN_UNSUPPORTED: Record<string, { file: string; reason: string }> = {
	jev_plan_review_13: {
		file: "jev_plan_review.feature",
		reason: "no native host plan-mode boundary hook is registered; plan review reads a local:// artifact",
	},
	jev_owner_followup_12: {
		file: "jev_owner_followup.feature",
		reason: "ordinary session state is session-local; no native session-journal restore is implemented",
	},
};

/** A removed feature would otherwise vanish from the suite without any test noticing. */
const REQUIRED_FEATURES = [
	"jev_acceptance.feature",
	"jev_anti_slop.feature",
	"jev_autonomy.feature",
	"jev_configuration.feature",
	"jev_consult.feature",
	"jev_context.feature",
	"jev_course_check.feature",
	"jev_diagnostics.feature",
	"jev_owner_followup.feature",
	"jev_plan_review.feature",
	"jev_reaim.feature",
	"jev_requirements.feature",
	"jev_review.feature",
	"jev_search_relevance.feature",
	"jev_session_mode.feature",
	"jev_text_review.feature",
	"jev_triage.feature",
] as const;

/**
 * Floors, not exact counts: adding a scenario needs no edit here, while deleting one does. The
 * numbers describe scenario declarations, not Examples rows or step wording.
 */
const MINIMUM_SCENARIOS: Record<string, number> = {
	"jev_acceptance.feature": 15,
	"jev_anti_slop.feature": 18,
	"jev_autonomy.feature": 20,
	"jev_configuration.feature": 12,
	"jev_consult.feature": 10,
	"jev_context.feature": 11,
	"jev_course_check.feature": 11,
	"jev_diagnostics.feature": 16,
	"jev_owner_followup.feature": 14,
	"jev_plan_review.feature": 14,
	"jev_reaim.feature": 9,
	"jev_requirements.feature": 11,
	"jev_review.feature": 9,
	"jev_search_relevance.feature": 7,
	"jev_session_mode.feature": 12,
	"jev_text_review.feature": 9,
	"jev_triage.feature": 12,
};

type Keyword = "Given" | "When" | "Then";

/** And/But inherit the previous concrete keyword; that is how Gherkin reads them. */
function keywordOf(steps: ParsedStep[]): Keyword[] {
	let current: Keyword = "Given";
	return steps.map(step => {
		if (step.keyword === "When" || step.keyword === "Then") current = step.keyword;
		if (step.keyword === "Given") current = "Given";
		return current;
	});
}

function missingSteps(steps: ParsedStep[], file: string): string[] {
	const keywords = keywordOf(steps);
	return steps
		.filter((step, index) => resolveStep(keywords[index] ?? "Given", step.text, file) === undefined)
		.map((step, index) => `${keywords[index] ?? "Given"} ${step.text}`);
}

function runStep(world: object, step: ParsedStep, keyword: Keyword, file: string): Promise<void> | void {
	const resolved = resolveStep(keyword, step.text, file);
	if (resolved === undefined) throw new Error(`no step definition for: ${keyword} ${step.text}`);
	return resolved.body(world as never, ...resolved.args);
}

const missingById = new Map<string, Set<string>>();
const executableByFeature = new Map<string, number>();
let executable = 0;

for (const feature of features) {
	for (const scenario of feature.scenarios) {
		for (const instance of scenario.instances) {
			const missing = missingSteps([...feature.background, ...instance.steps], feature.file);
			if (missing.length === 0) continue;
			const seen = missingById.get(scenario.id) ?? new Set<string>();
			for (const step of missing) seen.add(step);
			missingById.set(scenario.id, seen);
		}
	}
}

for (const feature of features) {
	describe(`${feature.file}: ${feature.name}`, () => {
		for (const scenario of feature.scenarios) {
			for (const instance of scenario.instances) {
				const steps = [...feature.background, ...instance.steps];
				const title = `${scenario.id} ${instance.name}`;
				const missing = missingSteps(steps, feature.file);
				if (missing.length > 0) {
					const allowlisted = KNOWN_UNSUPPORTED[scenario.id];
					if (allowlisted !== undefined) {
						test.todo(`${title} (known unsupported: ${allowlisted.reason})`, () => {});
						continue;
					}
					test(title, () => {
						throw new Error(
							`Unimplemented scenario steps in ${feature.file}:\n${missing.map(step => `  - ${step}`).join("\n")}\n` +
							`Define the step(s), or add ${scenario.id} to KNOWN_UNSUPPORTED only when the host boundary truly does not exist.`,
						);
					});
					continue;
				}
				executable += 1;
				executableByFeature.set(feature.file, (executableByFeature.get(feature.file) ?? 0) + 1);
				test(title, async () => {
					const world: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
					const keywords = keywordOf(steps);
					for (const [index, step] of steps.entries()) await runStep(world, step, keywords[index] ?? "Given", feature.file);
				});
			}
		}
	});
}

describe("scenario contract", () => {
	test("every required feature file is still present", () => {
		const present = new Set(features.map(feature => feature.file));
		expect(REQUIRED_FEATURES.filter(name => !present.has(name))).toEqual([]);
	});

	test("every feature keeps at least one executable scenario", () => {
		const lost = features.filter(feature => (executableByFeature.get(feature.file) ?? 0) === 0).map(feature => feature.file);
		expect(lost).toEqual([]);
	});

	test("every scenario has an explicit, feature-scoped, unique id", () => {
		const malformed: string[] = [];
		const seen = new Map<string, string>();
		for (const feature of features) {
			const prefix = `${feature.file.replace(/\.feature$/, "")}_`;
			for (const scenario of feature.scenarios) {
				const where = `${feature.file}:${scenario.line}`;
				if (!/^jev_[a-z0-9_]+_\d+[a-z]?$/.test(scenario.id) || !scenario.id.startsWith(prefix)) {
					malformed.push(`${where} has id '${scenario.id}', expected ${prefix}<number>`);
				}
				const previous = seen.get(scenario.id);
				if (previous !== undefined) malformed.push(`${previous} and ${where} share id '${scenario.id}'`);
				else seen.set(scenario.id, where);
			}
		}
		expect(malformed).toEqual([]);
	});

	test("scenario counts do not silently shrink", () => {
		const shrunk = features
			.filter(feature => feature.scenarios.length < (MINIMUM_SCENARIOS[feature.file] ?? 0))
			.map(feature => `${feature.file}: ${feature.scenarios.length} < ${MINIMUM_SCENARIOS[feature.file]}`);
		expect(shrunk).toEqual([]);
	});

	test("the unsupported allowlist is exactly the unimplemented set", () => {
		const unimplemented = [...missingById.keys()].sort();
		expect(unimplemented).toEqual(Object.keys(KNOWN_UNSUPPORTED).sort());
	});

	test("@pending marks exactly the allowlisted scenarios", () => {
		const pending = features
			.flatMap(feature => feature.scenarios)
			.filter(scenario => scenario.tags.includes("pending"))
			.map(scenario => scenario.id)
			.sort();
		expect(pending).toEqual(Object.keys(KNOWN_UNSUPPORTED).sort());
	});

	test("an allowlist entry is a real, correctly located unsupported scenario", () => {
		const problems: string[] = [];
		for (const [id, entry] of Object.entries(KNOWN_UNSUPPORTED)) {
			const matches = features.flatMap(feature => feature.scenarios.map(scenario => ({ feature, scenario })))
				.filter(item => item.scenario.id === id);
			if (matches.length !== 1) {
				problems.push(`${id} appears ${matches.length} times; expected exactly one scenario`);
				continue;
			}
			const found = matches[0]!;
			if (found.feature.file !== entry.file) problems.push(`${id} is in ${found.feature.file}, allowlist says ${entry.file}`);
			if (!found.scenario.tags.includes("pending")) problems.push(`${id} lacks the @pending tag`);
			if (!missingById.has(id)) problems.push(`${id} is now executable; remove it from KNOWN_UNSUPPORTED`);
		}
		expect(problems).toEqual([]);
	});

	test("executable scenarios do not silently regress", () => {
		expect(executable).toBeGreaterThan(0);
	});
});
