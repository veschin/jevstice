/**
 * The one gate/review mechanism.
 *
 * The architecture review scored this codebase 2.32/9 and named the top change (0.91):
 * GENERALIZE THE THREE GATES. They were one mechanism written three times - the plan/mutation
 * gate, the subagent hand-off gate and the destructive-action gate - each with its own constants,
 * its own identically shaped judge call, its own internal deadline, its own record type and its
 * own restore function. The review activities (`business_review`, `architecture_review` and the
 * opt-in `security_review`) are the same mechanism in `advisory` mode.
 *
 * A descriptor declares, in one place:
 *  - the SUBJECT it judges and the evidence that must support the judgement (`evidenceRequired`,
 *    `evidenceKinds`);
 *  - the consult FRAME: the fixed question, the claim shape built from the subject verbatim, the
 *    offered option set (or the fixed question set of a review) and the internal DEADLINE;
 *  - the MODE: `blocking` refuses the action on a confident explicit negative; `advisory`
 *    records and surfaces and has no refusal path at all;
 *  - the OUTCOME MAPPING: the record the result lands in and the boundary that consults it.
 *
 * Adding a gate or a review is adding a descriptor here - not a new code path: the controller
 * runs every consult through `consultGate` (single decision) or `consultReview`
 * (src/reviews.ts), and every record is restored by one validator per record shape.
 *
 * The modes are structural, not incidental: `DecisionConsult` carries the refusal option and the
 * deadline, `ReviewConsult` carries neither, and the registry validator refuses a review
 * descriptor that is not advisory or a decision descriptor that is not blocking.
 */
import type { ControlPointTrigger } from "./control-points.js";
import { HOST_HANDLER_TIMEOUT_MS, withDeadline } from "./deadline.js";
import {
	REVIEW_QUESTIONS,
	parseReviewQuestions,
	type ReviewId,
	type ReviewQuestion,
} from "./reviews.js";
import type {
	DecisionOption,
	DecisionResult,
	DecisionStage,
	DecisionVerdict,
	Evidence,
	Judge,
} from "./types.js";

/** Quote cap for consult evidence: the kept prefix stays verbatim and the source reports the cut. */
export const HANDOFF_QUOTE_CAP = 4000;

/**
 * Dispatch deadline for the FR-11 hand-off consult. The host runs `before_subagent_spawn`
 * handlers under a 30s timeout and DROPS the handler result on timeout, letting the spawn proceed,
 * while this handler keeps running: a negative that arrives after that ceiling would be recorded
 * as a refusal that never applied. Live endpoint latency has been measured at 33s against the
 * resetting edge, so the gate decides well before the host gives up.
 */
export const HANDOFF_DISPATCH_DEADLINE_MS = 25_000;

/**
 * Destructive-action consult deadline. The host bounds every `tool_call` handler at 30s and its
 * on-timeout policy is fail-CLOSED (`{ block: true }`), so a slow judge would otherwise become a
 * block this gate never decided: the deadline fires first and takes the fail-open path.
 */
export const DESTRUCTIVE_DEADLINE_MS = 25_000;

/**
 * Marker the client puts in `reasons` on a frame escape, followed by the service option id, the
 * companion meta_reason and the actionable fix (client.ts FRAME_FIX_PREFIX). A frame rejection is
 * never an explicit negative about the work, so it can record but never refuse.
 */
export const FRAME_ESCAPE_REASON = "meta_option";

/** How a gate or review acts on the judge's answer. */
export type GateMode = "blocking" | "advisory";

/** The six descriptors of the mechanism. */
export type GateId =
	| "plan_mutation"
	| "subagent_handoff"
	| "destructive_action"
	| "business_review"
	| "architecture_review"
	| "security_review";

/** One consultation frame of a gate: the fixed question and the claim built from the subject. */
export interface DecisionFrame {
	/** The one-sentence question the client fixes for this consultation. */
	task: string;
	/** The fixed claim shape: the descriptor owns the wording, the caller supplies the subject. */
	claim: (subject: string) => string;
	/** Internal deadline, under the host's handler timeout. Absent = a background consult. */
	deadlineMs?: number;
}

/** The single-decision consult of a blocking gate. */
export interface DecisionConsult {
	kind: "decision";
	/** Frames keyed by consult name (`dispatch`, `acceptance`, `execution`). */
	frames: Readonly<Record<string, DecisionFrame>>;
	/** Default offered option set; a `stages.<stage>` template may replace it (R3). */
	options: readonly DecisionOption[];
	/** The option id whose selection (with a confident revise) is the refusal. */
	refusalOption: string;
}

/** The approval store is the mechanism: the executor's submission is the consult. */
export interface ApprovalConsult {
	kind: "approval";
	/** Stages whose approval opens the pre-mutation boundary (the plan stages). */
	grantingStages: readonly DecisionStage[];
	/** Stage whose approval opens the session-stop boundary. */
	stopStage: DecisionStage;
}

/** A review's fixed question set: no options, no refusal option, no refusal path. */
export interface ReviewConsult {
	kind: "review";
	/** The fixed framing sentence of the review. */
	task: string;
	questions: readonly ReviewQuestion[];
	/** Internal deadline, under the host's handler timeout. */
	deadlineMs: number;
}

interface GateDescriptorBase {
	id: GateId;
	/** The stage the consult or approval is filed under (a registered control point). */
	stage: DecisionStage;
	mode: GateMode;
	/** The control-point trigger the controller enforces for this descriptor. */
	trigger: ControlPointTrigger;
	/** Where the mechanism is reached (the controller boundary or the submission). */
	boundary: string;
	/** The owner switch that arms it, verbatim. */
	armedBy: string;
	/** What a consult must quote. */
	evidenceRequired: string;
	evidenceKinds: readonly Evidence["kind"][];
}

export interface DecisionGate extends GateDescriptorBase {
	consult: DecisionConsult;
}
export interface ApprovalGate extends GateDescriptorBase {
	consult: ApprovalConsult;
}
export interface ReviewGate extends Omit<GateDescriptorBase, "id"> {
	id: ReviewId;
	consult: ReviewConsult;
}
export type GateDescriptor = DecisionGate | ApprovalGate | ReviewGate;

/**
 * Hand-off option set (shared with the acceptance side). The option ids carry consequence: the
 * controller reads an explicit `revise` verdict as the negative; an `approve` is never required
 * for the work to pass, and a template that overrides the options without keeping `revise` leaves
 * the gate advisory.
 */
export const HANDOFF_OPTIONS: readonly DecisionOption[] = [
	{
		id: "approve",
		label: "Hand-off is sound",
		meaning: "the work order or the returned result matches the quoted requirement and is complete enough to proceed",
	},
	{
		id: "revise",
		label: "Hand-off is deficient",
		meaning: "the work order or result contradicts or omits part of the quoted requirement; name the deficiency",
	},
];

/**
 * Destructive-action option set: the refusal is an explicit `revise`, never the absence of one.
 * The wording covers both triggers of the descriptor (a shell command and an out-of-root write), so
 * the same option set stays truthful whichever boundary produced the consult.
 */
export const DESTRUCTIVE_OPTIONS: readonly DecisionOption[] = [
	{
		id: "approve",
		label: "Safe to execute",
		meaning:
			"the command is not destructive or irreversible, or the write goes to a path the quoted task " +
			"clearly intends, and the action is scoped so that running it is clearly intended",
	},
	{
		id: "revise",
		label: "Destructive or irreversible",
		meaning:
			"the command or the write deletes or overwrites data, rewrites history, drops schema, or lands " +
			"outside the project the task works in, and is otherwise hard to reverse; do not run it without a " +
			"fresh explicit decision - name the hazard",
	},
];

/**
 * The mechanism's descriptor registry. Six descriptors, one place.
 *
 *  - `plan_mutation`: the approval gate. It has no judge call of its own: the executor's
 *    `jev_decision` submission is the consult, and the approval record - bound to task
 *    fingerprint, content digest and work revision - is the teeth, checked on the pre-mutation
 *    boundary and at the session stop. The mutation and stop boundaries are one mechanism, so
 *    both are declared here.
 *  - `subagent_handoff`: the FR-11 gate. The controller consults it at the task-tool boundary
 *    (dispatch, before the spawn) and at the delivery of the delegated result (acceptance).
 *  - `destructive_action`: POLICY-DRAFT I. The controller consults it at the tool_call boundary
 *    twice: for a bash command matching `gates.destructive.patterns`, and (when
 *    `gates.destructive.outsideProjectWrites` arms it) for a write/edit/ast_edit call whose target
 *    lies outside the project root - the same descriptor, one option set, one refusal rule.
 *  - the three reviews: advisory stages with fixed question sets; they record per-item results
 *    and surface them, and refuse nothing.
 */
export const GATE_REGISTRY: Readonly<Record<GateId, GateDescriptor>> = {
	plan_mutation: {
		id: "plan_mutation",
		stage: "understanding_review",
		mode: "blocking",
		trigger: "mutation_gate",
		boundary: "onToolCall (pre-mutation) and onSessionStop; the approval is recorded by submitDecision",
		armedBy: "gates.mutation (user-owned, default on) for the mutation side; gates.completion for the stop side",
		evidenceRequired: "the plan as a claim, with at least one submitted quote (20+ characters) inside it and a user/spec requirement quote",
		evidenceKinds: ["user", "spec", "code", "execution", "log"],
		consult: {
			kind: "approval",
			grantingStages: ["understanding_review", "direction_review"],
			stopStage: "completion_review",
		},
	},
	subagent_handoff: {
		id: "subagent_handoff",
		stage: "subagent_handoff",
		mode: "blocking",
		trigger: "on_demand",
		boundary: "onHandoffDispatch (before_subagent_spawn) and the delegated-result delivery (acceptance)",
		armedBy:
			"stages.subagent_handoff (owner config; absent = the gate does not exist); the acceptance side " +
			"additionally requires gates.handoffAcceptance",
		evidenceRequired: "the captured user requirement (kind user) plus the work order or the delivered result, verbatim",
		evidenceKinds: ["user", "spec", "log"],
		consult: {
			kind: "decision",
			options: HANDOFF_OPTIONS,
			refusalOption: "revise",
			frames: {
				dispatch: {
					task: "Validate the work order the lead agent is about to hand to a task agent, before dispatch (FR-11).",
					claim: subject =>
						"Claim under judgment: this work order is an adequate assignment for a task agent - it asks for the " +
						"work the quoted user requirement needs, stays within it, and names a result the agent can hand back.\n\n" +
						subject,
					deadlineMs: HANDOFF_DISPATCH_DEADLINE_MS,
				},
				acceptance: {
					task: "Validate the result a task agent delivered, before the lead agent accepts it and builds on it (FR-11).",
					claim: subject =>
						"Claim under judgment: the returned result satisfies the quoted user requirement and is supported by " +
						"what the delegated agent reported; nothing the requirement asks for is missing or contradicted.\n\n" +
						subject,
				},
			},
		},
	},
	destructive_action: {
		id: "destructive_action",
		stage: "destructive_action",
		mode: "blocking",
		trigger: "on_demand",
		boundary:
			"onDestructiveCall (tool_call, before a matching bash command runs, and before a write/edit/ast_edit " +
			"whose resolved target lies outside the project root)",
		armedBy:
			"gates.destructive.patterns arms the command trigger (absent or empty = it does not exist); " +
			"gates.destructive.outsideProjectWrites (owner config, off by default) arms the outside-root write trigger",
		evidenceRequired:
			"the bash command about to run, or the outside-root write's tool name, target path(s) and content " +
			"prefix, verbatim, plus the session task prompt when captured",
		evidenceKinds: ["spec", "user", "code", "log"],
		consult: {
			kind: "decision",
			options: DESTRUCTIVE_OPTIONS,
			refusalOption: "revise",
			frames: {
				execution: {
					task:
						"Judge this destructive or irreversible shell command at execution time, before it runs " +
						"(POLICY-DRAFT destructive-action gate; the plan never covers it).",
					claim: subject =>
						"Claim under judgment: this shell command is destructive or irreversible enough that running it " +
						"now is not safe without a fresh explicit decision - it deletes or overwrites data, rewrites " +
						"history, drops schema, or is otherwise hard to reverse.\n\n" +
						subject,
					deadlineMs: DESTRUCTIVE_DEADLINE_MS,
				},
				outside_root_write: {
					task:
						"Judge this file write or edit at execution time, before it runs: its target lies outside the " +
						"project root the task works in (POLICY-DRAFT destructive-action gate; the plan never covers " +
						"a target outside its own boundary).",
					claim: subject =>
						"Claim under judgment: this write or edit modifies a path outside the project root the task " +
						"works in, which is outside the boundary the plan covers - creating, overwriting or deleting " +
						"a file there is not safe without a fresh explicit decision unless the quoted task clearly " +
						"intends it.\n\n" +
						subject,
					deadlineMs: DESTRUCTIVE_DEADLINE_MS,
				},
			},
		},
	},
	business_review: {
		id: "business_review",
		stage: "business_review",
		mode: "advisory",
		trigger: "on_demand",
		boundary: "submitDecision (stage=business_review); the controller runs the fixed question set itself",
		armedBy: "always submittable; the review holds no gate, so there is no switch to arm",
		evidenceRequired: "the product as it stands, the customer's goal and problem, and the executor's declared decisions under review",
		evidenceKinds: ["user", "spec", "code", "execution", "log", "documentation"],
		consult: {
			kind: "review",
			task:
				"Business review of the product as it stands: score the promised outcome and how much of the work " +
				"serves it, choose the biggest declared risk, and mark the fixed statement and every declared decision.",
			questions: REVIEW_QUESTIONS.business_review,
			deadlineMs: 25_000,
		},
	},
	architecture_review: {
		id: "architecture_review",
		stage: "architecture_review",
		mode: "advisory",
		trigger: "on_demand",
		boundary: "submitDecision (stage=architecture_review); the controller runs the fixed question set itself",
		armedBy: "always submittable; the review holds no gate, so there is no switch to arm",
		evidenceRequired: "a module inventory (file, lines, role), the test inventory, the observed duplication, the invariants",
		evidenceKinds: ["code", "execution", "log", "documentation"],
		consult: {
			kind: "review",
			task:
				"Architecture review of the implementation: score how well it absorbs the next change, mark every " +
				"declared defect, and choose the declared change that would most improve it.",
			questions: REVIEW_QUESTIONS.architecture_review,
			deadlineMs: 25_000,
		},
	},
	security_review: {
		id: "security_review",
		stage: "security_review",
		mode: "advisory",
		trigger: "on_demand",
		boundary: "submitDecision (stage=security_review); the controller runs the fixed question set itself",
		armedBy: "opt-in by submission: the stage is registered but no boundary consults it on its own",
		evidenceRequired: "the changed surfaces and the code that implements them, verbatim",
		evidenceKinds: ["code", "spec", "documentation"],
		consult: {
			kind: "review",
			task:
				"Security review of the declared surfaces: mark whether each one opens an attack or disclosure path " +
				"and choose the single worst if it is left as it stands.",
			questions: REVIEW_QUESTIONS.security_review,
			deadlineMs: 25_000,
		},
	},
};

/** Type guards over the consult shape (they preserve narrowing for the controller and tests). */
export function isDecisionGate(descriptor: GateDescriptor): descriptor is DecisionGate {
	return descriptor.consult.kind === "decision";
}
export function isApprovalGate(descriptor: GateDescriptor): descriptor is ApprovalGate {
	return descriptor.consult.kind === "approval";
}
export function isReviewGate(descriptor: GateDescriptor): descriptor is ReviewGate {
	return descriptor.consult.kind === "review";
}

/** Narrow a descriptor to the single-decision consult (programmer error otherwise). */
export function decisionGate(id: GateId): DecisionGate {
	const descriptor = GATE_REGISTRY[id];
	if (!isDecisionGate(descriptor)) throw new Error(`gate "${id}" is not a single-decision consult`);
	return descriptor;
}

/** Narrow a descriptor to the approval consult (programmer error otherwise). */
export function approvalGate(id: GateId): ApprovalGate {
	const descriptor = GATE_REGISTRY[id];
	if (!isApprovalGate(descriptor)) throw new Error(`gate "${id}" is not an approval consult`);
	return descriptor;
}

/** Narrow a descriptor to the review consult (programmer error otherwise). */
export function reviewGate(id: GateId): ReviewGate {
	const descriptor = GATE_REGISTRY[id];
	if (!isReviewGate(descriptor)) throw new Error(`gate "${id}" is not a review consult`);
	return descriptor;
}

/** The descriptor a stage belongs to, or undefined for a stage outside the mechanism. */
export function gateByStage(stage: string): GateDescriptor | undefined {
	return Object.values(GATE_REGISTRY).find(descriptor => descriptor.stage === stage);
}

/** The review descriptor a stage names, when it is one. */
export function reviewGateForStage(stage: string): ReviewGate | undefined {
	const descriptor = gateByStage(stage);
	return descriptor !== undefined && isReviewGate(descriptor) ? descriptor : undefined;
}

// ---------- the shared consult runner ----------

/** A judge answer approves only if fully well-formed, option-resolvable and confident enough (AC4c/d). */
export function normalizeJudgeResult(raw: unknown, options: readonly DecisionOption[], minConfidence: number): DecisionResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { verdict: "insufficient_evidence", reasons: ["judge returned a non-object payload"] };
	}
	const record = raw as Record<string, unknown>;
	const verdict = record["verdict"];
	if (typeof verdict !== "string" || VERDICTS[verdict] !== true) {
		return { verdict: "insufficient_evidence", reasons: [`judge returned unknown verdict: ${String(verdict)}`] };
	}
	const reasons = Array.isArray(record["reasons"])
		? record["reasons"].filter((r): r is string => typeof r === "string")
		: [];
	const confidence = typeof record["confidence"] === "number" ? record["confidence"] : undefined;
	if (verdict === "approve") {
		const selected = record["selectedOption"];
		if (typeof selected !== "string" || !options.some(o => o.id === selected)) {
			return {
				verdict: "insufficient_evidence",
				reasons: ["judge approved without naming one of the offered options"],
			};
		}
		// Written as a positive test on purpose: `confidence < 0 || confidence > 1` is false for NaN,
		// which let a malformed answer keep the approve verdict (found by the 2026-10-08 review).
		if (confidence !== undefined && !(confidence >= 0 && confidence <= 1)) {
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
		selectedOption: typeof record["selectedOption"] === "string" ? record["selectedOption"] : undefined,
		reasons: reasons.length > 0 ? reasons : [`judge verdict: ${verdict}`],
		confidence,
	};
}

const VERDICTS: Readonly<Record<string, true>> = {
	approve: true,
	revise: true,
	insufficient_evidence: true,
	ask_user: true,
};

/**
 * The refusal condition, shared by every blocking gate: only an explicit negative - a `revise`
 * verdict, from an offered option set that names the refusal, that did not escape the frame, with
 * a real confidence at or above the floor and inside 0..1 - refuses an action. An abstention, a
 * judge error, a low or absent confidence and a frame escape are never a refusal.
 * (`normalizeJudgeResult` range-checks confidence on the approve branch only, so a malformed 1.5
 * revise must not count either.)
 */
export function confidentNegative(
	result: DecisionResult,
	options: readonly DecisionOption[],
	refusalOption: string,
	minConfidence: number,
): boolean {
	return (
		result.verdict === "revise" &&
		options.some(o => o.id === refusalOption) &&
		!result.reasons.includes(FRAME_ESCAPE_REASON) &&
		result.confidence !== undefined &&
		result.confidence >= minConfidence &&
		result.confidence <= 1
	);
}

/**
 * The named problems a judge's refusal leaves standing (PRD section 1.1 and FR-10, the owner's own
 * words: "если ты спросил судью и он сказал переделать значит выясняй что не так и переделывай" -
 * the answer obliges). The problems are the judge's OWN reasons, kept verbatim and in the order it
 * named them: they are what the next submission on the stage must answer by name, and what the
 * next consult shows the judge verbatim. A frame escape is not a statement about the work and an
 * empty reason names nothing, so neither becomes a problem; a repeat of an already-standing problem
 * is not a second problem.
 */
export function namedRefusalProblems(reasons: readonly string[]): string[] {
	const problems: string[] = [];
	for (const reason of reasons) {
		const problem = reason.trim();
		if (problem.length === 0 || problem === FRAME_ESCAPE_REASON) continue;
		if (problems.includes(problem)) continue;
		problems.push(problem);
	}
	return problems;
}

/**
 * Which named problems a submission did not answer. Answers are POSITIONAL: one entry per standing
 * problem, in the order the refusal named them (the same order the feedback numbers them and the
 * numbered list repeats), so a missing or blank entry leaves that problem standing. This is a
 * precondition only - the executor's own words are never evidence (FR-16); the judge's answer is
 * what decides whether a problem is resolved.
 */
export function unansweredProblems(problems: readonly string[], answers: readonly string[] | undefined): string[] {
	return problems.filter((_, i) => {
		const answer = answers?.[i];
		return answer === undefined || answer.trim().length === 0;
	});
}

/** `1. <problem>` lines: the numbered, verbatim list of standing problems the executor reads. */
export function numberedProblems(problems: readonly string[]): string {
	return problems.map((problem, i) => `${i + 1}. ${problem}`).join("\n");
}

/**
 * The consult block that makes the standing problems part of the judgement: the named problems
 * verbatim, the declared answers verbatim, and the question asked about them. Empty while no
 * problem stands, so a first submission's frame is untouched - and a submission that answered
 * nothing reaches the judge with that visible, never as a silently fresh question.
 */
export function outstandingProblemsBlock(problems: readonly string[], answers: readonly string[] | undefined): string {
	if (problems.length === 0) return "";
	const declared = problems
		.map((_, i) => {
			const answer = answers?.[i];
			return answer === undefined || answer.trim().length === 0
				? `${i + 1}. <not answered>`
				: `${i + 1}. ${answer.trim()}`;
		})
		.join("\n");
	return (
		"THIS STAGE IS UNDER AN OUTSTANDING REFUSAL: a previous submission on it was refused and the judge " +
		"named the problems below.\n\n" +
		`Named problems (verbatim, from the judge):\n${numberedProblems(problems)}\n\n` +
		`What this submission declares changed for each problem (verbatim, from the executor):\n${declared}\n\n` +
		"Question on THIS submission: does the quoted evidence show every named problem resolved? Approve only " +
		"if it does; if any named problem still stands, refuse again and name that problem."
	);
}

export interface GateConsultContext {
	/** Which frame of the descriptor frames this consultation. */
	frame: string;
	/** The subject under judgment, verbatim (work order, command, delivered result). */
	subject: string;
	evidence: Evidence[];
	/** Template option override for the stage (R3); undefined keeps the descriptor's set. */
	options?: readonly DecisionOption[];
	judge: Judge;
	minConfidence: number;
	/** Test seam: override the frame's internal deadline. */
	deadlineMs?: number;
}

export interface GateConsultResult {
	/** True when the judge answered (an unusable answer is still a consultation, not a failure). */
	judged: boolean;
	verdict?: DecisionVerdict;
	confidence?: number;
	reasons: string[];
	/** The offered option set the judge saw (the template override included). */
	options: readonly DecisionOption[];
	/** The internal deadline fired first: the answer never arrived in time and is not read. */
	deadlineLost: boolean;
	/** Confident explicit negative AND a blocking descriptor: the action is refused. */
	negative: boolean;
}

/**
 * One gate consultation: frame -> deadline race -> judge -> normalize -> refusal condition. Never
 * throws (a judge error is an unjudged result that approves and refuses nothing), and it is the
 * single code path every blocking gate uses.
 */
export async function consultGate(gate: DecisionGate, ctx: GateConsultContext): Promise<GateConsultResult> {
	const options = ctx.options ?? gate.consult.options;
	const frame = gate.consult.frames[ctx.frame];
	if (frame === undefined) {
		// A frame typo is a programming error, not a judge answer: it must never refuse work.
		return {
			judged: false,
			reasons: [`gate "${gate.id}" declares no frame "${ctx.frame}"; nothing was judged`],
			options,
			deadlineLost: false,
			negative: false,
		};
	}
	let raw: unknown;
	try {
		raw = await withDeadline(
			ctx.judge({
				stage: gate.stage,
				task: frame.task,
				proposal: frame.claim(ctx.subject),
				options: [...options],
				evidence: ctx.evidence,
			}),
			ctx.deadlineMs ?? frame.deadlineMs,
		);
	} catch (err) {
		return {
			judged: false,
			reasons: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`],
			options,
			deadlineLost: false,
			negative: false,
		};
	}
	if (raw === undefined) {
		return { judged: false, reasons: [], options, deadlineLost: true, negative: false };
	}
	const result = normalizeJudgeResult(raw, options, ctx.minConfidence);
	return {
		judged: true,
		verdict: result.verdict,
		confidence: result.confidence,
		reasons: result.reasons,
		options,
		deadlineLost: false,
		negative:
			gate.mode === "blocking" &&
			confidentNegative(result, options, gate.consult.refusalOption, ctx.minConfidence),
	};
}

/** What a gate line needs from a record: the verdict, its confidence and the reasons. */
export interface GateRecordView {
	judged: boolean;
	verdict?: DecisionVerdict;
	confidence?: number;
	reasons: string[];
}

/** One-line fixed-template summary of a gate record (no generated prose); `head` names the gate. */
export function gateLine(head: string, record: GateRecordView): string {
	const verdict = record.judged ? (record.verdict ?? "unusable answer") : "not judged";
	const confidence = record.confidence !== undefined ? `, confidence ${record.confidence}` : "";
	const reasons = record.reasons.length > 0 ? ` - ${record.reasons.join(" ")}` : "";
	return `${head}: ${verdict}${confidence}${reasons}`;
}

/** Verbatim prefix of a quote, capped for cost; `truncated` lets the source string report the cut. */
export function cappedQuote(text: string): { quote: string; truncated: boolean } {
	const trimmed = text.trim();
	return { quote: trimmed.slice(0, HANDOFF_QUOTE_CAP), truncated: trimmed.length > HANDOFF_QUOTE_CAP };
}

/** Judge evidence item for a consult: the quote stays verbatim even when capped. */
export function gateEvidence(kind: Evidence["kind"], source: string, text: string): Evidence {
	const { quote, truncated } = cappedQuote(text);
	return {
		kind,
		source: truncated ? `${source} (verbatim prefix, truncated at ${HANDOFF_QUOTE_CAP} characters)` : source,
		quote,
	};
}

/** `${label}:\n${verbatim capped quote}`: the subject block a gate frame embeds verbatim. */
export function gateSubject(label: string, text: string): string {
	return `${label}:\n${cappedQuote(text).quote}`;
}

// ---------- persisted gate records ----------

/** The fields every gate record carries; one validator covers both record shapes. */
export interface GateRecordFields {
	judged: boolean;
	verdict?: DecisionVerdict;
	confidence?: number;
	reasons: string[];
	blocked: boolean;
	at: number;
}

/**
 * Validate the shared fields of a persisted gate record. Undefined when the record is malformed:
 * the caller drops it rather than trusting disk, then validates its own extra fields and spreads
 * this base in.
 */
export function restoreGateRecordFields(raw: unknown): GateRecordFields | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record["judged"] !== "boolean" || typeof record["blocked"] !== "boolean") return undefined;
	if (typeof record["at"] !== "number" || !Number.isFinite(record["at"])) return undefined;
	const verdict = record["verdict"];
	if (verdict !== undefined && (typeof verdict !== "string" || VERDICTS[verdict] !== true)) return undefined;
	return {
		judged: record["judged"],
		verdict: verdict as DecisionVerdict | undefined,
		// Read back from disk, a confidence is checked the way the live path checks it: a non-finite
		// or out-of-range value is dropped rather than carried into a displayed record (review N4).
		confidence:
			typeof record["confidence"] === "number" &&
			Number.isFinite(record["confidence"]) &&
			record["confidence"] >= 0 &&
			record["confidence"] <= 1
				? record["confidence"]
				: undefined,
		reasons: Array.isArray(record["reasons"])
			? record["reasons"].filter((r): r is string => typeof r === "string")
			: [],
		blocked: record["blocked"],
		at: record["at"],
	};
}

// ---------- registry validation ----------

export interface GateRegistryProblem {
	code: string;
	gate?: string;
	stage?: string;
	detail: string;
}

/**
 * Report every way the registry can be a defect: a missing or extra descriptor, a stage the
 * control-point registry does not know (or whose trigger contradicts the descriptor), a blocking
 * decision gate whose option set does not name its refusal, a review that is not advisory (or an
 * advisory gate that is not a review - an advisory descriptor has no refusal path at all), a
 * malformed question set, a deadline at or above the host's handler timeout, or an approval gate
 * naming a stage that does not carry the trigger it claims. An empty array means the six
 * descriptors are wired and answerable; the suite asserts exactly that.
 */
export function validateGateRegistry(
	registry: Readonly<Record<string, GateDescriptor>> = GATE_REGISTRY,
	points: Readonly<Record<string, { trigger: ControlPointTrigger }>> = {},
): GateRegistryProblem[] {
	const problems: GateRegistryProblem[] = [];
	const push = (code: string, detail: string, where: { gate?: string; stage?: string } = {}): void => {
		problems.push({ code, detail, ...where });
	};
	const ids = Object.keys(registry);
	const gateIds: readonly string[] = [
		"plan_mutation",
		"subagent_handoff",
		"destructive_action",
		"business_review",
		"architecture_review",
		"security_review",
	];
	for (const id of gateIds) {
		if (!(id in registry)) push("gate_missing", `descriptor "${id}" is not declared`, { gate: id });
	}
	for (const id of ids) {
		if (!gateIds.includes(id)) push("gate_unknown", `"${id}" is not one of the gate/review descriptors`, { gate: id });
	}
	const seenStages = new Set<string>();
	for (const descriptor of Object.values(registry)) {
		const gate = descriptor.id;
		if (descriptor.consult.kind === "review" && descriptor.mode !== "advisory") {
			push("review_not_advisory", "a review descriptor must be advisory (a review never refuses)", { gate });
		}
		if (descriptor.mode === "advisory" && descriptor.consult.kind !== "review") {
			push(
				"advisory_without_refusal_path_shape",
				"an advisory descriptor must be a review: advisory means it has no refusal path at all",
				{ gate },
			);
		}
		if (seenStages.has(descriptor.stage)) {
			push("duplicate_stage", `stage "${descriptor.stage}" is claimed by two descriptors`, { gate, stage: descriptor.stage });
		}
		seenStages.add(descriptor.stage);
		const point = points[descriptor.stage];
		if (point === undefined) {
			push("stage_not_registered", `stage "${descriptor.stage}" is not a registered control point`, {
				gate,
				stage: descriptor.stage,
			});
		} else if (point.trigger !== descriptor.trigger) {
			push(
				"trigger_mismatch",
				`descriptor declares trigger "${descriptor.trigger}" but the control point is "${point.trigger}"`,
				{ gate, stage: descriptor.stage },
			);
		}
		if (descriptor.evidenceKinds.length === 0) {
			push("evidence_kinds_empty", "the descriptor must declare which evidence kinds a consult quotes", { gate });
		}
		if (descriptor.consult.kind === "decision") {
			const consult = descriptor.consult;
			if (consult.options.length < 2) push("options_out_of_range", "a decision gate needs at least 2 options", { gate });
			const optionIds = new Set(consult.options.map(o => o.id));
			if (optionIds.size !== consult.options.length) push("duplicate_option_ids", "option ids must be unique", { gate });
			if (!optionIds.has(consult.refusalOption)) {
				push(
					"refusal_option_not_offered",
					`the refusal option "${consult.refusalOption}" is not in the offered set (the gate would have no teeth)`,
					{ gate },
				);
			}
			const frames = Object.entries(consult.frames);
			if (frames.length === 0) push("no_frames", "a decision gate declares no consult frame", { gate });
			for (const [name, frame] of frames) {
				if (frame.task.trim().length === 0) push("frame_without_task", `frame "${name}" has no task sentence`, { gate });
				if (frame.claim("").trim().length === 0) push("frame_without_claim", `frame "${name}" has no claim shape`, { gate });
				if (frame.deadlineMs !== undefined && frame.deadlineMs >= HOST_HANDLER_TIMEOUT_MS) {
					push(
						"deadline_at_or_above_host_timeout",
						`frame "${name}" deadline ${frame.deadlineMs}ms must stay under the host's ${HOST_HANDLER_TIMEOUT_MS}ms`,
						{ gate },
					);
				}
			}
		}
		if (descriptor.consult.kind === "approval") {
			const consult = descriptor.consult;
			if (consult.grantingStages.length === 0) push("approval_without_stage", "the approval gate names no granting stage", { gate });
			for (const stage of consult.grantingStages) {
				if (points[stage]?.trigger !== "mutation_gate") {
					push("approval_stage_trigger_mismatch", `granting stage "${stage}" does not carry the mutation_gate trigger`, {
						gate,
						stage,
					});
				}
			}
			if (points[consult.stopStage]?.trigger !== "session_stop") {
				push("stop_stage_trigger_mismatch", `stop stage "${consult.stopStage}" does not carry the session_stop trigger`, {
					gate,
					stage: consult.stopStage,
				});
			}
		}
		if (descriptor.consult.kind === "review") {
			const consult = descriptor.consult;
			try {
				const parsed = parseReviewQuestions(consult.questions, "questions");
				const perItem = parsed.filter(q => q.perItem === true);
				const choice = parsed.filter(q => q.kind === "choice");
				if (choice.length === 0) push("review_without_choice", "a review declares no choice question", { gate });
				if (perItem.length === 0) push("review_without_per_item", "a review declares no per-item question", { gate });
				if (perItem.some(q => q.findingWhen === undefined)) {
					push("per_item_without_finding_polarity", "a per-item question must state which outcome is a finding", { gate });
				}
				const ids = parsed.map(q => q.id);
				if (new Set(ids).size !== ids.length) push("duplicate_question_ids", "review question ids must be unique", { gate });
			} catch (err) {
				push("malformed_question_set", err instanceof Error ? err.message : String(err), { gate });
			}
			if (consult.deadlineMs >= HOST_HANDLER_TIMEOUT_MS) {
				push(
					"deadline_at_or_above_host_timeout",
					`review deadline ${consult.deadlineMs}ms must stay under the host's ${HOST_HANDLER_TIMEOUT_MS}ms`,
					{ gate },
				);
			}
		}
	}
	return problems;
}

export type { ReviewId, ReviewQuestion };
