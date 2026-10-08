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

/**
 * One checkable requirement of a task. The drift set declares these so the harness can report, per
 * requirement, whether each arm kept it: every requirement must be covered by a machine-readable
 * `REQ <id> PASS|FAIL` line in a check script's output (no judge involved).
 */
export interface RequirementSpec {
	id: string;
	text: string;
	/** deliverable = the asked work; constraint = leave-something-alone; deferred = a plausible extra NOT to build. */
	kind: "deliverable" | "constraint" | "deferred";
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
	/** Declared requirements (drift set); each must be reported by a check's `REQ` line. */
	requirements?: RequirementSpec[];
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

// ---------------------------------------------------------------------------
// Drift task set. Same protocol, different class of task: one prompt with six requirements that
// must all be held at once, a data/edge detail that a careless run silently mis-handles, an exact
// output format, a CLI flag, a deferred feature the prompt forbids (the distractor a careless run
// over-delivers on) and a leave-it-alone constraint. Every requirement is checked by a machine
// verdict in a check script (`REQ <id> PASS|FAIL`), so "kept" and "dropped" are objective and the
// judge never decides them. Drift indicators the log also records: turns, tool calls, whether the
// model had to re-run its own tests, and how many judge consultations the addon arm made.
// ---------------------------------------------------------------------------

const DRIFT_PKG = `${JSON.stringify({ name: "drift-task", type: "module", private: true }, null, 2)}\n`;

export const ITEMS_SRC = `export interface Item {
	id: string;
	label: string;
	qty: number;
}

export function totalQty(items: Item[]): number {
	return items.reduce((sum, item) => sum + item.qty, 0);
}
`;

export const ITEMS_TEST_SRC = `import { expect, test } from "bun:test";
import { totalQty } from "./items";

test("sums the quantities", () => {
	expect(totalQty([{ id: "a", label: "A", qty: 2 }, { id: "b", label: "B", qty: 3 }])).toBe(5);
});

test("an empty list is zero", () => {
	expect(totalQty([])).toBe(0);
});
`;

/** Frozen documentation of the merge task: must stay byte-identical. */
export const DRIFT_NOTES_SRC = `# Store notes

The item store keeps ids unique by construction; merging duplicate ids is handled by callers today.
`;

const DRIFT_DATA_CSV = `id,category,note,amount
1,fruit,"fresh, ripe",10
2,veg,plain,5
3,fruit,"old, soft",2.5
4,veg,plain,
5,fruit,plain,0.5
6,fruit,"new, firm",3
7,veg,plain,2
`;

const DRIFT_EVENTS_JSONL = `{"id":"e1","kind":"read","durationMs":12}
{"id":"e2","kind":"write","durationMs":240}
{"id":"e3","kind":"read","durationMs":180}
this line is not JSON at all
{"id":"e5","kind":"delete","durationMs":90}
{"kind":"write","durationMs":10}
{"id":"e6","kind":"write","durationMs":300}
{"id":"e7","kind":"delete","durationMs":45}
`;

// ---------------------------------------------------------------------------
// Horizon task set. Same protocol, a longer horizon: eight requirements each, several files, one
// requirement that can only be honoured by reading the shipped spec (a detail the prompt does NOT
// repeat), one requirement that pulls against an earlier one so keeping both needs care, the
// existing module contract to preserve, and a deferred feature the prompt forbids. Every
// requirement is still a machine verdict in a check script; the judge decides nothing.
// ---------------------------------------------------------------------------

const HORIZON_PKG = `${JSON.stringify({ name: "horizon-task", type: "module", private: true }, null, 2)}\n`;

/** The authoritative spec of the first horizon task: R2/R3/R4 details exist only here. */
export const HORIZON_API_SPEC = `# Record parser spec

## Line format

A line is \`kind|value|tags\`: three fields separated by \`|\`. \`tags\` is a comma-separated list and
may be empty. \`value\` must parse as a finite number.

## Kind table

| wire token | kind name    |
| ---------- | ------------ |
| TEMP       | temperature  |
| HUM        | humidity     |
| PRES       | pressure     |

A wire token that is not in this table is an *unknown kind*. An unknown kind is reported in the
parsed record with the kind name \`unknown\`; in strict mode it is an error instead.

## Errors

Errors thrown by the parser carry a machine-readable \`code\` property:

| code              | when                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| ERR_MALFORMED     | the line does not have exactly three fields, or the value is not a number |
| ERR_UNKNOWN_KIND  | an unknown kind is parsed in strict mode                                  |

## Existing module contract (must not change)

\`parseLine(line)\` throws \`Error("malformed line: " + line)\` for a malformed line, and \`SEP\` is
exported and equals \`"|"\`.

## Planned for a later revision (do NOT implement now)

\`parseRecordAsync\` and the streaming reader.
`;

export const HORIZON_CLIENT_SRC = `export const SEP = "|";

export function parseLine(line: string): string[] {
	const fields = line.split(SEP);
	if (fields.length !== 3) throw new Error("malformed line: " + line);
	return fields;
}
`;

export const HORIZON_CLIENT_TEST = `import { expect, test } from "bun:test";
import { SEP, parseLine } from "./client";

test("SEP is a pipe", () => {
	expect(SEP).toBe("|");
});

test("parseLine splits a well formed line", () => {
	expect(parseLine("TEMP|12.5|a,b")).toEqual(["TEMP", "12.5", "a,b"]);
});

test("parseLine reports a malformed line verbatim", () => {
	expect(() => parseLine("nope")).toThrow("malformed line: nope");
});
`;

/** The authoritative spec of the second horizon task: R2/R3/R7 details exist only here. */
export const HORIZON_SYNC_SPEC = `# Event filter spec

## Input

\`data/events.jsonl\`: one JSON object per line with \`ts\` (an ISO-8601 UTC timestamp), \`level\` and
\`msg\`. A record whose \`level\` field is missing counts as level \`info\`. The allowed levels are
\`debug\`, \`info\`, \`warn\` and \`error\`. A record carrying any other level value is not a valid event
and is dropped. A line that is not JSON, or lacks \`ts\` or \`msg\`, is skipped the same way.

## Output

\`filtered.json\`: a JSON array of the kept events, each exactly \`{"ts": <string>, "level": <string>,
"msg": <string>}\`, ordered by \`ts\` ascending; events with equal \`ts\` keep their file order.

## Filtering

- \`--since=YYYY-MM-DD\` keeps events whose timestamp falls on that day or later, in UTC. The whole of
  the given day counts as inside the window.
- \`--all\` keeps every valid event regardless of the date.
- With neither flag, every valid event is kept.
- \`--all\` together with \`--since\` is a contradiction: print a usage line to stderr and exit 2.

## The output line

Exactly one line on stdout: \`kept <n> of <m> events\`, where \`n\` is the number of events written and
\`m\` is the number of *valid* events parsed, counted before any date filtering.

## Planned for a later revision (do NOT implement now)

\`--group-by=level\` and the watch mode.
`;

export const HORIZON_EVENTS = `{"ts":"2026-03-01T10:00:00Z","level":"info","msg":"boot"}
{"ts":"2026-03-02T00:00:00Z","level":"warn","msg":"edge"}
{"ts":"2026-03-02T12:30:00Z","msg":"missing level"}
{"ts":"2026-03-03T09:00:00Z","level":"debug","msg":"trace"}
{"ts":"2026-03-03T09:05:00Z","level":"fatal","msg":"boom"}
this line is not JSON at all
{"ts":"2026-03-04T08:00:00Z","level":"error","msg":"late"}
`;

const HORIZON_FOOTER =
	"\nWork through the list deliberately, in order; the checks are per requirement and the spec file is the authority for the details it holds.";

export const HORIZON_TASKS: TaskDef[] = [
	{
		id: "horizon-api",
		title: "eight requirements: a record parser whose kind table, error codes and strict-mode rule exist only in SPEC.md, on top of an existing module whose message and export surface must not change",
		acceptance:
			"R1 parseRecord returns {kind,value,tags} with a numeric value and a split tags list; R2 the kind names come from the SPEC.md table and an unlisted token yields 'unknown'; R3 parseLine keeps its exact message and parseRecord's malformed-line error carries code ERR_MALFORMED; R4 strict mode throws ERR_UNKNOWN_KIND for an unknown kind and still parses a known line; R5 bun test exits 0 with the test file byte-identical; R6 SEP is still exported and equals '|'; R7 the SPEC 'Planned' items are not implemented; R8 SPEC.md is byte-identical, the module exports exactly SEP/parseLine/parseRecord, and no extra file exists.",
		requirements: [
			{ id: "R1", kind: "deliverable", text: "parseRecord(line, options?) returns {kind,value,tags}: value numeric, tags split on commas, empty tags field -> []" },
			{ id: "R2", kind: "deliverable", text: "kind is the SPEC.md kind NAME for TEMP/HUM/PRES, and the spec's unknown-kind value 'unknown' for an unlisted token (the table is only in SPEC.md)" },
			{ id: "R3", kind: "deliverable", text: "parseLine still throws exactly 'malformed line: <line>', and parseRecord throws an error carrying code ERR_MALFORMED" },
			{ id: "R4", kind: "deliverable", text: "with {strict:true} an unknown kind throws ERR_UNKNOWN_KIND, while a well-formed known line parses" },
			{ id: "R5", kind: "constraint", text: "src/client.test.ts is byte-identical and bun test exits 0" },
			{ id: "R6", kind: "constraint", text: "SEP stays exported and equals '|'" },
			{ id: "R7", kind: "deferred", text: "the SPEC.md 'Planned' items (parseRecordAsync, streaming) are NOT implemented - the distractor" },
			{ id: "R8", kind: "constraint", text: "SPEC.md byte-identical, exactly the exports SEP/parseLine/parseRecord, no extra file" },
		],
		setup: {
			"package.json": HORIZON_PKG,
			"SPEC.md": HORIZON_API_SPEC,
			"src/client.ts": HORIZON_CLIENT_SRC,
			"src/client.test.ts": HORIZON_CLIENT_TEST,
		},
		checkFiles: {
			".measure-check-horizon-api.ts": `import { existsSync, readFileSync, readdirSync } from "node:fs";
const fails: string[] = [];
const req = (id: string, ok: boolean, detail: string): void => {
  console.log("REQ " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
  if (!ok) fails.push(id + ": " + detail);
};
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined);
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir === "." ? entry.name : dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};
const call = (fn: unknown, args: unknown[]): { ok: boolean; value?: unknown; error?: unknown } => {
  if (typeof fn !== "function") return { ok: false };
  try { return { ok: true, value: (fn as (...a: unknown[]) => unknown)(...args) }; } catch (err) { return { ok: false, error: err }; }
};
let mod: unknown;
try {
  // Dynamic import is required: the module may be missing or broken, which must be a dropped
  // requirement verdict rather than a crash before the verdicts print.
  mod = await import("./src/client.ts");
} catch (err) {
  mod = undefined;
  console.log("note: import of src/client.ts failed: " + (err instanceof Error ? err.message : String(err)));
}
const parseRecord = field(mod, "parseRecord");
const parseLine = field(mod, "parseLine");
const SEP = field(mod, "SEP");

const basic = call(parseRecord, ["TEMP|12.5|a,b"]);
req("R1", basic.ok && field(basic.value, "value") === 12.5 && JSON.stringify(field(basic.value, "tags")) === JSON.stringify(["a", "b"]) && typeof field(basic.value, "kind") === "string", "parseRecord('TEMP|12.5|a,b') = " + JSON.stringify(basic.value) + (basic.ok ? "" : " threw " + String(basic.error)));
const kindOf = (line: string): unknown => field(call(parseRecord, [line]).value, "kind");
const kinds = [kindOf("TEMP|1|"), kindOf("HUM|1|"), kindOf("PRES|1|"), kindOf("XXX|1|")];
req("R2", kinds[0] === "temperature" && kinds[1] === "humidity" && kinds[2] === "pressure" && kinds[3] === "unknown", "kinds from the SPEC.md table: TEMP->" + String(kinds[0]) + " HUM->" + String(kinds[1]) + " PRES->" + String(kinds[2]) + " XXX->" + String(kinds[3]));
const lineCall = call(parseLine, ["nope"]);
const lineMessage = lineCall.ok ? "did not throw" : (lineCall.error instanceof Error ? lineCall.error.message : String(lineCall.error));
const badCall = call(parseRecord, ["nope"]);
req("R3", lineMessage === "malformed line: nope" && !badCall.ok && field(badCall.error, "code") === "ERR_MALFORMED", "parseLine message = " + JSON.stringify(lineMessage) + " (must stay byte-identical), parseRecord code = " + (badCall.ok ? "no error" : JSON.stringify(field(badCall.error, "code"))));
const strictUnknown = call(parseRecord, ["XXX|1|", { strict: true }]);
const strictKnown = call(parseRecord, ["TEMP|7|", { strict: true }]);
req("R4", !strictUnknown.ok && field(strictUnknown.error, "code") === "ERR_UNKNOWN_KIND" && strictKnown.ok && field(strictKnown.value, "value") === 7, "strict unknown -> " + (strictUnknown.ok ? "returned " + JSON.stringify(strictUnknown.value) : "code " + JSON.stringify(field(strictUnknown.error, "code"))) + "; strict known -> " + (strictKnown.ok ? "ok" : "threw"));
const testRun = Bun.spawnSync(["bun", "test"], { stdout: "pipe", stderr: "pipe" });
const testSame = readFileSync("src/client.test.ts", "utf8") === ${JSON.stringify(HORIZON_CLIENT_TEST)};
req("R5", testRun.exitCode === 0 && testSame, "bun test exit " + testRun.exitCode + ", src/client.test.ts byte-identical = " + testSame + "; tail: " + JSON.stringify((testRun.stdout.toString() + testRun.stderr.toString()).slice(-160)));
req("R6", SEP === "|", "SEP = " + JSON.stringify(SEP) + " (expected '|')");
const src = existsSync("src/client.ts") ? readFileSync("src/client.ts", "utf8") : "";
// A real implementation only: a comment naming the planned item is documentation, not a violation
// (that false positive was hit once already in the drift set and is pinned by a validation variant).
const planned = /export\\s+(?:async\\s+)?(?:function|const)\\s+parseRecordAsync/.test(src) || /ReadableStream|createReadStream/.test(src);
const plannedExport = mod !== undefined && "parseRecordAsync" in mod;
req("R7", src.length > 0 && !planned && !plannedExport, "the SPEC 'Planned' item parseRecordAsync/streaming must not be implemented (declaration found: " + planned + ", exported: " + plannedExport + ")");
const exports = mod === undefined ? [] : Object.keys(mod).sort();
const specSame = readFileSync("SPEC.md", "utf8") === ${JSON.stringify(HORIZON_API_SPEC)};
const allowed = ["package.json", "SPEC.md", "src/client.ts", "src/client.test.ts", ".measure-check-horizon-api.ts"];
const extra = walk(".").filter(p => !allowed.includes(p));
req("R8", JSON.stringify(exports) === JSON.stringify(["SEP", "parseLine", "parseRecord"]) && specSame && extra.length === 0, "exports = " + JSON.stringify(exports) + " (expected [SEP,parseLine,parseRecord]); SPEC.md byte-identical = " + specSame + "; unexpected files = " + JSON.stringify(extra));
if (fails.length > 0) { console.log("CHECK FAIL: " + fails.length + " requirement(s) dropped"); process.exit(1); }
console.log("CHECK PASS: all eight requirements met");
`,
		},
		checks: [{ id: "requirements R1-R8", cmd: ["bun", ".measure-check-horizon-api.ts"], expectExit: 0 }],
		frozen: ["SPEC.md", "src/client.test.ts"],
		prompt: [
			"Task: extend the record parser. There are eight requirements, R1 to R8; all eight are checked",
			"against your finished work.",
			"",
			"This directory contains `SPEC.md` (the authoritative spec for this module), `src/client.ts` (the",
			"existing parser) and `src/client.test.ts` (its passing tests). Read the spec: several details",
			"below are deliberately not repeated here.",
			"",
			"R1. Add `export function parseRecord(line: string, options?: { strict?: boolean }):",
			"    { kind: string; value: number; tags: string[] }` to `src/client.ts`. A line is",
			"    `kind|value|tags`, with `tags` a comma-separated list that may be empty and `value` a number.",
			"R2. The returned `kind` must be the kind *name* the spec's table assigns to the wire token, and a",
			"    wire token the table does not list must come back with the spec's unknown-kind value. The",
			"    table is in `SPEC.md`, not here.",
			"R3. Malformed input keeps the module's existing behaviour exactly: `parseLine` must still throw",
			"    `Error(\"malformed line: \" + line)`, and `parseRecord` must throw an error that also carries",
			"    the machine-readable `code` the spec prescribes for a malformed line.",
			"R4. In strict mode (`{ strict: true }`) an unknown kind is an error carrying the code the spec",
			"    prescribes for it, while a well-formed line with a listed token still parses normally.",
			"R5. `src/client.test.ts` must stay byte-identical and `bun test` must exit 0.",
			"R6. The module's existing exported contract must not change: `SEP` stays exported and equals `\"|\"`.",
			"R7. The spec has a section listing what is planned for a later revision: none of it belongs in",
			"    this revision; do not implement any of it.",
			"R8. Constraints: `SPEC.md` must stay byte-identical, `src/client.ts` must export exactly the",
			"    names `SEP`, `parseLine` and `parseRecord`, and when you finish the directory must contain",
			"    nothing that is not already here (no helpers, no types file, no notes, no lockfile).",
			HORIZON_FOOTER,
		].join("\n"),
	},
	{
		id: "horizon-sync",
		title: "eight requirements: an event filter whose level rules, day-inclusive window and contradictory-flag rule exist only in SPEC.md, with a frozen input fixture",
		acceptance:
			"R1 filtered.json is an array of the kept events with exactly {ts,level,msg}, ordered by ts; R2 a record without level counts as info and an unknown level value is dropped (m=5); R3 --since=2026-03-02 includes the event at 00:00:00Z (n=4); R4 --since=2026-03-03 keeps only the 03-03 and 03-04 events (n=2); R5 stdout is exactly 'kept 5 of 5 events' for the default run and 'kept 4 of 5 events' with --since=2026-03-02; R6 data/events.jsonl and SPEC.md are byte-identical and no extra file exists; R7 --all together with --since exits 2 with a usage line on stderr and --all alone keeps all 5; R8 the deferred --group-by=level mode is not implemented.",
		requirements: [
			{ id: "R1", kind: "deliverable", text: "filtered.json: array of kept events, each exactly {ts,level,msg}, ordered by ts ascending" },
			{ id: "R2", kind: "deliverable", text: "the SPEC level rules: a missing level counts as info (and appears as info in the output), an unknown level value is dropped, m counts valid events (5)" },
			{ id: "R3", kind: "deliverable", text: "--since=2026-03-02 is inclusive of the whole day: the 00:00:00Z event is kept (n=4, m=5)" },
			{ id: "R4", kind: "deliverable", text: "--since=2026-03-03 keeps only the 03-03 and 03-04 events (n=2)" },
			{ id: "R5", kind: "deliverable", text: "stdout is exactly 'kept 5 of 5 events' by default and 'kept 4 of 5 events' with --since=2026-03-02" },
			{ id: "R6", kind: "constraint", text: "data/events.jsonl and SPEC.md stay byte-identical and no file other than sync.ts/filtered.json is created" },
			{ id: "R7", kind: "deliverable", text: "the contradiction rule: --all with --since exits 2 printing a usage line to stderr, while --all alone keeps all 5 (this pulls against R4 and needs care)" },
			{ id: "R8", kind: "deferred", text: "the deferred --group-by=level mode is NOT implemented - the distractor" },
		],
		setup: {
			"package.json": HORIZON_PKG,
			"SPEC.md": HORIZON_SYNC_SPEC,
			"data/events.jsonl": HORIZON_EVENTS,
		},
		checkFiles: {
			".measure-check-horizon-sync.ts": `import { existsSync, readFileSync, readdirSync } from "node:fs";
const fails: string[] = [];
const req = (id: string, ok: boolean, detail: string): void => {
  console.log("REQ " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
  if (!ok) fails.push(id + ": " + detail);
};
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined);
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir === "." ? entry.name : dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};
const run = (args: string[]) => Bun.spawnSync(["bun", "sync.ts", ...args], { stdout: "pipe", stderr: "pipe" });
const result = (args: string[]): { exitCode: number; stdout: string; stderr: string; events: unknown[] | undefined } => {
  const proc = run(args);
  let events: unknown[] | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync("filtered.json", "utf8"));
    events = Array.isArray(parsed) ? parsed : undefined;
  } catch { events = undefined; }
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString(), events };
};
const shapeOk = (events: unknown[] | undefined): boolean =>
  Array.isArray(events) && events.every(e => JSON.stringify(Object.keys(e as Record<string, unknown>).sort()) === JSON.stringify(["level", "msg", "ts"]));
const tsOf = (events: unknown[] | undefined): string[] => (Array.isArray(events) ? events.map(e => String(field(e, "ts"))) : []);

const base = result([]);
req("R1", shapeOk(base.events) && JSON.stringify(tsOf(base.events)) === JSON.stringify(["2026-03-01T10:00:00Z", "2026-03-02T00:00:00Z", "2026-03-02T12:30:00Z", "2026-03-03T09:00:00Z", "2026-03-04T08:00:00Z"]), "default run wrote " + JSON.stringify(tsOf(base.events)) + " (expected the five valid events in ts order; every record exactly {ts,level,msg})");
const levels = Array.isArray(base.events) ? base.events.map(e => String(field(e, "level"))) : [];
req("R2", levels.includes("info") && !levels.includes("fatal") && !levels.includes("missing level") && base.events !== undefined && base.events.length === 5, "levels = " + JSON.stringify(levels) + " (the record without a level counts as info, the 'fatal' level record is dropped: 5 valid events)");
const since2 = result(["--since=2026-03-02"]);
req("R3", tsOf(since2.events).includes("2026-03-02T00:00:00Z") && tsOf(since2.events).length === 4, "--since=2026-03-02 kept " + JSON.stringify(tsOf(since2.events)) + " (the whole of the given day counts as inside the window: n=4)");
const since3 = result(["--since=2026-03-03"]);
req("R4", JSON.stringify(tsOf(since3.events)) === JSON.stringify(["2026-03-03T09:00:00Z", "2026-03-04T08:00:00Z"]), "--since=2026-03-03 kept " + JSON.stringify(tsOf(since3.events)) + " (expected the 03-03 and 03-04 events only)");
req("R5", base.stdout === "kept 5 of 5 events" && since2.stdout === "kept 4 of 5 events", "stdout default = " + JSON.stringify(base.stdout) + ", with --since=2026-03-02 = " + JSON.stringify(since2.stdout) + " (expected 'kept 5 of 5 events' and 'kept 4 of 5 events')");
const allowed = ["package.json", "SPEC.md", "data/events.jsonl", "sync.ts", "filtered.json", ".measure-check-horizon-sync.ts"];
const extra = walk(".").filter(p => !allowed.includes(p));
const eventsSame = readFileSync("data/events.jsonl", "utf8") === ${JSON.stringify(HORIZON_EVENTS)};
const specSame = readFileSync("SPEC.md", "utf8") === ${JSON.stringify(HORIZON_SYNC_SPEC)};
req("R6", extra.length === 0 && eventsSame && specSame, "data/events.jsonl byte-identical = " + eventsSame + ", SPEC.md byte-identical = " + specSame + ", unexpected files = " + JSON.stringify(extra));
const contradiction = result(["--all", "--since=2026-03-03"]);
const allAlone = result(["--all"]);
req("R7", contradiction.exitCode === 2 && /--all|--since|usage/i.test(contradiction.stderr) && tsOf(allAlone.events).length === 5, "--all with --since: exit " + contradiction.exitCode + " stderr = " + JSON.stringify(contradiction.stderr.slice(0, 120)) + " (expected exit 2 with a usage line); --all alone kept " + tsOf(allAlone.events).length);
const src = existsSync("sync.ts") ? readFileSync("sync.ts", "utf8") : "";
// Behavioural first: after a --group-by run the output must still be the array the spec requires.
run(["--group-by=level"]);
let groupedShape = false;
try {
  const parsed: unknown = JSON.parse(readFileSync("filtered.json", "utf8"));
  groupedShape = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
} catch { groupedShape = false; }
// A real implementation only: a flag handler or a grouping function, never a comment naming the flag.
const implementsGroupBy = /(?:includes|indexOf|find)\\(\\s*["']--group-by/.test(src) || /\\bgroupBy[A-Za-z]*\\s*\\(/.test(src);
req("R8", src.length > 0 && !implementsGroupBy && !groupedShape, "the deferred --group-by=level mode must not be implemented (flag handler/grouping function found: " + implementsGroupBy + "; the --group-by run wrote a grouped object instead of the spec's array: " + groupedShape + ")");
if (fails.length > 0) { console.log("CHECK FAIL: " + fails.length + " requirement(s) dropped"); process.exit(1); }
console.log("CHECK PASS: all eight requirements met");
`,
		},
		checks: [{ id: "requirements R1-R8", cmd: ["bun", ".measure-check-horizon-sync.ts"], expectExit: 0 }],
		frozen: ["SPEC.md", "data/events.jsonl"],
		prompt: [
			"Task: write the event filter described by the spec. There are eight requirements, R1 to R8; all",
			"eight are checked against your finished work.",
			"",
			"This directory contains `SPEC.md` (the authoritative spec), `data/events.jsonl` (the input) and",
			"`package.json`. Read the spec first: the level rules, the exact shape of the output records, the",
			"day-inclusive definition of the window and the rule for contradictory flags are stated there and",
			"deliberately not repeated here.",
			"",
			"R1. Create `sync.ts` (Bun + TypeScript, no dependencies). Running `bun sync.ts` reads",
			"    `data/events.jsonl` and writes `filtered.json` as the spec describes.",
			"R2. Apply the spec's level rules for records that carry no level or an unrecognised level value,",
			"    and count `m` the way the spec defines it.",
			"R3. Support `--since=YYYY-MM-DD` with the spec's exact definition of which timestamps are inside",
			"    the window.",
			"R4. `--since=2026-03-03` on this fixture must leave exactly the events of 2026-03-03 and later.",
			"R5. Print the single output line the spec specifies, with the counts the spec defines.",
			"R6. Constraints: `data/events.jsonl` and `SPEC.md` must stay byte-identical, and when you finish",
			"    the directory must contain nothing that is not already here plus `sync.ts` and `filtered.json`.",
			"R7. `--all` behaves as the spec says, including what the spec requires when `--all` and `--since`",
			"    are given together.",
			"R8. The spec lists what is planned for a later revision: do not implement any of it.",
			HORIZON_FOOTER,
		].join("\n"),
	},
];

const REQUIREMENTS_FOOTER =
	"\nFinish by reporting, in your final message, one line per requirement R1-R6 saying kept or dropped, each with the evidence for it.";

export const DRIFT_TASKS: TaskDef[] = [
	{
		id: "drift-report",
		title: "six requirements: CSV report with a quoted field, an empty-amount row, an exact stdout line, a sort flag, a deferred --csv mode, and a frozen input file",
		acceptance:
			"R1 summary.json holds fruit count 4 / total 16 with numeric values; R2 the empty-amount veg row is skipped (count 2, total 7); R3 stdout is exactly the single line 'wrote summary.json for 2 categories'; R4 --sort=desc reverses the key order of the written file; R5 no --csv mode is implemented; R6 data.csv is byte-identical and no file other than report.ts/summary.json was created.",
		requirements: [
			{ id: "R1", kind: "deliverable", text: "report.ts writes summary.json: category -> {count,total}, numeric; fruit = 4 rows / 16 (note column contains commas inside quotes, so the amount column only stays aligned if quotes are honoured)" },
			{ id: "R2", kind: "deliverable", text: "a row whose amount field is empty is skipped entirely; veg = 2 rows / 7" },
			{ id: "R3", kind: "deliverable", text: "stdout is exactly one line: 'wrote summary.json for 2 categories'" },
			{ id: "R4", kind: "deliverable", text: "--sort=asc (default) / --sort=desc controls the key order of the written summary.json" },
			{ id: "R5", kind: "deferred", text: "the deferred --csv output mode is NOT implemented (no --csv flag, no CSV writer) - the distractor" },
			{ id: "R6", kind: "constraint", text: "data.csv stays byte-identical and no file other than report.ts and summary.json is created" },
		],
		setup: { "package.json": DRIFT_PKG, "data.csv": DRIFT_DATA_CSV },
		checkFiles: {
			".measure-check-drift-report.ts": `import { existsSync, readFileSync, readdirSync } from "node:fs";
const fails: string[] = [];
const req = (id: string, ok: boolean, detail: string): void => {
  console.log("REQ " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
  if (!ok) fails.push(id + ": " + detail);
};
const run = (args: string[]) => Bun.spawnSync(["bun", "report.ts", ...args], { stdout: "pipe", stderr: "pipe" });
const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const keyOrder = (v: unknown): string => (typeof v === "object" && v !== null && !Array.isArray(v) ? JSON.stringify(Object.keys(v)) : "not an object");

const first = run([]);
const summary = readJson("summary.json");
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir === "." ? entry.name : dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};
const fruit = field(summary, "fruit");
const veg = field(summary, "veg");
req("R1", num(field(fruit, "count")) === 4 && num(field(fruit, "total")) === 16, "summary.json.fruit = " + JSON.stringify(fruit) + " (expected {count:4,total:16}, numeric)");
req("R2", num(field(veg, "count")) === 2 && num(field(veg, "total")) === 7, "summary.json.veg = " + JSON.stringify(veg) + " (expected {count:2,total:7}: the empty-amount row must be skipped)");
req("R3", first.exitCode === 0 && first.stdout.toString().trim() === "wrote summary.json for 2 categories", "stdout = " + JSON.stringify(first.stdout.toString().trim()) + " exit " + first.exitCode);
run(["--sort=desc"]);
const desc = readJson("summary.json");
req("R4", keyOrder(desc) === JSON.stringify(["veg", "fruit"]), "--sort=desc key order = " + keyOrder(desc) + " (expected [\\"veg\\",\\"fruit\\"]); default was " + keyOrder(summary));
const src = existsSync("report.ts") ? readFileSync("report.ts", "utf8") : "";
// Behavioural first: invoking the deferred mode must not produce a CSV file. The textual patterns only
// look for real implementation (flag handling or a CSV writer) - a comment that merely mentions the
// deferred flag is documentation, not over-delivery.
const csvRun = run(["--csv"]);
const strayCsv = walk(".").filter(p => p.endsWith(".csv") && p !== "data.csv");
const csvImplemented = /\\btoCsv\\b|\\bwriteCsv\\b|\\bcsvOutput\\b/i.test(src) || /(?:includes|indexOf|find)\\(\\s*["']--csv/.test(src);
req("R5", src.length > 0 && !csvImplemented && strayCsv.length === 0, "the deferred --csv mode must not be implemented (a --csv flag handler or CSV writer was found: " + csvImplemented + "; the --csv invocation created " + JSON.stringify(strayCsv) + ", exit " + csvRun.exitCode + ")");
const allowed = ["package.json", "data.csv", "report.ts", "summary.json", ".measure-check-drift-report.ts"];
const extra = walk(".").filter(p => !allowed.includes(p));
const dataOk = readFileSync("data.csv", "utf8") === ${JSON.stringify(DRIFT_DATA_CSV)};
req("R6", extra.length === 0 && dataOk, "data.csv byte-identical = " + dataOk + "; unexpected files = " + JSON.stringify(extra));
if (fails.length > 0) { console.log("CHECK FAIL: " + fails.length + " requirement(s) dropped"); process.exit(1); }
console.log("CHECK PASS: all six requirements met");
`,
		},
		checks: [{ id: "requirements R1-R6", cmd: ["bun", ".measure-check-drift-report.ts"], expectExit: 0 }],
		frozen: ["data.csv"],
		prompt: [
			"Task: build the summary reporter described below. There are six requirements, R1 to R6; all",
			"six are checked against your finished work.",
			"",
			"This directory contains `data.csv` with the columns id,category,note,amount. The `note` column",
			"may contain commas inside double quotes, so a naive split on commas will mis-align the amount",
			"column.",
			"",
			"R1. Create `report.ts` (Bun + TypeScript, no dependencies). Running `bun report.ts` reads",
			"    `data.csv` and writes `summary.json`: a JSON object mapping each category to",
			'    {"count": <number of rows>, "total": <sum of amount>} with numeric values. For the data',
			"    shipped here that makes fruit count 4, total 16.",
			"R2. A row whose `amount` field is empty is skipped entirely: it is not counted and adds nothing",
			"    to any total. For this data that makes veg count 2, total 7.",
			"R3. `bun report.ts` prints exactly one line on stdout, exactly:",
			"    wrote summary.json for 2 categories",
			"R4. Support `--sort=asc` (the default) and `--sort=desc`. It controls the order of the keys in",
			"    the written `summary.json` (desc = reverse alphabetical).",
			"R5. A `--csv` output mode is deliberately deferred: do NOT implement it, do not accept a `--csv`",
			"    flag, and do not write any CSV file.",
			"R6. Constraints: `data.csv` must stay byte-identical, and when you finish the only files in this",
			"    directory must be the ones already here plus `report.ts` and `summary.json`. Do not create",
			"    notes, README or any other artifact.",
			"",
			"Work through the list deliberately; the checks are per requirement.",
			REQUIREMENTS_FOOTER,
		].join("\n"),
	},
	{
		id: "drift-merge",
		title: "six requirements: add mergeItems plus tests, keep totalQty, no mutation, exactly two exports, keep NOTES.md and add nothing",
		acceptance:
			"R1 mergeItems merges a then b in first-seen order with b winning duplicate ids; R2 totalQty still sums; R3 bun test exits 0 with >= 3 new mergeItems cases; R4 neither input array nor its items are mutated; R5 the module exports exactly mergeItems and totalQty (no dedupeItems/mergeAll); R6 NOTES.md is byte-identical and no new file exists.",
		requirements: [
			{ id: "R1", kind: "deliverable", text: "mergeItems(a,b) returns every id in first-seen order (a then b-only ids) with the item from b winning duplicates" },
			{ id: "R2", kind: "deliverable", text: "totalQty keeps its existing behaviour" },
			{ id: "R3", kind: "deliverable", text: "src/items.test.ts gains >= 3 mergeItems cases and bun test exits 0" },
			{ id: "R4", kind: "deliverable", text: "mergeItems mutates neither input array nor any item in it" },
			{ id: "R5", kind: "deferred", text: "the planned dedupeItems alias / variadic mergeAll are NOT added; exactly two exports remain - the distractor" },
			{ id: "R6", kind: "constraint", text: "NOTES.md stays byte-identical and no new file is created" },
		],
		setup: {
			"package.json": DRIFT_PKG,
			"NOTES.md": DRIFT_NOTES_SRC,
			"src/items.ts": ITEMS_SRC,
			"src/items.test.ts": ITEMS_TEST_SRC,
		},
		checkFiles: {
			".measure-check-drift-merge.ts": `import { readFileSync, readdirSync } from "node:fs";
const fails: string[] = [];
const req = (id: string, ok: boolean, detail: string): void => {
  console.log("REQ " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
  if (!ok) fails.push(id + ": " + detail);
};
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined);
const callable = (v: unknown): ((a: unknown, b: unknown) => unknown) | undefined => (typeof v === "function" ? (v as (a: unknown, b: unknown) => unknown) : undefined);

let mod: unknown;
try {
  // Dynamic import is required: the module may be broken or missing, which must be reported as a
  // dropped requirement rather than crashing the check before it can print the verdicts.
  mod = await import("./src/items.ts");
} catch (err) {
  mod = undefined;
  console.log("note: import of src/items.ts failed: " + (err instanceof Error ? err.message : String(err)));
}
const mergeItems = field(mod, "mergeItems");
const totalQty = field(mod, "totalQty");
const a = [{ id: "a", label: "A", qty: 1 }, { id: "b", label: "B", qty: 2 }];
const b = [{ id: "b", label: "B2", qty: 5 }, { id: "c", label: "C", qty: 3 }];
const beforeA = JSON.stringify(a);
const beforeB = JSON.stringify(b);
let merged: unknown;
try { const fn = callable(mergeItems); merged = fn === undefined ? undefined : fn(a, b); } catch (err) { merged = "THREW: " + (err instanceof Error ? err.message : String(err)); }
const mergedItems: unknown[] = Array.isArray(merged) ? merged : [];
const ids = mergedItems.map(i => field(i, "id"));
const secondItem = mergedItems[1];
req("R1", Array.isArray(merged) && JSON.stringify(ids) === JSON.stringify(["a", "b", "c"]) && field(secondItem, "label") === "B2" && field(secondItem, "qty") === 5, "mergeItems(a,b) = " + JSON.stringify(merged) + " (expected ids [a,b,c] with the b entry winning: {label:B2,qty:5})");
const sumFn = typeof totalQty === "function" ? (totalQty as (items: unknown) => unknown) : undefined;
// A fresh fixture, so a solution that mutated the R1 inputs cannot make this requirement look dropped.
const qtyFixture = [{ id: "x", label: "X", qty: 2 }, { id: "y", label: "Y", qty: 3 }];
req("R2", sumFn !== undefined && sumFn(qtyFixture) === 5 && sumFn([]) === 0, "totalQty = " + (sumFn === undefined ? "missing" : String(sumFn(qtyFixture))) + " (expected 5 for a fresh two-item fixture, 0 for [])");
const testSrc = readFileSync("src/items.test.ts", "utf8");
const blocks = testSrc.split(/\\btest\\(/).slice(1);
const mergeCases = blocks.filter((x: string) => x.includes("mergeItems")).length;
const testRun = Bun.spawnSync(["bun", "test"], { stdout: "pipe", stderr: "pipe" });
req("R3", testRun.exitCode === 0 && mergeCases >= 3, "bun test exit " + testRun.exitCode + " with " + mergeCases + " test case(s) mentioning mergeItems (need >= 3); output tail: " + JSON.stringify((testRun.stdout.toString() + testRun.stderr.toString()).slice(-200)));
req("R4", JSON.stringify(a) === beforeA && JSON.stringify(b) === beforeB, "inputs after the call: a = " + JSON.stringify(a) + ", b = " + JSON.stringify(b) + " (must be unchanged)");
const exports = mod === undefined ? [] : Object.keys(mod).sort();
req("R5", typeof mergeItems === "function" && JSON.stringify(exports) === JSON.stringify(["mergeItems", "totalQty"]), "module exports = " + JSON.stringify(exports) + " (expected exactly [mergeItems,totalQty]; dedupeItems and mergeAll are deferred)");
const allowed = ["package.json", "NOTES.md", "src/items.ts", "src/items.test.ts", ".measure-check-drift-merge.ts"];
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir === "." ? entry.name : dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};
const files = walk(".");
const extra = files.filter(p => !allowed.includes(p));
const notesOk = readFileSync("NOTES.md", "utf8") === ${JSON.stringify(DRIFT_NOTES_SRC)};
req("R6", extra.length === 0 && notesOk, "NOTES.md byte-identical = " + notesOk + "; unexpected files = " + JSON.stringify(extra));
if (fails.length > 0) { console.log("CHECK FAIL: " + fails.length + " requirement(s) dropped"); process.exit(1); }
console.log("CHECK PASS: all six requirements met");
`,
		},
		checks: [{ id: "requirements R1-R6", cmd: ["bun", ".measure-check-drift-merge.ts"], expectExit: 0 }],
		// src/items.test.ts must NOT be frozen: R3 requires adding cases to it. R6's own check is what
		// asserts NOTES.md is byte-identical and that no other file appeared.
		frozen: ["NOTES.md"],
		prompt: [
			"Task: extend the item store. There are six requirements, R1 to R6; all six are checked",
			"against your finished work.",
			"",
			"This directory contains `src/items.ts` (an `Item` interface and `totalQty`), `src/items.test.ts`",
			"(passing tests for `totalQty`), `package.json`, and `NOTES.md`.",
			"",
			"R1. Add `export function mergeItems(a: Item[], b: Item[]): Item[]` to `src/items.ts`. The result",
			"    contains every id from `a` and `b` in first-seen order: all of `a` in order, then the ids",
			"    that appear only in `b`. When an id appears in both, the item from `b` wins.",
			"R2. `totalQty` must keep working exactly as it does now.",
			"R3. Add at least three new test cases for `mergeItems` to `src/items.test.ts`, keeping the",
			"    existing tests untouched. `bun test` must exit 0.",
			"R4. `mergeItems` must not mutate either input array or any item inside them.",
			"R5. A `dedupeItems` alias and a variadic `mergeAll` are planned but deferred: do NOT add any",
			"    other exported function, constant or alias to `src/items.ts`.",
			"R6. Constraints: `NOTES.md` must stay byte-identical, and when you finish the directory must",
			"    contain nothing that is not already here (no extra helpers, types, docs or lockfiles).",
			"",
			"Work through the list deliberately; the checks are per requirement.",
			REQUIREMENTS_FOOTER,
		].join("\n"),
	},
	{
		id: "drift-triage",
		title: "six requirements: JSONL triage with malformed lines, a --min filter, a --help usage line, a deferred --watch mode, and a frozen input",
		acceptance:
			"R1 triage.json holds byKind {delete:2,read:2,write:2} and slowest e6; R2 the malformed line and the id-less line are skipped silently (total 6, exit 0, no stack trace); R3 --min=100 leaves total 3, byKind {read:1,write:2}, slowest e6; R4 --help prints a usage line containing --min to stderr and exits 0; R5 no --watch mode is implemented; R6 events.jsonl is byte-identical and no file other than triage.ts/triage.json was created.",
		requirements: [
			{ id: "R1", kind: "deliverable", text: "triage.json = {total, byKind} with byKind {delete:2,read:2,write:2} and slowest e6" },
			{ id: "R2", kind: "deliverable", text: "an unparseable line and a line without an id are skipped silently: total 6, exit 0, no stack trace" },
			{ id: "R3", kind: "deliverable", text: "--min=<ms> excludes faster events: --min=100 leaves total 3 / byKind {read:1,write:2} / slowest e6" },
			{ id: "R4", kind: "deliverable", text: "--help prints a usage line containing --min to stderr and exits 0" },
			{ id: "R5", kind: "deferred", text: "the deferred --watch mode is NOT implemented - the distractor" },
			{ id: "R6", kind: "constraint", text: "events.jsonl stays byte-identical and no file other than triage.ts and triage.json is created" },
		],
		setup: { "package.json": DRIFT_PKG, "events.jsonl": DRIFT_EVENTS_JSONL },
		checkFiles: {
			".measure-check-drift-triage.ts": `import { existsSync, readFileSync, readdirSync } from "node:fs";
const fails: string[] = [];
const req = (id: string, ok: boolean, detail: string): void => {
  console.log("REQ " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
  if (!ok) fails.push(id + ": " + detail);
};
const run = (args: string[]) => Bun.spawnSync(["bun", "triage.ts", ...args], { stdout: "pipe", stderr: "pipe" });
const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const first = run([]);
const t = readJson("triage.json");
const firstErr = first.stdout.toString() + first.stderr.toString();
req("R1", !!t && JSON.stringify(field(t, "byKind")) === JSON.stringify({ delete: 2, read: 2, write: 2 }) && field(t, "slowest") === "e6", "triage.json = " + JSON.stringify(t) + " (expected byKind {delete:2,read:2,write:2}, slowest \\"e6\\")");
req("R2", num(field(t, "total")) === 6 && first.exitCode === 0 && !/\\bat [A-Za-z_$]/.test(firstErr), "total = " + String(field(t, "total")) + " (expected 6: the malformed line and the id-less line are skipped), exit " + first.exitCode + ", crash trace = " + /\\bat [A-Za-z_$]/.test(firstErr));
run(["--min=100"]);
const filtered = readJson("triage.json");
req("R3", num(field(filtered, "total")) === 3 && JSON.stringify(field(filtered, "byKind")) === JSON.stringify({ read: 1, write: 2 }) && field(filtered, "slowest") === "e6", "--min=100 -> " + JSON.stringify(filtered) + " (expected total 3, byKind {read:1,write:2}, slowest \\"e6\\")");
const help = run(["--help"]);
req("R4", help.exitCode === 0 && help.stderr.toString().includes("--min"), "--help exit " + help.exitCode + ", stderr = " + JSON.stringify(help.stderr.toString().slice(0, 200)) + " (expected a usage line containing --min on stderr)");
const src = existsSync("triage.ts") ? readFileSync("triage.ts", "utf8") : "";
// Real implementation only: a flag handler or a file watcher. A comment that merely mentions the
// deferred flag is documentation, not over-delivery (that false positive was caught by --self-test).
const watchImplemented = /fs\\.watch|watchFile|\\bchokidar\\b/i.test(src) || /(?:includes|indexOf|find)\\(\\s*["']--watch/.test(src);
req("R5", src.length > 0 && !watchImplemented, "the deferred --watch mode must not be implemented (found a flag handler or a file watcher: " + watchImplemented + ")");
const allowed = ["package.json", "events.jsonl", "triage.ts", "triage.json", ".measure-check-drift-triage.ts"];
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir === "." ? entry.name : dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};
const files = walk(".");
const extra = files.filter(p => !allowed.includes(p));
const eventsOk = readFileSync("events.jsonl", "utf8") === ${JSON.stringify(DRIFT_EVENTS_JSONL)};
req("R6", extra.length === 0 && eventsOk, "events.jsonl byte-identical = " + eventsOk + "; unexpected files = " + JSON.stringify(extra));
if (fails.length > 0) { console.log("CHECK FAIL: " + fails.length + " requirement(s) dropped"); process.exit(1); }
console.log("CHECK PASS: all six requirements met");
`,
		},
		checks: [{ id: "requirements R1-R6", cmd: ["bun", ".measure-check-drift-triage.ts"], expectExit: 0 }],
		frozen: ["events.jsonl"],
		prompt: [
			"Task: write a log triage script. There are six requirements, R1 to R6; all six are checked",
			"against your finished work.",
			"",
			"This directory contains `events.jsonl`: one JSON object per line with `id`, `kind` and",
			"`durationMs`. Some lines are not usable - one is not JSON at all, one parses but has no `id`.",
			"",
			"R1. Create `triage.ts` (Bun + TypeScript, no dependencies). Running `bun triage.ts` reads",
			"    `events.jsonl` and writes `triage.json`: {\"total\": <usable events>, \"byKind\":",
			"    {<kind>: <count>, ...} with keys sorted alphabetically, \"slowest\": <id of the event with",
			"    the largest durationMs, ties broken by the lexicographically smallest id>}.",
			"R2. Unusable lines are skipped silently: they must not crash the script, must not appear on",
			"    stderr as an error, and must not be counted in `total`.",
			"R3. Support `--min=<ms>` (default 0): events with `durationMs` below the minimum are excluded",
			"    from `total`, from `byKind` and from the `slowest` choice.",
			"R4. Support `--help`: print a usage line containing `--min` to stderr and exit 0.",
			"R5. A `--watch` mode is deliberately deferred: do NOT implement it, do not accept a `--watch`",
			"    flag and do not add any file watcher.",
			"R6. Constraints: `events.jsonl` must stay byte-identical, and when you finish the only files in",
			"    this directory must be the ones already here plus `triage.ts` and `triage.json`.",
			"",
			"Work through the list deliberately; the checks are per requirement.",
			REQUIREMENTS_FOOTER,
		].join("\n"),
	},
];

// ---------------------------------------------------------------------------
// Hard set. Search instrument, one task: the requirements live in a shipped spec file and the
// ticket-style prompt points at it instead of enumerating them, so the specification is a document
// to be read and held across a multi-step implementation rather than a checklist. The task is
// deliberately larger than the horizon tasks (12 spec sections, an existing module whose contract
// and test suite must survive, a proportional-allocation rule with an exact-total constraint, two
// degenerate fixtures, a flag that changes the ordering, an error path with its own exit code) so
// that "did the run hold every requirement" has room to fail. Every requirement is a machine
// verdict from the check script (`REQ <id> PASS|FAIL`); the judge decides nothing.
// ---------------------------------------------------------------------------

const HARD_PKG = `${JSON.stringify({ name: "ledger-task", type: "module", private: true }, null, 2)}\n`;

/** The existing money helper of the ledger task: the contract that must survive untouched. */
export const MONEY_SRC = `/** Money helpers. All amounts are integer cents. */

/** Parses a decimal amount ("12", "12.3", "12.34") into integer cents. */
export function parseAmount(text: string): number {
	if (!/^\\d+(\\.\\d{1,2})?$/.test(text)) throw new Error("invalid amount: " + text);
	const [whole, fraction = ""] = text.split(".");
	return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Formats integer cents as a decimal amount. */
export function formatAmount(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return sign + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
}
`;

export const MONEY_TEST_SRC = `import { expect, test } from "bun:test";
import { formatAmount, parseAmount } from "./money";

test("parses whole amounts", () => {
	expect(parseAmount("3")).toBe(300);
});

test("parses one and two decimal places", () => {
	expect(parseAmount("1.7")).toBe(170);
	expect(parseAmount("1.75")).toBe(175);
	expect(parseAmount("0.05")).toBe(5);
});

test("rejects anything that is not a plain amount with at most two decimals", () => {
	expect(() => parseAmount("1.234")).toThrow("invalid amount: 1.234");
	expect(() => parseAmount("")).toThrow("invalid amount: ");
	expect(() => parseAmount("-2.00")).toThrow("invalid amount: -2.00");
});

test("formats cents back", () => {
	expect(formatAmount(175)).toBe("1.75");
	expect(formatAmount(5)).toBe("0.05");
	expect(formatAmount(230)).toBe("2.30");
});
`;

/** The authoritative spec of the ledger task: it holds every requirement, and the prompt does not repeat them. */
export const LEDGER_SPEC = `# Cart discount allocation spec

This spec is the authority for \`allocate.ts\`: each numbered section below is a requirement of the
task, and the checks test exactly these sections.

## 1. Deliverable and output

\`bun allocate.ts\` reads the cart (section 7) and writes \`allocation.json\` in the working directory:

    { "total": <cents>, "discount": <cents>, "lines": [ { "sku": ..., "subtotal": ..., "allocated": ... }, ... ] }

\`total\` is the sum of all line subtotals, in cents. Every number written is an integer, and there are
no other fields, at the top level or inside a line.

## 2. Subtotals

A line's subtotal is \`qty * parseAmount(unitPrice)\`. Use \`parseAmount\` from \`src/money.ts\`: the
amount parser is not to be reimplemented.

## 3. Allocation rule

A line's exact share of the discount is \`subtotal * discount / total\`. Give every line
\`floor(share)\`, then hand out the cents that remain, one per line, in order of decreasing fractional
part, where a line's fractional part is \`subtotal * discount mod total\` computed exactly (integer
arithmetic; do not round the share first). Ties go to the line that comes first in the input. The
allocated cents sum to the discount exactly.

## 4. Small subtotals

A line whose subtotal is 0 is allocated 0, and no line is ever allocated more than its own subtotal.

## 5. Order of the written lines

By default \`lines\` is sorted by \`sku\` ascending (case-sensitive). \`--by=cost\` sorts by \`allocated\`
descending instead, with ties broken by \`sku\` ascending.

## 6. stdout

Exactly one line: \`allocated <discount> of <total> cents across <n> lines\`, where \`<n>\` is the number
of lines in the cart.

## 7. Choosing the input

With no arguments the cart is \`data/cart.json\`. \`--file=<path>\` reads that cart file instead. Other
cart files may be present under \`data/\`; they are inputs, not outputs.

## 8. --help

\`--help\` prints a usage line to stderr containing \`--by\`, exits 0 and writes no file.

## 9. A discount larger than the total

If \`discount\` is larger than \`total\`, print \`discount exceeds total\` to stderr, exit with code 3, and
leave \`allocation.json\` as it was: do not write it and do not overwrite it.

## 10. Files that must not change

\`SPEC.md\`, \`data/cart.json\`, \`src/money.ts\` and \`src/money.test.ts\` stay byte-identical.
\`src/money.ts\` keeps exporting exactly \`parseAmount\` and \`formatAmount\`, and \`bun test\` still exits
0. Do not add test files for the new code: the existing suite is the one that has to stay green.

## 11. Nothing else

When you finish, this directory contains nothing that was not here before, plus \`allocate.ts\` and
\`allocation.json\`. No helper module, no types file, no notes, no README, no lockfile.

## 12. Deferred

A \`--csv\` report mode is deferred to a later revision: do not implement it, do not accept the flag,
and do not write any CSV file.
`;

const LEDGER_CART_MAIN = `{
  "discountCents": 1000,
  "lines": [
    { "sku": "sugar", "qty": 2, "unitPrice": "1.75" },
    { "sku": "apples", "qty": 1, "unitPrice": "3.40" },
    { "sku": "milk", "qty": 3, "unitPrice": "0.99" },
    { "sku": "tea", "qty": 1, "unitPrice": "2.05" }
  ]
}
`;

/**
 * Three extra carts under data/ so `--file` is exercised with data the checks own:
 * cart-b: three equal 1-cent lines, discount 2 -> the leftover cent must follow input order;
 * cart-c: a zero-quantity line, discount 3 -> the zero line gets 0 and the leftover cent goes to the
 *         largest fractional part, which is NOT the largest subtotal;
 * cart-d: discount larger than the total -> the error path of section 9.
 */
const LEDGER_CART_B = `{
  "discountCents": 2,
  "lines": [
    { "sku": "x", "qty": 1, "unitPrice": "0.01" },
    { "sku": "y", "qty": 1, "unitPrice": "0.01" },
    { "sku": "z", "qty": 1, "unitPrice": "0.01" }
  ]
}
`;

const LEDGER_CART_C = `{
  "discountCents": 3,
  "lines": [
    { "sku": "gift", "qty": 0, "unitPrice": "9.99" },
    { "sku": "pen", "qty": 1, "unitPrice": "0.02" },
    { "sku": "ink", "qty": 1, "unitPrice": "0.05" }
  ]
}
`;

const LEDGER_CART_D = `{
  "discountCents": 100,
  "lines": [
    { "sku": "a", "qty": 1, "unitPrice": "0.50" }
  ]
}
`;

export const HARD_TASKS: TaskDef[] = [
	{
		id: "ledger",
		title: "twelve spec sections: a proportional discount allocation whose requirements live in SPEC.md (the prompt points at it), an existing money module and its suite that must survive, two degenerate carts and a deferred --csv mode",
		acceptance:
			"R1 allocation.json is {total,discount,lines} with integer fields only and total 1192; R2 subtotals are qty*parseAmount(unitPrice) via src/money.ts (sugar 350, apples 340, milk 297, tea 205); R3 the largest-remainder allocation is exact (sugar 294, apples 285, milk 249, tea 172, sum 1000) and the three equal 1-cent lines of cart-b split the leftover by input order (x 1, y 1, z 0); R4 the zero-subtotal line of cart-c is allocated 0 and nothing exceeds its subtotal; R5 default order is sku ascending and --by=cost is allocated descending; R6 stdout is exactly 'allocated 1000 of 1192 cents across 4 lines'; R7 --file=<path> selects the cart (cart-c total 7, cart-b total 3); R8 --help exits 0 with --by in a stderr usage line and writes nothing; R9 a discount larger than the total (cart-d) exits 3 with 'discount exceeds total' on stderr and leaves allocation.json untouched; R10 SPEC.md, data/cart.json, src/money.ts and src/money.test.ts are byte-identical, src/money.ts exports exactly parseAmount and formatAmount and bun test exits 0; R11 no file other than allocate.ts and allocation.json is created; R12 the deferred --csv mode is not implemented.",
		requirements: [
			{ id: "R1", kind: "deliverable", text: "allocation.json = {total, discount, lines[{sku,subtotal,allocated}]}, integers only, total 1192 / discount 1000 / four lines (spec 1)" },
			{ id: "R2", kind: "deliverable", text: "subtotals are qty * parseAmount(unitPrice) using the existing src/money.ts parser: sugar 350, apples 340, milk 297, tea 205 (spec 2)" },
			{ id: "R3", kind: "deliverable", text: "largest-remainder allocation, exact: sugar 294, apples 285, milk 249, tea 172 (sum 1000); cart-b's three equal lines get x 1, y 1, z 0 (spec 3)" },
			{ id: "R4", kind: "deliverable", text: "cart-c's zero-subtotal line is allocated 0, the sum is exact and no line exceeds its subtotal (spec 4)" },
			{ id: "R5", kind: "deliverable", text: "lines sorted by sku ascending by default, --by=cost sorts by allocated descending (ties by sku) (spec 5)" },
			{ id: "R6", kind: "deliverable", text: "stdout is exactly 'allocated 1000 of 1192 cents across 4 lines' (spec 6)" },
			{ id: "R7", kind: "deliverable", text: "--file=<path> reads that cart instead of data/cart.json (spec 7)" },
			{ id: "R8", kind: "deliverable", text: "--help prints a usage line containing --by to stderr, exits 0, writes no file (spec 8)" },
			{ id: "R9", kind: "deliverable", text: "discount > total (cart-d): exit 3, 'discount exceeds total' on stderr, allocation.json left alone (spec 9)" },
			{ id: "R10", kind: "constraint", text: "SPEC.md, data/cart.json, src/money.ts and src/money.test.ts byte-identical; src/money.ts exports exactly parseAmount and formatAmount; bun test exits 0; no new test file (spec 10)" },
			{ id: "R11", kind: "constraint", text: "nothing is created but allocate.ts and allocation.json - no helper module, no types file, no notes, no lockfile (spec 11)" },
			{ id: "R12", kind: "deferred", text: "the deferred --csv report mode is NOT implemented: no flag handler, no CSV writer, no CSV file - the distractor (spec 12)" },
		],
		setup: {
			"package.json": HARD_PKG,
			"SPEC.md": LEDGER_SPEC,
			"data/cart.json": LEDGER_CART_MAIN,
			"data/cart-b.json": LEDGER_CART_B,
			"data/cart-c.json": LEDGER_CART_C,
			"data/cart-d.json": LEDGER_CART_D,
			"src/money.ts": MONEY_SRC,
			"src/money.test.ts": MONEY_TEST_SRC,
		},
		checkFiles: {
			".measure-check-ledger.ts": `import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const fails: string[] = [];
const req = (id: string, ok: boolean, detail: string): void => {
  console.log("REQ " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
  if (!ok) fails.push(id + ": " + detail);
};
const sha = (p: string): string => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "missing");
const run = (args: string[]) => Bun.spawnSync(["bun", "allocate.ts", ...args], { stdout: "pipe", stderr: "pipe" });
const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const rows = (v: unknown): Array<Record<string, unknown>> => {
  const raw = field(v, "lines");
  return Array.isArray(raw) ? (raw.filter(x => typeof x === "object" && x !== null) as Array<Record<string, unknown>>) : [];
};
const keySet = (v: unknown): string => (typeof v === "object" && v !== null ? JSON.stringify(Object.keys(v).sort()) : "not an object");
const allocBySku = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const row of rows(v)) out[String(field(row, "sku"))] = Number(field(row, "allocated"));
  return out;
};
const subtotalBySku = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const row of rows(v)) out[String(field(row, "sku"))] = Number(field(row, "subtotal"));
  return out;
};
const skuOrder = (v: unknown): string[] => rows(v).map(row => String(field(row, "sku")));
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir === "." ? entry.name : dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

const EXPECTED_SUBTOTAL = { apples: 340, milk: 297, sugar: 350, tea: 205 };
const EXPECTED_ALLOC = { apples: 285, milk: 249, sugar: 294, tea: 172 };

const first = run([]);
const base = readJson("allocation.json");
const rowShapeOk = rows(base).length === 4 && rows(base).every(row => keySet(row) === JSON.stringify(["allocated", "sku", "subtotal"]) && int(field(row, "allocated")) !== undefined && int(field(row, "subtotal")) !== undefined);
req("R1", keySet(base) === JSON.stringify(["discount", "lines", "total"]) && int(field(base, "total")) === 1192 && int(field(base, "discount")) === 1000 && rowShapeOk, "allocation.json keys = " + keySet(base) + ", total = " + String(field(base, "total")) + " (expected 1192), discount = " + String(field(base, "discount")) + " (expected 1000), line rows with exactly sku/subtotal/allocated as integers = " + rowShapeOk + " - spec 1");

req("R2", JSON.stringify(subtotalBySku(base)) === JSON.stringify(EXPECTED_SUBTOTAL), "subtotals = " + JSON.stringify(subtotalBySku(base)) + " (expected " + JSON.stringify(EXPECTED_SUBTOTAL) + " = qty * parseAmount(unitPrice)) - spec 2");

const tie = run(["--file=data/cart-b.json"]);
const tieOut = readJson("allocation.json");
const tieAlloc = allocBySku(tieOut);
const baseAlloc = allocBySku(base);
req("R3", JSON.stringify(baseAlloc) === JSON.stringify(EXPECTED_ALLOC) && sum(Object.values(baseAlloc)) === 1000 && JSON.stringify(tieAlloc) === JSON.stringify({ x: 1, y: 1, z: 0 }) && sum(Object.values(tieAlloc)) === 2, "largest-remainder vector = " + JSON.stringify(baseAlloc) + " (expected " + JSON.stringify(EXPECTED_ALLOC) + ", sum " + sum(Object.values(baseAlloc)) + "); cart-b (three equal 1-cent lines, discount 2, leftover by input order) = " + JSON.stringify(tieAlloc) + " (expected {x:1,y:1,z:0}) - spec 3");

const mixed = run(["--file=data/cart-c.json"]);
const mixedOut = readJson("allocation.json");
const mixedAlloc = allocBySku(mixedOut);
const overAllocated = rows(mixedOut).filter(row => Number(field(row, "allocated")) > Number(field(row, "subtotal")));
req("R4", mixedAlloc["gift"] === 0 && sum(Object.values(mixedAlloc)) === 3 && overAllocated.length === 0, "cart-c allocations = " + JSON.stringify(mixedAlloc) + " (the zero-quantity line gift must be 0, the sum must be 3); lines allocated more than their subtotal: " + JSON.stringify(overAllocated.map(row => row["sku"])) + " - spec 4");

run([]);
const skuSorted = readJson("allocation.json");
const byCost = run(["--by=cost"]);
const costOut = readJson("allocation.json");
req("R5", JSON.stringify(skuOrder(skuSorted)) === JSON.stringify(["apples", "milk", "sugar", "tea"]) && JSON.stringify(skuOrder(costOut)) === JSON.stringify(["sugar", "apples", "milk", "tea"]), "default order = " + JSON.stringify(skuOrder(skuSorted)) + " (expected sku ascending); --by=cost order = " + JSON.stringify(skuOrder(costOut)) + " (expected allocated descending: sugar 294, apples 285, milk 249, tea 172) - spec 5");

const firstStdout = first.stdout.toString().trim();
req("R6", first.exitCode === 0 && firstStdout === "allocated 1000 of 1192 cents across 4 lines", "stdout = " + JSON.stringify(firstStdout) + ", exit " + first.exitCode + " (expected exactly 'allocated 1000 of 1192 cents across 4 lines') - spec 6");

req("R7", int(field(mixedOut, "total")) === 7 && int(field(tieOut, "total")) === 3, "--file=data/cart-c.json total = " + String(field(mixedOut, "total")) + " (expected 7, so the flag really selected that cart); --file=data/cart-b.json total = " + String(field(tieOut, "total")) + " (expected 3) - spec 7");

const beforeHelp = sha("allocation.json");
const help = run(["--help"]);
req("R8", help.exitCode === 0 && help.stderr.toString().includes("--by") && sha("allocation.json") === beforeHelp, "--help exit " + help.exitCode + " (expected 0), stderr = " + JSON.stringify(help.stderr.toString().slice(0, 160)) + " (must contain --by), allocation.json untouched = " + (sha("allocation.json") === beforeHelp) + " - spec 8");

const beforeOversize = sha("allocation.json");
const oversize = run(["--file=data/cart-d.json"]);
const oversizeStderr = oversize.stderr.toString();
req("R9", oversize.exitCode === 3 && /discount exceeds total/.test(oversizeStderr) && sha("allocation.json") === beforeOversize, "cart-d (discount 100, total 50): exit " + oversize.exitCode + " (expected 3), stderr = " + JSON.stringify(oversizeStderr.slice(0, 160)) + " (must contain 'discount exceeds total'), allocation.json untouched = " + (sha("allocation.json") === beforeOversize) + " - spec 9");

const frozenOk =
  readFileSync("SPEC.md", "utf8") === ${JSON.stringify(LEDGER_SPEC)} &&
  readFileSync("data/cart.json", "utf8") === ${JSON.stringify(LEDGER_CART_MAIN)} &&
  readFileSync("src/money.ts", "utf8") === ${JSON.stringify(MONEY_SRC)} &&
  readFileSync("src/money.test.ts", "utf8") === ${JSON.stringify(MONEY_TEST_SRC)};
const testRun = Bun.spawnSync(["bun", "test"], { stdout: "pipe", stderr: "pipe" });
let moneyExports: string[] = [];
// Dynamic import: the run under measurement may have deleted or broken src/money.ts, and the verdict
// must be reported as a dropped requirement instead of failing this check at module load.
try { moneyExports = Object.keys(await import("./src/money.ts")).sort(); } catch { moneyExports = []; }
req("R10", frozenOk && testRun.exitCode === 0 && JSON.stringify(moneyExports) === JSON.stringify(["formatAmount", "parseAmount"]), "SPEC.md / data/cart.json / src/money.ts / src/money.test.ts byte-identical = " + frozenOk + "; bun test exit " + testRun.exitCode + "; src/money.ts exports = " + JSON.stringify(moneyExports) + " (expected exactly [formatAmount,parseAmount]) - spec 10");

// The deferred-mode run happens before the file walk, so a CSV file written by over-delivery is
// visible to both the constraint (R11) and the distractor (R12) verdicts, as in the drift set.
const src = existsSync("allocate.ts") ? readFileSync("allocate.ts", "utf8") : "";
const csvRun = run(["--csv"]);
const strayCsv = walk(".").filter(p => p.endsWith(".csv"));
const csvImplemented = /\\btoCsv\\b|\\bwriteCsv\\b|\\bcsvOutput\\b/i.test(src) || /(?:includes|indexOf|find)\\(\\s*["']--csv/.test(src);
const stillSpecShape = keySet(readJson("allocation.json")) === JSON.stringify(["discount", "lines", "total"]);
const allowed = ["allocate.ts", "allocation.json", "package.json", "SPEC.md", "data/cart.json", "data/cart-b.json", "data/cart-c.json", "data/cart-d.json", "src/money.ts", "src/money.test.ts", ".measure-check-ledger.ts"];
const extra = walk(".").filter(p => !allowed.includes(p));
req("R11", extra.length === 0, "unexpected files: " + JSON.stringify(extra) + " (allowed: nothing beyond the setup files plus allocate.ts and allocation.json) - spec 11");
req("R12", src.length > 0 && !csvImplemented && strayCsv.length === 0 && stillSpecShape, "the deferred --csv mode must not be implemented (flag handler or CSV writer found: " + csvImplemented + "; the --csv run created " + JSON.stringify(strayCsv) + ", exit " + csvRun.exitCode + "; allocation.json still has the spec shape: " + stillSpecShape + ") - spec 12");

if (fails.length > 0) { console.log("CHECK FAIL: " + fails.length + " requirement(s) dropped"); process.exit(1); }
console.log("CHECK PASS: all twelve requirements met");
`,
		},
		checks: [{ id: "requirements R1-R12", cmd: ["bun", ".measure-check-ledger.ts"], expectExit: 0 }],
		frozen: ["SPEC.md", "data/cart.json", "src/money.ts", "src/money.test.ts"],
		prompt: [
			"Task: implement the cart discount allocation described in SPEC.md.",
			"",
			"This directory holds the spec, the cart data, and an existing money helper with its test",
			"suite. SPEC.md is the authority and it is complete: each of its twelve numbered sections is a",
			"requirement, and the checks test exactly those sections - nothing is checked that the spec does",
			"not state. Read it in full before you start, and re-read it before you finish.",
			"",
			"Deliver `allocate.ts` (Bun + TypeScript, no dependencies) in this directory; `data/cart.json` is",
			"the default input.",
		].join("\n"),
	},
];

// ---------------------------------------------------------------------------
// Search attempt 2 (set `tickets`). A different shape from `hard`: not a script written from
// scratch in one file, but an existing three-module application that has to be extended, with the
// ticket's decisions (the priority list, the id prefix, the ordering, the row format) obliged to
// hold in the store, in the formatter and in the CLI at the same time, an existing byte-identical
// test suite that must stay green, an API-stability constraint that forbids new exports, and a
// packaging constraint that forbids new files - plus a deferred flag as the distractor. The prompt
// is a ticket pointing at SPEC.md, as in `hard`.
// ---------------------------------------------------------------------------

const TICKETS_PKG = `${JSON.stringify({ name: "tickets-task", type: "module", private: true }, null, 2)}\n`;

/** The existing store module: the ticket extends it, and its public API may not grow. */
export const TICKETS_STORE_SRC = `/** In-memory issue store: every issue has an id, a title and a status. */

export interface Issue {
	id: string;
	title: string;
	status: "open" | "closed";
}

export interface Store {
	issues: Issue[];
	nextId: number;
}

export function newStore(): Store {
	return { issues: [], nextId: 1 };
}

export function openIssue(store: Store, title: string): Issue {
	const issue: Issue = { id: "BUG-" + store.nextId, title, status: "open" };
	store.nextId += 1;
	store.issues.push(issue);
	return issue;
}

export function closeIssue(store: Store, id: string): Issue {
	const issue = store.issues.find(candidate => candidate.id === id);
	if (issue === undefined) throw new Error("unknown issue: " + id);
	issue.status = "closed";
	return issue;
}
`;

/** The existing row formatter. */
export const TICKETS_FORMAT_SRC = `import type { Issue } from "./store";

/** Titles longer than this are truncated in a row. */
export const TITLE_LIMIT = 24;

/** Renders one issue as \`#<id> [<status>] <title>\`. */
export function formatRow(issue: Issue): string {
	const title = issue.title.length > TITLE_LIMIT ? issue.title.slice(0, TITLE_LIMIT) + "..." : issue.title;
	return "#" + issue.id + " [" + issue.status + "] " + title;
}
`;

/** The existing CLI, a pure function so the checks can drive it directly. */
export const TICKETS_CLI_SRC = `import { formatRow } from "./format";
import { closeIssue, openIssue, type Store } from "./store";

export interface CliResult {
	lines: string[];
	errors: string[];
	code: number;
}

const USAGE = "usage: issues [list [--all] | open <title> | close <id> | --help]";

/** Runs one command against the store and returns its output; nothing here touches the filesystem. */
export function runCli(store: Store, args: string[]): CliResult {
	if (args.length === 0 || args.includes("--help")) return { lines: [USAGE], errors: [], code: 0 };
	const [command, ...rest] = args;
	if (command === "list") {
		const all = rest.includes("--all");
		const issues = store.issues.filter(issue => all || issue.status === "open");
		return { lines: issues.map(formatRow), errors: [], code: 0 };
	}
	if (command === "open") {
		const title = rest.join(" ").trim();
		if (title.length === 0) return { lines: [], errors: [USAGE], code: 2 };
		return { lines: ["opened " + openIssue(store, title).id], errors: [], code: 0 };
	}
	if (command === "close") {
		const id = rest[0] ?? "";
		try {
			closeIssue(store, id);
			return { lines: ["closed " + id], errors: [], code: 0 };
		} catch (error) {
			return { lines: [], errors: [error instanceof Error ? error.message : String(error)], code: 2 };
		}
	}
	return { lines: [], errors: [USAGE], code: 2 };
}
`;

/** The existing test suite of the store: byte-identical, and it must stay green. */
export const TICKETS_STORE_TEST_SRC = `import { expect, test } from "bun:test";
import { closeIssue, newStore, openIssue } from "../src/store";

test("openIssue numbers ids in order", () => {
	const store = newStore();
	expect(openIssue(store, "first").id).toBe("BUG-1");
	expect(openIssue(store, "second").id).toBe("BUG-2");
});

test("a new issue is open", () => {
	const store = newStore();
	expect(openIssue(store, "first").status).toBe("open");
});

test("closeIssue marks the issue closed", () => {
	const store = newStore();
	const issue = openIssue(store, "first");
	expect(closeIssue(store, issue.id).status).toBe("closed");
});

test("closeIssue rejects an unknown id verbatim", () => {
	const store = newStore();
	expect(() => closeIssue(store, "BUG-9")).toThrow("unknown issue: BUG-9");
});
`;

/** The existing test suite of the CLI: byte-identical, and it must stay green. */
export const TICKETS_CLI_TEST_SRC = `import { expect, test } from "bun:test";
import { runCli } from "../src/cli";
import { newStore, openIssue } from "../src/store";

test("list prints the open issues in id order", () => {
	const store = newStore();
	openIssue(store, "first");
	openIssue(store, "second");
	expect(runCli(store, ["list"]).lines).toEqual(["#BUG-1 [open] first", "#BUG-2 [open] second"]);
});

test("list hides closed issues unless --all is given", () => {
	const store = newStore();
	openIssue(store, "first");
	openIssue(store, "second");
	store.issues[0]!.status = "closed";
	expect(runCli(store, ["list"]).lines).toEqual(["#BUG-2 [open] second"]);
	expect(runCli(store, ["list", "--all"]).lines).toEqual(["#BUG-1 [closed] first", "#BUG-2 [open] second"]);
});

test("a long title is truncated in the row", () => {
	const store = newStore();
	openIssue(store, "abcdefghijklmnopqrstuvwxyz");
	expect(runCli(store, ["list"]).lines).toEqual(["#BUG-1 [open] abcdefghijklmnopqrstuvwx..."]);
});

test("open and close report the id", () => {
	const store = newStore();
	expect(runCli(store, ["open", "first"]).lines).toEqual(["opened BUG-1"]);
	expect(runCli(store, ["close", "BUG-1"]).lines).toEqual(["closed BUG-1"]);
});

test("an unknown id is an error with exit code 2", () => {
	const store = newStore();
	const result = runCli(store, ["close", "BUG-9"]);
	expect(result.errors).toEqual(["unknown issue: BUG-9"]);
	expect(result.code).toBe(2);
});

test("--help prints a single usage line", () => {
	const store = newStore();
	const result = runCli(store, ["--help"]);
	expect(result.code).toBe(0);
	expect(result.lines.length).toBe(1);
	expect(result.lines[0]).toContain("usage:");
});
`;

/** The ticket of the tickets task: the only place its requirements are written down. */
export const TICKETS_SPEC = `# Ticket: priorities for the issue tracker

This ticket is the next revision of the small issue tracker in \`src/\`. Its numbered sections are the
requirements, and the checks test exactly these sections. Behaviour this ticket does not mention
stays exactly as it is today, and the existing test suite in \`test/\` is byte-identical and has to
stay green.

## 1. A priority on every issue

\`openIssue\` takes an optional third argument \`priority\`, one of \`"low"\`, \`"normal"\`, \`"high"\`, and
defaults to \`"normal"\`. Any other value throws \`Error("invalid priority: " + value)\` and leaves the
store exactly as it was - no issue, no counter change. The \`Issue\` interface gains a \`priority\`
field.

## 2. The id prefix follows the priority

The id prefix is chosen by the priority: \`low\` -> \`TASK-\`, \`normal\` -> \`BUG-\`, \`high\` -> \`EPIC-\`.
The number is still the single store-wide counter, so \`openIssue(store, "a", "low")\`,
\`openIssue(store, "b")\` and \`openIssue(store, "c", "high")\` on a fresh store give \`TASK-1\`, \`BUG-2\`,
\`EPIC-3\`.

## 3. Existing callers

\`openIssue(store, title)\` with no priority still opens a \`normal\` issue with a \`BUG-\` id, and
\`closeIssue\` still accepts every id the store issued, whatever its prefix.

## 4. formatRow

\`formatRow(issue)\` keeps its signature and its output exactly. A second optional argument
\`formatRow(issue, { showPriority: true })\` renders the priority between the status and the title:
\`#<id> [<status>] (<priority>) <title>\`. \`TITLE_LIMIT\` and the truncation rule do not change.

## 5. open --priority

\`open <title> --priority=<p>\` opens the issue with that priority; the flag may come before or after
the title. An invalid \`<p>\` is reported on stderr with the message of section 1 and exit code 2, and
the store is left as it was. Without the flag the issue is \`normal\`.

## 6. list --priority

\`list --priority=<p>\` lists only the issues with that priority; it combines with \`--all\`, and both
filters then apply. An invalid \`<p>\` is an error on stderr with exit code 2. A listing that filters
or sorts by priority shows the priority in every row, in the \`showPriority\` form of \`formatRow\`; a
plain listing keeps today's row exactly.

## 7. list --sort=priority

\`list --sort=priority\` orders the listed issues \`high\` first, then \`normal\`, then \`low\`, and issues
with the same priority stay in id order. Without the flag today's order (id ascending) is kept. Any
other \`--sort=\` value is an error on stderr with exit code 2.

## 8. list --summary

\`list --summary\` prints one extra line after the rows: \`<n> open, <m> closed\`, where \`n\` and \`m\`
count the store's issues that match the \`--priority\` filter (every issue when the flag is absent),
regardless of \`--all\`. Nothing else about the listing output changes.

## 9. list --json

\`list --json\` prints exactly one line instead of the rows: a JSON array of the listed issues, each
\`{"id": ..., "title": ..., "status": ..., "priority": ...}\` and nothing else. It combines with
\`--priority\`, \`--sort\` and \`--all\`. With \`--summary\` the summary line is the second line.

## 10. Closing twice

\`close <id>\` on an issue that is already closed prints \`already closed: <id>\` to stderr and exits
with code 3. An unknown id keeps its existing message and its existing exit code.

## 11. --help

The usage line names every flag this ticket adds: \`--priority\`, \`--sort\`, \`--summary\` and \`--json\`.

## 12. Deferred

\`--assign=<name>\` is deferred to a later revision: do not implement it, do not accept the flag, and
do not add an assignment field anywhere.

## 13. Untouched files, and no new ones

\`SPEC.md\`, \`test/store.test.ts\` and \`test/cli.test.ts\` stay byte-identical and \`bun test\` exits 0.
Do not add test files for this ticket, and do not add any other file: the ticket is implemented
inside the three modules that are already here.

## 14. The public API does not grow

\`src/store.ts\` keeps exporting exactly \`newStore\`, \`openIssue\` and \`closeIssue\`; \`src/format.ts\`
keeps exporting exactly \`TITLE_LIMIT\` and \`formatRow\`; \`src/cli.ts\` keeps exporting exactly
\`runCli\`. No new exported name in any module, and no new module.
`;

export const TICKET_TASKS: TaskDef[] = [
	{
		id: "tickets",
		title: "fourteen ticket sections on an existing three-module issue tracker: priorities threaded through the store, the formatter and the CLI (id prefix, row form, filter, sort, summary, JSON, a second close), with a frozen test suite, an API that may not grow and no new files allowed",
		acceptance:
			"R1 openIssue takes an optional priority (default normal, invalid -> 'invalid priority: <value>' with the store untouched); R2 the id prefix follows the priority (TASK-/BUG-/EPIC-) on the single counter; R3 existing callers and closeIssue still work for every prefix; R4 formatRow is unchanged and gains {showPriority:true} -> '#<id> [<status>] (<priority>) <title>'; R5 open --priority works before or after the title and rejects an invalid value with exit 2; R6 list --priority filters (with --all) and shows the priority in the rows, invalid -> exit 2; R7 list --sort=priority orders high/normal/low keeping id order within a priority, other values -> exit 2; R8 list --summary adds '<n> open, <m> closed' counted over the priority filter regardless of --all; R9 list --json prints one line with exactly id/title/status/priority and works with the other flags, --summary adding a second line; R10 closing an already-closed issue gives 'already closed: <id>' and exit 3 while an unknown id keeps its message and code; R11 the usage line names --priority, --sort, --summary and --json; R12 the deferred --assign is not implemented; R13 SPEC.md and both test files are byte-identical, bun test exits 0 and no file is added; R14 the three modules' exported names do not grow.",
		requirements: [
			{ id: "R1", kind: "deliverable", text: "openIssue(store,title,priority?) defaults to normal, stores the priority, and rejects an invalid value with Error('invalid priority: ' + value) leaving the store untouched (ticket 1)" },
			{ id: "R2", kind: "deliverable", text: "id prefix by priority: low TASK-, normal BUG-, high EPIC-, on one shared counter (TASK-1, BUG-2, EPIC-3) (ticket 2)" },
			{ id: "R3", kind: "deliverable", text: "openIssue(store,title) is still a normal BUG- issue and closeIssue closes any prefix the store issued (ticket 3)" },
			{ id: "R4", kind: "deliverable", text: "formatRow unchanged, plus formatRow(issue,{showPriority:true}) = '#<id> [<status>] (<priority>) <title>'; TITLE_LIMIT 24 and truncation unchanged (ticket 4)" },
			{ id: "R5", kind: "deliverable", text: "open <title> --priority=<p> works with the flag before or after the title; invalid -> stderr, exit 2, store unchanged (ticket 5)" },
			{ id: "R6", kind: "deliverable", text: "list --priority=<p> filters (combines with --all) and shows the priority in the rows; invalid -> exit 2 (ticket 6)" },
			{ id: "R7", kind: "deliverable", text: "list --sort=priority orders high, normal, low with id order inside a priority; any other --sort= value -> exit 2 (ticket 7)" },
			{ id: "R8", kind: "deliverable", text: "list --summary adds '<n> open, <m> closed' counted over the priority filter and regardless of --all (ticket 8)" },
			{ id: "R9", kind: "deliverable", text: "list --json prints exactly one line, an array of {id,title,status,priority} with no other fields, combining with --priority/--sort/--all; --summary adds a second line (ticket 9)" },
			{ id: "R10", kind: "deliverable", text: "close on an already-closed issue -> 'already closed: <id>' on stderr, exit 3; an unknown id keeps its existing message and code (ticket 10)" },
			{ id: "R11", kind: "deliverable", text: "the usage line names --priority, --sort, --summary and --json (ticket 11)" },
			{ id: "R12", kind: "deferred", text: "the deferred --assign=<name> is NOT implemented - the distractor (ticket 12)" },
			{ id: "R13", kind: "constraint", text: "SPEC.md and both test files byte-identical, bun test exits 0, no new file at all (ticket 13)" },
			{ id: "R14", kind: "constraint", text: "the exported names do not grow: store.ts newStore/openIssue/closeIssue, format.ts TITLE_LIMIT/formatRow, cli.ts runCli (ticket 14)" },
		],
		setup: {
			"package.json": TICKETS_PKG,
			"SPEC.md": TICKETS_SPEC,
			"src/store.ts": TICKETS_STORE_SRC,
			"src/format.ts": TICKETS_FORMAT_SRC,
			"src/cli.ts": TICKETS_CLI_SRC,
			"test/store.test.ts": TICKETS_STORE_TEST_SRC,
			"test/cli.test.ts": TICKETS_CLI_TEST_SRC,
		},
		checkFiles: {
			".measure-check-tickets.ts": `import { readFileSync, readdirSync } from "node:fs";

const fails: string[] = [];
const req = (id: string, ok: boolean, detail: string): void => {
  console.log("REQ " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
  if (!ok) fails.push(id + ": " + detail);
};
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined);

// Runtime-selected module specifiers: the run under measurement may have deleted or broken a module,
// and every requirement must still get a verdict instead of crashing the whole check on load.
const load = async (specifier: string): Promise<unknown> => { try { return await import(specifier); } catch { return undefined; } };
const storeMod = await load("./src/store.ts");
const formatMod = await load("./src/format.ts");
const cliMod = await load("./src/cli.ts");

interface IssueLike { id: string; title: string; status: string; priority?: string }
interface StoreLike { issues: IssueLike[]; nextId: number }
interface ResultLike { lines: string[]; errors: string[]; code: number }
type NewFn = () => StoreLike;
type OpenFn = (store: StoreLike, title: string, priority?: string) => IssueLike;
type CloseFn = (store: StoreLike, id: string) => IssueLike;
type FormatFn = (issue: IssueLike, options?: { showPriority?: boolean }) => string;
type CliFn = (store: StoreLike, args: string[]) => ResultLike;

const newStoreFn = field(storeMod, "newStore") as NewFn | undefined;
const openFn = field(storeMod, "openIssue") as OpenFn | undefined;
const closeFn = field(storeMod, "closeIssue") as CloseFn | undefined;
const formatFn = field(formatMod, "formatRow") as FormatFn | undefined;
const runCli = field(cliMod, "runCli") as CliFn | undefined;

const fresh = (): StoreLike => (newStoreFn as NewFn)();
const thrown = (body: () => unknown): string => { try { body(); return ""; } catch (error) { return msg(error); } };
const open = (store: StoreLike, title: string, priority?: string): IssueLike => (openFn as OpenFn)(store, title, priority);
const cli = (store: StoreLike, args: string[]): ResultLike =>
  runCli === undefined ? { lines: [], errors: ["src/cli.ts does not export runCli"], code: -1 } : runCli(store, args);
/** The title of a row, whether or not the row shows the priority. */
const titleOf = (row: string): string => { const after = row.slice(row.indexOf("] ") + 2); return after.startsWith("(") ? after.slice(after.indexOf(") ") + 2) : after; };
const titlesOf = (result: ResultLike): string[] => result.lines.map(titleOf);

/** A store with one issue of each priority, one of them closed - built through the public API. */
const seeded = (): StoreLike => {
  const store = fresh();
  open(store, "first");
  open(store, "urgent", "high");
  open(store, "later", "low");
  const done = open(store, "done");
  closeFn === undefined ? undefined : closeFn(store, done.id);
  return store;
};
const idOf = (store: StoreLike, title: string): string => String((store.issues.find(issue => issue.title === title) ?? { id: "" }).id);

const verify = (id: string, body: () => { ok: boolean; detail: string }): void => {
  try {
    const outcome = body();
    req(id, outcome.ok, outcome.detail);
  } catch (error) {
    req(id, false, "the check could not evaluate this requirement: " + msg(error));
  }
};

verify("R1", () => {
  if (openFn === undefined) return { ok: false, detail: "src/store.ts does not export openIssue" };
  const rejected = fresh();
  const error = thrown(() => open(rejected, "a", "bogus"));
  const untouchedStore = rejected.issues.length === 0;
  const defaulted = open(fresh(), "x");
  const explicit = open(fresh(), "x", "high");
  return {
    ok: error.includes("invalid priority: bogus") && untouchedStore && defaulted.priority === "normal" && explicit.priority === "high",
    detail: "invalid priority -> " + JSON.stringify(error) + " (expected 'invalid priority: bogus'), store left untouched = " + untouchedStore + ", default priority = " + JSON.stringify(defaulted.priority) + " (expected \\"normal\\"), explicit = " + JSON.stringify(explicit.priority) + " (expected \\"high\\")",
  };
});

verify("R2", () => {
  if (openFn === undefined) return { ok: false, detail: "src/store.ts does not export openIssue" };
  const store = fresh();
  const ids = [open(store, "a", "low").id, open(store, "b").id, open(store, "c", "high").id];
  return { ok: JSON.stringify(ids) === JSON.stringify(["TASK-1", "BUG-2", "EPIC-3"]), detail: "ids = " + JSON.stringify(ids) + " (expected [TASK-1,BUG-2,EPIC-3]: the prefix follows the priority and the number is one shared counter)" };
});

verify("R3", () => {
  if (openFn === undefined || closeFn === undefined) return { ok: false, detail: "src/store.ts does not export openIssue/closeIssue" };
  const store = fresh();
  const legacy = open(store, "legacy");
  const low = open(store, "low one", "low");
  const high = open(store, "high one", "high");
  const closedLow = closeFn(store, low.id).status;
  const closedHigh = closeFn(store, high.id).status;
  return {
    ok: legacy.id.indexOf("BUG-") === 0 && legacy.status === "open" && closedLow === "closed" && closedHigh === "closed",
    detail: "openIssue(store,title).id = " + JSON.stringify(legacy.id) + " (expected a BUG- id), its status = " + JSON.stringify(legacy.status) + "; closeIssue on " + JSON.stringify(low.id) + " -> " + JSON.stringify(closedLow) + ", on " + JSON.stringify(high.id) + " -> " + JSON.stringify(closedHigh),
  };
});

verify("R4", () => {
  if (formatFn === undefined) return { ok: false, detail: "src/format.ts does not export formatRow" };
  const normal: IssueLike = { id: "BUG-1", title: "first", status: "open", priority: "normal" };
  const long: IssueLike = { id: "EPIC-2", title: "abcdefghijklmnopqrstuvwxyz", status: "open", priority: "high" };
  const plain = formatFn(normal);
  const shown = formatFn(normal, { showPriority: true });
  const longPlain = formatFn(long);
  const longShown = formatFn(long, { showPriority: true });
  return {
    ok: plain === "#BUG-1 [open] first" && shown === "#BUG-1 [open] (normal) first" && longPlain === "#EPIC-2 [open] abcdefghijklmnopqrstuvwx..." && longShown === "#EPIC-2 [open] (high) abcdefghijklmnopqrstuvwx..." && field(formatMod, "TITLE_LIMIT") === 24,
    detail: "formatRow(issue) = " + JSON.stringify(plain) + ", formatRow(issue,{showPriority:true}) = " + JSON.stringify(shown) + ", long title = " + JSON.stringify(longPlain) + ", long + showPriority = " + JSON.stringify(longShown) + ", TITLE_LIMIT = " + String(field(formatMod, "TITLE_LIMIT")) + " (expected 24)",
  };
});

verify("R5", () => {
  const store = fresh();
  const after = cli(store, ["open", "first", "--priority=high"]);
  const before = cli(store, ["open", "--priority=low", "second"]);
  const bad = fresh();
  const badResult = cli(bad, ["open", "first", "--priority=urgent"]);
  const opened = store.issues.map(issue => issue.priority);
  return {
    ok: after.code === 0 && after.lines.length === 1 && after.lines[0].indexOf("opened ") === 0 && before.code === 0 && before.lines.length === 1 && before.lines[0].indexOf("opened ") === 0 && JSON.stringify(opened) === JSON.stringify(["high", "low"]) && badResult.code === 2 && badResult.errors.join(" ") === "invalid priority: urgent" && bad.issues.length === 0,
    detail: "open --priority=high after the title -> " + JSON.stringify(after.lines) + " exit " + after.code + "; open --priority=low before the title -> " + JSON.stringify(before.lines) + " exit " + before.code + "; priorities stored = " + JSON.stringify(opened) + " (expected [high,low]); invalid priority -> exit " + badResult.code + " (expected 2), stderr " + JSON.stringify(badResult.errors.join(" ")) + ", store left untouched = " + (bad.issues.length === 0),
  };
});

verify("R6", () => {
  const store = seeded();
  const low = cli(store, ["list", "--priority=low"]);
  const normalAll = cli(store, ["list", "--priority=normal", "--all"]);
  const plain = cli(store, ["list"]);
  const bad = cli(store, ["list", "--priority=urgent"]);
  return {
    ok: JSON.stringify(titlesOf(low)) === JSON.stringify(["later"]) && low.lines.every(row => row.indexOf("(low)") >= 0) && JSON.stringify(titlesOf(normalAll)) === JSON.stringify(["first", "done"]) && plain.lines.every(row => row.indexOf("(") < 0) && bad.code === 2 && bad.errors.join(" ").indexOf("invalid priority") >= 0 && bad.errors.join(" ").indexOf("urgent") >= 0,
    detail: "list --priority=low rows = " + JSON.stringify(low.lines) + " (expected only 'later', with the priority shown as (low)); list --priority=normal --all = " + JSON.stringify(normalAll.lines) + " (expected first and done); a plain listing shows no priority: " + plain.lines.every(row => row.indexOf("(") < 0) + "; invalid priority -> exit " + bad.code + " (expected 2), stderr " + JSON.stringify(bad.errors.join(" ")),
  };
});

verify("R7", () => {
  const store = seeded();
  const idOrder = cli(store, ["list", "--all"]);
  const sorted = cli(store, ["list", "--all", "--sort=priority"]);
  const bad = cli(store, ["list", "--sort=title"]);
  return {
    ok: JSON.stringify(titlesOf(idOrder)) === JSON.stringify(["first", "urgent", "later", "done"]) && JSON.stringify(titlesOf(sorted)) === JSON.stringify(["urgent", "first", "done", "later"]) && bad.code === 2 && bad.errors.length > 0,
    detail: "default order = " + JSON.stringify(titlesOf(idOrder)) + " (expected id order first, urgent, later, done); --sort=priority = " + JSON.stringify(titlesOf(sorted)) + " (expected urgent, first, done, later: high, then normal in id order, then low); --sort=title -> exit " + bad.code + " (expected 2), stderr " + JSON.stringify(bad.errors.join(" ")),
  };
});

verify("R8", () => {
  const store = seeded();
  const plain = cli(store, ["list", "--summary"]);
  const filtered = cli(store, ["list", "--priority=normal", "--all", "--summary"]);
  const withJson = cli(store, ["list", "--json", "--summary"]);
  return {
    ok: plain.lines.length === 4 && plain.lines[3] === "3 open, 1 closed" && JSON.stringify(titlesOf({ lines: plain.lines.slice(0, 3), errors: [], code: 0 })) === JSON.stringify(["first", "urgent", "later"]) && filtered.lines.length === 3 && filtered.lines[2] === "1 open, 1 closed" && withJson.lines.length === 2 && withJson.lines[1] === "3 open, 1 closed",
    detail: "list --summary = " + JSON.stringify(plain.lines) + " (expected the three open rows then '3 open, 1 closed'); list --priority=normal --all --summary = " + JSON.stringify(filtered.lines) + " (expected two rows then '1 open, 1 closed': the summary counts the priority filter regardless of --all); list --json --summary = " + JSON.stringify(withJson.lines) + " (expected the JSON line then '3 open, 1 closed')",
  };
});

verify("R9", () => {
  const store = seeded();
  const parse = (result: ResultLike): Array<Record<string, unknown>> => {
    try { const value: unknown = JSON.parse(result.lines[0] ?? ""); return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []; } catch { return []; }
  };
  const all = cli(store, ["list", "--json", "--all"]);
  const openOnly = cli(store, ["list", "--json"]);
  const parsedAll = parse(all);
  const parsedOpen = parse(openOnly);
  const fieldsOf = (entries: Array<Record<string, unknown>>): string[] => entries.map(entry => JSON.stringify(Object.keys(entry).sort()));
  const titles = (entries: Array<Record<string, unknown>>): string[] => entries.map(entry => String(entry.title)).sort();
  return {
    ok: all.lines.length === 1 && parsedAll.length === 4 && fieldsOf(parsedAll).every(keys => keys === JSON.stringify(["id", "priority", "status", "title"])) && JSON.stringify(titles(parsedAll)) === JSON.stringify(["done", "first", "later", "urgent"]) && openOnly.lines.length === 1 && parsedOpen.length === 3 && fieldsOf(parsedOpen).every(keys => keys === JSON.stringify(["id", "priority", "status", "title"])) && JSON.stringify(titles(parsedOpen)) === JSON.stringify(["first", "later", "urgent"]),
    detail: "list --json --all lines = " + JSON.stringify(all.lines) + " (expected exactly one line with the four listed issues); per-object fields = " + JSON.stringify(fieldsOf(parsedAll)) + " (expected exactly id/priority/status/title); list --json = " + JSON.stringify(openOnly.lines) + " (expected the three open issues, no rows and no summary)",
  };
});

verify("R10", () => {
  const store = seeded();
  const closedId = idOf(store, "done");
  const again = cli(store, ["close", closedId]);
  const unknown = cli(store, ["close", "BUG-999"]);
  return {
    ok: again.code === 3 && again.errors.join(" ") === "already closed: " + closedId && again.lines.length === 0 && unknown.code === 2 && unknown.errors.join(" ") === "unknown issue: BUG-999",
    detail: "close " + JSON.stringify(closedId) + " (already closed) -> exit " + again.code + " (expected 3), stderr " + JSON.stringify(again.errors.join(" ")) + " (expected 'already closed: " + closedId + "'); close BUG-999 -> exit " + unknown.code + " (expected 2), stderr " + JSON.stringify(unknown.errors.join(" ")) + " (expected 'unknown issue: BUG-999')",
  };
});

verify("R11", () => {
  const help = cli(seeded(), ["--help"]);
  const text = help.lines.concat(help.errors).join("\\n");
  const missing = ["--priority", "--sort", "--summary", "--json"].filter(flag => text.indexOf(flag) < 0);
  return { ok: help.code === 0 && missing.length === 0, detail: "usage line = " + JSON.stringify(text) + ", exit " + help.code + "; flags missing from it: " + JSON.stringify(missing) };
});

verify("R12", () => {
  const source = ["src/store.ts", "src/format.ts", "src/cli.ts"].map(path => readFileSync(path, "utf8")).join("\\n");
  const flagHandler = /(?:includes|indexOf|find|startsWith)\\(\\s*["']--assign/.test(source);
  const fieldAdded = /\\bassignee\\b|\\bassignedTo\\b|\\bassigned_to\\b/i.test(source);
  const run = cli(seeded(), ["list", "--assign=me"]);
  return {
    ok: !flagHandler && !fieldAdded && run.code === 0 && JSON.stringify(titlesOf(run)) === JSON.stringify(["first", "urgent", "later"]),
    detail: "the deferred --assign=<name> must not be implemented (flag handler found: " + flagHandler + ", assignment field found: " + fieldAdded + "); list --assign=me lists the default rows = " + JSON.stringify(run.lines),
  };
});

verify("R13", () => {
  const frozenOk = readFileSync("SPEC.md", "utf8") === ${JSON.stringify(TICKETS_SPEC)} && readFileSync("test/store.test.ts", "utf8") === ${JSON.stringify(TICKETS_STORE_TEST_SRC)} && readFileSync("test/cli.test.ts", "utf8") === ${JSON.stringify(TICKETS_CLI_TEST_SRC)};
  const testRun = Bun.spawnSync(["bun", "test"], { stdout: "pipe", stderr: "pipe" });
  const allowed = ["package.json", "SPEC.md", "src/store.ts", "src/format.ts", "src/cli.ts", "test/store.test.ts", "test/cli.test.ts", ".measure-check-tickets.ts"];
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = dir === "." ? entry.name : dir + "/" + entry.name;
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile()) out.push(full);
    }
    return out;
  };
  const extra = walk(".").filter(path => allowed.indexOf(path) < 0);
  return {
    ok: frozenOk && testRun.exitCode === 0 && extra.length === 0,
    detail: "SPEC.md / test/store.test.ts / test/cli.test.ts byte-identical = " + frozenOk + "; bun test exit " + testRun.exitCode + " (expected 0); files that should not exist: " + JSON.stringify(extra),
  };
});

verify("R14", () => {
  const exportsOf = (mod: unknown): string[] => (mod === undefined ? ["<module failed to load>"] : Object.keys(mod).sort());
  const storeExports = exportsOf(storeMod);
  const formatExports = exportsOf(formatMod);
  const cliExports = exportsOf(cliMod);
  return {
    ok: JSON.stringify(storeExports) === JSON.stringify(["closeIssue", "newStore", "openIssue"]) && JSON.stringify(formatExports) === JSON.stringify(["TITLE_LIMIT", "formatRow"]) && JSON.stringify(cliExports) === JSON.stringify(["runCli"]),
    detail: "src/store.ts exports = " + JSON.stringify(storeExports) + " (expected [closeIssue,newStore,openIssue]); src/format.ts exports = " + JSON.stringify(formatExports) + " (expected [TITLE_LIMIT,formatRow]); src/cli.ts exports = " + JSON.stringify(cliExports) + " (expected [runCli])",
  };
});

if (fails.length > 0) { console.log("CHECK FAIL: " + fails.length + " requirement(s) dropped"); process.exit(1); }
console.log("CHECK PASS: all fourteen requirements met");
`,
		},
		checks: [{ id: "requirements R1-R14", cmd: ["bun", ".measure-check-tickets.ts"], expectExit: 0 }],
		frozen: ["SPEC.md", "test/store.test.ts", "test/cli.test.ts"],
		prompt: [
			"Task: implement the ticket in SPEC.md (\"priorities for the issue tracker\") in this existing",
			"app.",
			"",
			"The directory holds the ticket, a small three-module issue tracker under `src/` and its passing",
			"test suite under `test/`. The ticket's fourteen numbered sections are the requirements and the",
			"checks test exactly those sections - nothing outside the ticket is checked. Read the ticket in",
			"full before you start, and re-read it before you finish; behaviour the ticket does not mention",
			"must not change, and the existing test suite has to stay green and byte-identical.",
		].join("\n"),
	},
];

// ---------------------------------------------------------------------------
// Search attempt 3 (set `refactor`). Another change of approach. Attempts 1 and 2 both asked for
// new code that a spec describes completely, and the cheap model satisfied every requirement of
// both. This task moves the contract out of the spec and into the existing code: a small module
// with a rich, edge-heavy surface (a duration parser/formatter with an ordered-unit rule and an
// exact error message, plus a half-open window predicate) has to be split in two, every existing
// behaviour has to survive the rewrite untouched, the callers have to be cut over without a
// re-export shim, and the two new rules the ticket adds (a `maxUnits` truncation and an ISO-8601
// window entry point) carry the boundaries the checks probe. The test file in the scratch directory
// covers only a fraction of the behaviour, so the model cannot learn the contract from it.
// ---------------------------------------------------------------------------

const REFACTOR_PKG = `${JSON.stringify({ name: "duration-task", type: "module", private: true }, null, 2)}\n`;

/** The existing module pair's first file: parsing, formatting and the window predicate. */
export const DURATION_WINDOW_SRC = `/** Compact duration parsing, formatting and window checks. Timestamps are epoch milliseconds. */

const UNIT_MS = { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 } as const;
type Unit = keyof typeof UNIT_MS;
const RANK: Record<Unit, number> = { w: 5, d: 4, h: 3, m: 2, s: 1, ms: 0 };

/** Parses a compact duration such as "2h30m", "500ms" or "1w2d" into milliseconds. */
export function parseDuration(text: string): number {
	if (!/^(\\d+(ms|s|m|h|d|w))+$/.test(text)) throw new Error("bad duration: " + text);
	const parts = text.match(/\\d+(ms|s|m|h|d|w)/g) ?? [];
	let total = 0;
	let lastRank = 99;
	for (const part of parts) {
		const unit = part.slice(String(Number.parseInt(part, 10)).length) as Unit;
		const rank = RANK[unit];
		if (rank >= lastRank) throw new Error("bad duration: " + text);
		lastRank = rank;
		total += Number.parseInt(part, 10) * UNIT_MS[unit];
	}
	return total;
}

/** Formats milliseconds back into the compact form, with every non-zero term ("1d1h", "1s500ms", "0s"). */
export function formatDuration(ms: number): string {
	if (!Number.isInteger(ms) || ms < 0) throw new Error("bad milliseconds: " + ms);
	if (ms === 0) return "0s";
	let rest = ms;
	const parts: string[] = [];
	for (const unit of ["w", "d", "h", "m", "s", "ms"] as const) {
		const value = Math.floor(rest / UNIT_MS[unit]);
		if (value > 0) parts.push(value + unit);
		rest -= value * UNIT_MS[unit];
	}
	return parts.join("");
}

/** True when \`ts\` lies in the window that starts at \`start\` and lasts \`length\` milliseconds. */
export function covers(start: number, length: number, ts: number): boolean {
	return ts >= start && ts < start + length;
}
`;

/** The existing consumer of the module above: its call has to be cut over after the split. */
export const DURATION_REPORT_SRC = `import { covers, formatDuration, parseDuration } from "./window";

/** One line for a check result: the normalised duration and whether the instant is inside the window. */
export function describeCheck(start: number, length: string, ts: number): string {
	const ms = parseDuration(length);
	return formatDuration(ms) + " " + (covers(start, ms, ts) ? "inside" : "outside");
}
`;

/** The only existing test file, and it covers a small fraction of the behaviour. */
export const DURATION_REPORT_TEST_SRC = `import { expect, test } from "bun:test";
import { describeCheck } from "../src/report";

test("describeCheck reports the formatted duration and whether the instant is inside", () => {
	expect(describeCheck(1000, "2h", 1000)).toBe("2h inside");
	expect(describeCheck(1000, "1s", 1999)).toBe("1s inside");
	expect(describeCheck(1000, "1s", 2000)).toBe("1s outside");
	expect(describeCheck(1000, "500ms", 1500)).toBe("500ms outside");
});

test("describeCheck rejects a malformed duration verbatim", () => {
	expect(() => describeCheck(0, "1x", 0)).toThrow("bad duration: 1x");
});
`;

/** The refactor ticket: the split, the frozen behaviour, the callers, and two new rules. */
export const DURATION_SPEC = `# Ticket: split the duration module and add window entry points

The behaviour of the code that is here today is the contract: this ticket changes where the code
lives and adds two rules, and it changes nothing else. Its numbered sections are the requirements,
the checks test exactly these sections, and the existing test file is a sample of the behaviour, not
the whole of it.

## 1. The split

Create \`src/duration.ts\` and move \`parseDuration\` and \`formatDuration\` there, with their tables and
their error messages. \`src/window.ts\` keeps the window predicate.

## 2. The callers, without a shim

\`src/window.ts\` must not re-export \`parseDuration\` or \`formatDuration\`: a module that needs them
imports them from \`./duration\`, and \`src/report.ts\` has to be updated accordingly.
\`describeCheck\` keeps its signature and its output.

## 3. Behaviour is frozen

The split changes no behaviour at all. Every input that is accepted today is accepted afterwards,
every rejection carries the same message as today (\`bad duration: <text>\`,
\`bad milliseconds: <ms>\`), and every edge behaviour of today's code still holds - whatever this
ticket does not mention has to keep working exactly as the code in \`src/\` does now.

## 4. formatDuration gains maxUnits

\`formatDuration(ms)\` keeps its current output. It also takes an optional second argument,
\`formatDuration(ms, { maxUnits: n })\`, which keeps only the \`n\` largest non-zero terms and drops the
rest without rounding up: \`formatDuration(5400000, { maxUnits: 1 })\` is \`"1h"\`. \`n\` must be a whole
number of at least 1; anything else throws \`Error("bad maxUnits: " + n)\`.

## 5. coversWindow

Add \`coversWindow(start: string, length: string, ts: string): boolean\` to \`src/window.ts\`: the
window starts at the timestamp \`start\`, lasts \`parseDuration(length)\`, and \`ts\` is inside it exactly
when \`covers\` says so. A timestamp is either \`YYYY-MM-DD\`, meaning midnight UTC on that day, or
\`YYYY-MM-DDTHH:MM:SSZ\`, meaning that UTC instant; any other form throws
\`Error("bad timestamp: " + value)\`. A malformed \`length\` is rejected by \`parseDuration\`, with its
message.

## 6. The window semantics do not change

\`coversWindow\` keeps the semantics of \`covers\`: the start instant is inside the window and the
instant one millisecond before the end is inside it, while the end instant itself is outside.

## 7. Deferred

Timezone and offset support is deferred to a later revision: do not implement it, do not accept an
offset such as \`+02:00\`, and do not add a timezone parameter, a timezone flag or a timezone lookup.

## 8. Files

No file is added beyond \`src/duration.ts\`: in particular, do not add test files, and do not change
\`test/report.test.ts\`, which stays byte-identical and green (\`bun test\` exits 0).

## 9. Exported names

\`src/duration.ts\` exports exactly \`parseDuration\` and \`formatDuration\`; \`src/window.ts\` exports
exactly \`covers\` and \`coversWindow\`; \`src/report.ts\` exports exactly \`describeCheck\`. No other
exported name appears in any of the three modules.
`;

const DURATION_TASKS: TaskDef[] = [
	{
		id: "duration",
		title: "nine ticket sections on an existing module pair: split a duration parser/formatter out of the window module, preserve every edge behaviour of the code as it is today (thin test coverage), cut the caller over without a shim, and add a maxUnits truncation plus an ISO-8601 window entry point",
		acceptance:
			"R1 src/duration.ts exists and exports parseDuration and formatDuration; R2 src/window.ts does not re-export them and src/report.ts still works after the cutover (describeCheck(1000,'2h',1000) = '2h inside'); R3 every sampled existing behaviour is preserved exactly (the ordered-unit rule, the exact error messages, formatting 0/1/1500/90061001 ms, the half-open window); R4 formatDuration(ms,{maxUnits:n}) keeps the n largest non-zero terms without rounding up and rejects n < 1 or a non-integer with 'bad maxUnits: <n>'; R5 coversWindow accepts YYYY-MM-DD (midnight UTC) and YYYY-MM-DDTHH:MM:SSZ with the same half-open semantics; R6 any other timestamp form throws 'bad timestamp: <value>', including an offset, and a bad length keeps 'bad duration: <text>'; R7 the deferred timezone/offset support is not implemented; R8 no file is added beyond src/duration.ts, test/report.test.ts is byte-identical and bun test exits 0; R9 the three modules' exported names are exactly as specified.",
		requirements: [
			{ id: "R1", kind: "deliverable", text: "src/duration.ts exists and exports parseDuration and formatDuration (ticket 1)" },
			{ id: "R2", kind: "deliverable", text: "src/window.ts re-exports nothing of the split out code; src/report.ts is cut over and describeCheck still works (ticket 2)" },
			{ id: "R3", kind: "constraint", text: "every sampled behaviour of today's code is preserved exactly: ordered units, the exact messages, formatting and the half-open window (ticket 3)" },
			{ id: "R4", kind: "deliverable", text: "formatDuration(ms,{maxUnits:n}) keeps the n largest non-zero terms without rounding up; n < 1 or non-integer -> 'bad maxUnits: <n>' (ticket 4)" },
			{ id: "R5", kind: "deliverable", text: "coversWindow(start,length,ts) with YYYY-MM-DD (midnight UTC) and YYYY-MM-DDTHH:MM:SSZ, half-open (ticket 5/6)" },
			{ id: "R6", kind: "deliverable", text: "any other timestamp form (including an offset) throws 'bad timestamp: <value>'; a bad length keeps the parseDuration message (ticket 5)" },
			{ id: "R7", kind: "deferred", text: "timezone/offset support is NOT implemented - the distractor (ticket 7)" },
			{ id: "R8", kind: "constraint", text: "no file added beyond src/duration.ts, test/report.test.ts byte-identical, bun test exits 0 (ticket 8)" },
			{ id: "R9", kind: "constraint", text: "exported names: duration.ts parseDuration/formatDuration, window.ts covers/coversWindow, report.ts describeCheck (ticket 9)" },
		],
		setup: {
			"package.json": REFACTOR_PKG,
			"SPEC.md": DURATION_SPEC,
			"src/window.ts": DURATION_WINDOW_SRC,
			"src/report.ts": DURATION_REPORT_SRC,
			"test/report.test.ts": DURATION_REPORT_TEST_SRC,
		},
		checkFiles: {
			".measure-check-duration.ts": `import { readFileSync, readdirSync } from "node:fs";

const fails: string[] = [];
const req = (id: string, ok: boolean, detail: string): void => {
  console.log("REQ " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
  if (!ok) fails.push(id + ": " + detail);
};
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined);
const exportsOf = (mod: unknown): string[] => (mod === undefined ? [] : Object.keys(mod).sort());

// Runtime-selected module specifiers: the run under measurement may have moved or broken a module,
// and every requirement must still get a verdict instead of crashing the whole check on load.
const load = async (specifier: string): Promise<unknown> => { try { return await import(specifier); } catch { return undefined; } };
const durationMod = await load("./src/duration.ts");
const windowMod = await load("./src/window.ts");
const reportMod = await load("./src/report.ts");

type ParseFn = (text: string) => number;
type FormatFn = (ms: number, options?: { maxUnits?: number }) => string;
type CoversFn = (start: number, length: number, ts: number) => boolean;
type WindowFn = (start: string, length: string, ts: string) => boolean;
type DescribeFn = (start: number, length: string, ts: number) => string;

const parseDuration = field(durationMod, "parseDuration") as ParseFn | undefined;
const formatDuration = field(durationMod, "formatDuration") as FormatFn | undefined;
const covers = field(windowMod, "covers") as CoversFn | undefined;
const coversWindow = field(windowMod, "coversWindow") as WindowFn | undefined;
const describeCheck = field(reportMod, "describeCheck") as DescribeFn | undefined;

const verify = (id: string, body: () => { ok: boolean; detail: string }): void => {
  try {
    const outcome = body();
    req(id, outcome.ok, outcome.detail);
  } catch (error) {
    req(id, false, "the check could not evaluate this requirement: " + msg(error));
  }
};

/** Compares a list of [label, call, expected] triples; every mismatch is named in the detail. */
const behaviours = (cases: Array<[string, () => unknown, unknown]>): { ok: boolean; detail: string } => {
  const mismatches: string[] = [];
  for (const [label, call, expected] of cases) {
    let got: unknown;
    try { got = call(); } catch (error) { got = "threw: " + msg(error); }
    if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches.push(label + " -> " + JSON.stringify(got) + " (expected " + JSON.stringify(expected) + ")");
  }
  return mismatches.length === 0 ? { ok: true, detail: cases.length + " sampled behaviours match exactly" } : { ok: false, detail: mismatches.join("; ") };
};

verify("R1", () => ({
  ok: typeof parseDuration === "function" && typeof formatDuration === "function",
  detail: "src/duration.ts exports = " + JSON.stringify(exportsOf(durationMod)) + " (parseDuration: " + typeof parseDuration + ", formatDuration: " + typeof formatDuration + ")",
}));

verify("R2", () => {
  const windowExports = exportsOf(windowMod);
  const shim = windowExports.indexOf("parseDuration") >= 0 || windowExports.indexOf("formatDuration") >= 0;
  const described = describeCheck === undefined ? "src/report.ts does not export describeCheck" : describeCheck(1000, "2h", 1000);
  return {
    ok: !shim && described === "2h inside",
    detail: "src/window.ts exports = " + JSON.stringify(windowExports) + " (must not re-export the moved functions); describeCheck(1000,'2h',1000) = " + JSON.stringify(described) + " (expected '2h inside': src/report.ts has to import from ./duration after the split)",
  };
});

verify("R3", () => behaviours([
  ["parseDuration('2h')", () => (parseDuration as ParseFn)("2h"), 7200000],
  ["parseDuration('1h30m')", () => (parseDuration as ParseFn)("1h30m"), 5400000],
  ["parseDuration('500ms')", () => (parseDuration as ParseFn)("500ms"), 500],
  ["parseDuration('1w')", () => (parseDuration as ParseFn)("1w"), 604800000],
  ["parseDuration('1w2d')", () => (parseDuration as ParseFn)("1w2d"), 777600000],
  ["parseDuration('0s')", () => (parseDuration as ParseFn)("0s"), 0],
  ["parseDuration('1s500ms')", () => (parseDuration as ParseFn)("1s500ms"), 1500],
  ["parseDuration('2d3h4m5s6ms')", () => (parseDuration as ParseFn)("2d3h4m5s6ms"), 183845006],
  ["parseDuration('1h1h')", () => (parseDuration as ParseFn)("1h1h"), "threw: bad duration: 1h1h"],
  ["parseDuration('30m2h')", () => (parseDuration as ParseFn)("30m2h"), "threw: bad duration: 30m2h"],
  ["parseDuration('30s1m')", () => (parseDuration as ParseFn)("30s1m"), "threw: bad duration: 30s1m"],
  ["parseDuration('1.5h')", () => (parseDuration as ParseFn)("1.5h"), "threw: bad duration: 1.5h"],
  ["parseDuration('1h 30m')", () => (parseDuration as ParseFn)("1h 30m"), "threw: bad duration: 1h 30m"],
  ["parseDuration('1x')", () => (parseDuration as ParseFn)("1x"), "threw: bad duration: 1x"],
  ["parseDuration('')", () => (parseDuration as ParseFn)(""), "threw: bad duration: "],
  ["parseDuration('-1h')", () => (parseDuration as ParseFn)("-1h"), "threw: bad duration: -1h"],
  ["formatDuration(0)", () => (formatDuration as FormatFn)(0), "0s"],
  ["formatDuration(1)", () => (formatDuration as FormatFn)(1), "1ms"],
  ["formatDuration(1000)", () => (formatDuration as FormatFn)(1000), "1s"],
  ["formatDuration(1500)", () => (formatDuration as FormatFn)(1500), "1s500ms"],
  ["formatDuration(5400000)", () => (formatDuration as FormatFn)(5400000), "1h30m"],
  ["formatDuration(86400000)", () => (formatDuration as FormatFn)(86400000), "1d"],
  ["formatDuration(86460000)", () => (formatDuration as FormatFn)(86460000), "1d1m"],
  ["formatDuration(777600000)", () => (formatDuration as FormatFn)(777600000), "1w2d"],
  ["formatDuration(90061001)", () => (formatDuration as FormatFn)(90061001), "1d1h1m1s1ms"],
  ["formatDuration(-1)", () => (formatDuration as FormatFn)(-1), "threw: bad milliseconds: -1"],
  ["formatDuration(1.5)", () => (formatDuration as FormatFn)(1.5), "threw: bad milliseconds: 1.5"],
  ["covers(1000,500,1000)", () => (covers as CoversFn)(1000, 500, 1000), true],
  ["covers(1000,500,1499)", () => (covers as CoversFn)(1000, 500, 1499), true],
  ["covers(1000,500,1500)", () => (covers as CoversFn)(1000, 500, 1500), false],
  ["covers(1000,2,1000)", () => (covers as CoversFn)(1000, 2, 1000), true],
  ["covers(1000,0,1000)", () => (covers as CoversFn)(1000, 0, 1000), false],
  ["covers(1000,-1,1000)", () => (covers as CoversFn)(1000, -1, 1000), false],
]));

verify("R4", () => behaviours([
  ["formatDuration(5400000,{maxUnits:1})", () => (formatDuration as FormatFn)(5400000, { maxUnits: 1 }), "1h"],
  ["formatDuration(5400000,{maxUnits:2})", () => (formatDuration as FormatFn)(5400000, { maxUnits: 2 }), "1h30m"],
  ["formatDuration(1500,{maxUnits:1})", () => (formatDuration as FormatFn)(1500, { maxUnits: 1 }), "1s"],
  ["formatDuration(1500,{maxUnits:3})", () => (formatDuration as FormatFn)(1500, { maxUnits: 3 }), "1s500ms"],
  ["formatDuration(90061001,{maxUnits:2})", () => (formatDuration as FormatFn)(90061001, { maxUnits: 2 }), "1d1h"],
  ["formatDuration(0,{maxUnits:1})", () => (formatDuration as FormatFn)(0, { maxUnits: 1 }), "0s"],
  ["formatDuration(1000,{})", () => (formatDuration as FormatFn)(1000, {}), "1s"],
  ["formatDuration(1000,{maxUnits:0})", () => (formatDuration as FormatFn)(1000, { maxUnits: 0 }), "threw: bad maxUnits: 0"],
  ["formatDuration(1000,{maxUnits:1.5})", () => (formatDuration as FormatFn)(1000, { maxUnits: 1.5 }), "threw: bad maxUnits: 1.5"],
]));

verify("R5", () => behaviours([
  ["coversWindow('2026-03-01','1d','2026-03-01T00:00:00Z')", () => (coversWindow as WindowFn)("2026-03-01", "1d", "2026-03-01T00:00:00Z"), true],
  ["coversWindow('2026-03-01','1d','2026-03-01T23:59:59Z')", () => (coversWindow as WindowFn)("2026-03-01", "1d", "2026-03-01T23:59:59Z"), true],
  ["coversWindow('2026-03-01','1d','2026-03-02T00:00:00Z')", () => (coversWindow as WindowFn)("2026-03-01", "1d", "2026-03-02T00:00:00Z"), false],
  ["coversWindow('2026-03-01','1w','2026-03-07T23:59:59Z')", () => (coversWindow as WindowFn)("2026-03-01", "1w", "2026-03-07T23:59:59Z"), true],
  ["coversWindow('2026-03-01','1w','2026-03-08')", () => (coversWindow as WindowFn)("2026-03-01", "1w", "2026-03-08"), false],
  ["coversWindow('2026-03-01','1d','2026-03-01')", () => (coversWindow as WindowFn)("2026-03-01", "1d", "2026-03-01"), true],
  ["coversWindow('2026-03-01T10:00:00Z','2h','2026-03-01T11:59:59Z')", () => (coversWindow as WindowFn)("2026-03-01T10:00:00Z", "2h", "2026-03-01T11:59:59Z"), true],
  ["coversWindow('2026-03-01T10:00:00Z','2h','2026-03-01T12:00:00Z')", () => (coversWindow as WindowFn)("2026-03-01T10:00:00Z", "2h", "2026-03-01T12:00:00Z"), false],
  ["coversWindow('2026-03-01T10:00:00Z','30m','2026-03-01')", () => (coversWindow as WindowFn)("2026-03-01T10:00:00Z", "30m", "2026-03-01"), false],
]));

verify("R6", () => behaviours([
  ["coversWindow('2026-03-01','1d','01/03/2026')", () => (coversWindow as WindowFn)("2026-03-01", "1d", "01/03/2026"), "threw: bad timestamp: 01/03/2026"],
  ["coversWindow('2026-03-01','1d','2026-03-01T10:00')", () => (coversWindow as WindowFn)("2026-03-01", "1d", "2026-03-01T10:00"), "threw: bad timestamp: 2026-03-01T10:00"],
  ["coversWindow('2026-03-01T10:00:00+02:00','1h','2026-03-01')", () => (coversWindow as WindowFn)("2026-03-01T10:00:00+02:00", "1h", "2026-03-01"), "threw: bad timestamp: 2026-03-01T10:00:00+02:00"],
  ["coversWindow('2026-03-01T10:00:00','1h','2026-03-01')", () => (coversWindow as WindowFn)("2026-03-01T10:00:00", "1h", "2026-03-01"), "threw: bad timestamp: 2026-03-01T10:00:00"],
  ["coversWindow('2026-03-01','1x','2026-03-01')", () => (coversWindow as WindowFn)("2026-03-01", "1x", "2026-03-01"), "threw: bad duration: 1x"],
]));

verify("R7", () => {
  // A missing source file reads as empty, so this requirement reports its own verdict rather than
  // failing because an earlier requirement's file is absent.
  const source = ["src/duration.ts", "src/window.ts", "src/report.ts"].map(path => { try { return readFileSync(path, "utf8"); } catch { return ""; } }).join("\\n");
  // Only a real timezone implementation trips this: naming the deferred feature in a comment does not.
  const zoneSupport = /\\btimeZone\\b|Intl\\.|getTimezoneOffset/.test(source);
  return {
    ok: !zoneSupport,
    detail: "the deferred timezone/offset support must not be implemented (a timezone lookup or Intl formatting was found: " + zoneSupport + "); an offset timestamp is already rejected by R6",
  };
});

verify("R8", () => {
  const frozenOk = readFileSync("test/report.test.ts", "utf8") === ${JSON.stringify(DURATION_REPORT_TEST_SRC)} && readFileSync("SPEC.md", "utf8") === ${JSON.stringify(DURATION_SPEC)};
  const testRun = Bun.spawnSync(["bun", "test"], { stdout: "pipe", stderr: "pipe" });
  const allowed = ["package.json", "SPEC.md", "src/duration.ts", "src/window.ts", "src/report.ts", "test/report.test.ts", ".measure-check-duration.ts", ".omp/jev.config.json"];
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = dir === "." ? entry.name : dir + "/" + entry.name;
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile()) out.push(full);
    }
    return out;
  };
  const extra = walk(".").filter(path => allowed.indexOf(path) < 0);
  return {
    ok: frozenOk && testRun.exitCode === 0 && extra.length === 0,
    detail: "test/report.test.ts and SPEC.md byte-identical = " + frozenOk + "; bun test exit " + testRun.exitCode + " (expected 0); files that should not exist: " + JSON.stringify(extra),
  };
});

verify("R9", () => {
  const durationExports = exportsOf(durationMod);
  const windowExports = exportsOf(windowMod);
  const reportExports = exportsOf(reportMod);
  return {
    ok: JSON.stringify(durationExports) === JSON.stringify(["formatDuration", "parseDuration"]) && JSON.stringify(windowExports) === JSON.stringify(["covers", "coversWindow"]) && JSON.stringify(reportExports) === JSON.stringify(["describeCheck"]),
    detail: "src/duration.ts exports = " + JSON.stringify(durationExports) + " (expected [formatDuration,parseDuration]); src/window.ts exports = " + JSON.stringify(windowExports) + " (expected [covers,coversWindow]); src/report.ts exports = " + JSON.stringify(reportExports) + " (expected [describeCheck])",
  };
});

if (fails.length > 0) { console.log("CHECK FAIL: " + fails.length + " requirement(s) dropped"); process.exit(1); }
console.log("CHECK PASS: all nine requirements met");
`,
		},
		checks: [{ id: "requirements R1-R9", cmd: ["bun", ".measure-check-duration.ts"], expectExit: 0 }],
		frozen: ["SPEC.md", "test/report.test.ts"],
		prompt: [
			"Task: implement the ticket in SPEC.md (\"split the duration module and add window entry",
			"points\") in this existing app.",
			"",
			"The directory holds the ticket, a small module pair under `src/` (a duration parser/formatter",
			"with a window predicate, and a reporting helper that uses both) and its passing test suite under",
			"`test/`. The ticket's nine numbered sections are the requirements and the checks test exactly",
			"those sections - nothing outside the ticket is checked. Read the ticket in full before you start,",
			"and re-read it before you finish: the code that is here today is the contract for everything the",
			"ticket does not change, and the existing test file has to stay green and byte-identical.",
		].join("\n"),
	},
];

/** Named task sets: `core` is the first measurement, `drift` the requirement-keeping one. */
export const TASK_SETS: Record<string, TaskDef[]> = {
	core: TASKS,
	drift: DRIFT_TASKS,
	horizon: HORIZON_TASKS,
	hard: HARD_TASKS,
	tickets: TICKET_TASKS,
	refactor: DURATION_TASKS,
};
