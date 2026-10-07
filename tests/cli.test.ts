import { describe, expect, test } from "bun:test";
import type { DecisionRequest } from "../src/types";
import { runCli } from "../src/cli";

const okReq: DecisionRequest = {
  stage: "completion_review",
  task: "Implement foo()",
  proposal: "foo() returns 42, tested by foo.test.ts",
  options: [
    { id: "approve", label: "Approve", meaning: "complete and correct" },
    { id: "reject", label: "Reject", meaning: "misses the task" },
  ],
  evidence: [{ kind: "user", source: "user", quote: "implement foo returning 42" }],
};

function judgeBody(verdict: string, confidence: number) {
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
          approve: verdict === "approve" ? 0.9 : 0.05,
          revise: 0.05,
          insufficient_evidence: 0.03,
          ask_user: 0.02,
        },
        confidence,
      },
    },
    usage: { input_tokens: 300, output_tokens: 30 },
  };
}

function probeBody(confidence: number) {
  return {
    model: "jev-1.13.0",
    answers: {
      option: {
        type: "choice",
        choice: "development",
        probabilities: { development: 0.9, analytics: 0.06, query: 0.04 },
        confidence,
      },
      verdict: {
        type: "choice",
        choice: "approve",
        probabilities: {
          approve: 0.9,
          revise: 0.05,
          insufficient_evidence: 0.03,
          ask_user: 0.02,
        },
        confidence,
      },
    },
    usage: { input_tokens: 300, output_tokens: 30 },
  };
}

function okFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(judgeBody("approve", 0.9)), { status: 200 })) as unknown as typeof fetch;
}

const env = { TYPESAFE_API_KEY: "k", TYPESAFE_API_URL: "https://api.test/v1/systemone" };

describe("cli: runCli", () => {
  test("emits normalized DecisionResult JSON and exits 0 on success", async () => {
    const out = await runCli(["--", JSON.stringify(okReq)], { env, fetchFn: okFetch() });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.verdict).toBe("approve");
    expect(parsed.selectedOption).toBe("approve");
    expect(parsed.confidence).toBe(0.9);
  });

  test("reads request from a file path argument", async () => {
    const tmp = `/tmp/jev-cli-test-${process.pid}.json`;
    await Bun.write(tmp, JSON.stringify(okReq));
    const out = await runCli([tmp], { env, fetchFn: okFetch() });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).verdict).toBe("approve");
  });

  test("invalid JSON input exits 2 with error on stderr", async () => {
    const out = await runCli(["--", "{not json"], { env, fetchFn: okFetch() });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("invalid");
    expect(out.stdout).toBe("");
  });

  test("missing required fields exits 2 listing violations", async () => {
    const bad = { ...okReq, evidence: [] };
    const out = await runCli(["--", JSON.stringify(bad)], { env, fetchFn: okFetch() });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("empty_evidence");
  });

  test("missing api key exits 4 with config error, no network call", async () => {
    let called = 0;
    const fetchFn = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await runCli(["--", JSON.stringify(okReq)], { fetchFn });
    expect(out.exitCode).toBe(4);
    expect(called).toBe(0);
    expect(out.stderr).toContain("config");
  });

  test("auth failure exits 4 with error JSON on stderr", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    const out = await runCli(["--", JSON.stringify(okReq)], { env, fetchFn });
    expect(out.exitCode).toBe(4);
    expect(out.stderr).toContain("auth");
  });

  test("judge verdict revise is a valid result: exit 0, not an error", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify(judgeBody("revise", 0.9)), { status: 200 })) as unknown as typeof fetch;
    const out = await runCli(["--", JSON.stringify(okReq)], { env, fetchFn });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).verdict).toBe("revise");
  });

  test("probe subcommand without key emits clean error JSON and nonzero exit", async () => {
    const out = await runCli(["probe"], { fetchFn: okFetch() });
    expect(out.exitCode).toBe(4);
    const parsed = JSON.parse(out.stderr);
    expect(parsed.error).toBe("config");
  });

  test("probe subcommand with key performs a live minimal call and reports result", async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(Object.keys(body.questions).length).toBeGreaterThan(0);
      return new Response(JSON.stringify(probeBody(0.9)), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await runCli(["probe"], { env, fetchFn });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).ok).toBe(true);
  });

  test("no-args usage message exits 2", async () => {
    const out = await runCli([], { env });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("usage");
  });
});
