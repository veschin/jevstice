/**
 * Review activities: `business_review`, `architecture_review` and the opt-in `security_review`.
 *
 * The judge decided these are product capabilities the customer's outcome needs
 * (business 0.86 and architecture 0.92 must-be, security 0.46 opt-in; evidence/review-activities.md).
 * Each review is a stage with a FIXED question set and no blocking: it records its per-item
 * results in session state and surfaces them in the same session. A review never refuses an
 * action - it is the same mechanism as the gates in `advisory` mode (src/gates.ts owns the
 * registry and the descriptors; this module owns the question sets and the runner).
 *
 * Fixed question sets (verbatim from the spec):
 *  - business_review: two scores (the promised outcome, how much of the work serves it), a choice
 *    over the declared risk candidates, the fixed "the product's value is unverified" statement,
 *    and one statement per declared decision under review ("serves the outcome; keep it").
 *  - architecture_review: one score (how well this absorbs the next change), one statement per
 *    declared defect ("a maintainability defect that must be repaired"), a choice over the
 *    declared candidate changes.
 *  - security_review: one statement per declared surface ("opens an attack or disclosure path"),
 *    a choice over the same surfaces for the single worst.
 *
 * The rules that apply to every review:
 *  - an abstention, a judge error, a low confidence, a frame escape or a deadline loss records the
 *    uncertainty and surfaces it; only a confident negative STATEMENT is a finding to answer;
 *  - a review costs a judge call, so it runs on demand (never on a timer);
 *  - the question sets are the shipped defaults; an owner may replace them per stage through the
 *    existing `stages` config, fail-closed on anything malformed.
 */
import { withDeadline } from "./deadline.js";
import { SERVICE_OPTION_CRITERIA } from "./evidence.js";
import type {
	DecisionOption,
	DecisionStage,
	Evidence,
	ReviewJudge,
	ReviewQuestionKind,
	ReviewQuestionWire,
} from "./types.js";

/** The three review stages, in the order the spec lists them. */
export const REVIEW_IDS = ["business_review", "architecture_review", "security_review"] as const;
export type ReviewId = (typeof REVIEW_IDS)[number];

/** True when a stage name is one of the review activities (their question sets are overrideable). */
export function isReviewStage(stage: string): stage is ReviewId {
	return (REVIEW_IDS as readonly string[]).includes(stage);
}

/**
 * noul >= this => the statement holds. Same documented boundary the per-claim marking and the
 * multi-label marking use, so one number governs every statement verdict in the product.
 */
export const REVIEW_STATEMENT_THRESHOLD = 0.5;

/**
 * Internal deadline of a review consult. A review is submitted from a host handler, so it must
 * decide before the handler times out; the registry validator keeps every descriptor under the
 * host's ceiling.
 */
export const REVIEW_DEADLINE_MS = 25_000;

/** Business review rubrics (the same 0..9 levels the self-check runner uses, verbatim). */
export const OUTCOME_RUBRIC = [
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
] as const;

export const VALUE_RUBRIC = [
	"Not met at all.",
	"Barely started.",
	"A small part met.",
	"A quarter met.",
	"A third met.",
	"Half met.",
	"Two thirds met.",
	"Mostly met.",
	"Met, with gaps.",
	"Met and demonstrated.",
] as const;

/** Architecture review rubric: how well the implementation absorbs the next change (0..9). */
export const QUALITY_RUBRIC = [
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
] as const;

/**
 * One question of a review's fixed set.
 *  - `perItem`: one question per declared item (the item text is quoted into the question);
 *  - `candidates`: a choice whose criteria are the caller's declared candidate set;
 *  - `findingWhen`: which noul outcome is a finding the executor must answer (`true` for a
 *    statement that names a defect, `false` for a statement that names something to keep).
 */
export interface ReviewQuestion {
	id: string;
	kind: ReviewQuestionKind;
	question: string;
	rubric?: readonly string[];
	noul?: { true?: string; false?: string };
	perItem?: boolean;
	candidates?: boolean;
	findingWhen?: "true" | "false";
}

/** The shipped fixed question sets (the spec's defaults; overridable per stage via config). */
export const REVIEW_QUESTIONS: Readonly<Record<ReviewId, readonly ReviewQuestion[]>> = {
	business_review: [
		{
			id: "outcome",
			kind: "score",
			question:
				"How likely is this, as it stands, to produce the customer's promised outcome? Judge from the " +
				"quoted product state, the customer's goal and problem, and what is measured.",
			rubric: OUTCOME_RUBRIC,
		},
		{
			id: "goal_met",
			kind: "score",
			question: "How much of the described work serves that outcome rather than decorating it?",
			rubric: VALUE_RUBRIC,
		},
		{
			id: "risk",
			kind: "choice",
			question:
				"Which single declared risk most threatens the customer's outcome right now? Choose one of the " +
				"declared candidates.",
			candidates: true,
		},
		{
			id: "value_unverified",
			kind: "noul",
			question:
				"Statement under judgment: the product's value is unverified - nothing measures whether it " +
				"improves the customer's result.",
			noul: {
				true: "The statement holds: nothing in the quoted state measures the customer's result.",
				false: "The statement does not hold: the quoted state measures the customer's result.",
			},
			findingWhen: "true",
		},
		{
			id: "decision",
			kind: "noul",
			perItem: true,
			question:
				"Statement under judgment (for the declared decision quoted with this question): this decision " +
				"serves the customer's outcome and should be kept as it is.",
			noul: {
				true: "The decision serves the outcome and should be kept.",
				false: "The decision does not serve the outcome, or it should not be kept as it is.",
			},
			findingWhen: "false",
		},
	],
	architecture_review: [
		{
			id: "quality",
			kind: "score",
			question:
				"How well is this implementation built, for absorbing the next change? Judge from the quoted " +
				"module inventory, test inventory, observed duplication and invariants.",
			rubric: QUALITY_RUBRIC,
		},
		{
			id: "defect",
			kind: "noul",
			perItem: true,
			question:
				"Statement under judgment (for the declared defect quoted with this question): this is a " +
				"maintainability defect that must be repaired.",
			noul: {
				true: "The stated defect is real and must be repaired.",
				false: "It is not a maintainability defect, or it does not need repair.",
			},
			findingWhen: "true",
		},
		{
			id: "top_change",
			kind: "choice",
			question:
				"Which single declared change would most improve this codebase right now? Choose one of the " +
				"declared candidates.",
			candidates: true,
		},
	],
	security_review: [
		{
			id: "surface",
			kind: "noul",
			perItem: true,
			question:
				"Statement under judgment (for the declared surface quoted with this question): this change " +
				"opens an attack or disclosure path that is not acceptable.",
			noul: {
				true: "The change opens a real attack or disclosure path.",
				false: "No attack or disclosure path is opened by this change.",
			},
			findingWhen: "true",
		},
		{
			id: "worst_surface",
			kind: "choice",
			question: "Which single declared surface is the worst if it is left as it stands?",
			candidates: true,
		},
	],
};

const QUESTION_KINDS: Readonly<Record<string, true>> = { score: true, choice: true, noul: true };
/** A score rubric needs 2..10 levels (S:API score contract) and the value is capped by it. */
const RUBRIC_MIN_LEVELS = 2;
const RUBRIC_MAX_LEVELS = 10;

/**
 * Parse a question set (a shipped default or an owner override from `stages.<stage>.questions`).
 * Throws a plain Error naming the problem; the config layer wraps it into JevConfigError with the
 * file. Fail-closed: anything malformed refuses the config rather than silently shipping a review
 * whose question set is not the one the owner declared.
 */
export function parseReviewQuestions(raw: unknown, where: string): ReviewQuestion[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error(`${where} must be a non-empty array of review questions`);
	}
	const seen = new Set<string>();
	const out: ReviewQuestion[] = [];
	raw.forEach((entry, i) => {
		const at = `${where}[${i}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${at} must be an object`);
		}
		const record = entry as Record<string, unknown>;
		const id = record["id"];
		const kind = record["kind"];
		if (typeof id !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(id)) {
			throw new Error(`${at}.id must match ^[a-z][a-z0-9_]{1,63}$`);
		}
		if (seen.has(id)) throw new Error(`${at}.id "${id}" is declared twice`);
		seen.add(id);
		if (typeof kind !== "string" || QUESTION_KINDS[kind] !== true) {
			throw new Error(`${at}.kind must be one of: ${Object.keys(QUESTION_KINDS).join(", ")}`);
		}
		const question = record["question"];
		if (typeof question !== "string" || question.trim().length === 0) {
			throw new Error(`${at}.question must be a non-empty string`);
		}
		const parsed: ReviewQuestion = { id, kind: kind as ReviewQuestionKind, question };
		if (kind === "score") {
			const rubric = record["rubric"];
			if (
				!Array.isArray(rubric) ||
				rubric.length < RUBRIC_MIN_LEVELS ||
				rubric.length > RUBRIC_MAX_LEVELS ||
				rubric.some(level => typeof level !== "string" || level.trim().length === 0)
			) {
				throw new Error(
					`${at}.rubric must be ${RUBRIC_MIN_LEVELS}..${RUBRIC_MAX_LEVELS} non-empty level descriptions`,
				);
			}
			parsed.rubric = rubric as string[];
			if (record["perItem"] === true || record["candidates"] === true) {
				throw new Error(`${at} is a score question: perItem/candidates do not apply`);
			}
		}
		if (kind === "noul") {
			if (record["candidates"] === true) throw new Error(`${at} is a statement question: candidates do not apply`);
			const noul = record["noul"];
			if (typeof noul !== "object" || noul === null || Array.isArray(noul)) {
				throw new Error(`${at}.noul must be an object with the true/false criteria`);
			}
			const criteria: { true?: string; false?: string } = {};
			for (const key of ["true", "false"] as const) {
				const value = (noul as Record<string, unknown>)[key];
				if (value !== undefined) {
					if (typeof value !== "string" || value.trim().length === 0) {
						throw new Error(`${at}.noul.${key} must be a non-empty string`);
					}
					criteria[key] = value;
				}
			}
			if (criteria.true === undefined && criteria.false === undefined) {
				throw new Error(`${at}.noul must state at least one of true/false`);
			}
			parsed.noul = criteria;
			const findingWhen = record["findingWhen"];
			if (findingWhen !== undefined && findingWhen !== "true" && findingWhen !== "false") {
				throw new Error(`${at}.findingWhen must be "true" or "false" when declared`);
			}
			if (findingWhen !== undefined) parsed.findingWhen = findingWhen;
		}
		if (kind === "choice") {
			if (record["perItem"] === true) {
				throw new Error(`${at} is a choice question: one candidate set per review, perItem does not apply`);
			}
			if (record["candidates"] !== true) {
				throw new Error(`${at} is a choice question: it must take the declared candidates (candidates: true)`);
			}
			parsed.candidates = true;
		}
		if (record["perItem"] === true) {
			if (kind !== "noul") throw new Error(`${at}.perItem applies to statement questions only`);
			parsed.perItem = true;
		}
		out.push(parsed);
	});
	return out;
}

/** One declared item a per-item question judges (submitted claim text, in submission order). */
export interface ReviewItem {
	id: string;
	text: string;
}

/** The questions actually sent, after per-item expansion: the judge answers exactly these ids. */
export interface ExpandedReviewQuestion {
	wire: ReviewQuestionWire;
	template: ReviewQuestion;
	/** The declared item this question judges (per-item questions only). */
	item?: string;
}

/**
 * Build the request's question list: fixed questions once, a `perItem` question once per declared
 * item (the item text is quoted into the question, so the judge never guesses it), and a
 * `candidates` choice over the declared candidate set. Ids stay unique (`<id>-<n>` per item).
 */
export function expandReviewQuestions(
	questions: readonly ReviewQuestion[],
	items: readonly ReviewItem[],
	candidates: readonly DecisionOption[],
): ExpandedReviewQuestion[] {
	const out: ExpandedReviewQuestion[] = [];
	for (const template of questions) {
		if (template.perItem === true) {
			items.forEach((item, i) => {
				out.push({
					wire: {
						id: `${template.id}-${i + 1}`,
						kind: "noul",
						question: `${template.question} Declared item (verbatim): ${item.text}`,
						...(template.noul ? { noul: { ...template.noul } } : {}),
					},
					template,
					item: item.text,
				});
			});
			continue;
		}
		if (template.kind === "choice") {
			const criteria: Record<string, string | null> = {};
			for (const candidate of candidates) criteria[candidate.id] = candidate.meaning;
			out.push({
				wire: {
					id: template.id,
					kind: "choice",
					question: template.question,
					// The declared candidates, plus the mandatory service options: the judge is never
					// locked into the caller's candidate set (an escape is a review-level uncertainty).
					options: { ...criteria, ...SERVICE_OPTION_CRITERIA },
				},
				template,
			});
			continue;
		}
		out.push({
			wire: {
				id: template.id,
				kind: template.kind,
				question: template.question,
				...(template.rubric ? { rubric: [...template.rubric] } : {}),
				...(template.noul ? { noul: { ...template.noul } } : {}),
			},
			template,
		});
	}
	return out;
}

/** One answered question of a review: the per-item verdict the record keeps. */
export interface ReviewQuestionOutcome {
	questionId: string;
	kind: ReviewQuestionKind;
	/** Statement questions: the boolean the judge's noul resolved to. */
	verdict?: boolean;
	/** Statement questions: the raw noul probability (why the verdict came out that way). */
	noul?: number;
	/** Score questions. */
	score?: number;
	/** Choice questions: the selected declared candidate. */
	optionId?: string;
	optionLabel?: string;
	/** Per-item questions only: the declared item judged. */
	item?: string;
	confidence?: number;
	/** A confident negative statement (per the template's polarity): a finding to answer. */
	finding: boolean;
}

export type ReviewConsultOutcome =
	| { ok: true; outcomes: ReviewQuestionOutcome[]; findings: string[]; reasons: string[] }
	| { ok: false; judged: false; detail: string };

export interface ReviewConsultRequest {
	stage: DecisionStage;
	task: string;
	questions: readonly ReviewQuestion[];
	items: readonly ReviewItem[];
	candidates: readonly DecisionOption[];
	evidence: Evidence[];
	judge: ReviewJudge;
	/** Internal deadline: reviews are submitted from a host handler, so they decide before it. */
	deadlineMs?: number;
}

function failClosed(detail: string): ReviewConsultOutcome {
	// Never a partial review: an unusable answer records uncertainty and refuses nothing.
	return { ok: false, judged: false, detail };
}

/**
 * Run one review: the fixed question set (plus one question per declared item) goes to the judge
 * in ONE request; the answers come back validated per question id and per kind. Fail-closed on a
 * judge error, a deadline loss, a frame escape, a missing/unknown id, a wrong answer kind or an
 * out-of-range value: the consultation records uncertainty and no per-item verdicts.
 *
 * This function has no refusal path at all - a review is advisory by construction (the registry
 * declares the mode; the runner cannot block, record an approval or refuse an action).
 */
export async function consultReview(request: ReviewConsultRequest): Promise<ReviewConsultOutcome> {
	const expanded = expandReviewQuestions(request.questions, request.items, request.candidates);
	if (expanded.length === 0) return failClosed("the review has no question to ask");
	const choiceTemplates = expanded.filter(q => q.wire.kind === "choice");
	if (choiceTemplates.some(q => Object.keys(q.wire.options ?? {}).length < 2) || request.candidates.length === 0) {
		return failClosed("the review needs the declared candidates for its choice question");
	}
	let raw: unknown;
	try {
		raw = await withDeadline(
			request.judge({
				stage: request.stage,
				task: request.task,
				questions: expanded.map(q => q.wire),
				evidence: request.evidence,
				items: request.items.map(i => ({ id: i.id, text: i.text })),
			}),
			request.deadlineMs,
		);
	} catch (err) {
		return failClosed(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (raw === undefined) {
		return failClosed(
			`the judge did not answer before the review deadline (${request.deadlineMs}ms, under the host's ` +
				"handler timeout)",
		);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return failClosed("the judge returned a malformed review result");
	}
	const result = raw as { judged?: unknown; answers?: unknown; reasons?: unknown };
	if (result.judged !== true || !Array.isArray(result.answers)) {
		const why = Array.isArray(result.reasons)
			? result.reasons.filter((r): r is string => typeof r === "string").join(" ")
			: "";
		return failClosed(`the judge returned an unjudged review result${why === "" ? "" : `: ${why}`}`);
	}
	const byId = new Map<string, Record<string, unknown>>();
	for (const answer of result.answers) {
		if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
			return failClosed("the judge returned a malformed answer");
		}
		// Validated entry by entry: the raw payload is untrusted, so every field is read with a
		// typeof check below rather than trusted through a cast.
		const entry = answer as Record<string, unknown>;
		if (typeof entry["id"] !== "string") return failClosed("the judge returned an answer without an id");
		byId.set(entry["id"], entry);
	}
	const expected = expanded.map(q => q.wire.id);
	const unknown = [...byId.keys()].filter(id => !expected.includes(id));
	if (unknown.length > 0 || byId.size !== expected.length) {
		return failClosed(
			`the answered question ids must be exactly the asked ones (${expected.join(", ")}); ` +
				`got ${[...byId.keys()].join(", ")}`,
		);
	}
	const outcomes: ReviewQuestionOutcome[] = [];
	const reasons: string[] = Array.isArray(result.reasons)
		? result.reasons.filter((r): r is string => typeof r === "string")
		: [];
	for (const question of expanded) {
		const answer = byId.get(question.wire.id)!;
		const rawConfidence = answer["confidence"];
		const confidence =
			typeof rawConfidence === "number" && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
				? rawConfidence
				: undefined;
		if (answer["kind"] !== question.wire.kind) {
			return failClosed(
				`the answer for ${question.wire.id} is a ${String(answer["kind"])} answer where a ${question.wire.kind} ` +
					"question was asked",
			);
		}
		if (question.wire.kind === "score") {
			const levels = question.wire.rubric ?? [];
			const score = answer["score"];
			// Fractional scores are the norm, not an accident: the repository's own review runner asks
			// for a 0..9 score and the judge answers 2.58. A review note proposed pinning integers; the
			// product's measured usage and tests/reviews.test.ts contradict it, so the range stands.
			if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels.length - 1) {
				return failClosed(
					`the score for ${question.wire.id} must be a finite number within the rubric ` +
						`(0..${levels.length - 1}); got ${String(score)}`,
				);
			}
			outcomes.push({
				questionId: question.wire.id,
				kind: "score",
				score,
				...(confidence !== undefined ? { confidence } : {}),
				finding: false,
			});
			continue;
		}
		if (question.wire.kind === "choice") {
			const chosen = answer["choice"];
			if (typeof chosen !== "string") return failClosed(`the choice question ${question.wire.id} was not answered`);
			const offered = new Set(request.candidates.map(c => c.id));
			if (!offered.has(chosen)) {
				// A service option (or anything else outside the declared set): the caller's candidate
				// set was wrong, which is a review-level uncertainty, never a finding about the product.
				const escaped = chosen in SERVICE_OPTION_CRITERIA;
				return failClosed(
					escaped
						? `the judge rejected the declared candidates for ${question.wire.id} (${chosen}); state ` +
							"candidates that match the material and re-submit"
						: `the answer for ${question.wire.id} is not one of the declared candidates: ${chosen}`,
				);
			}
			const candidate = request.candidates.find(c => c.id === chosen)!;
			outcomes.push({
				questionId: question.wire.id,
				kind: "choice",
				optionId: chosen,
				optionLabel: candidate.label,
				...(confidence !== undefined ? { confidence } : {}),
				finding: false,
			});
			continue;
		}
		const noul = answer["noul"];
		if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
			return failClosed(
				`the statement answer for ${question.wire.id} must be a finite probability in 0..1; got ${String(noul)}`,
			);
		}
		const verdict = noul >= REVIEW_STATEMENT_THRESHOLD;
		const finding = question.template.findingWhen !== undefined && verdict === (question.template.findingWhen === "true");
		outcomes.push({
			questionId: question.wire.id,
			kind: "noul",
			verdict,
			noul,
			...(question.item !== undefined ? { item: question.item } : {}),
			...(confidence !== undefined ? { confidence } : {}),
			finding,
		});
	}
	const findings = outcomes
		.filter(outcome => outcome.finding)
		.map(outcome =>
			outcome.item !== undefined ? `${outcome.questionId} ("${outcome.item}")` : outcome.questionId,
		);
	return { ok: true, outcomes, findings, reasons };
}

// ---------- the recorded result ----------

/** One score the judge returned, with its confidence. */
export interface ReviewScoreMarking {
	questionId: string;
	score: number;
	confidence?: number;
}

/** The chosen candidate of a review's choice question (biggest risk / top change / worst surface). */
export interface ReviewChoiceMarking {
	questionId: string;
	optionId: string;
	label: string;
	confidence?: number;
}

/** One statement verdict (fixed statement or one declared item), with the noul it resolved from. */
export interface ReviewItemMarking {
	questionId: string;
	/** The declared item judged; "" for a fixed statement. */
	item: string;
	verdict: boolean;
	noul: number;
	confidence?: number;
	/** A confident negative statement: the finding the executor must answer. */
	finding: boolean;
}

/**
 * One recorded review: the per-item results, not a summary. `scores` carries the scores with
 * their confidences, `choice` the chosen declared candidate, `items` every statement verdict
 * (fixed and per declared item) in question order, and `findings` names what must be answered.
 */
export interface ReviewRecord {
	review: ReviewId;
	stage: DecisionStage;
	/** False when the consult could not be completed: no per-item result exists then. */
	judged: boolean;
	scores: ReviewScoreMarking[];
	choice?: ReviewChoiceMarking;
	items: ReviewItemMarking[];
	findings: string[];
	reasons: string[];
	at: number;
	taskFingerprint: string | undefined;
	workRevision: number;
}

/** Build the recorded review from one consult outcome plus the session stamps. */
export function reviewRecord(
	review: ReviewId,
	stage: DecisionStage,
	outcome: ReviewConsultOutcome,
	stamp: { at: number; taskFingerprint: string | undefined; workRevision: number },
): ReviewRecord {
	const base: ReviewRecord = {
		review,
		stage,
		judged: outcome.ok,
		scores: [],
		items: [],
		findings: outcome.ok ? outcome.findings : [],
		reasons: outcome.ok ? outcome.reasons : [],
		at: stamp.at,
		taskFingerprint: stamp.taskFingerprint,
		workRevision: stamp.workRevision,
	};
	if (!outcome.ok) {
		base.reasons = [outcome.detail];
		return base;
	}
	for (const item of outcome.outcomes) {
		if (item.kind === "score" && item.score !== undefined) {
			base.scores.push({
				questionId: item.questionId,
				score: item.score,
				...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
			});
			continue;
		}
		if (item.kind === "choice" && item.optionId !== undefined) {
			base.choice = {
				questionId: item.questionId,
				optionId: item.optionId,
				label: item.optionLabel ?? item.optionId,
				...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
			};
			continue;
		}
		if (item.kind === "noul" && item.verdict !== undefined && item.noul !== undefined) {
			base.items.push({
				questionId: item.questionId,
				item: item.item ?? "",
				verdict: item.verdict,
				noul: item.noul,
				...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
				finding: item.finding,
			});
		}
	}
	return base;
}

/** One-line fixed-template summary of a recorded review (no generated prose). */
export function reviewLine(record: ReviewRecord): string {
	if (!record.judged) return `${record.stage}: not judged - ${record.reasons.join(" ")}`;
	const scores = record.scores
		.map(s => `${s.questionId}=${s.score}${s.confidence !== undefined ? `(${s.confidence})` : ""}`)
		.join(" ");
	const choice = record.choice !== undefined ? `; choice ${record.choice.questionId}=${record.choice.optionId}` : "";
	const findings = record.findings.length > 0 ? `; findings: ${record.findings.join(", ")}` : "";
	return `${record.stage}: recorded - scores ${scores}${choice}${findings}`;
}
