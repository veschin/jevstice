#!/usr/bin/env bun
/**
 * Product reviews, live: one `business_review` and one `architecture_review` run through the
 * SHIPPED mechanism (src/reviews.ts question sets + src/client.ts review judge) against the real
 * endpoint, writing the recorded per-item result to evidence/reviews/<stamp>-product-reviews.md.
 *
 * It is the review-activities acceptance round-trip ("one business review and one architecture
 * review run against the real endpoint and their recorded state is shown") and nothing else: no
 * blocking, no state outside the printed record. The judge sees only the collected facts.
 *
 * Run: env TYPESAFE_API_KEY_COMMAND='pass show token/jev' bun tools/reviews/product-reviews.ts
 */
import { resolveApiKey } from "../../src/apikey.js";
import { createReviewJudge } from "../../src/client.js";
import {
	REVIEW_QUESTIONS,
	consultReview,
	reviewLine,
	reviewRecord,
} from "../../src/reviews.js";
import type { DecisionOption, Evidence } from "../../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const OUT_DIR = path.join(ROOT, "evidence", "reviews");

function sh(cmd: string): string {
	try {
		return Bun.spawnSync(["bash", "-lc", cmd], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
			.stdout.toString()
			.trim();
	} catch {
		return "";
	}
}

const key = await resolveApiKey(process.env);
if (key === undefined) {
	console.error("no key: set TYPESAFE_API_KEY or TYPESAFE_API_KEY_COMMAND");
	process.exit(2);
}
const judge = createReviewJudge({ apiKey: key });

const repo = {
	src: sh("wc -l src/*.ts | sort -rn"),
	tests: sh("wc -l tests/*.ts | sort -rn"),
	counts: sh("for f in tests/*.ts; do printf '%s %s\\n' \"$(grep -cE '^\\\\s*test\\\\(' $f)\" \"$f\"; done | sort -rn"),
	suite: sh("bun test 2>&1 | tail -4"),
	commits: sh("git log --oneline -12"),
	tasks: sh("grep -E '^\\| [A-E][0-9]' TASKS.md | head -30"),
	invariants: [
		"fail-closed: judge error, malformed answer, escape option, low or absent confidence never approve",
		"a judge abstention or error never blocks work; it is recorded and escalated",
		"rework is bounded and every attempt must change the approach",
		"reviews and gates never block on abstention, only on a confident explicit negative",
	].join(" | "),
};

const RISKS: DecisionOption[] = [
	{ id: "judge_reliability", label: "Judge reliability", meaning: "The judge itself: abstentions and unreliable transport." },
	{ id: "no_enforcement", label: "No enforcement", meaning: "Nothing forces the discipline the product exists for." },
	{ id: "cost_latency", label: "Cost and latency", meaning: "The cost and latency of consultations on the customer's cheap fast workflow." },
	{ id: "executor_discipline", label: "Executor discipline", meaning: "The outcome depends on the executor filing well-framed claims." },
	{ id: "no_measurement", label: "No measurement", meaning: "Nothing measures whether the product improves the result." },
	{ id: "structure", label: "Structure", meaning: "The code structure: a monolith that duplicates its own mechanisms." },
	{ id: "owner_supervision", label: "Owner supervision", meaning: "The customer still has to supervise." },
];

const CHANGES: DecisionOption[] = [
	{ id: "measure_value", label: "Measure value", meaning: "Measure whether the product improves the customer's result." },
	{ id: "generalize_gates", label: "Generalize the gates", meaning: "Generalize the duplicated gate mechanism into one." },
	{ id: "split_controller", label: "Split the controller", meaning: "Split the largest module by concern." },
	{ id: "prune_tests", label: "Prune tests", meaning: "Delete tests that protect implementation detail." },
	{ id: "enforce_without_deadlock", label: "Enforce without deadlock", meaning: "Return enforcement in a form that cannot deadlock." },
];

const reviewEvidence: Evidence[] = [
	{
		kind: "code",
		source: "src/gates.ts (the gate/review registry)",
		quote: sh("grep -n 'gate_missing\\|refusal_option_not_offered' src/gates.ts | head -4"),
	},
	{
		kind: "execution",
		source: "bun test (the suite as it stands)",
		quote: repo.suite,
	},
	{
		kind: "spec",
		source: "evidence/architecture-review.md (the judge's own review of this codebase)",
		quote: "the three gates (plan and mutation, subagent hand-off, destructive action) are one mechanism written three times - each with its own constants, its own identically shaped judge call, its own internal deadline, its own record type and its own restore function",
	},
	{
		kind: "user",
		source: "the customer's own words (PRD)",
		quote: "Пользователь задаёт задачу верхнеуровнево и получает максимально корректный результат с минимальными затратами.",
	},
	{
		kind: "log",
		source: "evidence/smoke-gates-findings.md (live smoke of the gates)",
		quote: "the hand-off dispatch check can never fire on omp 18.6.3 ... the acceptance side judges the spawn acknowledgement",
	},
];

const business = await consultReview({
	stage: "business_review",
	task: "Business review of jevstice as it stands, judged from the quoted material (advisory).",
	questions: REVIEW_QUESTIONS.business_review,
	items: [
		{ id: "decision-1", text: "The three gates were generalized into one descriptor-driven mechanism instead of three copies." },
		{ id: "decision-2", text: "The subagent hand-off dispatch check was kept and fixed to survive the host's tool_result order." },
		{ id: "decision-3", text: "The acceptance side of the hand-off gate is opt-in (gates.handoffAcceptance) and judges the delivered result." },
		{ id: "decision-4", text: "Reviews record per-item results and never block anything." },
	],
	candidates: RISKS,
	evidence: reviewEvidence,
	judge,
	deadlineMs: 25_000,
});

const architecture = await consultReview({
	stage: "architecture_review",
	task: "Architecture review of jevstice: how well the implementation absorbs the next change (advisory).",
	questions: REVIEW_QUESTIONS.architecture_review,
	items: [
		{ id: "defect-1", text: "src/controller.ts still holds the controller, the state and the tool description in one class; the gates are now descriptors, but the class is still the largest module." },
		{ id: "defect-2", text: "The tool description in the controller remains a long hand-written string." },
	],
	candidates: CHANGES,
	evidence: reviewEvidence,
	judge,
	deadlineMs: 25_000,
});

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${stamp}-product-reviews.md`);
const now = Date.now();
const businessRecord = reviewRecord("business_review", "business_review", business, {
	at: now,
	taskFingerprint: undefined,
	workRevision: 0,
});
const architectureRecord = reviewRecord("architecture_review", "architecture_review", architecture, {
	at: now,
	taskFingerprint: undefined,
	workRevision: 0,
});
const lines = [
	`# Product reviews ${new Date().toISOString()}`,
	"",
	"One `business_review` and one `architecture_review`, run through the shipped mechanism",
	"(`src/reviews.ts` question sets, `src/client.ts` review judge) against the real endpoint.",
	"",
	"## Recorded results",
	"",
	"```",
	reviewLine(businessRecord),
	"",
	reviewLine(architectureRecord),
	"```",
	"",
	"## business_review (recorded state)",
	"",
	"```json",
	JSON.stringify(businessRecord, null, 2),
	"```",
	"",
	"## architecture_review (recorded state)",
	"",
	"```json",
	JSON.stringify(architectureRecord, null, 2),
	"```",
	"",
	"## Repository as judged",
	"",
	"```",
	repo.src.split("\n").slice(0, 8).join("\n"),
	"",
	repo.counts.split("\n").slice(0, 8).join("\n"),
	"",
	repo.suite,
	"```",
	"",
];
fs.writeFileSync(outFile, lines.join("\n"));
console.log(`wrote ${outFile}`);
console.log(reviewLine(businessRecord));
console.log(reviewLine(architectureRecord));
