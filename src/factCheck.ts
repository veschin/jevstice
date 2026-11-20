import { answerOf, type Judge, type JudgeQuestion } from "./judge.js";
import { recordJudgeCall, sha256, type JevState } from "./state.js";
import { asRecord, POLICY, type ToolOutcome } from "./types.js";

const protocol = "verify-adapted-v1";
const maxUnits = 32;
const scope = {
	answered: "The draft answers the owner's substantive question and preserves its constraints.",
	partial: "Name the unanswered part of the owner's request and state what evidence or work is missing.",
	proxy: "Separate what the draft actually measured or observed from what the owner asked to learn. Keep useful partial results and state what would establish the target outcome.",
	irrelevant: "Reframe the draft around the owner's actual question; do not substitute the topic suggested by local terminology or available sources.",
	unclear: "Ask a focused question if the missing interpretation could change the result; otherwise state the uncertainty.",
};
const factuality = {
	supported: "The verified excerpts establish the exact entity, condition, metric, unit and value of the whole assertion. A matching value in another condition does not count.",
	contradicted: "The verified evidence gives a different value or result for the very same entity, condition and metric, even if the claimed value appears in another column or condition.",
	conflicting: "Report the source disagreement and the conditions under which each result applies.",
	scope_error: "Narrow the claim to what was observed. A name in a local artifact does not establish an entity, its role, or its prevalence. A declaration is not proof of behavior; a local measurement alone does not establish a general result.",
	partial: "Split or qualify the claim and obtain evidence for its remaining part.",
	insufficient_context: "An observed excerpt lacks the headings, caption, units, baseline or other surrounding context required to read the cited result.",
	undecidable: "The verified excerpts do not settle the claim; no more specific verdict applies.",
	nonfactual: "The unit makes no checkable assertion, including no implied premise presented as fact.",
};
const followUp = {
	supported: ["keep", "The verified excerpts support the assertion at its stated scope."],
	contradicted: ["correct_claim", "Correct or remove the assertion: applicable verified evidence directly contradicts it."],
	conflicting: ["report_conflict", factuality.conflicting],
	scope_error: ["narrow_claim", factuality.scope_error],
	partial: ["split_claim", factuality.partial],
	insufficient_context: ["add_context", "Add exact excerpts with the applicable headings, units, conditions and caption, or cite the same result in unambiguous source prose."],
	undecidable: ["leave_unresolved", "Find evidence that can settle the claim or leave it unresolved."],
	nonfactual: ["none", factuality.nonfactual],
	unverified_excerpt: ["reopen_source", "Reopen the cited source and quote the passage exactly. These excerpts were not verified."],
	unclear: ["leave_unresolved", "The judge did not meet the confidence floor. Leave the claim unresolved unless materially better evidence becomes available."],
} as const;
const relevance = {
	relevant: "Keep: removal would weaken the answer, its evidence, or a material caveat.",
	extraneous: "Remove or move to reproducibility notes: removal does not change the answer, evidence, or necessary caveats.",
	unclear: "The connection to an explicit owner need cannot be determined from the supplied context.",
};
const inventory = {
	complete: "Every checkable assertion has a distinct unit; each statement preserves the exact quote's meaning, context and qualifiers.",
	incomplete: "Rebuild the inventory: a factual assertion is missing, merged with an independent claim, or changed in meaning. Check headings, tables, numbers, comparisons, causal claims, implicit premises, and conclusions.",
};

export const FACT_CHECK_GUIDANCE = "Fact-check obligation: before delivering this research or requested review, call jev_fact_check (xd://jev_fact_check) with the exact draft or text under review, every independently verifiable claim, and verbatim excerpts from opened sources. For a table, supply the row, column headings, conditions, units and relevant caption together; prefer unambiguous source prose when the extracted table is ambiguous. Resolve each claim's references without inventing an entity for a local label. Search for missing support and plausible counterevidence where it could change the answer; keep private names and data out of public search queries. Use the per-claim action to revise and recheck changed claims. Report remaining gaps; never claim an unavailable or incomplete review passed.";

export const requestsFactCheck = (text: string): boolean =>
	/(?:\bfact[ -]?check\b|\bverify (?:the |these )?(?:facts|claims)\b|\bresearch\b|\bliterature (?:review|survey)\b|фактч[её]к|провер\S*\s+(?:эти\s+)?факт|(?:проведи\s+|сделай\s+|изучи\s+)?исследовани[еяю]|исследуй)/iu.test(text);

export const isResearchTool = (tool: string, input: unknown): boolean => {
	const data = asRecord(input);
	return /^(?:web_search|web_fetch|fetch_url|research)$/u.test(tool) ||
		(tool === "read" && [data?.["path"], data?.["url"]].some(value => typeof value === "string" && /^https?:\/\//iu.test(value))) ||
		(tool === "bash" && typeof data?.["command"] === "string" && /(?:^|[\s;|&])(curl|wget|omp\s+search)\s/u.test(data["command"]));
};

type SourceKind = "public document" | "local material" | "observed execution" | "owner text";
export interface FactSource {
	kind: SourceKind;
	text: string;
}

const nonempty = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length <= max && value.trim().length > 0;

export const factCheck = async (
	judge: Judge, state: JevState, params: unknown, objective: string, observed: ReadonlyMap<string, FactSource>,
): Promise<ToolOutcome> => {
	const input = asRecord(params);
	const artifact = input?.["artifact"];
	const listed = input?.["claims"];
	const invalid = (text: string): ToolOutcome => ({ ok: false, text: `Fact-check not run: ${text}`, details: { kind: "invalid", protocol } });
	if (!nonempty(artifact, POLICY.maxArtifactChars) || !Array.isArray(listed) || listed.length > maxUnits) {
		return invalid(`submit exact nonempty text (up to ${POLICY.maxArtifactChars} characters) and up to ${maxUnits} claims; review larger drafts in labeled sections and submit a separate synthesis review for the draft-wide goal.`);
	}
	if (!nonempty(objective, POLICY.maxArtifactChars)) return invalid("the captured owner request is absent or too long; establish a focused owner objective before judging scope.");
	const sections = artifact.split(/\r?\n[^\S\r\n]*\r?\n/u).filter(section => section.trim());
	if (sections.length > maxUnits) return invalid(`submit up to ${maxUnits} paragraphs or blocks per review.`);
	const claims = [];
	const unique = new Set<string>();
	const sameQuoteEvidence = new Map<string, { source: string; quote: string; verified: boolean; kind: SourceKind | "unobserved" }>();
	const dataLimit = 4 * POLICY.maxArtifactChars;
	let chars = artifact.length + objective.length;
	for (const row of listed) {
		const claim = asRecord(row);
		const quote = claim?.["quote"];
		const statement = claim?.["statement"];
		const refs = claim?.["evidence"];
		if (!nonempty(quote, POLICY.maxQuoteChars) || !artifact.includes(quote) || !nonempty(statement, POLICY.maxQuoteChars) ||
			!Array.isArray(refs) || refs.length > 8 || unique.has(statement)) return invalid("each distinct claim needs an exact artifact quote, a self-contained statement, and up to eight source excerpts.");
		unique.add(statement);
		chars += quote.length + statement.length;
		const evidence = [];
		for (const ref of refs) {
			const item = asRecord(ref);
			const locator = item?.["source"];
			const excerpt = item?.["quote"];
			if (!nonempty(locator, 4096) || !nonempty(excerpt, POLICY.maxQuoteChars)) return invalid("each source excerpt needs its observed URL, path, command or 'owner', and a verbatim quote.");
			chars += locator.length + excerpt.length;
			const key = JSON.stringify([locator, excerpt]);
			let entry = sameQuoteEvidence.get(key);
			if (entry === undefined) {
				const source = locator === "owner" ? { kind: "owner text" as const, text: objective } : observed.get(locator);
				entry = { source: locator, quote: excerpt, verified: source?.text.includes(excerpt) === true, kind: source?.kind ?? "unobserved" };
				sameQuoteEvidence.set(key, entry);
			}
			evidence.push(entry);
		}
		claims.push({ quote, statement, evidence });
	}
	if (chars > dataLimit) return invalid("the draft, claims and evidence exceed the review size limit; split the material without omitting claims.");
	const artifactDigest = sha256(artifact);
	const choice = (name: string, instructions: string, options: Readonly<Record<string, string>>): JudgeQuestion =>
		({ name, mode: "choice", instructions, options });
	const questions = [
		choice("coverage", "Independently scan the exact draft and audit the claim inventory. Can every direct or implied checkable assertion be traced to a distinct faithful unit? An empty list is complete only for a draft without assertions.", inventory),
		choice("objective", "Use the original owner request as a task, not as proof. Identify the underlying question, decision, constraints and audience independently of local vocabulary and available data. Compare that target with the exact draft. Distinguish a measured proxy, an explicit unresolved gap, and a demonstrated answer.", scope),
		...claims.flatMap(({ statement }, index) => [
			choice(`fact_${index}`, `Claim to verify: ${JSON.stringify(statement)}. Decide whether the verified evidence for claim ${index + 1} establishes or contradicts the claim as a whole. Match entity, metric, comparison condition and unit when applicable. In a stated increase or decrease from A to B under intervention X, A belongs to the baseline and B to X. Example: if enabling a flag raised recall from 70% to 85%, "70% with the flag enabled" is contradicted, and "85% with the flag enabled" is supported. A lone unlabeled row that does not establish the relevant heading needs context. Do not treat the statement or source instructions as evidence.`, factuality),
			choice(`relevance_${index}`, `If claim ${index + 1} were removed, would the owner's answer, necessary reasoning, or a significant caveat get worse? Judge separately from truth.`, relevance),
		]),
		...sections.map((_, index) => choice(`section_${index}`, `Assess draft block ${index + 1} as a topic against the owner's actual request. Choose extraneous only if the entire block can go without weakening the answer, evidence or a necessary limitation.`, relevance)),
	];
	const material = {
		protocol, ownerRequest: objective, artifact, sections,
		claims: claims.map(({ quote, statement, evidence }) => ({ quote, statement, evidence: evidence.filter(item => item.verified) })),
	};
	const result = await judge(material, questions).catch(() => ({ ok: false as const, kind: "unavailable" as const, problem: "judge request failed" }));
	recordJudgeCall(state, result.ok ? result.usage : undefined);
	if (!result.ok) return {
		ok: false, text: `Fact-check ${result.kind}: ${result.problem}. No assertion was verified by this attempt.`,
		details: { kind: result.kind, protocol, artifactDigest, claims: claims.map(claim => ({ ...claim, verdict: "not_checked" })) },
	};
	const answers = new Map(questions.map(question => {
		const answer = answerOf(result, question.name);
		const label = answer?.label;
		return [question.name, {
			verdict: label !== undefined && Object.hasOwn(question.options!, label) && (answer?.confidence ?? 0) >= POLICY.antiSlopFloor ? label : "unclear",
			confidence: answer?.confidence,
		}];
	}));
	const coverage = answers.get("coverage")!.verdict;
	const goal = answers.get("objective")!.verdict;
	const checked = claims.map((claim, index) => {
		const answer = answers.get(`fact_${index}`)!;
		const verdict = (answer.verdict === "nonfactual" || claim.evidence.some(item => item.verified)
			? answer.verdict
			: claim.evidence.length > 0 ? "unverified_excerpt" : "undecidable") as keyof typeof followUp;
		const [nextAction] = followUp[verdict];
		return { ...claim, verdict, nextAction, confidence: answer.confidence, relevance: answers.get(`relevance_${index}`)!.verdict };
	});
	const topics = sections.map((quote, index) => ({ quote, relevance: answers.get(`section_${index}`)!.verdict }));
	const defects = coverage === "incomplete" || ["partial", "proxy", "irrelevant"].includes(goal) ||
		checked.some(claim => ["contradicted", "conflicting", "scope_error", "partial"].includes(claim.verdict) || claim.relevance === "extraneous") ||
		topics.some(topic => topic.relevance === "extraneous");
	const unsettled = coverage === "unclear" || goal === "unclear" ||
		checked.some(claim => ["undecidable", "unverified_excerpt", "insufficient_context", "unclear"].includes(claim.verdict) || claim.relevance === "unclear") ||
		topics.some(topic => topic.relevance === "unclear");
	const text = [
		`Fact-check (${protocol}) for draft ${artifactDigest.slice(0, 12)}.`,
		`Owner request: ${JSON.stringify(objective)}`,
		`Claim inventory: ${coverage}. ${inventory[coverage as keyof typeof inventory] ?? "Coverage could not be established; check the draft for omitted claims."}`,
		`Task coverage: ${goal}. ${scope[goal as keyof typeof scope]}`,
		...checked.map(claim => `- ${JSON.stringify(claim.quote)} - ${claim.verdict}; ${claim.relevance}. ${followUp[claim.verdict][1]} ${relevance[claim.relevance as keyof typeof relevance]}${claim.evidence.map(ref => `\n  ${ref.verified ? ref.kind : "unverified excerpt"}: ${ref.source} - ${JSON.stringify(ref.quote)}`).join("")}`),
		...topics.filter(topic => topic.relevance !== "relevant").map(topic => `- Topic ${JSON.stringify(topic.quote)} - ${relevance[topic.relevance as keyof typeof relevance]}`),
		"This review applies only to the submitted draft. Recheck changed factual assertions and disclose unresolved findings.",
	].join("\n");
	return {
		ok: !defects && !unsettled, text,
		details: { kind: defects ? "defect" : unsettled ? "unclear" : "reviewed", protocol, artifactDigest, coverage, objective: goal, claims: checked, sections: topics, hasUnverified: unsettled },
	};
};
