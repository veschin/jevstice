/**
 * Catalog, classification and routing (FR-01..FR-04, PRD section 6 "harden-plan").
 * Owned by JevCatalogWorker.
 *
 * Data: src/catalog-data.json - source-attributed extraction of the local
 * harden-plan skill's 16 kind packs (excellence + pitfalls), generated at
 * author time from ~/.omp/agent/managed-skills/harden-plan/packs/*.md
 * (read 2026-10-07). Runtime does NOT read the user skill directory: the
 * bundled snapshot is the portable, traceable option.
 *
 * Judge calls are injected dependencies (src/types.ts Judge / MultiLabelJudge
 * below). Catalog code never talks to the network itself.
 */

import { readFileSync } from "node:fs";
import { POLICY } from "./types";
import type {
  DecisionOption,
  DecisionRequest,
  DecisionResult,
  DecisionStage,
  DecisionVerdict,
  Evidence,
  MultiLabelJudge,
} from "./types";
import bundledCatalog from "./catalog-data.json";

/** Documented TypeSafe limit: a Choice question carries at most 255 options (S:API). */
export const CHOICE_LIMIT = 255;

/** Error for catalog/state problems the caller must fix (not judge uncertainty). */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

// ---------- Catalog data ----------

export interface CatalogTopic {
  id: string;
  /** Short human label, e.g. "backend / API". */
  label: string;
  /** good->great bar entries. */
  excellence: string[];
  /** critic's checklist entries. */
  pitfalls: string[];
  /** Verbatim provenance of the entries. */
  source: string;
}

interface BundledCatalog {
  topics: CatalogTopic[];
}

/**
 * Load a topic catalog. Without arguments returns the bundled harden-plan
 * snapshot. Throws CatalogError on missing file, invalid JSON, missing/empty
 * topics, or a topic missing required fields - never returns a silent empty
 * selection surface.
 */
export function loadTopicCatalog(path?: string): CatalogTopic[] {
  let raw: unknown;
  if (path === undefined) {
    raw = bundledCatalog;
  } else {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new CatalogError(`catalog file not readable: ${path} (${(e as Error).message})`);
    }
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new CatalogError(`catalog file is not valid JSON: ${path} (${(e as Error).message})`);
    }
  }
  return parseCatalog(raw);
}

function parseCatalog(raw: unknown): CatalogTopic[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as BundledCatalog).topics)) {
    throw new CatalogError("catalog must be an object with a topics array");
  }
  const topics = (raw as BundledCatalog).topics;
  if (topics.length === 0) throw new CatalogError("catalog is empty: no topics");
  const seen = new Set<string>();
  for (const t of topics) {
    if (typeof t.id !== "string" || t.id === "") throw new CatalogError("catalog topic without id");
    if (typeof t.label !== "string" || t.label === "") throw new CatalogError(`catalog topic ${t.id}: missing label`);
    if (!Array.isArray(t.excellence) || t.excellence.length === 0)
      throw new CatalogError(`catalog topic ${t.id}: empty excellence`);
    if (!Array.isArray(t.pitfalls) || t.pitfalls.length === 0)
      throw new CatalogError(`catalog topic ${t.id}: empty pitfalls`);
    if (typeof t.source !== "string" || t.source === "") throw new CatalogError(`catalog topic ${t.id}: missing source`);
    if (seen.has(t.id)) throw new CatalogError(`duplicate catalog topic id: ${t.id}`);
    seen.add(t.id);
  }
  return topics;
}

/** Decision options for the 16 harden-plan kinds (dominant-kind selection). */
export function dominantKindOptions(catalog: CatalogTopic[]): DecisionOption[] {
  if (catalog.length === 0) throw new CatalogError("empty catalog: no kinds to offer");
  if (catalog.length > CHOICE_LIMIT)
    throw new CatalogError(`catalog has ${catalog.length} kinds, exceeds documented Choice limit ${CHOICE_LIMIT}`);
  return catalog.map((t) => ({
    id: t.id,
    label: t.label,
    meaning: `Treat the task as dominated by the "${t.label}" kind; apply its excellence bar and pitfalls checklist (source: ${t.source}).`,
  }));
}

// ---------- FR-01: task classification (development / analytics / query) ----------

/** FR-01 fixed option set, meanings anchored to the PRD wording. */
export const TASK_TYPE_OPTIONS: DecisionOption[] = [
  { id: "development", label: "development", meaning: "Task produces or changes software; plan topics and executor toolset apply." },
  { id: "analytics", label: "analytics", meaning: "Task analyses data/metrics/experiments to support a decision; output is an answer, not code." },
  { id: "query", label: "query", meaning: "Task is an informational request; answer directly, no build pipeline." },
];

export async function classifyTaskType(
  task: string,
  evidence: Evidence[],
  judge: (request: DecisionRequest) => Promise<DecisionResult>,
): Promise<DecisionResult> {
  return downgradeUncertain(
    await judge({
      stage: "task_classification",
      task,
      proposal: `Classify the user task into exactly one of: development, analytics, query.`,
      options: TASK_TYPE_OPTIONS,
      evidence: requireEvidence(evidence, "task_classification"),
    }),
  );
}

// ---------- FR-04: multi-topic selection with evidence-driven sharding ----------

/**
 * Multi-label marking uses the shared MultiLabelJudge (src/types.ts): one
 * call marks a bounded batch of items (implemented over parallel Noul
 * questions). approve verdict = marking completed and trustworthy;
 * anything else must be surfaced, never treated as an empty-but-valid result.
 */

export interface TopicSelection {
  outcome: "selected" | "insufficient_evidence" | "ask_user";
  /** Applicable topics, each carrying its source reference. */
  selected: CatalogTopic[];
  /** Topics explicitly marked not applicable - never silently dropped. */
  rejected: { id: string; reason: string }[];
  /** Judge's reasons, verbatim per call. */
  reasons: string[];
  confidence?: number;
  /** Number of judge calls actually issued (1 unless the catalog exceeds CHOICE_LIMIT). */
  shards: number;
}

/**
 * Partition topics into consecutive shards of at most shardSize items.
 * shardSize must be 1..CHOICE_LIMIT. Every topic appears in exactly one
 * shard - no repeated payloads, no lost items.
 */
export function planShards(count: number, shardSize = CHOICE_LIMIT): number[][] {
  if (!Number.isInteger(count) || count < 0) throw new CatalogError(`invalid topic count: ${count}`);
  if (!Number.isInteger(shardSize) || shardSize < 1 || shardSize > CHOICE_LIMIT)
    throw new CatalogError(`shardSize must be an integer in 1..${CHOICE_LIMIT}, got ${shardSize}`);
  const shards: number[][] = [];
  for (let start = 0; start < count; start += shardSize) {
    shards.push(Array.from({ length: Math.min(shardSize, count - start) }, (_, i) => start + i));
  }
  return shards;
}

function topicAt(catalog: CatalogTopic[], i: number): CatalogTopic {
  const t = catalog[i];
  if (t === undefined) throw new CatalogError(`catalog index out of range: ${i}`);
  return t;
}

/**
 * FR-04: judge marks which prepared topics really apply to the task.
 * Sharding happens only because of the documented 255-option cardinality -
 * catalogs within the limit are one judge call. Non-approve verdicts are
 * returned as explicit uncertainty; the function never invents a selection.
 */
export async function selectTopics(args: {
  task: string;
  evidence: Evidence[];
  catalog: CatalogTopic[];
  judge: MultiLabelJudge;
  shardSize?: number;
}): Promise<TopicSelection> {
  const { task, evidence, catalog, judge } = args;
  if (catalog.length === 0) throw new CatalogError("empty catalog: nothing to select from");
  const checked = requireEvidence(evidence, "topic_selection");
  const shards = planShards(catalog.length, args.shardSize);
  const selected: CatalogTopic[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const reasons: string[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;
  let outcome: TopicSelection["outcome"] = "selected";

  for (const shard of shards) {
    const items = shard.map((i) => ({
      id: topicAt(catalog, i).id,
      text: `${topicAt(catalog, i).label} - apply this kind's excellence bar and pitfalls: ${topicAt(catalog, i).excellence[0] ?? ""}`,
    }));
    const mark = await judge({ stage: "topic_selection", task, evidence: checked, items });
    reasons.push(...mark.reasons);
    if (mark.verdict !== "approve" || uncertain(mark)) {
      return {
        outcome: mark.verdict === "ask_user" ? "ask_user" : "insufficient_evidence",
        selected: [],
        rejected: [],
        reasons,
        shards: shards.length,
      };
    }
    const batchIds = new Set(items.map((it) => it.id));
    for (const id of Object.keys(mark.applicable)) {
      if (!batchIds.has(id))
        return {
          outcome: "insufficient_evidence",
          selected: [],
          rejected: [],
          reasons: [...reasons, `judge returned topic id outside the requested shard: ${id}`],
          shards: shards.length,
        };
    }
    for (const i of shard) {
      const t = topicAt(catalog, i);
      if (mark.applicable[t.id] === true) selected.push(t);
      else if (mark.applicable[t.id] === false) rejected.push({ id: t.id, reason: "judge marked not applicable" });
      else
        return {
          outcome: "insufficient_evidence",
          selected: [],
          rejected: [],
          reasons: [...reasons, `judge did not mark topic ${t.id}`],
          shards: shards.length,
        };
    }
    if (typeof mark.confidence === "number") {
      confidenceSum += mark.confidence;
      confidenceCount += 1;
    }
  }
  return {
    outcome,
    selected,
    rejected,
    reasons,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : undefined,
    shards: shards.length,
  };
}

// ---------- FR-02 / FR-03: skill and model routing ----------

export interface RoutingCandidate {
  id: string;
  label: string;
  /** What choosing this candidate commits the caller to. */
  meaning: string;
}

/** Throw on empty candidate list or unknown/duplicate ids (no invented options). */
export function validateCandidates(candidates: RoutingCandidate[], where: string): void {
  if (candidates.length === 0) throw new CatalogError(`${where}: candidate list is empty`);
  const seen = new Set<string>();
  for (const c of candidates) {
    if (typeof c.id !== "string" || c.id === "") throw new CatalogError(`${where}: candidate without id`);
    if (typeof c.meaning !== "string" || c.meaning === "") throw new CatalogError(`${where}: candidate ${c.id}: missing meaning`);
    if (seen.has(c.id)) throw new CatalogError(`${where}: duplicate candidate id: ${c.id}`);
    seen.add(c.id);
  }
}

function toOptions(candidates: RoutingCandidate[]): DecisionOption[] {
  if (candidates.length > CHOICE_LIMIT)
    throw new CatalogError(`${candidates.length} candidates exceed documented Choice limit ${CHOICE_LIMIT}`);
  return candidates.map((c) => ({ id: c.id, label: c.label, meaning: c.meaning }));
}

/** FR-02: pick skills from the caller-configured/discovered candidates only. */
export async function routeSkills(args: {
  task: string;
  evidence: Evidence[];
  candidates: RoutingCandidate[];
  judge: (request: DecisionRequest) => Promise<DecisionResult>;
}): Promise<DecisionResult> {
  validateCandidates(args.candidates, "skill_routing");
  return downgradeUncertain(
    await args.judge({
      stage: "skill_routing",
      task: args.task,
      proposal: "Select the skill(s) to activate for this task from the configured candidates.",
      options: toOptions(args.candidates),
      evidence: requireEvidence(args.evidence, "skill_routing"),
    }),
  );
}

export interface ModelRoutingResult {
  verdict: DecisionVerdict;
  /** Chosen allowlisted model id, present iff verdict === "approve". */
  selected?: string;
  /** Candidates removed by the allowlist before the judge saw them. */
  excluded: string[];
  reasons: string[];
  confidence?: number;
}

/**
 * FR-03: pick a model, restricted to the caller's allowlist. Candidates not
 * on the allowlist are excluded up front and reported - never offered to the
 * judge, never silently dropped. An empty allowlist is a caller error.
 */
export async function routeModel(args: {
  task: string;
  evidence: Evidence[];
  candidates: RoutingCandidate[];
  /** Allowed model ids; no default, no fallback provider is ever added here. */
  allowlist: string[];
  judge: (request: DecisionRequest) => Promise<DecisionResult>;
}): Promise<ModelRoutingResult> {
  if (args.allowlist.length === 0) throw new CatalogError("model allowlist is empty: no routing possible");
  validateCandidates(args.candidates, "model_routing");
  const allowed = new Set(args.allowlist);
  const excluded = args.candidates.filter((c) => !allowed.has(c.id)).map((c) => c.id);
  const eligible = args.candidates.filter((c) => allowed.has(c.id));
  if (eligible.length === 0) {
    return {
      verdict: "ask_user",
      excluded,
      reasons: ["no routing candidate is on the caller's allowlist"],
    };
  }
  const result = downgradeUncertain(
    await args.judge({
      stage: "model_routing",
      task: args.task,
      proposal: "Select the model to run this task on, from the allowlisted candidates.",
      options: toOptions(eligible),
      evidence: requireEvidence(args.evidence, "model_routing"),
    }),
  );
  if (result.verdict === "approve") {
    if (result.selectedOption === undefined || !allowed.has(result.selectedOption) || !eligible.some((c) => c.id === result.selectedOption))
      return {
        verdict: "insufficient_evidence",
        excluded,
        reasons: [...result.reasons, `judge selected unknown or non-allowlisted model: ${String(result.selectedOption)}`],
      };
    return {
      verdict: "approve",
      selected: result.selectedOption,
      excluded,
      reasons: result.reasons,
      confidence: result.confidence,
    };
  }
  return { verdict: result.verdict, excluded, reasons: result.reasons, confidence: result.confidence };
}

// ---------- shared ----------

/**
 * POLICY gate: an approve whose confidence is below the threshold is
 * downgraded to insufficient_evidence — never approve (AC4d, uncertainty
 * probe). Missing confidence leaves the verdict untouched (gate applies only
 * to reported confidence).
 */
function downgradeUncertain(result: DecisionResult): DecisionResult {
  if (result.verdict === "approve" && typeof result.confidence === "number" && result.confidence < POLICY.minConfidenceToApprove) {
    return {
      verdict: "insufficient_evidence",
      reasons: [
        ...result.reasons,
        `confidence ${result.confidence} below POLICY.minConfidenceToApprove ${POLICY.minConfidenceToApprove}; approve downgraded`,
      ],
    };
  }
  return result;
}

/** Same POLICY gate for MultiLabelResult-shaped marks. */
function uncertain(mark: { verdict: DecisionVerdict; confidence?: number }): boolean {
  return (
    mark.verdict === "approve" &&
    typeof mark.confidence === "number" &&
    mark.confidence < POLICY.minConfidenceToApprove
  );
}

function requireEvidence(evidence: Evidence[], stage: DecisionStage): Evidence[] {
  if (!Array.isArray(evidence) || evidence.length === 0)
    throw new CatalogError(`${stage}: structured evidence is required (FR-15); refusing to send an empty judge call`);
  return evidence;
}
