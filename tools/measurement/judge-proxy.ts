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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REAL_JUDGE_ORIGIN = "https://api.typesafe.ai";

export interface JudgeCall {
	at: string;
	path: string;
	model: string;
	questionIds: string[];
	/** Top-level keys of the request's `state`: what the consultation was about, without dumping it. */
	stateKeys: string[];
	stateBytes: number;
	status: number;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	responseSummary: string;
	/** Set only when JEV_PROXY_DUMP_DIR is configured: the verbatim request/response bodies. */
	requestPath?: string;
	responsePath?: string;
	dumpError?: string;
	/** Set when the relay itself failed (the endpoint resets sockets intermittently): status 502. */
	relayError?: string;
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
	const state = call.stateKeys.length > 0 ? `state=[${call.stateKeys.join(",")}]` : "state=[]";
	return `${call.at} ${call.status} ${call.latencyMs}ms questions=[${call.questionIds.join(",")}] ${state} ${call.stateBytes}B tokens=${call.inputTokens}/${call.outputTokens} answers="${call.responseSummary}"${call.requestPath === undefined ? "" : ` payload=${call.requestPath}`}`;
}

/**
 * The full request/response bodies are written only when JEV_PROXY_DUMP_DIR names a directory: a
 * measurement that wants to show what a consultation was about, and not only that one happened, sets
 * that variable and gets one JSON pair per call. Headers are never written, so the API key stays out
 * of the dump; the bodies hold extension-composed states (task text, plans, candidate answers).
 */
export function payloadDumpDir(): string | undefined {
	const dir = process.env["JEV_PROXY_DUMP_DIR"];
	return dir === undefined || dir.length === 0 ? undefined : dir;
}

function writeIfConfigured(path: string | undefined, text: string): string | undefined {
	if (path === undefined) return undefined;
	try {
		writeFileSync(path, text, "utf8");
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export async function startJudgeProxy(label: string): Promise<JudgeProxy> {
	const calls: JudgeCall[] = [];
	const record: TrafficRecord = { label, calls };
	const dumpDir = payloadDumpDir();
	if (dumpDir !== undefined) mkdirSync(dumpDir, { recursive: true });
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

			let model = "";
			let questionIds: string[] = [];
			let stateKeys: string[] = [];
			if (bodyText.length > 0) {
				try {
					const parsed: unknown = JSON.parse(bodyText);
					if (isRecord(parsed)) {
						if (typeof parsed["model"] === "string") model = parsed["model"];
						if (isRecord(parsed["questions"])) questionIds = Object.keys(parsed["questions"]);
						if (isRecord(parsed["state"])) stateKeys = Object.keys(parsed["state"]);
					}
				} catch {
					// not JSON: recorded with an empty summary below
				}
			}

			// Numbered by arrival: the index is the call's position in this run's traffic record.
			const index = calls.length + 1;
			const requestPath = dumpDir === undefined ? undefined : join(dumpDir, `${label}-${index}.request.json`);
			const responsePath = dumpDir === undefined ? undefined : join(dumpDir, `${label}-${index}.response.json`);
			// The request is dumped before it is relayed, so a relay that fails still shows what the
			// extension asked, and a consultation that never produced a judgement is still counted.
			let dumpError = writeIfConfigured(requestPath, bodyText);

			let status = 0;
			let responseText = "";
			let relayHeaders = new Headers();
			let relayError: string | undefined;
			try {
				const upstream = await fetch(`${REAL_JUDGE_ORIGIN}${url.pathname}${url.search}`, {
					method: request.method,
					headers,
					...(bodyText.length > 0 ? { body: bodyText } : {}),
				});
				status = upstream.status;
				// The decoded body is relayed as text, so the encoding/length headers of the upstream
				// response must go: forwarding `content-encoding: gzip` with a decoded body makes the
				// SDK fail with a ZlibError.
				responseText = await upstream.text();
				relayHeaders = new Headers(upstream.headers);
				relayHeaders.delete("content-encoding");
				relayHeaders.delete("content-length");
				relayHeaders.delete("transfer-encoding");
			} catch (error) {
				relayError = error instanceof Error ? error.message : String(error);
				status = 502;
				responseText = JSON.stringify({ error: "proxy relay failed: " + relayError });
				relayHeaders = new Headers({ "content-type": "application/json" });
			}
			dumpError = dumpError ?? writeIfConfigured(responsePath, responseText);

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
				stateKeys,
				stateBytes: bodyText.length,
				status,
				latencyMs: Date.now() - started,
				inputTokens,
				outputTokens,
				responseSummary: relayError === undefined ? responseSummary : `relay failed: ${relayError}`,
				...(requestPath === undefined ? {} : { requestPath }),
				...(responsePath === undefined ? {} : { responsePath }),
				...(dumpError === undefined ? {} : { dumpError }),
				...(relayError === undefined ? {} : { relayError }),
			});
			return new Response(responseText, { status, headers: relayHeaders });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1/systemone`,
		record,
		stop: () => server.stop(true),
	};
}
