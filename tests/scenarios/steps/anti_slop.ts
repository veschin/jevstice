/**
 * Steps for `scenarios/jev_anti_slop.feature`. Every review is driven through the production
 * `antiSlop` activity and `antiSlopStatus` state projection; the disclosure scenario also runs the
 * production controller so admission and session completion are observed, and the delivery scenario
 * runs `actionCheck` under a strict run so supervisor judgement and reviewed-byte binding are both
 * visible.
 */
import { expect } from "bun:test";
import { actionCheck, antiSlop, triage } from "../../../src/activities.js";
import { createJevController } from "../../../src/controller.js";
import {
	antiSlopScope,
	antiSlopStatus,
	findAntiSlopFinding,
	freshState,
	queueOwnerMessage,
	recordAction,
	registerTask,
	sha256,
	type AntiSlopStatus,
	type JevState,
} from "../../../src/state.js";
import type { Judge, JudgeQuestion } from "../../../src/judge.js";
import { asRecord, type JevConfig, type ToolOutcome } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	boundaryConfig,
	cleanProtocolAnswers,
	failingJudge,
	fakeCtx,
	fakePi,
	fakeZod,
	stopDecision,
	stopEvent,
	toolCallEvent,
	toolDetails,
	toolText,
	type FakeAnswerSource,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

const { given, when, then } = scoped("jev_anti_slop.feature");

// ---------------------------------------------------------------------------
// The submitted deliverable, its declarations and the answers the fake judge returns
// ---------------------------------------------------------------------------

const REQUEST = "Write the legal memo for the client";
const ARTIFACT =
	"The agreement takes effect on 1 January 2027. " +
	"The supplier must deliver within 30 days. " +
	"The supplier is therefore liable for delay.";

const CLAIM = {
	id: "claim-1",
	text: "The agreement takes effect on 1 January 2027.",
	kind: "fact",
	evidence: [
		{ kind: "documentation", quote: "Commencement: 1 January 2027.", source: "contract", sourceClass: "reputable_secondary" },
	],
};
const REFUTED = {
	text: "The supplier must deliver within 30 days.",
	kind: "fact",
	evidence: [{ kind: "documentation", quote: "Delivery is due within 14 days.", source: "contract", sourceClass: "official" }],
};
const UNSETTLED = {
	text: "The supplier is therefore liable for delay.",
	kind: "fact",
	evidence: [{ kind: "documentation", quote: "The contract leaves liability undecided.", sourceClass: "primary" }],
};

/** One refuted claim under the id the scenario needs; its question is `claim_<n>`. */
function refutedClaim(id: string): Record<string, unknown> {
	return { id, ...REFUTED };
}
const INFERENCE = {
	id: "inference-1",
	premises: [CLAIM.text],
	warrant: "A delivery deadline creates liability for a missed delivery.",
	conclusion: "The supplier is therefore liable for delay.",
};
const RULE_LINE = "Use formal legal English.";
const SECOND_RULE_LINE = "Avoid second person addresses.";
const HYPOTHESIS_FALSIFIER = "A court voids the agreement before 1 January 2027.";

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		artifact: ARTIFACT,
		language: "English",
		register: "formal legal English",
		purpose: "supplier agreement for the client",
		audience: "the client outside the project",
		rules: [{ class: "register", rule: RULE_LINE, severity: "warning" }],
		claims: [CLAIM],
		inferences: [],
		...overrides,
	};
}

interface JudgeCallRecord {
	state: unknown;
	questions: readonly JudgeQuestion[];
}

interface JudgeHarness {
	judge: Judge;
	calls: JudgeCallRecord[];
}

interface AntiSlopWorld {
	state: JevState;
	table: Record<string, FakeAnswerSource>;
	config: JevConfig;
	fake?: JudgeHarness;
	params: Record<string, unknown>;
	outcome?: ToolOutcome;
	outcomes: ToolOutcome[];
	attempts: ToolOutcome[];
	protocolQuestionNames: string[][];
	triage?: ToolOutcome;
	// per-scenario observations
	defect?: string;
	evidenceQuote?: string;
	findingIds: string[];
	reportText?: string;
	reviewText?: string;
	reviewDetails?: Record<string, unknown>;
	block?: string;
	stop?: string;
	pi?: FakePi;
	ctx?: Record<string, unknown>;
	commandNames: string[];
	toolNames: string[];
	statuses: AntiSlopStatus[];
	boundOutcomes: ToolOutcome[];
	callsAfterBounds: number;
	reviewsAfterBounds: number;
	stableIds: string[];
	invalidations: Array<{ oldId: string; newId: string; before: unknown; after: unknown }>;
	crossScope?: { sameTask: boolean; otherTask: boolean; otherRevision: boolean };
	strict?: { admitted: ToolOutcome; outside: ToolOutcome; changed: ToolOutcome };
	reviewDigest?: string;
	partOneDigest?: string;
	partTwoDigest?: string;
	oldPartOneFinding?: string;
	newPartOneFinding?: string;
	afterPartOneDigest?: string;
}

const world = (value: unknown): AntiSlopWorld => value as AntiSlopWorld;

function setup(value: unknown): AntiSlopWorld {
	const w = world(value);
	if (w.state === undefined) {
		w.state = freshState();
		w.table = {};
		w.config = boundaryConfig();
		w.params = {};
		w.outcomes = [];
		w.attempts = [];
		w.protocolQuestionNames = [];
		w.findingIds = [];
		w.commandNames = [];
		w.toolNames = [];
		w.statuses = [];
		w.boundOutcomes = [];
		w.callsAfterBounds = 0;
		w.reviewsAfterBounds = 0;
		w.stableIds = [];
		w.invalidations = [];
	}
	return w;
}

/** A registered external deliverable: the only scope the review accepts. */
function external(w: AntiSlopWorld, request = REQUEST): JevState {
	w.state = freshState();
	w.state.request = { text: request, weight: "judged" };
	registerTask(w.state, request, true);
	return w.state;
}

function getFake(w: AntiSlopWorld): JudgeHarness {
	if (w.fake === undefined) w.fake = answeringJudge(w.table);
	return w.fake;
}

function deps(w: AntiSlopWorld): { judge: Judge; config: JevConfig } {
	return { judge: getFake(w).judge, config: w.config };
}

async function run(w: AntiSlopWorld, params: Record<string, unknown>): Promise<ToolOutcome> {
	w.params = params;
	w.outcome = await antiSlop(deps(w), w.state, params);
	return w.outcome;
}

/** Clean answers for every fragment, built-in style check and rule, so only the intended defect produces a finding. */
function quiet(w: AntiSlopWorld, fragments = 1, rules = 1): void {
	Object.assign(w.table, cleanProtocolAnswers(fragments));
	for (let fragment = 1; fragment <= fragments; fragment += 1) {
		w.table[`language_${fragment}`] = { probability: 0.05 };
		w.table[`meta_${fragment}`] = { probability: 0.05 };
		w.table[`relevance_${fragment}`] = { label: "serves", confidence: 0.95 };
		for (let rule = 1; rule <= rules; rule += 1) {
			w.table[`rule_${fragment}_${rule}`] = { probability: 0.05 };
		}
	}
}

function listOf(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	const entries: Record<string, unknown>[] = [];
	for (const entry of value) {
		const item = asRecord(entry);
		if (item !== undefined) entries.push(item);
	}
	return entries;
}

function detailsOf(outcome: ToolOutcome | undefined): Record<string, unknown> {
	return outcome?.details ?? {};
}

function findingsOf(outcome: ToolOutcome | undefined): Record<string, unknown>[] {
	return listOf(detailsOf(outcome), "findings");
}

function claimsOf(outcome: ToolOutcome | undefined): Record<string, unknown>[] {
	return listOf(detailsOf(outcome), "claims");
}

function inferencesOf(outcome: ToolOutcome | undefined): Record<string, unknown>[] {
	return listOf(detailsOf(outcome), "inferences");
}

function findingByKind(outcome: ToolOutcome | undefined, kind: string): Record<string, unknown> | undefined {
	return findingsOf(outcome).find(finding => finding["kind"] === kind);
}

function judged(w: AntiSlopWorld, index = 0): Record<string, unknown> {
	return asRecord(getFake(w).calls[index]?.state) ?? {};
}

function questionNames(w: AntiSlopWorld, callIndex = 0): string[] {
	return (getFake(w).calls[callIndex]?.questions ?? []).map(question => question.name);
}

// Background ---------------------------------------------------------------

given("ordinary Jev diagnostics are enabled", value => {
	// The shipped configuration is advisory anti-slop over ordinary Jev diagnostics.
	const w = setup(value);
	expect(w.config.antiSlop.mode).toBe("advisory");
});

// Scenario 1 ---------------------------------------------------------------

given("a document intended for an audience outside the project", value => {
	const w = setup(value);
	external(w);
	quiet(w);
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	expect(w.state.task?.external).toBe(true);
});

when("the executor submits the exact artifact and its required declarations", async value => {
	const w = setup(value);
	await run(w, submission());
});

then("the review runs for that external deliverable", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(true);
	expect(w.outcome?.details?.["subject"]).toBe(w.state.task?.fingerprint);
	expect(w.state.antiSlopReviews).toHaveLength(1);
	expect(w.state.antiSlopReviews[0]?.request).toBe(REQUEST);
});

then("an internal code change or internal note is refused as out of scope", async value => {
	const w = world(value);
	const internal = freshState();
	registerTask(internal, "Change the parser", false);
	const callsBefore = w.fake?.calls.length ?? 0;
	const refused = await antiSlop(
		{ judge: getFake(w).judge, config: w.config },
		internal,
		w.params,
	);
	expect(refused.ok).toBe(false);
	expect(refused.text).toContain("external deliverable");
	expect(refused.text).toContain("none is in scope");
	expect(w.fake?.calls.length ?? 0).toBe(callsBefore);
	expect(internal.antiSlopReviews).toHaveLength(0);
});

// Scenario 2 ---------------------------------------------------------------

given("triage's external answer is below the confidence floor", value => {
	const w = setup(value);
	w.state = freshState();
	w.table.needs_development = { probability: 0.95 };
	w.table.external_deliverable = { probability: 0.55 };
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	quiet(w);
});

when("the task is registered", async value => {
	const w = setup(value);
	const triaged = await triage({ judge: getFake(w).judge, config: w.config }, w.state, { request: REQUEST });
	w.triage = triaged;
	expect(triaged.ok).toBe(true);
	expect(w.state.task).toBeDefined();
	const reviewed = await run(w, submission());
	expect(reviewed.ok).toBe(true);
});

then("the deliverable is not silently classified as internal", value => {
	expect(world(value).state.task?.external).toBe(true);
});

then("explicit review remains available", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(true);
	expect(w.state.antiSlopReviews).toHaveLength(1);
});

then("no publication is authorized by the classification", value => {
	const w = world(value);
	expect(w.triage?.text).not.toMatch(/authoriz/i);
	expect(w.triage?.details?.["approved"]).toBeUndefined();
});

// Scenario 3 ---------------------------------------------------------------

given("anti-slop mode is off in configuration", value => {
	const w = setup(value);
	external(w);
	w.config = { ...boundaryConfig(), antiSlop: { mode: "off" } };
});

when("the executor submits an external artifact", async value => {
	const w = setup(value);
	await run(w, submission());
});

then("the result names the configuration prerequisite", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.outcome?.text).toContain("off in this configuration");
	expect(w.outcome?.text).toContain("prerequisite");
	expect(w.outcome?.details?.["prerequisite"]).toBe(true);
});

then("no judge request is made", value => {
	const w = world(value);
	expect(w.fake?.calls ?? []).toHaveLength(0);
});

then("no trusted mark or finding is invented", value => {
	const w = world(value);
	expect(w.state.antiSlopReviews).toHaveLength(0);
	expect(w.outcome?.details?.["findings"]).toBeUndefined();
	expect(w.outcome?.text).not.toContain("trusted");
});

// Scenario 4 ---------------------------------------------------------------

given("an external artifact review records a blocker finding in advisory mode", async value => {
	const w = setup(value);
	w.table.needs_development = { probability: 0.95 };
	w.table.external_deliverable = { probability: 0.95 };
	w.table.claim_1 = { label: "refuted", confidence: 0.95 };
	quiet(w);
	const fake = answeringJudge(w.table);
	const pi = fakePi();
	const ctx = fakeCtx({ sessionId: "anti-slop-advisory" });
	createJevController({ judge: fake.judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	w.pi = pi;
	w.ctx = asRecord(ctx);
	const triaged = await pi.callTool("jev_triage", { request: REQUEST }, ctx);
	expect(toolText(triaged)).toContain("External deliverable");
	const reviewed = await pi.callTool("jev_anti_slop", submission(), ctx);
	w.reviewText = toolText(reviewed);
	w.reviewDetails = toolDetails(reviewed);
	const findings = listOf(w.reviewDetails ?? {}, "findings");
	expect(findings).toHaveLength(1);
	expect(findings[0]?.["kind"]).toBe("contradicted_claim");
	expect(findings[0]?.["severity"]).toBe("blocker");
	w.findingIds = [String(findings[0]?.["id"])];
});

when("the executor continues work and ends the session", async value => {
	const w = setup(value);
	expect(w.pi).toBeDefined();
	expect(w.ctx).toBeDefined();
	w.block = blockReason(
		await w.pi!.emit(
			"tool_call",
			toolCallEvent("write", { path: "memo.md", content: ARTIFACT }),
			w.ctx,
		),
	);
	w.stop = stopDecision(await w.pi!.emit("session_stop", stopEvent(), w.ctx));
});

then("neither action is blocked by the finding", value => {
	const w = world(value);
	expect(w.block).toBeUndefined();
	expect(w.stop).toBeUndefined();
});

then("the result lists the finding for the executor to disclose to the owner", value => {
	const w = world(value);
	const id = w.findingIds[0] ?? "";
	expect(id).not.toBe("");
	expect(w.reviewText).toContain(id);
	expect(w.reviewText).toContain("blocker contradicted_claim");
	expect(w.reviewText).toContain("details.findings");
});

then("it is never reported as Jev delivery approval", value => {
	const w = world(value);
	expect(w.reviewDetails?.["approved"]).toBeUndefined();
	expect(w.reviewText ?? "").not.toMatch(/approved/iu);
	expect(w.reviewText ?? "").toContain("authorizes no effect");
});

// Scenario 5 (outline) -----------------------------------------------------

given("the submission omits or invalidates {string}", (value, defect) => {
	const w = setup(value);
	w.defect = defect;
});

when("the review is validated", async value => {
	const w = setup(value);
	const defect = w.defect ?? "";
	external(w);
	const base = submission();
	const invalid: Record<string, unknown> =
		defect === "artifact text"
			? { ...base, artifact: "   " }
			: defect === "language"
				? { ...base, language: "  " }
				: defect === "register"
					? { ...base, register: "" }
					: defect === "purpose"
						? { ...base, purpose: " " }
						: defect === "audience"
							? { ...base, audience: "" }
							: defect === "malformed owner-supplied rules"
								? { ...base, rules: [{ class: "", rule: RULE_LINE }] }
								: defect === "empty rules for an unsupported language"
									? { ...base, language: "French", rules: [] }
									: defect === "a claim that does not occur in the artifact"
										? { ...base, claims: [{ ...CLAIM, text: "A sentence absent from the artifact." }], inferences: [] }
										: { ...base, claims: [{ ...CLAIM, evidence: [{ ...CLAIM.evidence[0], sourceClass: "blog" }] }], inferences: [] };
	const outcome = await antiSlop(deps(w), w.state, invalid);
	w.params = invalid;
	w.outcomes = [outcome];
});

then("the result names the invalid field", value => {
	const w = world(value);
	const defect = w.defect ?? "";
	const expected =
		defect === "artifact text"
			? /artifact is required/i
			: defect === "language"
				? /language/
				: defect === "register"
					? /register/
					: defect === "purpose"
						? /purpose/
						: defect === "audience"
							? /audience/
							: defect === "malformed owner-supplied rules"
								? /class and rule line/i
								: defect === "empty rules for an unsupported language"
									? /rules?/i
									: defect === "a claim that does not occur in the artifact"
										? /does not occur verbatim/i
										: /sourceClass/;
	const outcome = w.outcomes[0];
	expect(outcome?.ok).toBe(false);
	expect(outcome?.text ?? "").toMatch(expected);
});

then("the artifact is not partially reviewed", value => {
	const w = world(value);
	expect(w.state.antiSlopReviews).toHaveLength(0);
	expect(findingsOf(w.outcomes[0])).toHaveLength(0);
	expect(w.outcomes[0]?.text).toContain("nothing was judged and no finding is recorded");
});

// Scenario 5b --------------------------------------------------------------

given("an external deliverable has no owner rules and no factual claims", value => {
	const w = setup(value);
	external(w);
	w.table = {
		...cleanProtocolAnswers(),
		language_1: { probability: 0.05 },
		meta_1: { probability: 0.05 },
		relevance_1: { label: "serves", confidence: 0.95 },
	};
	expect(w.state.task?.external).toBe(true);
});

when("the review is submitted in English and in Russian", async value => {
	const w = setup(value);
	for (const language of ["English", "Russian"]) {
		external(w);
		w.fake = undefined;
		const outcome = await run(w, submission({ language, rules: [], claims: [], inferences: [] }));
		w.outcomes.push(outcome);
		w.protocolQuestionNames.push(questionNames(w));
	}
});

then("the selected built-in protocol is recorded and asked for every fragment", value => {
	const w = world(value);
	expect(w.outcomes).toHaveLength(2);
	for (const [index, expected] of ["en", "ru"].entries()) {
		const outcome = w.outcomes[index];
		if (outcome === undefined || !outcome.ok) throw new Error(outcome?.text ?? "missing review");
		const protocol = asRecord(detailsOf(outcome)["protocol"]);
		expect(protocol?.["language"]).toBe(expected);
		expect(w.protocolQuestionNames[index]).toEqual(
			expect.arrayContaining(["protocol_1_1", "protocol_1_2", "protocol_1_3", "protocol_1_4"]),
		);
	}
});

then("the normal result names its numbered steps and concrete repairs", value => {
	const w = world(value);
	for (const outcome of w.outcomes) {
		if (outcome === undefined || !outcome.ok) throw new Error(outcome?.text ?? "missing review");
		const protocol = asRecord(detailsOf(outcome)["protocol"]);
		const steps = protocol?.["steps"];
		const checks = protocol?.["checks"];
		expect(Array.isArray(steps)).toBe(true);
		expect(Array.isArray(checks)).toBe(true);
		for (const step of steps as string[]) expect(outcome.text).toContain(step);
		for (const check of checks as Array<Record<string, unknown>>) {
			expect(String(check["repair"]).length).toBeGreaterThan(0);
		}
		expect(detailsOf(outcome)["findings"]).toEqual([]);
	}
});

then("malformed supplied rules remain invalid", async value => {
	const w = world(value);
	const state = external(w);
	const fake = answeringJudge({});
	const outcome = await antiSlop(
		{ judge: fake.judge, config: w.config },
		state,
		submission({ rules: [{ class: "", rule: RULE_LINE }] }),
	);
	expect(outcome.ok).toBe(false);
	expect(fake.calls).toHaveLength(0);
	expect(outcome.text).toMatch(/class and rule line/i);
});

// Scenario 6 ---------------------------------------------------------------

given("a factual claim quotes evidence that supports it at the floor", value => {
	const w = setup(value);
	external(w);
	w.params = submission({ claims: [CLAIM, refutedClaim("claim-2"), { id: "claim-3", ...UNSETTLED }], inferences: [] });
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	w.table.claim_2 = { label: "refuted", confidence: 0.95 };
	w.table.claim_3 = { label: "not_enough_info", confidence: 0.95 };
	quiet(w);
});

given("the evidence source class is reputable_secondary or stronger", value => {
	const w = world(value);
	const evidence = CLAIM.evidence[0];
	expect(evidence?.sourceClass).toBe("reputable_secondary");
	expect(w.table.claim_1).toBeDefined();
});

when("the claim is judged", async value => {
	const w = setup(value);
	await run(w, w.params);
});

then("the claim is marked trusted with the supporting verdict", value => {
	const w = world(value);
	const claim = claimsOf(w.outcome).find(entry => entry["id"] === "claim-1");
	expect(claim?.["trust"]).toBe("trusted");
	expect(claim?.["verdict"]).toBe("supported");
});

then("a refuted claim at the floor is a blocker contradicted_claim", value => {
	const w = world(value);
	const claim = claimsOf(w.outcome).find(entry => entry["id"] === "claim-2");
	expect(claim?.["trust"]).toBe("distrusted");
	const finding = findingByKind(w.outcome, "contradicted_claim");
	expect(finding?.["severity"]).toBe("blocker");
	expect(finding?.["target"]).toBe("claim-2");
});

then("a claim the judge cannot settle is unverified, never trusted", value => {
	const w = world(value);
	const claim = claimsOf(w.outcome).find(entry => entry["id"] === "claim-3");
	expect(claim?.["trust"]).toBe("unverified");
	expect(claim?.["verdict"]).toBe("not_enough_info");
	expect(claim?.["trust"]).not.toBe("trusted");
});

// Scenario 7 (outline) -----------------------------------------------------

given("a claim has {string}", (value, problem) => {
	const w = setup(value);
	external(w);
	quiet(w);
	const claim =
		problem === "no evidence items"
			? { id: "claim-1", text: CLAIM.text, kind: "fact", evidence: [] }
			: {
					id: "claim-1",
					text: CLAIM.text,
					kind: "fact",
					evidence: [{ kind: "documentation", quote: CLAIM.text, source: "the executor", sourceClass: "official" }],
				};
	w.params = submission({ claims: [claim], inferences: [] });
});

when("the review runs", async value => {
	const w = setup(value);
	await run(w, w.params);
});

then("the claim is marked distrusted and unsupported", value => {
	const w = world(value);
	const claim = claimsOf(w.outcome)[0];
	expect(claim?.["trust"]).toBe("distrusted");
	expect(claim?.["verdict"]).toBe("unsupported");
});

then("a blocker unsupported_claim finding is recorded", value => {
	const w = world(value);
	const finding = findingByKind(w.outcome, "unsupported_claim");
	expect(finding?.["severity"]).toBe("blocker");
	expect(finding?.["target"]).toBe("claim-1");
});

then("the executor's own assertion is not counted as evidence", value => {
	const w = world(value);
	const judgedClaims = listOf(asRecord(judged(w)["antiSlop"]) ?? {}, "claims");
	const judgedEvidence = listOf(judgedClaims[0] ?? {}, "evidence");
	expect(judgedEvidence).toHaveLength(0);
	expect(listOf(claimsOf(w.outcome)[0] ?? {}, "evidence")).toHaveLength(0);
	expect(questionNames(w)).not.toContain("claim_1");
});

// Scenario 8 ---------------------------------------------------------------

given("a claim is supported at the floor by an anonymous source", value => {
	const w = setup(value);
	external(w);
	quiet(w);
	w.evidenceQuote = "An anonymous survey reports 72% agreement.";
	w.params = submission({
		claims: [
			{
				id: "claim-1",
				text: CLAIM.text,
				kind: "fact",
				evidence: [
					{ kind: "documentation", quote: w.evidenceQuote, source: "survey", sourceClass: "anonymous" },
				],
			},
		],
		inferences: [],
	});
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
});

when("the trust mark is assigned", async value => {
	const w = setup(value);
	await run(w, w.params);
});

then("the claim is low_trust rather than trusted", value => {
	const w = world(value);
	const claim = claimsOf(w.outcome)[0];
	expect(claim?.["trust"]).toBe("low_trust");
	expect(claim?.["trust"]).not.toBe("trusted");
	expect(claim?.["verdict"]).toBe("supported");
});

then("a warning low_trust_source finding is recorded", value => {
	const w = world(value);
	const finding = findingByKind(w.outcome, "low_trust_source");
	expect(finding?.["severity"]).toBe("warning");
	expect(finding?.["target"]).toBe("claim-1");
});

then("the supporting evidence remains listed", value => {
	const w = world(value);
	const evidence = listOf(claimsOf(w.outcome)[0] ?? {}, "evidence");
	expect(evidence.map(entry => entry["quote"])).toContain(w.evidenceQuote);
	expect(w.outcome?.text).toContain(w.evidenceQuote ?? "");
});

// Scenario 9 ---------------------------------------------------------------

given("an inference quotes its premises from the artifact and states a warrant", value => {
	const w = setup(value);
	external(w);
	quiet(w);
	w.params = submission({ claims: [], inferences: [INFERENCE] });
});

when("the judge answers that the conclusion does not follow at the floor", async value => {
	const w = setup(value);
	w.table.inference_1 = { label: "does_not_follow", confidence: 0.95 };
	await run(w, w.params);
});

then("the inference is distrusted", value => {
	const w = world(value);
	const inference = inferencesOf(w.outcome)[0];
	expect(inference?.["trust"]).toBe("distrusted");
	expect(inference?.["verdict"]).toBe("does_not_follow");
});

then("a blocker invalid_inference finding is recorded", value => {
	const w = world(value);
	const finding = findingByKind(w.outcome, "invalid_inference");
	expect(finding?.["severity"]).toBe("blocker");
	expect(finding?.["target"]).toBe("inference-1");
});

then("no unsubmitted premise or warrant is added", value => {
	const w = world(value);
	const judgedInferences = listOf(asRecord(judged(w)["antiSlop"]) ?? {}, "inferences");
	expect(judgedInferences).toHaveLength(1);
	expect(judgedInferences[0]?.["premises"]).toEqual(INFERENCE.premises);
	expect(judgedInferences[0]?.["warrant"]).toBe(INFERENCE.warrant);
	const basis = asRecord(inferencesOf(w.outcome)[0]?.["basis"]);
	expect(basis?.["premises"]).toEqual(INFERENCE.premises);
	expect(basis?.["warrant"]).toBe(INFERENCE.warrant);
});

// Scenario 10 (outline) ----------------------------------------------------

given("a hypothesis claim has {string}", (value, falsifier) => {
	const w = setup(value);
	external(w);
	quiet(w);
	const claim =
		falsifier === "no submitted falsifier"
			? { id: "claim-1", text: CLAIM.text, kind: "hypothesis", evidence: CLAIM.evidence }
			: {
					id: "claim-1",
					text: CLAIM.text,
					kind: "hypothesis",
					evidence: CLAIM.evidence,
					falsifier:
						falsifier === "an accepted observable falsifier"
							? HYPOTHESIS_FALSIFIER
							: "The hypothesis is an interesting question.",
				};
	if (falsifier === "a falsifier rejected at the floor") {
		w.table.falsifiable_1 = { probability: 0.05 };
		w.table.claim_1 = { label: "supported", confidence: 0.95 };
	}
	if (falsifier === "an accepted observable falsifier") {
		w.table.falsifiable_1 = { probability: 0.95 };
		w.table.claim_1 = { label: "supported", confidence: 0.95 };
	}
	w.params = submission({ claims: [claim], inferences: [] });
});

when("the review judges falsifiability", async value => {
	const w = setup(value);
	await run(w, w.params);
});

then("the claim is {string}", (value, expected) => {
	const w = world(value);
	const claim = claimsOf(w.outcome)[0];
	const trust = expected === "judged by claim evidence" ? "trusted" : expected;
	expect(claim?.["trust"]).toBe(trust);
	if (expected === "judged by claim evidence") expect(claim?.["verdict"]).toBe("supported");
});

then("the result is {string}", (value, expected) => {
	const w = world(value);
	const finding = findingByKind(w.outcome, "unfalsifiable_hypothesis");
	if (expected === "none for falsifiability") {
		expect(finding).toBeUndefined();
		return;
	}
	expect(finding?.["kind"]).toBe(expected);
	expect(finding?.["severity"]).toBe("blocker");
	expect(finding?.["target"]).toBe("claim-1");
});

// Scenario 11 --------------------------------------------------------------

given("a large artifact is split into bounded fragments", value => {
	const w = setup(value);
	external(w);
	const first = "The agreement takes effect on 1 January 2027.";
	const second = "This section explains how the argument is organized and what the reader should feel.";
	const third = "See Section 4 for the delivery deadline. The supplier must deliver within 30 days.";
	w.params = submission({
		artifact: [first, second, third].join("\n\n"),
		rules: [
			{ class: "register", rule: RULE_LINE, severity: "warning" },
			{ class: "tone", rule: SECOND_RULE_LINE, severity: "blocker" },
		],
		claims: [
			{
				id: "claim-1",
				text: "The supplier must deliver within 30 days.",
				kind: "fact",
				evidence: [{ kind: "documentation", quote: "Delivery clause 4.", sourceClass: "official" }],
			},
		],
		inferences: [],
	});
	quiet(w, 3, 2);
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	w.table.language_1 = { probability: 0.95 };
	w.table.meta_2 = { probability: 0.95 };
	w.table.relevance_3 = { label: "off_topic", confidence: 0.95 };
	w.table.rule_2_1 = { probability: 0.95 };
	w.table.rule_2_2 = { probability: 0.95 };
});

then("a fragment outside the declared language is a blocker language_mismatch", value => {
	const w = world(value);
	const finding = findingByKind(w.outcome, "language_mismatch");
	expect(finding?.["severity"]).toBe("blocker");
	expect(finding?.["target"]).toBe("fragment-1");
});

then("a violated rule quotes the submitted rule line and uses its declared severity", value => {
	const w = world(value);
	const violations = findingsOf(w.outcome).filter(finding => finding["kind"] === "register_violation");
	const warning = violations.find(finding => finding["rule"] === RULE_LINE);
	const blocker = violations.find(finding => finding["rule"] === SECOND_RULE_LINE);
	expect(warning?.["severity"]).toBe("warning");
	expect(blocker?.["severity"]).toBe("blocker");
	expect(violations).toHaveLength(2);
});

then("meta-text is a blocker meta_text while repetition or off-topic material is a warning", value => {
	const w = world(value);
	const meta = findingByKind(w.outcome, "meta_text");
	expect(meta?.["severity"]).toBe("blocker");
	expect(meta?.["target"]).toBe("fragment-2");
	const redundant = findingByKind(w.outcome, "redundant_material");
	expect(redundant?.["severity"]).toBe("warning");
	expect(redundant?.["target"]).toBe("fragment-3");
	expect(redundant?.["verdict"]).toBe("off_topic");
});

then("functional cross-references in operative content are not treated as meta-text", value => {
	const w = world(value);
	const metaOnOperative = findingsOf(w.outcome).find(
		finding => finding["kind"] === "meta_text" && finding["target"] === "fragment-3",
	);
	expect(metaOnOperative).toBeUndefined();
	const metaQuestion = (getFake(w).calls[0]?.questions ?? []).find(question => question.name === "meta_3");
	expect(metaQuestion?.instructions).toContain("See Section 4 for the delivery deadline");
	expect(metaQuestion?.instructions).toContain("functional cross-reference");
});

// Scenario 12 --------------------------------------------------------------

given("an artifact, rule set, claim set or question batch exceeds its configured bound", value => {
	const w = setup(value);
	external(w);
});

when("the review is submitted", async value => {
	const w = setup(value);
	const manyFragments = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}. ${ARTIFACT}`).join("\n\n");
	const oversized: Record<string, unknown>[] = [
		submission({ artifact: "x".repeat(16001) }),
		submission({
			rules: Array.from({ length: 51 }, (_, index) => ({
				class: "register",
				rule: `Submitted rule ${index + 1}.`,
				severity: "warning",
			})),
		}),
		submission({
			claims: Array.from({ length: 41 }, (_, index) => ({
				id: `claim-${index + 1}`,
				text: `Claim ${index + 1}.`,
				kind: "fact",
				evidence: [],
			})),
			inferences: [],
		}),
		submission({
			artifact: manyFragments,
			rules: Array.from({ length: 50 }, (_, index) => ({
				class: "register",
				rule: `Batch rule ${index + 1}.`,
				severity: "warning",
			})),
			claims: [CLAIM],
			inferences: [],
		}),
	];
	for (const params of oversized) {
		w.boundOutcomes.push(await antiSlop(deps(w), w.state, params));
	}
	w.callsAfterBounds = w.fake?.calls.length ?? 0;
	w.reviewsAfterBounds = w.state.antiSlopReviews.length;

	quiet(w);
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	await run(w, submission({ part: { index: 1, total: 2 } }));
	w.statuses.push(antiSlopStatus(w.state, antiSlopScope(w.state)!));
	await run(w, submission({ artifact: `${ARTIFACT} Delivery is monitored weekly.`, part: { index: 2, total: 2 } }));
	w.statuses.push(antiSlopStatus(w.state, antiSlopScope(w.state)!));
});

then("it is refused before any judge call", value => {
	const w = world(value);
	expect(w.boundOutcomes).toHaveLength(4);
	for (const outcome of w.boundOutcomes) expect(outcome.ok).toBe(false);
	expect(w.boundOutcomes[0]?.text).toContain("16000 characters");
	expect(w.boundOutcomes[1]?.text).toContain("50-rule bound");
	expect(w.boundOutcomes[2]?.text).toContain("40-claim bound");
	expect(w.boundOutcomes[3]?.text).toContain("batch limit");
	expect(w.callsAfterBounds).toBe(0);
});

then("no prefix is reviewed as though it were the whole artifact", value => {
	const w = world(value);
	expect(w.reviewsAfterBounds).toBe(0);
	for (const outcome of w.boundOutcomes) {
		expect(outcome.details?.["kind"]).toBe("invalid");
		expect(outcome.text).toContain("nothing was judged and no finding is recorded");
	}
});

then("a multi-part artifact is complete only when every declared part at the current content is reviewed", value => {
	const w = world(value);
	expect(w.statuses[0]?.complete).toBe(false);
	expect(w.statuses[0]?.missing).toEqual([2]);
	expect(w.statuses[1]?.complete).toBe(true);
	expect(w.statuses[1]?.missing).toEqual([]);
});

// Scenario 13 --------------------------------------------------------------

given("a review records a finding", async value => {
	const w = setup(value);
	external(w);
	quiet(w);
	w.table.claim_1 = { label: "refuted", confidence: 0.95 };
	const outcome = await run(w, submission({ claims: [refutedClaim("claim-1")], inferences: [] }));
	const finding = findingByKind(outcome, "contradicted_claim");
	expect(finding).toBeDefined();
});

when("the same artifact, language, register and rules are reviewed again", async value => {
	const w = setup(value);
	const first = findingByKind(w.outcome, "contradicted_claim");
	const firstId = String(first?.["id"]);
	const firstDigest = w.state.antiSlopReviews[0]?.partDigest;
	const second = await run(w, w.params);
	const secondId = String(findingByKind(second, "contradicted_claim")?.["id"]);
	w.stableIds = [firstId, secondId];

	const changedArtifact = `${ARTIFACT} The supplier also insures the shipment.`;
	const third = await run(
		w,
		submission({ artifact: changedArtifact, claims: [refutedClaim("claim-1")], inferences: [] }),
	);
	const thirdId = String(findingByKind(third, "contradicted_claim")?.["id"]);
	const afterArtifact = w.state.antiSlopReviews[0];
	w.invalidations.push({
		oldId: secondId,
		newId: thirdId,
		before: firstDigest,
		after: afterArtifact?.partDigest,
	});

	const fourth = await run(
		w,
		submission({ language: "French", claims: [refutedClaim("claim-1")], inferences: [] }),
	);
	const fourthId = String(findingByKind(fourth, "contradicted_claim")?.["id"]);
	const afterLanguage = w.state.antiSlopReviews[0];
	w.invalidations.push({
		oldId: thirdId,
		newId: fourthId,
		before: afterArtifact?.language,
		after: afterLanguage?.language,
	});

	const fifth = await run(
		w,
		submission({
			rules: [{ class: "register", rule: "Avoid contractions.", severity: "warning" }],
			claims: [refutedClaim("claim-1")],
			inferences: [],
		}),
	);
	const fifthId = String(findingByKind(fifth, "contradicted_claim")?.["id"]);
	const afterRules = w.state.antiSlopReviews[0];
	w.invalidations.push({
		oldId: fourthId,
		newId: fifthId,
		before: afterLanguage?.rulesDigest,
		after: afterRules?.rulesDigest,
	});

	const other = freshState();
	registerTask(other, "Another external deliverable", true);
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	const clean = await antiSlop(
		{ judge: getFake(w).judge, config: w.config },
		other,
		submission({ claims: [CLAIM], inferences: [] }),
	);
	expect(clean.ok).toBe(true);
	const scope = antiSlopScope(other)!;
	const sameTask = antiSlopStatus(other, scope).complete;
	const otherTask = antiSlopStatus(other, { ...scope, taskFingerprint: "a-different-task" }).complete;
	recordAction(other, { tool: "write", target: "memo.md", excerpt: "wrote the memo" });
	const otherRevision = antiSlopStatus(other, antiSlopScope(other)!).complete;
	w.crossScope = { sameTask, otherTask, otherRevision };
});

then("the finding id is stable", value => {
	const w = world(value);
	expect(w.stableIds[0]).toBe(w.stableIds[1]);
	expect(typeof w.stableIds[0]).toBe("string");
	expect(w.stableIds[0]?.length).toBeGreaterThan(0);
});

then("a changed artifact, language or rule set invalidates the earlier review", value => {
	const w = world(value);
	expect(w.invalidations).toHaveLength(3);
	for (const entry of w.invalidations) {
		expect(entry.newId).not.toBe(entry.oldId);
		expect(entry.after).not.toEqual(entry.before);
		expect(JSON.stringify(w.state.antiSlopReviews)).not.toContain(entry.oldId);
	}
	expect(w.state.antiSlopReviews).toHaveLength(1);
});

then("a review cannot approve a different task or work revision", value => {
	const w = world(value);
	expect(w.crossScope?.sameTask).toBe(true);
	expect(w.crossScope?.otherTask).toBe(false);
	expect(w.crossScope?.otherRevision).toBe(false);
});

// Scenario 14 --------------------------------------------------------------

given("the judge is unavailable or an answer falls below the anti-slop floor", value => {
	const w = setup(value);
	external(w);
	w.params = submission({ claims: [CLAIM], inferences: [INFERENCE] });
});

when("the review result is returned", async value => {
	const w = setup(value);
	const unavailable = await antiSlop({ judge: failingJudge("offline"), config: w.config }, w.state, w.params);
	w.attempts.push(unavailable);
	quiet(w);
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	w.table.inference_1 = { label: "follows", confidence: 0.5 };
	const belowFloor = await antiSlop(deps(w), w.state, w.params);
	w.attempts.push(belowFloor);
});

then("no review part is recorded as complete", value => {
	const w = world(value);
	expect(w.state.antiSlopReviews).toHaveLength(0);
	const scope = antiSlopScope(w.state);
	expect(scope).toBeDefined();
	expect(antiSlopStatus(w.state, scope!).complete).toBe(false);
});

then("affected claims and inferences remain unverified", value => {
	const w = world(value);
	expect(w.attempts[0]?.text).toContain("No judge decision exists");
	expect(w.attempts[1]?.text).toContain("inconclusive");
	expect(w.attempts[1]?.details?.["uncertain"]).toEqual(
		expect.arrayContaining([expect.stringContaining("inference inference-1")]),
	);
	expect(listOf(detailsOf(w.attempts[1]), "claims")).toHaveLength(0);
	const inferences = listOf(detailsOf(w.attempts[1]), "inferences");
	expect(inferences).toHaveLength(1);
	expect(inferences[0]?.["trust"]).toBe("unverified");
	expect(inferences[0]?.["status"]).toBe("unresolved");
});

then("no trusted mark is manufactured", value => {
	const w = world(value);
	for (const outcome of w.attempts) {
		expect(outcome.ok).toBe(false);
		expect(detailsOf(outcome)["approved"]).not.toBe(true);
		expect(outcome.text).not.toContain("trusted");
	}
	expect(w.state.antiSlopReviews).toHaveLength(0);
});

then("ordinary work and completion are not held", value => {
	const w = world(value);
	expect(w.state.hold).toBeUndefined();
	expect(w.state.completion).toBeUndefined();
	expect(w.config.antiSlop.mode).toBe("advisory");
});

// Scenario 15 --------------------------------------------------------------

given("a multi-part review has an accepted part at revision 4", async value => {
	const w = setup(value);
	external(w);
	for (let index = 0; index < 4; index += 1) {
		recordAction(w.state, { tool: "write", target: `memo-${index + 1}.md`, excerpt: "memo" });
	}
	expect(w.state.revision).toBe(4);
	quiet(w);
	w.table.claim_1 = { label: "refuted", confidence: 0.95 };
	const partOne = await run(
		w,
		submission({ claims: [refutedClaim("claim-1")], inferences: [], part: { index: 1, total: 2 } }),
	);
	expect(partOne.ok).toBe(true);
	const firstRecord = w.state.antiSlopReviews.find(review => review.part.index === 1);
	w.partOneDigest = firstRecord?.partDigest;
	w.oldPartOneFinding = String(findingByKind(partOne, "contradicted_claim")?.["id"]);

	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	const partTwo = await run(
		w,
		submission({
			artifact: `${ARTIFACT} Delivery is monitored weekly.`,
			claims: [CLAIM],
			inferences: [],
			part: { index: 2, total: 2 },
		}),
	);
	expect(partTwo.ok).toBe(true);
	const secondRecord = w.state.antiSlopReviews.find(review => review.part.index === 2);
	w.partTwoDigest = secondRecord?.partDigest;
});

when("one part is submitted again with changed artifact bytes", async value => {
	const w = setup(value);
	const changed = `${ARTIFACT} The supplier also insures the shipment.`;
	w.table.claim_1 = { label: "refuted", confidence: 0.95 };
	const outcome = await run(
		w,
		submission({ artifact: changed, claims: [refutedClaim("claim-1")], inferences: [], part: { index: 1, total: 2 } }),
	);
	w.afterPartOneDigest = sha256(changed);
	w.newPartOneFinding = String(findingByKind(outcome, "contradicted_claim")?.["id"]);
});

then("the changed part replaces its earlier review record", value => {
	const w = world(value);
	const partOnes = w.state.antiSlopReviews.filter(review => review.part.index === 1);
	expect(partOnes).toHaveLength(1);
	expect(partOnes[0]?.partDigest).toBe(w.afterPartOneDigest);
	expect(partOnes[0]?.partDigest).not.toBe(w.partOneDigest);
	expect(partOnes[0]?.part).toEqual({ index: 1, total: 2 });
});

then("unrelated parts remain recorded", value => {
	const w = world(value);
	const partTwos = w.state.antiSlopReviews.filter(review => review.part.index === 2);
	expect(partTwos).toHaveLength(1);
	expect(partTwos[0]?.partDigest).toBe(w.partTwoDigest);
});

then("the changed part cannot inherit the earlier content's findings", value => {
	const w = world(value);
	expect(w.newPartOneFinding).not.toBe(w.oldPartOneFinding);
	expect(JSON.stringify(w.state.antiSlopReviews)).not.toContain(w.oldPartOneFinding ?? "");
});

// Scenario 16 --------------------------------------------------------------

given("the review records a blocker finding", async value => {
	const w = setup(value);
	external(w);
	quiet(w);
	w.table.claim_1 = { label: "refuted", confidence: 0.95 };
	const outcome = await run(w, submission({ claims: [refutedClaim("claim-1")], inferences: [] }));
	const blocker = findingsOf(outcome).find(finding => finding["severity"] === "blocker");
	expect(blocker).toBeDefined();
	w.findingIds = [String(blocker?.["id"])];
	const pi = fakePi();
	createJevController({ judge: answeringJudge({}).judge, config: boundaryConfig(), zod: fakeZod() }).register(pi.api);
	w.pi = pi;
	w.commandNames = [...pi.commands.keys()];
	w.toolNames = [...pi.tools.keys()];
});

when("the executor reports it", value => {
	const w = setup(value);
	const id = w.findingIds[0] ?? "";
	w.reportText = w.outcome?.text ?? "";
	queueOwnerMessage(w.state, `I acknowledge the anti-slop finding ${id}.`);
});

then("the finding remains a diagnostic record", value => {
	const w = world(value);
	const id = w.findingIds[0] ?? "";
	const located = findAntiSlopFinding(w.state, id);
	expect(located).toBeDefined();
	expect(located?.finding.id).toBe(id);
	expect(w.state.antiSlopReviews).toHaveLength(1);
	expect(w.state.hold).toBeUndefined();
	expect(w.reportText).toContain(id);
});

then("no /jev-waive, repair permit or finding-resolution command is available", value => {
	const w = world(value);
	const resolution = /waive|repair|resolv|permit/iu;
	for (const name of w.commandNames) expect(name).not.toMatch(resolution);
	for (const name of w.toolNames) expect(name).not.toMatch(resolution);
	expect(w.commandNames).toEqual(expect.arrayContaining(["jev", "jev-status"]));
	expect(w.reportText ?? "").not.toContain("/jev-");
});

then("no result asks the owner to waive the finding before work continues", value => {
	const w = world(value);
	expect(w.outcome?.text ?? "").not.toMatch(/waive/iu);
	expect(w.outcome?.text ?? "").not.toMatch(/owner (?:must|should) (?:approve|acknowledge)/iu);
});

then("owner acknowledgement, if any, does not become Jev approval", value => {
	const w = world(value);
	const id = w.findingIds[0] ?? "";
	expect(w.state.ownerMessages.some(message => message.includes(id))).toBe(true);
	expect(w.state.completion).toBeUndefined();
	expect(w.state.acceptance).toEqual([]);
	expect(w.state.plan).toBeUndefined();
	const scope = antiSlopScope(w.state);
	expect(scope).toBeDefined();
	const status = antiSlopStatus(w.state, scope!);
	expect(status.blockers.map(finding => finding.id)).toContain(id);
	expect(w.outcome?.details?.["approved"]).not.toBe(true);
});

// Scenario 17 --------------------------------------------------------------

given("a strict run is authorized for a publication effect", value => {
	const w = setup(value);
	external(w);
	w.state.autonomous = true;
	w.state.plan = {
		taskFingerprint: w.state.task?.fingerprint ?? "",
		planUrl: "local://memo-plan.md",
		planDigest: "plan-digest",
	};
	w.state.planTopics = [
		{ id: "deliver", section: "# Deliver the memo", paths: ["memo.md"], requirement: REQUEST },
	];
});

given("the exact artifact bytes have a current review", async value => {
	const w = setup(value);
	quiet(w);
	w.table.claim_1 = { label: "supported", confidence: 0.95 };
	const reviewed = await run(w, submission({ claims: [CLAIM], inferences: [] }));
	expect(reviewed.ok).toBe(true);
	const scope = antiSlopScope(w.state);
	expect(scope).toBeDefined();
	expect(antiSlopStatus(w.state, scope!).complete).toBe(true);
	const record = w.state.antiSlopReviews[0];
	expect(record?.artifact).toBe(ARTIFACT);
	w.reviewDigest = record?.partDigest;
	expect(w.reviewDigest).toBe(sha256(ARTIFACT));
});

when("a delivery invocation is admitted", async value => {
	const w = setup(value);
	const table: Record<string, FakeAnswerSource> = {
		action: { label: "on_course", confidence: 0.99 },
		within_authority: { probability: 0.99 },
		external_delivery: { label: "delivers", confidence: 0.99 },
		reviewed_delivery: { probability: 0.99 },
	};
	const admitted = await actionCheck(
		{ judge: answeringJudge(table).judge, config: w.config },
		w.state,
		{ tool: "send_email", target: "the client", change: ARTIFACT, callId: "deliver-reviewed" },
	);
	table.within_authority = { probability: 0.01 };
	const outside = await actionCheck(
		{ judge: answeringJudge(table).judge, config: w.config },
		structuredClone(w.state),
		{ tool: "send_email", target: "the client", change: ARTIFACT, callId: "deliver-outside-authority" },
	);
	table.within_authority = { probability: 0.99 };
	table.reviewed_delivery = { probability: 0.01 };
	const changed = await actionCheck(
		{ judge: answeringJudge(table).judge, config: w.config },
		w.state,
		{
			tool: "send_email",
			target: "the client",
			change: `${ARTIFACT} An unreviewed addition.`,
			callId: "deliver-changed-bytes",
		},
	);
	w.strict = { admitted, outside, changed };
});

then("the supervisor's policy and containment decide admission", value => {
	const w = world(value);
	expect(w.strict?.admitted.details?.["approved"]).toBe(true);
	expect(w.strict?.admitted.details?.["withinAuthority"]).toBe(true);
	expect(w.strict?.outside.details?.["approved"]).toBe(false);
	expect(w.strict?.outside.details?.["withinAuthority"]).toBe(false);
	const scope = antiSlopScope(w.state);
	expect(antiSlopStatus(w.state, scope!).complete).toBe(true);
});

then("the delivered bytes must match the reviewed bytes", value => {
	const w = world(value);
	expect(w.strict?.admitted.details?.["antiSlopDelivery"]).toBe(true);
	expect(w.strict?.changed.details?.["approved"]).toBe(false);
	expect(w.strict?.changed.details?.["kind"]).toBe("unclear");
	expect(w.strict?.changed.details?.["antiSlopRequired"]).toBe(true);
	expect(w.state.antiSlopReviews[0]?.partDigest).toBe(w.reviewDigest);
});

then("Jev findings remain diagnostic evidence rather than a delivery permission", value => {
	const w = world(value);
	expect(w.outcome?.details?.["approved"]).toBeUndefined();
	expect(w.outcome?.text ?? "").not.toMatch(/permission|approval/iu);
	expect(detailsOf(w.outcome)["blocked"]).toBe(false);
	expect(w.state.hold).toBeUndefined();
	expect(w.state.completion).toBeUndefined();
});
