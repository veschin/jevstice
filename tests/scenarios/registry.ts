/**
 * Step registry for the executable Gherkin scenarios. Steps are matched by text; `{string}` and
 * `{word}` are the only parameters. A step that matches nothing must fail the scenario: a
 * scenario is only covered when every one of its steps runs against production code.
 */

export type StepBody = (world: never, ...args: string[]) => void | Promise<void>;

type Keyword = "Given" | "When" | "Then";

interface RegisteredStep {
	keyword: Keyword;
	pattern: string;
	regex: RegExp;
	body: StepBody;
	/** Feature file this definition belongs to; unscoped definitions are shared across files. */
	scope?: string;
}

const registered: RegisteredStep[] = [];

function compile(pattern: string): RegExp {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const withString = escaped.replace(/\\\{string\\\}/g, '"([^"]*)"');
	const withWord = withString.replace(/\\\{word\\\}/g, "(\\S+)");
	return new RegExp(`^${withWord}$`);
}

function define(keyword: Keyword, pattern: string, body: StepBody, scope?: string): void {
	const clash = registered.some(step => step.keyword === keyword && step.pattern === pattern && step.scope === scope);
	if (clash) throw new Error(`duplicate step definition: ${keyword} ${pattern}${scope === undefined ? "" : ` in ${scope}`}`);
	registered.push({ keyword, pattern, regex: compile(pattern), body, ...(scope === undefined ? {} : { scope }) });
}

export const given = (pattern: string, body: StepBody): void => define("Given", pattern, body);
export const when = (pattern: string, body: StepBody): void => define("When", pattern, body);
export const then = (pattern: string, body: StepBody): void => define("Then", pattern, body);

/**
 * Step definitions for one feature file. The same sentence often means different things in two
 * features ("the judge is unavailable" drives re-aim in one and consult in another), so a scoped
 * definition wins for its own file and never collides with another file's wording.
 */
export function scoped(file: string): { given: typeof given; when: typeof when; then: typeof then } {
	return {
		given: (pattern, body) => define("Given", pattern, body, file),
		when: (pattern, body) => define("When", pattern, body, file),
		then: (pattern, body) => define("Then", pattern, body, file),
	};
}

/** Resolve one step line; the keyword (Given/When/Then/And/But) does not affect matching. */
export function resolveStep(
	keyword: Keyword,
	text: string,
	file?: string,
): { body: StepBody; args: string[] } | undefined {
	const matches = registered.filter(step => step.keyword === keyword && step.regex.test(text));
	// A definition written for this feature beats a shared one.
	const chosen = matches.find(step => file !== undefined && step.scope === file) ?? matches.find(step => step.scope === undefined);
	if (chosen === undefined) return undefined;
	const match = chosen.regex.exec(text);
	return match === null ? undefined : { body: chosen.body, args: match.slice(1) };
}

export function registeredPatterns(): string[] {
	return registered.map(step => `${step.keyword} ${step.pattern}`);
}
