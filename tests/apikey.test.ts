/**
 * Key resolution is one path for the CLI and the extension (env var, else resolver command).
 * The key is never logged; these tests assert values, not formatting.
 */
import { describe, expect, test } from "bun:test";
import { apiKeyCommand, apiKeyFromEnv, memoizedKeyResolver, resolveApiKey } from "../src/apikey";
import { JevApiError } from "../src/client";
import { buildProductionJudge } from "../src/index";
import type { DecisionRequest } from "../src/types";

const request = {
	stage: "task_classification",
	task: "t",
	proposal: "p",
	options: [
		{ id: "a", label: "A", meaning: "a" },
		{ id: "b", label: "B", meaning: "b" },
	],
	evidence: [{ kind: "user", source: "s", quote: "a quote long enough to pass" }],
} as unknown as DecisionRequest;

describe("api key resolution", () => {
	test("a direct environment variable wins over the resolver command", async () => {
		const key = await resolveApiKey({ TYPESAFE_API_KEY: "direct", TYPESAFE_API_KEY_COMMAND: "exit 1" });
		expect(key).toBe("direct");
	});

	test("JEVI_API_KEY is the documented fallback; an empty value is not a key", () => {
		expect(apiKeyFromEnv({ JEVI_API_KEY: "alt" })).toBe("alt");
		expect(apiKeyFromEnv({ TYPESAFE_API_KEY: "" })).toBeUndefined();
		expect(apiKeyCommand({ TYPESAFE_API_KEY_COMMAND: "" })).toBeUndefined();
	});

	test("resolver command stdout is trimmed and becomes the key", async () => {
		expect(await resolveApiKey({ TYPESAFE_API_KEY_COMMAND: "printf '  secret\\n'" })).toBe("secret");
	});

	test("empty command output is not a key", async () => {
		expect(await resolveApiKey({ TYPESAFE_API_KEY_COMMAND: "true" })).toBeUndefined();
	});

	test("a failing command is a typed config error, never a silent empty key", async () => {
		await expect(resolveApiKey({ TYPESAFE_API_KEY_COMMAND: "exit 7" })).rejects.toThrow(JevApiError);
	});

	test("memoized resolver reuses a success and retries after a failure", async () => {
		const env: Record<string, string | undefined> = { TYPESAFE_API_KEY_COMMAND: "printf 'k1'" };
		const resolve = memoizedKeyResolver(env);
		expect(await resolve()).toBe("k1");
		env["TYPESAFE_API_KEY_COMMAND"] = "printf 'k2'";
		expect(await resolve()).toBe("k1");

		const failing: Record<string, string | undefined> = { TYPESAFE_API_KEY_COMMAND: "exit 3" };
		const resolveFailing = memoizedKeyResolver(failing);
		await expect(resolveFailing()).rejects.toThrow(JevApiError);
		failing["TYPESAFE_API_KEY_COMMAND"] = "printf 'k3'";
		expect(await resolveFailing()).toBe("k3");
	});

	test("production judge fails closed when neither variable nor command is set", async () => {
		await expect(buildProductionJudge({}).call(null, request)).rejects.toThrow(/unconfigured/);
	});
});
