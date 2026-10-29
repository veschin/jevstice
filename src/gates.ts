/**
 * The visible boundaries the extension holds (FR-18).
 *
 * The executor's private reasoning is not observable, so the extension enforces only what it can
 * see: a call that would change the working tree, the omp plan-mode proposal `write xd://propose`,
 * and the stop boundary at which a developed task settles. Whether a request reaches any of them is
 * decided per request and for free: the command classifier (`isNonMutatingCommand`) settles what a
 * call does, and the request screen (`screen.ts`) settles whether the request entered the judged
 * workflow at all. Everything here is a pure function of the session state.
 *
 * The classification fails closed. A tool, device or shell command this module does not recognise as
 * read-only is consequential, because opaque execution - `eval`, a delegated `task`, an LSP rename,
 * an unknown MCP route - reaches the working tree without naming a file.
 */
import { HOLD_BOUNDARY, PLAN_BOUNDARY, asRecord, type JevConfig, type PlanTopic } from "./types.js";
import {
	acceptanceAt,
	antiSlopScope,
	antiSlopStatus,
	boundaryExhausted,
	boundaryKey,
	continuationAllowed,
	type AntiSlopScope,
	type AntiSlopStatus,
	type JevState,
} from "./state.js";

/**
 * Tools that change the working tree. `write`, `edit` and `ast_edit` are classified by their target;
 * `bash` by its command text (`isNonMutatingCommand`); `eval` and `task` run code this extension
 * cannot read, so every call of theirs is consequential (FR-31). `lsp` is classified by its action.
 */
const MUTATING_TOOLS: Record<string, true> = {
	write: true,
	edit: true,
	ast_edit: true,
	bash: true,
	eval: true,
	task: true,
};

/**
 * Tools that only report state, consult the judge or reach coordination: they are never held and
 * never move the revision. Every tool outside this set and outside `MUTATING_TOOLS` is treated as
 * consequential, so a tool this extension does not know cannot escape the gate.
 */
const READ_ONLY_TOOLS: Record<string, true> = {
	read: true,
	find: true,
	grep: true,
	glob: true,
	web_search: true,
	wait: true,
	ast_grep: true,
	jev_acceptance: true,
	jev_anti_slop: true,
	jev_consult: true,
	jev_plan_review: true,
	jev_reaim: true,
	jev_requirements: true,
	jev_review: true,
	jev_search_relevance: true,
	jev_text_review: true,
	jev_triage: true,
	mcp__google_sheets_get_sheet_data: true,
	mcp__google_sheets_list_sheets: true,
	mcp__google_sheets_list_spreadsheets: true,
};

/** The host's multi-call wrapper: its own name carries no meaning, only the calls it carries do. */
const BATCH_TOOL_NAMES: Record<string, true> = {
	multi_tool_use: true,
	"multi_tool_use.parallel": true,
};

/**
 * The `lsp` actions that only read: they query a server and return text. Every other action
 * (`rename`, `rename_file`, `code_actions`, `reload`, `request`) can edit files through a workspace
 * edit or run a server command, and an unrecognised action is treated the same way.
 */
const LSP_READ_ACTIONS: Record<string, true> = {
	diagnostics: true,
	definition: true,
	type_definition: true,
	implementation: true,
	references: true,
	hover: true,
	symbols: true,
	status: true,
	capabilities: true,
};

/**
 * Shell programs whose plain invocation only reports state: they read the working tree, the
 * environment or the clock and write no file. Programs taking an output file positionally (`uniq`,
 * `xxd`) are deliberately absent, as is every program with a shell escape. `git` is read by
 * subcommand instead (below).
 */
const NON_MUTATING_PROGRAMS: Record<string, true> = {
	ls: true,
	pwd: true,
	cd: true,
	cat: true,
	echo: true,
	printf: true,
	wc: true,
	head: true,
	tail: true,
	cut: true,
	sort: true,
	grep: true,
	rg: true,
	which: true,
	type: true,
	printenv: true,
	whoami: true,
	id: true,
	date: true,
	uname: true,
	hostname: true,
	df: true,
	du: true,
	file: true,
	stat: true,
	tree: true,
	jq: true,
	tr: true,
	basename: true,
	dirname: true,
	realpath: true,
	readlink: true,
	diff: true,
	cmp: true,
	true: true,
	false: true,
	sleep: true,
	nl: true,
	comm: true,
	join: true,
	paste: true,
	rev: true,
	fold: true,
	column: true,
	seq: true,
	expr: true,
	od: true,
	shasum: true,
	sha256sum: true,
	md5sum: true,
};

/**
 * Argument tokens that turn an otherwise reporting program into a writer, so a command carrying one
 * is handled as a change even when its program reports state. The `--flag=value` and joined short
 * (`-ofile`, `-i.bak`) forms count too.
 */
const WRITE_FLAGS: Record<string, true> = {
	"-i": true,
	"--in-place": true,
	"-o": true,
	"--output": true,
	"-exec": true,
	"-execdir": true,
	"-delete": true,
	"-fprint": true,
	"-fls": true,
	"-ok": true,
};

/** Whether one argument is a write flag, in its bare, `--flag=value` or joined short form. */
function isWriteFlag(argument: string): boolean {
	if (WRITE_FLAGS[argument] === true) return true;
	const equals = argument.indexOf("=");
	if (equals > 0 && WRITE_FLAGS[argument.slice(0, equals)] === true) return true;
	if (argument.startsWith("--") || argument.length < 2) return false;
	const joined = argument.slice(0, 2);
	return joined !== "-" && WRITE_FLAGS[joined] === true;
}

/**
 * `git` subcommands that move no working-tree file: the inspection subcommands only read, and staging
 * and publication (`add`, `commit`, `push`) write the index, the object store or a remote - the
 * owner asked for those not to be held at all. Everything else reaches the working tree.
 */
const NON_MUTATING_GIT_SUBCOMMANDS: Record<string, true> = {
	add: true,
	commit: true,
	push: true,
	fetch: true,
	status: true,
	diff: true,
	log: true,
	show: true,
	"rev-parse": true,
	describe: true,
	"ls-files": true,
	"ls-remote": true,
	blame: true,
	shortlog: true,
	whatchanged: true,
	version: true,
	help: true,
};

/** Explicitly read-only or judge routes; every unknown xd device is consequential by default. */
const NON_MUTATING_DEVICES: Record<string, true> = {
	read: true,
	find: true,
	grep: true,
	glob: true,
	lsp: true,
	ast_grep: true,
	propose: true,
	jev_acceptance: true,
	jev_consult: true,
	jev_plan_review: true,
	jev_reaim: true,
	jev_requirements: true,
	jev_review: true,
	jev_search_relevance: true,
	jev_text_review: true,
	jev_triage: true,
	mcp__google_sheets_get_sheet_data: true,
	mcp__google_sheets_list_sheets: true,
	mcp__google_sheets_list_spreadsheets: true,
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
	/** The boundary that refused, so the refusal can be counted and told apart (FR-28). */
	boundary?: string;
}

export interface ProposeVerdict extends GateVerdict {
	/** The artifact URL whose digest still has to match the recorded approval. */
	url?: string;
}

/**
 * One refusal text (FR-20, FR-28): what is held, the one call that resolves it - written out with its
 * arguments so it can be made as it stands - and why nothing else will move the boundary.
 */
function refusal(headline: string, nextCall: string, why: string): string {
	return `${headline} Next call: ${nextCall} ${why}`;
}

/** The call that opens the mutation gate on an untriaged session (FR-18, FR-28). */
const TRIAGE_CALL =
	`jev_triage({"request": "<the owner's request, verbatim>", "topics": ["<a narrow topic this task needs>"], "evidence": [{"kind": "user", "quote": "<a line from the request>"}]})`;

/** The call that opens the mutation gate on a registered development task (FR-18, FR-24, FR-28). */
const PLAN_CALL =
	`write local://<slug>-plan.md, then jev_plan_review({"phase":"outline","steps":[{"id":"<step-id>","summary":"<one high-level action>","requirement":"<exact Jev-approved requirement>"}],"evidence":[{"kind": "user", "quote": "<request or owner reply>"}]}). After Jev approves the full outline, call jev_plan_review once per step with {"phase":"detail","plan":"local://<slug>-plan.md","topic":{"id":"<step-id>","section":"<complete verbatim section>","paths":["<changed path>"],"requirement":"<exact approved requirement>"},"evidence":[{"kind": "user", "quote": "<request or owner reply>"}]}; after every step passes, call jev_plan_review({"phase":"finalize","plan":"local://<slug>-plan.md","evidence":[{"kind": "user", "quote": "<request or owner reply>"}]}).`;

/** The call that answers a finding holding the work (FR-13, FR-28). */
const HOLD_CALL =
	`jev_consult({"mode": "boolean", "question": "<the finding, as a question>", "context": "<the task context>", "trueMeaning": "<what yes commits to>", "falseMeaning": "<what no commits to>"})`;

/** The call that defends finished work before completion (FR-14, FR-15, FR-26, FR-28). */
const ACCEPTANCE_CALL = (aspect: string): string =>
	`jev_acceptance({"aspect": "${aspect}", "claim": "<what the finished work achieves>", "evidence": [{"kind": "execution", "quote": "<the command and its output>"}, {"kind": "code", "quote": "<a diagnostic, a diff or a size measurement>"}]})`;

/** The call that reviews the external deliverable (FR-46, FR-56). */
const ANTI_SLOP_CALL =
	`jev_anti_slop({"artifact": "<exact external artifact text>", "language": "<declared language>", "register": "<declared register>", "purpose": "<declared purpose>", "audience": "external", "rules": [{"class": "<rule class>", "rule": "<owner rule>"}], "claims": [{"id": "claim-1", "text": "<verbatim artifact sentence>", "kind": "fact", "evidence": [{"kind": "documentation", "quote": "<source quote>", "source": "<source locator>", "sourceClass": "official"}]}], "inferences": []})`;

/** Why an external deliverable cannot settle yet (FR-55). */
function antiSlopReason(state: JevState, scope: AntiSlopScope, status: AntiSlopStatus): string {
	if (status.reviews.length === 0) {
		return refusal(
			`Jevstice holds this completion: the external deliverable has no anti-slop review at the current work revision (${state.revision}).`,
			ANTI_SLOP_CALL,
			"The review binds to the exact artifact and the current revision; a later change needs a fresh review.",
		);
	}
	if (status.missing.length > 0) {
		return refusal(
			`Jevstice holds this completion: the anti-slop review covers part(s) ${status.reviews.map(review => review.part.index).join(", ")} but not part(s) ${status.missing.join(", ")}.`,
			ANTI_SLOP_CALL,
			"Every part of the deliverable must be reviewed at the current revision.",
		);
	}
	if (status.inconsistent) {
		return refusal(
			"Jevstice holds this completion: the anti-slop parts were reviewed under different languages, registers or rule sets.",
			ANTI_SLOP_CALL,
			"Review every part with one declared language, register and rule set.",
		);
	}
	const blockers = status.blockers.map(finding => `${finding.id} (${finding.kind})`).join(", ");
	return refusal(
		`Jevstice holds this completion: the anti-slop review has unwaived blocker(s): ${blockers}.`,
		`owner: /jev-waive <finding-id> <reason>; executor: jev_anti_slop with a revised artifact`,
		"A waiver records the owner's acceptance of that finding; it is not Jev approval. A revised artifact needs a fresh review.",
	);
}

export const PLAN_REQUIRED_REASON = refusal(
	"Jevstice holds this change: the registered development task has no approved plan.",
	PLAN_CALL,
	"A plan is approved only when every topic you submit passes on its own. Registered jev_ tools, xd://, agent://, local:// and proc:// writes pass this gate.",
);

export const TRIAGE_REQUIRED_REASON = refusal(
	"Jevstice holds this change: no request has been triaged in this session, so no decision on it is known.",
	TRIAGE_CALL,
	"A development task then waits for requirements and jev_plan_review. Registered jev_ tools, xd://, agent://, local:// and proc:// writes pass this gate.",
);

/** The call that re-aims the task at the owner's latest message (FR-29). */
const REAIM_CALL =
	`jev_reaim({"interjection": "<the owner's latest message, verbatim>", "evidence": [{"kind": "user", "quote": "<the same words>"}]})`;

/**
 * The refusal of a change while the owner's latest message is unjudged (FR-29): the words may name a
 * new course, and only a judged re-aim decides the direction the work has to follow.
 */
function directionReason(state: JevState): string {
	const quoted = state.directionPending?.text ?? "";
	const short = quoted.length > 160 ? `${quoted.slice(0, 160)}...` : quoted;
	return refusal(
		`Jevstice holds this change: the owner sent a message after the task was registered ("${short}"), so the current direction is undecided.`,
		REAIM_CALL,
		"A new plan cannot settle it: only a judged re-aim replaces the task direction, and the re-aimed task then needs its own requirements and plan review.",
	);
}

/**
 * Refusal while availability has not granted current-request continuation (FR-21).
 */
const JUDGE_UNAVAILABLE_REASON = refusal(
	"Jevstice holds this change: the judge could not be reached, so no decision on it can be obtained and nothing is approved.",
	"retry the pending jev_ call (jev_triage, jev_requirements or jev_plan_review) with the same material",
	"Owner permission or the availability attempt limit permits continuation without judge approval.",
);

/**
 * A prior exhausted decision does not authorize a changed request. Its finding remains OPEN.
 */
function openItemReason(state: JevState, boundary: string, what: string): string {
	const item = state.openItem;
	const attempts = item !== undefined && boundaryKey(item.boundary) === boundaryKey(boundary) ? item.attempts : 0;
	return refusal(
		`Jevstice holds ${what}: the ${boundary} boundary is an OPEN item after ${attempts} refused submissions, and nothing was approved.`,
		"obtain current-request owner permission with /jev-continue, or register the owner's changed direction with jev_reaim",
		"The prior request's continuation permission does not carry over to a changed request.",
	);
}

const REQUIREMENTS_CALL =
	`jev_requirements({"request": "<the owner's request>", "items": [{"text": "<one checkable obligation>", "source": "<the request line it comes from>"}], "candidateNeeds": [], "evidence": [{"kind": "user", "quote": "<a line from the request>"}]})`;

export const REQUIREMENTS_REQUIRED_REASON = refusal(
	"Jevstice holds plan preparation: the registered task has no approved requirements review.",
	REQUIREMENTS_CALL,
	"Derive one checkable obligation per part of the owner's request and submit them with the request as evidence; an implementation choice the request does not state is not an owner instruction. Plan files and jev_plan_review remain held until coverage is established and every submitted obligation is supported.",
);

/** Hold plan artifacts and reviews until the registered task's requirements pass. */
export function requirementsBeforePlanGate(
	state: JevState,
	config: JevConfig,
	toolName: string,
	input: unknown,
): GateVerdict {
	if (continuationAllowed(state)) return { block: false };
	if (!config.gates.mutation || state.task === undefined) return { block: false };
	const path = pathOf(asRecord(input));
	const isPlanArtifact = toolName === "write" && path?.startsWith("local://") === true;
	const isPlanReview = toolName === "jev_plan_review" || (toolName === "write" && path === "xd://jev_plan_review");
	if (!isPlanArtifact && !isPlanReview) return { block: false };
	// Plan preparation for a direction the owner's latest message may have replaced spends judge
	// calls on work that a re-aim would discard.
	if (state.directionPending !== undefined) {
		return { block: true, boundary: DIRECTION_BOUNDARY, reason: directionReason(state) };
	}
	if (state.requirementsApproval?.taskFingerprint === state.task.fingerprint) return { block: false };
	if (state.judgeUnavailable === true) {
		return { block: true, boundary: "requirements", reason: JUDGE_UNAVAILABLE_REASON };
	}
	if (boundaryExhausted(state, "requirements")) {
		return { block: true, boundary: "requirements", reason: openItemReason(state, "requirements", "plan preparation") };
	}
	return { block: true, boundary: "requirements", reason: REQUIREMENTS_REQUIRED_REASON };
}

const TRIAGE_INSPECTION_REASON = refusal(
	"Jevstice holds this project inspection: the current request has not been triaged.",
	TRIAGE_CALL,
	"Read the required skills and update task tracking, then triage before inspecting project files or submitting requirements.",
);

/** The boundaries the gates refuse at; each one is counted on its own (FR-28). */
const TRIAGE_BOUNDARY = "triage";
const CHECK_BOUNDARY = "course-check";
const DIRECTION_BOUNDARY = "direction";
export const PROPOSE_BOUNDARY = "propose";

/** The refusal of a proposal whose artifact could not be read back (FR-07, FR-28). */
export function planArtifactUnreadableReason(url: string): string {
	return refusal(
		`Jevstice holds this plan proposal: the artifact ${url} could not be read, so the approval cannot be bound to what is being proposed.`,
		`write ${url}`,
		"An approval binds to the artifact's bytes and never to a copy of them.",
	);
}

/** The refusal of a proposal whose artifact changed after the review (FR-07, FR-28). */
export function planArtifactChangedReason(url: string): string {
	return refusal(
		`Jevstice holds this plan proposal: ${url} changed after the plan review, so the recorded approval no longer binds it.`,
		PLAN_CALL,
		"The approval is bound to the digest that was reviewed, so a changed artifact needs its own review.",
	);
}

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


/**
 * Whether one operator-free shell segment only reports state: a reporting program without a write
 * flag, or a `git` subcommand that stages, publishes or inspects. A leading `VAR=value` assignment
 * only sets the environment of this command. A program named by a path is never trusted - `/tmp/ls`
 * may be anything - and an unknown program or subcommand answers false, so an unrecognised command
 * keeps the consequential handling.
 */
function isNonMutatingSegment(segment: string): boolean {
	const tokens = segment.split(/\s+/).filter(token => token.length > 0);
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
	const program = tokens[index];
	if (program === undefined) return true;
	if (program.includes("/")) return false;
	const args = tokens.slice(index + 1);
	if (args.some(isWriteFlag)) return false;
	if (program !== "git") return NON_MUTATING_PROGRAMS[program] === true;
	const subcommand = args[0];
	return subcommand !== undefined && NON_MUTATING_GIT_SUBCOMMANDS[subcommand] === true;
}

/**
 * Recognize only unquoted literal reporting commands. Quoting and escaping require a shell parser;
 * stripping their contents hides executable substitutions and output flags (FR-31).
 */
export function isNonMutatingCommand(command: string): boolean {
	if (/['"`\\$]/.test(command)) return false;
	const text = command.replace(/\|\||&&/g, "\n").trim();
	if (text.length === 0) return true;
	if (/[<>&]/.test(text)) return false;
	return text.split(/[;|\n]/).every(isNonMutatingSegment);
}

const PRE_TRIAGE_INSPECTION_TOOLS: Record<string, true> = {
	read: true,
	find: true,
	grep: true,
	glob: true,
	bash: true,
	eval: true,
	ast_grep: true,
	lsp: true,
	task: true,
	jev_plan_review: true,
};

/** Hold visible project inspection and plan preparation until a judged request has been triaged (FR-32). */
export function triageBeforeInspectionGate(
	state: JevState,
	config: JevConfig,
	toolName: string,
	input: unknown,
): GateVerdict {
	if (continuationAllowed(state)) return { block: false };
	if (!config.gates.mutation || state.request?.weight !== "judged" || state.task !== undefined || state.simple !== undefined) {
		return { block: false };
	}
	const record = asRecord(input);
	const path = pathOf(record);
	const isNonMutatingShell = toolName === "bash" && typeof record?.["command"] === "string" && isNonMutatingCommand(record["command"]);
	const isNonProjectRead = toolName === "read" && path !== undefined && (!isProjectTarget(path) || path.startsWith("skill://"));
	const isLocalPlan = toolName === "write" && path?.startsWith("local://") === true;
	const isPlanProposal = toolName === "write" && path === PROPOSE_PATH;
	const isInspectionDevice = toolName === "write" && ["lsp", "ast_grep"].includes(deviceOf(path ?? "") ?? "");
	const isRequirements = toolName === "jev_requirements" || (toolName === "write" && path === "xd://jev_requirements");
	const isPlanReview = toolName === "write" && path === "xd://jev_plan_review";
	// A known read-only operation stays free even while the judge is unreachable: the gate holds
	// inspection, it never closes the executor's ability to read its own instructions.
	if (
		isNonProjectRead ||
		isNonMutatingShell ||
		(!PRE_TRIAGE_INSPECTION_TOOLS[toolName] &&
			!isLocalPlan &&
			!isPlanProposal &&
			!isInspectionDevice &&
			!isRequirements &&
			!isPlanReview)
	) {
		return { block: false };
	}
	if (state.judgeUnavailable === true) {
		return { block: true, boundary: TRIAGE_BOUNDARY, reason: JUDGE_UNAVAILABLE_REASON };
	}
	if (boundaryExhausted(state, TRIAGE_BOUNDARY)) {
		return { block: true, boundary: TRIAGE_BOUNDARY, reason: openItemReason(state, TRIAGE_BOUNDARY, "this project inspection") };
	}
	return { block: true, boundary: TRIAGE_BOUNDARY, reason: TRIAGE_INSPECTION_REASON };
}

/** Whether an LSP call applies an edit or runs a server command rather than answering a query. */
function lspMutates(record: Record<string, unknown> | undefined): boolean {
	const action = record?.["action"];
	return typeof action !== "string" || LSP_READ_ACTIONS[action] !== true;
}

/** The payload of an `xd://lsp` dispatch: a JSON string or an object naming the action. */
function devicePayload(content: unknown): Record<string, unknown> | undefined {
	if (typeof content !== "string") return asRecord(content);
	try {
		return asRecord(JSON.parse(content));
	} catch {
		return undefined;
	}
}

/** The tools one multi-call wrapper carries, or undefined when its payload cannot be read. */
function wrappedCalls(input: unknown): Array<{ name: string; input: unknown }> | undefined {
	const record = asRecord(input);
	const calls = record?.["tool_uses"] ?? record?.["calls"];
	if (!Array.isArray(calls) || calls.length === 0) return undefined;
	const wrapped: Array<{ name: string; input: unknown }> = [];
	for (const entry of calls) {
		const call = asRecord(entry);
		const name = call?.["recipient_name"] ?? call?.["tool"] ?? call?.["name"];
		if (typeof name !== "string" || name.length === 0) return undefined;
		wrapped.push({ name, input: call?.["parameters"] ?? call?.["input"] ?? call?.["args"] });
	}
	return wrapped;
}

/** True when the call changes the working tree: a consequential tool at a filesystem-like target. */
export function isConsequentialMutation(toolName: string, input: unknown): boolean {
	// A wrapper is judged by the calls it carries: one consequential call makes the whole call one.
	if (BATCH_TOOL_NAMES[toolName] === true) {
		const wrapped = wrappedCalls(input);
		if (wrapped === undefined) return true;
		return wrapped.some(call => isConsequentialMutation(call.name, call.input));
	}
	if (MUTATING_TOOLS[toolName] !== true) {
		if (READ_ONLY_TOOLS[toolName] === true) return false;
		if (toolName === "lsp") return lspMutates(asRecord(input));
		// An unknown tool can be anything, so it is treated as a change until it is known to read.
		return true;
	}
	const record = asRecord(input);
	// A shell command is judged by its own text: one that only reports state or publishes commits
	// changes no working-tree file, so it costs no approval, no course check and no revision bump.
	if (toolName === "bash") {
		const command = record?.["command"];
		return typeof command !== "string" ? true : !isNonMutatingCommand(command);
	}
	// Opaque execution names no target this extension can check, so it is always a change.
	if (toolName === "eval" || toolName === "task") return true;
	const targets: string[] = [];
	const path = pathOf(record);
	if (path !== undefined) targets.push(path);
	const paths = record?.["paths"];
	if (Array.isArray(paths)) {
		for (const entry of paths) if (typeof entry === "string" && entry.length > 0) targets.push(entry);
	}
	if (targets.length === 0) return true; // an unreadable target is treated as a change
	if (toolName === "write") {
		const device = deviceOf(targets[0] ?? "");
		if (device !== undefined) {
			if (NON_MUTATING_DEVICES[device] !== true) return true;
			if (device === "lsp") return lspMutates(devicePayload(record?.["content"]));
			return false;
		}
	}
	return targets.some(isProjectTarget);
}

/**
 * Whether a recorded action target lies outside every path the approved plan's topics name (FR-25).
 * The comparison is on the recorded target string: a target equal to a path, or under it, counts as
 * inside. Shell commands and opaque execution carry no path as their target - their own payload was
 * judged before execution - so they never count as deviations.
 */
export function targetOutsidePlan(toolName: string, target: string, topics: readonly PlanTopic[]): boolean {
	if (toolName === "bash" || toolName === "eval" || toolName === "task") return false;
	const paths = topics.flatMap(topic => topic.paths);
	if (paths.length === 0) return false;
	return !paths.some(entry => target === entry || target.startsWith(`${entry}/`) || entry.startsWith(`${target}/`));
}

/**
 * The mutation gate: hold a consequential change while a decision the extension knows about is
 * pending. A change is admitted by an approved plan for the registered task and nothing else: a
 * quiet reading and a simple verdict both cover read-only work, so neither authorises a working-tree
 * change, and an unjudged owner message closes the gate until a re-aim decides the direction.
 */
export function mutationGate(
	state: JevState,
	config: JevConfig,
	toolName: string,
	input: unknown,
): GateVerdict {
	if (!config.gates.mutation) return { block: false };
	if (continuationAllowed(state)) return { block: false };
	if (!isConsequentialMutation(toolName, input)) return { block: false };
	// No current-request continuation grant applies; unavailable judgment cannot approve a call.
	if (state.judgeUnavailable === true) {
		return { block: true, boundary: "judge", reason: JUDGE_UNAVAILABLE_REASON };
	}
	if (state.checkPending !== undefined) {
		return {
			block: true,
			boundary: CHECK_BOUNDARY,
			reason: refusal(
				"Jevstice holds this change: a course check is in flight and its verdict is not in yet.",
				"(none - wait for the course check message, then continue)",
				"A change decided before the check's verdict returns would bypass it.",
			),
		};
	}
	// A finding holds the work until a consultation the judge accepts resolves it; a spent refusal
	// budget leaves it blocked as an OPEN item (FR-13, FR-23).
	if (state.hold !== undefined) {
		return {
			block: true,
			boundary: HOLD_BOUNDARY,
			reason: boundaryExhausted(state, HOLD_BOUNDARY)
				? openItemReason(state, HOLD_BOUNDARY, "this change")
				: refusal(
						`Jevstice holds this change: ${state.hold.reason}.`,
						HOLD_CALL,
						"An unrelated consultation, or one whose answer leaves the finding standing, does not clear it.",
					),
		};
	}
	if (boundaryExhausted(state, PLAN_BOUNDARY)) {
		return { block: true, boundary: PLAN_BOUNDARY, reason: openItemReason(state, PLAN_BOUNDARY, "this change") };
	}
	// Only a request that entered the judged workflow opens the gate by itself: triage either confirms
	// a simple task or registers the development task whose plan review the next change waits for. A
	// request read as a publication or an inspection never asks the judge anything (FR-30); the
	// controller still judges each consequential candidate on its own payload before it runs.
	if (state.task === undefined) {
		if (boundaryExhausted(state, TRIAGE_BOUNDARY)) {
			return { block: true, boundary: TRIAGE_BOUNDARY, reason: openItemReason(state, TRIAGE_BOUNDARY, "this change") };
		}
		if (state.request?.weight === "quiet") return { block: false };
		if (state.simple !== undefined) return { block: false };
		return { block: true, boundary: TRIAGE_BOUNDARY, reason: TRIAGE_REQUIRED_REASON };
	}
	// The owner's latest message is not judged yet: its words may name a new course, so the old
	// direction holds nothing until a re-aim decides (FR-29).
	if (state.directionPending !== undefined) {
		return { block: true, boundary: DIRECTION_BOUNDARY, reason: directionReason(state) };
	}
	if (state.plan !== undefined && state.plan.taskFingerprint === state.task.fingerprint) return { block: false };
	return { block: true, boundary: PLAN_BOUNDARY, reason: PLAN_REQUIRED_REASON };
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
	if (continuationAllowed(state)) return { block: false };
	// A request triage confirmed simple needs no plan review, so its plan-mode proposal is not held
	// either - but only while no development task is registered, and a quiet follow-up never opens a
	// registered task's proposal (FR-02, FR-30).
	if (state.task === undefined && (state.simple !== undefined || state.request?.weight === "quiet")) return { block: false };
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
	if (boundaryExhausted(state, PLAN_BOUNDARY) || boundaryExhausted(state, PROPOSE_BOUNDARY)) {
		return {
			block: true,
			boundary: PROPOSE_BOUNDARY,
			reason: openItemReason(state, PLAN_BOUNDARY, `this plan proposal of ${url}`),
		};
	}
	if (state.plan === undefined) {
		return {
			block: true,
			boundary: PLAN_BOUNDARY,
			reason: refusal(
				`Jevstice holds this plan proposal: no Jev plan review has passed for ${url}.`,
				PLAN_CALL,
				`The approval binds to ${url} and to the task; proposing the artifact before that review is refused.`,
			),
		};
	}
	if (state.task === undefined || state.plan.taskFingerprint !== state.task.fingerprint) {
		return {
			block: true,
			boundary: PLAN_BOUNDARY,
			reason: `the recorded plan approval belongs to a different task (${state.plan.planUrl}). Review ${url} for the current task first.`,
		};
	}
	if (state.plan.planUrl !== url) {
		return {
			block: true,
			boundary: PLAN_BOUNDARY,
			reason: `the approved plan is ${state.plan.planUrl}, not ${url}. Review the artifact you are proposing.`,
		};
	}
	if (state.directionPending !== undefined) {
		return { block: true, boundary: DIRECTION_BOUNDARY, reason: directionReason(state) };
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
	if (continuationAllowed(state)) return { applies: false };
	if (state.task === undefined) {
		if (state.simple?.external === true && config.antiSlop.mode === "enforce") {
			const scope = antiSlopScope(state);
			if (scope !== undefined) {
				const status = antiSlopStatus(state, scope);
				if (!status.complete) return { applies: true, reason: antiSlopReason(state, scope, status) };
			}
		}
		return { applies: false };
	}
	if (state.revision === 0) return { applies: false };
	// Permission is checked above; without it, unavailable judgment cannot approve completion.
	if (state.judgeUnavailable === true) return { applies: true, reason: JUDGE_UNAVAILABLE_REASON };
	// The course check in flight owns the revision it started on: wait for its verdict first.
	if (state.checkPending !== undefined) {
		return {
			applies: true,
			reason: refusal(
				"Jevstice holds this completion: a course check is in flight and its verdict is not in yet.",
				"(none - wait for the course check message, then stop again)",
				"A stop decided before the check's verdict returns would settle work the check has not seen.",
			),
		};
	}
	if (state.hold !== undefined) {
		return {
			applies: true,
			reason: boundaryExhausted(state, HOLD_BOUNDARY)
				? openItemReason(state, HOLD_BOUNDARY, "this completion")
				: refusal(
						`Jevstice holds this completion: ${state.hold.reason}.`,
						HOLD_CALL,
						"An unrelated consultation, or one whose answer leaves the finding standing, does not clear it.",
					),
		};
	}
	// The owner's latest message is unjudged: completion would report on a direction no longer known.
	if (state.directionPending !== undefined) return { applies: true, reason: directionReason(state) };
	if (config.antiSlop.mode === "enforce") {
		const scope = antiSlopScope(state);
		if (scope !== undefined && !scope.quiet) {
			const status = antiSlopStatus(state, scope);
			if (!status.complete) return { applies: true, reason: antiSlopReason(state, scope, status) };
		}
	}
	const missing = (["business", "architecture"] as const).filter(aspect => acceptanceAt(state, aspect)?.approved !== true);
	const spent = missing.find(aspect => boundaryExhausted(state, `acceptance:${aspect}`));
	if (spent !== undefined) {
		return {
			applies: true,
			reason: openItemReason(state, `acceptance:${spent}`, `this completion (acceptance for ${spent} is an OPEN item)`),
		};
	}
	if (missing.length > 0) {
		const aspect = missing[0] ?? "business";
		return {
			applies: true,
			reason: refusal(
				`developed work cannot be reported complete: acceptance has not passed for ${missing.join(" and ")} at the current work revision (${state.revision} consequential changes).`,
				ACCEPTANCE_CALL(aspect),
				`Acceptance for ${missing.join(" and ")} is required at the current revision; any later change invalidates an approval.`,
			),
		};
	}
	return { applies: true };
}
