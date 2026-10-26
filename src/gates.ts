/**
 * The visible boundaries the extension holds (FR-18).
 *
 * The executor's private reasoning is not observable, so the extension enforces only what it can
 * see: a call that would change the working tree, the omp plan-mode proposal `write xd://propose`,
 * and the stop boundary at which a developed task settles. Whether a request reaches any of them is
 * decided per request and for free: the command classifier (`isNonMutatingCommand`) settles what a
 * call does, and the request screen (`screen.ts`) settles whether the request entered the judged
 * workflow at all. Everything here is a pure function of the session state.
 */
import { HOLD_BOUNDARY, PLAN_BOUNDARY, asRecord, type JevConfig, type PlanTopic } from "./types.js";
import { acceptanceAt, type JevState } from "./state.js";

/**
 * Tools that change the working tree when their target is a filesystem path.
 *
 * `bash` is classified by its command text (`isNonMutatingCommand`): a command that provably only
 * reports state or publishes commits changes no working-tree file, so it is not held and does not
 * move the work revision. A command this extension cannot read stays consequential (FR-31).
 */
const MUTATING_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true, bash: true };

/**
 * Shell programs whose plain invocation only reports state: they read the working tree, the
 * environment or the clock and write no file. `git` is read by subcommand instead (below).
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
	uniq: true,
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
	xxd: true,
	od: true,
	shasum: true,
	sha256sum: true,
	md5sum: true,
};

/**
 * Argument tokens that turn an otherwise reporting program into a writer, so a command carrying one
 * is handled as a change even when its program reports state. The `--flag=value` form counts too.
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

/** Whether one argument is a write flag, in either its bare or its `--flag=value` form. */
function isWriteFlag(argument: string): boolean {
	if (WRITE_FLAGS[argument] === true) return true;
	const equals = argument.indexOf("=");
	if (equals < 1) return false;
	return WRITE_FLAGS[argument.slice(0, equals)] === true;
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
	`write local://<slug>-plan.md, then jev_plan_review({"plan": "local://<slug>-plan.md", "claim": "<what the plan serves>", "topics": [{"id": "<topic>", "section": "<a section of that artifact, quoted verbatim>", "paths": ["<the path it changes>"], "requirement": "<the requirement of the task it serves>"}], "evidence": [{"kind": "spec", "quote": "<the task text>"}]})`;

/** The call that answers a finding holding the work (FR-13, FR-28). */
const HOLD_CALL =
	`jev_consult({"mode": "boolean", "question": "<the finding, as a question>", "context": "<the task context>", "trueMeaning": "<what yes commits to>", "falseMeaning": "<what no commits to>"})`;

/** The call that defends finished work before completion (FR-14, FR-15, FR-26, FR-28). */
const ACCEPTANCE_CALL = (aspect: string): string =>
	`jev_acceptance({"aspect": "${aspect}", "claim": "<what the finished work achieves>", "evidence": [{"kind": "execution", "quote": "<the command and its output>"}, {"kind": "code", "quote": "<a diagnostic, a diff or a size measurement>"}]})`;

export const PLAN_REQUIRED_REASON = refusal(
	"Jevstice holds this change: the registered development task has no approved plan.",
	PLAN_CALL,
	"A plan is approved only when every topic you submit passes on its own. Registered jev_ tools, xd://, agent://, local:// and proc:// writes pass this gate.",
);

export const TRIAGE_REQUIRED_REASON = refusal(
	"Jevstice holds this change: no request has been triaged in this session, so no decision on it is known.",
	TRIAGE_CALL,
	"A confirmed simple task then proceeds without plan review, course checks or acceptance; a development task waits for jev_plan_review. Registered jev_ tools, xd://, agent://, local:// and proc:// writes pass this gate.",
);

/** The boundaries the gates refuse at; each one is counted on its own (FR-28). */
const TRIAGE_BOUNDARY = "triage";
const CHECK_BOUNDARY = "course-check";
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
		`Jevstice holds this plan proposal: ${url} changed after the plan review.`,
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
 * The command text with the given quote characters' spans dropped. An unterminated quote drops the
 * rest of the text, which only ever makes the command harder to call reporting.
 */
function withoutQuotes(text: string, quotes: string): string {
	let result = "";
	let quote: string | undefined;
	for (const char of text) {
		if (quote === undefined) {
			if (quotes.includes(char)) {
				quote = char;
				continue;
			}
			result += char;
			continue;
		}
		if (char === quote) quote = undefined;
	}
	return result;
}

/**
 * Whether one operator-free shell segment only reports state: a reporting program without a write
 * flag, or a `git` subcommand that stages, publishes or inspects. A leading `VAR=value` assignment
 * only sets the environment of this command. An unknown program or an unknown subcommand answers
 * false, so an unrecognised command keeps the consequential handling.
 */
function isNonMutatingSegment(segment: string): boolean {
	const tokens = segment.split(/\s+/).filter(token => token.length > 0);
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
	const program = tokens[index];
	if (program === undefined) return true;
	const name = program.slice(program.lastIndexOf("/") + 1);
	const args = tokens.slice(index + 1);
	if (args.some(isWriteFlag)) return false;
	if (name !== "git") return NON_MUTATING_PROGRAMS[name] === true;
	const subcommand = args[0];
	return subcommand !== undefined && NON_MUTATING_GIT_SUBCOMMANDS[subcommand] === true;
}

/**
 * Whether a shell command provably changes no working-tree file: it carries no substitution,
 * redirection or background operator, and every segment joined by `;`, `|`, `&&` or a newline
 * reports state - inspects, or stages and publishes, as `git status` and `git commit` do.
 *
 * A single-quoted span is inert, so it is dropped first; a substitution or a backtick still runs
 * another command inside double quotes, so it is read before those are dropped; a redirection is
 * not, so it is read on what remains, where a commit message's own punctuation is already data.
 * Any shape this cannot read answers false: `rm`, `bun test`, an unknown program and an unparsed
 * substitution all stay consequential, so the gate is no looser than it was for them (FR-31).
 */
export function isNonMutatingCommand(command: string): boolean {
	const unquotedSingle = withoutQuotes(command, "'");
	if (unquotedSingle.includes("`") || unquotedSingle.includes("$(") || unquotedSingle.includes("${")) return false;
	const text = withoutQuotes(unquotedSingle, `"`).replace(/\|\||&&/g, "\n").trim();
	if (text.length === 0) return true;
	if (/[<>&]/.test(text)) return false;
	return text.split(/[;|\n]/).every(isNonMutatingSegment);
}

/** True when the call changes the working tree: a mutating tool at a filesystem-like target. */
export function isConsequentialMutation(toolName: string, input: unknown): boolean {
	if (MUTATING_TOOLS[toolName] !== true) return false;
	const record = asRecord(input);
	// A shell command is judged by its own text: one that only reports state or publishes commits
	// changes no working-tree file, so it costs no approval, no course check and no revision bump.
	if (toolName === "bash") {
		const command = record?.["command"];
		return typeof command !== "string" ? true : !isNonMutatingCommand(command);
	}
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
 * Whether a recorded action target lies outside every path the approved plan's topics name (FR-25).
 * The comparison is on the recorded target string: a target equal to a path, or under it, counts as
 * inside. A shell command is not a path - the command text is the whole command, which no plan names
 * - so commands never count as deviations.
 */
export function targetOutsidePlan(toolName: string, target: string, topics: readonly PlanTopic[]): boolean {
	if (toolName === "bash") return false;
	const paths = topics.flatMap(topic => topic.paths);
	if (paths.length === 0) return false;
	return !paths.some(entry => target === entry || target.startsWith(`${entry}/`) || entry.startsWith(`${target}/`));
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
	// The judge cannot answer at all: nothing can be decided, so no boundary holds work (FR-21).
	if (state.judgeUnavailable === true) return { block: false };
	if (state.checkPending === true) {
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
	// A boundary released after its refusal bound was exhausted stops holding the work: the refusal
	// stays an open item for the owner and nothing in it was approved (FR-23).
	if (state.hold !== undefined && !state.released.includes(HOLD_BOUNDARY)) {
		return {
			block: true,
			boundary: HOLD_BOUNDARY,
			reason: refusal(
				`Jevstice holds this change: ${state.hold.reason}.`,
				HOLD_CALL,
				"An unrelated consultation, or one whose answer leaves the finding standing, does not clear it.",
			),
		};
	}
	if (state.released.includes(PLAN_BOUNDARY)) return { block: false };
	// Only a request that entered the judged workflow opens the gate: triage either confirms a simple
	// task or registers the development task whose plan review the next change waits for.
	if (state.task === undefined) {
		// The screen's reading decides entry, before any judge call: a request read as a publication,
		// an inspection or a verification never asks the judge anything (FR-30).
		if (state.request?.weight === "quiet") return { block: false };
		if (state.simple !== undefined) return { block: false };
		return { block: true, boundary: TRIAGE_BOUNDARY, reason: TRIAGE_REQUIRED_REASON };
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
	// A request triage confirmed simple needs no plan review, so its plan-mode proposal is not held
	// either, and neither is a request the screen never let into the workflow (FR-02, FR-30).
	if (state.simple !== undefined || state.request?.weight === "quiet") return { block: false };
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
	// With the judge unavailable no completion decision can be reached: the session settles and
	// nothing is recorded as approved (FR-21).
	if (state.judgeUnavailable === true) return { applies: false };
	if (state.task === undefined || state.revision === 0) return { applies: false };
	if (state.hold !== undefined && !state.released.includes(HOLD_BOUNDARY)) {
		return {
			applies: true,
			reason: refusal(
				`Jevstice holds this completion: ${state.hold.reason}.`,
				HOLD_CALL,
				"An unrelated consultation, or one whose answer leaves the finding standing, does not clear it.",
			),
		};
	}
	const missing = (["business", "architecture"] as const).filter(
		aspect => acceptanceAt(state, aspect)?.approved !== true && !state.released.includes(`acceptance:${aspect}`),
	);
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
