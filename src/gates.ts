/**
 * Deterministic effect classifiers, not gates.
 *
 * The executor's private reasoning is not observable, so this module answers only what it can see
 * from a call's shape: does this call change the working tree, does a shell command publish, does a
 * target lie outside the approved plan's paths. Every answer is a pure function of the call, and no
 * function here blocks or permits execution. Jev reports diagnostics; the host owns permissions.
 *
 * The classification fails closed. A tool, device or shell command this module does not recognise as
 * read-only is consequential, because opaque execution - `eval`, a delegated `task`, an LSP rename,
 * an unknown MCP route - reaches the working tree without naming a file. A consequential
 * classification is recorded and judged, never treated as an authorization.
 */
import { asRecord, type PlanTopic } from "./types.js";

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

export interface GateVerdict {
	block: boolean;
	reason?: string;
	/** The boundary that refused, so a refusal can be attributed when the host reports it. */
	boundary?: string;
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
 * Whether a recorded action target lies outside every path the approved plan's topics name.
 * The comparison is on the recorded target string: a target equal to a path, or under it, counts as
 * inside. Shell commands and opaque execution carry no path as their target - their own payload was
 * judged before execution - so they never count as deviations. Callers use this to disclose a
 * deviation; it blocks nothing by itself.
 */
export function targetOutsidePlan(toolName: string, target: string, topics: readonly PlanTopic[]): boolean {
	if (toolName === "bash" || toolName === "eval" || toolName === "task") return false;
	const paths = topics.flatMap(topic => topic.paths);
	if (paths.length === 0) return false;
	return !paths.some(entry => target === entry || target.startsWith(`${entry}/`) || entry.startsWith(`${target}/`));
}

