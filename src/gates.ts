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
	permittedRepair,
	recoveryFeedback,
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
	todo: true,
	ast_grep: true,
	jev_context: true,
	jev_course_check: true,
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
 * `xxd`) are deliberately absent, and each reporting program's own output or execution options are
 * guarded below. `git` is read by subcommand instead.
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
	test: true,
	"[": true,
};

/** Potential effects: ordinary mode exempts repository metadata and publication; strict mode does not. */
const SHELL_TREE_CHANGE = 1;
const SHELL_NON_TREE_CHANGE = 2;
const SHELL_PUBLICATION = 4;
const GIT_SUBCOMMAND_EFFECTS: Record<string, number> = {
	add: SHELL_NON_TREE_CHANGE,
	commit: SHELL_NON_TREE_CHANGE,
	push: SHELL_PUBLICATION,
	fetch: SHELL_NON_TREE_CHANGE,
	status: 0,
	diff: 0,
	log: 0,
	show: 0,
	"rev-parse": 0,
	describe: 0,
	"ls-files": 0,
	"ls-remote": 0,
	blame: 0,
	shortlog: 0,
	whatchanged: 0,
	version: 0,
	help: 0,
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
	jev_context: true,
	jev_course_check: true,
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
/** Fetching a URL reads an external artifact, not the project tree. */
const EXTERNAL_READ_SCHEMES: Record<string, true> = { http: true, https: true };

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

interface ProposeVerdict extends GateVerdict {
	/** The artifact URL whose digest still has to match the recorded approval. */
	url?: string;
}

/**
 * One refusal text (FR-20, FR-28): the decision, the concrete next call, then the missing
 * prerequisite and the evidence reads that stay open. The machine boundary stays on `GateVerdict`.
 */
function refusal(headline: string, nextCall: string, why: string): string {
	const separator = /[.!?]$/.test(nextCall) ? " " : ". ";
	return `${headline} Next call: ${nextCall}${separator}${why}`;
}

/** The call that opens the mutation gate on an untriaged session (FR-18, FR-28). */
const TRIAGE_CALL =
	`jev_triage({"request": "<owner request, verbatim>", "topics": ["<narrow topic>"], "evidence": [{"kind": "user", "quote": "<line from the request>"}]})`;

/** The call that opens the mutation gate on a registered development task (FR-18, FR-24, FR-28). */
const PLAN_CALL =
	`write local://<slug>-plan.md, then jev_plan_review with phase "outline" (one id, summary and requirement per step, plus user evidence), one phase "detail" submission per step (verbatim section and changed paths), and phase "finalize"`;

/** The call that defends finished work before completion (FR-14, FR-15, FR-26, FR-28). */
const ACCEPTANCE_CALL = (aspect: string): string =>
	`jev_acceptance({"aspect":"${aspect}","claim":"<what the finished work achieves>","evidence":[{"kind":"execution","quote":"<command and output>"},{"kind":"code","quote":"<diff, diagnostic or measurement>"}]})`;

/** The call that reviews the external deliverable (FR-46, FR-56). */
const ANTI_SLOP_CALL =
	`jev_anti_slop({"artifact":"<exact artifact text>","language":"<declared language>","register":"<declared register>","purpose":"<declared purpose>","audience":"external","rules":[...],"claims":[...],"inferences":[]})`;

/** Why an external deliverable cannot settle yet (FR-55). */
function antiSlopReason(state: JevState, status: AntiSlopStatus): string {
	if (status.reviews.length === 0) {
		return refusal(
			`Jevstice holds this completion: the external deliverable has no anti-slop review at the current work revision (${state.revision}).`,
			ANTI_SLOP_CALL,
			"A review of the exact artifact at this revision is the missing prerequisite. Evidence reads and jev_context stay open.",
		);
	}
	if (status.missing.length > 0) {
		return refusal(
			`Jevstice holds this completion: the anti-slop review covers part(s) ${status.reviews.map(review => review.part.index).join(", ")} but not part(s) ${status.missing.join(", ")}.`,
			ANTI_SLOP_CALL,
			"Every part reviewed at the current revision is the missing prerequisite. Evidence reads stay open.",
		);
	}
	if (status.inconsistent) {
		return refusal(
			"Jevstice holds this completion: the anti-slop parts were reviewed under different languages, registers or rule sets.",
			ANTI_SLOP_CALL,
			"One declared language, register and rule set across every part is the missing prerequisite; evidence reads stay open.",
		);
	}
	const blockers = status.blockers.map(finding => `${finding.id} (${finding.kind})`).join(", ");
	return refusal(
		`Jevstice holds this completion: the anti-slop review has unwaived blocker(s): ${blockers}.`,
		`owner: /jev-waive <finding-id> <reason>; executor: jev_anti_slop with a revised artifact`,
		"A waiver records the owner's acceptance of that finding, not Jev approval; a revised artifact needs a fresh review. Evidence reads stay open.",
	);
}

export const PLAN_REQUIRED_REASON = refusal(
	"Jevstice holds this change: the registered development task has no approved plan.",
	PLAN_CALL,
	"The approved plan is the missing prerequisite. Evidence reads, jev_context and xd:// coordination stay open; each topic is approved on its own.",
);

const TRIAGE_REQUIRED_REASON = refusal(
	"Jevstice holds this change: the current request has not been triaged.",
	TRIAGE_CALL,
	"Triage is the missing prerequisite. Evidence reads, jev_context and xd:// coordination stay open.",
);

/** The call that re-aims the task at the owner's latest message (FR-29). */
const REAIM_CALL =
	`jev_reaim({"interjection":"<owner's latest message, verbatim>","evidence":[{"kind":"user","quote":"<the same words>"}]})`;

/**
 * The refusal of a change while the owner's latest message is unjudged (FR-29): the words may name a
 * new course, and only a judged re-aim decides the direction the work has to follow.
 */
function directionReason(state: JevState): string {
	const quoted = state.directionPending?.text ?? "";
	const short = quoted.length > 160 ? `${quoted.slice(0, 160)}...` : quoted;
	const next = state.task === undefined ? TRIAGE_CALL : REAIM_CALL;
	const why =
		state.task === undefined
			? "Triage is the missing prerequisite because no development task is registered. Evidence reads and jev_context stay open."
			: "A judged re-aim is the missing prerequisite. It decides whether the message continues, extends or replaces the course; earlier approvals do not carry over. Evidence reads, jev_context and xd:// coordination stay open.";
	return refusal(
		`Jevstice holds this change: the latest owner message may replace the current course ("${short}").`,
		next,
		why,
	);
}

/**
 * Refusal while availability has not granted current-request continuation (FR-21). No decision was
 * obtained, so the class is unavailable judgment, not a defect and not an approval.
 */
const JUDGE_UNAVAILABLE_REASON = refusal(
	"Jevstice holds this decision: no usable judge answer was obtained, so nothing is approved.",
	"restore judge availability and resubmit the same material unchanged; it was never judged",
	"The attempt count records the outage and is not an approval. Evidence reads, jev_context and xd:// coordination stay open.",
);

/**
 * A prior exhausted decision does not authorize a changed request. Its finding remains OPEN and
 * only materially new evidence can move the work.
 */
function openItemReason(state: JevState, boundary: string, what: string): string {
	const item = state.openItem;
	const attempts = item !== undefined && boundaryKey(item.boundary) === boundaryKey(boundary) ? item.attempts : 0;
	return refusal(
		`Jevstice holds ${what}: the ${boundary} decision is OPEN after ${attempts} refused submissions; nothing was approved.`,
		"submit materially new evidence that addresses the finding, then use recovery phase repair for an exact corrective call or phase resolve for observed correction evidence",
		state.autonomous === true
			? "Strict autonomy has no continuation override, and the spent budget never authorizes an effect. Evidence reads and jev_context stay open."
			: "A repeated submission without new evidence changes nothing. Evidence reads and jev_context stay open.",
	);
}

const REQUIREMENTS_CALL =
	`jev_requirements({"request":"<owner request>","items":[{"text":"<one checkable obligation>","source":"<request line>"}],"candidateNeeds":[],"evidence":[{"kind":"user","quote":"<request line>"}]})`;

const REQUIREMENTS_REQUIRED_REASON = refusal(
	"Jevstice holds plan preparation: the registered task has no approved requirements review.",
	REQUIREMENTS_CALL,
	"One checkable obligation per part of the owner's request is the missing prerequisite. Evidence reads and jev_context stay open; plan files and jev_plan_review remain held until requirements pass.",
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
	"Triage is the missing prerequisite. skill:// instructions, jev_context, external URL reads and non-project reads stay open.",
);

/** The boundaries the gates refuse at; each one is counted on its own (FR-28). */
const TRIAGE_BOUNDARY = "triage";
const CHECK_BOUNDARY = "course-check";
const DIRECTION_BOUNDARY = "direction";
export const PROPOSE_BOUNDARY = "propose";

/** The refusal of a proposal whose artifact could not be read back (FR-07, FR-28). */
export function planArtifactUnreadableReason(url: string): string {
	return refusal(
		`Jevstice holds this plan proposal: the artifact ${url} could not be read back.`,
		`write ${url}`,
		"A readable artifact is the missing prerequisite; the approval binds to its bytes, not to a copy. Evidence reads stay open.",
	);
}

/** The refusal of a proposal whose artifact changed after the review (FR-07, FR-28). */
export function planArtifactChangedReason(url: string): string {
	return refusal(
		`Jevstice holds this plan proposal: ${url} changed after the plan review.`,
		PLAN_CALL,
		"A fresh review of the current artifact is the missing prerequisite; the approval binds the reviewed digest, not an earlier copy. Evidence reads stay open.",
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
 * A literal shell word. Quoted text is inert, `expanded` records a value taken from a tracked
 * binding, and `dynamic` marks an expansion or syntax this parser will not follow.
 */
interface ShellWord {
	text: string;
	quoted: boolean;
	expanded: boolean;
	dynamic: boolean;
}

interface ShellWordBuffer extends ShellWord {
	content: boolean;
}

/** `null` means the binding was reassigned in a scope this parser cannot follow. */
type ShellBindings = Map<string, string | null>;

type SegmentJoin = "start" | "sequence" | "and" | "or" | "pipe" | "background" | "end";

/**
 * Output and execution options that turn an otherwise reporting program into a writer. Options are
 * per program: `grep -i` and `rg -i` only ignore case, `df --output` selects fields and `ls -o`
 * only changes the listing, while these forms write or execute. `--flag=value` and joined short
 * (`-ofile`) forms count.
 */
const PROGRAM_WRITE_OPTIONS: Record<string, Record<string, true>> = {
	git: { "--output": true, "--ext-diff": true, "--textconv": true, "--show-signature": true },
	sort: {
		"-o": true,
		"--output": true,
		"-T": true,
		"--temporary-directory": true,
		"--compress-program": true,
	},
	tree: { "-o": true },
	file: { "-C": true, "--compile": true },
	rg: { "--pre": true, "--hostname-bin": true },
};

function isProgramWriteOption(program: string, word: ShellWord): boolean {
	const options = PROGRAM_WRITE_OPTIONS[program];
	if (options === undefined) return false;
	if (options[word.text] === true) return true;
	const equals = word.text.indexOf("=");
	if (equals > 0 && options[word.text.slice(0, equals)] === true) return true;
	if (word.text.startsWith("--") || word.text.length < 2) return false;
	return options[word.text.slice(0, 2)] === true;
}

/** Skip a backtick substitution: its content is opaque, so the caller marks the word dynamic. */
function skipBacktick(command: string, start: number): number {
	let index = start + 1;
	while (index < command.length) {
		if (command[index] === "\\") {
			index += 2;
			continue;
		}
		if (command[index] === "`") return index + 1;
		index += 1;
	}
	return command.length;
}

/** Skip a `$(...)` or `$((...))` body so its operators cannot be read as the outer command. */
function skipBalancedParen(command: string, start: number): number {
	let depth = 0;
	let quote: "'" | '"' | null = null;
	let index = start;
	while (index < command.length) {
		const character = command[index] ?? "";
		if (quote === "'") {
			if (character === "'") quote = null;
			index += 1;
			continue;
		}
		if (quote === '"') {
			if (character === "\\") {
				index += 2;
				continue;
			}
			if (character === '"') quote = null;
			index += 1;
			continue;
		}
		if (character === "\\") {
			index += 2;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			index += 1;
			continue;
		}
		if (character === "`") {
			index = skipBacktick(command, index);
			continue;
		}
		if (character === "(") {
			depth += 1;
			index += 1;
			continue;
		}
		if (character === ")") {
			depth -= 1;
			index += 1;
			if (depth === 0) return index;
			continue;
		}
		index += 1;
	}
	return command.length;
}

interface ShellExpansion {
	text: string;
	dynamic: boolean;
	next: number;
}

function bindingExpansion(name: string, bindings: ShellBindings, quoted: boolean, next: number): ShellExpansion {
	const value = bindings.get(name);
	if (value === undefined || value === null) return { text: "", dynamic: true, next };
	// Unquoted expansion word-splits and globs, so an option or argument can change shape.
	if (quoted) return { text: value, dynamic: false, next };
	const unsafe = /\s/.test(value) || value.includes("*") || value.includes("?") || value.includes("[");
	return { text: value, dynamic: unsafe, next };
}

/**
 * Resolve one `$` form. Only a plain `$NAME` or `${NAME}` naming a literal binding is followed;
 * command substitution, arithmetic, special parameters and every braced modifier stay dynamic.
 */
function expandShellVariable(command: string, start: number, bindings: ShellBindings, quoted: boolean): ShellExpansion {
	const following = command[start + 1];
	if (following === "(") return { text: "", dynamic: true, next: skipBalancedParen(command, start + 1) };
	if (following === "{") {
		const close = command.indexOf("}", start + 2);
		if (close < 0) return { text: "", dynamic: true, next: command.length };
		const name = command.slice(start + 2, close);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { text: "", dynamic: true, next: close + 1 };
		return bindingExpansion(name, bindings, quoted, close + 1);
	}
	if (following !== undefined) {
		// ANSI-C `$'...'` and locale `$"..."` quoting are expansions this parser does not follow.
		if (following === "'" || following === '"') return { text: "", dynamic: true, next: start + 1 };
		const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(command.slice(start + 1))?.[0];
		if (name !== undefined) return bindingExpansion(name, bindings, quoted, start + 1 + name.length);
		if (following === "[") return { text: "", dynamic: true, next: start + 2 };
		if (/^[0-9?@*#$!_-]/.test(following)) {
			let end = start + 1;
			while (end < command.length && /[0-9]/.test(command[end] ?? "")) end += 1;
			if (end === start + 1) end += 1;
			return { text: "", dynamic: true, next: end };
		}
	}
	return { text: "$", dynamic: false, next: start + 1 };
}

function gitCommandEffects(args: readonly ShellWord[]): number {
	const subcommand = args[0];
	if (subcommand === undefined || subcommand.dynamic || subcommand.expanded) return SHELL_TREE_CHANGE;
	const effects = GIT_SUBCOMMAND_EFFECTS[subcommand.text] ?? SHELL_TREE_CHANGE;
	if (effects === SHELL_TREE_CHANGE) return effects;
	return args.some(argument => isProgramWriteOption("git", argument)) ? effects | SHELL_TREE_CHANGE : effects;
}

/**
 * One literal segment. Leading assignments are prefix effects for a command and only an environment
 * change on their own. A binding persists only across an unconditional `;`/newline (or into a
 * command after `&`) and never out of a pipeline or a conditional branch, so a skipped reassignment
 * leaves the name unknown instead of hiding a write flag.
 */
function commandSegmentEffects(
	words: readonly ShellWord[],
	join: SegmentJoin,
	nextJoin: SegmentJoin,
	bindings: ShellBindings,
): number {
	let index = 0;
	let prefix = 0;
	const assignments: Array<{ name: string; value: string | null }> = [];
	while (index < words.length) {
		const word = words[index];
		if (word === undefined) break;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word.text);
		if (match === null) break;
		prefix = SHELL_NON_TREE_CHANGE;
		assignments.push({ name: match[1] ?? "", value: word.dynamic ? null : (match[2] ?? "") });
		index += 1;
	}
	if (index === words.length) {
		const persists =
			(join === "start" || join === "sequence" || join === "background") &&
			nextJoin !== "pipe" &&
			nextJoin !== "background";
		for (const assignment of assignments) bindings.set(assignment.name, persists ? assignment.value : null);
		// A dynamic assignment value may be command substitution, so it can execute even alone.
		return assignments.some(assignment => assignment.value === null) ? prefix | SHELL_TREE_CHANGE : prefix;
	}
	const program = words[index];
	if (program === undefined) return prefix;
	const args = words.slice(index + 1);
	if (assignments.some(assignment => assignment.value === null)) prefix |= SHELL_TREE_CHANGE;
	// A quoted, expanded or absolute program name is not a statically known reporting binary.
	if (program.dynamic || program.expanded || program.quoted || program.text.length === 0 || program.text.includes("/")) {
		return prefix | SHELL_TREE_CHANGE;
	}
	if (args.some(argument => argument.dynamic)) return prefix | SHELL_TREE_CHANGE;
	if (program.text === "git") return prefix | gitCommandEffects(args);
	if (NON_MUTATING_PROGRAMS[program.text] !== true) return prefix | SHELL_TREE_CHANGE;
	return prefix | (args.some(argument => isProgramWriteOption(program.text, argument)) ? SHELL_TREE_CHANGE : 0);
}

/**
 * One conservative literal parser serves both domains; opaque payloads still require full judgment
 * (FR-31). Quotes and backslash escapes are read literally, `;`, newlines, `&&`, `||` and `|` split
 * segments outside quotes, and literal `NAME=value` assignments are followed for `$NAME`/`${NAME}`.
 * Command substitution, process or arithmetic syntax, real redirections, background operators,
 * unknown expansions, quoted or expanded programs and unsupported syntax stay consequential.
 */
function commandEffects(command: string): number {
	const bindings: ShellBindings = new Map();
	let effects = 0;
	let words: ShellWord[] = [];
	let word: ShellWordBuffer = { text: "", quoted: false, expanded: false, dynamic: false, content: false };
	let quote: "'" | '"' | null = null;
	let unsafe = false;
	let join: SegmentJoin = "start";
	let index = 0;

	const flushWord = (): void => {
		if (word.content || word.text.length > 0) {
			words.push({ text: word.text, quoted: word.quoted, expanded: word.expanded, dynamic: word.dynamic });
		}
		word = { text: "", quoted: false, expanded: false, dynamic: false, content: false };
	};
	const flushSegment = (nextJoin: SegmentJoin): void => {
		flushWord();
		if (unsafe) effects |= SHELL_TREE_CHANGE;
		effects |= commandSegmentEffects(words, join, nextJoin, bindings);
		words = [];
		unsafe = false;
		join = nextJoin;
	};

	while (index < command.length) {
		const character = command[index] ?? "";
		if (quote === "'") {
			if (character === "'") quote = null;
			else word.text += character;
			index += 1;
			continue;
		}
		if (quote === '"') {
			if (character === '"') {
				quote = null;
				index += 1;
				continue;
			}
			if (character === "\\") {
				const escaped = command[index + 1];
				if (escaped === undefined) word.dynamic = true;
				else if (escaped === "\n") index += 1;
				else if (escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\") {
					word.text += escaped;
					word.content = true;
					index += 1;
				} else {
					word.text += "\\";
					word.content = true;
				}
				index += 1;
				continue;
			}
			if (character === "`") {
				word.dynamic = true;
				word.expanded = true;
				word.content = true;
				index = skipBacktick(command, index);
				continue;
			}
			if (character === "$") {
				const expansion = expandShellVariable(command, index, bindings, true);
				word.text += expansion.text;
				word.expanded = true;
				word.content = true;
				word.dynamic ||= expansion.dynamic;
				index = expansion.next;
				continue;
			}
			word.text += character;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			word.quoted = true;
			word.content = true;
			index += 1;
			continue;
		}
		if (character === "\\") {
			const escaped = command[index + 1];
			if (escaped === undefined) {
				unsafe = true;
				index += 1;
				continue;
			}
			if (escaped === "\n") {
				index += 2;
				continue;
			}
			word.text += escaped;
			word.content = true;
			index += 2;
			continue;
		}
		if (character === "`") {
			word.dynamic = true;
			word.expanded = true;
			word.content = true;
			index = skipBacktick(command, index);
			continue;
		}
		if (character === "$") {
			const expansion = expandShellVariable(command, index, bindings, false);
			word.text += expansion.text;
			word.expanded = true;
			word.content = true;
			word.dynamic ||= expansion.dynamic;
			index = expansion.next;
			continue;
		}
		if (character === "<" || character === ">") {
			flushWord();
			unsafe = true;
			index += 1;
			continue;
		}
		if (character === "&") {
			flushWord();
			if (command[index + 1] === "&") {
				flushSegment("and");
				index += 2;
			} else {
				unsafe = true;
				flushSegment("background");
				index += 1;
			}
			continue;
		}
		if (character === "|") {
			flushWord();
			if (command[index + 1] === "|") {
				flushSegment("or");
				index += 2;
			} else {
				flushSegment("pipe");
				index += 1;
			}
			continue;
		}
		if (character === ";" || character === "\n") {
			flushWord();
			flushSegment("sequence");
			index += 1;
			continue;
		}
		if (character === "(" || character === ")" || character === "{" || character === "}") {
			flushWord();
			unsafe = true;
			index += 1;
			continue;
		}
		if (character === "#" && !word.content) {
			const newline = command.indexOf("\n", index);
			index = newline < 0 ? command.length : newline;
			continue;
		}
		if (/\s/.test(character)) {
			flushWord();
			index += 1;
			continue;
		}
		word.text += character;
		word.content = true;
		index += 1;
	}
	if (quote !== null) unsafe = true;
	flushSegment("end");
	return effects;
}

/** Ordinary working-tree policy deliberately exempts repository metadata and publication (FR-31). */
export function isNonMutatingCommand(command: string): boolean {
	return (commandEffects(command) & SHELL_TREE_CHANGE) === 0;
}

/** Strict observation excludes publication, repository changes and unproved environment effects. */
export function isReadOnlyCommand(command: string): boolean {
	return commandEffects(command) === 0;
}

/** Recognized literal publication; opaque/mixed executable effects still need the full authority judgment. */
export function isPublishingCommand(command: string): boolean {
	return (commandEffects(command) & SHELL_PUBLICATION) !== 0;
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
	const isNonProjectRead =
		toolName === "read" &&
		path !== undefined &&
		(!isProjectTarget(path) || path.startsWith("skill://") || EXTERNAL_READ_SCHEMES[schemeOf(path) ?? ""] === true);
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
 * A caller may strengthen the normal working-tree classification for a stricter effect policy.
 */
export function mutationGate(
	state: JevState,
	config: JevConfig,
	toolName: string,
	input: unknown,
	forceConsequential?: true,
): GateVerdict {
	if (!config.gates.mutation && state.autonomous !== true) return { block: false };
	if (continuationAllowed(state)) return { block: false };
	if (forceConsequential !== true && !isConsequentialMutation(toolName, input)) return { block: false };
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
				"wait for the course check message, then retry the change",
				"The check owns the revision it started on; evidence reads stay open.",
			),
		};
	}
	// A supported repair opens only its exact payload; the rest of the finding stays held.
	if (state.hold !== undefined && permittedRepair(state, toolName, input) === undefined) {
		return {
			block: true,
			boundary: HOLD_BOUNDARY,
			reason: boundaryExhausted(state, HOLD_BOUNDARY)
				? `${recoveryFeedback(state)}\n${openItemReason(state, HOLD_BOUNDARY, "this change")}`
				: recoveryFeedback(state),
		};
	}
	// Only a request that entered the judged workflow opens the gate by itself: triage either confirms
	// a simple task or registers the development task whose plan review the next change waits for. A
	// request read as a publication or an inspection never asks the judge anything (FR-30); the
	// controller still judges each consequential candidate on its own payload before it runs.
	if (state.task === undefined) {
		if (state.autonomous !== true && boundaryExhausted(state, TRIAGE_BOUNDARY)) {
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
	// An approved plan opens the gate even after its refusal budget was spent: the budget records
	// the OPEN finding, and a corrected plan that passes is the recovery that resolves it.
	if (state.plan !== undefined && state.plan.taskFingerprint === state.task.fingerprint) return { block: false };
	if (state.autonomous !== true && boundaryExhausted(state, PLAN_BOUNDARY)) {
		return { block: true, boundary: PLAN_BOUNDARY, reason: openItemReason(state, PLAN_BOUNDARY, "this change") };
	}
	return { block: true, boundary: PLAN_BOUNDARY, reason: PLAN_REQUIRED_REASON };
}

/**
 * Decision-state submissions that cannot replace an unrelated finding. Corrective requirement and
 * plan reviews remain open, as does a fresh submission to the exact failed review.
 */
const HELD_JUDGE_TOOLS: Record<string, true> = {
	jev_triage: true,
	jev_reaim: true,
	jev_review: true,
	jev_text_review: true,
	jev_anti_slop: true,
	jev_acceptance: true,
};

/** Diagnostics, source lookup and corrective planning do not execute project effects. */
const RECOVERY_PERMITTED_TOOLS: Record<string, true> = {
	jev_consult: true,
	jev_context: true,
	jev_course_check: true,
	jev_requirements: true,
	jev_plan_review: true,
};

/**
 * A finding holds normal effects. Its exact approved repair may pass to the remaining gates;
 * evidence, diagnosis, corrective planning and the failed review remain available.
 */
export function recoveryGate(state: JevState, toolName: string, input: unknown): GateVerdict {
	if (state.hold === undefined || permittedRepair(state, toolName, input) !== undefined) return { block: false };
	if (RECOVERY_PERMITTED_TOOLS[toolName] === true) return { block: false };
	if (state.hold.boundary === toolName || (toolName === "jev_reaim" && state.directionPending !== undefined)) return { block: false };
	// An inconclusive action preflight proved no defect and executed nothing. Its own refusal text
	// tells the executor to resubmit a clearer invocation, and its revision-scoped boundary can never
	// equal a tool name, so without this the finding is unremovable. The corrected call still faces
	// the full action judgment below, and a fresh refusal holds it again.
	const preflight = state.hold.boundary === "action" || state.hold.boundary?.startsWith("action:");
	if (preflight && asRecord(state.hold.result)?.["kind"] === "unclear" && HELD_JUDGE_TOOLS[toolName] !== true) {
		return { block: false };
	}
	if (HELD_JUDGE_TOOLS[toolName] === true) {
		return { block: true, boundary: HOLD_BOUNDARY, reason: recoveryFeedback(state) };
	}
	if (!isConsequentialMutation(toolName, input)) return { block: false };
	return { block: true, boundary: HOLD_BOUNDARY, reason: recoveryFeedback(state) };
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
				"Jevstice holds this plan proposal: the submitted text carries no usable plan slug. Next call: write the slug itself (for example, coverage-report) to xd://propose; it becomes local://<slug>-plan.md. Evidence reads stay open.",
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
				`Jevstice holds this plan proposal: no plan review has passed for ${url}.`,
				PLAN_CALL,
				`The review binds ${url} to the current task and is the missing prerequisite. Evidence reads and jev_context stay open.`,
			),
		};
	}
	if (state.task === undefined || state.plan.taskFingerprint !== state.task.fingerprint) {
		return {
			block: true,
			boundary: PLAN_BOUNDARY,
			reason: `Jevstice holds this plan proposal: the recorded plan approval belongs to a different task (${state.plan.planUrl}). Next call: review ${url} for the current task. Evidence reads stay open.`,
		};
	}
	if (state.plan.planUrl !== url) {
		return {
			block: true,
			boundary: PLAN_BOUNDARY,
			reason: `Jevstice holds this plan proposal: the approved plan is ${state.plan.planUrl}, not ${url}. Next call: review ${url} or propose the approved artifact. Evidence reads stay open.`,
		};
	}
	if (state.directionPending !== undefined) {
		return { block: true, boundary: DIRECTION_BOUNDARY, reason: directionReason(state) };
	}
	return { block: false, url };
}

/** The completion boundary's decision: whether the extension holds this stop, and why. */
interface CompletionGate {
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
	if (!config.gates.completion && state.autonomous !== true) return { applies: false };
	if (continuationAllowed(state)) return { applies: false };
	if (state.autonomous === true && state.task === undefined) {
		return {
			applies: true,
			reason:
				"Jevstice holds strict autonomous completion: no bound registered objective is recorded. Next call: register the objective at triage, then supply current execution evidence. Evidence reads stay open.",
		};
	}
	if (state.task === undefined) {
		if (state.simple?.external === true && config.antiSlop.mode === "enforce") {
			const scope = antiSlopScope(state);
			if (scope !== undefined) {
				const status = antiSlopStatus(state, scope);
				if (!status.complete) return { applies: true, reason: antiSlopReason(state, status) };
			}
		}
		return { applies: false };
	}
	if (state.revision === 0 && state.autonomous !== true) return { applies: false };
	// Permission is checked above; without it, unavailable judgment cannot approve completion.
	if (state.judgeUnavailable === true) return { applies: true, reason: JUDGE_UNAVAILABLE_REASON };
	// The course check in flight owns the revision it started on: wait for its verdict first.
	if (state.checkPending !== undefined) {
		return {
			applies: true,
			reason: refusal(
				"Jevstice holds this completion: a course check is in flight and its verdict is not in yet.",
				"wait for the course check message, then stop again",
				"A stop before the verdict would settle work the check has not seen; evidence reads stay open.",
			),
		};
	}
	if (state.hold !== undefined) {
		return {
			applies: true,
			reason: boundaryExhausted(state, HOLD_BOUNDARY)
				? `${recoveryFeedback(state)}\n${openItemReason(state, HOLD_BOUNDARY, "this completion")}`
				: recoveryFeedback(state),
		};
	}
	// The owner's latest message is unjudged: completion would report on a direction no longer known.
	if (state.directionPending !== undefined) return { applies: true, reason: directionReason(state) };
	if (config.antiSlop.mode === "enforce") {
		const scope = antiSlopScope(state);
		if (scope !== undefined && !scope.quiet) {
			const status = antiSlopStatus(state, scope);
			if (!status.complete) return { applies: true, reason: antiSlopReason(state, status) };
		}
	}
	const missing = (["business", "architecture"] as const).filter(aspect => acceptanceAt(state, aspect)?.approved !== true);
	const spent = state.autonomous === true ? undefined : missing.find(aspect => boundaryExhausted(state, `acceptance:${aspect}`));
	if (spent !== undefined) {
		return {
			applies: true,
			reason: openItemReason(state, `acceptance:${spent}`, "this completion"),
		};
	}
	if (missing.length > 0) {
		const aspect = missing[0] ?? "business";
		return {
			applies: true,
			reason: refusal(
				`Jevstice holds this completion: acceptance has not passed for ${missing.join(" and ")} at the current revision (${state.revision} consequential changes).`,
				ACCEPTANCE_CALL(aspect),
				`Acceptance for ${missing.join(" and ")} is the missing prerequisite; any later change invalidates an approval. Evidence reads stay open.`,
			),
		};
	}
	return { applies: true };
}
