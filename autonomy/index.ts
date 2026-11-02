/** Explicit strict-only entry, loaded by the optional supervisor rather than the package manifest. */
import { memoizedApiKeyResolver } from "../src/apikey.js";
import { loadJevConfig } from "../src/config.js";
import { createJevController, type PiApi, type SchemaBuilder } from "../src/controller.js";
import { createTypeSafeJudge } from "../src/judge.js";
import { POLICY } from "../src/types.js";

export default async (pi: PiApi & { zod: SchemaBuilder }): Promise<void> => {
	const startup = { ready: false, reason: "Strict autonomous initialization is not committed; all calls and completion remain held." };
	pi.on("tool_call", () => startup.ready ? undefined : { block: true, reason: startup.reason });
	pi.on("session_stop", () => startup.ready ? undefined : { decision: "block", reason: startup.reason });
	try {
		const storeFile = process.env["JEVSTICE_AUTONOMY_STORE"];
		const runId = process.env["JEVSTICE_AUTONOMY_RUN"];
		if (storeFile === undefined || storeFile.trim().length === 0 || runId === undefined || runId.trim().length === 0) {
			throw new Error("Both nonempty autonomous store and run locators are required.");
		}
		const config = loadJevConfig({ cwd: process.cwd() });
		const judge = createTypeSafeJudge({
			resolveKey: memoizedApiKeyResolver(process.env),
			model: POLICY.defaultModel,
		});
		// Register deny hooks before loading any Linux/SQLite implementation.
		const { createAutonomyRuntime } = await import("./runtime.js");
		const autonomy = createAutonomyRuntime({ storeFile, runId, judge, config });
		autonomy.register(pi, pi.zod);
		createJevController({ judge, config: autonomy.config(), zod: pi.zod, autonomy }).register(autonomy.controllerApi(pi));
		startup.ready = true;
	} catch (error) {
		startup.reason = `Strict autonomous initialization failed closed: ${error instanceof Error ? error.message : String(error)}. All calls and completion remain held.`;
	}
};
