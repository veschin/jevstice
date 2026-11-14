/**
 * The single TypeSafe judge adapter (FR-08).
 *
 * One request carries the evaluated state and named questions; answers come back typed.
 * Choice and Score report confidence; Boolean reports only a yes probability, from which
 * decision certainty is derived.
 * The SDK returns no free prose, so nothing here invents an explanation.
 *
 * Fail-closed normalization: a malformed request is refused
 * before any call, and a missing key, a transport error, a missing answer, an unknown
 * choice label or a confidence outside [0, 1] produce `{ ok: false }`. Callers must treat
 * that as "no answer", never as approval.
 */
import { choice, noul, score, TypeSafeClient, type ChoiceCriteria, type EntryType, type Questions } from "@typesafe-ai/sdk";
import { POLICY, asRecord, type Evidence } from "./types.js";

/** The three question shapes the executor may choose from. */
type JudgeMode = "choice" | "score" | "noul";

/** One question as the activity authors it. */
export interface JudgeQuestion {
	name: string;
	mode: JudgeMode;
	/** The question the judge reads. */
	instructions: string;
	/** mode=choice: label -> what choosing it commits to (2..255 entries). */
	options?: Readonly<Record<string, string>>;
	/** mode=score: the rubric from level 0 up (2+ entries). */
	criteria?: readonly string[];
	/** mode=noul: what a yes means. */
	trueMeaning?: string;
	/** mode=noul: what a no means. */
	falseMeaning?: string;
}

/** One typed answer, keyed by its question name. */
export interface JudgeAnswer {
	name: string;
	mode: JudgeMode;
	/** mode=choice: the selected label. */
	label?: string;
	/** mode=score: the expected rubric value. */
	score?: number;
	/** mode=noul: probability of the true outcome. */
	probability?: number;
	/** Choice/Score report this; Boolean derives certainty from the yes probability. */
	confidence: number;
}

/**
 * The adapter's result: typed answers, or the problem that prevented a usable one. `kind` separates
 * the failures the executor must read differently (FR-20): `unavailable` is the judge failing to
 * answer (transport, authentication, a missing key), `unusable` is an answer that could not be read
 * or a request refused before the call. Neither counts as an approval; only `unavailable` counts
 * towards the availability bound (FR-21).
 */
export type JudgeOutcome =
	| { ok: true; answers: readonly JudgeAnswer[]; usage?: { inputTokens: number; outputTokens: number } }
	| { ok: false; problem: string; kind: JudgeFailureKind };

/** Why a judge answer could not be used (FR-20, FR-21). */
export type JudgeFailureKind = "unavailable" | "unusable";

/** Pure decision call. Tests inject a fake; production uses the TypeSafe client. */
export type Judge = (state: unknown, questions: readonly JudgeQuestion[]) => Promise<JudgeOutcome>;

/** The transport slice this adapter needs, so tests never touch the network. */
export interface SystemOneClient {
	systemOne(request: { state: EntryType; questions: Questions; model?: string }): Promise<unknown>;
}

/** Refuse a malformed request before it reaches the judge; undefined means the request is usable. */
export function questionProblem(questions: readonly JudgeQuestion[]): string | undefined {
	if (questions.length === 0) return "no questions were submitted";
	const names = new Set<string>();
	for (const [index, question] of questions.entries()) {
		if (question.name.length === 0) return `question ${index + 1} has no name`;
		if (names.has(question.name)) return `two questions share the name '${question.name}'`;
		names.add(question.name);
		if (question.instructions.trim().length === 0) return `question '${question.name}' has no instructions`;
		if (question.mode === "choice") {
			const options = Object.entries(question.options ?? {});
			if (options.length < 2) return `question '${question.name}' needs at least 2 alternatives, got ${options.length}`;
			if (options.length > 255) return `question '${question.name}' allows at most 255 alternatives, got ${options.length}`;
			for (const [label, meaning] of options) {
				if (label.trim().length === 0) return `question '${question.name}' has an empty alternative label`;
				if (meaning.trim().length === 0) return `question '${question.name}' alternative '${label}' has no meaning`;
			}
		}
		if (question.mode === "score") {
			const criteria = question.criteria ?? [];
			if (criteria.length < 2) return `question '${question.name}' needs at least 2 rubric steps, got ${criteria.length}`;
			const empty = criteria.findIndex(step => step.trim().length === 0);
			if (empty !== -1) return `question '${question.name}' rubric step ${empty + 1} is empty`;
		}
		if (question.mode === "noul") {
			if ((question.trueMeaning ?? "").trim().length === 0) return `question '${question.name}' does not say what yes means`;
			if ((question.falseMeaning ?? "").trim().length === 0) return `question '${question.name}' does not say what no means`;
		}
	}
	return undefined;
}

/** Build the SDK question map for a validated request. */
export function buildQuestions(questions: readonly JudgeQuestion[]): Questions {
	const built: Record<string, unknown> = {};
	for (const question of questions) {
		if (question.mode === "choice") {
			const criteria: Record<string, string> = {};
			for (const [label, meaning] of Object.entries(question.options ?? {})) criteria[label] = meaning;
			built[question.name] = choice(question.instructions, criteria as ChoiceCriteria);
			continue;
		}
		if (question.mode === "score") {
			const [first, second, ...rest] = question.criteria ?? [];
			if (first === undefined || second === undefined) continue;
			built[question.name] = score(question.instructions, [first, second, ...rest]);
			continue;
		}
		built[question.name] = noul(question.instructions, {
			true: question.trueMeaning ?? null,
			false: question.falseMeaning ?? null,
		});
	}
	return built as Questions;
}

function probability(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * Turn one SDK result into typed answers. Any deviation from the submitted question set is a
 * failed outcome: an answer that cannot be read is never an approval.
 */
export function normalizeAnswers(
	questions: readonly JudgeQuestion[],
	raw: unknown,
): JudgeOutcome {
	const envelope = asRecord(raw);
	const answers = asRecord(envelope?.["answers"]);
	const usageRecord = asRecord(envelope?.["usage"]);
	const inputTokens = usageRecord?.["input_tokens"];
	const outputTokens = usageRecord?.["output_tokens"];
	const usage =
		typeof inputTokens === "number" &&
		Number.isFinite(inputTokens) &&
		inputTokens >= 0 &&
		typeof outputTokens === "number" &&
		Number.isFinite(outputTokens) &&
		outputTokens >= 0
			? { inputTokens, outputTokens }
			: undefined;
	if (answers === undefined) return { ok: false, kind: "unusable", problem: "the judge response carries no answers" };
	const extra = Object.keys(answers).filter(name => !questions.some(question => question.name === name));
	if (extra.length > 0) return { ok: false, kind: "unusable", problem: `the judge answered questions that were not asked: ${extra.map(name => JSON.stringify(name)).join(", ")}` };

	const normalized: JudgeAnswer[] = [];
	for (const question of questions) {
		const answer = asRecord(answers[question.name]);
		if (answer === undefined) return { ok: false, kind: "unusable", problem: `the judge response has no answer for '${question.name}'` };
		if (question.mode === "noul") {
			if (answer["type"] !== "noul") return { ok: false, kind: "unusable", problem: `answer '${question.name}' is not a yes/no answer` };
			const yes = probability(answer["noul"]);
			if (yes === undefined) return { ok: false, kind: "unusable", problem: `answer '${question.name}' has no yes probability between 0 and 1` };
			normalized.push({ name: question.name, mode: "noul", probability: yes, confidence: Math.max(yes, 1 - yes) });
			continue;
		}
		const confidence = probability(answer["confidence"]);
		if (confidence === undefined) {
			return { ok: false, kind: "unusable", problem: `answer '${question.name}' has no confidence between 0 and 1` };
		}
		if (question.mode === "choice") {
			if (answer["type"] !== "choice") return { ok: false, kind: "unusable", problem: `answer '${question.name}' is not a choice answer` };
			const label = answer["choice"];
			if (typeof label !== "string") return { ok: false, kind: "unusable", problem: `answer '${question.name}' has no choice label` };
			if (!Object.hasOwn(question.options ?? {}, label)) {
				return { ok: false, kind: "unusable", problem: `answer '${question.name}' selected ${JSON.stringify(label)}, which was not offered` };
			}
			normalized.push({ name: question.name, mode: "choice", label, confidence });
			continue;
		}
		const value = answer["score"];
		if (answer["type"] !== "score") return { ok: false, kind: "unusable", problem: `answer '${question.name}' is not a score answer` };
		const highest = (question.criteria?.length ?? 0) - 1;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > highest) {
			return {
				ok: false,
				kind: "unusable",
				problem:
					typeof value === "number"
						? `answer '${question.name}' has score ${value}, outside the submitted rubric 0..${highest}`
						: `answer '${question.name}' has no numeric score; the submitted rubric runs 0..${highest}`,
			};
		}
		normalized.push({ name: question.name, mode: "score", score: value, confidence });
	}
	return { ok: true, answers: normalized, ...(usage === undefined ? {} : { usage }) };
}

/** The production transport: one TypeSafe client per resolved key, no body logging. */
function defaultClient(apiKey: string, model: string): SystemOneClient {
	return new TypeSafeClient({
		apiKey,
		defaultModel: model,
		logLevel: "off",
		timeout: 12000,
		retry: { maxRetries: 1 },
	});
}

/**
 * The production judge. The key resolves lazily on every call, so a resolver command failure
 * stays retryable and a missing key is reported as an unavailable judge instead of throwing.
 */
export function createTypeSafeJudge(deps: {
	resolveKey: () => Promise<string | undefined>;
	model?: string;
	createClient?: (apiKey: string, model: string) => SystemOneClient;
}): Judge {
	const model = deps.model ?? POLICY.defaultModel;
	const makeClient = deps.createClient ?? defaultClient;
	let client: SystemOneClient | undefined;
	let clientKey: string | undefined;
	return async (state, questions) => {
		const malformed = questionProblem(questions);
		if (malformed !== undefined) {
			return { ok: false, kind: "unusable", problem: `the judge request was refused before any call: ${malformed}` };
		}
		let key: string | undefined;
		try {
			key = await deps.resolveKey();
		} catch {
			key = undefined;
		}
		if (key === undefined) {
			return {
				ok: false,
				kind: "unavailable",
				problem: `no TypeSafe API key: set ${POLICY.apiKeyEnv} or ${POLICY.altApiKeyEnvs.join(" or ")}, or a command in ${POLICY.apiKeyCommandEnv}`,
			};
		}
		try {
			if (client === undefined || clientKey !== key) {
				client = makeClient(key, model);
				clientKey = key;
			}
			const raw = await client.systemOne({ state: state as EntryType, questions: buildQuestions(questions), model });
			return normalizeAnswers(questions, raw);
		} catch {
			return { ok: false, kind: "unavailable", problem: "the judge service did not answer (transport, authentication or service error)" };
		}
	};
}

/** The typed answer for one question, or undefined when the outcome is unusable. */
export function answerOf(outcome: JudgeOutcome, name: string): JudgeAnswer | undefined {
	if (!outcome.ok) return undefined;
	return outcome.answers.find(answer => answer.name === name);
}

/** True when the judge selected `label` at or above the approval floor. */
export function choseLabel(
	outcome: JudgeOutcome,
	name: string,
	label: string,
	floor: number = POLICY.minConfidenceToApprove,
): boolean {
	const answer = answerOf(outcome, name);
	if (answer === undefined || answer.mode !== "choice") return false;
	return answer.label === label && answer.confidence >= floor;
}

/** The probability a boolean question reported, or undefined when unusable. */
export function probabilityOf(outcome: JudgeOutcome, name: string): number | undefined {
	const answer = answerOf(outcome, name);
	return answer?.mode === "noul" ? answer.probability : undefined;
}

/** The rubric value a score question reported, or undefined when unusable. */
export function scoreOf(outcome: JudgeOutcome, name: string): number | undefined {
	const answer = answerOf(outcome, name);
	return answer?.mode === "score" ? answer.score : undefined;
}

/** True when a boolean question's probability reaches the approval floor. */
export function saidTrue(
	outcome: JudgeOutcome,
	name: string,
	floor: number = POLICY.minProbabilityToApprove,
): boolean {
	const value = probabilityOf(outcome, name);
	return value !== undefined && value >= floor;
}

/** Quote list rendered for the evaluated state; `undefined` and empty quotes are dropped. */
export function renderEvidence(evidence: readonly Evidence[]): string[] {
	const rendered: string[] = [];
	for (const item of evidence) {
		const quote = item.quote.trim();
		if (quote.length === 0) continue;
		rendered.push(item.source === undefined || item.source.length === 0 ? `[${item.kind}] ${quote}` : `[${item.kind} ${item.source}] ${quote}`);
	}
	return rendered;
}
