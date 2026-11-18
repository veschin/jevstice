import { describe, expect, test } from "bun:test";
import { acceptance, actionCheck, antiSlop, courseCheck, observedOutcome, requirements, textReview, triage } from "../src/activities.js";
import {
	antiSlopStatus,
	diagnosticKind,
	freshState,
	recordAcceptance,
	recordAction,
	recordAntiSlopReview,
	registerSimple,
	registerTask,
	type JevState,
} from "../src/state.js";
import type { Judge } from "../src/judge.js";
import { asRecord, type Evidence, type JevConfig, type ToolOutcome } from "../src/types.js";
import {
	answeringJudge,
	boundaryConfig,
	cleanProtocolAnswers,
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

function config(mode: "off" | "advisory" = "advisory"): JevConfig {
	return { ...boundaryConfig(), antiSlop: { mode } };
}

function depsFor(table: Record<string, FakeAnswerSource>, mode: "off" | "advisory" = "advisory") {
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
	...cleanProtocolAnswers(),
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

interface SelectedProtocol {
	language: string;
	steps: string[];
	checks: Array<{ class: string; rule: string; repair: string }>;
}

/** The selected protocol attached to a successful or inconclusive review result. */
function selectedProtocol(outcome: ToolOutcome): SelectedProtocol {
	const protocol = asRecord(outcome.details?.["protocol"]);
	expect(protocol).toBeDefined();
	const language = protocol?.["language"];
	const steps = protocol?.["steps"];
	const checks = protocol?.["checks"];
	expect(language === "ru" || language === "en").toBe(true);
	expect(Array.isArray(steps)).toBe(true);
	expect(Array.isArray(checks)).toBe(true);
	return {
		language: language as string,
		steps: steps as string[],
		checks: checks as SelectedProtocol["checks"],
	};
}

/** The caller sees the selected numbered steps in order, including preservation guidance. */
function expectProtocolInText(outcome: ToolOutcome, protocol: SelectedProtocol): void {
	expect(protocol.steps.length).toBeGreaterThan(0);
	expect(
		protocol.steps.some(step => /(preserv|meaning|fact|negation|сохран|смысл|факт|отриц)/iu.test(step)),
	).toBe(true);
	let lastIndex = -1;
	for (const step of protocol.steps) {
		const index = outcome.text.indexOf(step);
		expect(index).toBeGreaterThan(-1);
		expect(index).toBeGreaterThan(lastIndex);
		lastIndex = index;
	}
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
		expect(calls).toHaveLength(0);
	});

	test("an internal task cannot run the review", async () => {
		const state = freshState();
		state.request = { text: "Change the parser", weight: "judged" };
		registerTask(state, "Change the parser", false);
		const { deps, calls } = depsFor({});

		const outcome = await antiSlop(deps, state, params({ claims: [CLAIM_1], inferences: [] }));
		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe("FR-51 - the built-in style protocol", () => {
	for (const [language, expected] of [
		["English", "en"],
		["Russian", "ru"],
		["Английский", "en"],
		["Русский", "ru"],
		["en-GB", "en"],
		["ru-RU", "ru"],
	] as const) {
		test(`${language} (${expected}) assertion-free artifact with no owner rules is accepted`, async () => {
			const state = externalState();
			const { deps, calls } = depsFor({
				...cleanProtocolAnswers(),
				language_1: { probability: 0.05 },
				meta_1: { probability: 0.05 },
				relevance_1: { label: "serves", confidence: 0.95 },
			});

			const outcome = await antiSlop(
				deps,
				state,
				params({
					artifact: expected === "ru" ? "Выберите файл, затем нажмите кнопку \"Проверить\"." : "Select the file, then press the \"Verify\" button.",
					language, rules: [], claims: [], inferences: [],
				}),
			);
			if (!outcome.ok) throw new Error(outcome.text);
			const protocol = selectedProtocol(outcome);

			expect(protocol.language).toBe(expected);
			expect(protocol.checks.map(check => check.class)).toEqual([
				"symbols",
				"wording",
				"syntax",
				"coherence",
			]);
			expect(calls[0]?.questions.map(question => question.name)).toEqual(
				expect.arrayContaining(["protocol_1_1", "protocol_1_2", "protocol_1_3", "protocol_1_4"]),
			);
			expect(outcome.details["findings"]).toEqual([]);
			expect(outcome.details["claims"]).toEqual([]);
			expect(outcome.details["inferences"]).toEqual([]);
			expect(outcome.text).toMatch(/does not verify factual assertions/i);
			expectProtocolInText(outcome, protocol);
			expect(state.antiSlopReviews).toHaveLength(1);
		});
	}

	test("a built-in style violation is a warning with the exact quote and repair", async () => {
		const state = externalState();
		const { deps, calls } = depsFor({
			...CLEAN_FRAGMENT,
			claim_1: { label: "supported", confidence: 0.95 },
			protocol_1_1: { probability: 0.95 },
		});

		const outcome = await antiSlop(
			deps,
			state,
			params({
				rules: [{ class: "register", rule: "Avoid contractions." }],
				claims: [CLAIM_1],
				inferences: [],
			}),
		);
		if (!outcome.ok) throw new Error(outcome.text);
		const protocol = selectedProtocol(outcome);
		const styleCheck = protocol.checks[0];
		const fragment = (outcome.details["fragments"] as string[])[0];
		const findings = outcome.details["findings"] as Array<Record<string, unknown>>;
		const finding = findings.find(
			entry => entry["kind"] === "register_violation" && entry["rule"] === styleCheck?.rule,
		);

		expect(styleCheck?.class).toBe("symbols");
		expect(finding).toBeDefined();
		expect(finding?.["severity"]).toBe("warning");
		expect(finding?.["target"]).toBe("fragment-1");
		expect(finding?.["quote"]).toBe(fragment);
		expect(finding?.["repair"]).toBe(styleCheck?.repair);
		expect(findings).toHaveLength(1);
		expect(outcome.text).toContain(String(finding?.["quote"]));
		expect(outcome.text).toContain(String(finding?.["repair"]));
		const names = calls[0]?.questions.map(question => question.name) ?? [];
		expect(names).toContain("protocol_1_1");
		expect(names).toContain("rule_1_1");
	});

	test("a claim finding carries the quoted material and a concrete repair", async () => {
		const state = externalState();
		const { deps } = depsFor({
			...CLEAN_FRAGMENT,
			claim_1: { label: "refuted", confidence: 0.95 },
		});

		const outcome = await antiSlop(deps, state, params({ claims: [CLAIM_1], inferences: [] }));
		if (!outcome.ok) throw new Error(outcome.text);
		const findings = outcome.details["findings"] as Array<Record<string, unknown>>;
		const finding = findings.find(entry => entry["kind"] === "contradicted_claim");

		expect(finding).toBeDefined();
		expect(finding?.["quote"]).toBe(CLAIM_1.text);
		expect(String(finding?.["repair"]).length).toBeGreaterThan(0);
		expect(outcome.text).toContain(String(finding?.["quote"]));
		expect(outcome.text).toContain(String(finding?.["repair"]));
	});

	test("an uncertain built-in style answer is inconclusive and still exposes the protocol", async () => {
		const state = externalState();
		const { deps } = depsFor({
			...CLEAN_FRAGMENT,
			protocol_1_3: { probability: 0.5 },
		});

		const outcome = await antiSlop(
			deps,
			state,
			params({ rules: [], claims: [], inferences: [] }),
		);

		expect(outcome.ok).toBe(false);
		expect(asRecord(outcome.details)?.["kind"]).toBe("unclear");
		expect(state.antiSlopReviews).toHaveLength(0);
		expect(outcome.text).toContain("inconclusive");
		expect(outcome.text).not.toContain("Outcome: clean");
		const protocol = selectedProtocol(outcome);
		expect(protocol.language).toBe("en");
		expectProtocolInText(outcome, protocol);
	});

	test("a missing built-in style answer cannot produce a clean review", async () => {
		const state = externalState();
		const table: Record<string, FakeAnswerSource> = { ...CLEAN_FRAGMENT };
		delete table["protocol_1_4"];
		const { deps } = depsFor(table);

		const outcome = await antiSlop(
			deps,
			state,
			params({ rules: [], claims: [], inferences: [] }),
		);

		expect(outcome.ok).toBe(false);
		expect(state.antiSlopReviews).toHaveLength(0);
		expect(outcome.text).not.toContain("Outcome: clean");
	});

	test("an unavailable judge cannot produce a clean style review", async () => {
		const state = externalState();
		const deps = { judge: failingJudge("offline"), config: config("advisory") };

		const outcome = await antiSlop(
			deps,
			state,
			params({ rules: [], claims: [], inferences: [] }),
		);

		expect(outcome.ok).toBe(false);
		expect(state.antiSlopReviews).toHaveLength(0);
		expect(outcome.text).not.toContain("Outcome: clean");
	});

	test("an unsupported language needs owner rules and selects no protocol", async () => {
		for (const language of ["French", "constructor", "__proto__"]) {
			const state = externalState();
			const withoutRules = depsFor({});
			const refused = await antiSlop(
				withoutRules.deps,
				state,
				params({ language, rules: [], claims: [], inferences: [] }),
			);

			expect(refused.ok).toBe(false);
			expect(withoutRules.calls).toHaveLength(0);
			expect(refused.text).toMatch(/rules?/i);
		}

		const acceptedState = externalState();
		const accepted = depsFor({
			language_1: { probability: 0.05 },
			meta_1: { probability: 0.05 },
			relevance_1: { label: "serves", confidence: 0.95 },
			rule_1_1: { probability: 0.05 },
		});
		const outcome = await antiSlop(
			accepted.deps,
			acceptedState,
			params({
				language: "French",
				rules: [{ class: "register", rule: "Écrire en français formel." }],
				claims: [],
				inferences: [],
			}),
		);
		if (!outcome.ok) throw new Error(outcome.text);

		expect(outcome.details["protocol"]).toBeNull();
		const names = accepted.calls[0]?.questions.map(question => question.name) ?? [];
		expect(names.some(name => name.startsWith("protocol_"))).toBe(false);
		expect(acceptedState.antiSlopReviews).toHaveLength(1);
	});

	test("a malformed supplied rule is still refused for a supported language", async () => {
		const state = externalState();
		const { deps, calls } = depsFor({});

		const outcome = await antiSlop(
			deps,
			state,
			params({ rules: [{ class: "", rule: "Use formal legal English." }] }),
		);

		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
		expect(outcome.text).toMatch(/class and rule line/i);
		expect(state.antiSlopReviews).toHaveLength(0);
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
		expect(calls[0]?.questions.some(question => question.name === "claim_1")).toBe(true);
	});
});

describe("FR-51, FR-52 - language, register, meta-text and relevance findings", () => {
	test("each fragment defect is named with its submitted rule and severity", async () => {
		const state = externalState();
		const { deps } = depsFor({
			...cleanProtocolAnswers(),
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
		const deps = { judge: failingJudge("offline"), config: config("advisory") };
		const outcome = await antiSlop(deps, state, params());

		expect(outcome.ok).toBe(false);
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

describe("FR-20, FR-21, FR-46, FR-53 - judgment recovery and review freshness", () => {
	test("an unavailable judgment does not block the same material from being judged again", async () => {
		const state = externalState();
		const fake = answeringJudge({
			claim_1: { label: "supported", confidence: 0.95 },
			claim_2: { label: "supported", confidence: 0.95 },
			inference_1: { label: "follows", confidence: 0.95 },
			...CLEAN_FRAGMENT,
		});
		let offline = true;
		let attempts = 0;
		const judge: Judge = async (material, questions) => {
			attempts += 1;
			return offline ? { ok: false, kind: "unavailable", problem: "offline" } : fake.judge(material, questions);
		};
		const deps = { judge, config: config("advisory") };
		const input = params();

		const first = await antiSlop(deps, state, input);
		expect(first.ok).toBe(false);
		expect(state.antiSlopReviews).toHaveLength(0);
		expect(state.submissions.filter(entry => entry.boundary.startsWith("anti-slop"))).toHaveLength(0);

		offline = false;
		const second = await antiSlop(deps, state, input);
		expect(second.ok).toBe(true);
		expect(attempts).toBe(2);
		expect(state.antiSlopReviews).toHaveLength(1);
	});

	test("a failed changed re-review removes only the affected part and keeps other scopes", async () => {
		const state = externalState();
		const clean = depsFor(
			{
				claim_1: { label: "supported", confidence: 0.95 },
				claim_2: { label: "supported", confidence: 0.95 },
				inference_1: { label: "follows", confidence: 0.95 },
				...CLEAN_FRAGMENT,
			},
			"advisory",
		);
		expect((await antiSlop(clean.deps, state, params({ part: { index: 1, total: 2 } }))).ok).toBe(true);
		expect((await antiSlop(clean.deps, state, params({ part: { index: 2, total: 2 } }))).ok).toBe(true);
		recordAntiSlopReview(state, {
			taskFingerprint: "other-task",
			request: "Another owner request",
			revision: state.revision,
			part: { index: 1, total: 2 },
			partDigest: "d",
			language: "en",
			register: "formal",
			rulesDigest: "r",
			findings: [],
		});
		const scope = {
			taskFingerprint: state.task?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			quiet: false,
		};
		expect(antiSlopStatus(state, scope).complete).toBe(true);

		const changed = `${ARTIFACT} The supplier also insures the shipment.`;
		const failing = { judge: failingJudge("offline"), config: config("advisory") };
		const failed = await antiSlop(failing, state, params({ artifact: changed, part: { index: 1, total: 2 } }));
		expect(failed.ok).toBe(false);

		const status = antiSlopStatus(state, scope);
		expect(status.complete).toBe(false);
		expect(status.missing).toEqual([1]);
		expect(state.antiSlopReviews.some(review => review.taskFingerprint === "other-task")).toBe(true);
		expect(
			state.antiSlopReviews.filter(
				review => review.taskFingerprint === state.task?.fingerprint && review.part.index === 2,
			),
		).toHaveLength(1);
	});

	test("changed claim evidence changes that finding id and leaves an unrelated finding id stable", async () => {
		const state = externalState();
		const { deps } = depsFor(
			{
				claim_1: { label: "refuted", confidence: 0.95 },
				claim_2: { label: "refuted", confidence: 0.95 },
				...CLEAN_FRAGMENT,
			},
			"advisory",
		);
		const first = await antiSlop(deps, state, params({ claims: [CLAIM_1, CLAIM_2], inferences: [] }));
		if (!first.ok) throw new Error(first.text);
		const firstFindings = first.details["findings"] as Array<Record<string, unknown>>;
		const firstClaim1 = firstFindings.find(
			finding => finding["target"] === "claim-1" && finding["kind"] === "contradicted_claim",
		);
		const firstClaim2 = firstFindings.find(
			finding => finding["target"] === "claim-2" && finding["kind"] === "contradicted_claim",
		);

		const changedClaim = {
			...CLAIM_1,
			evidence: [{ ...CLAIM_1.evidence[0], quote: "Commencement is 1 January 2027." }],
		};
		const second = await antiSlop(deps, state, params({ claims: [changedClaim, CLAIM_2], inferences: [] }));
		if (!second.ok) throw new Error(second.text);
		const secondFindings = second.details["findings"] as Array<Record<string, unknown>>;
		const secondClaim1 = secondFindings.find(
			finding => finding["target"] === "claim-1" && finding["kind"] === "contradicted_claim",
		);
		const secondClaim2 = secondFindings.find(
			finding => finding["target"] === "claim-2" && finding["kind"] === "contradicted_claim",
		);

		expect(typeof firstClaim1?.["id"]).toBe("string");
		expect(secondClaim1?.["id"]).not.toBe(firstClaim1?.["id"]);
		expect(secondClaim2?.["id"]).toBe(firstClaim2?.["id"]);
	});

	test("a quote identical to the claim is excluded from judgment and cannot make anonymous support trusted", async () => {
		const state = externalState();
		const selfClaim = {
			...CLAIM_1,
			evidence: [
				{ kind: "documentation", quote: CLAIM_1.text, source: "self", sourceClass: "official" },
				{
					kind: "documentation",
					quote: "Anonymous survey reports 72% agreement.",
					source: "survey",
					sourceClass: "anonymous",
				},
			],
		};
		const { deps, calls } = depsFor(
			{ claim_1: { label: "supported", confidence: 0.95 }, ...CLEAN_FRAGMENT },
			"advisory",
		);

		const outcome = await antiSlop(deps, state, params({ claims: [selfClaim], inferences: [] }));
		if (!outcome.ok) throw new Error(outcome.text);
		const claims = outcome.details["claims"] as Array<Record<string, unknown>>;
		const findings = outcome.details["findings"] as Array<Record<string, unknown>>;
		const judged = asRecord(asRecord(calls[0]?.state)?.["antiSlop"]);
		const judgedClaims = (judged?.["claims"] ?? []) as Array<Record<string, unknown>>;
		const judgedEvidence = (judgedClaims[0]?.["evidence"] ?? []) as Array<Record<string, unknown>>;

		expect(claims[0]?.["trust"]).toBe("low_trust");
		expect((claims[0]?.["evidence"] as Array<Record<string, unknown>>).map(item => item["quote"])).toEqual([
			"Anonymous survey reports 72% agreement.",
		]);
		expect(judgedEvidence.map(item => item["quote"])).toEqual(["Anonymous survey reports 72% agreement."]);
		expect(findings.some(finding => finding["kind"] === "low_trust_source")).toBe(true);
	});
});

describe("FR-55 - review status and advisory default", () => {
	function scopeOf(state: JevState) {
		return {
			taskFingerprint: state.task?.fingerprint ?? state.simple?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			quiet: false,
		};
	}
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

	test("advisory records an incomplete review and keeps a blocker recorded as a diagnostic", async () => {
		const state = acceptedState();
		const missing = antiSlopStatus(state, scopeOf(state));
		expect(missing.complete).toBe(false);

		const { deps } = depsFor(
			{
				claim_1: { label: "refuted", confidence: 0.95 },
				...CLEAN_FRAGMENT,
			},
			"advisory",
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

		const blocked = antiSlopStatus(state, scopeOf(state));
		expect(blocked.blockers.map(entry => entry.id)).toContain(String(findingId));

		const stillRecorded = antiSlopStatus(state, scopeOf(state));
		expect(stillRecorded.blockers.map(entry => entry.id)).toContain(String(findingId));
	});

	test("a simple external deliverable has no complete review until one is recorded", () => {
		const state = freshState();
		state.request = { text: REQUEST, weight: "judged" };
		registerSimple(state, REQUEST, true);

		expect(antiSlopStatus(state, scopeOf(state)).complete).toBe(false);

		recordAntiSlopReview(state, {
			taskFingerprint: state.simple?.fingerprint,
			request: REQUEST,
			revision: state.revision,
			part: { index: 1, total: 1 },
			partDigest: "d",
			language: "en",
			register: "formal",
			rulesDigest: "r",
			findings: [],
		});
		expect(antiSlopStatus(state, scopeOf(state)).complete).toBe(true);
	});

	test("advisory reports the finding without touching completion", async () => {
		const state = acceptedState();
		const { deps } = depsFor({
			claim_1: { label: "refuted", confidence: 0.95 },
			...CLEAN_FRAGMENT,
		});
		const outcome = await antiSlop(deps, state, params({ claims: [CLAIM_2], inferences: [] }));
		if (!outcome.ok) throw new Error(outcome.text);

		expect(outcome.details["blocked"]).toBe(true);
		expect(state.completion).toBeUndefined();
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
			"advisory",
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
			"advisory",
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

describe("FR-63 - strict delivery preserves the reviewed content", () => {
	for (const scenario of [
		{ name: "changed inline content", tool: "send_email", change: JSON.stringify({ body: `${ARTIFACT}\nAn unreviewed addition.` }), matches: 0.01, approved: false },
		{ name: "regeneration before publication", tool: "bash", change: JSON.stringify({ command: "bun generate-memo.ts && send-memo memo.md" }), matches: 0.01, approved: false },
		{ name: "unchanged reviewed content", tool: "send_email", change: JSON.stringify({ body: ARTIFACT }), matches: 0.99, approved: true },
		{ name: "review replaced during judgment", tool: "send_email", change: JSON.stringify({ body: ARTIFACT }), matches: 0.99, approved: false, replaceReview: true },
	]) {
		test(`${scenario.name} cannot borrow an unrelated review at the same revision`, async () => {
			const state = externalState();
			state.autonomous = true;
			state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://plan.md", planDigest: "bound" };
			state.planTopics = [{ id: "deliver", section: "# Deliver the reviewed memo", paths: ["memo.md"], requirement: REQUEST }];
			const review = depsFor({ ...CLEAN_FRAGMENT, claim_1: { label: "supported", confidence: 0.99 } }, "advisory");
			const reviewed = await antiSlop(review.deps, state, params({ claims: [CLAIM_1], inferences: [] }));
			if (!reviewed.ok) throw new Error(reviewed.text);
			const action = depsFor({
				action: { label: "on_course", confidence: 0.99 },
				within_authority: { probability: 0.99 },
				external_delivery: { label: "delivers", confidence: 0.99 },
				reviewed_delivery: { probability: scenario.matches },
			}, "advisory");
			const deps = {
				...action.deps,
				judge: async (material: unknown, questions: Parameters<Judge>[1]) => {
					if ("replaceReview" in scenario) {
						const replacement = await antiSlop(review.deps, state, params({
							artifact: `${ARTIFACT}\nThe recipient requires another version.`, claims: [CLAIM_1], inferences: [],
						}));
						if (!replacement.ok) throw new Error(replacement.text);
					}
					return action.deps.judge(material, questions);
				},
			};
			const result = await actionCheck(deps, state, {
				tool: scenario.tool, target: "external memo", change: scenario.change, callId: `deliver-${scenario.name}`,
			});
			expect(result.ok && toolDetails(result)["approved"] === true).toBe(scenario.approved);
		});
	}
});

describe("diagnostic false-clean and accounting regressions", () => {
	test("an explicit unclear relevance answer makes the anti-slop review inconclusive with an unresolved status", async () => {
		const state = externalState();
		const { deps } = depsFor({
			...CLEAN_FRAGMENT,
			relevance_1: { label: "unclear", confidence: 0.95 },
			claim_1: { label: "supported", confidence: 0.95 },
			inference_1: { label: "follows", confidence: 0.95 },
		});
		const outcome = await antiSlop(deps, state, params({ rules: [], claims: [CLAIM_1], inferences: [INFERENCE] }));
		expect(outcome.ok).toBe(false);
		expect(outcome.details?.["kind"]).toBe("unclear");
		expect(String(outcome.details?.["uncertain"])).toContain("relevance");
		const relevance = asRecord(outcome.details?.["relevance"] instanceof Array ? (outcome.details?.["relevance"] as unknown[])[0] : undefined);
		expect(relevance?.["status"]).toBe("unresolved");
		expect(state.antiSlopReviews).toHaveLength(0);
	});

	test("a below-floor relevance answer is not treated as a clean fragment", async () => {
		const state = externalState();
		const { deps } = depsFor({
			...CLEAN_FRAGMENT,
			relevance_1: { label: "repeats", confidence: 0.5 },
			claim_1: { label: "supported", confidence: 0.95 },
		});
		const outcome = await antiSlop(deps, state, params({ rules: [], claims: [CLAIM_1], inferences: [] }));
		expect(outcome.ok).toBe(false);
		expect(String(outcome.details?.["uncertain"])).toContain("relevance");
		expect(state.antiSlopReviews).toHaveLength(0);
	});

	test("an explicit unclear inference answer is inconclusive and carries an unresolved status", async () => {
		const state = externalState();
		const { deps } = depsFor({
			...CLEAN_FRAGMENT,
			claim_1: { label: "supported", confidence: 0.95 },
			inference_1: { label: "unclear", confidence: 0.95 },
		});
		const outcome = await antiSlop(deps, state, params({ rules: [], claims: [CLAIM_1], inferences: [INFERENCE] }));
		expect(outcome.ok).toBe(false);
		expect(outcome.details?.["kind"]).toBe("unclear");
		expect(String(outcome.details?.["uncertain"])).toContain("inference inf-1");
		const inferences = outcome.details?.["inferences"];
		expect(Array.isArray(inferences)).toBe(true);
		expect(asRecord((inferences as unknown[])[0])?.["status"]).toBe("unresolved");
		expect(asRecord((inferences as unknown[])[0])?.["verdict"]).toBe("unclear");
		expect(state.antiSlopReviews).toHaveLength(0);
	});

	test("a text review over the 200-question batch limit is refused locally without a judge call", async () => {
		const fragments = Array.from({ length: 12 }, (_, index) => `Paragraph number ${index + 1}.`).join("\n\n");
		const rules = Array.from({ length: 17 }, (_, index) => ({
			class: "style",
			rule: `Rule number ${index + 1}.`,
			scope: "fragment" as const,
		}));
		const { deps, calls } = depsFor({});
		const outcome = await textReview(deps, freshState(), { text: fragments, rules });
		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
		expect(outcome.text).toContain("204");
		expect(outcome.text).toContain("200");
		expect(outcome.details?.["kind"]).toBe("invalid");
	});

	test("an unchanged repeated text review is counted as not checked, not another failure", async () => {
		const { deps, calls } = depsFor({ text_rule_1: { probability: 0.95 } });
		const params = { text: "The report is ready.", rules: [{ class: "accuracy", rule: "Claims must follow the evidence." }] };
		const first = await textReview(deps, freshState(), params);
		const state = freshState();
		await textReview(deps, state, params);
		const repeat = await textReview(deps, state, params);
		expect(first.ok).toBe(false);
		expect(repeat.ok).toBe(false);
		expect(repeat.details?.["skipped"]).toBe(true);
		expect(diagnosticKind(repeat)).toBe("not_checked");
		expect(calls).toHaveLength(2);
	});

	test("the course check reports the choice confidence floor it actually applies", async () => {
		const state = freshState();
		const task = registerTask(state, "Report the coverage of the last run");
		state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://plan.md", planDigest: "bound" };
		state.planTopics = [{
			id: "report",
			section: "# Report\nReport the coverage of the last run.",
			paths: ["src/report.ts"],
			requirement: "Report the coverage of the last run",
		}];
		const { deps } = depsFor({ course: { label: "on_course", confidence: 0.56 } });
		const outcome = await courseCheck(deps, state, { claim: "render the coverage report" });
		expect(outcome.details?.["approved"]).toBe(false);
		expect(outcome.text).toContain("below the 0.6 reliability floor");
		expect(outcome.text).not.toContain("0.7 reliability floor");
	});
});

describe("observedOutcome - one ordinary result check", () => {
	const EXECUTION: Evidence = { kind: "execution", quote: "$ bun test\n3 pass, 0 fail", source: "bun test" };
	const CODE: Evidence = { kind: "code", quote: "export function report(): string { return renderCoverage(); }", source: "src/report.ts" };
	const OBSERVATIONS: Evidence[] = [EXECUTION, CODE];

	function observedState(items: string[]): JevState {
		const state = freshState();
		const task = registerTask(state, "Build the coverage report");
		state.requirementsApproval = { taskFingerprint: task.fingerprint, items };
		return state;
	}

	function requirementAnswers(label: string, execution = "evidence_1", code = "evidence_2", confidence = 0.95): Record<string, FakeAnswerSource> {
		return {
			requirement_1: { label, confidence },
			requirement_1_execution: { label: execution, confidence },
			requirement_1_code: { label: code, confidence },
		};
	}

	test("all approved requirements are met from retained code and execution evidence without a plan or acceptance record", async () => {
		const state = observedState(["The report renders the coverage."]);
		const { deps, calls } = depsFor(requirementAnswers("observed"));
		const outcome = await observedOutcome(deps, state, OBSERVATIONS);
		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["approved"]).toBe(true);
		expect(outcome.details?.["met"]).toEqual(["The report renders the coverage."]);
		expect(outcome.details?.["missing"]).toEqual([]);
		expect(outcome.details?.["unresolved"]).toEqual([]);
		expect(outcome.details?.["defects"]).toEqual([]);
		expect(calls[0]?.questions.map(question => question.name)).toEqual([
			"requirement_1", "requirement_1_execution", "requirement_1_code",
		]);
		expect(state.acceptance).toEqual([]);
		expect(state.plan).toBeUndefined();
	});

	test("a successful test run can establish that the tests passed without a code quote", async () => {
		const state = observedState(["The tests run and pass."]);
		const { deps } = depsFor(requirementAnswers("observed", "evidence_1", "not_needed"));
		const outcome = await observedOutcome(deps, state, OBSERVATIONS);
		expect(outcome.details).toMatchObject({ approved: true, requirements: [{
			status: "met", execution: { status: "selected", id: "evidence_1" }, code: { status: "not_needed" },
		}] });
	});

	test("two not-needed bases cannot establish a requirement without a cited observation", async () => {
		const state = observedState(["The tests run and pass."]);
		const { deps } = depsFor(requirementAnswers("observed", "not_needed", "not_needed"));
		const outcome = await observedOutcome(deps, state, OBSERVATIONS);
		expect(outcome.details).toMatchObject({ approved: false, missing: ["The tests run and pass."] });
	});

	test("a selected none basis reports the requirement as missing with the unresolved/missing names", async () => {
		const state = observedState(["The report renders the coverage."]);
		const { deps } = depsFor(requirementAnswers("observed", "none"));
		const outcome = await observedOutcome(deps, state, OBSERVATIONS);
		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["approved"]).toBe(false);
		expect(outcome.details?.["kind"]).toBe("unclear");
		expect(outcome.details?.["missing"]).toEqual(["The report renders the coverage."]);
		expect(outcome.details?.["met"]).toEqual([]);
		expect(state.acceptance).toEqual([]);
	});

	test("an unresolved answer is reported by requirement name rather than as a pass", async () => {
		const state = observedState(["The report renders the coverage."]);
		const { deps } = depsFor(requirementAnswers("unclear"));
		const outcome = await observedOutcome(deps, state, OBSERVATIONS);
		expect(outcome.details?.["approved"]).toBe(false);
		expect(outcome.details?.["unresolved"]).toEqual(["The report renders the coverage."]);
		expect(outcome.text).toContain("inconclusive");
	});

	test("deviating evidence names the requirement as a defect", async () => {
		const state = observedState(["The report renders the coverage."]);
		const { deps } = depsFor(requirementAnswers("deviates"));
		const outcome = await observedOutcome(deps, state, OBSERVATIONS);
		expect(outcome.details?.["approved"]).toBe(false);
		expect(outcome.details?.["kind"]).toBe("defect");
		expect(outcome.details?.["defects"]).toEqual(["The report renders the coverage."]);
		expect(outcome.text).toContain("defect");
	});

	test("missing code or execution evidence is a no-judge prerequisite", async () => {
		const state = observedState(["The report renders the coverage."]);
		const { deps, calls } = depsFor({});
		const outcome = await observedOutcome(deps, state, [CODE]);
		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
		expect(outcome.details?.["skipped"]).toBe(true);
		expect(outcome.details?.["prerequisite"]).toBe("code and execution evidence");
		expect(outcome.details?.["missingEvidence"]).toEqual(["execution"]);
	});

	test("no approved requirements is a prerequisite with no judge call", async () => {
		const state = freshState();
		registerTask(state, "Build the coverage report");
		const { deps, calls } = depsFor({});
		const outcome = await observedOutcome(deps, state, OBSERVATIONS);
		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
		expect(outcome.details?.["prerequisite"]).toBeDefined();
	});

	test("a failed judge is unavailable and never an approval", async () => {
		const state = observedState(["The report renders the coverage."]);
		const outcome = await observedOutcome({ judge: failingJudge("socket reset"), config: boundaryConfig() }, state, OBSERVATIONS);
		expect(outcome.ok).toBe(false);
		expect(outcome.details?.["kind"]).toBe("unavailable");
		expect(outcome.details?.["approved"]).not.toBe(true);
	});

	test("an unchanged repeated observation is not checked and costs no second judge call", async () => {
		const state = observedState(["The report renders the coverage."]);
		const { deps, calls } = depsFor(requirementAnswers("deviates"));
		const first = await observedOutcome(deps, state, OBSERVATIONS);
		const repeat = await observedOutcome(deps, state, OBSERVATIONS);
		expect(first.details?.["approved"]).toBe(false);
		expect(repeat.ok).toBe(false);
		expect(repeat.details?.["skipped"]).toBe(true);
		expect(diagnosticKind(repeat)).toBe("not_checked");
		expect(calls).toHaveLength(1);
	});

	test("aspect outcome delegates to the ordinary check without recording acceptance", async () => {
		const state = observedState(["The report renders the coverage."]);
		const { deps } = depsFor(requirementAnswers("observed"));
		const outcome = await acceptance(deps, state, { aspect: "outcome", evidence: OBSERVATIONS });
		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["check"]).toBe("observed_outcome");
		expect(outcome.details?.["approved"]).toBe(true);
		expect(state.acceptance).toEqual([]);
	});

	test("an oversized requirement set is refused locally without a judge call", async () => {
		const state = observedState(Array.from({ length: 67 }, (_, index) => `Requirement number ${index + 1}.`));
		const { deps, calls } = depsFor({});
		const outcome = await observedOutcome(deps, state, OBSERVATIONS);
		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
		expect(outcome.text).toContain("201");
		expect(outcome.text).toContain("200");
	});
});

describe("direct requirements registration", () => {
	test("a captured judged request registers the task before its requirements are judged", async () => {
		const state = freshState();
		state.request = { text: "Build a coverage dashboard", weight: "judged" };
		const { deps, calls } = depsFor({ coverage: { probability: 0.95 }, item_1: { probability: 0.95 } });
		const outcome = await requirements(deps, state, {
			request: "Build a coverage dashboard",
			items: [{ text: "the dashboard lists coverage", source: "Build a coverage dashboard" }],
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.details?.["approved"]).toBe(true);
		expect(state.task?.request).toBe("Build a coverage dashboard");
		expect(state.task?.external).not.toBe(true);
		expect(calls).toHaveLength(1);
	});

	test("an explicit external artifact keeps the anti-slop classification", async () => {
		const state = freshState();
		state.request = { text: "Write the legal memo", weight: "judged" };
		const { deps } = depsFor({ coverage: { probability: 0.95 }, item_1: { probability: 0.95 } });
		const outcome = await requirements(deps, state, {
			request: "Write the legal memo",
			items: [{ text: "the memo states the deadline", source: "Write the legal memo" }],
		});
		expect(outcome.ok).toBe(true);
		expect(state.task?.external).toBe(true);
	});

	test("without a captured request the original triage prerequisite remains", async () => {
		const state = freshState();
		const { deps, calls } = depsFor({});
		const outcome = await requirements(deps, state, {
			request: "Build a coverage report",
			items: [{ text: "the report lists coverage", source: "Build a coverage report" }],
		});
		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
		expect(outcome.text).toContain("must be registered through jev_triage");
	});

	test("a quiet request does not register a development task from requirements", async () => {
		const state = freshState();
		state.request = { text: "Build a coverage dashboard", weight: "quiet" };
		const { deps, calls } = depsFor({});
		const outcome = await requirements(deps, state, {
			request: "Build a coverage dashboard",
			items: [{ text: "the dashboard lists coverage", source: "Build a coverage dashboard" }],
		});
		expect(outcome.ok).toBe(false);
		expect(state.task).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});
