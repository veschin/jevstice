/**
 * D3 audit harness (scratch, deleted after the audit).
 * Ask Jev, one Noul question per test name: does this test, as named, protect
 * behaviour that would otherwise go unnoticed - if that behaviour broke, would
 * this test fail?
 *
 * usage: bun run tools/audit/judge.ts <outfile.json> <file1.test.ts> [file2.test.ts ...]
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevApiRequest, JevApiResponse, JevQuestion } from "../../src/types.js";
import { isRecord } from "../../src/guards.js";

const apiKey = (await Bun.$`pass token/jev`.text()).trim();
const [, , outPath, ...onlyFiles] = process.argv;

interface TestEntry {
	name: string;
	line: number;
	describe: string | null;
}

const inventory = (await Bun.file("/tmp/audit/inventory.json").json()) as Record<string, TestEntry[]>;

const RULE = `Test discipline rule (owner order 2026-10-08, recorded in TASKS.md): a test exists
only where it fails when the behaviour breaks. Not written, ever: tests of wiring, forwarding,
mock echoes, source text, incidental defaults, tautologies, bare not-throw checks, or
non-empty/length-grew assertions. A test whose only content is "the function was called", "the
argument was forwarded", "the constant equals the literal I just wrote", "this string appears in
the source", or "the array is non-empty" does NOT protect behaviour: it stays green when the
feature is deleted. A test DOES protect behaviour when it pins an observable outcome that a
plausible regression would break: a gate that must block, a fail-closed path that must not
approve, a bound that must be enforced, a byte-identity round-trip, an exit code, a persisted
value that must survive a restart. A test that duplicates another test on the same code path
protects nothing new.`;

const INVENTORY = `Modules under test (jevstice, a Bun/TypeScript omp extension that puts an
external judge (Jev) in the decision path):
- src/controller.ts: the omp extension; plan gate (blocks mutation work until a plan is
  approved), completion gate (blocks session stop without approval), destructive-action gate,
  subagent hand-off gate, tool registration, state persistence, rework bound.
- src/client.ts: the Jev transport + judge primitives (decision, multi-label marking, claim
  check, requirements formalization, course check); fail-closed contract violations.
- src/catalog.ts: topic catalog / classification routing (hardening-plan kinds).
- src/config.ts: template override config (user + project layers, trust split, fail-closed).
- src/evidence.ts: decision request validation (stable violation codes).
- src/activities.ts: the six-activity registry; a declared-but-unwired activity is a defect.
- src/cli.ts: the CLI contract (JSON in/out, exit codes: 0 ok, 2 invalid input, 4 judge failure
  which must NEVER approve).
- src/apikey.ts: api key resolution (env var, else resolver command).
- src/guards.ts, src/types.ts: shared types/guards.

You are auditing the NAMES of the tests in this suite against the rule above. Your verdict is a
filter that selects which test bodies get read; it is not the final decision, so judge the name
as written.`;

const client = new TypeSafeClient({
	apiKey,
	baseURL: "https://api.typesafe.ai",
	defaultModel: "jev-latest",
	retry: { maxRetries: 5 },
	logLevel: "off",
});

const items = Object.entries(inventory)
	.filter(([file]) => onlyFiles.length === 0 || onlyFiles.includes(file))
	.flatMap(([file, tests]) =>
		tests.map((t, i) => ({
			id: `${file}::${i}`,
			file,
			text: `${file} > ${t.describe ?? "(top level)"} > ${t.name}`,
		})),
	);

console.log(`judging ${items.length} test names in ${onlyFiles.join(", ") || "all files"}`);

const answers: Record<string, { p: number; text: string; file: string }> = {};

async function attempt(body: JevApiRequest): Promise<JevApiResponse> {
	for (let i = 0; ; i++) {
		try {
			return (await client.systemOne(body as never)) as unknown as JevApiResponse;
		} catch (err) {
			const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			if (i >= 6) throw new Error(`giving up after ${i + 1} attempts: ${msg}`);
			console.log(`  retry ${i + 1} (${msg.slice(0, 140)})`);
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 1500 * (i + 1));
			await promise;
		}
	}
}

/** The API answers every asked id with a finite noul; anything else is a contract violation. */
function readNoul(res: JevApiResponse, id: string): number {
	const answer: unknown = res.answers[id];
	if (!isRecord(answer) || answer["type"] !== "noul") throw new Error(`missing noul for ${id}`);
	const p = answer["noul"];
	if (typeof p !== "number" || !Number.isFinite(p)) throw new Error(`no finite noul for ${id}`);
	return p;
}

/** 200 questions hit the API's max_tokens_exceeded (400); 100 is inside the observed budget. */
const SHARD = 100;
for (let s = 0; s < items.length; s += SHARD) {
	const slice = items.slice(s, s + SHARD);
	const questions: Record<string, JevQuestion> = {};
	for (const it of slice) {
		questions[it.id] = {
			type: "noul",
			id: it.id,
			instructions: {
				policy: RULE,
				question: `Test: \`${it.text}\`. Does this test, as named, protect behaviour that would otherwise go unnoticed - if that behaviour broke, would this test fail?`,
			},
			criteria: {
				true: "The name states an observable outcome that a plausible regression would break, so the test fails when the behaviour breaks.",
				false:
					"The name states wiring, forwarding, a mock echo, source text, an incidental default, a tautology, a bare not-throw check, or a non-empty/length-grew assertion (or duplicates another test on the same path) - the test stays green when the behaviour breaks.",
			},
		};
	}
	const res = await attempt({
		state: { task: "Audit the jevstice test suite names", evidence: INVENTORY },
		model: "jev-latest",
		questions,
	});
	for (const it of slice) answers[it.id] = { p: readNoul(res, it.id), text: it.text, file: it.file };
	const got = slice.map(i => answers[i.id].p);
	console.log(`  shard ${s / SHARD + 1}: ${slice.length} answers, min p=${Math.min(...got).toFixed(2)}`);
}

await Bun.write(outPath, JSON.stringify({ rule: RULE, answers }, null, 1));
const vals = Object.values(answers);
console.log(
	`wrote ${outPath}: n=${vals.length} true(>=0.5)=${vals.filter(v => v.p >= 0.5).length} false=${vals.filter(v => v.p < 0.5).length}`,
);
