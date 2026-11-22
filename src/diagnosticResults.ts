import type { FactSource } from "./factCheck.js";
import { diagnosticKind, sha256, type DiagnosticKind } from "./state.js";
import { asRecord, type ToolOutcome } from "./types.js";

export interface EvidenceScope {
	objective: string;
	sources: Map<string, FactSource>;
}

export type VerifyObserved = (source: string, quote: string, whole?: boolean) => boolean;

export interface DiagnosticBinding {
	scope: EvidenceScope | undefined;
	objective: string | undefined;
	revision: number;
	work?: string;
	observations?: number;
	requirements?: string;
	plan?: string;
}

export interface PriorFact {
	verdict: string;
	confidence?: number;
}

interface DiagnosticResultSummary {
	id: string;
	tool: string;
	subject: string;
	revision: number;
	status: DiagnosticKind;
	applicability: "current" | "historical";
	sources: string[];
	reason?: string;
	prior: readonly string[];
}

export interface DiagnosticResults {
	begin(binding: DiagnosticBinding): {
		observe(source: string): FactSource | undefined;
		verify: VerifyObserved;
		priorFact(artifact: string, claim: string): PriorFact | undefined;
		issueBaseline(id: string, phase: "understand" | "develop", subject: string): { details: Record<string, unknown>; observations: number } | undefined;
		link(tool: "jev_requirements" | "jev_plan_review"): void;
		stillCurrent(active: DiagnosticBinding): boolean;
		record(tool: string, subject: string, input: unknown, result: ToolOutcome, active?: DiagnosticBinding): string;
	};
	list(binding: DiagnosticBinding): DiagnosticResultSummary[];
	read(id: string, binding: DiagnosticBinding): (DiagnosticResultSummary & { input: unknown; result: ToolOutcome }) | undefined;
}

interface DiagnosticResult {
	id: string;
	tool: string;
	subject: string;
	binding: DiagnosticBinding;
	sources: ReadonlyMap<string, string>;
	prior: readonly string[];
	input: unknown;
	result: ToolOutcome;
}

const digestOf = (source: FactSource | undefined): string => source === undefined
	? "absent" : sha256(`${source.kind}\0${source.whole === true ? "whole" : "excerpt"}\0${source.text}`);

export function createDiagnosticResults(): DiagnosticResults {
	const rows: DiagnosticResult[] = [];
	const sameScope = (row: DiagnosticResult, binding: DiagnosticBinding): boolean =>
		row.binding.scope === binding.scope && row.binding.objective === binding.objective;
	const sourcesCurrent = (row: DiagnosticResult, binding: DiagnosticBinding): boolean => {
		for (const [source, digest] of row.sources) if (digestOf(binding.scope?.sources.get(source)) !== digest) return false;
		return true;
	};
	const current = (row: DiagnosticResult, binding: DiagnosticBinding): boolean => {
		if (!sameScope(row, binding)) return false;
		if (row.tool === "jev_requirements" && row.result.details?.["approved"] === true) {
			if (row.binding.requirements !== binding.requirements) return false;
		} else if (row.tool === "jev_plan_review" && row.result.details?.["planDigest"] !== undefined) {
			if (row.binding.plan !== binding.plan || row.binding.requirements !== binding.requirements) return false;
		} else if (row.binding.work !== undefined ? row.binding.work !== binding.work
			: row.tool !== "jev_fact_check" && row.binding.revision !== binding.revision) return false;
		if (!sourcesCurrent(row, binding)) return false;
		return row.prior.every(id => {
			const input = rows.find(candidate => candidate.id === id);
			// Issue understanding and development are baselines, not proof of later implementation.
			if (input && row.tool === "jev_issue" && input.tool === row.tool && row.subject === input.subject) return sameScope(input, binding);
			return input !== undefined && current(input, binding);
		});
	};
	const keyOf = (row: DiagnosticResult): string => {
		const input = asRecord(row.input);
		return JSON.stringify([row.tool, row.subject, input?.["phase"] ?? input?.["action"] ?? input?.["aspect"], asRecord(input?.["part"])?.["index"]]);
	};
	const replacedBy = (result: ToolOutcome): boolean => {
		const status = diagnosticKind(result);
		return status === "passed" || status === "failed" || status === "inconclusive";
	};
	const summary = (row: DiagnosticResult, binding: DiagnosticBinding): DiagnosticResultSummary => {
		const status = diagnosticKind(row.result);
		const replaced = row.tool === "jev_acceptance/outcome" && status === "unavailable" && rows.some(candidate => candidate.tool === row.tool &&
			candidate.subject === row.subject && candidate.binding.work === row.binding.work &&
			replacedBy(candidate.result) && current(candidate, binding));
		const reason = replaced ? "A settled outcome supersedes this unavailable attempt."
			: !current(row, binding) ? "The objective, work revision, or a bound input is no longer current." : undefined;
		return { id: row.id, tool: row.tool, subject: row.subject, revision: row.binding.revision,
			status, applicability: reason === undefined ? "current" : "historical",
			sources: [...row.sources.keys()], prior: row.prior, reason };
	};
	return {
		begin(binding: DiagnosticBinding) {
			const sources = new Map<string, string>();
			const prior = new Set<string>();
			const observe = (source: string): FactSource | undefined => {
				const found = binding.scope?.sources.get(source);
				if (!sources.has(source)) sources.set(source, digestOf(found));
				return found;
			};
			const verify: VerifyObserved = (source, quote, whole) => {
				const observed = observe(source);
				return observed !== undefined && (whole ? observed.whole === true && observed.text === quote : observed.text.includes(quote));
			};
			const priorFact = (artifact: string, claim: string): PriorFact | undefined => {
				const subject = sha256(artifact);
				for (let i = rows.length - 1; i >= 0; i -= 1) {
					const row = rows[i]!;
					if (row.tool !== "jev_fact_check" || row.subject !== subject || !current(row, binding)) continue;
					const entries = row.result.details?.["claims"];
					if (!Array.isArray(entries)) continue;
					const matches = entries.map(asRecord).filter(entry => entry?.["quote"] === claim || entry?.["statement"] === claim);
					if (matches.length === 0) continue;
					prior.add(row.id);
					const verdict = matches[0]?.["verdict"];
					return typeof verdict === "string" && matches.every(item => item?.["verdict"] === verdict)
						? { verdict, confidence: typeof matches[0]?.["confidence"] === "number" ? matches[0]["confidence"] : undefined }
						: { verdict: "unclear" };
				}
				return undefined;
			};
			return {
				observe, verify, priorFact,
				issueBaseline(id, phase, subject) {
					const row = rows.find(candidate => candidate.id === id);
					if (!row || row.tool !== "jev_issue" || row.subject !== subject || asRecord(row.input)?.["phase"] !== phase ||
						!sameScope(row, binding) || (phase === "understand" && !sourcesCurrent(row, binding))) return undefined;
					const details = row.result.details;
					if (!details) return undefined;
					const status = details["status"];
					if (phase === "understand" ? status !== "understood" && status !== "partially_understood" : status !== "development_ready") return undefined;
					prior.add(row.id);
					return { details, observations: row.binding.observations ?? 0 };
				},
				link(tool) {
					for (let i = rows.length - 1; i >= 0; i -= 1) {
						const row = rows[i]!;
						if (row.tool !== tool || !current(row, binding)) continue;
						if (tool === "jev_requirements" ? row.result.details?.["approved"] === true : row.result.details?.["planDigest"] === binding.plan && binding.plan !== undefined) {
							prior.add(row.id);
							break;
						}
					}
				},
				stillCurrent: (active: DiagnosticBinding): boolean => binding.scope === active.scope && binding.objective === active.objective &&
					binding.revision === active.revision && [...sources].every(([source, digest]) => digestOf(active.scope?.sources.get(source)) === digest),
				record(tool: string, subject: string, input: unknown, result: ToolOutcome, active = binding): string {
					const id = `result-${rows.length + 1}`;
					rows.push({ id, tool, subject, binding: active, sources, prior: [...prior], input, result });
					return id;
				},
			};
		},
		list(binding: DiagnosticBinding) {
			const seen = new Set<string>();
			return rows.slice().reverse().flatMap(row => {
				const key = keyOf(row);
				if (seen.has(key)) return [];
				seen.add(key);
				return [summary(row, binding)];
			});
		},
		read(id: string, binding: DiagnosticBinding) {
			const row = rows.find(entry => entry.id === id);
			return row === undefined ? undefined : { ...summary(row, binding), input: row.input, result: row.result };
		},
	};
}
