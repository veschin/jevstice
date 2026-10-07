/**
 * Single key-resolution path shared by the CLI and the extension: an environment
 * variable first, then a resolver command whose stdout is the key
 * (`pass show token/jev`). The key is never logged, persisted, or echoed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JevApiError } from "./client.js";

const execFileP = promisify(execFile);
const KEY_COMMAND_TIMEOUT_MS = 15000;

export type KeyEnv = Record<string, string | undefined>;

/** Direct key from the environment, if present. */
export function apiKeyFromEnv(env: KeyEnv): string | undefined {
	const direct = env["TYPESAFE_API_KEY"] ?? env["JEVI_API_KEY"];
	return direct !== undefined && direct.length > 0 ? direct : undefined;
}

/** Resolver command from the environment, if present. */
export function apiKeyCommand(env: KeyEnv): string | undefined {
	const command = env["TYPESAFE_API_KEY_COMMAND"];
	return command !== undefined && command.length > 0 ? command : undefined;
}

/** Environment variable, else the resolver command's trimmed stdout. */
export async function resolveApiKey(env: KeyEnv): Promise<string | undefined> {
	const direct = apiKeyFromEnv(env);
	if (direct !== undefined) return direct;
	const command = apiKeyCommand(env);
	if (command === undefined) return undefined;
	let stdout: string;
	try {
		({ stdout } = await execFileP("/bin/sh", ["-c", command], { timeout: KEY_COMMAND_TIMEOUT_MS }));
	} catch (err) {
		throw new JevApiError(
			"config",
			`TYPESAFE_API_KEY_COMMAND failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const key = stdout.trim();
	return key.length > 0 ? key : undefined;
}

/**
 * Memoized resolver: the command runs once per success; a failure clears the cache so the
 * next call retries - a transient `pass`/gpg failure must not poison the whole session.
 */
export function memoizedKeyResolver(env: KeyEnv): () => Promise<string | undefined> {
	let pending: Promise<string | undefined> | undefined;
	return () => {
		if (pending === undefined) {
			pending = resolveApiKey(env).catch(err => {
				pending = undefined;
				throw err;
			});
		}
		return pending;
	};
}
