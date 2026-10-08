import { describe, expect, test } from "bun:test";
import {
	answerOf,
	buildQuestions,
	choseLabel,
	createTypeSafeJudge,
	normalizeAnswers,
	probabilityOf,
	questionProblem,
	saidTrue,
	scoreOf,
	type JudgeQuestion,
	type SystemOneClient,
} from "../src/judge.js";
import { POLICY } from "../src/types.js";

function transportReturning(payload: unknown): { client: SystemOneClient; requests: unknown[] } {
	const requests: unknown[] = [];
	const client: SystemOneClient = {
		systemOne: async request => {
			requests.push(request);
			return payload;
		},
	};
	return { client, requests };
}

const DECISION: JudgeQuestion = {
	name: "decision",
	mode: "choice",
	instructions: "Which alternative does the quoted evidence support?",
	options: { keep: "keep the current design", replace: "replace it" },
};

const EFFORT: JudgeQuestion = {
	name: "effort",
	mode: "score",
	instructions: "How much effort does the change take?",
	criteria: ["none", "small", "large"],
};

const WORTH: JudgeQuestion = {
	name: "worth",
	mode: "noul",
	instructions: "Is the change worth doing?",
	trueMeaning: "worth doing now",
	falseMeaning: "not worth doing now",
};

const THREE_MODES = [DECISION, EFFORT, WORTH];

describe("T1 - the judge adapter returns typed answers", () => {
	test("FR-08: choice, score and boolean each return their typed answer with the reported confidence", async () => {
		const { client, requests } = transportReturning({
			model: "jev-latest",
			answers: {
				decision: { type: "choice", choice: "replace", confidence: 0.91, probabilities: { keep: 0.09, replace: 0.91 } },
				effort: { type: "score", score: 1.6, confidence: 0.88, probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 }, legend: {} },
				worth: { type: "noul", noul: 0.93 },
			},
		});
		const judge = createTypeSafeJudge({ resolveKey: async () => "key", createClient: () => client });

		const outcome = await judge({ task: "replace the parser" }, THREE_MODES);

		expect(outcome.ok).toBe(true);
		expect(requests).toHaveLength(1);
		expect(choseLabel(outcome, "decision", "replace")).toBe(true);
		expect(choseLabel(outcome, "decision", "keep")).toBe(false);
		expect(scoreOf(outcome, "effort")).toBeCloseTo(1.6);
		expect(probabilityOf(outcome, "worth")).toBeCloseTo(0.93);
		expect(saidTrue(outcome, "worth")).toBe(true);
		expect(answerOf(outcome, "decision")?.confidence).toBeCloseTo(0.91);
	});

	test("FR-08: the submitted criteria reach the wire and no answer invents prose", async () => {
		const { client, requests } = transportReturning({
			model: "jev-latest",
			answers: {
				decision: { type: "choice", choice: "keep", confidence: 0.9, probabilities: {} },
				effort: { type: "score", score: 0, confidence: 0.9, probabilities: {}, legend: {} },
				worth: { type: "noul", noul: 0.9 },
			},
		});
		const judge = createTypeSafeJudge({ resolveKey: async () => "key", createClient: () => client });
		const outcome = await judge("material", THREE_MODES);
		const sent = requests[0] as {
			model: string;
			state: unknown;
			questions: Record<string, { type: string; instructions?: string; criteria?: unknown }>;
		};

		expect(sent.model).toBe(POLICY.defaultModel);
		expect(sent.state).toBe("material");
		expect(sent.questions["decision"]?.type).toBe("choice");
		expect(sent.questions["decision"]?.criteria).toEqual({ keep: "keep the current design", replace: "replace it" });
		expect(sent.questions["effort"]?.type).toBe("score");
		expect(sent.questions["effort"]?.criteria).toEqual(["none", "small", "large"]);
		expect(sent.questions["worth"]?.type).toBe("noul");
		expect(sent.questions["worth"]?.criteria).toEqual({ true: "worth doing now", false: "not worth doing now" });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// The answers carry the typed selection only - there is no explanation field to invent one in.
		expect(Object.keys(outcome.answers[0] ?? {}).sort()).toEqual(["confidence", "label", "mode", "name"]);
	});

	test("T1: the adapter makes no judge call before it is invoked", async () => {
		const { client, requests } = transportReturning({ model: "m", answers: {} });
		const judge = createTypeSafeJudge({ resolveKey: async () => "key", createClient: () => client });

		expect(requests).toHaveLength(0);
		await judge({}, [DECISION]);
		expect(requests).toHaveLength(1);
	});
});

describe("T1 - fail-closed normalization", () => {
	test("POLICY.failureNeverApproves: a missing key never reaches the transport and never approves", async () => {
		const { client, requests } = transportReturning({ model: "m", answers: {} });
		const judge = createTypeSafeJudge({ resolveKey: async () => undefined, createClient: () => client });

		const outcome = await judge({}, THREE_MODES);

		expect(outcome.ok).toBe(false);
		expect(requests).toHaveLength(0);
	});

	test("POLICY.failureNeverApproves: the key is handed to the client and never enters the request", async () => {
		const { client, requests } = transportReturning({
			model: "m",
			answers: { decision: { type: "choice", choice: "keep", confidence: 0.9 }, effort: { type: "score", score: 0 }, worth: { type: "noul", noul: 0.9 } },
		});
		const keys: string[] = [];
		const judge = createTypeSafeJudge({
			resolveKey: async () => "secret-key",
			createClient: key => {
				keys.push(key);
				return client;
			},
		});

		await judge({ task: "x" }, THREE_MODES);

		expect(keys).toEqual(["secret-key"]);
		expect(JSON.stringify(requests[0])).not.toContain("secret-key");
	});

	test("POLICY.failureNeverApproves: malformed answers never approve", () => {
		const cases: Array<[string, unknown]> = [
			["no answers key", { model: "m" }],
			["missing answer", { model: "m", answers: { effort: { type: "score", score: 1, confidence: 0.9 }, worth: { type: "noul", noul: 0.9 } } }],
			["unknown choice label", { model: "m", answers: { decision: { type: "choice", choice: "maybe", confidence: 0.9 }, effort: { type: "score", score: 1, confidence: 0.9 }, worth: { type: "noul", noul: 0.9 } } }],
			["confidence outside [0,1]", { model: "m", answers: { decision: { type: "choice", choice: "keep", confidence: 1.4 }, effort: { type: "score", score: 1, confidence: 0.9 }, worth: { type: "noul", noul: 0.9 } } }],
			["answer for a question that was not asked", { model: "m", answers: { other: { type: "noul", noul: 0.9 }, decision: { type: "choice", choice: "keep", confidence: 0.9 }, effort: { type: "score", score: 1, confidence: 0.9 }, worth: { type: "noul", noul: 0.9 } } }],
			["score missing", { model: "m", answers: { decision: { type: "choice", choice: "keep", confidence: 0.9 }, effort: { type: "score", confidence: 0.9 }, worth: { type: "noul", noul: 0.9 } } }],
		];
		for (const [name, payload] of cases) {
			const outcome = normalizeAnswers(THREE_MODES, payload);
			expect(`${name}: ${outcome.ok}`).toBe(`${name}: false`);
		}
	});

	test("FR-08: a confident Boolean no remains a usable answer without approving yes", () => {
		const outcome = normalizeAnswers([WORTH], { model: "m", answers: { worth: { type: "noul", noul: 0.02 } } });
		expect(outcome.ok).toBe(true);
		expect(answerOf(outcome, "worth")?.confidence).toBeCloseTo(0.98);
		expect(saidTrue(outcome, "worth")).toBe(false);
	});

	test("POLICY.failureNeverApproves: reject unsupported Boolean fields and scores outside the rubric", () => {
		const unsupportedBoolean = normalizeAnswers([WORTH], { model: "m", answers: { worth: { boolean: 0.99 } } });
		const outsideRubric = normalizeAnswers([EFFORT], { model: "m", answers: { effort: { type: "score", score: 3, confidence: 0.99 } } });
		expect(unsupportedBoolean.ok).toBe(false);
		expect(outsideRubric.ok).toBe(false);
	});

	test("POLICY.failureNeverApproves: a transport error never echoes the API key", async () => {
		const judge = createTypeSafeJudge({
			resolveKey: async () => "secret-key",
			createClient: () => ({
				systemOne: async () => { throw new Error("authentication rejected secret-key"); },
			}),
		});
		const outcome = await judge({}, [DECISION]);
		expect(outcome.ok).toBe(false);
		expect(JSON.stringify(outcome)).not.toContain("secret-key");
	});

	test("POLICY.failureNeverApproves: a malformed request is refused before any call", async () => {
		const { client, requests } = transportReturning({ model: "m", answers: {} });
		const judge = createTypeSafeJudge({ resolveKey: async () => "key", createClient: () => client });

		const outcome = await judge({}, [{ name: "single", mode: "choice", instructions: "?", options: { only: "one alternative" } }]);

		expect(outcome.ok).toBe(false);
		expect(requests).toHaveLength(0);
		expect(questionProblem([])).toBeDefined();
		expect(questionProblem([{ name: "x", mode: "noul", instructions: "?", trueMeaning: "yes" }])).toBeDefined();
		expect(questionProblem(THREE_MODES)).toBeUndefined();
	});

	test("POLICY.failureNeverApproves: a transport failure never approves", async () => {
		const judge = createTypeSafeJudge({
			resolveKey: async () => "key",
			createClient: () => ({
				systemOne: async () => {
					throw new Error("socket reset");
				},
			}),
		});

		const outcome = await judge({}, THREE_MODES);

		expect(outcome.ok).toBe(false);
	});

	test("POLICY.failureNeverApproves: an answer below the floor is not an approval", () => {
		const low = normalizeAnswers(THREE_MODES, {
			model: "m",
			answers: {
				decision: { type: "choice", choice: "keep", confidence: POLICY.minConfidenceToApprove - 0.01 },
				effort: { type: "score", score: 1, confidence: 0.9 },
				worth: { type: "noul", noul: POLICY.minProbabilityToApprove - 0.01 },
			},
		});
		const atFloor = normalizeAnswers(THREE_MODES, {
			model: "m",
			answers: {
				decision: { type: "choice", choice: "keep", confidence: POLICY.minConfidenceToApprove },
				effort: { type: "score", score: 1, confidence: 0.9 },
				worth: { type: "noul", noul: POLICY.minProbabilityToApprove },
			},
		});

		expect(choseLabel(low, "decision", "keep")).toBe(false);
		expect(saidTrue(low, "worth")).toBe(false);
		expect(choseLabel(atFloor, "decision", "keep")).toBe(true);
		expect(saidTrue(atFloor, "worth")).toBe(true);
	});

	test("the question builder rejects an oversized choice set", () => {
		const options: Record<string, string> = {};
		for (let index = 0; index < 256; index += 1) options[`option_${index}`] = `meaning ${index}`;
		expect(questionProblem([{ name: "big", mode: "choice", instructions: "?", options }])).toBeDefined();
		expect(Object.keys(buildQuestions([DECISION]))).toEqual(["decision"]);
	});
});
