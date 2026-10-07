/**
 * Jev omp extension entry point.
 *
 * Load manifest (integrator-owned package.json): { "omp": { "extensions": ["src/index.ts"] } }.
 * Production judge: real TypeSafe client from src/client.ts (createJudge, JevClientConfig).
 * API key resolution order: JEVI_API_KEY, then TYPESAFE_API_KEY (POLICY.apiKeyEnv); the key is
 * only ever passed to the client - never logged, persisted, or echoed.
 *
 * With no key configured the extension still loads and read-only work stays possible, but every
 * decision submission fails closed (typed error -> insufficient_evidence; judge-unavailable
 * never approves).
 */
import { createJevController, type ControllerDeps, type JevController, type PiApi } from "./controller.js";
import { JevConfigError, loadJevTemplateConfig, type JevTemplateConfig } from "./config.js";
import { isRecord } from "./guards.js";
import { createCourseCheckJudge, createJudge } from "./client.js";
import { POLICY, type Judge } from "./types.js";

function envValue(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function intEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.length === 0) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Build the production judge dependencies; fail-closed when unconfigured. */
export function buildProductionJudge(env: NodeJS.ProcessEnv = process.env): Judge {
	const apiKey = envValue("TYPESAFE_API_KEY", "JEVI_API_KEY");
	if (apiKey === undefined || apiKey.length === 0) {
		// Explicit fail-closed: unconfigured judge can never approve (POLICY.failureNeverApproves).
		return async () => {
			throw new Error(
				`jev judge unconfigured: set ${POLICY.apiKeyEnv} (or JEVI_API_KEY); ` +
					"a missing judge can never approve",
			);
		};
	}
	return createJudge({
		apiKey,
		apiUrl: envValue("TYPESAFE_API_URL", "JEVI_BASE_URL"),
		model: envValue("JEVI_MODEL"),
		timeoutMs: intEnv("JEVI_TIMEOUT_MS"),
	});
}

function extractCustomEntries(sessionManager: unknown): Array<{ customType: string; data: unknown }> {
	if (!isRecord(sessionManager) || typeof sessionManager["getEntries"] !== "function") return [];
	try {
		const entries = (sessionManager["getEntries"] as () => unknown[])();
		const out: Array<{ customType: string; data: unknown }> = [];
		for (const entry of entries) {
			if (!isRecord(entry) || entry["type"] !== "custom" || typeof entry["customType"] !== "string") continue;
			out.push({ customType: entry["customType"] as string, data: entry["data"] });
		}
		return out;
	} catch {
		return [];
	}
}

export function createJevExtension(deps: Partial<ControllerDeps> = {}) {
	return (pi: PiApi): void => {
		// R5: load template config at extension load; an invalid file REFUSES registration
		// (never silent defaults). Missing files are the normal defaults case.
		let templateError: string | undefined;
		let template: JevTemplateConfig | undefined;
		try {
			template = deps.template ?? loadJevTemplateConfig(process.cwd(), process.env["HOME"] ?? "");
		} catch (err) {
			if (err instanceof JevConfigError) {
				templateError = err.message;
				process.stderr.write(`jev: refusing to register jev_decision — ${err.message}\n`);
				return;
			}
			throw err;
		}
		// N1: the effective (R1-clamped) floor also raises the course-check demotion floor.
		const effectiveMinConfidence = Math.max(
			POLICY.minConfidenceToApprove,
			template?.confidenceThreshold ?? 0,
		);
		const clientConfig = {
			apiKey: envValue("TYPESAFE_API_KEY", "JEVI_API_KEY") ?? "",
			apiUrl: envValue("TYPESAFE_API_URL", "JEVI_BASE_URL"),
			model: envValue("JEVI_MODEL"),
			timeoutMs: intEnv("JEVI_TIMEOUT_MS"),
			minConfidence: effectiveMinConfidence,
		};
		const controller: JevController = createJevController({
			judge: deps.judge ?? buildProductionJudge(),
			// C1 wired by default in production; tests inject their own.
			courseCheckJudge:
				deps.courseCheckJudge ??
				(deps.judge === undefined ? createCourseCheckJudge(clientConfig) : undefined),
			template,
			templateError,
		});
		controller.register(pi);
		// Session continuity + R5 re-validation: an already-running session picks up config
		// corruption fail-closed (typed errors on every submission, gates stay up).
		pi.on("session_start", (_event, ctx) => {
			try {
				template = deps.template ?? loadJevTemplateConfig(process.cwd(), process.env["HOME"] ?? "");
				controller.setTemplateState(template, undefined);
			} catch (err) {
				if (err instanceof JevConfigError) {
					controller.setTemplateState(undefined, err.message);
					return;
				}
				throw err;
			}
			if (isRecord(ctx) && "sessionManager" in ctx) {
				controller.onSessionStart(extractCustomEntries(ctx["sessionManager"]));
			}
		});
	};
}

export default createJevExtension();
