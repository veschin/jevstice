#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { observedOutcome } from "../src/activities.js";
import { memoizedApiKeyResolver } from "../src/apikey.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createTypeSafeJudge } from "../src/judge.js";
import { freshState, recordAction, registerTask, sha256 } from "../src/state.js";
import { asRecord, POLICY, type Evidence, type ToolOutcome } from "../src/types.js";

interface Scenario {
	id: string;
	request: string;
	requirements: readonly string[];
	topics?: readonly (readonly [id: string, requirementIndex: number, section: string])[];
	code: string;
	execution?: string;
}

// One final revision per case, including incomplete evidence and contradictory work by design.
const cohort: readonly Scenario[] = [
	{
		id: "planned-clean",
		request: "Normalize a key to trimmed lowercase, then append '-signed' to the normalized key.",
		requirements: ["Normalize ' Ada ' to 'ada'.", "Signing ' Ada ' returns 'ada-signed'."],
		topics: [
			["normalize", 0, "Implement key() in final.ts. Check that key(' Ada ') prints ada in the combined verification."],
			["sign", 1, "Implement signedKey() in final.ts using key(). Check that signedKey(' Ada ') prints ada-signed in the combined verification."],
		],
		code: "export const key = (s: string) => s.trim().toLowerCase();\nexport const signedKey = (s: string) => key(s) + '-signed';",
		execution: `import { key, signedKey } from "./final.ts"; console.log(key(" Ada "), signedKey(" Ada "));`,
	},
	{
		id: "planned-mixed",
		request: "Convert square meters to square centimeters and retain separate runtime verification of both output units.",
		requirements: ["Show that area(2, 'cm2') prints 20000.", "Retain a runtime check showing area(2, 'm2') prints 2."],
		topics: [
			["centimeters", 0, "Implement the cm2 branch of area() in final.ts and retain the command and output showing area(2, 'cm2') prints 20000."],
			["meters", 1, "Implement the m2 branch of area() in final.ts and retain the separate command and output showing area(2, 'm2') prints 2; code alone cannot establish that the check ran."],
		],
		code: "export const area = (n: number, unit: 'cm2' | 'm2') => unit === 'cm2' ? n * 10_000 : n;",
		execution: `import { area } from "./final.ts"; console.log(area(2, "cm2"));`,
	},
	{
		id: "planned-vague",
		request: "Display a duration as milliseconds with a space before the unit.",
		requirements: ["Rendering 7 milliseconds returns '7 ms'."],
		topics: [["display", 0, "Improve display polish."]],
		code: "export const render = (ms: number) => `${ms} ms`;",
		execution: `import { render } from "./final.ts"; console.log(render(7));`,
	},
	{
		id: "planned-defect",
		request: "Cap a supplied page size at 5 without changing values below the cap.",
		requirements: ["pageSize(20) returns 5 and pageSize(2) returns 2."],
		topics: [["cap", 0, "Update pageSize() in final.ts and run a check with inputs 20 and 2; output must be 5 and 2, respectively."]],
		code: "export const pageSize = (n: number) => Math.min(n, 10);",
		execution: `import { pageSize } from "./final.ts"; console.log(pageSize(20), pageSize(2)); if (pageSize(20) !== 5 || pageSize(2) !== 2) { console.error("expected 5 2"); process.exit(1); }`,
	},
	{
		id: "unplanned-clean",
		request: "Trim whitespace from a tag before prepending '#'.",
		requirements: ["tag('  blue ') returns '#blue'."],
		code: "export const tag = (s: string) => '#' + s.trim();",
		execution: `import { tag } from "./final.ts"; console.log(tag("  blue "));`,
	},
	{
		id: "unplanned-no-verification",
		request: "Repeat a string the requested number of times.",
		requirements: ["repeat('a', 3) returns 'aaa'."],
		code: "export const repeat = (s: string, n: number) => s.repeat(n);",
	},
];

const statuses = ["approved", "bad_task", "missing_evidence", "defect", "inconclusive", "unavailable", "not_checked"] as const;
type Status = typeof statuses[number];
interface Verdict {
	status: Status;
	nonRun?: string;
	label?: string;
	confidence?: number;
	definition?: { label: string; confidence?: number };
}
const notChecked = (nonRun: string): Verdict => ({ status: "not_checked", nonRun });
const activityVerdict = (outcome: ToolOutcome): Verdict => {
	const details = outcome.details;
	if (details?.["prerequisite"] !== undefined) return notChecked("activity_prerequisite");
	if (details?.["skipped"] === true) return notChecked("activity_skipped");
	switch (details?.["kind"]) {
		case "invalid": case "stale": return notChecked(String(details["kind"]));
		case "unavailable": return { status: "unavailable" };
		case "unclear": case "unusable": return { status: "inconclusive" };
		case "defect": return { status: "defect" };
	}
	return details?.["approved"] === true ? { status: "approved" } : notChecked("unexpected_activity_result");
};

const plannedVerdict = (value: unknown, nonRun: string): Verdict => {
	const row = asRecord(value);
	const status = statuses.find(candidate => candidate === row?.["status"]);
	if (status === undefined) return notChecked("missing_planned_status");
	if (status === "not_checked") return notChecked(nonRun);
	const rawDefinition = asRecord(row?.["definition"]);
	return {
		status,
		...(typeof row?.["label"] === "string" ? { label: row["label"] } : {}),
		...(typeof row?.["confidence"] === "number" ? { confidence: row["confidence"] } : {}),
		...(typeof rawDefinition?.["label"] === "string" ? {
			definition: { label: rawDefinition["label"], ...(typeof rawDefinition["confidence"] === "number" ? { confidence: rawDefinition["confidence"] } : {}) },
		} : {}),
	};
};

async function executeScenario(scenario: Scenario): Promise<Evidence[]> {
	const evidence: Evidence[] = [{ kind: "code", source: "Written synthetic fixture: final.ts", quote: scenario.code }];
	const workspace = mkdtempSync(join(tmpdir(), "jev-acceptance-baseline-"));
	try {
		await Bun.write(join(workspace, "final.ts"), scenario.code);
		if (scenario.execution === undefined) return evidence;
		const argv = [process.execPath, "-e", scenario.execution];
		const result = Bun.spawnSync(argv, { cwd: workspace, timeout: 5_000, stdout: "pipe", stderr: "pipe" });
		evidence.push({ kind: "execution", source: "Bun command executed on synthetic final.ts",
			quote: `argv: ${JSON.stringify(argv)}\nstdout: ${result.stdout.toString().trim()}\nstderr: ${result.stderr.toString().trim()}\nexit: ${result.exitCode}` });
		return evidence;
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

function rates(verdicts: readonly Verdict[], unit: string) {
	const denominator = verdicts.length;
	return {
		unit,
		denominator,
		statuses: Object.fromEntries(statuses.map(status => {
			const count = verdicts.filter(verdict => verdict.status === status).length;
			return [status, { count, rate: count / denominator }];
		})),
	};
}

async function run() {
	const deadlineMs = 120_000;
	const transportTimeoutMs = 12_000;
	const started = performance.now();
	const deadline = AbortSignal.timeout(deadlineMs);
	const key = await memoizedApiKeyResolver(process.env)();
	const model = POLICY.defaultModel;
	let transportSubmissions = 0;
	const judge = createTypeSafeJudge({
		resolveKey: async () => key,
		model,
		createClient: (apiKey, defaultModel) => {
			const client = new TypeSafeClient({ apiKey, defaultModel, logLevel: "off", timeout: transportTimeoutMs, retry: { maxRetries: 0 } });
			return { systemOne: request => {
				deadline.throwIfAborted();
				transportSubmissions += 1;
				return client.systemOne(request, { signal: deadline });
			} };
		},
	});
	const planned = [];
	const unplanned = [];
	for (const scenario of cohort) {
		const state = freshState();
		const task = registerTask(state, scenario.request);
		// These are starting fixture bindings, not verdicts obtained from the live judge.
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items: [...scenario.requirements] };
		const planUrl = "local://synthetic-plan.md";
		const plan = scenario.topics?.map(([id, , section]) => `## ${id}\n${section}\n`).join("\n");
		if (plan !== undefined && scenario.topics !== undefined) {
			state.plan = { taskFingerprint: task.fingerprint, planUrl, planDigest: sha256(plan) };
			state.planTopics = scenario.topics.map(([id, index, section]) => ({ id, requirement: scenario.requirements[index]!, section, paths: ["final.ts"] }));
		}
		recordAction(state, { tool: "write", target: "final.ts", excerpt: scenario.code });
		const evidence = await executeScenario(scenario);
		const { revision } = state;
		const row = { id: scenario.id, task: task.fingerprint, revision, execution: evidence[1]?.quote ?? null };
		const before = transportSubmissions;
		const outcome = deadline.aborted ? undefined : await observedOutcome({ judge, config: DEFAULT_CONFIG, readArtifact: async url => url === planUrl ? plan ?? null : null }, state, evidence);
		const details = outcome?.details;
		const current = details?.["task"] === task.fingerprint && details?.["revision"] === revision;
		const fallback = outcome === undefined ? notChecked("cohort_deadline") : activityVerdict(outcome);
		const calls = { adapterCalls: state.usage.judgeCalls, transportSubmissions: transportSubmissions - before };
		const boundVerdict = fallback.status === "approved" || fallback.status === "defect"
			? notChecked("unexpected_outcome_binding") : fallback;
		if (plan === undefined) {
			const verdict = current && details?.["check"] === "observed_outcome" ? fallback : boundVerdict;
			unplanned.push({ ...row, ...calls, ...verdict });
			continue;
		}
		const binding = current && details?.["check"] === "planned_outcome" && details["planDigest"] === state.plan?.planDigest;
		const taskResults: unknown[] = binding && Array.isArray(details?.["tasks"]) ? details["tasks"] : [];
		const tasks = state.planTopics.map(({ id }) => ({ id, ...(binding
			? plannedVerdict(taskResults.find(result => asRecord(result)?.["id"] === id), "plan_task_not_run") : boundVerdict) }));
		const overall = binding ? plannedVerdict(details?.["overall"], tasks.every(result => result.status === "approved")
			? "integrated_review_not_run" : "plan_tasks_not_all_approved") : boundVerdict;
		planned.push({ ...row, planDigest: state.plan?.planDigest, ...calls, tasks, overall });
	}
	console.log(JSON.stringify({
		cohort: {
			sha256: sha256(JSON.stringify(cohort)),
			tasks: cohort.length,
			selection: "One current final revision per frozen scenario, selected before verdicts; no reruns.",
			evidence: "Synthetic work written and checked in isolated workspaces; no production task data.",
		},
		judge: {
			backend: "TypeSafe", requestedModel: model, transportTimeoutMs, deadlineMs,
			deadlineReached: deadline.aborted, elapsedMs: Math.round(performance.now() - started), credentialsConfigured: key !== undefined,
		},
		rates: {
			plannedIntegrated: rates(planned.map(row => row.overall), "planned scenarios"),
			plannedPerPlanTask: rates(planned.flatMap(row => row.tasks), "plan tasks"),
			unplanned: rates(unplanned, "unplanned scenarios"),
		},
		planned,
		unplanned,
	}, null, 2));
}

if (import.meta.main) {
	if (process.argv.length === 2) await run();
	else {
		console.error("Usage: bun tools/acceptance-baseline.ts (uses the configured TypeSafe judge; prints synthetic baseline JSON)");
		process.exitCode = 2;
	}
}
