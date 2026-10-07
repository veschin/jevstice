import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const CLEAN_ENV: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !["TYPESAFE_API_KEY", "JEVI_API_KEY", "TYPESAFE_API_KEY_COMMAND", "TYPESAFE_API_URL"].includes(k)) {
    CLEAN_ENV[k] = v;
  }
}

function run(args: string[], env: Record<string, string> = {}) {
  const p = spawnSync("bun", ["src/cli.ts", ...args], {
    env: { ...CLEAN_ENV, ...env },
    encoding: "utf8",
    timeout: 60000,
  });
  return { exitCode: p.status ?? -1, stdout: p.stdout, stderr: p.stderr };
}

function errObj(p: { stderr: string; stdout: string }) {
  // Error channel contract: error JSON on stderr; stdout empty on failures.
  expect(p.stdout).toBe("");
  return JSON.parse(p.stderr);
}

const FIXTURE = "tests/fixtures/completion_request.json";

describe("cli contract (FR-09, FR-15; AC4c)", () => {
  test("invalid input exits 2 with clean error JSON, no judge call", async () => {
    const p = run(["tests/fixtures/invalid.json"]);
    expect(p.exitCode).toBe(2);
    const out = JSON.parse(p.stderr);
    expect(out.error).toBe("invalid_input");
  });

  test("missing API key exits 4, never approves (POLICY.failureNeverApproves)", async () => {
    const p = run([FIXTURE]);
    expect(p.exitCode).toBe(4);
    expect(errObj(p).error).toBe("config");
  });

  test("unreachable endpoint exits 4 with transport error (FR live error path)", async () => {
    const p = run([FIXTURE], {
      TYPESAFE_API_KEY: "test-key-not-real",
      TYPESAFE_API_URL: "http://127.0.0.1:1/v1/systemone",
    });
    expect(p.exitCode).toBe(4);
    expect(errObj(p).error).toBe("transport");
  }, 30000);

  test("probe without key reports configuration error, exit 4", async () => {
    const p = run(["probe"]);
    expect(p.exitCode).toBe(4);
    expect(errObj(p).error).toBe("config");
  });

  test("probe with key against unreachable endpoint exits 4 (real network attempt)", async () => {
    const p = run(["probe"], {
      TYPESAFE_API_KEY: "test-key-not-real",
      TYPESAFE_API_URL: "http://127.0.0.1:1/v1/systemone",
    });
    expect(p.exitCode).toBe(4);
    expect(errObj(p).error).toBe("transport");
  }, 30000);
});
