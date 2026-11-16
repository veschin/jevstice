#!/usr/bin/env bun
/**
 * Ask the judge about each normative scenario separately, one call per scenario, and record the
 * verdict with its probability. The ledger is `scenarios/reviews.json`; a scenario whose text and
 * cited requirement text are unchanged is not paid for twice.
 *
 * Usage: bun tools/review-scenarios.ts [--file jev_triage] [--all] [--limit N] [--force]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoizedApiKeyResolver } from "../src/apikey.js";
import { createTypeSafeJudge } from "../src/judge.js";
import { sha256 } from "../src/state.js";
import { POLICY } from "../src/types.js";
import { parseFeature } from "../tests/scenarios/gherkin.js";

const ROOT = join(import.meta.dir, "..");
const LEDGER = join(ROOT, "scenarios", "reviews.json");

interface ReviewRecord {
	file: string;
	id: string;
	title: string;
	digest: string;
	requirementIds: string[];
	approved: boolean;
	probability?: number;
	problem?: string;
	at: string;
}

interface Ledger {
	reviews: ReviewRecord[];
}

function prdText(): string {
	return readFileSync(join(ROOT, "PRD.md"), "utf8");
}

/** The requirement text cited by a feature header, keyed by FR id. */
function requirementFor(prd: string, ids: string[]): string {
	const lines = prd.split(/\r?\n/);
	const found: string[] = [];
	for (const line of lines) {
		const match = /^- \*\*(FR-\d+)/.exec(line);
		if (match !== null && ids.includes(match[1] ?? "")) found.push(line.replace(/^[-*]\s*/, ""));
	}
	return found.join("\n");
}


/** Implementation excerpts the judge can compare against: <file, symbol> per feature. */
const EXCERPTS: Record<string, Array<[string, string]>> = {
	jev_triage: [
		["src/activities.ts", "triage"],
		["src/screen.ts", "weightOf"],
		["src/controller.ts", "430-580"],
	],
};

function excerpt(file: string, ref: string): string {
	const text = readFileSync(join(ROOT, file), "utf8");
	const range = /^(\d+)-(\d+)$/.exec(ref);
	if (range !== null) {
		const lines = text.split(/\r?\n/);
		return lines.slice(Number(range[1]) - 1, Number(range[2])).join("\n").slice(0, 4000);
	}
	const at = text.indexOf(`function ${ref}(`);
	if (at < 0) return "";
	let depth = 0;
	let started = false;
	for (let index = at; index < text.length; index += 1) {
		const char = text[index];
		if (char === "{") {
			depth += 1;
			started = true;
		} else if (char === "}") {
			depth -= 1;
			if (started && depth === 0) return text.slice(at, index + 1).slice(0, 4000);
		}
	}
	return text.slice(at, at + 4000);
}

function readLedger(): Ledger {
	try {
		return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
	} catch {
		return { reviews: [] };
	}
}

function writeLedger(ledger: Ledger): void {
	writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
}

const args = process.argv.slice(2);
const fileArg = args.includes("--file") ? args[args.indexOf("--file") + 1] : undefined;
const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : undefined;
const force = args.includes("--force");

const prd = prdText();
const ledger = readLedger();
const judge = createTypeSafeJudge({ resolveKey: memoizedApiKeyResolver(process.env), model: POLICY.defaultModel });

const files: string[] = fileArg === undefined ? [] : [`${fileArg}.feature`];
if (args.includes("--all")) {
	files.push(...readdirSync(join(ROOT, "scenarios")).filter(name => name.endsWith(".feature")).sort());
}

let asked = 0;
let approved = 0;
let below = 0;

for (const file of files) {
	const feature = parseFeature(readFileSync(join(ROOT, "scenarios", file), "utf8"), file);
	const header = readFileSync(join(ROOT, "scenarios", file), "utf8").split(/\r?\n/).slice(0, 6).join("\n");
	const ids = [...new Set([...header.matchAll(/FR-\d+/g)].map(match => match[0]))];
	const headerRequirement = requirementFor(prd, ids);

	for (const scenario of feature.scenarios) {
		if (limitArg !== undefined && asked >= limitArg) break;
		const body = scenario.steps.map(step => `${step.keyword} ${step.text}`).join("\n");
		const scenarioIds = [...new Set(scenario.tags.filter(tag => /^fr_\d+$/.test(tag)).map(tag => tag.toUpperCase().replace("FR_", "FR-")))];
		const requirement = scenarioIds.length === 0 ? headerRequirement : requirementFor(prd, scenarioIds);
		const implementation = (EXCERPTS[file.replace(/\.feature$/, "")] ?? [])
			.map(([path, symbol]) => `--- ${path} ${symbol}\n${excerpt(path, symbol)}`)
			.join("\n");
		const digest = sha256(`${file}\n${scenario.id}\n${scenario.name}\n${body}\n${requirement}\n${implementation}`);
		const previous = ledger.reviews.find(record => record.file === file && record.id === scenario.id);
		if (!force && previous?.digest === digest) {
			console.log(`${scenario.id} cached ${previous.approved ? "approved" : "not approved"}`);
			continue;
		}
		const outcome = await judge(
			{ scenario: scenario.id, file, requirement, body, implementation },
			[
				{
					name: "scenario_agreement",
					mode: "choice",
					instructions:
						`Classify one business scenario against its cited requirement text and the quoted implementation. Scenario: "${scenario.name}". Steps:\n${body}`,
					options: {
						matches: "the scenario restates the cited requirement and the quoted implementation performs exactly it",
						requirement_gap: "the scenario restates the requirement, but the quoted implementation does not perform it",
						scenario_exceeds: "the scenario asks for behavior beyond the cited requirement and beyond the implementation",
						contradicts: "the scenario contradicts the requirement or the quoted implementation",
					},
				},
			],
		);
		asked += 1;
		const answer = outcome.ok ? outcome.answers[0] : undefined;
		const label = answer?.mode === "choice" ? answer.label : undefined;
		const probability = answer?.confidence;
		const ok = label === "matches" && probability !== undefined && probability >= POLICY.minConfidenceToApprove;
		if (ok) approved += 1;
		else below += 1;
		const record: ReviewRecord = {
			file,
			id: scenario.id,
			title: scenario.name,
			digest,
			requirementIds: ids,
			approved: ok,
			...(probability === undefined ? {} : { probability }),
			...(outcome.ok ? {} : { problem: outcome.problem }),
			at: new Date().toISOString(),
		};
		ledger.reviews = [...ledger.reviews.filter(entry => !(entry.file === file && entry.id === scenario.id)), record];
		writeLedger(ledger);
		console.log(`${scenario.id} ${ok ? "approved" : "BELOW"} ${label ?? (outcome.ok ? "no answer" : outcome.problem)} ${probability === undefined ? "" : probability.toFixed(2)}`);
	}
}

console.log(`\nasked ${asked} · approved ${approved} · below or unusable ${below}`);
if (below > 0) process.exitCode = 1;
