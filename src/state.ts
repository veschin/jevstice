/**
 * Per-session gate state and the digests that bind an approval to concrete work.
 *
 * The state lives in memory for the session: a host restart loses an approval and the gate closes
 * again, which is the safe direction (approvals are never restored from disk and never inferred).
 */
import { createHash } from "node:crypto";
import { POLICY, type Aspect } from "./types.js";

/** The development task the gate belongs to. */
export interface TaskIdentity {
	/** SHA-256 of the request text; the approval ledger is keyed by it. */
	fingerprint: string;
	request: string;
}

/** A plan approval, bound to one task and one exact artifact content. */
export interface PlanApproval {
	taskFingerprint: string;
	planUrl: string;
	planDigest: string;
	confidence: number;
}

/** One acceptance verdict for one aspect at one work revision. */
export interface AcceptanceRecord {
	aspect: Aspect;
	revision: number;
	label: string;
	approved: boolean;
	confidence: number;
}

/** One successful consequential action, kept as evidence for the course and completion checks. */
export interface ActionRecord {
	tool: string;
	target: string;
	excerpt: string;
}

/** The last course check and what it said. */
export interface CourseCheckRecord {
	revision: number;
	label: string;
	approved: boolean;
	confidence: number;
}

/** The last completion check and what it said. */
export interface CompletionRecord {
	revision: number;
	label: string;
	approved: boolean;
	confidence: number;
}

/** The stop-block ledger for one unchanged refusal. */
export interface StopRecord {
	signature: string;
	blocks: number;
}

/** Everything the gates read and write for one session. */
export interface JevState {
	task?: TaskIdentity;
	/** The request triage confirmed simple: consequential changes pass without the complex stages. */
	simple?: TaskIdentity;
	plan?: PlanApproval;
	/** Count of successful consequential changes; a change invalidates stale approvals. */
	revision: number;
	/** Consequential actions since the last course check. */
	actionsSinceCheck: number;
	/** A course check is in flight: consequential changes wait for its verdict. */
	checkPending?: boolean;
	/** A finding that holds consequential changes until the executor consults. */
	hold?: { reason: string };
	actions: ActionRecord[];
	courseCheck?: CourseCheckRecord;
	completion?: CompletionRecord;
	acceptance: AcceptanceRecord[];
	stop?: StopRecord;
}

export function freshState(): JevState {
	return { revision: 0, actionsSinceCheck: 0, actions: [], acceptance: [] };
}

/** SHA-256 in hex; the fingerprint and the artifact binding are both built from it. */
export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Drop every approval, verdict and record that belonged to the previous request. */
function clearWork(state: JevState): void {
	delete state.task;
	delete state.simple;
	delete state.plan;
	delete state.hold;
	delete state.courseCheck;
	delete state.completion;
	delete state.stop;
	state.acceptance = [];
	state.actions = [];
	state.revision = 0;
	state.actionsSinceCheck = 0;
}

/**
 * Register the development task under a fingerprint of its request. A different request starts
 * fresh work, so every approval and verdict of the previous task is dropped.
 */
export function registerTask(state: JevState, request: string): TaskIdentity {
	const fingerprint = sha256(request.trim());
	if (state.simple === undefined && state.task?.fingerprint === fingerprint) return state.task;
	clearWork(state);
	state.task = { fingerprint, request };
	return state.task;
}

/**
 * Record a request triage confirmed simple. The verdict belongs to that request and ends any
 * registered development task, so consequential changes pass without the complex stages.
 */
export function registerSimple(state: JevState, request: string): TaskIdentity {
	clearWork(state);
	state.simple = { fingerprint: sha256(request.trim()), request };
	return state.simple;
}

/** The acceptance verdict for one aspect at the current revision, if recorded. */
export function acceptanceAt(state: JevState, aspect: Aspect): AcceptanceRecord | undefined {
	return state.acceptance.find(record => record.aspect === aspect && record.revision === state.revision);
}

/** Record one acceptance verdict, replacing the earlier record for that aspect. */
export function recordAcceptance(state: JevState, record: AcceptanceRecord): void {
	state.acceptance = state.acceptance.filter(existing => existing.aspect !== record.aspect);
	state.acceptance.push(record);
}

/** Record one successful consequential action, its excerpt and the new work revision. */
export function recordAction(state: JevState, action: ActionRecord): void {
	state.revision += 1;
	state.actionsSinceCheck += 1;
	delete state.completion;
	state.actions = [...state.actions, action].slice(-POLICY.maxActionRecords);
}

/**
 * Count one blocked stop for an unchanged refusal. The count allows POLICY.maxStopBlocks blocks;
 * beyond that the refusal is recorded as an open item instead of looping on the same framing.
 */
export function recordStopBlock(state: JevState, signature: string): { block: boolean; blocks: number } {
	const blocks = state.stop?.signature === signature ? state.stop.blocks + 1 : 1;
	state.stop = { signature, blocks };
	return { block: blocks <= POLICY.maxStopBlocks, blocks };
}
