import { describe, expect, test } from "bun:test";
import { memoizedApiKeyResolver, resolveApiKey } from "../src/apikey.js";

describe("T1 - the key reaches the judge client and nowhere else", () => {
	test("the environment variable wins over the resolver command", async () => {
		const runs: string[] = [];
		const key = await resolveApiKey(
			{ TYPESAFE_API_KEY: "env-key", TYPESAFE_API_KEY_COMMAND: "pass show token/jev" },
			async command => {
				runs.push(command);
				return "command-key";
			},
		);

		expect(key).toBe("env-key");
		expect(runs).toEqual([]);
	});

	test("JEVI_API_KEY is accepted as the alternate variable and whitespace is trimmed", async () => {
		expect(await resolveApiKey({ JEVI_API_KEY: "  jevi-key  " })).toBe("jevi-key");
	});

	test("the resolver command's trimmed stdout is the key", async () => {
		const runs: string[] = [];
		const key = await resolveApiKey({ TYPESAFE_API_KEY_COMMAND: "pass show token/jev" }, async command => {
			runs.push(command);
			return "command-key\n";
		});

		expect(key).toBe("command-key");
		expect(runs).toEqual(["pass show token/jev"]);
	});

	test("an empty result and a failing command resolve to no key", async () => {
		expect(await resolveApiKey({ TYPESAFE_API_KEY_COMMAND: "true" }, async () => "   \n")).toBeUndefined();
		expect(
			await resolveApiKey({ TYPESAFE_API_KEY_COMMAND: "false" }, async () => {
				throw new Error("gpg: decryption failed");
			}),
		).toBeUndefined();
		expect(await resolveApiKey({})).toBeUndefined();
		expect(await resolveApiKey({ TYPESAFE_API_KEY: "   " })).toBeUndefined();
	});

	test("a resolved key is memoized across calls", async () => {
		let runs = 0;
		const resolve = memoizedApiKeyResolver({ TYPESAFE_API_KEY_COMMAND: "pass show token/jev" }, async () => {
			runs += 1;
			return "command-key";
		});

		expect(await resolve()).toBe("command-key");
		expect(await resolve()).toBe("command-key");
		expect(runs).toBe(1);
	});

	test("a missing key is retried, so a key exported mid-session is picked up", async () => {
		const env: Record<string, string | undefined> = { TYPESAFE_API_KEY_COMMAND: "pass show token/jev" };
		let runs = 0;
		const resolve = memoizedApiKeyResolver(env, async () => {
			runs += 1;
			return runs === 1 ? "" : "command-key";
		});

		expect(await resolve()).toBeUndefined();
		expect(await resolve()).toBe("command-key");
		expect(runs).toBe(2);
	});
});
