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
import {
	type ControlPoint,
	lookupControlPoint,
	validateDeclaredControlPoint,
} from "./control-points.js";
import { STAGES } from "./stages.js";
import { POLICY, type CourseCheckJudge, type CourseCheckResult } from "./types.js";
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
	/** Latest course_check outcome — recorded, never grants an approval. */
	lastCourseCheck: { selectedOption: string; at: number } | undefined;
	/** Open aspect_coverage drift: missed aspect ids for the current task (completion teeth). */
	openAspectGaps: { missed: string[]; taskFingerprint: string | undefined } | undefined;
	/** Calibration-tolerant completion: consecutive mid-band approves (FR: calibration rule). */
	consecutiveCompletionApproves: { count: number; confidences: number[]; taskFingerprint: string | undefined; workRevision: number } | undefined;
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
		lastCourseCheck: undefined,
		openAspectGaps: undefined,
		consecutiveCompletionApproves: undefined,
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
	/** Non-fatal evidence-quality codes surfaced alongside a judged verdict. */
	warnings?: string[];
	/** One-line fixed-template summary for executor readability (no generated prose). */
	summary: string;
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
/** course_check redirecting options: approve+these map to revise (registry holds the full set). */
const COURSE_CHECK_REDIRECTING: ReadonlySet<string> = new Set(["return_to_requirement", "replan"]);
const STATE_ENTRY_TYPE = "jev.state";
const TOOL_NAME = "jev_decision";

export interface ValidatedDecisionInput {
	stage: DecisionStage;
	task: string;
	proposal: string;
	options: DecisionOption[];
	evidence: Evidence[];
	capabilities: string[];
	/** Claimed-aspect catalog ids for the aspect_coverage preset. */
	aspects: string[];
}

export interface ValidationResult {
	ok: boolean;
	reasons: string[];
	input?: ValidatedDecisionInput;
}

/** Validate the executor's structured decision submission. Never throws. */
export function validateDecisionInput(raw: unknown, extraStages: ReadonlySet<string> = new Set()): ValidationResult {
	const reasons: string[] = [];
	if (!isRecord(raw)) return { ok: false, reasons: ["decision input must be a JSON object"] };
	const stage = raw["stage"];
	if (typeof stage !== "string" || !(STAGES.has(stage) || extraStages.has(stage))) {
		reasons.push(`stage must be one of: ${[...new Set([...STAGES, ...extraStages])].join(", ")}`);
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
	const aspects = Array.isArray(raw["aspects"])
		? raw["aspects"].filter((a): a is string => typeof a === "string" && a.trim().length > 0)
		: [];
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
			aspects,
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

// ---------- aspect_coverage (forgotten-aspect detection, user order) ----------

export type AspectMarking =
	| "applicable_and_addressed"
	| "applicable_not_addressed"
	| "not_applicable";

export interface AspectCoverageRequest {
	aspects: Array<{ id: string; text: string }>;
	currentAction: string;
	evidence: Evidence[];
}

export interface AspectCoverageResult {
	markings: Record<string, AspectMarking>;
	reasons: string[];
	confidence?: number;
	/** False when the judge could not be consulted (fail-closed; never a mapping). */
	judged: boolean;
	/** Meta-option escape: judge cannot mark this batch -> insufficient_evidence. */
	escape?: boolean;
}

export type AspectCoverageJudge = (request: AspectCoverageRequest) => Promise<AspectCoverageResult>;

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
	/** Per-requirement drift judge for the course_check preset (C1 wired path). */
	courseCheckJudge?: CourseCheckJudge;
	/** Three-way aspect marking judge for the aspect_coverage preset. */
	aspectCoverageJudge?: AspectCoverageJudge;
	/** Valid catalog topic ids for the aspects[] pre-check (built in index from the catalog). */
	catalogIds?: ReadonlySet<string>;
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
	private readonly courseCheckJudge: CourseCheckJudge | undefined;
	private readonly aspectCoverageJudge: AspectCoverageJudge | undefined;
	private readonly catalogIds: ReadonlySet<string>;
	private template: JevTemplateConfig;
	private templateError: string | undefined;
	/** Config-declared on_demand control points (controlPoints key). */
	private extraPoints: ReadonlyMap<string, ControlPoint> = new Map();
	/** R1: never below POLICY floor; a template override may only raise it. */
	private minConfidence: number;
	/** Calibration-tolerant completion: template/config may only RAISE these (Math.max clamp). */
	private readonly completionConsecutiveApproves: number;
	private readonly completionConfidenceFloor: number;

	constructor(deps: ControllerDeps) {
		this.judge = deps.judge;
		this.courseCheckJudge = deps.courseCheckJudge;
		this.aspectCoverageJudge = deps.aspectCoverageJudge;
		this.catalogIds = deps.catalogIds ?? new Set();
		this.maxReworkIterations = deps.maxReworkIterations ?? POLICY.maxReworkIterations;
		// R1: a confidenceThreshold override may only RAISE the bar above POLICY.
		this.minConfidence = Math.max(
			deps.minConfidence ?? POLICY.minConfidenceToApprove,
			deps.template?.confidenceThreshold ?? 0,
		);
		this.now = deps.now ?? (() => Date.now());
		this.template = deps.template ?? {};
		this.templateError = deps.templateError;
		this.extraPoints = extraPointsFromTemplate(this.template);
		this.completionConsecutiveApproves = Math.max(
			POLICY.completionConsecutiveApproves,
			(deps.template as { completion?: { consecutiveApproves?: number } } | undefined)?.completion
				?.consecutiveApproves ?? 0,
		);
		this.completionConfidenceFloor = Math.max(
			POLICY.completionConfidenceFloor,
			(deps.template as { completion?: { confidenceFloor?: number } } | undefined)?.completion
				?.confidenceFloor ?? 0,
		);
	}

	/** Re-validate config mid-session (R5): corruption degrades to typed fail-closed errors. */
	setTemplateState(template: JevTemplateConfig | undefined, templateError?: string): void {
		this.template = template ?? {};
		this.extraPoints = extraPointsFromTemplate(this.template);
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
				"If any action is blocked by the plan gate, your very next tool call MUST be jev_decision itself " +
				"with stage=understanding_review (plan stage) and verbatim quoted evidence — do not write files " +
				"first, do not report the block to the user. " +
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
				return {
					content: [
						{
							type: "text",
							text: `${outcome.summary}\n${JSON.stringify(outcome, null, 2)}`,
						},
					],
					details: outcome,
				};
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
			const check = validateDecisionInput(event["input"], this.extraStageSet());
			if (!check.ok) {
				return {
					block: true,
					reason:
						`jev_decision rejected before judging: ${check.reasons.join("; ")}. ` +
						`Fix the listed problems and call ${TOOL_NAME} again.`,
				};
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
						"the block message you received does not mean the addon is unavailable. " +
						"Your next tool call must be jev_decision (a normal registered tool call, exactly like read/write) — not a file write.",
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
						if (typeof stage !== "string" || !(STAGES.has(stage) || this.extraStageSet().has(stage))) return [];
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
				lastCourseCheck: undefined,
				openAspectGaps: undefined,
				consecutiveCompletionApproves: undefined,
			};
			return;
		}
	}

	getState(): JevState {
		return this.state;
	}

	// ----- core decision flow -----

	/** Public pipeline: run the core flow, then attach the one-line fixed-template summary. */
	async submitDecision(raw: unknown): Promise<DecisionOutcome> {
		const outcome = await this.submitDecisionCore(raw);
		if (outcome.summary !== "") return outcome;
		const stage = isRecord(raw) && typeof raw["stage"] === "string" ? raw["stage"] : "unknown";
		const options =
			isRecord(raw) && Array.isArray(raw["options"]) ? (raw["options"] as Array<Record<string, unknown>>) : [];
		const meaningOf = (id: string | undefined): string => {
			if (id === undefined) return "";
			const opt = options.find(o => o["id"] === id);
			return opt && typeof opt["meaning"] === "string" ? `: ${opt["meaning"]}` : "";
		};
		const taskText = isRecord(raw) && typeof raw["task"] === "string" ? raw["task"] : "";
		const fp = this.state.taskFingerprint ?? (taskText.length > 0 ? await fingerprint(taskText) : "");
		const used = this.state.iterations[`${fp}:${stage}`] ?? 0;
		let line: string;
		switch (outcome.verdict) {
			case "approve":
				line = `${stage}: approve — ${outcome.selectedOption ?? ""}${meaningOf(outcome.selectedOption)}`;
				break;
			case "revise":
				line = `${stage}: revise — sent back with reasons (iteration ${used}/${this.maxReworkIterations})`;
				break;
			case "ask_user":
				line = `${stage}: ask_user — escalate to the user`;
				break;
			default:
				line =
					outcome.judged
						? `${stage}: insufficient_evidence — judge answered insufficient_evidence (confidence ${outcome.confidence ?? "n/a"}) — improve evidence and re-submit`
						: `${stage}: insufficient_evidence — judge not consulted or answer unusable; fix the request`;
		}
		return { ...outcome, summary: line };
	}

	/**
	 * Full decision pipeline: validate -> coverage -> bound -> judge -> normalize -> record.
	 * Judge throw/unavailability and any malformed answer can never approve (AC4c/d).
	 * Approvals bind to the exact content digest (AC5); a new approve for the same stage/task
	 * with different content supersedes and invalidates the earlier record.
	 */
	private async submitDecisionCore(raw: unknown): Promise<DecisionOutcome> {
		if (this.templateError !== undefined) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`jev config invalid (fail-closed, defaults NOT applied): ${this.templateError}`],
				judged: false,
				summary: "config error: jev refuses to decide; fix the config file",
			};
		}
		const check = validateDecisionInput(raw, this.extraStageSet());
		if (!check.ok || check.input === undefined) {
			return { verdict: "insufficient_evidence", reasons: check.reasons, judged: false, summary: "" };
		}
		const input = check.input;

		// P3 evidence pre-check: catch would-be-wasted consultations before burning the
		// rework counter. >=2 problems (or missing requirement evidence on plan stages)
		// reject immediately; a single quality problem judges with a warnings annotation.
		const planStage = lookupControlPoint(input.stage, this.extraPoints)?.trigger === "mutation_gate";
		const problems: string[] = [];
		const warnings: string[] = [];
		const seenQuotes = new Map<string, number>();
		input.evidence.forEach((e, i) => {
			const first = seenQuotes.get(e.quote);
			if (first !== undefined) {
				problems.push(`duplicate_evidence_quote#${i}`);
				warnings.push(`duplicate_evidence_quote#${i}`);
				return;
			}
			seenQuotes.set(e.quote, i);
			if (e.quote.length < 20) {
				problems.push(`quote_too_short:${e.source}#${i}`);
				warnings.push(`quote_too_short:${e.source}#${i}`);
			}
		});
		if (planStage && !input.evidence.some(e => e.kind === "user" || e.kind === "spec")) {
			problems.push("no_requirement_evidence");
		}
		if (problems.includes("no_requirement_evidence") || problems.length >= 2) {
			return { verdict: "insufficient_evidence", reasons: problems, judged: false, summary: "" };
		}

		const point = lookupControlPoint(input.stage, this.extraPoints);
		if (point?.requiresArtifactEvidence === true) {
			if (!input.evidence.some(e => COMPLETION_EVIDENCE_KINDS.has(e.kind))) {
				return {
					verdict: "insufficient_evidence",
					reasons: [
						"completion_review requires at least one execution, code or log evidence item; " +
							"a textual report alone is insufficient",
					],
					judged: false,
					summary: "",
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
						summary: "",
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
			return { verdict: "ask_user", reasons: [blocker], judged: false, summary: "" };
		}

		// R3: template options replace the executor's fixed option set for this stage.
		const templateStage = this.template.stages?.[input.stage] ?? this.extraStageTemplate(input.stage);
		const judgeOptions = templateStage?.options ?? input.options;
		if (point?.fixedOptionIds !== undefined && templateStage?.options === undefined) {
			const ids = new Set(judgeOptions.map(o => o.id));
			const mismatch = [...point.fixedOptionIds].filter(id => !ids.has(id));
			if (mismatch.length > 0 || ids.size !== judgeOptions.length) {
				return {
					verdict: "insufficient_evidence",
					reasons: [
						"this control point requires exactly its fixed options " +
							`[...${[...(point.fixedOptionIds ?? [])].join(", ")}] (template override may replace them)`,
					],
					judged: false,
					summary: "",
				};
			}
		}
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

		// C1 wired path: course_check preset consults the dedicated per-requirement judge.
		if (input.stage === "course_check" && this.courseCheckJudge !== undefined) {
			return this.submitCourseCheck(input, boundKey, used);
		}
		// aspect_coverage preset: catalog pre-check + dedicated three-way judge.
		if (input.stage === "aspect_coverage") {
			const unknown = input.aspects.filter(id => !this.catalogIds.has(id));
			if (input.aspects.length === 0) {
				return {
					verdict: "insufficient_evidence",
					reasons: ["aspect_coverage requires a non-empty aspects list of catalog topic ids"],
					judged: false,
					summary: "",
				};
			}
			if (unknown.length > 0) {
				return {
					verdict: "insufficient_evidence",
					reasons: [`unknown_aspect_id: ${unknown.join(", ")}`],
					judged: false,
					summary: "",
				};
			}
			if (this.aspectCoverageJudge !== undefined) {
				return this.submitAspectCoverage(input, boundKey, used);
			}
			// No judge wired: keep the pre-check result as a typed correction, fail-closed.
			return {
				verdict: "insufficient_evidence",
				reasons: ["aspect_coverage judge not configured in this session"],
				judged: false,
				summary: "",
			};
		}

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
				summary: "",
			};
		}

		// Calibration-tolerant completion: normalize with the lowered bar so mid-band
		// approves survive; the counting block below enforces floor/count/teeth.
		const stopStage = lookupControlPoint(input.stage, this.extraPoints)?.trigger === "session_stop";
		const normalizeBar = stopStage
			? Math.min(this.minConfidence, this.completionConfidenceFloor)
			: this.minConfidence;
		const normalized = normalizeJudgeResult(rawResult, judgeOptions, normalizeBar);
		this.state.iterations[boundKey] = used + 1;
		// course_check advisory-to-binding mapping (record, never approve anything).
		let result = normalized;
		if (point?.verdictMapping === "course_check" && normalized.verdict === "ask_user") {
			// Judge itself chose ask_user: escalate with a recorded blocker.
			result = this.escalateCourseCheck(normalized);
		}
		if (point?.verdictMapping === "course_check" && normalized.verdict === "approve" && normalized.selectedOption !== undefined) {
			const picked = normalized.selectedOption;
			if (COURSE_CHECK_REDIRECTING.has(picked)) {
				result = {
					verdict: "revise",
					reasons: [...normalized.reasons, `course_check redirects: ${picked}`],
					confidence: normalized.confidence,
				};
			} else if (picked === "ask_user") {
				result = this.escalateCourseCheck(normalized);
			} else {
				// continue / verify_before_proceeding: record only, approves nothing.
				this.state.lastCourseCheck = { selectedOption: picked, at: this.now() };
			}
		}

		// Advisory points (course_check benign pair, config-declared on_demand) never
		// record gate approvals; their outcomes live in state records/feedback only.
		// Calibration-tolerant completion rule: 0.6<=conf<minConfidence counts toward
		// consecutive approves (count/floor clamp raise-only); reset on non-approve, work
		// bump or task change; below-floor never counts.
		if (
			stopStage &&
			result.verdict === "approve" &&
			result.confidence !== undefined &&
			result.confidence < this.completionConfidenceFloor
		) {
			this.state.consecutiveCompletionApproves = undefined;
			this.persist();
			return {
				verdict: "insufficient_evidence",
				reasons: [`conf=${result.confidence} below calibration floor ${this.completionConfidenceFloor}`],
				confidence: result.confidence,
				judged: true,
				summary: "",
			};
		}
		if (
			stopStage &&
			result.verdict === "approve" &&
			result.confidence !== undefined &&
			result.confidence < this.minConfidence
		) {
			const prev = this.state.consecutiveCompletionApproves;
			const fresh =
				prev === undefined ||
				prev.taskFingerprint !== this.state.taskFingerprint ||
				prev.workRevision !== this.state.workRevision;
			const streak = fresh
				? {
						count: 0,
						confidences: [] as number[],
						taskFingerprint: this.state.taskFingerprint,
						workRevision: this.state.workRevision,
					}
				: prev;
			streak.count += 1;
			streak.confidences.push(result.confidence);
			this.state.consecutiveCompletionApproves = streak;
			if (streak.count < this.completionConsecutiveApproves) {
				this.persist();
				return {
					verdict: "insufficient_evidence",
					reasons: [
						"completion_pending_consecutive_approves",
						`n=${streak.count}/${this.completionConsecutiveApproves}`,
						`conf=${result.confidence}`,
					],
					confidence: result.confidence,
					judged: true,
					summary: "",
				};
			}
			result = {
				...result,
				reasons: [
					"consecutive_approves",
					`n=${streak.count}`,
					`conf=${streak.confidences.join(", ")}`,
					...result.reasons,
				],
			};
		} else if (stopStage && result.verdict !== "approve") {
			this.state.consecutiveCompletionApproves = undefined;
		}

		const skipApproval =
			point?.trigger === "on_demand" &&
			!(point.verdictMapping === "course_check" &&
				(result.selectedOption === "ask_user" || COURSE_CHECK_REDIRECTING.has(result.selectedOption ?? "")));
		if (result.verdict === "approve" && result.selectedOption !== undefined && !skipApproval) {
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
		if (warnings.length > 0) {
			return { ...result, judged: true, warnings, summary: "" };
		}
		return { ...result, judged: true, summary: "" };
	}

	/**
	 * C1 wired course_check: per-requirement drift (Noul) + next-action Choice in ONE request.
	 * Verdict mapping: continue/verify_before_proceeding -> recorded (no approval);
	 * return_to_requirement/replan -> revise + feedback; ask_user -> escalation.
	 * Fail-closed identical: throw/unjudged/contract-violation -> insufficient_evidence, no record.
	 */
	private async submitCourseCheck(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		// Deterministic dedupe: judge questions are keyed by requirement id, so duplicate
		// ids must never silently collapse a drift check. Same id + same quote merges;
		// same id + different quote gets a #N suffix so every distinct requirement is judged.
		const requirements: Array<{ id: string; quote: string }> = [];
		const seenQuotes = new Map<string, string>();
		input.evidence
			.filter(e => e.kind === "user" || e.kind === "spec")
			.forEach((e, i) => {
				const base = nonEmptyString(e.source) ? e.source : `req-${i}`;
				if (seenQuotes.get(base) === e.quote) return;
				let id = base;
				for (let n = 2; requirements.some(r => r.id === id); n++) id = `${base}#${n}`;
				seenQuotes.set(id, e.quote);
				requirements.push({ id, quote: e.quote });
			});
		if (requirements.length === 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["course_check requires at least one user or spec evidence item as the requirement under check"],
				judged: false,
				summary: "",
			};
		}
		let raw: CourseCheckResult;
		try {
			raw = await this.courseCheckJudge!({
				requirements,
				currentAction: input.proposal,
				evidence: input.evidence,
			});
		} catch (err) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`],
				judged: false,
				summary: "",
			};
		}
		if (!isRecord(raw) || raw["judged"] !== true || typeof raw["nextAction"] !== "string") {
			// Contract violation / judge could not be consulted: never auto-continue.
			return {
				verdict: "insufficient_evidence",
				reasons: ["course_check judge returned an unjudged or malformed result; no action taken"],
				judged: false,
				summary: "",
			};
		}
		const nextAction = raw["nextAction"] as string;
		const onTrack = isRecord(raw["onTrack"]) ? raw["onTrack"] : {};
		const drifted = Object.entries(onTrack)
			.filter(([, ok]) => ok !== true)
			.map(([id]) => id);
		const reasons = [...(Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : [])];
		if (drifted.length > 0) reasons.push(`not on track: ${drifted.join(", ")}`);
		this.state.iterations[boundKey] = used + 1;
		if (nextAction === "continue" || nextAction === "verify_before_proceeding") {
			this.state.lastCourseCheck = { selectedOption: nextAction, at: this.now() };
			this.persist();
			return {
				verdict: "approve",
				selectedOption: nextAction,
				reasons,
				confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
				judged: true,
				summary: "",
			};
		}
		const driftSuffix = drifted.length > 0 ? ` (drifted: ${drifted.join(", ")})` : "";
		if (nextAction === "return_to_requirement" || nextAction === "replan") {
			this.pushFeedback(`Jev course_check redirects: ${nextAction}${driftSuffix}`);
			this.persist();
			return {
				verdict: "revise",
				selectedOption: nextAction,
				reasons,
				judged: true,
				summary: `course_check: revise — ${nextAction}: back to requirement${driftSuffix}`,
			};
		}
		// ask_user
		const blocker = "course_check escalated to the user (ask_user chosen by the judge or rework bound).";
		if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
		this.persist();
		return {
			verdict: "ask_user",
			selectedOption: nextAction,
			reasons: [...reasons, blocker],
			judged: true,
			summary: "",
		};
	}

	/** aspect_coverage three-way marking: missed aspects -> revise; else recorded, no approval. */
	private async submitAspectCoverage(
		input: ValidatedDecisionInput,
		boundKey: string,
		used: number,
	): Promise<DecisionOutcome> {
		let raw: AspectCoverageResult;
		try {
			raw = await this.aspectCoverageJudge!({
				aspects: input.aspects.map(id => ({ id, text: id })),
				currentAction: input.proposal,
				evidence: input.evidence,
			});
		} catch (err) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`],
				judged: false,
				summary: "",
			};
		}
		if (
			!isRecord(raw) ||
			raw["judged"] !== true ||
			raw["escape"] === true ||
			!isRecord(raw["markings"])
		) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["aspect_coverage judge returned an unjudged, escaped or malformed result; no mapping applied"],
				judged: false,
				summary: "",
			};
		}
		const markings = raw["markings"] as Record<string, string>;
		const unknownIds = input.aspects.filter(id => !(id in markings));
		if (unknownIds.length > 0) {
			return {
				verdict: "insufficient_evidence",
				reasons: [`aspect_coverage judge did not mark: ${unknownIds.join(", ")}`],
				judged: false,
				summary: "",
			};
		}
		const missed = input.aspects.filter(id => markings[id] === "applicable_not_addressed");
		this.state.iterations[boundKey] = used + 1;
		const reasons = [
			...(Array.isArray(raw["reasons"]) ? raw["reasons"].filter((r): r is string => typeof r === "string") : []),
		];
		if (missed.length > 0) {
			// Open drift recorded against the current task: completion teeth (unmetStopGates).
			this.state.openAspectGaps = { missed, taskFingerprint: this.state.taskFingerprint };
			reasons.push(`missed aspects: ${missed.join(", ")}`);
			this.pushFeedback(`Jev aspect_coverage: applicable but not addressed — ${missed.join(", ")}`);
			this.persist();
			return {
				verdict: "revise",
				reasons,
				confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
				judged: true,
				summary: `aspect_coverage: revise — applicable_not_addressed: ${missed.join(", ")}`,
			};
		}
		this.state.openAspectGaps = undefined;
		this.persist();
		return {
			verdict: "approve",
			reasons,
			confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
			judged: true,
			summary: "aspect_coverage: approve — all applicable aspects addressed",
		};
	}

	/** course_check ask_user escalation: recorded blocker, never a gate grant. */
	private escalateCourseCheck(normalized: DecisionResult): DecisionOutcome {
		const blocker = "course_check escalated to the user (ask_user chosen by the judge or rework bound).";
		if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
		this.persist();
		return {
			verdict: "ask_user",
			reasons: [...normalized.reasons, blocker],
			confidence: normalized.confidence,
			judged: true,
			summary: "",
		};
	}

	// ----- internals -----

	private extraStageSet(): Set<string> {
		return new Set(this.extraPoints.keys());
	}

	private extraStageTemplate(stage: string): { instructions?: string; options?: DecisionOption[] } | undefined {
		const declared = this.template.controlPoints?.[stage];
		if (declared === undefined) return undefined;
		return { instructions: declared.instructions, options: declared.options };
	}

	private planApproval(): ApprovalRecord | undefined {
		// Undefined current fingerprint means no user task is established yet: no gate credit.
		if (this.state.taskFingerprint === undefined) return undefined;
		return this.state.approvals.find(
			a =>
				lookupControlPoint(a.stage, this.extraPoints)?.trigger === "mutation_gate" &&
				a.taskFingerprint === this.state.taskFingerprint,
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
			if (lookupControlPoint(a.stage, this.extraPoints)?.trigger === "session_stop") completion = a;
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
		// aspect_coverage teeth: an open drift for the CURRENT task blocks completion until
		// a fresh aspect_coverage submission clears it (advisory preset, no own stop gate).
		const gaps = this.state.openAspectGaps;
		if (gaps !== undefined && gaps.taskFingerprint === this.state.taskFingerprint && gaps.missed.length > 0) {
			missing.push(`aspects not addressed: ${gaps.missed.join(", ")}`);
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

function extraPointsFromTemplate(template: JevTemplateConfig): ReadonlyMap<string, ControlPoint> {
	const out = new Map<string, ControlPoint>();
	const declared = template.controlPoints;
	if (declared === undefined) return out;
	for (const [stage, value] of Object.entries(declared)) {
		try {
			out.set(stage, validateDeclaredControlPoint(stage, value));
		} catch {
			// Invalid declarations are caught at config load; skip here (fail-closed already ran).
		}
	}
	return out;
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
