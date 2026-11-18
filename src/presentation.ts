/**
 * Native OMP presentation for Jev diagnostics.
 *
 * The call heading and verdict draw as one compact native row; the model/tool payload is never
 * changed. The host injects its Text component and Theme, so this module has no TUI dependency.
 * `mergeCallAndResult` lets omp drop the call row once a result exists, and the semantic
 * `describeCall`/`describeResult` hooks cover native (TSP) terminals. Both the direct tool path and
 * the mounted `write xd://...` delegation pass the real arguments and read the same flag.
 */
import { diagnosticKind } from "./state.js";
import { asRecord, type ToolOutcome } from "./types.js";

/** A host-rendered component: only the native surface this module uses. */
export interface DisplayComponent {
	render(width: number): readonly string[];
	invalidate(): void;
}

/** The render options OMP passes to tool renderers. */
export interface RenderOptions {
	expanded: boolean;
	isPartial?: boolean;
	spinnerFrame?: number;
	argsComplete?: boolean;
	executionStarted?: boolean;
}

/** The host theme surface; optional so presentation degrades to plain text. */
export interface PresentationTheme {
	fg?(color: string, text: string): string;
	bold?(text: string): string;
	faint?(text: string): string;
	symbol?(key: string): string;
	styledSymbol?(key: string, color: string): string;
}

/** The part of the omp ExtensionAPI used by presentation. */
export interface PresentationApi {
	pi?: {
		Text?: new (text?: string, paddingX?: number, paddingY?: number) => DisplayComponent;
	};
}

/** One span of a native (TSP) head. `s` is a theme colour name. */
export interface NativeTextSpan {
	t: string;
	s?: string;
}

export type NativeText = string | readonly NativeTextSpan[];

/** One plain text node in a native tool body. */
export interface NativeTextNode {
	k: "text";
	p: { text: string; wrap: "word" };
}

/** The native tool view OMP's TSP terminals understand, restricted to what this module builds. */
export interface NativeToolView {
	head?: NativeText;
	body?: readonly NativeTextNode[];
	tone?: "neutral" | "accent" | "info" | "success" | "warning" | "error" | "pending" | "muted" | "user";
	preview?: "none" | { lines: number };
	open?: boolean;
}

/** Native tool presentation for one Jev tool. */
export interface ToolPresentation {
	renderCall?(args: unknown, options: RenderOptions, theme?: PresentationTheme): DisplayComponent;
	renderResult?(result: unknown, options: RenderOptions, theme?: PresentationTheme, args?: unknown): DisplayComponent;
	mergeCallAndResult?: true;
	describeCall?(args: unknown, options: RenderOptions): NativeToolView;
	describeResult?(result: unknown, options: RenderOptions, args?: unknown): NativeToolView;
}

/** A custom-message renderer in the shape `registerMessageRenderer` expects. */
export type MessagePresentationRenderer = (
	message: unknown,
	options: RenderOptions,
	theme?: PresentationTheme,
) => DisplayComponent | undefined;

type DisplayTone = "success" | "warning" | "error" | "info" | "muted";

interface Verdict {
	label: string;
	tone: DisplayTone;
	symbol: string;
}

interface RowParts {
	label: string;
	target?: string;
	reason?: string;
	verdict: Verdict;
}

const SEP = " \u00b7 ";
const MAX_TARGET_CHARS = 32;
const MAX_REASON_CHARS = 120;
const MIN_REASON_WIDTH = 16;
const PREVIEW_LINES = 4;
const CHECKING: Verdict = { label: "Checking", tone: "info", symbol: "status.running" };

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function sanitize(value: string): string {
	return value.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** Keep line structure for message summaries while stripping control sequences. */
function sanitizeBlock(value: string): string {
	return value.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "")
		.split("\n").slice(0, 12).map(line => clip(line.trimEnd(), 200)).join("\n").trim();
}

function clip(value: string, limit: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= limit) return trimmed;
	const chars = [...trimmed];
	if (chars.length <= limit) return trimmed;
	return limit <= 3 ? chars.slice(0, Math.max(0, limit)).join("") : `${chars.slice(0, limit - 3).join("")}...`;
}

function caption(value: unknown, limit = MAX_REASON_CHARS): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = sanitize(value);
	return clean.length === 0 ? undefined : clip(clean, limit);
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function plural(value: unknown, noun: string): string | undefined {
	const count = Array.isArray(value) ? value.length : numberOf(value);
	return count !== undefined && count > 0 ? `${count} ${noun}${count === 1 ? "" : "s"}` : undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		const single = asRecord(content)?.["text"];
		return typeof single === "string" ? single : "";
	}
	return content.map(block => typeof block === "string" ? block : (asRecord(block)?.["text"] ?? "")).join("\n");
}

function resultRecord(result: unknown): { details: Record<string, unknown>; full: string; isError: boolean } {
	const record = asRecord(result);
	return {
		details: asRecord(record?.["details"]) ?? {},
		full: contentText(record?.["content"]),
		isError: record?.["isError"] === true,
	};
}

/** Presentation-only overrides callers may attach as `details.presentation`. */
function overrideOf(details: Record<string, unknown>): { stage?: string; target?: string; reason?: string } {
	const source = asRecord(details["presentation"]);
	return source === undefined ? {} : {
		stage: caption(source["stage"], 80),
		target: caption(source["target"], MAX_TARGET_CHARS),
		reason: caption(source["reason"], MAX_REASON_CHARS),
	};
}

function verdictOf(outcome: ToolOutcome, partial: boolean): Verdict {
	if (partial) return CHECKING;
	const details = asRecord(outcome.details) ?? {};
	if (details["enabled"] === false) return { label: "Off", tone: "muted", symbol: "status.disabled" };
	if (details["kind"] === "invalid" && details["prerequisite"] === undefined) {
		return { label: "Invalid input", tone: "warning", symbol: "status.warning" };
	}
	if (details["kind"] === "stale") return { label: "Outdated", tone: "warning", symbol: "status.warning" };
	const kind = diagnosticKind(outcome);
	const warnings = numberOf(details["warnings"]) ?? 0;
	if (kind === "passed" && warnings > 0 && (numberOf(details["blockers"]) ?? 0) === 0) {
		return { label: "Warnings", tone: "warning", symbol: "status.warning" };
	}
	if (kind === "passed") {
		return details["approved"] === true
			? { label: "Passed", tone: "success", symbol: "status.success" }
			: { label: "Complete", tone: "success", symbol: "status.success" };
	}
	if (kind === "failed") return { label: "Findings", tone: "error", symbol: "status.error" };
	if (kind === "inconclusive") return { label: "Inconclusive", tone: "warning", symbol: "status.warning" };
	if (kind === "unavailable") return { label: "Unavailable", tone: "warning", symbol: "status.warning" };
	return { label: "Not checked", tone: "muted", symbol: "status.disabled" };
}

/** The plain verdict used in model-visible details and compact fallbacks. */
export function outcomeSummary(outcome: ToolOutcome): string {
	return verdictOf(outcome, false).label;
}

/** A short identification of what was judged; never an arbitrary payload dump. */
function targetFor(args: unknown, details: Record<string, unknown>): string | undefined {
	const override = overrideOf(details);
	if (override.target !== undefined) return override.target;
	const record = asRecord(args) ?? {};
	const reviewKind = caption(details["reviewKind"])
		?? (["checkpoint", "commit", "diff"].includes(String(details["kind"])) ? caption(details["kind"]) : undefined);
	const fields = [
		caption(details["aspect"]) ?? caption(record["aspect"]),
		reviewKind,
		caption(details["target"]) ?? caption(record["target"]),
		caption(details["phase"]) ?? caption(record["phase"]),
		caption(details["step"]),
		caption(details["mode"]) ?? caption(record["mode"]),
		caption(details["action"]) ?? caption(record["action"]),
		caption(details["sourceId"]) ?? caption(record["sourceId"]),
		caption(details["language"]) ?? caption(record["language"]),
	].filter((part): part is string => part !== undefined);
	const part = asRecord(details["part"]) ?? asRecord(record["part"]);
	const index = numberOf(part?.["index"]);
	const total = numberOf(part?.["total"]);
	if (index !== undefined && total !== undefined) fields.push(`part ${index}/${total}`);
	const counts = [
		plural(record["topics"] ?? details["topics"], "topic"),
		plural(record["items"], "item"),
		plural(record["candidates"], "candidate"),
		plural(record["rules"], "rule"),
		plural(details["fragments"], "fragment"),
	].filter((part): part is string => part !== undefined);
	fields.push(...counts);
	const revision = numberOf(details["revision"]);
	if (fields.length === 0 && revision !== undefined) fields.push(`revision ${revision}`);
	return fields.length === 0 ? undefined : clip(fields.join(SEP), MAX_TARGET_CHARS);
}

function compose(parts: readonly (string | undefined)[]): string | undefined {
	const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
	return kept.length === 0 ? undefined : clip(kept.join(SEP), MAX_REASON_CHARS);
}

function firstSentence(value: string): string | undefined {
	const flat = sanitize(value);
	if (flat.length === 0) return undefined;
	const end = flat.search(/[.!?](?:\s|$)/);
	return clip(end === -1 ? flat : flat.slice(0, end + 1), MAX_REASON_CHARS);
}

/** One useful reason line, structured details first and free text last. */
function reasonFor(outcome: ToolOutcome, details: Record<string, unknown>, full: string): string | undefined {
	const override = overrideOf(details);
	if (override.reason !== undefined) return override.reason;
	const named = caption(details["kind"]);
	if (named === "invalid" || named === "stale" || named === "unavailable" || details["prerequisite"] !== undefined || details["enabled"] === false) {
		return firstSentence(full) ?? caption(details["prerequisite"]);
	}
	const blockers = numberOf(details["blockers"]);
	const warnings = numberOf(details["warnings"]);
	if (blockers !== undefined || warnings !== undefined) {
		if ((blockers ?? 0) === 0 && (warnings ?? 0) === 0) return "no finding";
		return compose([plural(blockers, "blocker"), plural(warnings, "warning"), plural(details["claims"], "claim")]);
	}
	const defects = details["defects"];
	if (Array.isArray(defects)) {
		if (defects.length === 0) return "no finding";
		return compose([plural(defects, "defect"), plural(details["fragments"], "fragment"), plural(details["rules"], "rule")]);
	}
	if (typeof details["needsDevelopment"] === "boolean" && details["pending"] !== true) {
		const probability = numberOf(details["probability"]) ?? numberOf(details["simpleProbability"]);
		const state = details["needsDevelopment"]
			? (probability === undefined ? "development task" : `${percent(probability)} development`)
			: (probability === undefined ? "simple task" : `${percent(probability)} simple`);
		return compose([state, details["externalDeliverable"] === true ? "external deliverable" : undefined]);
	}
	const sources = Array.isArray(details["sources"]) ? details["sources"].length : undefined;
	if (sources !== undefined) {
		const findings = Array.isArray(details["findings"]) ? details["findings"].length : 0;
		const pending = Array.isArray(details["pendingEffects"]) ? details["pendingEffects"].length : 0;
		if (sources === 0 && findings === 0 && pending === 0) return "no sources";
		return compose([plural(sources, "source"), plural(findings, "finding"), plural(pending, "pending effect")]);
	}
	const title = caption(details["title"]);
	if (title !== undefined) return `selected ${title}`;
	const coverage = numberOf(details["coverage"]);
	const level = numberOf(details["level"]);
	const score = numberOf(details["score"]);
	const probability = numberOf(details["probability"]);
	const confidence = numberOf(details["confidence"]);
	const sourceKind = caption(asRecord(details["source"])?.["kind"]);
	const parts = [
		caption(details["basis"]),
		caption(details["verdict"]),
		caption(details["assessment"]),
		caption(details["label"]),
		coverage === undefined ? undefined : `${percent(coverage)} coverage`,
		plural(details["rejectedItems"], "rejected item"),
		plural(details["rejectedSteps"], "rejected step"),
		plural(details["uncoveredRequirements"], "uncovered requirement"),
		plural(details["unsettledItems"], "unsettled item"),
		plural(details["unresolvedNeeds"], "unresolved need"),
		plural(details["uncoveredNeeds"], "uncovered need"),
		plural(details["unmetSections"], "unmet section"),
		plural(details["failed"], "failed check"),
		plural(details["approvedSteps"], "step"),
		level === undefined ? undefined : `step ${level}`,
		score === undefined ? undefined : `score ${score.toFixed(2)}`,
		probability === undefined ? undefined : `yes ${percent(probability)}`,
		confidence === undefined ? undefined : `${percent(confidence)} confidence`,
		caption(details["interjection"]) === undefined ? undefined : "new direction",
		sourceKind === undefined ? undefined : `archived ${sourceKind}`,
	];
	return compose(parts) ?? firstSentence(full);
}

function toneColor(tone: DisplayTone): string {
	return tone === "info" ? "accent" : tone;
}

function style(theme: PresentationTheme | undefined, color: string, text: string): string {
	return theme?.fg?.(color, text) ?? text;
}

function bold(theme: PresentationTheme | undefined, text: string): string {
	return theme?.bold?.(text) ?? text;
}

/** One native row, clipped to the available width while the payload stays untouched. */
class CompactRow implements DisplayComponent {
	#parts: RowParts;
	#Text: new (text?: string, paddingX?: number, paddingY?: number) => DisplayComponent;
	#theme?: PresentationTheme;

	constructor(parts: RowParts, Text: new (text?: string, paddingX?: number, paddingY?: number) => DisplayComponent, theme?: PresentationTheme) {
		this.#parts = parts;
		this.#Text = Text;
		this.#theme = theme;
	}

	render(width: number): readonly string[] {
		return new this.#Text(this.#line(width), 0, 0).render(width);
	}

	invalidate(): void {
		// The row is rebuilt from its parts on every render; there is no cached state.
	}

	#line(width: number): string {
		const { label, target, reason, verdict } = this.#parts;
		const theme = this.#theme;
		const glyph = theme?.symbol?.(verdict.symbol);
		const prefixPlain = glyph === undefined || glyph.length === 0 ? "" : `${glyph} `;
		const prefix = prefixPlain.length === 0 ? "" : `${style(theme, toneColor(verdict.tone), prefixPlain.trimEnd())} `;
		const targetPlain = target === undefined ? "" : clip(target, Math.max(6, Math.min(MAX_TARGET_CHARS, Math.floor(width / 3))));
		const base = `${prefixPlain}${label}${targetPlain.length > 0 ? SEP + targetPlain : ""}${SEP}${verdict.label}`;
		const budget = width - [...base].length - SEP.length;
		const reasonPlain = reason !== undefined && budget >= MIN_REASON_WIDTH ? clip(reason, Math.min(MAX_REASON_CHARS, budget)) : "";
		return [
			prefix + style(theme, "toolTitle", bold(theme, label)),
			targetPlain.length > 0 ? style(theme, "muted", targetPlain) : "",
			reasonPlain.length > 0 ? style(theme, "dim", reasonPlain) : "",
			style(theme, toneColor(verdict.tone), bold(theme, verdict.label)),
		].filter(part => part.length > 0).join(SEP);
	}
}

function nativeHead(label: string, target: string | undefined, reason: string | undefined, verdict: Verdict): readonly NativeTextSpan[] {
	const spans: NativeTextSpan[] = [{ t: label, s: "toolTitle" }];
	if (target !== undefined) spans.push({ t: SEP, s: "muted" }, { t: target, s: "muted" });
	if (reason !== undefined) spans.push({ t: SEP, s: "dim" }, { t: reason, s: "dim" });
	spans.push({ t: SEP, s: "muted" }, { t: verdict.label, s: toneColor(verdict.tone) });
	return spans;
}

function callParts(label: string, args: unknown): RowParts {
	return { label, target: targetFor(args, {}), verdict: CHECKING };
}

function resultParts(label: string, result: unknown, options: RenderOptions, args: unknown): { parts: RowParts; full: string } {
	const { details, full, isError } = resultRecord(result);
	const outcome: ToolOutcome = { ok: !isError, text: full, details };
	return {
		full,
		parts: {
			label: overrideOf(details).stage ?? label,
			target: targetFor(args, details),
			reason: options.isPartial === true ? "in progress" : reasonFor(outcome, details, full),
			verdict: verdictOf(outcome, options.isPartial === true),
		},
	};
}

function describeResult(label: string, result: unknown, options: RenderOptions, args: unknown): NativeToolView {
	const { parts, full } = resultParts(label, result, options, args);
	const body: NativeTextNode[] = full.length > 0 ? [{ k: "text", p: { text: full, wrap: "word" } }] : [];
	return {
		head: nativeHead(parts.label, parts.target, parts.reason, parts.verdict),
		...(body.length > 0 ? { body, preview: { lines: PREVIEW_LINES } } : { preview: "none" }),
		tone: parts.verdict.tone,
		...(options.expanded ? { open: true } : {}),
	};
}

function themeOf(options: RenderOptions, theme: PresentationTheme | undefined): PresentationTheme | undefined {
	return theme ?? (typeof (options as unknown as PresentationTheme).fg === "function" ? options as unknown as PresentationTheme : undefined);
}

/** The tool presentation for one Jev tool, or `{}` when this host injects no Text component. */
export function toolPresentation(pi: PresentationApi, label: string): ToolPresentation {
	const Text = pi.pi?.Text;
	if (Text === undefined) return {};
	return {
		mergeCallAndResult: true,
		renderCall: (args, options, theme) => new CompactRow(callParts(label, args), Text, themeOf(options, theme)),
		renderResult: (result, options, theme, args) => {
			const { parts, full } = resultParts(label, result, options, args);
			return options.expanded ? new Text(full, 0, 0) : new CompactRow(parts, Text, themeOf(options, theme));
		},
		describeCall: (args): NativeToolView => ({ head: nativeHead(label, targetFor(args, {}), undefined, CHECKING), tone: CHECKING.tone, preview: "none" }),
		describeResult: (result, options, args) => describeResult(label, result, options, args),
	};
}

/** Custom messages collapse to `details.summary` and expand to the untouched model content. */
export function messagePresentation(pi: PresentationApi): MessagePresentationRenderer | undefined {
	const Text = pi.pi?.Text;
	if (Text === undefined) return undefined;
	return (message, options) => {
		const record = asRecord(message);
		const details = asRecord(record?.["details"]) ?? {};
		const summary = typeof details["summary"] === "string" ? details["summary"] : undefined;
		const full = contentText(record?.["content"]);
		return new Text(options.expanded ? full : sanitizeBlock(summary ?? "Jev \u00b7 Details"), 0, 0);
	};
}
