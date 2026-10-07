import { describe, expect, test } from "bun:test";
import type { DecisionRequest, DecisionOption, MultiLabelRequest } from "../src/types";
import { createJudge, createMultiLabelJudge, JevApiError } from "../src/client";

const okOptions: DecisionOption[] = [
  { id: "approve", label: "Approve", meaning: "proposal is complete and correct" },
  { id: "reject", label: "Reject", meaning: "proposal misses the task" },
];

const okReq: DecisionRequest = {
  stage: "completion_review",
  task: "Implement foo()",
  proposal: "foo() returns 42, tested by foo.test.ts",
  options: okOptions,
  evidence: [
    { kind: "user", source: "user", quote: "implement foo returning 42" },
    {
      kind: "execution",
      source: "bun test output",
      quote: "foo.test.ts:\nexpect(foo()).toBe(42)\n1 pass",
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function judgeVerdictBody(verdict: string, confidence: number) {
  return {
    model: "jev-1.13.0",
    answers: {
      option: {
        type: "choice",
        choice: "approve",
        probabilities: { approve: 0.9, reject: 0.1 },
        confidence,
      },
      verdict: {
        type: "choice",
        choice: verdict,
        probabilities: {
          approve: verdict === "approve" ? 0.9 : 0.1,
          revise: verdict === "revise" ? 0.6 : 0.1,
          insufficient_evidence: verdict === "insufficient_evidence" ? 0.6 : 0.05,
          ask_user: verdict === "ask_user" ? 0.6 : 0.0,
        },
        confidence,
      },
    },
    usage: { input_tokens: 300, output_tokens: 30 },
  };
}

function okResponse(): Response {
  return jsonResponse(judgeVerdictBody("approve", 0.85));
}

function fetchOk(calls?: { body?: unknown }[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (calls) calls.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
    return okResponse();
  }) as unknown as typeof fetch;
}

const baseConfig = { apiKey: "test-key", fetchFn: fetchOk(), retryDelayMs: 0 };

describe("client: happy path", () => {
  test("maps choice answers to DecisionResult with selectedOption and confidence", async () => {
    const judge = createJudge(baseConfig);
    const result = await judge(okReq);
    expect(result.verdict).toBe("approve");
    expect(result.selectedOption).toBe("approve");
    expect(result.confidence).toBe(0.85);
    expect(Array.isArray(result.reasons)).toBe(true);
  });

  test("non-approve verdict passes through with its reason code", async () => {
    const fetchFn = (async () => jsonResponse(judgeVerdictBody("revise", 0.85))) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    const result = await judge(okReq);
    expect(result.verdict).toBe("revise");
  });

  test("SDK transport construction: URL root derived, bearer key in header only", async () => {
    const calls: { url?: unknown; headers?: unknown; body?: unknown }[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url,
        headers: init?.headers,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return okResponse();
    }) as unknown as typeof fetch;
    const judge = createJudge({
      apiKey: "k-test",
      apiUrl: "https://api.example.test/v1/systemone",
      fetchFn,
    });
    await judge(okReq);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/systemone");
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer k-test");
    // model resolved by the SDK from defaultModel
    expect((calls[0]!.body as Record<string, unknown>)["model"]).toBe("jev-latest");
  });

  test("sends systemone request with model, state and both questions", async () => {
    const calls: { body?: unknown }[] = [];
    const judge = createJudge({ ...baseConfig, fetchFn: fetchOk(calls) });
    await judge(okReq);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body["model"]).toBe("jev-latest");
    const questions = body["questions"] as Record<string, unknown>;
    expect(Object.keys(questions).sort()).toEqual(["option", "verdict"]);
    // state carries evidence verbatim
    const state = JSON.stringify(body["state"]);
    expect(state).toContain("implement foo returning 42");
  });
});

describe("client: request validation (boundary)", () => {
  test("rejects fewer than two options", async () => {
    const judge = createJudge(baseConfig);
    await expect(judge({ ...okReq, options: [] })).rejects.toBeInstanceOf(JevApiError);
    await expect(judge({ ...okReq, options: [okOptions[0]!] })).rejects.toBeInstanceOf(
      JevApiError,
    );
  });

  test("rejects more than 255 options", async () => {
    const judge = createJudge(baseConfig);
    const options = Array.from({ length: 256 }, (_, i) => ({
      id: `opt${i}`,
      label: `o${i}`,
      meaning: "m",
    }));
    await expect(judge({ ...okReq, options })).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects duplicate option ids", async () => {
    const judge = createJudge(baseConfig);
    await expect(
      judge({ ...okReq, options: [okOptions[0]!, okOptions[0]!] }),
    ).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects option missing meaning (rubric required for Choice criteria)", async () => {
    const judge = createJudge(baseConfig);
    await expect(
      judge({
        ...okReq,
        options: [
          { id: "approve", label: "Approve", meaning: "" },
          okOptions[1]!,
        ],
      }),
    ).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects evidence with empty quote (no fabricated or empty quotes)", async () => {
    const judge = createJudge(baseConfig);
    await expect(
      judge({ ...okReq, evidence: [{ kind: "user", source: "user", quote: "   " }] }),
    ).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects evidence with empty source (provenance required)", async () => {
    const judge = createJudge(baseConfig);
    await expect(
      judge({ ...okReq, evidence: [{ kind: "user", source: "", quote: "x" }] }),
    ).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects empty evidence list", async () => {
    const judge = createJudge(baseConfig);
    await expect(judge({ ...okReq, evidence: [] })).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects empty stage/task/proposal", async () => {
    const judge = createJudge(baseConfig);
    await expect(judge({ ...okReq, stage: "" as never })).rejects.toBeInstanceOf(JevApiError);
    await expect(judge({ ...okReq, task: "" })).rejects.toBeInstanceOf(JevApiError);
    await expect(judge({ ...okReq, proposal: "" })).rejects.toBeInstanceOf(JevApiError);
  });
});

describe("client: malformed and uncertain responses", () => {
  test("never treats a confidence-less choice answer as approval", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          option: { type: "choice", choice: "approve", probabilities: { approve: 1.0 } },
          verdict: { type: "choice", choice: "approve", probabilities: { approve: 1.0 } },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    await expect(judge(okReq)).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects unknown answer type", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { option: { type: "poem" }, verdict: { type: "poem" } },
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    await expect(judge(okReq)).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects missing answer for a question id", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          option: {
            type: "choice",
            choice: "approve",
            probabilities: { approve: 0.9, reject: 0.1 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    await expect(judge(okReq)).rejects.toBeInstanceOf(JevApiError);
  });

  test("rejects choice answer naming an option that was never offered", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          option: {
            type: "choice",
            choice: "hallucinated_option",
            probabilities: { approve: 0.5, reject: 0.5 },
            confidence: 0.9,
          },
          verdict: {
            type: "choice",
            choice: "approve",
            probabilities: { approve: 1.0 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    await expect(judge(okReq)).rejects.toBeInstanceOf(JevApiError);
  });

  test("demotes low-confidence approve to insufficient_evidence with reason code", async () => {
    const fetchFn = (async () =>
      jsonResponse(judgeVerdictBody("approve", 0.2))) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    const result = await judge(okReq);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.reasons).toContain("low_confidence");
  });

  test("respects configurable minConfidence", async () => {
    const fetchFn = (async () => jsonResponse(judgeVerdictBody("revise", 0.55))) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn, minConfidence: 0.5 });
    const result = await judge(okReq);
    expect(result.verdict).toBe("revise");
  });

  test("AC4d uncertainty probe: confidence 0.7 approve never approves", async () => {
    const fetchFn = (async () => jsonResponse(judgeVerdictBody("approve", 0.7))) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    const result = await judge(okReq);
    expect(result.verdict).not.toBe("approve");
    expect(result.verdict).toBe("insufficient_evidence");
  });
  test("template options become the accepted selectedOption set", async () => {
    const fetchFn = (async () => {
      const body = judgeVerdictBody("approve", 0.9);
      body.answers.option.choice = "ship";
      return jsonResponse(body);
    }) as unknown as typeof fetch;
    const judge = createJudge({
      ...baseConfig,
      fetchFn,
      stages: {
        completion_review: {
          options: [
            { id: "ship", label: "Ship", meaning: "merge it" },
            { id: "hold", label: "Hold", meaning: "do not merge" },
          ],
        },
      },
    });
    const result = await judge(okReq);
    expect(result.selectedOption).toBe("ship");
  });

  test("invalid template options fail closed with validation codes", async () => {
    let called = 0;
    const fetchFn = (async () => {
      called++;
      return okResponse();
    }) as unknown as typeof fetch;
    const judge = createJudge({
      ...baseConfig,
      fetchFn,
      stages: { completion_review: { options: [{ id: "only", label: "Only", meaning: "" }] } },
    });
    await expect(judge(okReq)).rejects.toBeInstanceOf(JevApiError);
    expect(called).toBe(0);
  });
});

describe("client: API auth and error behavior", () => {
  test("401 raises auth error without retry", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return jsonResponse({ error: "unauthorized" }, 401);
    }) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    const err = await judge(okReq).catch((e) => e);
    expect(err).toBeInstanceOf(JevApiError);
    expect((err as JevApiError).code).toBe("auth");
    expect(calls).toBe(1);
  });

  test("422 raises invalid_request with server detail, no retry", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return jsonResponse({ error: "malformed question", field: "questions.verdict" }, 422);
    }) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    const err = (await judge(okReq).catch((e) => e)) as JevApiError;
    expect(err.code).toBe("invalid_request");
    expect(calls).toBe(1);
    expect(String(err.message)).toContain("malformed question");
  });

  test("429 retries with backoff then succeeds", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      const status = calls++ === 0 ? 429 : 200;
      return jsonResponse(okRespBody(), status);
    }) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn, maxRetries: 2 });
    const result = await judge(okReq);
    expect(result.verdict).toBe("approve");
    expect(calls).toBe(2);
  });

  test("529 exhausts retries and raises rate_limited", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return jsonResponse({}, 529);
    }) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn, maxRetries: 2 });
    const err = (await judge(okReq).catch((e) => e)) as JevApiError;
    expect(err.code).toBe("rate_limited");
    expect(calls).toBe(3); // initial + 2 retries
  });

  test("network failure raises transport error", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    const err = (await judge(okReq).catch((e) => e)) as JevApiError;
    expect(err.code).toBe("transport");
  });

  test("non-JSON error body raises unexpected_status with status", async () => {
    const fetchFn = (async () =>
      new Response("<html>gateway error</html>", { status: 502 })) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn });
    const err = (await judge(okReq).catch((e) => e)) as JevApiError;
    expect(err.code).toBe("unexpected_status");
    expect(err.status).toBe(502);
  });

  test("Bun TimeoutError DOMException is a timeout, not transport", async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out", "TimeoutError")),
        );
      });
    }) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn, timeoutMs: 20 });
    const err = (await judge(okReq).catch((e) => e)) as JevApiError;
    expect(err.code).toBe("timeout");
  });

  test("timeout raises timeout error", async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, fetchFn, timeoutMs: 20 });
    const err = (await judge(okReq).catch((e) => e)) as JevApiError;
    expect(err.code).toBe("timeout");
  });

  test("missing api key raises config error without any call", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return okResponse();
    }) as unknown as typeof fetch;
    const judge = createJudge({ ...baseConfig, apiKey: "", fetchFn });
    await expect(judge(okReq)).rejects.toBeInstanceOf(JevApiError);
    expect(calls).toBe(0);
  });
});

function okRespBody() {
  return judgeVerdictBody("approve", 0.85);
}

// ---------- createMultiLabelJudge (FR-04 topic selection) ----------

function noulAnswers(map: Record<string, number>) {
  return {
    model: "jev-1.13.0",
    answers: Object.fromEntries(
      Object.entries(map).map(([id, p]) => [id, { type: "noul", noul: p }]),
    ),
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

const okMulti: MultiLabelRequest = {
  stage: "topic_selection",
  task: "Mark applicable topics.",
  evidence: [{ kind: "user", source: "user", quote: "etl pipeline with large tables" }],
  items: [
    { id: "sharding", text: "Sharding for large datasets" },
    { id: "logging", text: "Structured logging" },
  ],
};

describe("multi-label judge", () => {
  test("maps noul answers to applicable flags with verdict approve", async () => {
    const calls: unknown[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(init?.body as string));
      return jsonResponse(noulAnswers({ sharding: 0.98, logging: 0.15 }));
    }) as unknown as typeof fetch;
    const judge = createMultiLabelJudge({ apiKey: "k", fetchFn });
    const result = await judge(okMulti);
    expect(result.verdict).toBe("approve");
    expect(result.applicable).toEqual({ sharding: true, logging: false });
  });

  test("255 items -> exactly one systemone request; 256 items -> two shards", async () => {
    const idsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, text: "x" }));
    let calls = 0;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(init?.body as string);
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]),
      );
      return jsonResponse({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }) as unknown as typeof fetch;
    const judge = createMultiLabelJudge({ apiKey: "k", fetchFn });
    await judge({ ...okMulti, items: idsOf(255) });
    expect(calls).toBe(1);
    calls = 0;
    await judge({ ...okMulti, items: idsOf(256) });
    expect(calls).toBe(2);
  });

  test("unknown answer id or missing id -> insufficient_evidence, fail closed", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { sharding: { type: "noul", noul: 0.9 }, extra: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as unknown as typeof fetch;
    const judge = createMultiLabelJudge({ apiKey: "k", fetchFn });
    const result = await judge(okMulti);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.reasons).toContain("bad_payload");
  });

  test("non-noul answer type -> insufficient_evidence, fail closed", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          sharding: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 0.9 },
          logging: { type: "noul", noul: 0.5 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as unknown as typeof fetch;
    const judge = createMultiLabelJudge({ apiKey: "k", fetchFn });
    const result = await judge(okMulti);
    expect(result.verdict).toBe("insufficient_evidence");
  });

  test("documented thresholds: 0.98 -> true, 0.15 -> false; empty items -> approve {}", async () => {
    const fetchFn = (async () =>
      jsonResponse(noulAnswers({}))) as unknown as typeof fetch;
    const judge = createMultiLabelJudge({ apiKey: "k", fetchFn });
    const result = await judge({ ...okMulti, items: [] });
    expect(result.verdict).toBe("approve");
    expect(result.applicable).toEqual({});
  });

  test("same validation as single-decision: empty evidence rejected", async () => {
    const judge = createMultiLabelJudge({ apiKey: "k", fetchFn: fetchOk() });
    await expect(judge({ ...okMulti, evidence: [] })).rejects.toBeInstanceOf(JevApiError);
  });
});
