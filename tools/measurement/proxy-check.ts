#!/usr/bin/env bun
/**
 * Validates tools/measurement/judge-proxy.ts on its own, with one real judge request and no omp
 * session: start the proxy, send a `systemOne` call through it with the official SDK, and check that
 * the proxy recorded the call with its usage and that the answer came back unchanged.
 *
 * usage: bun run tools/measurement/proxy-check.ts
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { startJudgeProxy, summariseCall, systemOneFromApiUrl } from "./judge-proxy";

const apiKey = process.env["TYPESAFE_API_KEY"] ?? process.env["JEVI_API_KEY"] ?? "";
if (apiKey.length === 0) throw new Error("no judge key: set TYPESAFE_API_KEY (or JEVI_API_KEY)");

const proxy = await startJudgeProxy("proxy-check");
try {
	const client = new TypeSafeClient({
		apiKey,
		baseURL: new URL(proxy.url).origin,
		defaultModel: "jev-latest",
		timeout: 60_000,
		retry: { maxRetries: 0 },
		logLevel: "off",
	});
	const result = (await client.systemOne({
		state: {
			stage: "proxy_check",
			note: "a proxy self-test; the claim below is trivially checkable",
		},
		questions: {
			answered: {
				type: "noul",
				id: "answered",
				instructions: {
					policy: "The quoted state is all the evidence there is. Judge only from it.",
					question: "Does the quoted state say that this request is a proxy self-test?",
				},
				criteria: {
					true: "The quoted state says it is a proxy self-test.",
					false: "The quoted state does not say that.",
				},
			},
		},
	})) as { model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number } };

	const recorded = proxy.record.calls;
	process.stdout.write(`proxy url: ${proxy.url}\n`);
	process.stdout.write(`TYPESAFE_API_URL the harness would hand a session: ${systemOneFromApiUrl(proxy.url)}\n`);
	process.stdout.write(`calls recorded by the proxy: ${recorded.length}\n`);
	for (const call of recorded) process.stdout.write(`  ${summariseCall(call)}\n`);
	process.stdout.write(`answer seen by the SDK: ${JSON.stringify(result.answers)}\n`);
	process.stdout.write(`usage seen by the SDK: ${JSON.stringify(result.usage)}\n`);

	const call = recorded[0];
	const ok =
		recorded.length === 1 &&
		call !== undefined &&
		call.status === 200 &&
		call.questionIds.includes("answered") &&
		call.inputTokens > 0 &&
		typeof call.responseSummary === "string" &&
		call.responseSummary.includes("answered=") &&
		result.answers !== undefined &&
		"answered" in result.answers;
	process.stdout.write(`${ok ? "PROXY CHECK PASS" : "PROXY CHECK FAIL"} (one call relayed, answered, and recorded with usage)\n`);
	process.exit(ok ? 0 : 1);
} finally {
	proxy.stop();
}
