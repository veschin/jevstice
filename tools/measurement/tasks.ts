/**
 * The fixed task set of the with/without measurement, as data only (no harness logic), so each
 * task's check files can be validated on their own against a known-correct and a known-wrong
 * solution without running a single omp session.
 */

// The fixed task set. Each task: verbatim prompt (identical for both arms), the files written
// into the scratch directory BEFORE the run, the check files written AFTER the run (so the
// agent can never see or satisfy them by accident), the check commands, and the files whose
// setup-time digest must not change (task 2: the test itself is correct, only the source is buggy).
// ---------------------------------------------------------------------------

export interface CheckSpec {
	/** Human label printed in the evidence log. */
	id: string;
	cmd: string[];
	expectExit: number;
}

export interface TaskDef {
	id: string;
	title: string;
	prompt: string;
	setup: Record<string, string>;
	checkFiles: Record<string, string>;
	checks: CheckSpec[];
	frozen: string[];
	/** What "satisfies the task" means, checkably (stated in the evidence log and to the judge). */
	acceptance: string;
}

const PKG_JSON = `${JSON.stringify({ name: "measure-task", type: "module", private: true }, null, 2)}\n`;

/** The correct, must-not-be-modified test of the median task; the check embeds it verbatim. */
export const MEDIAN_TEST_SRC = `import { expect, test } from "bun:test";
import { median } from "./stats";

test("odd length returns the middle value", () => {
	expect(median([3, 1, 2])).toBe(2);
});

test("even length returns the mean of the two middle values", () => {
	expect(median([1, 2, 3, 4])).toBe(2.5);
	expect(median([4, 2, 1, 3])).toBe(2.5);
});

test("single element is itself", () => {
	expect(median([7])).toBe(7);
});

test("empty input is zero", () => {
	expect(median([])).toBe(0);
});
`;

export const TASKS: TaskDef[] = [
	{
		id: "slug",
		title: "add a function with a test and make the test pass",
		acceptance:
			"src/slug.ts exists and exports slug(); slug() matches the quoted rules on the check inputs; src/slug.test.ts exists with >= 5 test cases; `bun test` exits 0.",
		prompt: [
			"Task: implement a slug function, with tests.",
			"",
			"In this directory create `src/slug.ts` exporting exactly this function:",
			"",
			"    export function slug(input: string): string",
			"",
			"Behaviour, applied in this order:",
			"1. lower-case the whole input;",
			"2. replace every character that is not a-z or 0-9 with a single '-';",
			"3. collapse every run of '-' into one '-';",
			"4. remove leading and trailing '-';",
			"5. an input with no a-z/0-9 character yields the empty string.",
			"",
			"Also create `src/slug.test.ts` using bun:test, with at least 5 test cases. Cover at least:",
			'  "Hello World" -> "hello-world"',
			'  "  Foo   Bar  " -> "foo-bar"',
			'  "A+B & C" -> "a-b-c"',
			'  "---" -> ""',
			'  "" -> ""',
			"",
			"Run the tests and make them pass. Finish by reporting the exact command you ran and its output.",
		].join("\n"),
		setup: { "package.json": PKG_JSON },
		checkFiles: {
			".measure-check-slug.ts": `import { existsSync, readFileSync } from "node:fs";
const fails: string[] = [];
let slug: ((s: string) => string) | undefined;
try {
  // Dynamic import is required: the module under test may not exist, and that must be reported
  // as a failed check rather than crashing the check script before it can print why.
  const mod = await import("./src/slug.ts");
  slug = mod.slug;
} catch (err) {
  fails.push("cannot import ./src/slug.ts: " + (err instanceof Error ? err.message : String(err)));
}
if (typeof slug !== "function") {
  fails.push("src/slug.ts does not export a function named slug");
} else {
  const cases: Array<[string, string]> = [
    ["Hello World", "hello-world"],
    ["  Foo   Bar  ", "foo-bar"],
    ["A+B & C", "a-b-c"],
    ["---", ""],
    ["", ""],
    ["Plain", "plain"],
  ];
  for (const [input, expected] of cases) {
    let got: unknown;
    try { got = slug(input); } catch (err) { got = "THREW: " + (err instanceof Error ? err.message : String(err)); }
    if (got !== expected) fails.push(JSON.stringify(input) + " -> " + JSON.stringify(got) + ", expected " + JSON.stringify(expected));
  }
}
if (!existsSync("src/slug.test.ts")) {
  fails.push("src/slug.test.ts is missing");
} else {
  const src = readFileSync("src/slug.test.ts", "utf8");
  const n = (src.match(/\\b(?:test|it)\\(/g) ?? []).length;
  if (n < 5) fails.push("src/slug.test.ts has " + n + " test cases, need >= 5");
}
if (fails.length > 0) { console.log("CHECK FAIL"); for (const f of fails) console.log(" - " + f); process.exit(1); }
console.log("CHECK PASS: slug() matches the quoted rules on 6 inputs; src/slug.test.ts present with >= 5 cases");
`,
		},
		checks: [
			{ id: "external-behaviour+test-file", cmd: ["bun", ".measure-check-slug.ts"], expectExit: 0 },
			{ id: "agent-tests-pass", cmd: ["bun", "test"], expectExit: 0 },
		],
		frozen: [],
	},
	{
		id: "median",
		title: "fix a failing test without touching the test",
		acceptance:
			"`bun test` exits 0; src/stats.test.ts is byte-identical to its setup state; median() matches the quoted values on the external assertions (incl. even-length averages and no input mutation).",
		prompt: [
			"Task: make the failing test suite pass.",
			"",
			"`bun test` currently fails in this directory. Find the cause and fix the bug in `src/stats.ts`.",
			"`src/stats.test.ts` is correct as written: do not modify it in any way.",
			"",
			"When the suite passes, run `bun test` once more and report the exact command and its output in your final message.",
		].join("\n"),
		setup: {
			"package.json": PKG_JSON,
			"src/stats.ts": `/** Small numeric helpers. */
export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}
`,
			"src/stats.test.ts": MEDIAN_TEST_SRC,
		},
		checkFiles: {
			".measure-check-median.ts": `import { readFileSync } from "node:fs";
const fails: string[] = [];
let median: ((v: number[]) => number) | undefined;
try {
  // Dynamic import is required: the module under test may not exist, and that must be reported
  // as a failed check rather than crashing the check script before it can print why.
  const mod = await import("./src/stats.ts");
  median = mod.median;
} catch (err) {
  fails.push("cannot import ./src/stats.ts: " + (err instanceof Error ? err.message : String(err)));
}
if (typeof median !== "function") {
  fails.push("src/stats.ts does not export a function named median");
} else {
  const cases: Array<[number[], number]> = [
    [[1, 2, 3, 4], 2.5],
    [[4, 2, 1, 3], 2.5],
    [[3, 1, 2], 2],
    [[7], 7],
    [[], 0],
  ];
  for (const [input, expected] of cases) {
    let got: unknown;
    try { got = median([...input]); } catch (err) { got = "THREW: " + (err instanceof Error ? err.message : String(err)); }
    if (got !== expected) fails.push("median(" + JSON.stringify(input) + ") -> " + JSON.stringify(got) + ", expected " + expected);
  }
  const input = [3, 1, 2];
  median(input);
  if (JSON.stringify(input) !== JSON.stringify([3, 1, 2])) fails.push("median mutates its input array: " + JSON.stringify(input));
}
const expectedTest = ${JSON.stringify(MEDIAN_TEST_SRC)};
try {
  const now = readFileSync("src/stats.test.ts", "utf8");
  if (now !== expectedTest) fails.push("src/stats.test.ts was modified (it must stay byte-identical)");
} catch (err) {
  fails.push("src/stats.test.ts unreadable: " + (err instanceof Error ? err.message : String(err)));
}
if (fails.length > 0) { console.log("CHECK FAIL"); for (const f of fails) console.log(" - " + f); process.exit(1); }
console.log("CHECK PASS: median() matches the 5 assertions, does not mutate its input, and src/stats.test.ts is unmodified");
`,
		},
		checks: [
			{ id: "external-behaviour+test-unmodified", cmd: ["bun", ".measure-check-median.ts"], expectExit: 0 },
			{ id: "agent-tests-pass", cmd: ["bun", "test"], expectExit: 0 },
		],
		frozen: ["src/stats.test.ts"],
	},
	{
		id: "transform",
		title: "write a small script that transforms a sample input",
		acceptance:
			"transform.ts exists and runs; out.json parses to a JSON object with exactly the keys \"fruit\" and \"veg\" (alphabetical) and the numeric values 13 and 12; whitespace and formatting inside the file are NOT part of the requirement; re-running the script reproduces the same file.",
		prompt: [
			"Task: write a small data transform.",
			"",
			"This directory contains `sample.csv`. Write a Bun script `transform.ts` that reads `sample.csv`",
			"and writes `out.json`: a JSON object mapping each distinct `category` to the sum of the `amount`",
			"values in that category. Amounts must be JSON numbers, not strings. Keys must be sorted",
			"alphabetically. The file must end with a single trailing newline.",
			"",
			"Run the script once so that `out.json` exists in the directory, then report its exact contents",
			"and the command you ran in your final message.",
		].join("\n"),
		setup: {
			"package.json": PKG_JSON,
			"sample.csv": [
				"id,category,amount",
				"1,fruit,10",
				"2,veg,5",
				"3,fruit,2.5",
				"4,veg,7",
				"5,fruit,0.5",
				"",
			].join("\n"),
		},
		checkFiles: {
			".measure-check-transform.ts": `import { existsSync, readFileSync } from "node:fs";
const fails: string[] = [];
const expected = { fruit: 13, veg: 12 };
function readOut(label: string): Record<string, unknown> | undefined {
  if (!existsSync("out.json")) { fails.push(label + ": out.json is missing"); return undefined; }
  try {
    const parsed = JSON.parse(readFileSync("out.json", "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { fails.push(label + ": out.json is not a JSON object"); return undefined; }
    return parsed as Record<string, unknown>;
  } catch (err) { fails.push(label + ": out.json is not valid JSON: " + (err instanceof Error ? err.message : String(err))); return undefined; }
}
const first = readOut("first read");
if (first !== undefined) {
  const keys = Object.keys(first);
  if (JSON.stringify(keys) !== JSON.stringify(["fruit", "veg"])) fails.push("first read: keys are " + JSON.stringify(keys) + ", expected [\\"fruit\\",\\"veg\\"] (sorted)");
  for (const [k, v] of Object.entries(expected)) {
    if (first[k] !== v) fails.push("first read: " + k + " is " + JSON.stringify(first[k]) + ", expected " + v + " (a number)");
  }
}
if (!existsSync("transform.ts")) {
  fails.push("transform.ts is missing");
} else {
  const proc = Bun.spawnSync(["bun", "transform.ts"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) fails.push("re-running 'bun transform.ts' exited " + proc.exitCode + ": " + proc.stderr.toString().slice(0, 400));
  const second = readOut("second read (after re-run)");
  if (second !== undefined && JSON.stringify(second) !== JSON.stringify(first)) fails.push("second read: re-running the script changed out.json (" + JSON.stringify(second) + " vs " + JSON.stringify(first) + ")");
}
if (fails.length > 0) { console.log("CHECK FAIL"); for (const f of fails) console.log(" - " + f); process.exit(1); }
console.log("CHECK PASS: out.json is exactly " + JSON.stringify(expected) + " with sorted numeric keys, and re-running transform.ts reproduces it");
`,
		},
		checks: [{ id: "external-out.json+rerun", cmd: ["bun", ".measure-check-transform.ts"], expectExit: 0 }],
		frozen: [],
	},
];
