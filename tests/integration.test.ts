import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("extension configuration safety (FR-17)", () => {
  test.each(["malformed", "unreadable"])("%s config preserves mutation and completion gates", (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-config-"));
    const configFile = join(dir, ".omp", "jev.config.json");
    try {
      mkdirSync(join(dir, ".omp"));
      if (kind === "malformed") writeFileSync(configFile, "{not json");
      else mkdirSync(configFile);
      const entry = new URL("../src/index.ts", import.meta.url).pathname;
      const script = `
        import { createJevExtension } from ${JSON.stringify(entry)};
        const hooks = {};
        // omp keeps a LIST of handlers per event (runner.ts ext.handlers.get(event)); the
        // extension registers two tool_call and two before_subagent_spawn handlers, so a
        // last-wins registry would silently drop a gate. Merge like the host: first block wins.
        const emit = async (name, event) => {
          let merged;
          for (const handler of hooks[name] ?? []) {
            const result = await handler(event);
            if (result && result.block === true) return result;
            if (result !== undefined) merged = { ...(merged ?? {}), ...result };
          }
          return merged;
        };
        let decision;
        createJevExtension({ judge: async () => { throw new Error("must not consult"); } })({
          on: (name, handler) => { hooks[name] = [...(hooks[name] ?? []), handler]; },
          registerTool: tool => { decision = tool; },
          appendEntry() {},
          sendMessage() {},
        });
        await emit("before_agent_start", {prompt:"Inspect a project without changing its files"});
        const mutation = await emit("tool_call", {toolName:"write",input:{}});
        const read = await emit("tool_call", {toolName:"read",input:{}});
        const stop = await emit("session_stop", {stop_hook_active:false});
        const outcome = await decision?.execute("invalid-config", {
          stage:"direction_review", task:"Inspect the project",
          proposal:"Inspect the project without changing any files",
          options:[{id:"approve",label:"Approve",meaning:"proceed"},{id:"revise",label:"Revise",meaning:"rework"}],
          evidence:[{kind:"user",source:"user",quote:"Inspect the project without changing its files"}],
        });
        console.log(JSON.stringify({mutation,read:read??null,stop,outcome:outcome?.details}));
      `;
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: dir,
        env: { ...CLEAN_ENV, HOME: dir },
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.status).toBe(0);
      const actual = JSON.parse(result.stdout);
      expect(actual.mutation?.block).toBe(true);
      expect(actual.read).toBeNull();
      expect(actual.stop?.decision).toBe("block");
      expect(actual.outcome?.verdict).toBe("insufficient_evidence");
      expect(actual.outcome?.judged).toBe(false);
      expect(actual.outcome?.reasons.join(" ")).toContain(configFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
