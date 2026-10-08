/**
 * Jevstice entry point.
 *
 * Load manifest (integrator-owned package.json): `{ "omp": { "extensions": ["src/index.ts"] } }`.
 * The manifest field is deliberately absent at the moment, so ordinary sessions load no addon and
 * the extension is exercised only when a session loads it explicitly.
 *
 * With no key configured the extension still loads; every submission then fails closed (an unusable
 * answer is never an approval). The key is resolved lazily and only ever handed to the judge client.
 */
import { memoizedApiKeyResolver } from "./apikey.js";
import { loadJevConfig } from "./config.js";
import { createJevController, type PiApi, type SchemaBuilder } from "./controller.js";
import { createTypeSafeJudge, type Judge } from "./judge.js";
import { POLICY } from "./types.js";

/** The host surface the factory reads: the extension API plus the injected schema builder. */
interface ExtensionHost extends PiApi {
	zod: SchemaBuilder;
}

/** Build the factory omp calls with its ExtensionAPI; `deps` exists for tests and embedding. */
export function createJevExtension(
	deps: { judge?: Judge; cwd?: string; home?: string } = {},
): (pi: ExtensionHost) => void {
	return pi => {
		const config = loadJevConfig({ cwd: deps.cwd ?? process.cwd(), home: deps.home });
		const judge =
			deps.judge ??
			createTypeSafeJudge({
				resolveKey: memoizedApiKeyResolver(process.env),
				model: POLICY.defaultModel,
			});
		createJevController({ judge, config, zod: pi.zod }).register(pi);
	};
}

export default createJevExtension();
