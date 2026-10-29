/**
 * The omp wiring.
 *
 * Registers the judge-backed tools, holds the visible boundaries (`tool_call` for consequential
 * changes and for the plan-mode proposal, `session_stop` for completion) and runs the automatic
 * checks at their activity boundaries: a course check every configured number of successful
 * consequential actions, and one completion check when a developed task settles.
 *
 * Nothing here classifies prompts. A read-only call costs no judge call and no gate; a consequential
 * call that the deterministic gates admit is judged on its own payload before it runs, and the
 * automatic checks run at their activity boundaries.
 */
import { readFileSync } from "node:fs";
import {
	acceptance,
	actionCheck,
	antiSlop,
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
	requirementsBeforePlanGate,
	targetOutsidePlan,
	triageBeforeInspectionGate,
	PLAN_REQUIRED_REASON,
	PROPOSE_BOUNDARY,
	type GateVerdict,
} from "./gates.js";
import type { Judge } from "./judge.js";
import {
	clearFinishedTask,
	allowContinuation,
	antiSlopScope,
	antiSlopStatus,
	continuationAllowed,
	exhaustBoundary,
	findAntiSlopFinding,
	freshState,
	invalidatePlan,
	markDeviation,
	recordAction,
	recordAntiSlopWaiver,
	recordFailedAction,
	recordRefusedCall,
	recordStopBlock,
	screenRequest,
	sha256,
	type JevState,
	type PendingCheck,
	type PlanApproval,
	type PlanDraft,
	type TaskIdentity,
} from "./state.js";
import { PLAN_BOUNDARY, POLICY, asRecord, type JevConfig, type PlanTopic, type ToolOutcome } from "./types.js";

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
	registerCommand?(name: string, options: { description: string; handler: (args: string, ctx: unknown) => void }): void;
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
	" Read-only work needs no triage. Development normally requires requirements, a plan and both acceptance aspects. The owner can permit continuation with /jev-continue or an explicit approval message. After the attempt limit, continue with unresolved findings marked OPEN; permission to proceed is not Jev approval.";

const TRIAGE_DESCRIPTION =
	"Before a consequential change, submit the owner's request and concrete task topics. A development result requires requirements review and plan review: derive one checkable obligation per part of the request yourself and submit it with jev_requirements, then plan. No owner confirmation step exists - do not ask the owner to confirm the obligation list. The same call records whether the deliverable is external-facing; the anti-slop review applies only then. A simple result names skipped stages; an unsettled result registers nothing.";

const REAIM_DESCRIPTION =
	"Use only when the owner changes direction mid-task. Copy the interjection verbatim and quote it as user evidence. Approval re-aims the task, drops the old approvals and requires a fresh requirements and plan review; do not re-triage.";

const SEARCH_DESCRIPTION =
	"Submit the query and at least two candidates, each with evidence and your reason for relevance. Jev returns a selected candidate or none; the reason is yours, not Jev's. A below-floor selection is unusable.";

const REQUIREMENTS_DESCRIPTION =
	"Submit the owner's request and one checkable item per obligation you derived from it, each with the exact request line it comes from. Treat a necessary implementation choice as your own decision, not as an owner instruction. Use candidateNeeds only for suspected omissions. Plan artifacts and review stay held until coverage is established and every submitted item is supported; no owner confirmation is read or required.";

const PLAN_REVIEW_DESCRIPTION =
	"Use phase outline first: submit proposed high-level steps as {id, summary, requirement}, where each requirement exactly matches one Jev-approved obligation. Jev approves passing steps independently and retains them while you revise rejected steps. After the whole outline passes, use phase detail once per step: include the local artifact URL and one topic {id, section, paths, requirement}; quote that step's complete artifact section verbatim. Jev receives the original request, the approved requirements, the full outline and earlier approved details on every call. After every step passes, use phase finalize with the artifact URL. Only final approval releases project changes.";
const ACCEPTANCE_DESCRIPTION =
	"Submit the claim and one aspect: business or architecture. Include execution evidence (command and output) and code evidence (diff, diagnostic or measurement); connect proof to the owner's need and approved plan topics. Both aspects must pass at the current revision; later consequential changes invalidate approval.";

const REVIEW_DESCRIPTION =
	"Submit review kind (checkpoint, commit or diff), target, one claim, changed-code evidence and verification output. A finding holds changes until jev_consult resolves it. This review never replaces business or architecture acceptance.";

const TEXT_REVIEW_DESCRIPTION =
	"Submit the text and exact rules as {class, rule}. Jev returns violating fragments and the submitted rules they break; revise only those fragments. No returned defects means the text meets the submitted rules.";

const ANTI_SLOP_DESCRIPTION =
	"Use for an external document, research output or legal communication. Submit the exact artifact, declared language/register/purpose/audience, owner rules, factual claims with quoted evidence and sourceClass, hypotheses with falsifiers, and inferences with premises, warrant and conclusion. Jev marks each claim and inference trusted, low_trust, distrusted or unverified and returns findings; advisory by default. A large artifact is split into numbered parts. No meta-text in the artifact or the result.";

const JEV_SKILL = readFileSync(new URL("./jev-skill.md", import.meta.url), "utf8").trim();


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
	planTopics: PlanTopic[];
	/** The approved obligations the plan was bound to, so the execution session can keep planning. */
	requirements?: { taskFingerprint: string; items: string[] };
	/** The partial outline and detail approvals, needed for a further plan revision. */
	planDraft?: PlanDraft;
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

	/**
	 * One judged activity per session at a time. Every activity mutates the same state - approvals,
	 * the refusal ledger, the hold - so two calls in flight would judge each other's half-written
	 * work. Calls queue in arrival order; read-only tool calls never take this lock.
	 */
	const activityLocks = new Map<string, Promise<void>>();
	const serialized = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
		const previous = activityLocks.get(id) ?? Promise.resolve();
		const { promise: current, resolve: release } = Promise.withResolvers<void>();
		const tail = previous.then(() => current);
		activityLocks.set(id, tail);
		await previous;
		try {
			return await work();
		} finally {
			release();
			if (activityLocks.get(id) === tail) activityLocks.delete(id);
		}
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
	 * Whether the recorded plan approval still binds the artifact on disk. The artifact can change
	 * outside the propose path, so a mismatch voids the approval instead of authorising work.
	 */
	const planBindingVerdict = async (ctx: unknown, state: JevState): Promise<GateVerdict | undefined> => {
		if (state.task === undefined || state.plan === undefined) return undefined;
		if (state.plan.taskFingerprint !== state.task.fingerprint) return undefined;
		const url = state.plan.planUrl;
		const digest = state.plan.planDigest;
		const artifact = await activitiesFor(ctx).readArtifact?.(url);
		if (artifact === null || artifact === undefined) {
			invalidatePlan(state);
			return { block: true, boundary: PLAN_BOUNDARY, reason: planArtifactUnreadableReason(url) };
		}
		if (sha256(artifact) !== digest) {
			invalidatePlan(state);
			return { block: true, boundary: PLAN_BOUNDARY, reason: planArtifactChangedReason(url) };
		}
		return undefined;
	};

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
		state.planTopics = granted.planTopics;
		// The approved obligations and the draft belong to the same task: carrying them keeps the
		// execution session able to revise or re-finalize the plan without redoing requirements.
		if (granted.requirements?.taskFingerprint === granted.task.fingerprint) state.requirementsApproval = granted.requirements;
		if (granted.planDraft?.taskFingerprint === granted.task.fingerprint) state.planDraft = granted.planDraft;
	};

	/**
	 * What the owner has to know and the executor cannot be told often enough (FR-21, FR-23): the judge
	 * became unavailable, or a refusal budget is spent and the boundary is recorded as an OPEN item.
	 * Each is announced once.
	 */
	const announce = (pi: PiApi, ctx: unknown, state: JevState): void => {
		const openItem = state.openItem;
		const signature = openItem === undefined ? undefined : `${openItem.boundary}:${openItem.attempts}`;
		if (openItem !== undefined && signature !== undefined && state.openItemNotified !== signature) {
			state.openItemNotified = signature;
			notify(
				ctx,
				`Jevstice recorded ${openItem.boundary} as OPEN after the attempt limit. Continuing this request is permitted; no refused decision is approved.`,
			);
			sendMessage(
				pi,
				"jev.open_item",
				`Jevstice stopped retrying ${openItem.boundary}. Continue the current request with this finding OPEN, not approved. Prior refused material remains recorded.`,
				"aside",
			);
		}
		if (state.judgeUnavailable === true && state.judgeUnavailableNotified !== true) {
			state.judgeUnavailableNotified = true;
			notify(
				ctx,
				`Jevstice: the judge could not be reached for ${POLICY.maxJudgeFailures} calls. Continue this request with unjudged decisions OPEN; no Jev approval is recorded.`,
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
			exhaustBoundary(state, boundary);
			notify(ctx, `Jevstice: ${count} refused calls reached the attempt limit. Continuation is permitted; the ${boundary} finding remains OPEN.`);
			sendMessage(pi, "jev.open_item", `The ${boundary} gate reached ${count} refused calls. Retry the operation: continuation of this request is now permitted with the finding OPEN, not approved.`, "aside");
		}
		return { block: true, reason: continuationAllowed(state) ? `${reason} Attempt limit reached: retry the operation; continuation is permitted with the finding OPEN.` : `${reason} The owner may permit continuation with /jev-continue or an explicit approval message.` };
	};

	/**
	 * The automatic course check: fired without the executor asking, delivered as a message. Its
	 * pending marker is cleared only by the check that set it, so a slow verdict of an older check
	 * never releases a newer one or a newer task.
	 */
	const runCourseCheck = async (pi: PiApi, ctx: unknown, id: string, marker: PendingCheck): Promise<void> => {
		try {
			const outcome = await serialized(id, async () => {
				const state = states.get(id);
				return state === undefined ? undefined : courseCheck(activitiesFor(ctx), state);
			});
			if (outcome !== undefined) sendMessage(pi, "jev.course_check", outcome.text, "aside");
		} catch (error) {
			pi.logger?.warn?.("jevstice: the course check failed", error);
		} finally {
			const state = states.get(id);
			if (state?.checkPending === marker) delete state.checkPending;
		}
	};

	return {
		register(pi: PiApi): void {
			const approvedInputs = new Map<string, string>();
			const deliveryCalls = new Set<string>();
			const approve = (ctx: unknown): void => {
				const state = stateFor(ctx);
				allowContinuation(state, "explicit owner approval; unresolved findings remain OPEN");
				notify(ctx, "Jevstice: owner authorized continuation of this request. Unresolved findings remain OPEN; no Jev approval is recorded.");
				sendMessage(pi, "jev.owner_approval", "The owner permits continuation of the current request despite Jev holds. Proceed; disclose unresolved findings as OPEN rather than claiming Jev approved them.", "aside");
			};
			const waive = (ctx: unknown, findingId: string, reason: string): void => {
				const state = stateFor(ctx);
				const found = findAntiSlopFinding(state, findingId);
				if (found === undefined) {
					notify(ctx, `Jevstice: no anti-slop finding ${findingId} is recorded in this session.`);
					return;
				}
				recordAntiSlopWaiver(state, {
					findingId,
					reason,
					reviewPartDigest: found.review.partDigest,
					...(found.review.taskFingerprint === undefined
						? {}
						: { taskFingerprint: found.review.taskFingerprint }),
					request: found.review.request,
				});
				notify(
					ctx,
					`Jevstice: owner waived ${findingId} (${found.finding.kind}). The finding remains recorded; no Jev approval is claimed.`,
				);
				sendMessage(
					pi,
					"jev.anti_slop_waiver",
					`The owner waived anti-slop finding ${findingId}. It remains recorded as waived by the owner, not approved by Jev.`,
					"aside",
				);
			};
			pi.registerCommand?.("jev-continue", { description: "Continue the current request with unresolved Jev findings OPEN", handler: (_args, ctx) => approve(ctx) });
			pi.registerCommand?.("jev-waive", {
				description: "Waive one anti-slop finding by its id",
				handler: (args: string, ctx: unknown) => {
					const [findingId, ...rest] = args.trim().split(/\s+/);
					if (findingId === undefined || findingId.length === 0) {
						notify(ctx, "Jevstice: /jev-waive needs a finding id.");
						return;
					}
					waive(ctx, findingId, rest.join(" "));
				},
			});
			pi.on("input", (event, ctx) => {
				const input = asRecord(event);
				if (input?.["source"] !== "interactive" && input?.["source"] !== "rpc") return;
				const text = input["text"];
				if (typeof text !== "string") return;
				const trimmed = text.trim();
				if (/^(?:аппрув|даю (?:полный )?аппрув|одобряю(?: продолжение)?|разрешаю продолжать|продолжай несмотря на (?:отказ|блокировку) jev|approve(?: continuation)?|continue despite jev)[.!]?$/iu.test(trimmed)) {
					approve(ctx);
					approvedInputs.set(sessionIdOf(ctx), text);
					return;
				}
				const waiver = /^(?:waive|одобряю|принимаю)\s+(finding-[a-f0-9]{12})(?:\s+(.+))?$/iu.exec(trimmed);
				if (waiver?.[1] !== undefined) {
					waive(ctx, waiver[1], waiver[2] ?? "");
					approvedInputs.set(sessionIdOf(ctx), text);
				}
			});
			const z = deps.zod;
			/** One registered description: the tool's own text and the note every tool shares. */
			const described = (body: string): string => `${body}${WORKFLOW_NOTE}`;
			const evidence = z.array(z.object({ kind: z.string(), quote: z.string(), source: z.string().optional() }));
			const run =
				(runActivity: (activity: ActivityDeps, state: JevState, params: unknown) => Promise<ToolOutcome>) =>
				async (_id: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: unknown) => {
					const id = sessionIdOf(ctx);
					const outcome = await serialized(id, () => runActivity(activitiesFor(ctx), stateFor(ctx), params));
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
					phase: z.enum(["outline", "detail", "finalize"]),
					steps: z
						.array(z.object({ id: z.string(), summary: z.string(), requirement: z.string() }))
						.optional(),
					plan: z.string().optional(),
					topic: z
						.object({
							id: z.string(),
							section: z.string(),
							paths: z.array(z.string()),
							requirement: z.string(),
						})
						.optional(),
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

			pi.registerTool({
				name: "jev_anti_slop",
				label: "Jev anti-slop",
				description: described(ANTI_SLOP_DESCRIPTION),
				parameters: z.object({
					artifact: z.string(),
					language: z.string(),
					register: z.string(),
					purpose: z.string(),
					audience: z.string(),
					rules: z.array(
						z.object({
							class: z.string(),
							rule: z.string(),
							severity: z.enum(["blocker", "warning"]).optional(),
						}),
					),
					claims: z.array(
						z.object({
							id: z.string(),
							text: z.string(),
							kind: z.enum(["fact", "hypothesis"]),
							evidence: z.array(
								z.object({
									kind: z.string(),
									quote: z.string(),
									source: z.string().optional(),
									sourceClass: z.enum([
										"primary",
										"official",
										"peer_reviewed",
										"reputable_secondary",
										"anonymous",
										"none",
									]),
								}),
							),
							falsifier: z.string().optional(),
						}),
					),
					inferences: z
						.array(
							z.object({
								id: z.string(),
								premises: z.array(z.string()),
								warrant: z.string(),
								conclusion: z.string(),
							}),
						)
						.optional(),
					part: z.object({ index: z.number(), total: z.number() }).optional(),
				}),
				execute: run(antiSlop),
			});

			pi.on("session_start", (_event, ctx) => {
				states.delete(sessionIdOf(ctx));
				const problems = deps.config.problems;
				if (problems.length > 0) notify(ctx, `Jevstice configuration: ${problems.join("; ")}`);
			});

			pi.on("session_shutdown", (_event, ctx) => {
				states.delete(sessionIdOf(ctx));
			});

			// A new prompt is a new request: the previous simple verdict does not carry over, a task whose
			// completion check approved the current revision is finished and dropped, and an unfinished
			// task keeps its walls - no prompt text opens them. The request is read once here, for free.
			pi.on("before_agent_start", (event, ctx) => {
				const state = stateFor(ctx);
				const approval = approvedInputs.get(sessionIdOf(ctx));
				approvedInputs.delete(sessionIdOf(ctx));
				const incoming = asRecord(event)?.["prompt"];
				if (approval !== undefined && incoming === approval) return { systemPromptAppend: JEV_SKILL };
				if (continuationAllowed(state) && typeof incoming === "string" && /^(?:continue|proceed|продолжай|дальше)[.!]?$/iu.test(incoming.trim())) return { systemPromptAppend: JEV_SKILL };
				delete state.simple;
				clearFinishedTask(state);
				const prompt = asRecord(event)?.["prompt"];
				screenRequest(state, typeof prompt === "string" ? prompt : "");
				// An unfinished task plus a message the screen reads as a change of direction: nothing
				// moves until a judged re-aim decides it. A routine follow-up keeps the task and its
				// gate; read-only work stays free under either.
				if (state.task !== undefined && state.request?.weight === "judged" && typeof prompt === "string" && prompt.trim().length > 0) {
					state.directionPending = { text: prompt.trim() };
				}
				return { systemPromptAppend: JEV_SKILL };
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
				const toolCallId = asRecord(event)?.["toolCallId"];
				const input = asRecord(event)?.["input"];
				const state = stateFor(ctx);
				announce(pi, ctx, state);
				if (continuationAllowed(state)) return undefined;
				const triageVerdict = triageBeforeInspectionGate(state, deps.config, toolName, input);
				if (triageVerdict.block) {
					return refuse(pi, ctx, state, toolName, input, triageVerdict);
				}
				const requirementsVerdict = requirementsBeforePlanGate(state, deps.config, toolName, input);
				if (requirementsVerdict.block) {
					return refuse(pi, ctx, state, toolName, input, requirementsVerdict);
				}
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
							handoff = {
								fromSessionId: sessionIdOf(ctx),
								task: state.task,
								plan: state.plan,
								planTopics: state.planTopics,
								requirements: state.requirementsApproval,
								planDraft: state.planDraft,
							};
						}
					}
					return verdict.block
						? refuse(pi, ctx, state, toolName, input, { ...verdict, boundary: verdict.boundary ?? PROPOSE_BOUNDARY })
						: undefined;
				}
				if (!isConsequentialMutation(toolName, input)) return undefined;
				const verdict = mutationGate(state, deps.config, toolName, input);
				if (verdict.block) return refuse(pi, ctx, state, toolName, input, verdict);
				// An owner who turned the gates off asked for no boundary at all.
				if (!deps.config.gates.mutation) return undefined;
				// Every consequential candidate the deterministic gates admit is judged on its own
				// payload before it runs: a registered task against its approved plan, a quiet or simple
				// request against the owner's request itself. No tool name is trusted on its own.
				const admittedTask = state.task;
				const admittedRevision = state.revision;
				const admittedRequest = state.request?.text;
				const binding = await planBindingVerdict(ctx, state);
				if (binding !== undefined) return refuse(pi, ctx, state, toolName, input, binding);
				// The judge receives the complete call, not the bounded evidence excerpt: a payload
				// can hide its real content after the excerpt cap, and a truncated check would pass it.
				const action = { tool: toolName, target: targetOf(input), change: JSON.stringify(input ?? null) };
				let outcome: ToolOutcome;
				try {
					outcome = await serialized(sessionIdOf(ctx), () => actionCheck(activitiesFor(ctx), state, action));
				} catch (error) {
					pi.logger?.warn?.("jevstice: the action check failed", error);
					return refuse(pi, ctx, state, toolName, input, {
						block: true,
						boundary: "action",
						reason: `Jevstice holds this change: the action check could not run (${error instanceof Error ? error.message : String(error)}). The call was not executed; retry it once the judge answers.`,
					});
				}
				if (!outcome.ok || outcome.details["approved"] !== true) {
					return refuse(pi, ctx, state, toolName, input, {
						block: true,
						boundary: "action",
						reason: `${outcome.text} The call was not executed.`,
					});
				}
				// The judgment took a network round-trip: the task, its revision, the gates and the
				// approved artifact are re-read before execution, so an owner prompt or a concurrent
				// write arriving while the answer was in flight cannot retarget the call.
				if (state.task?.fingerprint !== admittedTask?.fingerprint || state.revision !== admittedRevision) {
					return refuse(pi, ctx, state, toolName, input, { block: true, boundary: PLAN_BOUNDARY, reason: PLAN_REQUIRED_REASON });
				}
				// A request-judged call is stale the moment the owner's message changes; nothing of the
				// old authorisation carries over to it.
				if (admittedTask === undefined && state.request?.text !== admittedRequest) {
					return refuse(pi, ctx, state, toolName, input, {
						block: true,
						boundary: "action",
						reason:
							"Jevstice holds this change: the owner's latest message arrived while the call was being judged, so the authorisation is stale. The call was not executed; submit the new request for triage.",
					});
				}
				const requeued = mutationGate(state, deps.config, toolName, input);
				if (requeued.block) return refuse(pi, ctx, state, toolName, input, requeued);
				const rechecked = await planBindingVerdict(ctx, state);
				if (rechecked !== undefined) return refuse(pi, ctx, state, toolName, input, rechecked);
				const finalVerdict = mutationGate(state, deps.config, toolName, input);
				if (finalVerdict.block) return refuse(pi, ctx, state, toolName, input, finalVerdict);
				if (outcome.details["antiSlopDelivery"] === true && typeof toolCallId === "string") {
					deliveryCalls.add(toolCallId);
				}
				return undefined;
			});

			pi.on("tool_result", async (event, ctx) => {
				await restoreApprovedPlan(ctx);
				const record = asRecord(event);
				if (record === undefined) return undefined;
				const toolName = record["toolName"];
				const input = record["input"];
				if (typeof toolName !== "string" || !isConsequentialMutation(toolName, input)) return undefined;
				const callId = record["toolCallId"];
				const delivery = typeof callId === "string" && deliveryCalls.delete(callId);
				const state = stateFor(ctx);
				// Only the registered development task carries the interval, the evidence and the hold.
				if (state.task === undefined) return undefined;
				const target = targetOf(input);
				const action = {
					tool: toolName,
					target,
					excerpt: [changeOf(record["input"]), excerptOf(record["content"])].filter(part => part.length > 0).join("\n"),
				};
				// A consequential call that failed may still have touched the tree: it invalidates
				// acceptance, but it is not progress and advances no check interval.
				if (record["isError"] === true) {
					recordFailedAction(state, action);
					return undefined;
				}
				recordAction(state, action, !delivery);
				// A change outside the approved plan is a trigger of its own (FR-25): the plan named the
				// paths its topics change, so an action elsewhere is a possible change of course.
				if (state.deviation === undefined && targetOutsidePlan(toolName, target, state.planTopics)) {
					markDeviation(state, toolName, target);
				}
				// Completion-only checking defers every course check to completion (FR-12).
				if (continuationAllowed(state)) return undefined;
				if (deps.config.courseCheck.mode !== "interval") return undefined;
				// A check needs an approved plan to judge against, and a standing finding cannot be
				// changed by a course verdict: neither is a reason to spend a judge call.
				if (state.plan === undefined || state.plan.taskFingerprint !== state.task.fingerprint) return undefined;
				if (state.hold !== undefined) return undefined;
				if (state.deviation === undefined && state.actionsSinceCheck < deps.config.courseCheck.interval) return undefined;
				state.actionsSinceCheck = 0;
				// The check is in flight: a change decided before its verdict returns would bypass it,
				// and only this check may clear the marker it set.
				const marker: PendingCheck = { taskFingerprint: state.task.fingerprint, revision: state.revision };
				state.checkPending = marker;
				void runCourseCheck(pi, ctx, sessionIdOf(ctx), marker);
				return undefined;
			});

			pi.on("session_stop", async (_event, ctx) => {
				await restoreApprovedPlan(ctx);
				const state = stateFor(ctx);
				announce(pi, ctx, state);
				if (deps.config.antiSlop.mode === "advisory") {
					const scope = antiSlopScope(state);
					if (scope !== undefined && !scope.quiet) {
						const status = antiSlopStatus(state, scope);
						if (!status.complete) {
							const signature = `advisory:${scope.revision}:${status.missing.join(",")}:${status.blockers.map(finding => finding.id).join(",")}:${status.inconsistent}`;
							if (state.antiSlopNotice !== signature) {
								state.antiSlopNotice = signature;
								notify(
									ctx,
									"Jevstice: the advisory anti-slop review is missing or has unwaived blockers; completion is not held in advisory mode.",
								);
								sendMessage(
									pi,
									"jev.anti_slop_advisory",
									"The external deliverable has no complete anti-slop review at this revision. Completion is not held in advisory mode; the gap is disclosed, not approved.",
									"aside",
								);
							}
						}
					}
				}
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
						const outcome = await serialized(sessionIdOf(ctx), () =>
							completionCheck(activitiesFor(ctx), state, { course: deps.config.courseCheck.mode === "completion" }),
						);
						const completion = state.completion;
						if (completion?.approved === true) {
							delete state.stop;
							return undefined;
						}
						reason = `${outcome.text} The finished work is held at the completion boundary.`;
					}
				}
				// Bound the stop itself too: exhausting acceptance or stop attempts never invents approval.
				const { blocks, exhausted } = recordStopBlock(state, sha256(reason));
				if (!exhausted) return { decision: "block", reason: `${reason} The owner may permit continuation with /jev-continue.` };
				exhaustBoundary(state, "completion");
				sendMessage(pi, "jev.open_item", `Completion remains OPEN after ${blocks} blocked stops: ${reason}. Stopping is permitted without claiming Jev acceptance.`, "aside");
				return undefined;
			});
		},
	};
}
