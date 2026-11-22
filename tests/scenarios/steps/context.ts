import { expect } from "bun:test";
import { copyFile, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextArchive, type ContextArchive, type ContextSource } from "../../../src/context.js";
import { createJevController } from "../../../src/controller.js";
import type { Judge, JudgeQuestion } from "../../../src/judge.js";
import { sha256 } from "../../../src/state.js";
import { asRecord } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	boundaryConfig,
	fakeArtifacts,
	fakeCtx,
	fakePi,
	fakeZod,
	toolCallEvent,
	toolDetails,
	toolFailed,
	toolResultEvent,
	toolText,
	until,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

/**
 * Steps for `scenarios/jev_context.feature`, scoped to that file. Every step drives the production
 * `jev_context` tool over `createContextArchive`, or the archive itself where the scenario is about
 * storage immutability.
 */

const { given, when, then } = scoped("jev_context.feature");

const QUESTION = "Does the recorded report contain coverage for the last run?";
const CONTEXT = "The recorded report covers the completed run.";
const TRUE_MEANING = "The recorded report contains coverage.";
const FALSE_MEANING = "The recorded report lacks coverage.";
const ARCHIVE_SEGMENTS = [".omp", "jev", "context"] as const;

/** The observable fields every step may read; the runner's world object is shared per scenario. */
interface Observed {
	ok: boolean;
	text: string;
	details?: Record<string, unknown>;
}

interface JudgeCall {
	state: unknown;
	questions: readonly JudgeQuestion[];
}

interface SequencedJudge {
	judge: Judge;
	calls: JudgeCall[];
}

interface Pending {
	promise: Promise<void>;
	resolve: () => void;
}

interface World {
	archive?: ContextArchive;
	cwd?: string;
	fake?: SequencedJudge;
	calls?: JudgeCall[];
	params?: Record<string, unknown>;
	result?: unknown;
	listResult?: unknown;
	judgment?: Promise<unknown>;
	judgmentResult?: unknown;
	first?: unknown;
	second?: unknown;
	outcome?: Observed;
	pi?: FakePi;
	ctx?: unknown;
	content?: string;
	problem?: string;
	stored?: ContextSource;
	readId?: string;
	owner?: ContextSource;
	plan?: ContextSource;
	currentRequest?: string;
	input?: Omit<ContextSource, "id" | "digest">;
	record?: ContextSource;
	duplicate?: ContextSource;
	recordPath?: string;
	firstBytes?: string;
	secondBytes?: string;
	sources?: Array<Record<string, unknown>>;
	readBack?: ContextSource;
	started?: Pending;
	release?: Pending;
	completedDuringJudgment?: boolean;
	[key: string]: unknown;
}

const world = (value: unknown): World => value as World;

function setup(value: unknown): World {
	const w = world(value);
	if (!Array.isArray(w.calls)) w.calls = [];
	return w;
}

const observed = (result: unknown): Observed => ({
	ok: !toolFailed(result),
	text: toolText(result),
	details: toolDetails(result),
});

const booleanConsult = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	mode: "boolean",
	question: QUESTION,
	context: CONTEXT,
	trueMeaning: TRUE_MEANING,
	falseMeaning: FALSE_MEANING,
	...extra,
});

const usableBoolean = { probability: 0.9, confidence: 0.95 };

const recordPath = (cwd: string, id: string): string => join(cwd, ...ARCHIVE_SEGMENTS, `${id}.json`);

const archiveDir = (cwd: string): string => join(cwd, ...ARCHIVE_SEGMENTS);

/** Start a controller over an archive; every judge call is recorded in the world. */
function controller(w: World, options: { judge?: Judge; archive?: ContextArchive } = {}): FakePi {
	const fake = options.judge === undefined ? answeringJudge({}) : undefined;
	w.fake ??= fake;
	const pi = fakePi();
	createJevController({
		judge: options.judge ?? fake!.judge,
		config: boundaryConfig(),
		zod: fakeZod(),
		...(options.archive === undefined ? {} : { context: options.archive }),
	}).register(pi.api);
	w.pi = pi;
	w.ctx = fakeCtx({ artifactsDir: w.cwd ?? null, sessionId: "session-1" });
	return pi;
}

async function submitConsult(w: World): Promise<void> {
	w.result = await w.pi!.callTool("jev_consult", w.params, w.ctx);
	w.outcome = observed(w.result);
	w.calls = [...(w.fake?.calls ?? [])];
}

// Background ---------------------------------------------------------------

given("ordinary Jev diagnostics are enabled", value => {
	// Diagnostics are the shipped default; only the world's observable collections are prepared.
	setup(value);
});

// Scenario 1 ---------------------------------------------------------------

given("this project has no archived sources and no recorded finding", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	controller(w, { archive: w.archive });
});

when("the executor calls jev_context with action list", async value => {
	const w = setup(value);
	w.result = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
	w.outcome = observed(w.result);
	w.calls = [...(w.fake?.calls ?? [])];
});

then("Jev returns no archived sources or findings", value => {
	const w = setup(value);
	expect(toolDetails(w.result)["sources"]).toEqual([]);
	expect(toolText(w.result)).toContain("[]");
});

then("the result claims no workflow approval", value => {
	const w = setup(value);
	expect(toolText(w.result)).not.toMatch(/approved|approval/i);
	expect(toolDetails(w.result)["approved"]).toBeUndefined();
	expect(toolDetails(w.result)["hold"]).toBeUndefined();
});

then("no judge request is made", value => {
	expect(setup(value).calls).toEqual([]);
});

// Scenario 2 ---------------------------------------------------------------

given("the archive holds an owner message and approved requirement and plan snapshots", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	w.owner = w.archive.put({
		kind: "owner",
		sessionId: "session-1",
		origin: "interactive",
		content: "Build the coverage report.",
		sequence: 1,
	});
	w.archive.put({
		kind: "requirements",
		sessionId: "session-1",
		origin: "judge_approved",
		content: JSON.stringify(["The report covers the last run."], null, 2),
		source: "jev_requirements",
		approval: "task-fingerprint-1234",
	});
	w.archive.put({
		kind: "plan",
		sessionId: "session-1",
		origin: "judge_approved",
		content: "# plan: collect the numbers",
		source: "local://x-plan.md",
		approval: "plan-digest-5678",
	});
	controller(w, { archive: w.archive });
});

when("the executor lists the archive", async value => {
	const w = setup(value);
	w.listResult = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
	w.result = w.listResult;
	w.outcome = observed(w.result);
	w.calls = [...(w.fake?.calls ?? [])];
});

then("each source has a stable sourceId, kind, origin, session and approval metadata", value => {
	const w = setup(value);
	const sources = toolDetails(w.listResult)["sources"] as Array<Record<string, unknown>>;
	expect(sources).toHaveLength(3);
	for (const source of sources) {
		expect(String(source["id"])).toMatch(/^[0-9a-f]{64}$/);
		expect(["owner", "requirements", "plan"]).toContain(String(source["kind"]));
		expect(["interactive", "rpc", "prompt", "judge_approved"]).toContain(String(source["origin"]));
		expect(source["sessionId"]).toBe("session-1");
	}
	const byKind = (kind: string): Record<string, unknown> | undefined => sources.find(source => source["kind"] === kind);
	expect(byKind("requirements")?.["approval"]).toBe("task-fingerprint-1234");
	expect(byKind("plan")?.["approval"]).toBe("plan-digest-5678");
	expect(byKind("owner")?.["approval"]).toBeUndefined();
});

then("the same unchanged sources retain their identifiers on another list call", async value => {
	const w = setup(value);
	const again = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
	const ids = (result: unknown): unknown[] =>
		(toolDetails(result)["sources"] as Array<Record<string, unknown>>).map(source => source["id"]);
	expect(ids(again)).toEqual(ids(w.listResult));
});

then("source content is not exposed by the list action", value => {
	const w = setup(value);
	const sources = toolDetails(w.listResult)["sources"] as Array<Record<string, unknown>>;
	for (const source of sources) expect(Object.hasOwn(source, "content")).toBe(false);
	expect(toolText(w.listResult)).not.toContain("Build the coverage report.");
	expect(toolText(w.listResult)).not.toContain("collect the numbers");
});

// Scenario 3 ---------------------------------------------------------------

given("an archived source contains Unicode, line breaks and more than a preview's length", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	w.content = `Owner line: привет 🌟\r\n${"×".repeat(1800)}\nFinal line.`;
	w.owner = w.archive.put({
		kind: "owner",
		sessionId: "session-1",
		origin: "interactive",
		content: w.content,
		sequence: 1,
	});
	controller(w, { archive: w.archive });
});

when("the executor reads that sourceId", async value => {
	const w = setup(value);
	w.result = await w.pi!.callTool("jev_context", { action: "read", sourceId: w.owner!.id }, w.ctx);
	w.outcome = observed(w.result);
	w.calls = [...(w.fake?.calls ?? [])];
});

then("the result contains the exact complete stored content and its digest", value => {
	const w = setup(value);
	const source = asRecord(toolDetails(w.result)["source"]);
	expect(source?.["content"]).toBe(w.content);
	expect(source?.["digest"]).toBe(sha256(w.content!));
	expect(toolText(w.result)).toContain("привет 🌟");
	expect(toolText(w.result).length).toBeGreaterThan(1800);
});

then("it identifies the source and its provenance", value => {
	const w = setup(value);
	const source = asRecord(toolDetails(w.result)["source"]);
	expect(source?.["id"]).toBe(w.owner?.id);
	expect(source?.["kind"]).toBe("owner");
	expect(source?.["origin"]).toBe("interactive");
	expect(source?.["sessionId"]).toBe("session-1");
});

// Scenario 4 ---------------------------------------------------------------

given("an archive record is {string}", async (value, problem) => {
	const w = setup(value);
	w.problem = problem;
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	const stored = w.archive.put({
		kind: "owner",
		sessionId: "session-1",
		origin: "interactive",
		content: "Original owner text.",
		sequence: 1,
	});
	w.stored = stored;
	w.readId = stored.id;
	const path = recordPath(w.cwd, stored.id);
	if (problem === "malformed JSON") {
		await writeFile(path, "{ not json", "utf8");
	} else if (problem === "missing or wrong digest") {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		parsed.digest = "0".repeat(64);
		await writeFile(path, JSON.stringify(parsed), "utf8");
	} else if (problem === "renamed under a different id") {
		w.readId = "f".repeat(64);
		await copyFile(path, recordPath(w.cwd, w.readId));
	} else if (problem === "reached through a symbolic link") {
		const target = join(w.cwd, "outside-record.json");
		await copyFile(path, target);
		await unlink(path);
		await symlink(target, path);
	} else if (problem === "an unrelated file in the archive") {
		await writeFile(join(archiveDir(w.cwd), "notes.txt"), "note content", "utf8");
	} else {
		throw new Error(`unknown archive problem: ${problem}`);
	}
	controller(w, { archive: w.archive });
});

when("the executor lists or reads the archive", async value => {
	const w = setup(value);
	if (w.problem === undefined) {
		// Scenario 10: an explicit judgment is blocked in the judge while the archive is read.
		let finished = false;
		const inspection = w.pi!.callTool("jev_context", { action: "list" }, w.ctx).then(result => {
			finished = true;
			return result;
		});
		w.completedDuringJudgment = await until(() => finished, 200);
		w.result = await inspection;
		if (!finished) w.release!.resolve();
		w.release!.resolve();
		w.judgmentResult = await w.judgment;
		w.outcome = observed(w.result);
		w.calls = [...(w.fake?.calls ?? [])];
		return;
	}
	w.listResult = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
	if (w.problem !== "an unrelated file in the archive") {
		w.result = await w.pi!.callTool("jev_context", { action: "read", sourceId: w.readId }, w.ctx);
	}
	w.outcome = observed(w.result ?? w.listResult);
	w.calls = [...(w.fake?.calls ?? [])];
});

then("the record is reported as invalid rather than returned", value => {
	const w = setup(value);
	const expected: Record<string, RegExp> = {
		"malformed JSON": /valid JSON/i,
		"missing or wrong digest": /digest/i,
		"renamed under a different id": /does not match requested source/i,
		"reached through a symbolic link": /symbolic link/i,
		"an unrelated file in the archive": /not a context record/i,
	};
	const results = [w.listResult, w.result].filter(result => result !== undefined);
	expect(results.length).toBeGreaterThan(0);
	for (const result of results) {
		const details = toolDetails(result);
		expect(details["source"]).toBeUndefined();
		expect(details["sources"]).toBeUndefined();
		const text = toolText(result);
		expect(text).toMatch(/unavailable|invalid/i);
		expect(text).toMatch(expected[w.problem!]!);
	}
});

then("no altered content is presented as the stored source", value => {
	const w = setup(value);
	const results = [w.listResult, w.result].filter(result => result !== undefined);
	for (const result of results) {
		expect(toolText(result)).not.toContain(w.stored!.content);
		expect(toolDetails(result)["source"]).toBeUndefined();
	}
});

then("no approval is restored from the archive", value => {
	const w = setup(value);
	const results = [w.listResult, w.result].filter(result => result !== undefined);
	for (const result of results) {
		// The controller records the failed inventory call itself as a diagnostic finding; that is not
		// an approval restored from the archive, and no source metadata or approval is returned.
		expect(toolDetails(result)["approval"]).toBeUndefined();
		expect(toolDetails(result)["source"]).toBeUndefined();
		expect(toolDetails(result)["sources"]).toBeUndefined();
		expect(toolText(result)).not.toMatch(/\bapproved\b/i);
	}
});

// Scenario 5 ---------------------------------------------------------------

given("evidence cites a sourceId with {string}", async (value, defect) => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	const owner = w.archive.put({
		kind: "owner",
		sessionId: "session-1",
		origin: "interactive",
		content: "The coverage report records the completed run.",
		sequence: 1,
	});
	const plan = w.archive.put({
		kind: "plan",
		sessionId: "session-1",
		origin: "judge_approved",
		content: "Plan: collect the numbers and report them.",
		source: "local://x-plan.md",
		approval: "plan-digest-5678",
	});
	w.owner = owner;
	w.plan = plan;
	let evidence: unknown[];
	if (defect === "a missing source id") {
		w.readId = "b".repeat(64);
		evidence = [{ kind: "user", sourceId: w.readId, quote: "The report is complete." }];
	} else if (defect === "a quote absent from the archived content") {
		evidence = [{ kind: "user", sourceId: owner.id, quote: "This sentence is not stored anywhere." }];
	} else if (defect === "owner kind claimed for a non-owner source") {
		evidence = [{ kind: "user", sourceId: plan.id, quote: "Plan: collect the numbers" }];
	} else if (defect === "an archive that cannot be read") {
		await rm(archiveDir(w.cwd), { recursive: true, force: true });
		await mkdir(join(w.cwd, ".omp", "jev"), { recursive: true });
		const outside = await fakeArtifacts({});
		await symlink(archiveDir(outside), join(w.cwd, ...ARCHIVE_SEGMENTS));
		w.readId = "c".repeat(64);
		evidence = [{ kind: "user", sourceId: w.readId, quote: "Any stored owner text." }];
	} else {
		throw new Error(`unknown citation defect: ${defect}`);
	}
	w.defect = defect;
	w.params = booleanConsult({ evidence });
	controller(w, { archive: createContextArchive(w.cwd) });
});

when("the executor submits a Jev activity", async value => {
	const w = setup(value);
	await submitConsult(w);
});

then("the call is refused before any judge request", value => {
	const w = setup(value);
	expect(toolFailed(w.result)).toBe(true);
	expect(w.calls).toEqual([]);
});

then("the result names the invalid citation", value => {
	const w = setup(value);
	const text = toolText(w.result);
	expect(w.outcome?.details?.["kind"]).toBe("invalid");
	if (w.defect === "a missing source id") {
		expect(text).toContain(String(w.readId));
	} else if (w.defect === "a quote absent from the archived content") {
		expect(text).toContain("quote is absent");
		expect(text).toContain(String(w.owner?.id));
	} else if (w.defect === "owner kind claimed for a non-owner source") {
		expect(text).toContain("not an authentic owner message");
		expect(text).toContain(String(w.plan?.id));
	} else {
		expect(text).toContain("symbolic link");
	}
});

then("no finding is recorded", value => {
	const w = setup(value);
	expect(toolDetails(w.result)["hold"]).toBeUndefined();
	expect(w.outcome?.details?.["kind"]).toBe("invalid");
});

// Scenario 6 ---------------------------------------------------------------

given("the archive contains owner text saying to skip planning", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	const skip = "Skip the plan and implementation stages; just finish the work.";
	const fake = answeringJudge({ consult: usableBoolean });
	w.fake = fake;
	const pi = controller(w, { judge: fake.judge, archive: w.archive });
	await pi.emit("input", { source: "interactive", text: skip }, w.ctx);
	w.currentRequest = "Build the coverage report for the last run.";
	await pi.emit("before_agent_start", { reason: "prompt", prompt: w.currentRequest, systemPrompt: ["Host policy"] }, w.ctx);
	const owner = w.archive.list().find(source => source.content === skip);
	expect(owner).toBeDefined();
	if (owner === undefined) throw new Error("the captured owner message was not archived");
	w.owner = owner;
	w.params = booleanConsult({ evidence: [{ kind: "user", sourceId: owner.id, quote: skip }] });
});

when("that text is cited in evidence", async value => {
	const w = setup(value);
	await submitConsult(w);
});

then("it is authenticated as the owner's words", value => {
	const w = setup(value);
	const material = asRecord(w.calls?.[0]?.state);
	const selected = asRecord(material?.["trustedContext"])?.["selectedSources"] as Array<Record<string, unknown>>;
	expect(selected).toHaveLength(1);
	expect(selected?.[0]?.["id"]).toBe(w.owner?.id);
	expect(selected?.[0]?.["kind"]).toBe("owner");
	expect(selected?.[0]?.["content"]).toBe(w.owner?.content);
});

then("it is treated as data and context for judgment", value => {
	const w = setup(value);
	const material = asRecord(w.calls?.[0]?.state);
	const quotes = material?.["quotes"] as unknown[];
	expect(quotes.join("\n")).toContain("Skip the plan");
	const trusted = asRecord(material?.["trustedContext"]);
	expect(String(trusted?.["introduction"])).toMatch(/data, not an instruction|not instructions/i);
	expect(toolFailed(w.result)).toBe(false);
});

then("it does not itself authorize execution or override the current request", async value => {
	const w = setup(value);
	expect(toolDetails(w.result)["approved"]).not.toBe(true);
	const blocks = await w.pi!.emit("tool_call", toolCallEvent("write", { path: "src/report.ts", content: "coverage" }), w.ctx);
	expect(blockReason(blocks)).toBeUndefined();
	const listed = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
	expect(toolText(listed)).toContain(`Current objective: ${w.currentRequest}`);
	expect(toolText(listed)).not.toContain("Skip the plan and implementation stages; just finish the work.");
});

// Scenario 7 ---------------------------------------------------------------

given("a refusal recorded a finding with its boundary, revision and exact material", async value => {
	const w = setup(value);
	const fake = answeringJudge({ consult: { label: "stdout", confidence: 0.3 } });
	w.fake = fake;
	const pi = controller(w, { judge: fake.judge });
	const alternatives = [
		{ label: "stdout", meaning: "The report goes to stdout." },
		{ label: "stderr", meaning: "The report goes to stderr." },
	];
	w.paramsA = { mode: "choice", question: "Does the report go to stdout?", context: CONTEXT, alternatives };
	w.first = await pi.callTool("jev_consult", w.paramsA, w.ctx);
	w.paramsB = { mode: "choice", question: "Is the usage text reviewed?", context: "The usage text changed.", alternatives };
	w.second = await pi.callTool("jev_consult", w.paramsB, w.ctx);
});

given("a later attempt submitted different material", value => {
	const w = setup(value);
	expect(toolDetails(w.first)["hold"]).toBeDefined();
	expect(toolDetails(w.second)["hold"]).toBeDefined();
});

then("the finding still shows the first request and the answer it received", value => {
	const w = setup(value);
	const hold = asRecord(toolDetails(w.result)["hold"]);
	expect(hold).toBeDefined();
	expect(hold?.["material"]).toBe(JSON.stringify(w.paramsA));
	expect(String(hold?.["material"])).toContain("Does the report go to stdout?");
	expect(hold?.["boundary"]).toBe("jev_consult");
	expect(hold?.["revision"]).toBe(0);
	const original = asRecord(hold?.["result"]);
	expect(String(original?.["text"])).toContain("Consult (choice)");
	expect(String(original?.["text"])).toContain("stdout");
});

then("the later attempt has not overwritten that original material", value => {
	const w = setup(value);
	const hold = asRecord(toolDetails(w.result)["hold"]);
	expect(hold?.["material"]).not.toBe(JSON.stringify(w.paramsB));
	const findings = toolDetails(w.result)["findings"] as Array<Record<string, unknown>>;
	expect(findings).toHaveLength(2);
	expect(findings[0]?.["material"]).toBe(JSON.stringify(w.paramsA));
	expect(findings[1]?.["material"]).toBe(JSON.stringify(w.paramsB));
	expect(hold?.["id"]).toBe(findings[0]?.["id"]);
});

then("reading it does not clear the finding", async value => {
	const w = setup(value);
	const hold = asRecord(toolDetails(w.result)["hold"]);
	const again = await w.pi!.callTool("jev_context", { action: "list" }, w.ctx);
	expect(asRecord(toolDetails(again)["hold"])).toEqual(hold);
});

// Scenario 8 ---------------------------------------------------------------

given("an identical source is stored twice", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	w.input = {
		kind: "owner",
		sessionId: "session-1",
		origin: "interactive",
		content: "immutable owner text\nwith a second line",
		sequence: 1,
	};
	w.record = w.archive.put(w.input);
	w.recordPath = recordPath(w.cwd, w.record.id);
	w.firstBytes = await readFile(w.recordPath, "utf8");
	w.duplicate = w.archive.put(w.input);
});

when("the archive is read", async value => {
	const w = setup(value);
	w.sources = createContextArchive(w.cwd!).list().map(source => ({ ...source }));
	w.readBack = createContextArchive(w.cwd!).read(w.record!.id);
	w.secondBytes = await readFile(w.recordPath!, "utf8");
});

then("one record is returned with the same id and bytes", value => {
	const w = setup(value);
	expect(w.sources).toHaveLength(1);
	expect(w.sources?.[0]?.["id"]).toBe(w.record?.id);
	expect(w.firstBytes).toBe(w.secondBytes);
	expect(w.readBack?.content).toBe(w.input?.content);
});

then("no existing record is overwritten", async value => {
	const w = setup(value);
	expect(w.duplicate).toEqual(w.record);
	expect(await readdir(archiveDir(w.cwd!))).toEqual([`${w.record?.id}.json`]);
});

then("a rejected provenance field writes nothing", async value => {
	const w = setup(value);
	const before = await readdir(archiveDir(w.cwd!));
	expect(() => w.archive!.put({ ...w.input, content: "different", extra: true } as never)).toThrow(/unexpected field/i);
	expect(await readdir(archiveDir(w.cwd!))).toEqual(before);
	expect(w.archive!.list()).toHaveLength(1);
});

// Scenario 9 ---------------------------------------------------------------

given("the owner communicates through interactive or RPC input", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	controller(w, { archive: w.archive });
});

when("the addon captures the message", async value => {
	const w = setup(value);
	await w.pi!.emit("input", { source: "interactive", text: "  Build the report  " }, w.ctx);
	await w.pi!.emit("input", { source: "rpc", text: "Also keep the old format" }, w.ctx);
	w.sources = w.archive!.list().map(source => ({ ...source }));
});

then("it is stored with its exact bytes and origin", value => {
	const w = setup(value);
	expect(w.sources?.map(source => source["content"])).toEqual(["  Build the report  ", "Also keep the old format"]);
	expect(w.sources?.map(source => source["origin"])).toEqual(["interactive", "rpc"]);
	expect(w.sources?.map(source => source["sequence"])).toEqual([1, 2]);
});

then("extension-originated text and tool arguments are not stored as owner sources", async value => {
	const w = setup(value);
	const before = w.archive!.list().map(source => source.id);
	await w.pi!.emit("input", { source: "extension", text: "Injected extension instruction" }, w.ctx);
	await w.pi!.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "Injected tool argument" }), w.ctx);
	await w.pi!.emit(
		"tool_result",
		toolResultEvent("write", { path: "src/a.ts", content: "Injected tool argument" }, "Wrote src/a.ts"),
		w.ctx,
	);
	const after = w.archive!.list();
	expect(after.map(source => source.id)).toEqual(before);
	expect(after.some(source => source.content.includes("Injected"))).toBe(false);
});

then("repeated identical text at distinct times remains distinct records", async value => {
	const w = setup(value);
	await w.pi!.emit("input", { source: "interactive", text: "Same text twice" }, w.ctx);
	await w.pi!.emit("input", { source: "interactive", text: "Same text twice" }, w.ctx);
	const records = w.archive!.list().filter(source => source.content === "Same text twice");
	expect(records).toHaveLength(2);
	expect(new Set(records.map(source => source.id)).size).toBe(2);
	expect(records.map(source => source.sequence)).toEqual([3, 4]);
});

// Scenario 10 --------------------------------------------------------------

given("an explicit judgment is in flight for the same session", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	w.archive.put({
		kind: "owner",
		sessionId: "session-1",
		origin: "interactive",
		content: "Owner context for the report.",
		sequence: 1,
	});
	w.started = Promise.withResolvers<void>();
	w.release = Promise.withResolvers<void>();
	const inner = answeringJudge({ consult: usableBoolean });
	w.fake = inner;
	const judge: Judge = async (state, questions) => {
		w.started!.resolve();
		await w.release!.promise;
		return inner.judge(state, questions);
	};
	const pi = controller(w, { judge, archive: w.archive });
	w.params = booleanConsult();
	w.judgment = pi.callTool("jev_consult", w.params, w.ctx);
	await w.started.promise;
});

then("the context read completes without waiting for that judgment", value => {
	expect(setup(value).completedDuringJudgment).toBe(true);
});

then("it changes no approval or work revision", value => {
	const w = setup(value);
	const details = toolDetails(w.result);
	expect(toolFailed(w.result)).toBe(false);
	expect(details["revision"]).toBe(0);
	expect(details["acceptance"]).toEqual([]);
	expect(details["hold"]).toBeUndefined();
	expect(details["approved"]).toBeUndefined();
	expect(toolDetails(w.judgmentResult)["revision"]).toBeUndefined();
});

then("it cannot be mistaken for the judgment's result", value => {
	const w = setup(value);
	const listed = toolDetails(w.result);
	expect(listed["mode"]).toBeUndefined();
	expect(listed["label"]).toBeUndefined();
	expect(listed["probability"]).toBeUndefined();
	expect(listed["submission"]).toBeUndefined();
	expect(listed["sources"]).toBeDefined();
	expect(toolText(w.result)).not.toContain("Consult (");
	expect(toolText(w.judgmentResult)).toContain("Consult (boolean)");
});

// Scenario 11 --------------------------------------------------------------

given("a cited source is intact and its exact quote is present", async value => {
	const w = setup(value);
	w.cwd = await fakeArtifacts({});
	w.archive = createContextArchive(w.cwd);
	const owner = w.archive.put({
		kind: "owner",
		sessionId: "session-1",
		origin: "interactive",
		content: "Repair the recorded coverage report.",
		sequence: 1,
	});
	w.owner = owner;
	w.params = booleanConsult({
		evidence: [{ kind: "user", sourceId: owner.id, quote: "Repair the recorded coverage report." }],
	});
	const fake = answeringJudge({ consult: usableBoolean });
	w.fake = fake;
	controller(w, { judge: fake.judge, archive: w.archive });
});

given("an unrelated archive record is corrupt", async value => {
	const w = setup(value);
	await writeFile(recordPath(w.cwd!, "0".repeat(64)), "{invalid", "utf8");
});

when("the executor submits a Jev activity citing the intact source", async value => {
	const w = setup(value);
	await submitConsult(w);
});

then("the activity proceeds to judgment with that source bound", value => {
	const w = setup(value);
	expect(toolFailed(w.result)).toBe(false);
	expect(w.calls).toHaveLength(1);
	const material = asRecord(w.calls?.[0]?.state);
	const selected = asRecord(material?.["trustedContext"])?.["selectedSources"] as Array<Record<string, unknown>>;
	expect(selected?.[0]?.["id"]).toBe(w.owner?.id);
	expect(selected?.[0]?.["content"]).toBe(w.owner?.content);
});

then("the archive problem is reported in the result details", value => {
	const w = setup(value);
	const problems = toolDetails(w.result)["contextProblems"];
	expect(Array.isArray(problems)).toBe(true);
	expect((problems as unknown[]).join("\n")).toContain("archive");
});

then("the intact citation is not rejected because of the unrelated record", value => {
	const w = setup(value);
	expect(toolDetails(w.result)["kind"]).toBeUndefined();
	expect(toolText(w.result)).toContain("Consult (boolean)");
	expect(toolText(w.result)).not.toMatch(/Diagnostic unavailable/);
});

// Diagnostic result lookup -------------------------------------------------

const LOOKUP_REQUEST = "Implement and verify the report count.";
const LOOKUP_CODE = "export const count = 1;";
const LOOKUP_OUTPUT = "1 pass, 0 fail";

given("an outcome check could not reach the judge and returned a result ID", async value => {
	const w = setup(value);
	const fake = answeringJudge({
		coverage: { probability: 0.95 },
		item_1: { probability: 0.95 },
		requirement_1: { label: "observed" },
		requirement_1_execution: { label: "evidence_2" },
		requirement_1_code: { label: "evidence_1" },
	});
	w.offline = true;
	const judge: Judge = (state, questions) => w.offline === true && questions.some(question => question.name === "requirement_1")
		? Promise.resolve({ ok: false, kind: "unavailable", problem: "offline" }) : fake.judge(state, questions);
	const pi = controller(w, { judge });
	await pi.emit("before_agent_start", { reason: "prompt", prompt: LOOKUP_REQUEST }, w.ctx);
	const requirements = await pi.callTool("jev_requirements", { items: [{ text: LOOKUP_REQUEST, source: LOOKUP_REQUEST }] }, w.ctx);
	const priorId = toolDetails(requirements)["resultId"];
	expect(typeof priorId).toBe("string");
	w.requirementResultId = priorId;
	await pi.emit("tool_result", toolResultEvent("write", { path: "report.ts", content: LOOKUP_CODE }, "Wrote report.ts"), w.ctx);
	await pi.emit("tool_result", toolResultEvent("bash", { command: "bun test report.test.ts" }, LOOKUP_OUTPUT), w.ctx);
	const first = toolDetails(await pi.callTool("jev_acceptance", { aspect: "outcome" }, w.ctx));
	expect(first["kind"]).toBe("unavailable");
	expect(typeof first["resultId"]).toBe("string");
	w.readId = first["resultId"] as string;
});

when("the judge recovers and the same work passes outcome acceptance", async value => {
	const w = setup(value);
	w.offline = false;
	const passed = toolDetails(await w.pi!.callTool("jev_acceptance", { aspect: "outcome" }, w.ctx));
	expect(passed["approved"]).toBe(true);
	expect(typeof passed["resultId"]).toBe("string");
	expect(passed["resultId"]).not.toBe(w.readId);
	w.passedResultId = passed["resultId"];
});

then("the latest result ID is listed as current", async value => {
	const w = setup(value);
	const list = toolDetails(await w.pi!.callTool("jev_context", { action: "list" }, w.ctx));
	const results = list["results"] as Array<Record<string, unknown>>;
	const current = results.find(result => result["id"] === w.passedResultId);
	expect(current).toMatchObject({ tool: "jev_acceptance/outcome", applicability: "current" });
});

when("the executor requests jev_context with action result and the previous ID as sourceId", async value => {
	const w = setup(value);
	w.result = await w.pi!.callTool("jev_context", { action: "result", sourceId: w.readId }, w.ctx);
});

then("the previous diagnostic is marked historical and linked to its requirement result", value => {
	const w = setup(value);
	expect(toolDetails(w.result)["result"]).toMatchObject({
		id: w.readId, tool: "jev_acceptance/outcome", applicability: "historical", prior: [w.requirementResultId],
	});
});

then("it retains the submitted code and execution observations and the unavailable verdict", value => {
	const w = setup(value);
	const recorded = toolDetails(w.result)["result"];
	expect(recorded).toMatchObject({
		status: "unavailable",
		result: { details: { kind: "unavailable" } },
	});
	const observations = asRecord(asRecord(recorded)?.["input"])?.["observations"];
	if (!Array.isArray(observations)) throw new Error("Expected retained code and execution observations");
	const code = asRecord(observations.find(item => asRecord(item)?.["kind"] === "code"));
	const execution = asRecord(observations.find(item => asRecord(item)?.["kind"] === "execution"));
	expect(code?.["quote"]).toContain(LOOKUP_CODE);
	expect(execution?.["quote"]).toContain(LOOKUP_OUTPUT);
});
