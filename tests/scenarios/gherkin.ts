/**
 * Minimal Gherkin parser: enough for the normative scenarios in `scenarios/` (Feature,
 * Background, Scenario, Scenario Outline plus one Examples table, tags and comments).
 * No third-party dependency and no step execution here.
 */

export interface ParsedStep {
	keyword: "Given" | "When" | "Then" | "And" | "But";
	text: string;
	line: number;
}

export interface ParsedScenario {
	id: string;
	name: string;
	tags: string[];
	steps: ParsedStep[];
	outline: boolean;
	line: number;
	/** One instance per Examples row, placeholders already substituted. */
	instances: Array<{ name: string; steps: ParsedStep[]; example?: Record<string, string> }>;
}

export interface ParsedFeature {
	name: string;
	tags: string[];
	background: ParsedStep[];
	scenarios: ParsedScenario[];
	file: string;
}

const STEP_KEYWORDS = ["Given", "When", "Then", "And", "But"] as const;

function splitTags(line: string): string[] {
	return line
		.trim()
		.split(/\s+/)
		.filter(token => token.startsWith("@"))
		.map(token => token.slice(1));
}

function substitute(steps: ParsedStep[], row: Record<string, string>): ParsedStep[] {
	return steps.map(step => ({
		...step,
		text: step.text.replace(/<([^>]+)>/g, (whole, key: string) => row[key] ?? whole),
	}));
}

/** Parse one feature file into its scenarios, expanding outlines into instances. */
export function parseFeature(text: string, file: string): ParsedFeature {
	const lines = text.split(/\r?\n/);
	let featureName = "";
	const featureTags: string[] = [];
	const background: ParsedStep[] = [];
	const scenarios: ParsedScenario[] = [];
	let pendingTags: string[] = [];
	let target: ParsedStep[] | undefined;
	let current: ParsedScenario | undefined;
	let examples: { header: string[]; rows: string[][] } | undefined;
	let inExamples = false;

	const finishScenario = (): void => {
		if (current === undefined) return;
		if (current.outline) {
			const table = examples;
			if (table === undefined || table.rows.length === 0) {
				current.instances = [{ name: current.name, steps: current.steps }];
			} else {
				current.instances = table.rows.map(row => {
					const values: Record<string, string> = {};
					table.header.forEach((header, index) => {
						values[header] = row[index] ?? "";
					});
					return {
						name: current!.name.replace(/<([^>]+)>/g, (whole, key: string) => values[key] ?? whole),
						steps: substitute(current!.steps, values),
						example: values,
					};
				});
			}
		} else {
			current.instances = [{ name: current.name, steps: current.steps }];
		}
		scenarios.push(current);
		current = undefined;
		examples = undefined;
		inExamples = false;
	};

	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		const number = index + 1;
		if (line.length === 0 || line.startsWith("#")) continue;
		if (line.startsWith("@")) {
			pendingTags = splitTags(line);
			continue;
		}
		if (line.startsWith("Feature:")) {
			featureName = line.slice("Feature:".length).trim();
			featureTags.push(...pendingTags);
			pendingTags = [];
			target = background;
			continue;
		}
		if (line.startsWith("Background:")) {
			target = background;
			continue;
		}
		if (line.startsWith("Scenario Outline:") || line.startsWith("Scenario:")) {
			finishScenario();
			const outline = line.startsWith("Scenario Outline:");
			const name = line.slice((outline ? "Scenario Outline:" : "Scenario:").length).trim();
			const idTag = pendingTags.find(tag => /^jev_[a-z0-9_]+_\d+[a-z]?$/.test(tag));
			current = {
				id: idTag ?? `line_${number}`,
				name,
				tags: pendingTags,
				steps: [],
				outline,
				line: number,
				instances: [],
			};
			pendingTags = [];
			target = current.steps;
			continue;
		}
		if (line.startsWith("Examples:")) {
			inExamples = true;
			examples = { header: [], rows: [] };
			continue;
		}
		if (line.startsWith("|")) {
			if (!inExamples || examples === undefined) continue;
			const cells = line
				.slice(1, line.endsWith("|") ? -1 : undefined)
				.split("|")
				.map(cell => cell.trim());
			if (examples.header.length === 0) examples.header = cells;
			else examples.rows.push(cells);
			continue;
		}
		const keyword = STEP_KEYWORDS.find(word => line.startsWith(`${word} `));
		if (keyword !== undefined && target !== undefined) {
			target.push({ keyword, text: line.slice(keyword.length + 1).trim(), line: number });
			continue;
		}
	}
	finishScenario();
	return { name: featureName, tags: featureTags, background, scenarios, file };
}
