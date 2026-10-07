#!/usr/bin/env bun
/**
 * Self-check runner: the reviews the product is judged by, run against the repository as it stands,
 * without the customer's participation. Owner order 2026-10-08: "я хочу чтобы ты регулярно проводил
 * проверки и без моего участия ... как можно раньше создай механизм таких проверок и внедряй его в
 * работу".
 *
 * It collects the state itself (module inventory, test inventory, recent commits, the open task rows,
 * the previous review file), asks the judge the fixed review question sets (business, architecture,
 * tests, process) and writes evidence/reviews/<date>.md with the verdicts plus the movement since the
 * last run. Nothing here blocks anything: it reports.
 *
 * Run:  env TYPESAFE_API_KEY_COMMAND='pass show token/jev' bun tools/reviews/run.ts
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const OUT_DIR = path.join(ROOT, "evidence", "reviews");

type Verdict = { id: string; type: string; value: number | string | undefined; confidence?: number };

const OUTCOME_RUBRIC = [
	"Cannot produce it at all; the design is wrong.",
	"Very unlikely; a core part is missing.",
	"Unlikely; something essential is unproven.",
	"Possible in narrow cases only.",
	"Even odds, with heavy supervision.",
	"Likely for small tasks, unproven for the customer's real work.",
	"Likely for the customer's real work, but nothing measures it.",
	"Very likely; the loop runs and is enforced.",
	"Nearly certain: it runs, is enforced and is measured.",
	"Certain, with evidence.",
];
const QUALITY_RUBRIC = [
	"Unmaintainable: the design cannot absorb the next change.",
	"Seriously overgrown: one module dominates and duplicates the rest.",
	"Overgrown: duplication and a monolith dominate the structure.",
	"Serviceable but carrying duplication that slows every next change.",
	"Serviceable: the layering is sound, duplication is contained.",
	"Sound: the pieces are separated, the duplication is small.",
	"Sound and general: new behaviour lands in one place, not three.",
	"Clean: separation, generality and tests that protect behaviour.",
	"Clean, and the shape would survive a rewrite of any one module.",
	"Exemplary: nothing to redo, generalize or delete.",
];
const VALUE_RUBRIC = [
	"Not met at all.", "Barely started.", "A small part met.", "A quarter met.", "A third met.",
	"Half met.", "Two thirds met.", "Mostly met.", "Met, with gaps.", "Met and demonstrated.",
];
const RISKS: Record<string, string> = {
	judge_reliability: "The judge itself: abstentions and unreliable transport.",
	no_enforcement: "Nothing forces the discipline the product exists for.",
	cost_latency: "The cost and latency of consultations on the customer's cheap fast workflow.",
	executor_discipline: "The outcome depends on the executor filing well-framed claims.",
	no_measurement: "Nothing measures whether the product improves the result.",
	structure: "The code structure: a monolith that duplicates its own mechanisms.",
	owner_supervision: "The customer still has to supervise.",
};

function sh(cmd: string): string {
	try {
		return Bun.spawnSync(["bash", "-lc", cmd], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
	} catch {
		return "";
	}
}

function collect() {
	const src = sh("wc -l src/*.ts | sort -rn | head -20");
	const tests = sh("wc -l tests/*.ts | sort -rn | head -20");
	const counts = sh("for f in tests/*.ts; do printf '%s %s\\n' \"$(grep -cE '^\\\\s*test\\\\(' $f)\" \"$f\"; done | sort -rn");
	const total = sh("bun test 2>&1 | tail -4");
	const commits = sh("git log --oneline -12");
	const tasks = sh("grep -E '^\\| [A-E][0-9]' TASKS.md | head -30");
	const status = sh("git status --porcelain | head -20");
	const invariants = [
		"fail-closed: judge error, malformed answer, escape option, low or absent confidence never approve",
		"a judge abstention or error never blocks work; it is recorded and escalated",
		"rework is bounded and every attempt must change the approach",
		"reviews and gates never block on abstention, only on a confident explicit negative",
	].join(" | ");
	return { src, tests, counts, total, commits, tasks, status, invariants };
}

async function ask(client: TypeSafeClient, state: unknown, questions: Record<string, unknown>) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = (await client.systemOne({ state, model: "jev-latest", questions } as never)) as {
				answers: Record<string, { type: string; score?: number; noul?: number; choice?: string; confidence?: number }>;
			};
			const out: Verdict[] = [];
			for (const [id, a] of Object.entries(res.answers)) {
				out.push({ id, type: a.type, value: a.type === "score" ? a.score : a.type === "noul" ? a.noul : a.choice, confidence: a.confidence });
			}
			return out;
		} catch (err) {
			if (attempt === 3) return [{ id: "error", type: "error", value: String(err).slice(0, 120) }];
			await Bun.sleep(2500);
		}
	}
	return [];
}

const previousFile = (() => {
	if (!fs.existsSync(OUT_DIR)) return undefined;
	const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith(".md")).sort();
	return files.length > 0 ? path.join(OUT_DIR, files[files.length - 1]!) : undefined;
})();
const previous = previousFile !== undefined ? fs.readFileSync(previousFile, "utf8") : undefined;

const repo = collect();

const state = {
	stage: "self_check",
	task: "Periodic self-check of the jevstice project: an oh-my-pi extension that puts an external judge in the decision path of a coding agent, so that a customer gives one high-level task and gets a maximally correct result at minimal cost.",
	customer_goal: "Пользователь задаёт задачу верхнеуровнево и получает максимально корректный результат с минимальными затратами.",
	customer_problem: "она часто делает лишнее, часто делает не то что я хочу, часто бросает задачи на пол пути. качество реализации очень низкое",
	customer_rules: "the product must force the conditions under which the judge answers well; a gate or review that blocks on an abstention is a defect; a test exists only where it fails when the behaviour breaks",
	invariants: repo.invariants,
	repository: repo,
	previous_review: previous?.slice(0, 4000) ?? "none - this is the first run",
};

const questions: Record<string, unknown> = {
	business_outcome: {
		type: "score", id: "business_outcome",
		instructions: { policy: "Judge only from the state.", question: "How likely is this project, as it now stands, to give the customer the promised outcome?" },
		criteria: OUTCOME_RUBRIC,
	},
	business_value: {
		type: "score", id: "business_value",
		instructions: { policy: "Judge only from the state.", question: "How far has the customer's goal actually been met so far?" },
		criteria: VALUE_RUBRIC,
	},
	business_risk: {
		type: "choice", id: "business_risk",
		instructions: { policy: "Judge only from the state.", question: "Which single risk most threatens the customer's outcome right now?" },
		criteria: RISKS,
	},
	business_value_unverified: {
		type: "noul", id: "business_value_unverified",
		instructions: { policy: "Judge only from the state.", question: "Claim: nothing in the state measures whether this product improves the customer's result." },
		criteria: { true: "Unverified.", false: "Verified." },
	},
	architecture_quality: {
		type: "score", id: "architecture_quality",
		instructions: { policy: "Judge only from the state.", question: "How well is this implementation built, for absorbing the next change?" },
		criteria: QUALITY_RUBRIC,
	},
	architecture_monolith: {
		type: "noul", id: "architecture_monolith",
		instructions: { policy: "Judge only from the state.", question: "Claim: the largest module still dominates the codebase and duplicates the mechanisms the others implement." },
		criteria: { true: "Still dominates and duplicates.", false: "No longer true." },
	},
	tests_protect_behaviour: {
		type: "noul", id: "tests_protect_behaviour",
		instructions: { policy: "Judge only from the state.", question: "Claim: the test suite protects the behaviour rather than the implementation, judged from its size relative to the code and the counts per file." },
		criteria: { true: "Protects behaviour.", false: "Protects implementation detail." },
	},
	process_loop_sound: {
		type: "noul", id: "process_loop_sound",
		instructions: { policy: "Judge only from the state.", question: "Claim: the working loop is sound - bounded attempts with changed approaches, reviews that never block on abstention, no deadlocks, no fake success." },
		criteria: { true: "Sound.", false: "Not sound." },
	},
	top_change: {
		type: "choice", id: "top_change",
		instructions: { policy: "Judge only from the state.", question: "Which single change would most improve this project right now?" },
		criteria: {
			measure_value: "Measure whether the product improves the customer's result.",
			generalize_gates: "Generalize the duplicated gate mechanism into one.",
			split_controller: "Split the largest module by concern.",
			prune_tests: "Delete tests that protect implementation detail.",
			review_activities: "Build the review activities into the product.",
			enforce_without_deadlock: "Return enforcement in a form that cannot deadlock.",
		},
	},
};

const key = (await Bun.$`pass show token/jev`.text()).trim();
const client = new TypeSafeClient({ apiKey: key, baseURL: "https://api.typesafe.ai", defaultModel: "jev-latest", timeout: 30000, retry: { maxRetries: 5, backoffInitialMs: 500 }, logLevel: "off", fetch: fetch });
const verdicts = await ask(client, state, questions);

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const outFile = path.join(OUT_DIR, `${stamp}.md`);
const lines = [
	`# Self-check ${new Date().toISOString()}`,
	"",
	"Run by `tools/reviews/run.ts` without the customer's participation. The judge saw only the",
	"repository facts collected below.",
	"",
	"## Verdicts",
	"",
	"| Question | Answer | Confidence |",
	"|---|---|---|",
	...verdicts.map(v => `| ${v.id} | ${v.value} | ${v.confidence ?? "-"} |`),
	"",
	"## Repository as judged",
	"",
	"```",
	`src: ${state.repository.src.split("\n").slice(0, 6).join(" | ")}`,
	`tests: ${state.repository.tests.split("\n").slice(0, 4).join(" | ")}`,
	`counts: ${state.repository.counts.split("\n").slice(0, 6).join(" | ")}`,
	`suite: ${state.repository.total.split("\n").slice(-3).join(" | ")}`,
	"```",
	"",
	"## Movement",
	"",
	previous === undefined ? "First run - no previous review to compare against." : `Previous: ${previousFile}`,
	"",
	"## Recent commits",
	"",
	"```",
	state.repository.commits,
	"```",
	"",
	"## Open tasks",
	"",
	"```",
	state.repository.tasks,
	"```",
	"",
];
fs.writeFileSync(outFile, lines.join("\n"));

console.log(`wrote ${outFile}`);
for (const v of verdicts) console.log(`${v.id}: ${v.value}${v.confidence !== undefined ? ` (conf ${v.confidence})` : ""}`);
