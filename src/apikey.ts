/**
 * Key resolution: an environment variable first, then a resolver command whose trimmed stdout is
 * the key (`pass show token/jev`). The key is never logged, persisted or echoed - it reaches the
 * judge client and nothing else. A missing key or a failing command resolves to `undefined`, so the
 * judge reports an unusable answer instead of throwing and no call can be mistaken for an approval.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { POLICY } from "./types.js";

const execFileAsync = promisify(execFile);
const KEY_COMMAND_TIMEOUT_MS = 15000;

export type KeyEnv = Record<string, string | undefined>;
export type KeyCommandRunner = (command: string) => Promise<string>;

const runKeyCommand: KeyCommandRunner = async command => {
	const { stdout } = await execFileAsync("/bin/sh", ["-c", command], { timeout: KEY_COMMAND_TIMEOUT_MS });
	return stdout;
};

/** Environment variable, else the resolver command's trimmed stdout; undefined when neither yields a key. */
export async function resolveApiKey(
	env: KeyEnv,
	run: KeyCommandRunner = runKeyCommand,
): Promise<string | undefined> {
	for (const name of [POLICY.apiKeyEnv, ...POLICY.altApiKeyEnvs]) {
		const value = env[name]?.trim();
		if (value !== undefined && value.length > 0) return value;
	}
	const command = env[POLICY.apiKeyCommandEnv]?.trim();
	if (command === undefined || command.length === 0) return undefined;
	try {
		const key = (await run(command)).trim();
		return key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Memoized resolver: the command runs once per resolved key. A missing key and a failing command
 * clear the cache, so a key exported mid-session or a transient `pass`/gpg failure is retried on
 * the next call instead of poisoning the session.
 */
export function memoizedApiKeyResolver(
	env: KeyEnv,
	run: KeyCommandRunner = runKeyCommand,
): () => Promise<string | undefined> {
	let pending: Promise<string | undefined> | undefined;
	return () => {
		if (pending === undefined) {
			pending = resolveApiKey(env, run).then(
				key => {
					if (key === undefined) pending = undefined;
					return key;
				},
				error => {
					pending = undefined;
					throw error;
				},
			);
		}
		return pending;
	};
}
