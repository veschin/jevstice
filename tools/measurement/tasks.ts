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

/** Named task sets: `core` is the first measurement, `drift` the requirement-keeping one. */
export const TASK_SETS: Record<string, TaskDef[]> = { core: TASKS, drift: DRIFT_TASKS, horizon: HORIZON_TASKS };
