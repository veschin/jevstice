import { describe, expect, test } from "bun:test";
import { actionCheck, antiSlop, triage } from "../src/activities.js";
import { completionGate } from "../src/gates.js";
import {
	antiSlopStatus,
	freshState,
	recordAcceptance,
	recordAction,
	recordAntiSlopReview,
	recordAntiSlopWaiver,
	registerSimple,
	registerTask,
	type JevState,
} from "../src/state.js";
import type { JevConfig } from "../src/types.js";
import {
	answeringJudge,
	boundaryConfig,
	failingJudge,
	toolDetails,
	type FakeAnswerSource,
} from "./helpers.js";

const REQUEST = "Write the legal memo";
const ARTIFACT = [
	"The agreement takes effect on 1 January 2027.",
	"The supplier must deliver within 30 days.",
	"The supplier is therefore liable for delay.",
].join(" ");

function config(mode: "off" | "advisory" | "enforce" = "advisory"): JevConfig {
	return { ...boundaryConfig(), antiSlop: { mode } };
}

function depsFor(table: Record<string, FakeAnswerSource>, mode: "off" | "advisory" | "enforce" = "advisory") {
	const fake = answeringJudge(table);
	return { deps: { judge: fake.judge, config: config(mode) }, calls: fake.calls };
}

function externalState(): JevState {
	const state = freshState();
	state.request = { text: REQUEST, weight: "judged" };
	registerTask(state, REQUEST, true);
	return state;
}

/** Fragment answers for one clean paragraph and one owner rule. */
const CLEAN_FRAGMENT: Record<string, FakeAnswerSource> = {
	language_1: { probability: 0.05 },
	meta_1: { probability: 0.05 },
	relevance_1: { label: "serves", confidence: 0.95 },
	rule_1_1: { probability: 0.05 },
};

const CLAIM_1 = {
	id: "claim-1",
	text: "The agreement takes effect on 1 January 2027.",
	kind: "fact" as const,
	evidence: [
		{ kind: "documentation", quote: "Commencement: 1 January 2027.", source: "contract", sourceClass: "official" },
	],
};
const CLAIM_2 = {
	id: "claim-2",
	text: "The supplier must deliver within 30 days.",
	kind: "fact" as const,
	evidence: [
		{ kind: "documentation", quote: "Delivery is due within 14 days.", source: "contract", sourceClass: "official" },
	],
};
const INFERENCE = {
	id: "inf-1",
	premises: [CLAIM_2.text],
	warrant: "A delivery deadline creates liability for delay.",
	conclusion: "The supplier is therefore liable for delay.",
};

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		artifact: ARTIFACT,
		language: "en",
		register: "formal legal English",
		purpose: "supplier agreement",
		audience: "external",
		rules: [{ class: "register", rule: "Use formal legal English." }],
		claims: [CLAIM_1, CLAIM_2],
		inferences: [INFERENCE],
		...overrides,
	};
}

describe("FR-46 - validation happens before a judge call", () => {
	test("a claim outside the artifact is refused without a judge call", async () => {
		const state = externalState();
		const { deps, calls } = depsFor({});
		const outcome = await antiSlop(
			deps,
			state,
			params({
				claims: [{ ...CLAIM_1, text: "A sentence that is not in the artifact." }],
				inferences: [],
			}),
		);

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("verbatim");
		expect(calls).toHaveLength(0);
		expect(state.antiSlopReviews).toHaveLength(0);
	});

	test("an unknown source class is refused without a judge call", async () => {
		const state = externalState();
		const { deps, calls } = depsFor({});
		const outcome = await antiSlop(
			deps,
			state,
			params({
				claims: [
					{
						...CLAIM_1,
						evidence: [{ ...CLAIM_1.evidence[0], sourceClass: "blog" }],
					},
				],
				inferences: [],
			}),
		);

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("sourceClass");
		expect(calls).toHaveLength(0);
	});

	test("an internal task cannot run the review", async () => {
		const state = freshState();
		state.request = { text: "Change the parser", weight: "judged" };
		registerTask(state, "Change the parser", false);
		const { deps, calls } = depsFor({});

		const outcome = await antiSlop(deps, state, params({ claims: [CLAIM_1], inferences: [] }));
		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("external deliverable");
		expect(calls).toHaveLength(0);
	});
});

describe("FR-47, FR-48 - claim verification and explicit trust marks", () => {
	test("a supported claim is trusted and a refuted claim is a blocker finding", async () => {
		const state = externalState();
		const { deps, calls } = depsFor({
			claim_1: { label: "supported", confidence: 0.95 },
			claim_2: { label: "refuted", confidence: 0.95 },
			inference_1: { label: "follows", confidence: 0.95 },
			...CLEAN_FRAGMENT,
		});

		const outcome = await antiSlop(deps, state, params());
		if (!outcome.ok) throw new Error(outcome.text);
		const claims = outcome.details["claims"] as Array<Record<string, unknown>>;
		const findings = outcome.details["findings"] as Array<Record<string, unknown>>;

		expect(claims.find(claim => claim["id"] === "claim-1")?.["trust"]).toBe("trusted");
		expect(claims.find(claim => claim["id"] === "claim-2")?.["trust"]).toBe("distrusted");
		expect(
			findings.some(
				finding =>
					finding["kind"] === "contradicted_claim" &&
					finding["severity"] === "blocker" &&
					finding["target"] === "claim-2",
			),
		).toBe(true);
		expect(outcome.details["blockers"]).toBe(1);
		expect(state.antiSlopReviews).toHaveLength(1);
		expect(outcome.text).toContain("claim-1 trusted supported");
		expect(outcome.text).toContain("contradicted_claim");
		expect(calls[0]?.questions.some(question => question.name === "claim_1")).toBe(true);
	});
});

describe("FR-51, FR-52 - language, register, meta-text and relevance findings", () => {
	test("each fragment defect is named with its submitted rule and severity", async () => {
		const state = externalState();
		const { deps } = depsFor({
			claim_1: { label: "supported", confidence: 0.95 },
			language_1: { probability: 0.95 },
			meta_1: { probability: 0.95 },
			relevance_1: { label: "repeats", confidence: 0.95 },
			rule_1_1: { probability: 0.95 },
		});

		const outcome = await antiSlop(deps, state, params({ claims: [CLAIM_1], inferences: [] }));
		if (!outcome.ok) throw new Error(outcome.text);
		const findings = outcome.details["findings"] as Array<Record<string, unknown>>;
		const kinds = findings.map(finding => finding["kind"]);

		expect(kinds).toContain("language_mismatch");
		expect(kinds).toContain("meta_text");
		expect(kinds).toContain("redundant_material");
		expect(kinds).toContain("register_violation");
		expect(findings.find(finding => finding["kind"] === "language_mismatch")?.["severity"]).toBe("blocker");
		expect(findings.find(finding => finding["kind"] === "meta_text")?.["severity"]).toBe("blocker");
		expect(findings.find(finding => finding["kind"] === "redundant_material")?.["severity"]).toBe("warning");
		expect(findings.find(finding => finding["kind"] === "register_violation")?.["rule"]).toBe(
			"Use formal legal English.",
		);
		expect(outcome.details["blockers"]).toBe(2);
		expect(outcome.details["warnings"]).toBe(2);
	});
});

describe("FR-48 - weak sources and inconclusive judgments are marked, not trusted", () => {
	test("a supported claim on an anonymous source is low_trust and an unsettled claim is unverified", async () => {
		const state = externalState();
		const { deps } = depsFor({
			claim_1: { label: "supported", confidence: 0.95 },
			claim_2: { label: "not_enough_info", confidence: 0.95 },
			...CLEAN_FRAGMENT,
		});
		const weak = {
			...CLAIM_1,
			evidence: [{ ...CLAIM_1.evidence[0], sourceClass: "anonymous" as const }],
		};

		const outcome = await antiSlop(deps, state, params({ claims: [weak, CLAIM_2], inferences: [] }));
		if (!outcome.ok) throw new Error(outcome.text);
		const claims = outcome.details["claims"] as Array<Record<string, unknown>>;
		const findings = outcome.details["findings"] as Array<Record<string, unknown>>;

		expect(claims.find(claim => claim["id"] === "claim-1")?.["trust"]).toBe("low_trust");
		expect(claims.find(claim => claim["id"] === "claim-2")?.["trust"]).toBe("unverified");
		expect(findings.some(finding => finding["kind"] === "low_trust_source")).toBe(true);
		expect(findings.some(finding => finding["kind"] === "unverified_claim")).toBe(true);
		expect(outcome.details["blocked"]).toBe(false);
		expect(outcome.details["warnings"]).toBe(2);
	});
});

describe("FR-50 - a hypothesis needs an observable falsifier", () => {
	const HYPOTHESIS = {
		...CLAIM_1,
		kind: "hypothesis" as const,
		falsifier: "A court voids the agreement before 1 January 2027.",
	};

	test("a rejected falsifier is an unfalsifiable blocker whatever the claim verdict says", async () => {
		const state = externalState();
		const { deps } = depsFor({
			falsifiable_1: { probability: 0.05 },
			claim_1: { label: "supported", confidence: 0.95 },
			...CLEAN_FRAGMENT,
		});
		const outcome = await antiSlop(deps, state, params({ claims: [HYPOTHESIS], inferences: [] }));
		if (!outcome.ok) throw new Error(outcome.text);
		const claims = outcome.details["claims"] as Array<Record<string, unknown>>;
		const findings = outcome.details["findings"] as Array<Record<string, unknown>>;

		expect(claims[0]?.["trust"]).toBe("distrusted");
		expect(findings.some(finding => finding["kind"] === "unfalsifiable_hypothesis")).toBe(true);
	});

	test("an accepted falsifier passes to the claim verdict", async () => {
		const state = externalState();
		const { deps } = depsFor({
			falsifiable_1: { probability: 0.95 },
			claim_1: { label: "supported", confidence: 0.95 },
			...CLEAN_FRAGMENT,
		});
		const outcome = await antiSlop(deps, state, params({ claims: [HYPOTHESIS], inferences: [] }));
		if (!outcome.ok) throw new Error(outcome.text);
		const claims = outcome.details["claims"] as Array<Record<string, unknown>>;

		expect(claims[0]?.["trust"]).toBe("trusted");
		expect(outcome.details["blockers"]).toBe(0);
	});
});

describe("FR-47, FR-50 - missing evidence and missing falsifier need no claim question", () => {
	test("an unsupported fact and an unfalsifiable hypothesis are distrusted without their own judge question", async () => {
		const state = externalState();
		const { deps, calls } = depsFor(CLEAN_FRAGMENT);
		const outcome = await antiSlop(
			deps,
			state,
			params({
				claims: [
					{ id: "fact-no-evidence", text: CLAIM_2.text, kind: "fact", evidence: [] },
					{ id: "hyp-no-falsifier", text: CLAIM_1.text, kind: "hypothesis", evidence: [] },
				],
				inferences: [],
			}),
		);
		if (!outcome.ok) throw new Error(outcome.text);
		const claims = outcome.details["claims"] as Array<Record<string, unknown>>;
		const findings = outcome.details["findings"] as Array<Record<string, unknown>>;
		const names = calls[0]?.questions.map(question => question.name) ?? [];

		expect(claims.find(claim => claim["id"] === "fact-no-evidence")?.["trust"]).toBe("distrusted");
		expect(claims.find(claim => claim["id"] === "hyp-no-falsifier")?.["trust"]).toBe("distrusted");
		expect(findings.some(finding => finding["kind"] === "unsupported_claim")).toBe(true);
		expect(findings.some(finding => finding["kind"] === "unfalsifiable_hypothesis")).toBe(true);
		expect(names).not.toContain("claim_1");
		expect(names).not.toContain("claim_2");
		expect(names).not.toContain("falsifiable_2");
	});
});

describe("FR-56 - fail-closed and part coverage", () => {
	test("off refuses without a judge call while a quiet external publication is reviewable", async () => {
		const quiet = freshState();
		quiet.request = { text: "Send the legal memo to the client", weight: "quiet" };
		const off = depsFor(CLEAN_FRAGMENT, "off");
		const refused = await antiSlop(off.deps, quiet, params({ claims: [CLAIM_1], inferences: [] }));
		expect(refused.ok).toBe(false);
		expect(off.calls).toHaveLength(0);

		const advisory = depsFor({ claim_1: { label: "supported", confidence: 0.95 }, ...CLEAN_FRAGMENT });
		const reviewed = await antiSlop(advisory.deps, quiet, params({ claims: [CLAIM_1], inferences: [] }));
		expect(reviewed.ok).toBe(true);
		expect(quiet.antiSlopReviews[0]?.taskFingerprint).toBeUndefined();
	});

	test("a judge failure records no review and no trusted mark", async () => {
		const state = externalState();
		const deps = { judge: failingJudge("offline"), config: config("enforce") };
		const outcome = await antiSlop(deps, state, params());

		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("unusable");
		expect(state.antiSlopReviews).toHaveLength(0);
	});

	test("the latest part total owns coverage and a missing part keeps the review incomplete", () => {
		const state = externalState();
		recordAction(state, { tool: "write", target: "memo.md", excerpt: "memo" });
		const base = {
			taskFingerprint: state.task?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			partDigest: "d",
			language: "en",
			register: "formal",
			rulesDigest: "r",
			mode: "enforce" as const,
			claims: [],
			inferences: [],
			findings: [],
		};
		recordAntiSlopReview(state, { ...base, part: { index: 1, total: 2 } });
		const partial = antiSlopStatus(state, {
			taskFingerprint: state.task?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			quiet: false,
		});
		expect(partial.complete).toBe(false);
		expect(partial.missing).toEqual([2]);

		recordAntiSlopReview(state, { ...base, part: { index: 2, total: 2 } });
		const complete = antiSlopStatus(state, {
			taskFingerprint: state.task?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			quiet: false,
		});
		expect(complete.complete).toBe(true);
		expect(complete.missing).toEqual([]);

		recordAntiSlopReview(state, { ...base, part: { index: 2, total: 2 }, language: "fr" });
		const inconsistent = antiSlopStatus(state, {
			taskFingerprint: state.task?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			quiet: false,
		});
		expect(inconsistent.inconsistent).toBe(true);
		expect(inconsistent.complete).toBe(false);
	});
});

describe("FR-55 - enforcement, waiver and advisory default", () => {
	function acceptedState(): JevState {
		const state = externalState();
		recordAction(state, { tool: "write", target: "memo.md", excerpt: "memo" });
		recordAcceptance(state, {
			aspect: "business",
			revision: state.revision,
			label: "serves_business_need",
			approved: true,
			confidence: 0.9,
		});
		recordAcceptance(state, {
			aspect: "architecture",
			revision: state.revision,
			label: "sound_for_next_change",
			approved: true,
			confidence: 0.9,
		});
		return state;
	}

	test("enforce holds completion without a review, and a blocker holds it until the owner waives it", async () => {
		const state = acceptedState();
		const missing = completionGate(state, config("enforce"));
		expect(missing.applies).toBe(true);
		expect(missing.reason).toContain("anti-slop");

		const { deps } = depsFor(
			{
				claim_1: { label: "refuted", confidence: 0.95 },
				...CLEAN_FRAGMENT,
			},
			"enforce",
		);
		const outcome = await antiSlop(
			deps,
			state,
			params({
				claims: [CLAIM_2],
				inferences: [],
			}),
		);
		if (!outcome.ok) throw new Error(outcome.text);
		const finding = (outcome.details["findings"] as Array<Record<string, unknown>>).find(
			entry => entry["severity"] === "blocker",
		);
		const findingId = finding?.["id"];
		expect(typeof findingId).toBe("string");

		const blocked = completionGate(state, config("enforce"));
		expect(blocked.reason).toContain(String(findingId));

		recordAntiSlopWaiver(state, { findingId: String(findingId), reason: "owner accepted the risk" });
		const waived = completionGate(state, config("enforce"));
		expect(waived.reason ?? "").not.toContain("anti-slop");
	});

	test("enforce holds a simple external completion until the review exists", () => {
		const state = freshState();
		state.request = { text: REQUEST, weight: "judged" };
		registerSimple(state, REQUEST, true);

		const missing = completionGate(state, config("enforce"));
		expect(missing.applies).toBe(true);
		expect(missing.reason).toContain("anti-slop");

		recordAntiSlopReview(state, {
			taskFingerprint: state.simple?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			part: { index: 1, total: 1 },
			partDigest: "d",
			language: "en",
			register: "formal",
			rulesDigest: "r",
			mode: "enforce",
			claims: [],
			inferences: [],
			findings: [],
		});
		expect(completionGate(state, config("enforce")).applies).toBe(false);
	});

	test("advisory reports the finding without holding completion", async () => {
		const state = acceptedState();
		const { deps } = depsFor({
			claim_1: { label: "refuted", confidence: 0.95 },
			...CLEAN_FRAGMENT,
		});
		const outcome = await antiSlop(deps, state, params({ claims: [CLAIM_2], inferences: [] }));
		if (!outcome.ok) throw new Error(outcome.text);

		const gate = completionGate(state, config("advisory"));
		expect(gate.reason ?? "").not.toContain("anti-slop");
	});
});

describe("FR-55 - an external delivery waits for a complete review", () => {
	test("a delivery invocation is refused without a review and admitted after one", async () => {
		const state = externalState();
		recordAction(state, { tool: "write", target: "memo.md", excerpt: "memo" });
		state.plan = {
			taskFingerprint: state.task?.fingerprint ?? "",
			planUrl: "local://memo-plan.md",
			planDigest: "d",
			confidence: 0.9,
		};
		state.planTopics = [
			{
				id: "write",
				section: "# memo",
				paths: ["memo.md"],
				requirement: "write the memo",
			},
		];
		const { deps } = depsFor(
			{
				action: { label: "on_course", confidence: 0.95 },
				external_delivery: { label: "delivers", confidence: 0.95 },
			},
			"enforce",
		);

		const withoutReview = await actionCheck(deps, state, {
			tool: "write",
			target: "memo.md",
			change: "memo",
		});
		expect(withoutReview.ok).toBe(true);
		expect(toolDetails(withoutReview)["approved"]).toBe(false);
		expect(toolDetails(withoutReview)["antiSlopRequired"]).toBe(true);

		const local = depsFor(
			{
				action: { label: "on_course", confidence: 0.95 },
				external_delivery: { label: "does_not_deliver", confidence: 0.95 },
			},
			"enforce",
		);
		const localWrite = await actionCheck(local.deps, state, {
			tool: "write",
			target: "memo.md",
			change: "memo",
		});
		expect(toolDetails(localWrite)["approved"]).toBe(true);
		expect(toolDetails(localWrite)["antiSlopDelivery"]).toBe(false);

		recordAntiSlopReview(state, {
			taskFingerprint: state.task?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			part: { index: 1, total: 1 },
			partDigest: "d",
			language: "en",
			register: "formal",
			rulesDigest: "r",
			mode: "enforce",
			claims: [],
			inferences: [],
			findings: [],
		});
		const withReview = await actionCheck(deps, state, {
			tool: "write",
			target: "memo.md",
			change: "memo",
		});
		expect(toolDetails(withReview)["approved"]).toBe(true);
		expect(toolDetails(withReview)["antiSlopDelivery"]).toBe(true);
	});
});

describe("FR-45 - triage records the external deliverable", () => {
	test("a document request is registered as external and an internal request is not", async () => {
		const external = depsFor({
			needs_development: { probability: 0.95 },
			external_deliverable: { probability: 0.95 },
		});
		const externalState = freshState();
		const externalOutcome = await triage(external.deps, externalState, { request: REQUEST });
		if (!externalOutcome.ok) throw new Error(externalOutcome.text);
		expect(externalOutcome.details["externalDeliverable"]).toBe(true);
		expect(externalState.task?.external).toBe(true);

		const internal = depsFor({
			needs_development: { probability: 0.95 },
			external_deliverable: { probability: 0.05 },
		});
		const internalState = freshState();
		const internalOutcome = await triage(internal.deps, internalState, { request: "Change the parser" });
		if (!internalOutcome.ok) throw new Error(internalOutcome.text);
		expect(internalOutcome.details["externalDeliverable"]).toBe(false);
		expect(internalState.task?.external).toBe(false);
	});
});
