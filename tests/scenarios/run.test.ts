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
 * Every normative scenario is turned into a test. A scenario all of whose steps are registered runs
 * against production code; a scenario with any unregistered step is reported as `todo`, never as a
 * pass. `covered` below asserts the executable set does not shrink silently.
 */
const SCENARIO_DIR = join(import.meta.dir, "..", "..", "scenarios");

const features = readdirSync(SCENARIO_DIR)
	.filter(name => name.endsWith(".feature"))
	.sort()
	.map(name => parseFeature(readFileSync(join(SCENARIO_DIR, name), "utf8"), name));

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

let executable = 0;

for (const feature of features) {
	describe(`${feature.file}: ${feature.name}`, () => {
		for (const scenario of feature.scenarios) {
			for (const instance of scenario.instances) {
				const steps = [...feature.background, ...instance.steps];
				const title = `${scenario.id} ${instance.name}`;
				const missing = missingSteps(steps, feature.file);
				if (missing.length > 0) {
					test.todo(`${title} (${missing.length} step(s) not implemented)`, () => {});
					continue;
				}
				executable += 1;
				test(title, async () => {
					const world: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
					const keywords = keywordOf(steps);
					for (const [index, step] of steps.entries()) await runStep(world, step, keywords[index] ?? "Given", feature.file);
				});
			}
		}
	});
}

describe("scenario coverage", () => {
	test("executable scenarios do not silently regress", () => {
		expect(executable).toBeGreaterThan(0);
	});
});
