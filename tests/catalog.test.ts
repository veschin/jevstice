/**
 * Boundary/transition tests for src/catalog.ts (JevCatalogWorker).
 * Judge is always an injected stub; no network, no real client.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CatalogError,
  CHOICE_LIMIT,
  TASK_TYPE_OPTIONS,
  classifyTaskType,
  dominantKindOptions,
  loadTopicCatalog,
  planShards,
  routeModel,
  routeSkills,
  selectTopics,
  validateCandidates,
  type RoutingCandidate,
} from "../src/catalog";
import type { DecisionRequest, DecisionResult, DecisionVerdict, Evidence, MultiLabelJudge } from "../src/types";

const ev: Evidence[] = [{ kind: "user", source: "user", quote: "сделай ETL процесс с шардированием" }];
const catalog = loadTopicCatalog();
const etlTask = "Построить ETL-процесс: выгрузка из API, трансформация, загрузка в хранилище";

function okJudge(selected: string): (r: DecisionRequest) => Promise<DecisionResult> {
  return (r) =>
    Promise.resolve({ verdict: "approve", selectedOption: selected, reasons: ["matches evidence"], confidence: 0.9 });
}

function markJudge(applicable: Record<string, boolean>, verdict: DecisionVerdict = "approve"): MultiLabelJudge {
  return (req) => {
    // contract: items bounded by CHOICE_LIMIT, ids unique, stage fixed
    if (req.items.length > CHOICE_LIMIT) throw new Error(`batch exceeds CHOICE_LIMIT: ${req.items.length}`);
    for (const it of req.items) if (!(it.id in applicable)) applicable[it.id] = false;
    return Promise.resolve({ verdict, applicable: { ...applicable }, reasons: ["marked"], confidence: 0.85 });
  };
}

// ---------- catalog loading ----------

describe("loadTopicCatalog", () => {
  test("bundled snapshot: 16 harden-plan kinds with provenance", () => {
    expect(catalog.length).toBe(16);
    for (const t of catalog) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.source).toContain("harden-plan");
      expect(t.excellence.length).toBeGreaterThan(0);
      expect(t.pitfalls.length).toBeGreaterThan(0);
    }
  });

  test("missing file throws CatalogError, not silent empty", () => {
    expect(() => loadTopicCatalog("/nonexistent/catalog.json")).toThrow(CatalogError);
  });

  test("invalid JSON throws CatalogError", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-cat-"));
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ nope");
    expect(() => loadTopicCatalog(p)).toThrow(CatalogError);
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty topics array throws CatalogError", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-cat-"));
    const p = join(dir, "empty.json");
    writeFileSync(p, JSON.stringify({ topics: [] }));
    expect(() => loadTopicCatalog(p)).toThrow(CatalogError);
    rmSync(dir, { recursive: true, force: true });
  });

  test("topic missing pitfalls throws CatalogError", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-cat-"));
    const p = join(dir, "partial.json");
    writeFileSync(p, JSON.stringify({ topics: [{ id: "x", label: "X", excellence: ["a"], source: "s" }] }));
    expect(() => loadTopicCatalog(p)).toThrow(CatalogError);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------- FR-01 classification ----------

describe("classifyTaskType", () => {
  test("fixed 3-way option set, judge choice returned verbatim", async () => {
    let seen: DecisionRequest | undefined;
    const result = await classifyTaskType(etlTask, ev, (r) => {
      seen = r;
      return Promise.resolve({ verdict: "approve", selectedOption: "development", reasons: ["builds software"] });
    });
    expect(seen!.stage).toBe("task_classification");
    expect(seen!.options.map((o) => o.id)).toEqual(["development", "analytics", "query"]);
    expect(result.verdict).toBe("approve");
    expect(result.selectedOption).toBe("development");
  });

  test("empty evidence is refused before any judge call", async () => {
    let called = false;
    expect(classifyTaskType(etlTask, [], () => ((called = true), Promise.resolve({ verdict: "approve", reasons: [] })))).rejects.toThrow(CatalogError);
    expect(called).toBe(false);
  });

  test("FR-01 three-way mapping: non-approve verdicts surface unchanged, no default type", async () => {
    for (const verdict of ["revise", "insufficient_evidence", "ask_user"] as const) {
      const result = await classifyTaskType(etlTask, ev, () =>
        Promise.resolve({ verdict, reasons: ["cannot decide"] }),
      );
      expect(result.verdict).toBe(verdict);
      expect(result.selectedOption).toBeUndefined();
    }
  });

  test("TASK_TYPE_OPTIONS carry meanings (fixed option set, FR-08)", () => {
    for (const o of TASK_TYPE_OPTIONS) expect(o.meaning.length).toBeGreaterThan(10);
  });
});

// ---------- FR-04 topic selection ----------

describe("planShards", () => {
  test("no sharding within the documented limit", () => {
    expect(planShards(255)).toEqual([Array.from({ length: 255 }, (_, i) => i)]);
    expect(planShards(1)).toEqual([[0]]);
  });

  test("shards only past CHOICE_LIMIT, each item exactly once", () => {
    const shards = planShards(256);
    expect(shards.length).toBe(2);
    expect(shards[0]?.length).toBe(255);
    expect(shards[1]?.length).toBe(1);
    const flat = shards.flat().sort((a, b) => a - b);
    expect(flat).toEqual(Array.from({ length: 256 }, (_, i) => i));
  });

  test("rejects shardSize outside 1..CHOICE_LIMIT", () => {
    expect(() => planShards(10, 256)).toThrow(CatalogError);
    expect(() => planShards(10, 0)).toThrow(CatalogError);
  });
});

describe("selectTopics", () => {
  test("multi-label: applicable and explicitly rejected, sources carried", async () => {
    const applicable: Record<string, boolean> = { backend: true, data: true };
    const result = await selectTopics({ task: etlTask, evidence: ev, catalog, judge: markJudge(applicable) });
    expect(result.outcome).toBe("selected");
    expect(result.shards).toBe(1); // 16 topics -> no sharding
    const ids = result.selected.map((t) => t.id);
    expect(ids).toContain("data");
    expect(ids).toContain("backend");
    expect(result.selected.every((t) => t.source.includes("harden-plan")));
    const rejectedIds = result.rejected.map((r) => r.id);
    expect(rejectedIds).toContain("ui");
    const ui = result.rejected.find((r) => r.id === "ui");
    expect(ui?.reason.length ?? 0).toBeGreaterThan(0);
    expect(result.selected.length + result.rejected.length).toBe(16); // nothing lost
  });

  test("no sharding for a 200-topic catalog; sharding at 300 into 2 bounded calls", async () => {
    const synth = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `t${i}`,
        label: `T${i}`,
        excellence: ["e"],
        pitfalls: ["p"],
        source: "synthetic",
      }));
    const calls: number[] = [];
    const countingJudge: MultiLabelJudge = (req) => {
      calls.push(req.items.length);
      const applicable: Record<string, boolean> = {};
      for (const it of req.items) applicable[it.id] = it.id.endsWith("0");
      return Promise.resolve({ verdict: "approve", applicable, reasons: [] });
    };
    const r200 = await selectTopics({ task: etlTask, evidence: ev, catalog: synth(200), judge: countingJudge });
    expect(r200.shards).toBe(1);
    expect(calls).toEqual([200]);
    calls.length = 0;
    const r300 = await selectTopics({ task: etlTask, evidence: ev, catalog: synth(300), judge: countingJudge });
    expect(r300.shards).toBe(2);
    expect(calls[0]).toBeLessThanOrEqual(CHOICE_LIMIT);
    expect(calls[1]).toBeLessThanOrEqual(CHOICE_LIMIT);
    expect(r300.selected.length + r300.rejected.length).toBe(300); // no lost items across shards
  });

  test("non-approve verdict surfaces uncertainty, never an empty-but-valid selection", async () => {
    const result = await selectTopics({
      task: etlTask,
      evidence: ev,
      catalog,
      judge: markJudge({}, "insufficient_evidence"),
    });
    expect(result.outcome).toBe("insufficient_evidence");
    expect(result.selected).toEqual([]);
  });

  test("ask_user verdict propagates", async () => {
    const result = await selectTopics({ task: etlTask, evidence: ev, catalog, judge: markJudge({}, "ask_user") });
    expect(result.outcome).toBe("ask_user");
  });

  test("judge returning unknown topic id -> insufficient_evidence (no invented options)", async () => {
    const rogue: MultiLabelJudge = () =>
      Promise.resolve({ verdict: "approve", applicable: { backend: true, ghost: true }, reasons: [] });
    const result = await selectTopics({ task: etlTask, evidence: ev, catalog, judge: rogue });
    expect(result.outcome).toBe("insufficient_evidence");
    expect(result.selected).toEqual([]);
  });

  test("empty catalog is a caller error", () => {
    expect(selectTopics({ task: etlTask, evidence: ev, catalog: [], judge: markJudge({}) })).rejects.toThrow(CatalogError);
  });

  test("selection is a subset of the catalog, never invented", async () => {
    const applicable: Record<string, boolean> = { data: true, backend: true, architecture: true };
    const result = await selectTopics({ task: etlTask, evidence: ev, catalog, judge: markJudge(applicable) });
    const catalogIds = new Set(catalog.map((t) => t.id));
    for (const t of result.selected) expect(catalogIds.has(t.id)).toBe(true);
    for (const r of result.rejected) expect(catalogIds.has(r.id)).toBe(true);
  });

  test("bundled provenance is resolvable: named pack file exists in the local skill", () => {
    for (const t of catalog) {
      const m = t.source.match(/packs\/([a-z-]+\.md)/);
      expect(m).not.toBeNull();
      expect(() =>
        require("node:fs").accessSync(
          `${process.env.HOME}/.omp/agent/managed-skills/harden-plan/packs/${m![1]}`,
        ),
      ).not.toThrow();
    }
  });

  test("judge throwing -> error propagates, no default pick", async () => {
    const failing: MultiLabelJudge = () => Promise.reject(new Error("network down"));
    expect(selectTopics({ task: etlTask, evidence: ev, catalog, judge: failing })).rejects.toThrow("network down");
  });

  test("judge omitting a topic marking -> insufficient_evidence, no default applicability", async () => {
    const partial: MultiLabelJudge = (req) => {
      const applicable: Record<string, boolean> = {};
      const first = req.items[0];
      if (first) applicable[first.id] = true; // marks only the first
      return Promise.resolve({ verdict: "approve", applicable, reasons: [] });
    };
    const result = await selectTopics({ task: etlTask, evidence: ev, catalog, judge: partial });
    expect(result.outcome).toBe("insufficient_evidence");
    expect(result.selected).toEqual([]);
  });
});

// ---------- FR-02 skill routing ----------

const skills: RoutingCandidate[] = [
  { id: "harden-plan", label: "harden-plan", meaning: "plan hardening packs" },
  { id: "test-driven-development", label: "tdd", meaning: "tests first" },
];

describe("routeSkills", () => {
  test("judge sees only real configured candidates", async () => {
    let seen: DecisionRequest | undefined;
    await routeSkills({ task: etlTask, evidence: ev, candidates: skills, judge: (r) => ((seen = r), okJudge("harden-plan")(r)) });
    expect(seen!.stage).toBe("skill_routing");
    expect(seen!.options.map((o) => o.id)).toEqual(["harden-plan", "test-driven-development"]);
  });

  test("empty candidate list throws instead of consulting the judge", async () => {
    expect(routeSkills({ task: etlTask, evidence: ev, candidates: [], judge: okJudge("x") })).rejects.toThrow(CatalogError);
  });

  test("duplicate candidate ids rejected", () => {
    const firstSkill = skills[0];
    expect(firstSkill).toBeDefined();
    expect(() => validateCandidates([...skills, firstSkill!], "t")).toThrow(CatalogError);
  });
});

// ---------- FR-03 model routing ----------

const models: RoutingCandidate[] = [
  { id: "deepseek-v4.1-flash", label: "deepseek", meaning: "cheap fast executor" },
  { id: "glm5.3", label: "glm", meaning: "slower stronger executor" },
  { id: "claude-opus-5.5", label: "opus", meaning: "premium, not caller-configured" },
];

describe("routeModel", () => {
  test("allowlist excludes non-allowlisted candidates up front and reports them", async () => {
    let seen: DecisionRequest | undefined;
    const result = await routeModel({
      task: etlTask,
      evidence: ev,
      candidates: models,
      allowlist: ["deepseek-v4.1-flash", "glm5.3"],
      judge: (r) => ((seen = r), okJudge("deepseek-v4.1-flash")(r)),
    });
    expect(seen!.options.map((o) => o.id)).toEqual(["deepseek-v4.1-flash", "glm5.3"]); // opus never offered
    expect(result.excluded).toEqual(["claude-opus-5.5"]);
    expect(result.verdict).toBe("approve");
    expect(result.selected).toBe("deepseek-v4.1-flash");
  });

  test("empty allowlist throws - no implicit fallback provider", () => {
    expect(routeModel({ task: etlTask, evidence: ev, candidates: models, allowlist: [], judge: okJudge("x") })).rejects.toThrow(
      CatalogError,
    );
  });

  test("allowlist matching nothing -> ask_user, not a default pick", async () => {
    const result = await routeModel({
      task: etlTask,
      evidence: ev,
      candidates: models,
      allowlist: ["nonexistent-model"],
      judge: okJudge("deepseek-v4.1-flash"),
    });
    expect(result.verdict).toBe("ask_user");
  });

  test("judge selecting a non-allowlisted model is downgraded, never applied", async () => {
    const result = await routeModel({
      task: etlTask,
      evidence: ev,
      candidates: models,
      allowlist: ["deepseek-v4.1-flash"],
      judge: okJudge("claude-opus-5.5"),
    });
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.selected).toBeUndefined();
  });

  test("judge selecting an id outside the offered options is downgraded", async () => {
    const result = await routeModel({
      task: etlTask,
      evidence: ev,
      candidates: models,
      allowlist: ["deepseek-v4.1-flash", "glm5.3"],
      judge: okJudge("mystery-model"),
    });
    expect(result.verdict).toBe("insufficient_evidence");
  });

  test("uncertainty probe: approve at confidence 0.7 is downgraded, never approve (AC4d)", async () => {
    const lowConf = (r: DecisionRequest) =>
      Promise.resolve({ verdict: "approve" as const, selectedOption: "deepseek-v4.1-flash", reasons: ["ok"], confidence: 0.7 });
    const result = await routeModel({
      task: etlTask,
      evidence: ev,
      candidates: models,
      allowlist: ["deepseek-v4.1-flash"],
      judge: lowConf,
    });
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.selected).toBeUndefined();
    const cls = await classifyTaskType(etlTask, ev, () =>
      Promise.resolve({ verdict: "approve", selectedOption: "development", reasons: [], confidence: 0.7 }),
    );
    expect(cls.verdict).toBe("insufficient_evidence");
    expect(cls.selectedOption).toBeUndefined();
  });

  test("confidence at threshold (0.8) approves; missing confidence leaves verdict", async () => {
    const atThreshold = await classifyTaskType(etlTask, ev, () =>
      Promise.resolve({ verdict: "approve", selectedOption: "development", reasons: [], confidence: 0.8 }),
    );
    expect(atThreshold.verdict).toBe("approve");
    const noConfidence = await classifyTaskType(etlTask, ev, () =>
      Promise.resolve({ verdict: "approve", selectedOption: "development", reasons: [] }),
    );
    expect(noConfidence.verdict).toBe("approve");
  });
});

// ---------- dominant-kind options ----------

describe("dominantKindOptions", () => {
  test("16 options with meanings and provenance in meaning text", () => {
    const opts = dominantKindOptions(catalog);
    expect(opts.length).toBe(16);
    for (const o of opts) expect(o.meaning).toContain("source:");
  });

  test("empty catalog rejected", () => {
    expect(() => dominantKindOptions([])).toThrow(CatalogError);
  });
});
