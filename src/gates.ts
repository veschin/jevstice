/**
 * The visible boundaries the extension holds (FR-18).
 *
 * The executor's private reasoning is not observable, so the extension enforces only what it can
 * see: a call that would change the working tree, the omp plan-mode proposal `write xd://propose`,
 * and the stop boundary at which a developed task settles.
 */
import { asRecord, type JevConfig } from "./types.js";
import { acceptanceAt, type JevState } from "./state.js";

/**
 * Tools that change the working tree when their target is a filesystem path.
 *
 * `bash` is held and recorded as a whole: a command cannot be classified as read-only or mutating
 * without parsing it, and a shell reaches the working tree through arbitrarily many paths.
 * ponytail: a command-level classifier (git status is read-only, rm is not) would narrow this.
 */
const MUTATING_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true, bash: true };

/** `xd://` devices that change the working tree or drive the desktop when dispatched. */
const MUTATING_DEVICES: Record<string, true> = {
	write: true,
	edit: true,
	ast_edit: true,
	bash: true,
	eval: true,
	computer: true,
	resolve: true,
	reject: true,
	checkpoint: true,
	rewind: true,
};

/** Schemes reaching coordination, session artifacts or judge tools rather than the working tree. */
const COORDINATION_SCHEMES: Record<string, true> = {
	xd: true,
	agent: true,
	local: true,
	artifact: true,
	proc: true,
	memory: true,
	mcp: true,
};

/** The omp plan-mode proposal path. */
const PROPOSE_PATH = "xd://propose";

export interface GateVerdict {
	block: boolean;
	reason?: string;
}

export interface ProposeVerdict extends GateVerdict {
	/** The artifact URL whose digest still has to match the recorded approval. */
	url?: string;
}

export const PLAN_REQUIRED_REASON =
	"Jevstice holds this change: the registered development task has no approved plan. Write the plan artifact to local://<slug>-plan.md, then call jev_plan_review with plan 'local://<slug>-plan.md', the claim the plan serves the task and quoted evidence from the task and the plan. Registered jev_ tools, xd://, agent://, local:// and proc:// writes pass this gate.";

export const TRIAGE_REQUIRED_REASON =
	"Jevstice holds this change: no request has been triaged in this session, so no decision on it is known. Call jev_triage with the owner's request and quoted evidence (or submit requirements with jev_requirements) before the first consequential change; a confirmed simple task then proceeds without plan review, course checks or acceptance, while a development task waits for jev_plan_review. Registered jev_ tools, xd://, agent://, local:// and proc:// writes pass this gate.";

/** The session artifact URL a plan slug maps to (omp's own plan-mode naming). */
export function planArtifactUrl(slug: string): string {
	return `local://${slug}-plan.md`;
}

function schemeOf(target: string): string | undefined {
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(target);
	return match?.[1]?.toLowerCase();
}

/** The device name of an `xd://<device>` target. */
function deviceOf(target: string): string | undefined {
	if (!target.startsWith("xd://")) return undefined;
	const name = target.slice("xd://".length).split(/[/?#]/, 1)[0];
	return name !== undefined && name.length > 0 ? name : undefined;
}

function isProjectTarget(target: string): boolean {
	const scheme = schemeOf(target);
	if (scheme === undefined) return true;
	return COORDINATION_SCHEMES[scheme] !== true;
}

/** The target a tool call names, including omp's legacy `file_path` alias. */
function pathOf(record: Record<string, unknown> | undefined): string | undefined {
	const path = record?.["path"];
	if (typeof path === "string" && path.length > 0) return path;
	const legacy = record?.["file_path"];
	return typeof legacy === "string" && legacy.length > 0 ? legacy : undefined;
}

/** True when the call changes the working tree: a mutating tool at a filesystem-like target. */
export function isConsequentialMutation(toolName: string, input: unknown): boolean {
	if (MUTATING_TOOLS[toolName] !== true) return false;
	const record = asRecord(input);
	const targets: string[] = [];
	const path = pathOf(record);
	if (path !== undefined) targets.push(path);
	const paths = record?.["paths"];
	if (Array.isArray(paths)) {
		for (const entry of paths) if (typeof entry === "string" && entry.length > 0) targets.push(entry);
	}
	if (targets.length === 0) return true; // an unreadable target, or a shell command, is treated as a change
	if (toolName === "write") {
		const device = deviceOf(targets[0] ?? "");
		if (device !== undefined) return MUTATING_DEVICES[device] === true;
	}
	return targets.some(isProjectTarget);
}

/**
 * The mutation gate: hold a consequential change while a decision the extension knows about is
 * pending. A session whose request triage confirmed simple is never held; a session that has not
 * been triaged holds its first consequential change, because registering that work is what the
 * extension judges.
 */
export function mutationGate(
	state: JevState,
	config: JevConfig,
	toolName: string,
	input: unknown,
): GateVerdict {
	if (!config.gates.mutation) return { block: false };
	if (!isConsequentialMutation(toolName, input)) return { block: false };
	if (state.checkPending === true) {
		return {
			block: true,
			reason:
				"Jevstice holds this change: a course check is in flight and its verdict is not in yet. Wait for the check to report before the next consequential change.",
		};
	}
	if (state.hold !== undefined) {
		return {
			block: true,
			reason: `${state.hold.reason}. Consult jev_consult about that finding, with the task context and quoted evidence that answer it, before the next consequential change.`,
		};
	}
	// Only a triaged request opens the gate: triage either confirms a simple task or registers the
	// development task whose plan review the next change waits for.
	if (state.task === undefined) {
		if (state.simple !== undefined) return { block: false };
		return { block: true, reason: TRIAGE_REQUIRED_REASON };
	}
	if (state.plan !== undefined && state.plan.taskFingerprint === state.task.fingerprint) return { block: false };
	return { block: true, reason: PLAN_REQUIRED_REASON };
}

/** Whether a tool call is the plan-mode proposal `write xd://propose`. */
export function isProposeCall(toolName: string, input: unknown): boolean {
	if (toolName !== "write") return false;
	return pathOf(asRecord(input)) === PROPOSE_PATH;
}

/**
 * The plan slug omp derives from a proposal title, mirroring plan mode's own naming: a trailing
 * `.md` is dropped, spaces become hyphens, characters that cannot sit in a file name are dropped,
 * repeated and edge hyphens collapse, and a trailing `-plan` is stripped so it is not doubled.
 * `undefined` names a title omp itself refuses, so no plan file could carry it.
 */
function planSlugFromTitle(title: string): string | undefined {
	const trimmed = title.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return undefined;
	const sanitized = trimmed
		.replace(/\.md$/i, "")
		.replace(/\s+/g, "-")
		.replace(/[^A-Za-z0-9_-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (sanitized.length === 0) return undefined;
	const slug = sanitized.replace(/-plan$/i, "");
	return slug.length > 0 ? slug : sanitized;
}

/**
 * The plan-mode boundary: `write xd://propose` needs a plan approval bound to this task and to the
 * artifact it proposes. The returned `url` names the artifact whose digest the caller must still
 * match against the recorded approval, so a plan whose content changed is not proposed.
 */
export function proposeGate(state: JevState, config: JevConfig, input: unknown): ProposeVerdict {
	if (!config.gates.mutation) return { block: false };
	const content = asRecord(input)?.["content"];
	const slug = typeof content === "string" ? planSlugFromTitle(content) : undefined;
	if (slug === undefined) {
		return {
			block: true,
			reason:
				"the plan proposal carries no plan slug. Write the plan slug (matching local://<slug>-plan.md) as plain text to xd://propose.",
		};
	}
	const url = planArtifactUrl(slug);
	if (state.plan === undefined) {
		return {
			block: true,
			reason: `Jevstice holds this plan proposal: no Jev plan review has passed for ${url}. Write the plan artifact to that URL, then call jev_plan_review with plan '${url}', the claim the plan serves the task and quoted evidence from the task and the plan.`,
		};
	}
	if (state.task === undefined || state.plan.taskFingerprint !== state.task.fingerprint) {
		return {
			block: true,
			reason: `the recorded plan approval belongs to a different task (${state.plan.planUrl}). Review ${url} for the current task first.`,
		};
	}
	if (state.plan.planUrl !== url) {
		return {
			block: true,
			reason: `the approved plan is ${state.plan.planUrl}, not ${url}. Review the artifact you are proposing.`,
		};
	}
	return { block: false, url };
}

/** The completion boundary's decision: whether the extension holds this stop, and why. */
export interface CompletionGate {
	/** Whether the extension holds stops of this session at all. */
	applies: boolean;
	/** A refusal decided from the recorded state alone, so no judge call is spent on it. */
	reason?: string;
}

/**
 * Whether the completion boundary applies, and any refusal the recorded state already settles.
 * Read-only sessions and tasks that changed nothing never enter the gate (a simple query ends
 * without acceptance calls); `applies` with no reason means the completion check decides.
 */
export function completionGate(state: JevState, config: JevConfig): CompletionGate {
	if (!config.gates.completion) return { applies: false };
	if (state.task === undefined || state.revision === 0) return { applies: false };
	if (state.hold !== undefined) {
		return {
			applies: true,
			reason: `${state.hold.reason}. Consult jev_consult with the task context and quoted evidence before reporting the task complete.`,
		};
	}
	const missing = (["business", "architecture"] as const).filter(
		aspect => acceptanceAt(state, aspect)?.approved !== true,
	);
	if (missing.length > 0) {
		return {
			applies: true,
			reason: `developed work cannot be reported complete: acceptance has not passed for ${missing.join(" and ")} at the current work revision (${state.revision} consequential changes). Call jev_acceptance with aspect "${missing[0] ?? "business"}" and quoted artifact and verification evidence, then the other aspect; any later change invalidates an approval.`,
		};
	}
	return { applies: true };
}
