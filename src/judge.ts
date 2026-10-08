/**
 * The single TypeSafe judge adapter (FR-08).
 *
 * One request carries the evaluated state and named questions; answers come back typed.
 * Choice and Score report confidence; Boolean reports only a yes probability, from which
 * decision certainty is derived.
 * The SDK returns no free prose, so nothing here invents an explanation.
 *
 * Fail-closed normalization (POLICY.failureNeverApproves): a malformed request is refused
 * before any call, and a missing key, a transport error, a missing answer, an unknown
 * choice label or a confidence outside [0, 1] produce `{ ok: false }`. Callers must treat
 * that as "no answer", never as approval.
 */
import { choice, noul, score, TypeSafeClient, type ChoiceCriteria, type EntryType, type Questions } from "@typesafe-ai/sdk";
import { POLICY, asRecord, type Evidence } from "./types.js";

/** The three question shapes the executor may choose from. */
export type JudgeMode = "choice" | "score" | "noul";

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

/** The adapter's result: typed answers, or the problem that prevented a usable one. */
export type JudgeOutcome =
	| { ok: true; model: string; answers: readonly JudgeAnswer[] }
	| { ok: false; problem: string };

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
	for (const question of questions) {
		if (question.name.length === 0) return "a question has no name";
		if (names.has(question.name)) return `two questions share the name '${question.name}'`;
		names.add(question.name);
		if (question.instructions.trim().length === 0) return `question '${question.name}' carries no text`;
		if (question.mode === "choice") {
			const options = Object.entries(question.options ?? {});
			if (options.length < 2) return `question '${question.name}' offers fewer than two alternatives`;
			if (options.length > 255) return `question '${question.name}' offers more than 255 alternatives`;
			for (const [label, meaning] of options) {
				if (label.trim().length === 0) return `question '${question.name}' has an empty label`;
				if (meaning.trim().length === 0) return `alternative '${label}' states no meaning`;
			}
		}
		if (question.mode === "score") {
			const criteria = question.criteria ?? [];
			if (criteria.length < 2) return `question '${question.name}' has fewer than two rubric steps`;
			if (criteria.some(step => step.trim().length === 0)) {
				return `question '${question.name}' has an empty rubric step`;
			}
		}
		if (question.mode === "noul") {
			if ((question.trueMeaning ?? "").trim().length === 0) return `question '${question.name}' does not state what yes means`;
			if ((question.falseMeaning ?? "").trim().length === 0) return `question '${question.name}' does not state what no means`;
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
	const model = typeof envelope?.["model"] === "string" ? envelope["model"] : POLICY.defaultModel;
	const answers = asRecord(envelope?.["answers"]);
	if (answers === undefined) return { ok: false, problem: "the judge returned no answers" };
	const extra = Object.keys(answers).filter(name => !questions.some(question => question.name === name));
	if (extra.length > 0) return { ok: false, problem: `the judge answered unknown questions: ${extra.join(", ")}` };

	const normalized: JudgeAnswer[] = [];
	for (const question of questions) {
		const answer = asRecord(answers[question.name]);
		if (answer === undefined) return { ok: false, problem: `the judge returned no answer for '${question.name}'` };
		if (question.mode === "noul") {
			const yes = probability(answer["noul"]);
			if (answer["type"] !== "noul" || yes === undefined) return { ok: false, problem: `answer '${question.name}' carries no probability` };
			normalized.push({ name: question.name, mode: "noul", probability: yes, confidence: Math.max(yes, 1 - yes) });
			continue;
		}
		const confidence = probability(answer["confidence"]);
		if (confidence === undefined) {
			return { ok: false, problem: `answer '${question.name}' reports no usable confidence` };
		}
		if (question.mode === "choice") {
			const label = answer["choice"];
			if (typeof label !== "string" || !Object.hasOwn(question.options ?? {}, label)) {
				return { ok: false, problem: `answer '${question.name}' selected a label that was not offered` };
			}
			normalized.push({ name: question.name, mode: "choice", label, confidence });
			continue;
		}
		const value = answer["score"];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > (question.criteria?.length ?? 0) - 1) {
			return { ok: false, problem: `answer '${question.name}' carries a score outside the submitted rubric` };
		}
		normalized.push({ name: question.name, mode: "score", score: value, confidence });
	}
	return { ok: true, model, answers: normalized };
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
 * stays retryable and a missing key is reported as an unusable answer instead of throwing.
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
		if (malformed !== undefined) return { ok: false, problem: malformed };
		let key: string | undefined;
		try {
			key = await deps.resolveKey();
		} catch {
			key = undefined;
		}
		if (key === undefined) {
			return {
				ok: false,
				problem: `no TypeSafe API key (${POLICY.apiKeyEnv}, ${POLICY.altApiKeyEnvs.join(", ")} or a resolver in ${POLICY.apiKeyCommandEnv})`,
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
			return { ok: false, problem: "the judge call failed (transport, authentication or service error)" };
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
		const trimmed = item.quote.trim();
		const quote = trimmed.length > POLICY.maxQuoteChars ? trimmed.slice(0, POLICY.maxQuoteChars) : trimmed;
		if (quote.length === 0) continue;
		rendered.push(item.source === undefined || item.source.length === 0 ? `[${item.kind}] ${quote}` : `[${item.kind} ${item.source}] ${quote}`);
	}
	return rendered;
}
