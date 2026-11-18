import { expect } from "bun:test";
import { createJevController } from "../../../src/controller.js";
import { configPaths, DEFAULT_CONFIG, loadJevConfig } from "../../../src/config.js";
import { memoizedApiKeyResolver, resolveApiKey } from "../../../src/apikey.js";
import {
	createTypeSafeJudge,
	normalizeAnswers,
	type Judge,
	type JudgeOutcome,
	type JudgeQuestion,
} from "../../../src/judge.js";
import type { JevConfig } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	boundaryConfig,
	fakeCtx,
	fakePi,
	fakeZod,
	stopDecision,
	stopEvent,
	toolCallEvent,
	toolDetails,
	toolFailed,
	toolText,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/**
 * Steps for `scenarios/jev_configuration.feature`, scoped to that file. Configuration scenarios
 * drive `loadJevConfig`, `resolveApiKey`, `createTypeSafeJudge` and the controller boundary; every
 * assertion reads a value production code actually produced.
 */

const { given, when, then } = scoped("jev_configuration.feature");

const CWD = "/project";
const HOME = "/home/owner";
const KEY = "sk-live-owner-supplied";
const QUESTION: JudgeQuestion = {
	name: "probe",
	mode: "noul",
	instructions: "Does the submitted material support the probe?",
	trueMeaning: "the material supports it",
	falseMeaning: "the material does not support it",
};

interface ConfigWorld {
	files: Record<string, string>;
	readOrder: string[];
	config?: JevConfig;
	expectedProblemToken?: string;
	env: Record<string, string | undefined>;
	runKeyCommand: (command: string) => Promise<string>;
	resolvedKey?: string;
	judgeClientKey?: string;
	judgeState?: unknown;
	judgeOutcome?: JudgeOutcome;
	judgeCalls: number;
	calls: number;
	status?: string;
	notifications: string[];
	pi?: FakePi;
	ctx?: unknown;
	result?: unknown;
	blocks: unknown[];
	firstMissing?: string | undefined;
	secondResolved?: string | undefined;
	cwd?: string;
	failure?: string;
	resolver?: () => Promise<string | undefined>;
	releaseKey?: () => void;
}

const world = (value: unknown): ConfigWorld => value as ConfigWorld;

function setup(value: unknown): ConfigWorld {
	const w = world(value);
	if (w.files === undefined) {
		w.files = {};
		w.readOrder = [];
		w.env = {};
		w.runKeyCommand = async () => "";
		w.judgeCalls = 0;
		w.notifications = [];
	}
	return w;
}

function projectPath(): string {
	return configPaths({ cwd: CWD, home: HOME })[1] ?? "";
}

function userPath(): string {
	return configPaths({ cwd: CWD, home: HOME })[0] ?? "";
}

function load(w: ConfigWorld): JevConfig {
	w.config = loadJevConfig({
		cwd: CWD,
		home: HOME,
		read: path => {
			w.readOrder.push(path);
			return w.files[path] ?? null;
		},
	});
	return w.config;
}

function notificationContext(w: ConfigWorld): unknown {
	return {
		ui: { notify: (message: string) => w.notifications.push(message) },
		sessionManager: {
			getArtifactsDir: () => null,
			getSessionId: () => "session-1",
		},
	};
}

function controller(w: ConfigWorld, judge: Judge): FakePi {
	const pi = fakePi();
	createJevController({ judge, config: w.config ?? boundaryConfig(), zod: fakeZod() }).register(pi.api);
	w.pi = pi;
	return pi;
}

const CONSULT_PARAMS = {
	mode: "boolean",
	question: "Does the record contain coverage?",
	context: "The record contains coverage for the completed run.",
	trueMeaning: "The record contains coverage.",
	falseMeaning: "The record lacks coverage.",
};

// Background ---------------------------------------------------------------

given("no user or project configuration file exists", value => {
	const w = setup(value);
	w.files = {};
});

// Scenario 1 ---------------------------------------------------------------

when("the addon loads its configuration", value => {
	load(world(value));
});

then("anti-slop mode is advisory", value => {
	expect(world(value).config?.antiSlop.mode).toBe("advisory");
});

then("no mutation, completion or course-check schedule setting is active", value => {
	const config = world(value).config;
	expect(config).toBeDefined();
	expect(Object.keys(config ?? {}).sort()).toEqual(["antiSlop", "billing", "problems"]);
	expect(config).toEqual(DEFAULT_CONFIG);
});

then("the effective configuration contains no enforce mode", value => {
	expect(JSON.stringify(world(value).config)).not.toContain("enforce");
});

// Scenario 2 ---------------------------------------------------------------

given("the user file sets anti-slop off", value => {
	const w = setup(value);
	w.files[userPath()] = JSON.stringify({ antiSlop: { mode: "off" } });
});

given("the project file sets anti-slop advisory", value => {
	const w = setup(value);
	w.files[projectPath()] = JSON.stringify({ antiSlop: { mode: "advisory" } });
});

when("the configuration is loaded", value => {
	load(world(value));
});

then("the effective anti-slop mode is advisory", value => {
	expect(world(value).config?.antiSlop.mode).toBe("advisory");
});

then("the user file was read before the project file", value => {
	const w = world(value);
	expect(w.readOrder).toEqual([userPath(), projectPath()]);
});

// Scenario 3 ---------------------------------------------------------------

function legacyFile(key: string): string {
	switch (key) {
		case "gates.mutation":
			return JSON.stringify({ gates: { mutation: true } });
		case "gates.completion":
			return JSON.stringify({ gates: { completion: true } });
		case "courseCheck.mode":
			return JSON.stringify({ courseCheck: { mode: "strict" } });
		case "courseCheck.interval":
			return JSON.stringify({ courseCheck: { interval: 5 } });
		default:
			return "{}";
	}
}

given('the configuration file contains {string}', (value, key) => {
	const w = setup(value);
	w.files[projectPath()] = legacyFile(key);
	w.expectedProblemToken = undefined;
});

then("no execution or completion behavior changes", value => {
	const config = world(value).config;
	expect(config).toEqual(DEFAULT_CONFIG);
	expect(config?.problems).toEqual([]);
});

then("the diagnostic contract remains in force", value => {
	expect(world(value).config?.antiSlop.mode).toBe("advisory");
});

// Scenario 4 ---------------------------------------------------------------

given('a configuration file sets antiSlop.mode to "enforce"', value => {
	const w = setup(value);
	w.files[projectPath()] = JSON.stringify({ antiSlop: { mode: "enforce" } });
	w.expectedProblemToken = "antiSlop.mode";
});

then("the configuration records the file and the invalid key", value => {
	const w = world(value);
	const problems = w.config?.problems ?? [];
	expect(problems.length).toBeGreaterThan(0);
	expect(problems.join("\n")).toContain(projectPath());
	expect(problems.join("\n")).toContain(w.expectedProblemToken ?? "antiSlop.mode");
});

then("external findings are not described as a delivery gate", value => {
	const w = world(value);
	const rendered = `${JSON.stringify(w.config)}\n${(w.config?.problems ?? []).join("\n")}`;
	expect(rendered.toLowerCase()).not.toContain("delivery gate");
	expect(rendered.toLowerCase()).not.toContain("execution gate");
});

// Scenario 5 ---------------------------------------------------------------

given("the configuration supplies a balance and per-million token costs", value => {
	const w = setup(value);
	w.files[projectPath()] = JSON.stringify({
		billing: { balance: 12.5, inputCostPerMillion: 2, outputCostPerMillion: 8 },
	});
	w.config = load(w);
});

when("/jev-status reports usage", async value => {
	const w = world(value);
	const judge: Judge = async () => ({
		ok: true,
		answers: [{ name: "consult", mode: "noul", probability: 0.9, confidence: 0.9 }],
		usage: { inputTokens: 1_000_000, outputTokens: 2_000_000 },
	});
	const pi = controller(w, judge);
	const ctx = fakeCtx();
	const result = await pi.callTool("jev_consult", CONSULT_PARAMS, ctx);
	expect(toolFailed(result)).toBe(false);
	pi.callCommand("jev-status", "", ctx);
	w.status = pi.messages.filter(message => message.customType === "jev.status").at(-1)?.content;
});

then("estimated spend is computed from recorded judge tokens and configured costs", value => {
	expect(world(value).status).toContain("Estimated spend 18$");
});

then("the configured balance is labelled as configured", value => {
	expect(world(value).status).toContain("configured balance 12.5$");
});

then("no live provider balance is queried or claimed", value => {
	const status = world(value).status ?? "";
	expect(status.toLowerCase()).not.toContain("live");
	expect(status.toLowerCase()).not.toContain("queried");
});

// Scenario 6 ---------------------------------------------------------------

function invalidFile(content: string): { text: string; token: string } {
	switch (content) {
		case "text that is not valid JSON":
			return { text: "{ this is not json", token: "not valid JSON" };
		case "a top level that is not an object":
			return { text: "[]", token: "top level must be a JSON object" };
		case "antiSlop.mode with an unknown value":
			return { text: JSON.stringify({ antiSlop: { mode: "sometimes" } }), token: "antiSlop.mode" };
		case "billing.balance with a negative number":
			return { text: JSON.stringify({ billing: { balance: -3 } }), token: "billing.balance" };
		case "billing.inputCostPerMillion as a string":
			return { text: JSON.stringify({ billing: { inputCostPerMillion: "free" } }), token: "billing.inputCostPerMillion" };
		default:
			return { text: "{}", token: "" };
	}
}

given('a configuration file contains {string}', (value, content) => {
	const w = setup(value);
	const invalid = invalidFile(content);
	w.files[projectPath()] = invalid.text;
	w.expectedProblemToken = invalid.token;
});

then("the values already in force are retained", value => {
	const config = world(value).config;
	expect(config?.antiSlop).toEqual(DEFAULT_CONFIG.antiSlop);
	expect(config?.billing).toEqual(DEFAULT_CONFIG.billing);
});

then("the file and offending key are named", value => {
	const w = world(value);
	const problems = w.config?.problems ?? [];
	expect(problems.join("\n")).toContain(projectPath());
	expect(problems.join("\n")).toContain(w.expectedProblemToken ?? "");
});

then("configuration problems do not block ordinary work", async value => {
	const w = world(value);
	const pi = controller(w, answeringJudge({}).judge);
	const ctx = fakeCtx();
	const blocks = await pi.emit("tool_call", toolCallEvent("read", { path: "src/a.ts" }), ctx);
	expect(blockReason(blocks)).toBeUndefined();
});

// Scenario 7 ---------------------------------------------------------------

given("the loaded configuration recorded one or more problems", value => {
	const w = setup(value);
	w.files[projectPath()] = "{ not json";
	w.config = load(w);
	expect((w.config.problems ?? []).length).toBeGreaterThan(0);
});

when("a new session starts", async value => {
	const w = world(value);
	const pi = controller(w, answeringJudge({}).judge);
	w.ctx = notificationContext(w);
	await pi.emit("session_start", { type: "session_start" }, w.ctx);
	pi.callCommand("jev-status", "", w.ctx);
	w.status = pi.messages.filter(message => message.customType === "jev.status").at(-1)?.content;
});

then("the owner is notified of each exact problem in the owner-facing UI", value => {
	const w = world(value);
	expect(w.notifications.length).toBeGreaterThan(0);
	const notified = w.notifications.join("\n");
	for (const problem of w.config?.problems ?? []) expect(notified).toContain(problem);
});

then("configuration details are not sent as model content", value => {
	const w = world(value);
	expect(w.pi).toBeDefined();
	expect(w.pi?.messages.filter(message => message.customType === "jev.config")).toEqual([]);
});

then("the session continues with the retained effective values", async value => {
	const w = world(value);
	expect(w.status).toContain("Session mode: on");
	expect(w.config?.antiSlop.mode).toBe("advisory");
	const blocks = await w.pi!.emit("tool_call", toolCallEvent("read", { path: "src/a.ts" }), w.ctx);
	expect(blockReason(blocks)).toBeUndefined();
});

// Scenario 8 ---------------------------------------------------------------

given('{string} supplies a non-empty key', (value, source) => {
	const w = setup(value);
	switch (source) {
		case "the TYPESAFE_API_KEY environment value":
			w.env = { TYPESAFE_API_KEY: KEY };
			break;
		case "the JEVI_API_KEY environment value":
			w.env = { JEVI_API_KEY: KEY };
			break;
		case "the stdout of the configured key command":
			w.env = { TYPESAFE_API_KEY_COMMAND: "pass show token/jev" };
			w.runKeyCommand = async () => `  ${KEY}  \n`;
			break;
		default:
			throw new Error(`unknown key source: ${source}`);
	}
});

when("the judge resolves credentials", async value => {
	const w = world(value);
	w.resolvedKey = await resolveApiKey(w.env, w.runKeyCommand);
});

then("that value is used as the API key", async value => {
	const w = world(value);
	const judge = createTypeSafeJudge({
		resolveKey: async () => w.resolvedKey,
		createClient: apiKey => {
			w.judgeClientKey = apiKey;
			return {
				systemOne: async request => {
					w.judgeState = request.state;
					return { answers: { probe: { type: "noul", noul: 0.9 } } };
				},
			};
		},
	});
	const outcome = await judge({ material: "probe" }, [QUESTION]);
	expect(outcome.ok).toBe(true);
	expect(w.judgeClientKey).toBe(KEY);
	expect(w.resolvedKey).toBe(KEY);
});

then("it is not written to configuration, state, diagnostics or logs", value => {
	const w = world(value);
	const surfaces = [
		JSON.stringify(w.config ?? DEFAULT_CONFIG),
		JSON.stringify(w.judgeState),
		JSON.stringify(w.status ?? ""),
		JSON.stringify(w.notifications),
	].join("\n");
	expect(surfaces).not.toContain(KEY);
});

// Scenario 9 ---------------------------------------------------------------

given("no environment key is set and no key command produces a key", value => {
	const w = setup(value);
	w.env = { TYPESAFE_API_KEY_COMMAND: "pass show token/jev" };
	w.runKeyCommand = async () => "";
});

when("the executor calls a Jev tool", async value => {
	const w = world(value);
	const judge = createTypeSafeJudge({
		resolveKey: memoizedApiKeyResolver(w.env, w.runKeyCommand),
	});
	const pi = controller(w, judge);
	const ctx = fakeCtx();
	w.result = await pi.callTool("jev_consult", CONSULT_PARAMS, ctx);
	w.ctx = ctx;
});

then("the result states that no usable judge decision exists", value => {
	const w = world(value);
	expect(toolText(w.result)).toContain("No judge decision exists");
	expect(toolText(w.result)).toContain("no TypeSafe API key");
});

then("no approval, acceptance or trusted mark is recorded", value => {
	const details = toolDetails(world(value).result);
	expect(details["approved"]).toBe(false);
	expect(details["accepted"]).toBeUndefined();
	expect(details["trusted"]).toBeUndefined();
});

then("ordinary work and completion remain available under the host's permissions", async value => {
	const w = world(value);
	const pi = w.pi!;
	const blocks = await pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "x" }), w.ctx);
	expect(blockReason(blocks)).toBeUndefined();
	const stop = await pi.emit("session_stop", stopEvent(), w.ctx);
	expect(stopDecision(stop)).toBeUndefined();
});

// Scenario 10 --------------------------------------------------------------

given("the key command failed on an earlier call", async value => {
	const w = setup(value);
	w.env = { TYPESAFE_API_KEY_COMMAND: "pass show token/jev" };
	let available = false;
	w.resolver = memoizedApiKeyResolver(w.env, async () => {
		if (!available) throw new Error("gpg: decryption failed");
		return KEY;
	});
	w.releaseKey = () => {
		available = true;
	};
	w.firstMissing = await w.resolver();
});

when("a key becomes available before the next Jev call", async value => {
	const w = world(value);
	w.releaseKey?.();
	w.secondResolved = await w.resolver?.();
});

then("the next call resolves credentials again", value => {
	const w = world(value);
	expect(w.firstMissing).toBeUndefined();
	expect(w.secondResolved).toBe(KEY);
});

then("the earlier failure did not poison the session", async value => {
	const w = world(value);
	let available = false;
	const resolve = memoizedApiKeyResolver(w.env, async () => {
		if (!available) throw new Error("gpg: decryption failed");
		return KEY;
	});
	const judge = createTypeSafeJudge({
		resolveKey: resolve,
		createClient: () => ({ systemOne: async () => ({ answers: { probe: { type: "noul", noul: 0.9 } } }) }),
	});
	const first = await judge({ material: "probe" }, [QUESTION]);
	expect(first.ok).toBe(false);
	available = true;
	const second = await judge({ material: "probe" }, [QUESTION]);
	expect(second.ok).toBe(true);
});

// Scenario 11 --------------------------------------------------------------

function judgeFailureAnswers(failure: string): JudgeOutcome {
	switch (failure) {
		case "a transport or authentication error":
			return { ok: false, kind: "unavailable", problem: "the judge service did not answer" };
		case "a missing required answer":
			return normalizeAnswers([QUESTION], { answers: {} });
		case "an answer for an unexpected question":
			return normalizeAnswers([QUESTION], { answers: { probe: { type: "noul", noul: 0.9 }, extra: { type: "noul", noul: 0.9 } } });
		case "a probability outside zero to one":
			return normalizeAnswers([QUESTION], { answers: { probe: { type: "noul", noul: 1.4 } } });
		case "an unsupported answer shape":
			return normalizeAnswers([QUESTION], { answers: { probe: { type: "score", score: 1 } } });
		default:
			throw new Error(`unknown judge failure: ${failure}`);
	}
}

given('the judge returns {string}', (value, failure) => {
	const w = setup(value);
	w.failure = failure;
	w.judgeOutcome = judgeFailureAnswers(failure);
});

when("a valid activity consumes the outcome", async value => {
	const w = world(value);
	const outcome = w.judgeOutcome;
	if (outcome === undefined) throw new Error("no judge outcome was prepared");
	const judge: Judge = async () => outcome;
	const pi = controller(w, judge);
	const ctx = fakeCtx();
	w.result = await pi.callTool("jev_consult", CONSULT_PARAMS, ctx);
});

then("the result is recorded as unavailable or unusable as appropriate", value => {
	const w = world(value);
	const outcome = w.judgeOutcome;
	expect(outcome).toBeDefined();
	if (outcome === undefined) return;
	expect(outcome.ok).toBe(false);
	if (outcome.ok) return;
	if (w.failure === "a transport or authentication error") expect(outcome.kind).toBe("unavailable");
	else expect(outcome.kind).toBe("unusable");
	expect(toolText(w.result)).toContain("No judge decision exists");
	expect(toolDetails(w.result)["kind"]).toBe("unavailable");
});

then("the work is not called defective", value => {
	const w = world(value);
	expect(toolText(w.result).toLowerCase()).not.toContain("class: defect");
	expect(toolText(w.result).toLowerCase()).toContain("not a defect");
	expect(toolDetails(w.result)["kind"]).not.toBe("defect");
});

then("no effect is authorized by the failed judgment", value => {
	const details = toolDetails(world(value).result);
	expect(details["approved"]).toBe(false);
	expect(toolText(world(value).result).toLowerCase()).not.toContain("authorizes");
});

// Scenario 12 --------------------------------------------------------------

given("the extension is loaded in a running host process", value => {
	const w = setup(value);
	w.files[projectPath()] = JSON.stringify({ antiSlop: { mode: "advisory" } });
	w.config = load(w);
});

when("an owner edits the configuration or the extension source", value => {
	const w = world(value);
	w.files[projectPath()] = JSON.stringify({ antiSlop: { mode: "off" } });
});

then("the loaded process keeps its current schemas and configuration", value => {
	const w = world(value);
	expect(w.config?.antiSlop.mode).toBe("advisory");
});

then("the changed behavior applies after the host is restarted", value => {
	const w = world(value);
	const restarted = loadJevConfig({
		cwd: CWD,
		home: HOME,
		read: path => w.files[path] ?? null,
	});
	expect(restarted.antiSlop.mode).toBe("off");
});

then("no reload is claimed without observing the new process", value => {
	const w = world(value);
	expect(w.config?.antiSlop.mode).toBe("advisory");
	expect(JSON.stringify(w.config)).not.toContain('"off"');
});
