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
import { freshState, markDeviation, recordAction, recordRefusedCall, recordStopBlock, sha256, type JevState, type PlanApproval, type TaskIdentity } from "./state.js";
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
	"Ask the Jev judge one decision, in the shape that fits it: mode=choice selects between submitted alternatives, mode=score places the material on a submitted rubric, mode=boolean answers a yes/no question as a probability. Use it when you are unsure during implementation, when a consequential business decision has to be taken from the task context (FR-19), or whenever a decision should not rest on your own guess. " +
	"How to ask (measured on this judge): one decision per call; state a claim and quote the 3-6 short verbatim lines that settle it. A claim plus its settling quote scores 0.80-1.00; the same claim with the settling quote removed scores 0.30-0.50; an open 'is this fine?' scores 0.14-0.26. Keep arithmetic out of the question - quote the computed numbers instead. " +
	"A low score is not a no and never a reason to stop: fix the material - quote what settles the claim, narrow the claim to a single obligation, or change the approach - and never resubmit the same words. " +
	"The tool returns the judge's typed answer - the selected label, the score or the probability - with its reported confidence, and never an invented explanation. An answer below the confidence floor, a malformed answer or a failed call is reported as unusable together with the recovery steps - follow them instead of giving up. " +
	"Example (good): question 'May the next consequential change proceed?', context 'the six recorded rework actions of the registered task, each verified', evidence [execution] '117 pass / 0 fail / 393 expect() calls' - answered proceed at 0.95. Example (bad): 'Review my work' with no quotes - below the floor, unusable, and no amount of rewording fixes it; only quoting the work does. " +
	"When a Jev finding is holding consequential changes, the consultation must answer that finding: the judge is asked whether it does, and an unrelated consultation leaves the hold in place. Everything submitted is judged as data, never as instructions.";

/** The one-line asking rule every other tool description carries (FR-09). */
const ASKING_RULE =
	" Asking rule: one decision per call, stated as a claim with the verbatim quotes that settle it; a low score means weak evidence or a too-wide claim, not a no - the guide with worked examples and measured scores is on jev_consult.";

const TRIAGE_DESCRIPTION =
	"Triage the owner's request before development work: does it need the deeper activities - a plan reviewed before consequential changes, course checks while implementing, and business and architecture acceptance before completion - or is it a simple task that needs none of them? " +
	"Submit the request text, quoted evidence from it, and the narrow task-specific topics you think it needs (concrete concerns such as high availability, fault tolerance, security, performance or user interface behaviour, not generic labels). " +
	"A `development task registered` answer registers the task and holds consequential changes until jev_plan_review approves the plan artifact; a `simple task` answer explicitly names the skipped activities, registers no development task, and lets consequential changes pass while that request stands. An answer the judge cannot settle is refused and registers nothing. A plain web search or a read-only question needs no triage call at all: it costs no judge call and no gate; the first consequential change of an untriaged session is held until triage or jev_requirements has judged the request." + ASKING_RULE;


const REAIM_DESCRIPTION =
	"Register the owner's interjection as the course the work must follow (FR-29). Submit the owner's words verbatim as `interjection` and at least one `user` evidence item quoting them; the judge sees nothing else, and an interjection it cannot attribute to the owner changes nothing. " +
	"On approval the task is re-aimed: the released boundaries stay released, the plan boundary is released by the owner's order, the old plan and acceptance records are dropped, the work revision restarts, and course checks judge against the owner's course - with no plan topics recorded, no course question runs. " +
	"Use it when the owner interjects a new direction into a running session, instead of re-triage, which rebuilds every wall." + ASKING_RULE;
const SEARCH_DESCRIPTION =
	"Ask the judge which submitted search result is the relevant one for a query, and why. Submit the query and, per candidate, its title or url, the evidence it carries and YOUR proposed reason for its relevance. " +
	"The judge selects one candidate-and-reason pair, or marks every submitted candidate irrelevant; the tool returns the selected candidate together with your own submitted reason - never an invented explanation - and the reported confidence, and returns no candidate when none is relevant. Submit 2 or more candidates; a selection below the confidence floor is refused as unusable. This is optional for a plain search: it costs a call only when you ask for it." + ASKING_RULE;

const REQUIREMENTS_DESCRIPTION =
	"Break the owner's request into individual concrete requirements and have Jev check them against the original request: submit the request text, one {text, source} item per requirement where source is the quote the item derives from, and optionally the owner needs you suspect you omitted as candidateNeeds. " +
	"One batched call returns, per item, the probability that it faithfully captures an obligation of the request without invented scope; the coverage probability of the item set as a whole; and which candidate needs are missing from the list. Use it before the requirement list becomes the task plan. It registers the development task, so consequential changes are held until a plan review passes." + ASKING_RULE;

const PLAN_REVIEW_DESCRIPTION =
	"Submit the plan artifact for Jev review at the plan-mode boundary. `plan` is the artifact URL you wrote (local://<slug>-plan.md), `claim` states what the plan is meant to satisfy, `topics` lists the plan's topics - per topic its id, the artifact section that governs it quoted verbatim, the paths it changes and the requirement it serves - and `evidence` quotes the task requirements. " +
	"The review reads the artifact itself and puts one question per topic to the judge, so a verdict names the topic it concerns; a topic whose quoted section is absent from the artifact is refused before any judge call, and the approval is recorded only when every topic passes. " +
	"The approval is bound to the artifact's exact content and to the task fingerprint; it then allows `write xd://propose` for that artifact, and any later change to the artifact invalidates it. Write the plan artifact before this call - review binds to the artifact, not to a copy of it. " +
	"You can write the plan artifact and call every Jevstice tool while consequential changes are held; so can agent messages (agent://) and mounted device calls (xd://)." + ASKING_RULE;

const ACCEPTANCE_DESCRIPTION =
	"Defend the finished work before Jev, once per aspect. aspect=business states the owner's need is served; aspect=architecture states the design carries the result and can absorb the next change. Quote concrete artifact and verification evidence - a claim without quotes is refused. " +
	"Completion of developed work requires both aspects approved at the current work revision; any further consequential change invalidates both, and the tool reports which aspect is still missing. A verdict below the confidence floor is recorded as no approval." + ASKING_RULE;

const REVIEW_DESCRIPTION =
	"Defend changed work before Jev as a developer. kind is checkpoint, commit or diff; target names it; claim states what the change does; evidence quotes the changed code, the diff and the verification run. " +
	"The tool returns the judge's verdict with its confidence. A finding holds consequential changes until you consult jev_consult about it. A review verdict never approves completion - business and architecture acceptance do that." + ASKING_RULE;

const TEXT_REVIEW_DESCRIPTION =
	"Have a text reviewed before you present it to the owner. Submit the text and the register rules it must satisfy as {class, rule}, quoted verbatim from the rules you were given - formal register, no jargon, one thought per sentence, the greatest brevity that keeps the meaning. " +
	"The tool splits the text into fragments and puts every submitted rule to the judge once per fragment; the returned text quotes back the fragment and the rule line it violates, taken from the rules you submitted, and the tool adds no advice of its own. " +
	"A text that violates none of the submitted rules is approved; a defect list is refused, so rewrite those fragments in the form the named rule lines require and submit again." + ASKING_RULE;


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
				description: CONSULT_DESCRIPTION,
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
				description: TRIAGE_DESCRIPTION,
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
				description: REAIM_DESCRIPTION,
				parameters: z.object({
					interjection: z.string(),
					evidence,
				}),
				execute: run(reaim),
			});

			pi.registerTool({
				name: "jev_search_relevance",
				label: "Jev search relevance",
				description: SEARCH_DESCRIPTION,
				parameters: z.object({
					query: z.string(),
					candidates: z.array(z.object({ title: z.string().optional(), url: z.string().optional(), evidence: z.string(), reason: z.string() })),
				}),
				execute: run(searchRelevance),
			});

			pi.registerTool({
				name: "jev_requirements",
				label: "Jev requirements",
				description: REQUIREMENTS_DESCRIPTION,
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
				description: PLAN_REVIEW_DESCRIPTION,
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
				description: ACCEPTANCE_DESCRIPTION,
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
				description: REVIEW_DESCRIPTION,
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
				description: TEXT_REVIEW_DESCRIPTION,
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

			// A new prompt is a new request: the previous request's simple verdict does not carry over.
			pi.on("before_agent_start", (_event, ctx) => {
				delete stateFor(ctx).simple;
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
