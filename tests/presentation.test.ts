import { describe, expect, test } from "bun:test";
import {
	messagePresentation,
	outcomeSummary,
	toolPresentation,
	type DisplayComponent,
	type PresentationTheme,
	type RenderOptions,
	type ToolPresentation,
} from "../src/presentation.js";

interface Host {
	api: { pi: { Text: new (text?: string, paddingX?: number, paddingY?: number) => DisplayComponent } };
	texts: string[];
}

/** A native Text stand-in that records the text handed to the host component. */
function host(): Host {
	const texts: string[] = [];
	class Text implements DisplayComponent {
		#text: string;
		constructor(text = "") {
			this.#text = text;
			texts.push(text);
		}
		render(): readonly string[] {
			return this.#text.length === 0 ? [] : [this.#text];
		}
		invalidate(): void {
			// Nothing is cached.
		}
	}
	return { api: { pi: { Text } }, texts };
}

interface ThemeProbe {
	theme: PresentationTheme;
	colors: string[];
	symbols: string[];
}

function themeProbe(): ThemeProbe {
	const colors: string[] = [];
	const symbols: string[] = [];
	return {
		colors,
		symbols,
		theme: {
			fg(color, text) {
				colors.push(color);
				return text;
			},
			bold: text => text,
			symbol(key) {
				symbols.push(key);
				return "*";
			},
		},
	};
}

function rendered(component: DisplayComponent | undefined, width = 100): string {
	return component?.render(width).join("\n") ?? "";
}

function result(details: Record<string, unknown>, text = "FULL DIAGNOSTIC", isError = false): unknown {
	return { content: [{ type: "text", text }], details, isError };
}

function compact(presentation: ToolPresentation, shown: unknown, options: RenderOptions = { expanded: false }, args?: unknown): string {
	return rendered(presentation.renderResult?.(shown, options, undefined, args));
}

describe("compact tool presentation", () => {
	test("merges the call into the result row when the host supports it", () => {
		const { api } = host();
		const presentation = toolPresentation(api, "Jev acceptance");
		expect(presentation.mergeCallAndResult).toBe(true);
		const line = compact(presentation, result({ aspect: "business", approved: true, verdict: "met", confidence: 0.91, basis: "Execution and code evidence support the claim." }));
		expect(line).toContain("Jev acceptance");
		expect(line).toContain("business");
		expect(line).toContain("Execution and code evidence");
		expect(line).toContain("Passed");
		expect(line.split("\n")).toHaveLength(1);
	});

	test("shows a stage or target without echoing arbitrary arguments", () => {
		const { api } = host();
		const presentation = toolPresentation(api, "Jev context");
		const call = rendered(presentation.renderCall?.({ artifact: "PRIVATE LONG INPUT" }, { expanded: false }));
		expect(call).toContain("Jev context");
		expect(call).toContain("Checking");
		expect(call).not.toContain("PRIVATE");
	});

	test("uses a short target for review, plan and consult results", () => {
		const { api } = host();
		const review = toolPresentation(api, "Jev developer review");
		const reviewLine = compact(review, result({ reviewKind: "diff", target: "src/export.ts", verdict: "defect", approved: false, confidence: 0.82 }));
		expect(reviewLine).toContain("diff");
		expect(reviewLine).toContain("src/export.ts");
		expect(reviewLine).toContain("defect");
		expect(reviewLine).toContain("Findings");

		const plan = toolPresentation(api, "Jev plan review");
		const planLine = compact(plan, result({ phase: "detail", step: "s2", verdict: "revise", approved: false, confidence: 0.4 }));
		expect(planLine).toContain("detail");
		expect(planLine).toContain("s2");
		expect(planLine).toContain("revise");

		const consult = toolPresentation(api, "Jev consult");
		const consultLine = compact(consult, result({ mode: "choice", label: "stdout", confidence: 0.9 }));
		expect(consultLine).toContain("choice");
		expect(consultLine).toContain("stdout");
	});

	test("keeps distinct plain verdicts for every outcome class", () => {
		const { api } = host();
		const presentation = toolPresentation(api, "Jev developer review");
		const cases: Array<[Record<string, unknown>, boolean, string]> = [
			[{}, false, "Complete"],
			[{ approved: true }, false, "Passed"],
			[{ warnings: 2, blockers: 0 }, false, "Warnings"],
			[{ approved: false }, false, "Findings"],
			[{ kind: "unclear" }, false, "Inconclusive"],
			[{ kind: "unavailable" }, false, "Unavailable"],
			[{ prerequisite: true }, false, "Not checked"],
			[{ kind: "stale" }, false, "Outdated"],
			[{ kind: "invalid" }, true, "Invalid input"],
			[{ enabled: false, skipped: true }, false, "Off"],
		];
		for (const [details, isError, label] of cases) {
			const line = compact(presentation, result(details, "FULL DIAGNOSTIC", isError));
			expect(line).toContain(label);
		}
	});

	test("outcomeSummary stays plain and classifies warnings separately", () => {
		expect(outcomeSummary({ ok: true, text: "", details: { approved: true } })).toBe("Passed");
		expect(outcomeSummary({ ok: true, text: "", details: {} })).toBe("Complete");
		expect(outcomeSummary({ ok: true, text: "", details: { warnings: 1, blockers: 0 } })).toBe("Warnings");
		expect(outcomeSummary({ ok: false, text: "", details: { kind: "unclear" } })).toBe("Inconclusive");
		expect(outcomeSummary({ ok: false, text: "", details: { kind: "unavailable" } })).toBe("Unavailable");
		expect(outcomeSummary({ ok: true, text: "", details: { prerequisite: true } })).toBe("Not checked");
	});

	test("clips and sanitizes only the caption, preserving the full payload on expand", () => {
		const { api, texts } = host();
		const presentation = toolPresentation(api, "Jev text review");
		const payload = "A long paragraph. ".repeat(400) + "PAYLOAD END";
		const caption = `\u001b[31mred\u001b[0m\ncaption `.repeat(80);
		const shown = result({ defects: 2, fragments: 3, rules: 1, presentation: { reason: caption } }, payload);
		const line = compact(presentation, shown, { expanded: false });
		expect(line).not.toContain("\u001b");
		expect(line).not.toContain("\n");
		expect(line).toContain("red caption");
		const expanded = compact(presentation, shown, { expanded: true });
		expect(expanded).toBe(payload);
		expect(texts.at(-1)).toBe(payload);
	});

	test("keeps one clipped row at a narrow width", () => {
		const { api } = host();
		const presentation = toolPresentation(api, "Jev developer review");
		const shown = result({
			reviewKind: "diff",
			target: "src/a/very/long/path/that/needs/truncation.ts",
			verdict: "sound",
			confidence: 0.9,
			presentation: { reason: "A detailed explanation that would not fit in a narrow transcript row at all." },
		});
		const line = rendered(presentation.renderResult?.(shown, { expanded: false }), 80);
		expect(line.split("\n")).toHaveLength(1);
		expect([...line].length).toBeLessThanOrEqual(80);
		expect(line).toContain("Complete");
		expect(line).not.toContain("that would not fit");
	});

	test("passes the host theme and reports the semantic verdict colour", () => {
		const { api } = host();
		const probe = themeProbe();
		const presentation = toolPresentation(api, "Jev acceptance");
		const line = rendered(presentation.renderResult?.(result({ aspect: "business", approved: true }), { expanded: false }, probe.theme));
		expect(line).toContain("Passed");
		expect(probe.colors).toContain("toolTitle");
		expect(probe.colors).toContain("success");
		expect(probe.symbols).toContain("status.success");
	});

	test("accepts the mounted xd result shape and the fourth args argument", () => {
		const { api } = host();
		const presentation = toolPresentation(api, "Jev developer review");
		const shown = {
			content: [{ type: "text", text: "Mounted payload" }],
			details: { reviewKind: "commit", target: "HEAD", verdict: "sound", approved: true, confidence: 0.95 },
			isError: false,
		};
		const line = compact(presentation, shown, { expanded: false }, { kind: "commit", target: "HEAD", __partialJson: "{\"kind\":" });
		expect(line).toContain("commit");
		expect(line).toContain("HEAD");
		expect(line).toContain("sound");
		expect(line).not.toContain("__partialJson");
	});

	test("returns no renderers when the host has no Text component", () => {
		expect(toolPresentation({}, "Jev review")).toEqual({});
		expect(messagePresentation({})).toBeUndefined();
	});
});

describe("native describe hooks", () => {
	test("describe the compact head and keep the full body for expansion", () => {
		const { api } = host();
		const presentation = toolPresentation(api, "Jev acceptance");
		const full = "First line.\nSecond line.";
		const view = presentation.describeResult?.(result({ aspect: "business", approved: false, basis: "Unmet evidence." }, full), { expanded: false });
		expect(view?.head).toContainEqual({ t: "Jev acceptance", s: "toolTitle" });
		expect(view?.head).toContainEqual({ t: "Findings", s: "error" });
		expect(view?.tone).toBe("error");
		expect(view?.preview).toEqual({ lines: 4 });
		const body = view?.body?.[0];
		expect(body?.p.text).toBe(full);
		const opened = presentation.describeResult?.(result({ approved: true }, full), { expanded: true });
		expect(opened?.open).toBe(true);
	});

	test("describeCall says Checking without a payload body", () => {
		const { api } = host();
		const presentation = toolPresentation(api, "Jev context");
		const view = presentation.describeCall?.({ action: "list" }, { expanded: false });
		expect(view?.head).toContainEqual({ t: "Jev context", s: "toolTitle" });
		expect(view?.head).toContainEqual({ t: "Checking", s: "accent" });
		expect(view?.body).toBeUndefined();
		expect(view?.preview).toBe("none");
	});
});

describe("custom message presentation", () => {
	test("collapses to the summary and expands to the full model text", () => {
		const { api } = host();
		const renderer = messagePresentation(api);
		expect(renderer).toBeDefined();
		const content = "Full diagnostic details that only appear when expanded.";
		const message = { content, details: { summary: "Jev \u00b7 On\nWork: none" } };
		expect(rendered(renderer?.(message, { expanded: false }))).toBe("Jev \u00b7 On\nWork: none");
		expect(rendered(renderer?.(message, { expanded: true }))).toBe(content);
	});

	test("strips control sequences from the summary only", () => {
		const { api } = host();
		const renderer = messagePresentation(api);
		const message = { content: "PAYLOAD \u001b[31mkept", details: { summary: "\u001b[31mJev \u00b7 Off\u001b[0m" } };
		const summary = rendered(renderer?.(message, { expanded: false }));
		expect(summary).toBe("Jev \u00b7 Off");
		expect(rendered(renderer?.(message, { expanded: true }))).toBe("PAYLOAD \u001b[31mkept");
	});
});
