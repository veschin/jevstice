/**
 * A throwaway local forwarding proxy for the TypeSafe judge endpoint.
 *
 * Why it exists: the addon's own judge consultations are HTTP calls made from inside the extension
 * and are invisible to the host's event stream, so "how many judge consultations did that run make,
 * and what did they cost" cannot be read off the session. The extension (like the CLI) honours
 * `TYPESAFE_API_URL`, so each spawned session is pointed at one of these proxies; every request is
 * relayed to the real endpoint unchanged and recorded. The Authorization header carrying the API key
 * is forwarded but never written to the record.
 *
 * It is deliberately a separate module so it can be validated on its own, without an omp session:
 * `bun run tools/measurement/proxy-check.ts`.
 */
import { isRecord } from "../../src/guards";

const REAL_JUDGE_ORIGIN = "https://api.typesafe.ai";

export interface JudgeCall {
	at: string;
	path: string;
	model: string;
	questionIds: string[];
	stateBytes: number;
	status: number;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	responseSummary: string;
}

export interface TrafficRecord {
	label: string;
	calls: JudgeCall[];
}

export interface JudgeProxy {
	/** Value for TYPESAFE_API_URL: the SDK strips the /v1/systemone suffix to get its API root. */
	url: string;
	record: TrafficRecord;
	stop: () => void;
}

/** Mirrors what src/client.ts does with the endpoint URL, so the proxy sees the same requests. */
export function systemOneFromApiUrl(apiUrl: string): string {
	const suffix = "/v1/systemone";
	return apiUrl.endsWith(suffix) ? apiUrl : `${apiUrl.replace(/\/$/, "")}${suffix}`;
}

/** One line per call, safe to print and to persist: no headers, no API key. */
export function summariseCall(call: JudgeCall): string {
	return `${call.at} ${call.status} ${call.latencyMs}ms questions=[${call.questionIds.join(",")}] state=${call.stateBytes}B tokens=${call.inputTokens}/${call.outputTokens} answers="${call.responseSummary}"`;
}

export async function startJudgeProxy(label: string): Promise<JudgeProxy> {
	const calls: JudgeCall[] = [];
	const record: TrafficRecord = { label, calls };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const started = Date.now();
			const bodyText = request.method === "POST" ? await request.text() : "";
			const headers = new Headers(request.headers);
			headers.delete("host");
			headers.delete("content-length");
			const upstream = await fetch(`${REAL_JUDGE_ORIGIN}${url.pathname}${url.search}`, {
				method: request.method,
				headers,
				...(bodyText.length > 0 ? { body: bodyText } : {}),
			});
			// The decoded body is relayed as text, so the encoding/length headers of the upstream
			// response must go: forwarding `content-encoding: gzip` with a decoded body makes the
			// SDK fail with a ZlibError.
			const responseText = await upstream.text();
			const relayHeaders = new Headers(upstream.headers);
			relayHeaders.delete("content-encoding");
			relayHeaders.delete("content-length");
			relayHeaders.delete("transfer-encoding");
			let model = "";
			let questionIds: string[] = [];
			if (bodyText.length > 0) {
				try {
					const parsed: unknown = JSON.parse(bodyText);
					if (isRecord(parsed)) {
						if (typeof parsed["model"] === "string") model = parsed["model"];
						if (isRecord(parsed["questions"])) questionIds = Object.keys(parsed["questions"]);
					}
				} catch {
					// not JSON: recorded with an empty summary below
				}
			}
			let inputTokens = 0;
			let outputTokens = 0;
			let responseSummary = "";
			try {
				const parsedResponse: unknown = JSON.parse(responseText);
				if (isRecord(parsedResponse)) {
					const usage = parsedResponse["usage"];
					if (isRecord(usage)) {
						if (typeof usage["input_tokens"] === "number") inputTokens = usage["input_tokens"];
						if (typeof usage["output_tokens"] === "number") outputTokens = usage["output_tokens"];
					}
					const answers = parsedResponse["answers"];
					if (isRecord(answers)) {
						responseSummary = Object.entries(answers)
							.map(([id, answer]) => {
								if (!isRecord(answer)) return `${id}=?`;
								if (typeof answer["choice"] === "string") {
									const confidence = typeof answer["confidence"] === "number" ? `@${answer["confidence"]}` : "";
									return `${id}=${answer["choice"]}${confidence}`;
								}
								if (typeof answer["noul"] === "number") return `${id}=${answer["noul"]}`;
								return `${id}=?`;
							})
							.join(" ");
					}
				}
			} catch {
				responseSummary = responseText.slice(0, 200);
			}
			calls.push({
				at: new Date().toISOString(),
				path: url.pathname,
				model,
				questionIds,
				stateBytes: bodyText.length,
				status: upstream.status,
				latencyMs: Date.now() - started,
				inputTokens,
				outputTokens,
				responseSummary,
			});
			return new Response(responseText, { status: upstream.status, headers: relayHeaders });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1/systemone`,
		record,
		stop: () => server.stop(true),
	};
}
