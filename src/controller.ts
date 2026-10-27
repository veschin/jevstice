/**
 * The omp wiring.
 *
 * Registers the judge-backed tools, holds the visible boundaries (`tool_call` for consequential
 * changes and for the plan-mode proposal, `session_stop` for completion) and runs the automatic
 * checks at their activity boundaries: a course check every configured number of successful
 * consequential actions, and one completion check when a developed task settles.
 *
 * Nothing here classifies prompts and nothing calls the judge before a tool is invoked or a
 * boundary is reached, so a plain read-only question costs no call and no gate.
 */
import {
	acceptance,
	completionCheck,
	consult,
	courseCheck,
	reaim,
	planReview,
	requirements,
	review,
	searchRelevance,
	textReview,
	triage,
	type ActivityDeps,
} from "./activities.js";
import { readLocalArtifact } from "./artifact.js";
import {
	completionGate,
	isConsequentialMutation,
	isProposeCall,
	mutationGate,
	planArtifactChangedReason,
	planArtifactUnreadableReason,
	proposeGate,
	targetOutsidePlan,
	PROPOSE_BOUNDARY,
	type GateVerdict,
} from "./gates.js";
import type { Judge } from "./judge.js";
import { freshState, markDeviation, recordAction, recordRefusedCall, recordStopBlock, screenRequest, sha256, type JevState, type PlanApproval, type TaskIdentity } from "./state.js";
import { HOLD_BOUNDARY, POLICY, asRecord, type JevConfig, type ToolOutcome } from "./types.js";

/** A schema node as this extension builds it; the host validates the built schema itself. */
export interface SchemaLike {
	describe(text: string): SchemaLike;
	optional(): SchemaLike;
}

/** The schema builder the host injects as `pi.zod`. */
export interface SchemaBuilder {
	object(shape: Record<string, SchemaLike>): SchemaLike;
	array(element: SchemaLike): SchemaLike;
	string(): SchemaLike;
	boolean(): SchemaLike;
	number(): SchemaLike;
	enum(values: readonly [string, ...string[]]): SchemaLike;
}

/** One tool as registered with the host. */
export interface PiToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	): Promise<unknown>;
}

/** Structural surface of the omp ExtensionAPI this extension uses. */
export interface PiApi {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	registerTool(tool: PiToolDefinition): void;
	sendMessage?(
		payload: unknown,
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean },
	): void;
	logger?: { warn?(...args: unknown[]): void };
}

export interface ControllerDeps {
	judge: Judge;
	config: JevConfig;
	zod: SchemaBuilder;
}

export interface JevController {
	register(pi: PiApi): void;
}

const CONSULT_DESCRIPTION =
	"Use one decision: choice needs alternatives, score needs at least two criteria, boolean needs trueMeaning and falseMeaning. Fill question and relevant context; add exact source quotes when useful. To clear a hold, ask whether a specific corrective action resolves its finding. A below-floor result is not approval.";


const WORKFLOW_NOTE =
	" Read-only work needs no triage. If triage registers development, get plan approval before project changes and both acceptance approvals before stopping; a simple-task verdict skips those stages.";

const TRIAGE_DESCRIPTION =
	"Before a consequential change, submit the owner's request and concrete task topics. A development result registers the task and requires plan review; a simple result names skipped stages; an unsettled result registers nothing.";

const REAIM_DESCRIPTION =
	"Use only when the owner changes direction mid-task. Copy the interjection verbatim and quote it as user evidence. Approval re-aims the task and drops the old plan and acceptance records; do not re-triage.";

const SEARCH_DESCRIPTION =
	"Submit the query and at least two candidates, each with evidence and your reason for relevance. Jev returns a selected candidate or none; the reason is yours, not Jev's. A below-floor selection is unusable.";

const REQUIREMENTS_DESCRIPTION =
	"Before drafting the plan, submit the request and one checkable item per obligation, each with its exact source quote. Use candidateNeeds only for suspected omissions. The result reports per-item judgments, whole-list coverage and omitted needs, then registers the task for plan review.";

const PLAN_REVIEW_DESCRIPTION =
	"Submit the written local:// artifact, claim, one topic per task obligation, and evidence quoting the request. Each topic needs its exact artifact section, paths and one requirement. Jev checks coverage, extra scope and executability separately; fix only named failures and leave passing topics unchanged.";

const ACCEPTANCE_DESCRIPTION =
	"Submit the claim and one aspect: business or architecture. Include execution evidence (command and output) and code evidence (diff, diagnostic or measurement); connect proof to the owner's need and approved plan topics. Both aspects must pass at the current revision; later consequential changes invalidate approval.";

const REVIEW_DESCRIPTION =
	"Submit review kind (checkpoint, commit or diff), target, one claim, changed-code evidence and verification output. A finding holds changes until jev_consult resolves it. This review never replaces business or architecture acceptance.";

const TEXT_REVIEW_DESCRIPTION =
	"Submit the text and exact rules as {class, rule}. Jev returns violating fragments and the submitted rules they break; revise only those fragments. No returned defects means the text meets the submitted rules.";


/** Best-effort reading of one string-valued method off the session manager. */
function callString(host: Record<string, unknown> | undefined, method: string): string | null {
	const fn = host?.[method];
	if (typeof fn !== "function") return null;
	try {
		const value = (fn as () => unknown).call(host);
		return typeof value === "string" && value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

function sessionManagerOf(ctx: unknown): Record<string, unknown> | undefined {
	return asRecord(asRecord(ctx)?.["sessionManager"]);
}

function sessionIdOf(ctx: unknown): string {
	return callString(sessionManagerOf(ctx), "getSessionId") ?? "session";
}

function notify(ctx: unknown, text: string): void {
	const ui = asRecord(asRecord(ctx)?.["ui"]);
	const fn = ui?.["notify"];
	if (typeof fn !== "function") return;
	try {
		(fn as (message: string, level?: string) => void).call(ui, text, "warning");
	} catch {
		// A host without a working UI must not break the gate.
	}
}

function sendMessage(pi: PiApi, customType: string, text: string, deliverAs: "aside" | "nextTurn"): void {
	try {
		pi.sendMessage?.({ customType, content: text, display: true }, { deliverAs });
	} catch (error) {
		pi.logger?.warn?.("jevstice: could not deliver a session message", error);
	}
}

function targetOf(input: unknown): string {
	const record = asRecord(input);
	const path = record?.["path"];
	if (typeof path === "string" && path.length > 0) return path;
	const legacy = record?.["file_path"];
	if (typeof legacy === "string" && legacy.length > 0) return legacy;
	const paths = record?.["paths"];
	if (Array.isArray(paths)) {
		const named = paths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
		if (named.length > 0) return named.join(", ");
	}
	// A shell command is the action's own target: the course and completion checks judge it from the
	// command text and its output.
	const command = record?.["command"];
	if (typeof command === "string" && command.trim().length > 0) {
		const trimmed = command.trim();
		return trimmed.length > POLICY.maxActionExcerptChars ? `${trimmed.slice(0, POLICY.maxActionExcerptChars)}...` : trimmed;
	}
	return "(unnamed target)";
}

function excerptOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		const record = asRecord(block);
		const text = record?.["text"];
		if (typeof text === "string" && text.trim().length > 0) {
			const trimmed = text.trim();
			return trimmed.length > POLICY.maxActionExcerptChars ? trimmed.slice(0, POLICY.maxActionExcerptChars) : trimmed;
		}
	}
	return "";
}

/** The change material of a tool input - what the action wrote, edited or ran - bounded by policy. */
function changeOf(input: unknown): string {
	const text = JSON.stringify(input ?? null);
	if (text === undefined || text.length <= POLICY.maxActionExcerptChars) return text ?? "";
	return `${text.slice(0, POLICY.maxActionExcerptChars)}...`;
}

/** A plan approval granted in a session the host is about to replace with the execution session. */
interface PlanHandoff {
	/** The session the approval was granted in; the approval is never restored back into it. */
	fromSessionId: string;
	task: TaskIdentity;
	plan: PlanApproval;
}

export function createJevController(deps: ControllerDeps): JevController {
	const states = new Map<string, JevState>();

	const stateFor = (ctx: unknown): JevState => {
		const id = sessionIdOf(ctx);
		let state = states.get(id);
		if (state === undefined) {
			state = freshState();
			states.set(id, state);
		}
		return state;
	};

	const activitiesFor = (ctx: unknown): ActivityDeps => ({
		judge: deps.judge,
		config: deps.config,
		readArtifact: async url => {
			if (!url.startsWith("local://")) return null;
			const manager = sessionManagerOf(ctx);
			return readLocalArtifact(
				{
					getArtifactsDir: () => callString(manager, "getArtifactsDir"),
					getSessionId: () => callString(manager, "getSessionId"),
				},
				url.slice("local://".length),
			);
		},
	});

	/**
	 * The approve-and-execute switch: omp clears the session while the approval is being taken and
	 * copies the `local://` artifacts into the replacement session only after the switch has been
	 * emitted. The approval is therefore restored at the first operation of the new session, and
	 * only when the copied artifact still matches the digest the judge approved - an ordinary clear,
	 * a resume, or an artifact edited after the review restores nothing.
	 */
	let handoff: PlanHandoff | undefined;
	let switchArmed = false;
	let handoffSessionId: string | undefined;

	const restoreApprovedPlan = async (ctx: unknown): Promise<void> => {
		if (handoff === undefined || handoffSessionId === undefined) return;
		if (sessionIdOf(ctx) !== handoffSessionId) return;
		const granted = handoff;
		handoff = undefined;
		handoffSessionId = undefined;
		const artifact = await activitiesFor(ctx).readArtifact?.(granted.plan.planUrl);
		if (artifact === null || artifact === undefined || sha256(artifact) !== granted.plan.planDigest) return;
		const state = stateFor(ctx);
		if (state.task !== undefined) return;
		state.task = granted.task;
		state.plan = granted.plan;
	};

	/**
	 * What the owner has to know and the executor cannot be told often enough (FR-21, FR-23): the judge
	 * became unavailable, or a boundary was released after its refusal bound. Each is announced once.
	 */
	const announce = (pi: PiApi, ctx: unknown, state: JevState): void => {
		const openItem = state.openItem;
		const signature = openItem === undefined ? undefined : `${openItem.boundary}:${openItem.attempts}`;
		if (openItem !== undefined && signature !== undefined && state.openItemNotified !== signature) {
			state.openItemNotified = signature;
			notify(
				ctx,
				`Jevstice released the ${openItem.boundary} boundary as an OPEN item after ${openItem.attempts} refusals; nothing refused there is approved.`,
			);
			sendMessage(
				pi,
				"jev.open_item",
				`Jevstice released the ${openItem.boundary} boundary after ${openItem.attempts} refusals (digests ${openItem.digests
					.map(entry => entry.slice(0, 8))
					.join(", ")}). The refusal stays an OPEN item for you; nothing it refused is approved.`,
				"nextTurn",
			);
		}
		if (state.judgeUnavailable === true && state.judgeUnavailableNotified !== true) {
			state.judgeUnavailableNotified = true;
			notify(
				ctx,
				`Jevstice: the judge could not be reached for ${POLICY.maxJudgeFailures} calls in a row, so the boundaries now pass without a judge answer and nothing is recorded as approved.`,
			);
		}
	};

	/**
	 * One refused consequential call (FR-20, FR-28): the reason already carries the copy-ready next
	 * call, the same instruction is delivered once per boundary into the executor's context rather than
	 * only into its tool error, and the count of refused calls tells the owner when the executor is not
	 * following the boundary.
	 */
	const refuse = (
		pi: PiApi,
		ctx: unknown,
		state: JevState,
		toolName: string,
		input: unknown,
		verdict: GateVerdict,
	): { block: true; reason: string } => {
		const boundary = verdict.boundary ?? "gate";
		const reason = verdict.reason ?? `Jevstice holds this change at the ${boundary} boundary.`;
		const count = recordRefusedCall(state, boundary, `${toolName} ${targetOf(input)}`);
		if (count === 1) sendMessage(pi, "jev.boundary", reason, "aside");
		if (count === POLICY.maxIgnoredBoundaryCalls) {
			notify(
				ctx,
				`Jevstice: ${count} consequential calls were refused while the ${boundary} boundary stands and the call that resolves it was not made. Attempted: ${state.refusedCalls.calls.join("; ")}`,
			);
		}
		return { block: true, reason };
	};

	/** The automatic course check: fired without the executor asking, delivered as a message. */
	const runCourseCheck = async (pi: PiApi, ctx: unknown, id: string): Promise<void> => {
		try {
			const state = states.get(id);
			if (state === undefined) return;
			const outcome = await courseCheck(activitiesFor(ctx), state);
			sendMessage(pi, "jev.course_check", outcome.text, "aside");
		} catch (error) {
			pi.logger?.warn?.("jevstice: the course check failed", error);
		} finally {
			const state = states.get(id);
			if (state !== undefined) delete state.checkPending;
		}
	};

	return {
		register(pi: PiApi): void {
			const z = deps.zod;
			/** One registered description: the tool's own text and the note every tool shares. */
			const described = (body: string): string => `${body}${WORKFLOW_NOTE}`;
			const evidence = z.array(z.object({ kind: z.string(), quote: z.string(), source: z.string().optional() }));
			const run =
				(runActivity: (activity: ActivityDeps, state: JevState, params: unknown) => Promise<ToolOutcome>) =>
				async (_id: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: unknown) => {
					const outcome = await runActivity(activitiesFor(ctx), stateFor(ctx), params);
					return { content: [{ type: "text", text: outcome.text }], details: outcome.details ?? {}, isError: !outcome.ok };
				};

			pi.registerTool({
				name: "jev_consult",
				label: "Jev consult",
				description: described(CONSULT_DESCRIPTION),
				parameters: z.object({
					mode: z.enum(["choice", "score", "boolean"]),
					question: z.string(),
					context: z.string(),
					evidence,
					alternatives: z.array(z.object({ label: z.string(), meaning: z.string() })).optional(),
					criteria: z.array(z.string()).optional(),
					trueMeaning: z.string().optional(),
					falseMeaning: z.string().optional(),
				}),
				execute: run(consult),
			});

			pi.registerTool({
				name: "jev_triage",
				label: "Jev triage",
				description: described(TRIAGE_DESCRIPTION),
				parameters: z.object({
					request: z.string(),
					topics: z.array(z.string()).optional(),
					evidence: evidence.optional(),
				}),
				execute: run(triage),
			});

			pi.registerTool({
				name: "jev_reaim",
				label: "Jev re-aim",
				description: described(REAIM_DESCRIPTION),
				parameters: z.object({
					interjection: z.string(),
					evidence,
				}),
				execute: run(reaim),
			});

			pi.registerTool({
				name: "jev_search_relevance",
				label: "Jev search relevance",
				description: described(SEARCH_DESCRIPTION),
				parameters: z.object({
					query: z.string(),
					candidates: z.array(z.object({ title: z.string().optional(), url: z.string().optional(), evidence: z.string(), reason: z.string() })),
				}),
				execute: run(searchRelevance),
			});

			pi.registerTool({
				name: "jev_requirements",
				label: "Jev requirements",
				description: described(REQUIREMENTS_DESCRIPTION),
				parameters: z.object({
					request: z.string(),
					items: z.array(z.object({ text: z.string(), source: z.string() })),
					candidateNeeds: z.array(z.string()).optional(),
					evidence: evidence.optional(),
				}),
				execute: run(requirements),
			});

			pi.registerTool({
				name: "jev_plan_review",
				label: "Jev plan review",
				description: described(PLAN_REVIEW_DESCRIPTION),
				parameters: z.object({
					plan: z.string(),
					claim: z.string(),
					topics: z.array(
						z.object({
							id: z.string(),
							section: z.string(),
							paths: z.array(z.string()),
							requirement: z.string(),
						}),
					),
					evidence,
				}),
				execute: run(planReview),
			});

			pi.registerTool({
				name: "jev_acceptance",
				label: "Jev acceptance",
				description: described(ACCEPTANCE_DESCRIPTION),
				parameters: z.object({
					aspect: z.enum(["business", "architecture"]),
					claim: z.string(),
					evidence,
				}),
				execute: run(acceptance),
			});

			pi.registerTool({
				name: "jev_review",
				label: "Jev developer review",
				description: described(REVIEW_DESCRIPTION),
				parameters: z.object({
					kind: z.enum(["checkpoint", "commit", "diff"]),
					target: z.string(),
					claim: z.string(),
					evidence,
				}),
				execute: run(review),
			});

			pi.registerTool({
				name: "jev_text_review",
				label: "Jev text review",
				description: described(TEXT_REVIEW_DESCRIPTION),
				parameters: z.object({
					text: z.string(),
					rules: z.array(z.object({ class: z.string(), rule: z.string() })),
				}),
				execute: run(textReview),
			});

			pi.on("session_start", (_event, ctx) => {
				states.delete(sessionIdOf(ctx));
				const problems = deps.config.problems;
				if (problems.length > 0) notify(ctx, `Jevstice configuration: ${problems.join("; ")}`);
			});

			pi.on("session_shutdown", (_event, ctx) => {
				states.delete(sessionIdOf(ctx));
			});

			// A new prompt is a new request: the previous request's simple verdict does not carry over, and
			// the request is read once here - for free - to decide whether it enters the workflow at all.
			pi.on("before_agent_start", (event, ctx) => {
				const state = stateFor(ctx);
				delete state.simple;
				const request = asRecord(event)?.["prompt"];
				screenRequest(state, typeof request === "string" ? request : "");
			});

			// The approve-and-execute switch arms here; the approval is restored after the switch,
			// because omp copies the artifacts over only once the switch has been emitted.
			pi.on("session_before_switch", (event, _ctx) => {
				switchArmed = asRecord(event)?.["reason"] === "new" && handoff !== undefined;
			});

			pi.on("session_switch", (event, ctx) => {
				if (switchArmed && asRecord(event)?.["reason"] === "new" && handoff !== undefined) {
					handoffSessionId = sessionIdOf(ctx);
				}
				switchArmed = false;
			});

			pi.on("tool_call", async (event, ctx) => {
				await restoreApprovedPlan(ctx);
				const toolName = asRecord(event)?.["toolName"];
				if (typeof toolName !== "string") return undefined;
				const input = asRecord(event)?.["input"];
				const state = stateFor(ctx);
				announce(pi, ctx, state);
				if (isProposeCall(toolName, input)) {
					const verdict = proposeGate(state, deps.config, input);
					if (!verdict.block && verdict.url !== undefined && state.plan !== undefined) {
						const artifact = await activitiesFor(ctx).readArtifact?.(verdict.url);
						if (artifact === null || artifact === undefined) {
							return refuse(pi, ctx, state, toolName, input, {
								block: true,
								boundary: PROPOSE_BOUNDARY,
								reason: planArtifactUnreadableReason(verdict.url),
							});
						}
						if (sha256(artifact) !== state.plan.planDigest) {
							return refuse(pi, ctx, state, toolName, input, {
								block: true,
								boundary: PROPOSE_BOUNDARY,
								reason: planArtifactChangedReason(verdict.url),
							});
						}
						if (state.task !== undefined) {
							handoff = { fromSessionId: sessionIdOf(ctx), task: state.task, plan: state.plan };
						}
					}
					return verdict.block
						? refuse(pi, ctx, state, toolName, input, { ...verdict, boundary: verdict.boundary ?? PROPOSE_BOUNDARY })
						: undefined;
				}
				const verdict = mutationGate(state, deps.config, toolName, input);
				return verdict.block ? refuse(pi, ctx, state, toolName, input, verdict) : undefined;
			});

			pi.on("tool_result", async (event, ctx) => {
				await restoreApprovedPlan(ctx);
				const record = asRecord(event);
				if (record === undefined || record["isError"] === true) return undefined;
				const toolName = record["toolName"];
				const input = record["input"];
				if (typeof toolName !== "string" || !isConsequentialMutation(toolName, input)) return undefined;
				const state = stateFor(ctx);
				// Only the registered development task carries the interval, the evidence and the hold.
				if (state.task === undefined) return undefined;
				const target = targetOf(input);
				recordAction(state, { tool: toolName, target, excerpt: [changeOf(record["input"]), excerptOf(record["content"])].filter(part => part.length > 0).join("\n") }, toolName !== "bash");
				// A change outside the approved plan is a trigger of its own (FR-25): the plan named the
				// paths its topics change, so an action elsewhere is a possible change of course.
				if (state.deviation === undefined && targetOutsidePlan(toolName, target, state.planTopics)) {
					markDeviation(state, toolName, target);
				}
				// Completion-only checking defers every course check to completion (FR-12).
				if (deps.config.courseCheck.mode !== "interval") return undefined;
				// A hold this boundary can no longer enforce makes the check a judge call with no effect (FR-23).
				if (state.released.includes(HOLD_BOUNDARY)) return undefined;
				if (state.deviation === undefined && state.actionsSinceCheck < deps.config.courseCheck.interval) return undefined;
				state.actionsSinceCheck = 0;
				// The check is in flight: a change decided before its verdict returns would bypass it.
				state.checkPending = true;
				void runCourseCheck(pi, ctx, sessionIdOf(ctx));
				return undefined;
			});

			pi.on("session_stop", async (_event, ctx) => {
				await restoreApprovedPlan(ctx);
				const state = stateFor(ctx);
				announce(pi, ctx, state);
				const gate = completionGate(state, deps.config);
				if (!gate.applies) return undefined;
				let reason = gate.reason;
				if (reason === undefined) {
					const recorded = state.completion;
					if (recorded !== undefined && recorded.revision === state.revision) {
						if (recorded.approved) {
							delete state.stop;
							return undefined;
						}
						reason = `the completion check at revision ${recorded.revision} answered "${recorded.label}" (confidence ${recorded.confidence.toFixed(2)})`;
					} else {
						const outcome = await completionCheck(activitiesFor(ctx), state, {
							course: deps.config.courseCheck.mode === "completion",
						});
						const completion = state.completion;
						if (completion?.approved === true) {
							delete state.stop;
							return undefined;
						}
						reason = `${outcome.text} The finished work is held at the completion boundary.`;
					}
				}
				const { block, blocks } = recordStopBlock(state, sha256(reason));
				if (block) return { decision: "block", reason };
				sendMessage(
					pi,
					"jev.open_item",
					`Jevstice stops holding completion after ${blocks} refusals for one unchanged reason; the refusal stays an OPEN item: ${reason}`,
					"nextTurn",
				);
				return undefined;
			});
		},
	};
}
