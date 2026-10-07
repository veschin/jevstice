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
import { createAspectCoverageJudge, createCourseCheckJudge, createJudge, createMultiLabelJudge } from "./client.js";
import { loadTopicCatalog, type CatalogTopic } from "./catalog.js";
import { memoizedKeyResolver } from "./apikey.js";
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
/**
 * Production judge. The key resolves lazily - environment variable first, else the
 * resolver command - so a host that keeps the secret in `pass` needs no exported
 * variable, and a transient resolver failure stays retryable.
 */
export function buildProductionJudge(env: NodeJS.ProcessEnv = process.env): Judge {
	const resolveKey = memoizedKeyResolver(env);
	const base = {
		apiUrl: envValue("TYPESAFE_API_URL", "JEVI_BASE_URL"),
		model: envValue("JEVI_MODEL"),
		timeoutMs: intEnv("JEVI_TIMEOUT_MS"),
	};
	return async request => {
		const apiKey = await resolveKey();
		if (apiKey === undefined) {
			// Explicit fail-closed: unconfigured judge can never approve (POLICY.failureNeverApproves).
			throw new Error(
				`jev judge unconfigured: set ${POLICY.apiKeyEnv} or TYPESAFE_API_KEY_COMMAND ` +
					"(e.g. 'pass show token/jev'); a missing judge can never approve",
			);
		}
		return createJudge({ ...base, apiKey })(request);
	};
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
		// R5: invalid configuration keeps the controller registered with closed gates.
		// Missing files are the normal defaults case.
		let templateError: string | undefined;
		let template: JevTemplateConfig | undefined;
		try {
			template = deps.template ?? loadJevTemplateConfig(process.cwd(), process.env["HOME"] ?? "");
		} catch (err) {
			if (err instanceof JevConfigError) {
				templateError = err.message;
				process.stderr.write(`jev: configuration invalid; gates remain closed — ${err.message}\n`);
			} else {
				throw err;
			}
		}
		// N1: the effective (R1-clamped) floor also raises the course-check demotion floor.
		const effectiveMinConfidence = Math.max(
			POLICY.minConfidenceToApprove,
			template?.confidenceThreshold ?? 0,
		);
		const clientConfig = {
			apiUrl: envValue("TYPESAFE_API_URL", "JEVI_BASE_URL"),
			model: envValue("JEVI_MODEL"),
			timeoutMs: intEnv("JEVI_TIMEOUT_MS"),
			minConfidence: effectiveMinConfidence,
		};
		// Same lazy resolution as the main judge; the sub-judges are built per call, so
		// they see the key the moment it resolves.
		const resolveKey = memoizedKeyResolver(process.env);
		const withKey = async () => ({ ...clientConfig, apiKey: (await resolveKey()) ?? "" });
		// Catalog labels inform the judge; mentioning a label never proves preservation.
		let catalogIds: ReadonlySet<string> = new Set();
		let aspectTexts: ReadonlyMap<string, string> = new Map();
		let catalogTopics: CatalogTopic[] | undefined;
		try {
			const catalog = loadTopicCatalog();
			catalogTopics = catalog;
			catalogIds = new Set(catalog.map(t => t.id));
			aspectTexts = new Map(catalog.map(t => [t.id, t.label]));
		} catch {
			// Catalog unavailable: pre-check accepts nothing; wired judge stays undefined.
		}
		const aspectCoverageJudge =
			deps.aspectCoverageJudge ??
			(deps.judge === undefined
				? async req => createAspectCoverageJudge(await withKey())({
						...req,
						aspects: req.aspects.map(a => ({
							...a,
							text: req.requireAll ? a.text : (aspectTexts.get(a.id) ?? a.text),
						})),
					})
				: undefined);
		const controller: JevController = createJevController({
			judge: deps.judge ?? buildProductionJudge(),
			// C1 wired by default in production; tests inject their own.
			courseCheckJudge:
				deps.courseCheckJudge ??
				(deps.judge === undefined ? async req => createCourseCheckJudge(await withKey())(req) : undefined),
			aspectCoverageJudge,
			catalogIds,
			// FR-01/FR-04: automatic task-start checks; advisory, they never block.
			catalog: catalogTopics,
			multiLabelJudge:
				deps.multiLabelJudge ??
				(deps.judge === undefined ? async req => createMultiLabelJudge(await withKey())(req) : undefined),
			template,
			templateError,
		});
		controller.register(pi);
		// Session continuity + R5 re-validation: an already-running session picks up config
		// corruption fail-closed (typed errors on every submission, gates stay up).
		pi.on("session_start", (_event, ctx) => {
			try {
				template = deps.template ?? loadJevTemplateConfig(process.cwd(), process.env["HOME"] ?? "");
				clientConfig.minConfidence = Math.max(POLICY.minConfidenceToApprove, template.confidenceThreshold ?? 0);
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
