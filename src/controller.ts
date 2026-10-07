/**
 * Jev decision controller: omp extension core.
 *
 * Real omp semantics (verified against @oh-my-pi/pi-coding-agent 18.6.3 source):
 * - `tool_call` handler (event, ctx) => {block?, reason?, input?, additionalContext?} fires
 *   before execution and can block (extensibility/shared-events.ts:325).
 * - `session_stop` handler => {decision: "block", reason} is extension-only and maps to a
 *   continuation; `event.stop_hook_active` is true when already continuing from a stop hook
 *   (shared-events.ts:110/486) - we never block twice on the same unmet gate (finite rework).
 * - `before_subagent_spawn` => {model?, block?, reason?, note?} (extensions/types.ts:1301).
 * - `before_agent_start` carries the already-transformed prompt (task fingerprint source).
 * - `pi.appendEntry(customType, data)` persists non-LLM state; `ctx.sessionManager.getEntries()`
 *   reads it back on session start (session-manager.ts:3419, 653-676).
 * - Same-agent feedback: `pi.sendMessage(payload, {deliverAs, triggerTurn})` injects into the
 *   SAME session - no respawn, no new session.
 */
import { isRecord, nonEmptyString } from "./guards.js";
import type { JevTemplateConfig } from "./config.js";
import { POLICY } from "./types.js";
import {
	type DecisionResult,
	type DecisionStage,
	type DecisionVerdict,
	type Evidence,
	type Judge,
	type DecisionOption,
} from "./types.js";

// ---------- persisted state ----------

export interface ApprovalRecord {
	stage: DecisionStage;
	/** sha256 of the exact decision request revision this approval covers (AC5 content digest). */
	revisionHash: string;
	/** Fingerprint of the user task active when approved; changed task invalidates. */
	taskFingerprint: string | undefined;
	/** Mutation counter value when approved; later work invalidates completion approvals. */
	workRevision: number;
	selectedOption: string;
	approvedAt: number;
}

export interface JevState {
	approvals: ApprovalRecord[];
	/** Judge consultations per `${taskFingerprint}:${stage}` - bounded rework (FR-12). */
	iterations: Record<string, number>;
	/** Bumped on every allowed mutating tool call (edit/write/bash); completion approvals bind to it. */
	workRevision: number;
	/** sha256 of the latest before_agent_start prompt. */
	taskFingerprint: string | undefined;
	/** True once any mutating tool call was allowed; read-only sessions stay ungated (AC4). */
	mutationsSeen: boolean;
	/** Explicit unresolved blockers, surfaced verbatim - never replaced by fake success. */
	blockers: string[];
	/** Applied model-routing selection (AC2): enforced at before_subagent_spawn. */
	routedModel: string | undefined;
	/** Applied skill-routing selection (AC2), recorded for dispatch visibility. */
	routedSkill: string | undefined;
}

function freshState(): JevState {
	return {
		approvals: [],
		iterations: {},
		workRevision: 0,
		taskFingerprint: undefined,
		mutationsSeen: false,
		blockers: [],
		routedModel: undefined,
		routedSkill: undefined,
	};
}

// ---------- public result shapes ----------

export interface DecisionOutcome {
	verdict: DecisionVerdict;
	selectedOption?: string;
	reasons: string[];
	confidence?: number;
	/** Judge was actually consulted for this outcome. */
	judged: boolean;
}

export interface StopGateResult {
	decision?: "block";
	reason?: string;
}

export interface SpawnRouteResult {
	model?: string | string[];
	block?: boolean;
	reason?: string;
	note?: string;
}

// ---------- tool input validation ----------

const EVIDENCE_KINDS: ReadonlySet<string> = new Set([
	"user",
	"spec",
	"code",
	"execution",
	"log",
	"documentation",
]);
const STAGES: ReadonlySet<string> = new Set([
	"task_classification",
	"skill_routing",
	"model_routing",
	"topic_selection",
	"understanding_review",
	"direction_review",
	"completion_review",
	"important_decision",
	"code_review",
	"subagent_handoff",
	"refactor_check",
]);
/** Completion must rest on artifact evidence, not self-report (AC4b). */
const COMPLETION_EVIDENCE_KINDS: ReadonlySet<string> = new Set(["execution", "code", "log"]);
// Mutation-bearing builtins (omp 18.6.3 tools/builtin-names.ts + tool sources):
// edit/write mutate files directly; ast_edit performs structural edits; bash executes
// arbitrary shell (mutation-capable, conservatively gated); memory_edit and manage_skill
// write user-level state. Non-builtin custom tools are out of this gate's reach (documented).
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"ast_edit",
	"bash",
	"memory_edit",
	"manage_skill",
]);
const PLAN_STAGES: ReadonlySet<DecisionStage> = new Set(["understanding_review", "direction_review"]);
const STATE_ENTRY_TYPE = "jev.state";
const TOOL_NAME = "jev_decision";

export interface ValidatedDecisionInput {
	stage: DecisionStage;
	task: string;
	proposal: string;
	options: DecisionOption[];
	evidence: Evidence[];
	capabilities: string[];
}

export interface ValidationResult {
	ok: boolean;
	reasons: string[];
	input?: ValidatedDecisionInput;
}

/** Validate the executor's structured decision submission. Never throws. */
export function validateDecisionInput(raw: unknown): ValidationResult {
	const reasons: string[] = [];
	if (!isRecord(raw)) return { ok: false, reasons: ["decision input must be a JSON object"] };
	const stage = raw["stage"];
	if (typeof stage !== "string" || !STAGES.has(stage)) {
		reasons.push(`stage must be one of: ${[...STAGES].join(", ")}`);
	}
	if (!nonEmptyString(raw["task"])) reasons.push("task must be a non-empty string");
	if (!nonEmptyString(raw["proposal"])) reasons.push("proposal must be a non-empty string");
	const rawOptions = raw["options"];
	if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
		reasons.push("options must be a non-empty array of {id,label,meaning}");
	}
	const options: DecisionOption[] = [];
	if (Array.isArray(rawOptions)) {
		rawOptions.forEach((o, i) => {
			if (!isRecord(o) || !nonEmptyString(o["id"]) || !nonEmptyString(o["label"]) || !nonEmptyString(o["meaning"])) {
				reasons.push(`options[${i}] must have non-empty id, label and meaning`);
				return;
			}
			options.push({ id: o["id"] as string, label: o["label"] as string, meaning: o["meaning"] as string });
		});
	}
	const optionIds = new Set(options.map(o => o.id));
	if (optionIds.size !== options.length) reasons.push("option ids must be unique");
	const rawEvidence = raw["evidence"];
	if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
		reasons.push("evidence must be a non-empty array of {kind,source,quote}");
	}
	const evidence: Evidence[] = [];
	if (Array.isArray(rawEvidence)) {
		rawEvidence.forEach((e, i) => {
			if (!isRecord(e) || typeof e["kind"] !== "string" || !EVIDENCE_KINDS.has(e["kind"])) {
				reasons.push(`evidence[${i}].kind must be one of: ${[...EVIDENCE_KINDS].join(", ")}`);
				return;
			}
			if (!nonEmptyString(e["source"]) || !nonEmptyString(e["quote"])) {
				reasons.push(`evidence[${i}] must carry non-empty source and quote`);
				return;
			}
			evidence.push({
				kind: e["kind"] as Evidence["kind"],
				source: e["source"] as string,
				quote: e["quote"] as string,
			});
		});
	}
	const capabilities = Array.isArray(raw["capabilities"])
		? raw["capabilities"].filter((c): c is string => typeof c === "string" && c.trim().length > 0)
		: [];
	if (reasons.length > 0) return { ok: false, reasons };
	return {
		ok: true,
		reasons: [],
		input: {
			stage: stage as DecisionStage,
			task: raw["task"] as string,
			proposal: raw["proposal"] as string,
			options,
			evidence,
			capabilities,
		},
	};
}

// ---------- revision hashing ----------

function canonicalEvidence(evidence: Evidence[]): string {
	return JSON.stringify(
		evidence.map(e => ({ kind: e.kind, source: e.source, quote: e.quote })).sort((a, b) =>
			(a.kind + a.source + a.quote).localeCompare(b.kind + b.source + b.quote),
		),
	);
}

function toHex(digest: ArrayBuffer, slice?: number): string {
	const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
	return slice === undefined ? hex : hex.slice(0, slice);
}

async function revisionHash(stage: string, task: string, proposal: string, evidence: Evidence[]): Promise<string> {
	const material = `${stage}\u0000${task}\u0000${proposal}\u0000${canonicalEvidence(evidence)}`;
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)));
}

async function fingerprint(text: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)), 16);
}

// ---------- judge result validation ----------

const VERDICTS: ReadonlySet<string> = new Set(["approve", "revise", "insufficient_evidence", "ask_user"]);

/** A judge answer approves only if fully well-formed, option-resolvable and confident enough (AC4c/d). */
export function normalizeJudgeResult(raw: unknown, options: DecisionOption[], minConfidence: number): DecisionResult {
	if (!isRecord(raw)) {
		return { verdict: "insufficient_evidence", reasons: ["judge returned a non-object payload"] };
	}
	const verdict = raw["verdict"];
	if (typeof verdict !== "string" || !VERDICTS.has(verdict)) {
		return { verdict: "insufficient_evidence", reasons: [`judge returned unknown verdict: ${String(verdict)}`] };
	}
	const reasons = Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : [];
	const confidence = typeof raw["confidence"] === "number" ? raw["confidence"] : undefined;
	if (verdict === "approve") {
		const selected = raw["selectedOption"];
		if (typeof selected !== "string" || !options.some(o => o.id === selected)) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["judge approved without naming one of the offered options"],
			};
		}
		if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`judge confidence ${confidence} outside 0..1 is malformed`],
				confidence,
			};
		}
		if (confidence === undefined || confidence < minConfidence) {
			return {
				verdict: "insufficient_evidence",
				reasons: [
					confidence === undefined
						? `judge approved without reporting confidence; absent is not above the required ${minConfidence}`
						: `judge confidence ${confidence} below required ${minConfidence}`,
				],
				confidence,
			};
		}
	}
	return {
		verdict: verdict as DecisionVerdict,
		selectedOption: typeof raw["selectedOption"] === "string" ? raw["selectedOption"] : undefined,
		reasons: reasons.length > 0 ? reasons : [`judge verdict: ${verdict}`],
		confidence,
	};
}

/**
 * Requirement coverage: every capability id must appear in evidence text (AC6).
 * Matching ceiling: whole-word substring only — a capability whose verification is a
 * real command cannot be truly evidenced by prose; per-capability verify commands are
 * the proper fix and stay deferred with full AC6.
 */
export function coverageGaps(capabilities: string[], evidence: Evidence[]): string[] {
	const corpus = evidence.map(e => `${e.source} ${e.quote}`).join("\n").toLowerCase();
	return capabilities.filter(c => {
		const term = c.trim().toLowerCase();
		if (term.length === 0) return false;
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return !new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "u").test(corpus);
	});
}

// ---------- controller ----------

export interface ControllerDeps {
	judge: Judge;
	/** Bounded rework per task+stage (FR-12). */
	maxReworkIterations?: number;
	minConfidence?: number;
	now?: () => number;
	/** Template overrides (R1-R6): threshold may only RAISE the bar; stage shaping only. */
	template?: JevTemplateConfig;
	/** Validation error from a config file: fail closed on every submission (R5). */
	templateError?: string;
}

/** Minimal structural surface of the omp ExtensionAPI the controller needs. */
export interface PiApi {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
	}): void;
	appendEntry(customType: string, data?: unknown): void;
	sendMessage(
		payload: unknown,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void;
}

export class JevController {
	private state: JevState = freshState();
	private readonly judge: Judge;
	private readonly maxReworkIterations: number;
	private readonly now: () => number;
	private pi: PiApi | undefined;
	private template: JevTemplateConfig;
	private templateError: string | undefined;
	/** R1: never below POLICY floor; a template override may only raise it. */
	private minConfidence: number;

	constructor(deps: ControllerDeps) {
		this.judge = deps.judge;
		this.maxReworkIterations = deps.maxReworkIterations ?? POLICY.maxReworkIterations;
		// R1: a confidenceThreshold override may only RAISE the bar above POLICY.
		this.minConfidence = Math.max(
			deps.minConfidence ?? POLICY.minConfidenceToApprove,
			deps.template?.confidenceThreshold ?? 0,
		);
		this.now = deps.now ?? (() => Date.now());
		this.template = deps.template ?? {};
		this.templateError = deps.templateError;
	}

	/** Re-validate config mid-session (R5): corruption degrades to typed fail-closed errors. */
	setTemplateState(template: JevTemplateConfig | undefined, templateError?: string): void {
		this.template = template ?? {};
		this.templateError = templateError;
		if (templateError === undefined && template?.confidenceThreshold !== undefined) {
			this.minConfidence = Math.max(POLICY.minConfidenceToApprove, template.confidenceThreshold);
		}
	}

	// ----- registration -----

	register(pi: PiApi): void {
		this.pi = pi;
		pi.registerTool({
			name: TOOL_NAME,
			label: "Jev decision",
			description:
				"Submit a structured important decision, review or completion claim to the Jev judge. " +
				"Required before any file-mutating work and before finishing mutated work. Provide fixed options " +
				"and evidence as {kind, source, quote} items (kind: user|spec|code|execution|log|documentation). " +
				"Completion claims additionally need execution/code/log evidence; pass `capabilities` " +
				"(original feature ids) for refactor completion coverage checks.",
			parameters: {
				type: "object",
				properties: {
					stage: { type: "string", description: "which gate this decision belongs to" },
					task: { type: "string", description: "what is being decided" },
					proposal: { type: "string", description: "the proposal/result under judgment" },
					options: {
						type: "array",
						items: {
							type: "object",
							properties: { id: { type: "string" }, label: { type: "string" }, meaning: { type: "string" } },
							required: ["id", "label", "meaning"],
						},
					},
					evidence: {
						type: "array",
						items: {
							type: "object",
							properties: { kind: { type: "string" }, source: { type: "string" }, quote: { type: "string" } },
							required: ["kind", "source", "quote"],
						},
					},
					capabilities: { type: "array", items: { type: "string" } },
				},
				required: ["stage", "task", "proposal", "options", "evidence"],
			},
			execute: async (_id: string, params: unknown) => {
				const outcome = await this.submitDecision(params);
				return { content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }], details: outcome };
			},
		});
		pi.on("tool_call", (event, ctx) => this.onToolCall(event, ctx));
		pi.on("before_agent_start", event => this.onBeforeAgentStart(event));
		pi.on("session_stop", event => this.onSessionStop(event));
		pi.on("before_subagent_spawn", (event, ctx) => this.onBeforeSubagentSpawn(event, ctx));
	}

	// ----- event handlers (also directly test-invokable) -----

	/**
	 * Pre-execution gates (AC4a): malformed jev_decision input never reaches the judge;
	 * mutating tool calls are blocked until the plan gate holds for the current task.
	 * Read-only tools pass untouched in every case.
	 */
	onToolCall(event: unknown, _ctx?: unknown): { block?: boolean; reason?: string } | undefined {
		if (!isRecord(event)) return undefined;
		const toolName = event["toolName"];
		if (toolName === TOOL_NAME) {
			const check = validateDecisionInput(event["input"]);
			if (!check.ok) {
				return { block: true, reason: `jev_decision rejected before judging: ${check.reasons.join("; ")}` };
			}
			return undefined;
		}
		if (typeof toolName === "string" && MUTATING_TOOLS.has(toolName)) {
			const plan = this.planApproval();
			if (plan === undefined) {
				return {
					block: true,
					reason:
						"plan gate: mutating work requires an approved understanding_review or direction_review " +
						`for the current task first. Call ${TOOL_NAME} with the plan stage and evidence. ` +
						"Read-only evidence gathering remains available. " +
						`Submit decisions with the registered ${TOOL_NAME} TOOL (tool call), not by writing files ` +
						`(e.g. to xd://${TOOL_NAME}); ` +
						"the block message you received does not mean the addon is unavailable.",
				};
			}
			this.state.mutationsSeen = true;
			this.state.workRevision += 1;
			this.persist();
		}
		return undefined;
	}

	async onBeforeAgentStart(event: unknown): Promise<void> {
		if (!isRecord(event) || typeof event["prompt"] !== "string") return;
		const fp = await fingerprint(event["prompt"]);
		if (fp !== this.state.taskFingerprint) {
			this.state.taskFingerprint = fp;
			this.persist();
		}
	}

	async onSessionStop(event: unknown): Promise<StopGateResult | undefined> {
		if (!isRecord(event)) return undefined;
		// Never block on a continuation of our own block: finite rework (FR-12, AC4 fail-visible).
		if (event["stop_hook_active"] === true) {
			const missing = this.unmetStopGates();
			if (missing.length > 0) {
				const blocker =
					`Jev gates still unmet after one continuation (${missing.join(", ")}). ` +
					"Stopped WITHOUT fake success: run jev_decision with the required stage and evidence, " +
					"or resolve with the user.";
				if (!this.state.blockers.includes(blocker)) {
					this.state.blockers.push(blocker);
					this.persist();
					this.pushFeedback(blocker);
				}
			}
			return undefined;
		}
		const missing = this.unmetStopGates();
		if (missing.length === 0) return undefined;
		return {
			decision: "block",
			reason:
				`Jev gate(s) not satisfied: ${missing.join("; ")}. ` +
				`Call the ${TOOL_NAME} tool with the required stage, fixed options and quoted evidence ` +
				"(completion needs execution/code/log evidence; refactors must evidence every original capability).",
		};
	}

	onBeforeSubagentSpawn(event: unknown, ctx?: unknown): SpawnRouteResult | undefined {
		if (!isRecord(event) || this.state.routedModel === undefined) return undefined;
		const wanted = this.state.routedModel;
		const listed = hostModelIds(ctx);
		if (listed.includes(wanted)) {
			return { model: wanted, note: `Jev model_routing selected ${wanted}; host list confirmed.` };
		}
		return {
			block: true,
			reason:
				`Jev model routing selected ${wanted}, but it is not among the host's authenticated models ` +
				`(${listed.join(", ") || "none"}). Jev never substitutes other models; adjust the routing decision or host config.`,
		};
	}

	/** Record an applied model-routing decision; enforced against the host model list at spawn (AC2). */
	rememberModelRouting(model: string): void {
		this.state.routedModel = model;
		this.persist();
	}

	/** Record an applied skill-routing selection (AC2 dispatch visibility). */
	rememberSkillRouting(skill: string): void {
		this.state.routedSkill = skill;
		this.persist();
	}

	/** Restore persisted state from session custom entries (session continuity, no cache claims). */
	onSessionStart(entries: ReadonlyArray<{ customType?: unknown; data?: unknown }>): void {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry: { customType?: unknown; data?: unknown } | undefined = entries[i];
			if (entry === undefined) continue;
			if (entry.customType !== STATE_ENTRY_TYPE || !isRecord(entry.data)) continue;
			const data = entry.data;
			// Validate each restored approval; drop malformed records rather than trusting disk.
			const restoredApprovals: ApprovalRecord[] = Array.isArray(data["approvals"])
				? data["approvals"].flatMap((a: unknown): ApprovalRecord[] => {
						if (!isRecord(a)) return [];
						const stage = a["stage"];
						const revisionHash = a["revisionHash"];
						const workRevision = a["workRevision"];
						const approvedAt = a["approvedAt"];
						if (typeof stage !== "string" || !STAGES.has(stage)) return [];
						if (!nonEmptyString(revisionHash)) return [];
						if (typeof workRevision !== "number" || !Number.isFinite(workRevision)) return [];
						if (typeof approvedAt !== "number" || !Number.isFinite(approvedAt)) return [];
						if (!nonEmptyString(a["selectedOption"])) return [];
						return [
							{
								stage: stage as DecisionStage,
								revisionHash,
								taskFingerprint: typeof a["taskFingerprint"] === "string" ? a["taskFingerprint"] : undefined,
								workRevision,
								selectedOption: a["selectedOption"] as string,
								approvedAt,
							},
						];
					})
				: [];
			this.state = {
				approvals: restoredApprovals,
				iterations: isRecord(data["iterations"]) ? (data["iterations"] as Record<string, number>) : {},
				workRevision: typeof data["workRevision"] === "number" ? data["workRevision"] : 0,
				taskFingerprint: typeof data["taskFingerprint"] === "string" ? data["taskFingerprint"] : undefined,
				mutationsSeen: data["mutationsSeen"] === true,
				blockers: Array.isArray(data["blockers"])
					? data["blockers"].filter((b): b is string => typeof b === "string")
					: [],
				routedModel: typeof data["routedModel"] === "string" ? data["routedModel"] : undefined,
				routedSkill: typeof data["routedSkill"] === "string" ? data["routedSkill"] : undefined,
			};
			return;
		}
	}

	getState(): JevState {
		return this.state;
	}

	// ----- core decision flow -----

	/**
	 * Full decision pipeline: validate -> coverage -> bound -> judge -> normalize -> record.
	 * Judge throw/unavailability and any malformed answer can never approve (AC4c/d).
	 * Approvals bind to the exact content digest (AC5); a new approve for the same stage/task
	 * with different content supersedes and invalidates the earlier record.
	 */
	async submitDecision(raw: unknown): Promise<DecisionOutcome> {
		if (this.templateError !== undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`jev config invalid (fail-closed, defaults NOT applied): ${this.templateError}`],
				judged: false,
			};
		}
		const check = validateDecisionInput(raw);
		if (!check.ok || check.input === undefined) {
			return { verdict: "insufficient_evidence", reasons: check.reasons, judged: false };
		}
		const input = check.input;

		if (input.stage === "completion_review") {
			if (!input.evidence.some(e => COMPLETION_EVIDENCE_KINDS.has(e.kind))) {
				return {
					verdict: "insufficient_evidence",
					reasons: [
						"completion_review requires at least one execution, code or log evidence item; " +
							"a textual report alone is insufficient",
					],
					judged: false,
				};
			}
			const effectiveCaps = input.capabilities.length > 0 ? input.capabilities : (this.template.capabilities ?? []);
			if (effectiveCaps.length > 0) {
				const gaps = coverageGaps(effectiveCaps, input.evidence);
				if (gaps.length > 0) {
					return {
						verdict: "revise",
						reasons: [
							`refactor requirement coverage incomplete: no evidence covers capability id(s) ${gaps.join(", ")}`,
						],
						judged: false,
					};
				}
			}
		}

		const taskFp = this.state.taskFingerprint ?? (await fingerprint(input.task));
		const boundKey = `${taskFp}:${input.stage}`;
		const used = this.state.iterations[boundKey] ?? 0;
		if (used >= this.maxReworkIterations) {
			const blocker =
				`Jev rework bound exhausted for stage ${input.stage} (${used} judge consultations). ` +
				"Escalated to the user; do not continue rework and do not claim completion.";
			if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
			this.persist();
			this.pushFeedback(blocker);
			return { verdict: "ask_user", reasons: [blocker], judged: false };
		}

		// R3: template options replace the executor's fixed option set for this stage.
		const templateStage = this.template.stages?.[input.stage];
		const judgeOptions = templateStage?.options ?? input.options;
		// R2: built-in evidence policy first, template instructions appended after (cap 4000).
		let judgeProposal =
			`${input.proposal}\n\nJev evidence policy: evidence items must quote real artifacts ` +
			"(user/spec/code/execution/log/documentation); completion claims require execution/code/log " +
			"evidence; refactor completions must evidence every declared capability.";
		if (templateStage?.instructions !== undefined) {
			judgeProposal += `\n\n${templateStage.instructions.slice(0, 4000)}`;
		}
		// Config capabilities are DEFAULTS; caller-passed wins.
		const capabilities = input.capabilities.length > 0 ? input.capabilities : (this.template.capabilities ?? []);

		let rawResult: DecisionResult;
		try {
			rawResult = await this.judge({
				stage: input.stage,
				task: input.task,
				proposal: judgeProposal,
				options: judgeOptions,
				evidence: input.evidence,
			});
		} catch (err) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`],
				judged: false,
			};
		}

		const result = normalizeJudgeResult(rawResult, judgeOptions, this.minConfidence);
		this.state.iterations[boundKey] = used + 1;

		if (result.verdict === "approve" && result.selectedOption !== undefined) {
			const digest = await revisionHash(input.stage, input.task, input.proposal, input.evidence);
			// AC5 replay/supersede: an older approval of the same stage for this task with a
			// different content digest is no longer authoritative.
			this.state.approvals = this.state.approvals.filter(
				a => !(a.stage === input.stage && a.taskFingerprint === this.state.taskFingerprint && a.revisionHash !== digest),
			);
			this.state.approvals.push({
				stage: input.stage,
				revisionHash: digest,
				// Bind to the established user-task fingerprint; when none is established the
				// strict gate comparisons below treat the approval as stale (fail-safe, AC5).
				taskFingerprint: this.state.taskFingerprint,
				workRevision: this.state.workRevision,
				selectedOption: result.selectedOption,
				approvedAt: this.now(),
			});
			if (input.stage === "model_routing") {
				const selected = judgeOptions.find(o => o.id === result.selectedOption);
				// Host gate compares model IDs (ctx.models.list() ids); store the option ID.
				if (selected) this.rememberModelRouting(selected.id);
			}
			if (input.stage === "skill_routing") {
				const selected = judgeOptions.find(o => o.id === result.selectedOption);
				if (selected) this.rememberSkillRouting(selected.label);
			}
		}
		if (result.verdict === "revise") {
			this.pushFeedback(`Jev judge asked for revision: ${result.reasons.join(" ")}`);
		}
		this.persist();
		return { ...result, judged: true };
	}

	// ----- internals -----

	private planApproval(): ApprovalRecord | undefined {
		// Undefined current fingerprint means no user task is established yet: no gate credit.
		if (this.state.taskFingerprint === undefined) return undefined;
		return this.state.approvals.find(
			a => PLAN_STAGES.has(a.stage) && a.taskFingerprint === this.state.taskFingerprint,
		);
	}

	private unmetStopGates(): string[] {
		if (!this.state.mutationsSeen) return [];
		const missing: string[] = [];
		if (this.planApproval() === undefined) {
			missing.push("no plan-stage approval (understanding_review or direction_review) for the current task");
		}
		// Latest approval wins: supersede keeps same-digest records, so the freshest
		// completion_review must be consulted, not the first.
		let completion: ApprovalRecord | undefined;
		for (const a of this.state.approvals) {
			if (a.stage === "completion_review") completion = a;
		}
		if (completion === undefined) {
			missing.push("no completion_review approval at all");
		} else if (completion.taskFingerprint !== this.state.taskFingerprint) {
			// Strict comparison: an approval from before any fingerprint was set must NOT
			// pass once a new task establishes a fingerprint (AC5).
			missing.push(
				`completion_review approval is stale: the user task changed since it was granted ` +
					`(approved ${completion.taskFingerprint}, now ${this.state.taskFingerprint ?? "unknown"})`,
			);
		} else if (completion.workRevision !== this.state.workRevision) {
			missing.push(
				`completion_review approval is stale: work revision ${this.state.workRevision} > approved ${completion.workRevision}`,
			);
		}
		return missing;
	}

	/** Same-session feedback via the host's real message injection (AC7). */
	private pushFeedback(text: string): void {
		this.pi?.sendMessage(
			{ customType: "jev-feedback", content: text, display: true },
			{ deliverAs: "aside", triggerTurn: false },
		);
	}

	private persist(): void {
		this.pi?.appendEntry(STATE_ENTRY_TYPE, this.state);
	}
}

function hostModelIds(ctxOrList: unknown): string[] {
	if (Array.isArray(ctxOrList)) {
		return ctxOrList.filter(m => typeof m === "string") as string[];
	}
	if (!isRecord(ctxOrList)) return [];
	const models = ctxOrList["models"];
	if (!isRecord(models) || typeof models["list"] !== "function") return [];
	try {
		const list = (models["list"] as () => unknown[])();
		return list.filter(m => isRecord(m) && typeof m["id"] === "string").map(m => (m as { id: string }).id);
	} catch {
		return [];
	}
}

/** Test seam / DI entry point. */
export function createJevController(deps: ControllerDeps): JevController {
	return new JevController(deps);
}
