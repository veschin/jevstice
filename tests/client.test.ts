import { describe, expect, test } from "bun:test";
import type { DecisionRequest, DecisionOption, MultiLabelRequest, AspectCoverageRequest } from "../src/types";
import { POLICY } from "../src/types";
import { createJudge, createMultiLabelJudge, createAspectCoverageJudge, JevApiError } from "../src/client";
import { buildRequestBody, META_REASON_CRITERIA, SERVICE_OPTION_CRITERIA } from "../src/evidence";

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
    expect(Object.keys(questions).sort()).toEqual(["meta_reason", "option", "verdict"]);
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

// ---------- createCourseCheckJudge (universal decision-point: course_check preset) ----------

import { createCourseCheckJudge } from "../src/client";
import {
  COURSE_CHECK_NEXT_ACTIONS,
  type CourseCheckRequest,
  type CourseCheckResult,
} from "../src/types";

const okCourse: CourseCheckRequest = {
  requirements: [
    { id: "req-1", quote: "POST /login returns a JWT." },
    { id: "req-2", quote: "Failures return 401." },
  ],
  currentAction: "Implemented handler, adding tests",
  evidence: [{ kind: "code", source: "src/login.ts:10", quote: "return sign(payload, secret);" }],
};

function courseBody(noul: Record<string, number>, action: string, confidence: number) {
  return {
    model: "jev-1.13.0",
    answers: {
      ...Object.fromEntries(
        Object.entries(noul).map(([id, p]) => [id, { type: "noul", noul: p }]),
      ),
      next_action: {
        type: "choice",
        choice: action,
        probabilities: Object.fromEntries(
          COURSE_CHECK_NEXT_ACTIONS.map((a) => [a, a === action ? 0.9 : 0.01]),
        ),
        confidence,
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function courseFetch(noul: Record<string, number>, action: string, confidence: number) {
  return (async () =>
    jsonResponse(courseBody(noul, action, confidence))) as unknown as typeof fetch;
}

describe("course check judge", () => {
  test("one systemone request: noul per requirement + next_action choice", async () => {
    const calls: { body?: unknown }[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) });
      return jsonResponse(courseBody({ "req-1": 0.95, "req-2": 0.2 }, "continue", 0.9));
    }) as unknown as typeof fetch;
    const judge = createCourseCheckJudge({ apiKey: "k", fetchFn });
    const result: CourseCheckResult = await judge(okCourse);
    expect(calls).toHaveLength(1);
    const questions = (calls[0]!.body as { questions: Record<string, unknown> }).questions;
    expect(Object.keys(questions).sort()).toEqual([
      "meta_reason",
      "next_action",
      "req-1",
      "req-2",
    ]);
    expect(result.judged).toBe(true);
    expect(result.onTrack).toEqual({ "req-1": true, "req-2": false });
    expect(result.nextAction).toBe("continue");
  });

  test("requirement quotes verbatim in state only", async () => {
    const calls: { body?: unknown }[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) });
      return jsonResponse(courseBody({ "req-1": 0.9 }, "continue", 0.9));
    }) as unknown as typeof fetch;
    const judge = createCourseCheckJudge({ apiKey: "k", fetchFn });
    await judge({ ...okCourse, requirements: [{ id: "req-1", quote: "VERBATIM_QUOTE_MARKER" }] });
    const body = calls[0]!.body as {
      state: unknown;
      questions: Record<string, { instructions: unknown }>;
    };
    expect(JSON.stringify(body.state)).toContain("VERBATIM_QUOTE_MARKER");
    expect(JSON.stringify(body.questions["next_action"]!.instructions)).not.toContain(
      "VERBATIM_QUOTE_MARKER",
    );
  });

  test("contract violation (unknown id) -> judged:false, never auto-continue", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          "req-1": { type: "noul", noul: 0.9 },
          extra: { type: "noul", noul: 0.1 },
          next_action: {
            type: "choice",
            choice: "continue",
            probabilities: { continue: 1 },
            confidence: 0.9,
          },
        },
        usage: {},
      })) as unknown as typeof fetch;
    const judge = createCourseCheckJudge({ apiKey: "k", fetchFn });
    const result = await judge(okCourse);
    expect(result.judged).toBe(false);
    expect(result.reasons).toContain("bad_payload");
    expect(result.nextAction).not.toBe("continue");
  });

  test("low-confidence next_action -> verify_before_proceeding, never continue", async () => {
    const judge = createCourseCheckJudge({
      apiKey: "k",
      fetchFn: courseFetch({ "req-1": 0.9, "req-2": 0.9 }, "continue", 0.5),
    });
    const result = await judge(okCourse);
    expect(result.judged).toBe(true);
    expect(result.nextAction).toBe("verify_before_proceeding");
    expect(result.reasons).toContain("low_confidence");
  });

  test("transport error surfaces typed error, no action fabricated", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const judge = createCourseCheckJudge({ apiKey: "k", fetchFn, maxRetries: 0 });
    await expect(judge(okCourse)).rejects.toBeInstanceOf(JevApiError);
  });

  test("empty requirements rejected, zero network", async () => {
    let called = 0;
    const fetchFn = (async () => {
      called++;
      return jsonResponse(courseBody({}, "continue", 0.9));
    }) as unknown as typeof fetch;
    const judge = createCourseCheckJudge({ apiKey: "k", fetchFn });
    await expect(judge({ ...okCourse, requirements: [] })).rejects.toBeInstanceOf(JevApiError);
    expect(called).toBe(0);
  });

  test("missing api key config error, zero network", async () => {
    const judge = createCourseCheckJudge({ apiKey: "", fetchFn: courseFetch({}, "continue", 0.9) });
    await expect(judge(okCourse)).rejects.toBeInstanceOf(JevApiError);
  });

  test("confidence override raises bar: 0.85 < threshold -> verify_before_proceeding", async () => {
    const judge = createCourseCheckJudge({
      apiKey: "k",
      fetchFn: courseFetch({ "req-1": 0.9, "req-2": 0.9 }, "continue", 0.85),
      minConfidence: 0.95,
    });
    const result = await judge(okCourse);
    expect(result.judged).toBe(true);
    expect(result.nextAction).toBe("verify_before_proceeding");
    expect(result.reasons).toContain("low_confidence");
  });

  test("override cannot lower below 0.8 floor: minConfidence 0.3 still demotes 0.7", async () => {
    const judge = createCourseCheckJudge({
      apiKey: "k",
      fetchFn: courseFetch({ "req-1": 0.9, "req-2": 0.9 }, "continue", 0.7),
      minConfidence: 0.3,
    });
    const result = await judge(okCourse);
    expect(result.nextAction).toBe("verify_before_proceeding");
    expect(result.reasons).toContain("low_confidence");
  });

  test("raised bar still passes when confidence meets it", async () => {
    const judge = createCourseCheckJudge({
      apiKey: "k",
      fetchFn: courseFetch({ "req-1": 0.9, "req-2": 0.9 }, "continue", 0.95),
      minConfidence: 0.95,
    });
    const result = await judge(okCourse);
    expect(result.nextAction).toBe("continue");
  });
});

// ---------- mandatory meta-options (service options) ----------

const SERVICE_IDS = Object.keys(SERVICE_OPTION_CRITERIA);

function metaBody(answers: Record<string, unknown>) {
  return {
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const choiceAnswer = (choice: string, confidence = 0.9) => ({
  type: "choice",
  choice,
  probabilities: { [choice]: 1 },
  confidence,
});

describe("mandatory meta-options", () => {
  test("service options present in verdict, option and next_action criteria", async () => {
    const calls: { body?: unknown }[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) });
      return jsonResponse(
        metaBody({
          verdict: choiceAnswer("approve"),
          option: choiceAnswer("approve"),
          meta_reason: choiceAnswer("options_incomplete"),
        }),
      );
    }) as unknown as typeof fetch;
    const judge = createJudge({ apiKey: "k", fetchFn });
    await judge(okReq);
    const questions = (calls[0]!.body as { questions: Record<string, { criteria: Record<string, unknown> }> })
      .questions;
    for (const id of SERVICE_IDS) {
      expect(questions["verdict"]!.criteria[id]).toBeDefined();
      expect(questions["option"]!.criteria[id]).toBeDefined();
    }
    expect(Object.keys(questions["meta_reason"]!.criteria).sort()).toEqual(
      Object.keys(META_REASON_CRITERIA).sort(),
    );
  });

  test("verdict ALL_OPTIONS_WRONG -> insufficient_evidence with meta reasons", async () => {
    const fetchFn = (async () =>
      jsonResponse(
        metaBody({
          verdict: choiceAnswer("ALL_OPTIONS_WRONG"),
          option: choiceAnswer("approve"),
          meta_reason: choiceAnswer("options_wrong_premise"),
        }),
      )) as unknown as typeof fetch;
    const judge = createJudge({ apiKey: "k", fetchFn });
    const result = await judge(okReq);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.reasons).toContain("meta_option");
    expect(result.reasons).toContain("ALL_OPTIONS_WRONG");
    expect(result.reasons).toContain("meta_reason:options_wrong_premise");
  });

  test("verdict PARTIALLY_RIGHT_NONE_FULL -> revise; NO_FIT_OTHER_REASON -> ask_user", async () => {
    for (const [id, expected] of [
      ["PARTIALLY_RIGHT_NONE_FULL", "revise"],
      ["NO_FIT_OTHER_REASON", "ask_user"],
    ] as const) {
      const fetchFn = (async () =>
        jsonResponse(
          metaBody({
            verdict: choiceAnswer(id),
            option: choiceAnswer("approve"),
            meta_reason: choiceAnswer("insufficient_context"),
          }),
        )) as unknown as typeof fetch;
      const judge = createJudge({ apiKey: "k", fetchFn });
      const result = await judge(okReq);
      expect(result.verdict).toBe(expected);
    }
  });

  test("service option in the option question also never approves", async () => {
    const fetchFn = (async () =>
      jsonResponse(
        metaBody({
          verdict: choiceAnswer("approve"),
          option: choiceAnswer("NO_FIT_OTHER_REASON"),
          meta_reason: choiceAnswer("options_incomplete"),
        }),
      )) as unknown as typeof fetch;
    const judge = createJudge({ apiKey: "k", fetchFn });
    const result = await judge(okReq);
    expect(result.verdict).not.toBe("approve");
  });

  test("non-service selection unaffected by meta machinery", async () => {
    const judge = createJudge({ ...baseConfig });
    const result = await judge(okReq);
    expect(result.verdict).toBe("approve");
    expect(result.reasons).toEqual(["approved"]);
  });

  test("course_check: service selections map conservatively, never continue", async () => {
    const cases: [string, CourseCheckResult["nextAction"]][] = [
      ["ALL_OPTIONS_WRONG", "replan"],
      ["PARTIALLY_RIGHT_NONE_FULL", "return_to_requirement"],
      ["NO_FIT_OTHER_REASON", "ask_user"],
    ];
    for (const [service, expected] of cases) {
      const judge = createCourseCheckJudge({
        apiKey: "k",
        fetchFn: (async () =>
          jsonResponse(
            courseBody(
              { "req-1": 0.95, "req-2": 0.95 },
              service,
              0.9,
            ),
          )) as unknown as typeof fetch,
      });
      const result = await judge(okCourse);
      expect(result.judged).toBe(true);
      expect(result.nextAction).toBe(expected);
    }
  });

  test("template options cannot remove service options (builder always appends)", () => {
    const body = buildRequestBody(
      { ...okReq, stage: "code_review" },
      {
        apiKey: "k",
        stages: {
          code_review: {
            options: [
              { id: "ship", label: "Ship", meaning: "merge" },
              { id: "hold", label: "Hold", meaning: "wait" },
            ],
          },
        },
      },
    );
    const criteria = (body.questions.option as { criteria: Record<string, unknown> }).criteria;
    for (const id of SERVICE_IDS) expect(criteria[id]).toBeDefined();
  });
});

// ---------- completion candidate (typed mid-band candidate, completion_review only) ----------

function midBandFetch(verdict: string, confidence: number, option = "approve"): typeof fetch {
  return (async () =>
    jsonResponse(
      metaBody({
        verdict: choiceAnswer(verdict, confidence),
        option: choiceAnswer(option, confidence),
      }),
    )) as unknown as typeof fetch;
}

describe("completion candidate (mid-band completion_review)", () => {
  test("approve at 0.7 stays strict insufficient_evidence but carries the typed candidate", async () => {
    const judge = createJudge({ apiKey: "k", fetchFn: midBandFetch("approve", 0.7) });
    const result = await judge(okReq);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.reasons).toEqual(["low_confidence"]);
    expect(result.completionCandidate).toEqual({ selectedOption: "approve" });
  });

  test("candidate carries the chosen non-default option", async () => {
    const judge = createJudge({ apiKey: "k", fetchFn: midBandFetch("approve", 0.7, "reject") });
    const result = await judge(okReq);
    expect(result.completionCandidate).toEqual({ selectedOption: "reject" });
  });

  test("candidate appears exactly at POLICY.completionConfidenceFloor", async () => {
    const judge = createJudge({
      apiKey: "k",
      fetchFn: midBandFetch("approve", POLICY.completionConfidenceFloor),
    });
    const result = await judge(okReq);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.completionCandidate).toEqual({ selectedOption: "approve" });
  });

  test("confidence below the completion floor -> no candidate", async () => {
    const judge = createJudge({
      apiKey: "k",
      fetchFn: midBandFetch("approve", POLICY.completionConfidenceFloor - 0.1),
    });
    const result = await judge(okReq);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.completionCandidate).toBeUndefined();
  });

  test("non-completion stage -> no candidate", async () => {
    const judge = createJudge({ apiKey: "k", fetchFn: midBandFetch("approve", 0.7) });
    const result = await judge({ ...okReq, stage: "direction_review" });
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.completionCandidate).toBeUndefined();
  });

  test("raised configured bar -> no candidate (bar raising opts out)", async () => {
    const judge = createJudge({
      apiKey: "k",
      fetchFn: midBandFetch("approve", 0.85),
      minConfidence: 0.9,
    });
    const result = await judge(okReq);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.completionCandidate).toBeUndefined();
  });

  test("meta verdict escape -> revise/insufficient, never a candidate", async () => {
    const judge = createJudge({ apiKey: "k", fetchFn: midBandFetch("ALL_OPTIONS_WRONG", 0.7) });
    const result = await judge(okReq);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.reasons).toContain("meta_option");
    expect(result.completionCandidate).toBeUndefined();
  });

  test("meta option selection with mid-band approve verdict -> no candidate", async () => {
    const judge = createJudge({
      apiKey: "k",
      fetchFn: midBandFetch("approve", 0.7, "PARTIALLY_RIGHT_NONE_FULL"),
    });
    const result = await judge(okReq);
    expect(result.verdict).toBe("revise");
    expect(result.completionCandidate).toBeUndefined();
  });

  test("full-confidence approve -> plain approval, no candidate field", async () => {
    const judge = createJudge({ apiKey: "k", fetchFn: midBandFetch("approve", 0.85) });
    const result = await judge(okReq);
    expect(result.verdict).toBe("approve");
    expect(result.completionCandidate).toBeUndefined();
  });
});

// ---------- createAspectCoverageJudge (three-way per-aspect marking) ----------

const okAspects: AspectCoverageRequest = {
  aspects: [
    { id: "error-handling", text: "Errors are caught and surfaced" },
    { id: "docs", text: "README documents the flag" },
  ],
  currentAction: "Implemented error handling; README updated",
  evidence: [{ kind: "code", source: "src/x.ts", quote: "try { run(); } catch (e) { report(e); }" }],
};

const ASPECT_CHOICES = ["applicable_and_addressed", "applicable_not_addressed", "not_applicable"];

function aspectFetch(answers: Record<string, unknown>, calls?: { body?: unknown }[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (calls) calls.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
    return jsonResponse(metaBody(answers));
  }) as unknown as typeof fetch;
}

function markingsFrom(spec: Record<string, [string, number?]>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, [choice, confidence]] of Object.entries(spec)) {
    answers[id] = choiceAnswer(choice, confidence ?? 0.9);
  }
  return answers;
}

describe("aspect coverage judge", () => {
  test("happy path: raw three-way markings pass through, judged", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed", 0.9],
          docs: ["applicable_and_addressed", 0.85],
        }),
      ),
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(true);
    expect(result.escape).toBeUndefined();
    expect(result.markings).toEqual({
      "error-handling": "applicable_and_addressed",
      docs: "applicable_and_addressed",
    });
    expect(result.confidence).toBe(0.85); // min across aspects
  });

  test("not_applicable passes through without requireAll", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed"],
          docs: ["not_applicable"],
        }),
      ),
    });
    const result = await judge({ ...okAspects });
    expect(result.judged).toBe(true);
    expect(result.markings["docs"]).toBe("not_applicable");
  });

  test("requireAll: not_applicable cannot satisfy -> applicable_not_addressed", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed"],
          docs: ["not_applicable"],
        }),
      ),
    });
    const result = await judge({ ...okAspects, requireAll: true });
    expect(result.judged).toBe(true);
    expect(result.markings["docs"]).toBe("applicable_not_addressed");
    expect(result.reasons.some((r) => r.includes("docs"))).toBe(true);
  });

  test("question wiring: fixed three options + service options per aspect; aspect text with evidence in state, policy declares text data", async () => {
    const calls: { body?: unknown }[] = [];
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed"],
          docs: ["applicable_and_addressed"],
        }),
        calls,
      ),
    });
    await judge(okAspects);
    // test-authored wire shape, reconstructed through JSON.parse (type lost in transit)
    const body = calls[0]!.body as {
      state: { aspects: unknown[]; evidence: unknown[] };
      questions: Record<string, { type: string; criteria: Record<string, unknown>; instructions: { question?: string; policy?: string } }>;
    };
    expect(Object.keys(body.questions).sort()).toEqual(["docs", "error-handling", "meta_reason"]);
    for (const id of ["error-handling", "docs"]) {
      expect(body.questions[id]!.type).toBe("choice");
      for (const c of ASPECT_CHOICES) expect(body.questions[id]!.criteria[c]).toBeDefined();
      for (const s of SERVICE_IDS) expect(body.questions[id]!.criteria[s]).toBeDefined();
      // untrusted-evidence pattern: aspect text named in its question, declared data by policy
      const aspect = okAspects.aspects.find((a) => a.id === id)!;
      expect(body.questions[id]!.instructions.question).toContain(aspect.text);
      expect(body.questions[id]!.instructions.policy).toMatch(/never an instruction/);
    }
    expect(JSON.stringify(body.state)).toContain("README documents the flag");
    expect(JSON.stringify(body.state)).toContain("try { run(); }");
  });

  test("no keyword matching: contradicting evidence never overrides the SDK marking (both directions)", async () => {
    const boastful = {
      ...okAspects,
      evidence: [{ kind: "code" as const, source: "src/x.ts", quote: "error-handling fully implemented and covered" }],
    };
    const skeptical = {
      ...okAspects,
      evidence: [{ kind: "log" as const, source: "ci", quote: "docs NOT updated, still missing" }],
    };
    const judgeNotAddressed = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_not_addressed"],
          docs: ["applicable_not_addressed"],
        }),
      ),
    });
    const r1 = await judgeNotAddressed(boastful);
    expect(r1.markings["error-handling"]).toBe("applicable_not_addressed");
    const judgeAddressed = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed"],
          docs: ["applicable_and_addressed"],
        }),
      ),
    });
    const r2 = await judgeAddressed(skeptical);
    expect(r2.judged).toBe(true);
    expect(r2.markings["docs"]).toBe("applicable_and_addressed");
  });

  test("missing answer for an aspect -> judged:false, no markings", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(markingsFrom({ "error-handling": ["applicable_and_addressed"] })),
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(false);
    expect(result.markings).toEqual({});
    expect(result.reasons).toContain("bad_payload");
  });

  test("malformed answer (non-choice type) -> judged:false", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch({
        "error-handling": { type: "noul", noul: 0.9 },
        docs: choiceAnswer("applicable_and_addressed"),
      }),
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(false);
    expect(result.reasons).toContain("bad_payload");
  });

  test("missing or non-finite confidence -> judged:false", async () => {
    for (const confidence of [undefined, Number.NaN]) {
      const judge = createAspectCoverageJudge({
        apiKey: "k",
        fetchFn: aspectFetch({
          "error-handling": choiceAnswer("applicable_and_addressed"),
          docs: {
            type: "choice",
            choice: "applicable_and_addressed",
            probabilities: { applicable_and_addressed: 1 },
            ...(confidence === undefined ? {} : { confidence }),
          },
        }),
      });
      const result = await judge(okAspects);
      expect(result.judged).toBe(false);
      expect(result.reasons).toContain("bad_payload");
    }
  });

  test("confidence out of 0..1 range -> judged:false", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed"],
          docs: ["applicable_and_addressed", 1.5],
        }),
      ),
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(false);
    expect(result.markings).toEqual({});
  });

  test("low confidence below the effective floor -> fail closed, no mapping", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed"],
          docs: ["applicable_and_addressed", 0.79],
        }),
      ),
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(false);
    expect(result.markings).toEqual({});
    expect(result.reasons).toContain("low_confidence");
  });

  test("configured override raises the floor: 0.9 < 0.95 -> fail closed", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed"],
          docs: ["applicable_and_addressed", 0.9],
        }),
      ),
      minConfidence: 0.95,
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(false);
    expect(result.markings).toEqual({});
  });

  test("confidence exactly at the floor is accepted", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch(
        markingsFrom({
          "error-handling": ["applicable_and_addressed", POLICY.minConfidenceToApprove],
          docs: ["not_applicable", POLICY.minConfidenceToApprove],
        }),
      ),
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(true);
    expect(result.markings["docs"]).toBe("not_applicable");
  });

  test("service-option answer -> meta escape, judged:true, no markings", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch({
        "error-handling": choiceAnswer("ALL_OPTIONS_WRONG"),
        docs: choiceAnswer("applicable_and_addressed"),
        meta_reason: choiceAnswer("options_incomplete"),
      }),
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(true);
    expect(result.escape).toBe(true);
    expect(result.markings).toEqual({});
    expect(result.reasons).toContain("meta_option");
    expect(result.reasons).toContain("ALL_OPTIONS_WRONG");
    expect(result.reasons).toContain("meta_reason:options_incomplete");
  });

  test("unknown extra answer id -> judged:false (exactly the supplied ids)", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: aspectFetch({
        ...markingsFrom({
          "error-handling": ["applicable_and_addressed"],
          docs: ["applicable_and_addressed"],
        }),
        extra: choiceAnswer("applicable_and_addressed"),
      }),
    });
    const result = await judge(okAspects);
    expect(result.judged).toBe(false);
    expect(result.reasons).toContain("bad_payload");
  });

  test("empty aspects -> invalid_input, zero network", async () => {
    let called = 0;
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: (async () => {
        called++;
        return jsonResponse(metaBody({}));
      }) as unknown as typeof fetch,
    });
    await expect(judge({ ...okAspects, aspects: [] })).rejects.toBeInstanceOf(JevApiError);
    expect(called).toBe(0);
  });

  test("empty aspect id or text -> invalid_input, zero network", async () => {
    let called = 0;
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: (async () => {
        called++;
        return jsonResponse(metaBody({}));
      }) as unknown as typeof fetch,
    });
    await expect(
      judge({ ...okAspects, aspects: [{ id: "", text: "x" }] }),
    ).rejects.toBeInstanceOf(JevApiError);
    await expect(
      judge({ ...okAspects, aspects: [{ id: "a", text: "  " }] }),
    ).rejects.toBeInstanceOf(JevApiError);
    expect(called).toBe(0);
  });

  test("non-boolean requireAll -> invalid_input, zero network", async () => {
    let called = 0;
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: (async () => {
        called++;
        return jsonResponse(metaBody({}));
      }) as unknown as typeof fetch,
    });
    await expect(
      judge({ ...okAspects, requireAll: "yes" as unknown as boolean }),
    ).rejects.toBeInstanceOf(JevApiError);
    expect(called).toBe(0);
  });

  test("missing api key -> config error, zero network", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "",
      fetchFn: aspectFetch(markingsFrom({ "error-handling": ["applicable_and_addressed"] })),
    });
    await expect(judge(okAspects)).rejects.toBeInstanceOf(JevApiError);
  });

  test("transport error surfaces typed JevApiError (no fabricated markings)", async () => {
    const judge = createAspectCoverageJudge({
      apiKey: "k",
      fetchFn: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
      maxRetries: 0,
    });
    await expect(judge(okAspects)).rejects.toBeInstanceOf(JevApiError);
  });
});
