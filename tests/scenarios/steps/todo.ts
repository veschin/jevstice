import { expect } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createJevController } from "../../../src/controller.js";
import type { JudgeQuestion } from "../../../src/judge.js";
import { asRecord } from "../../../src/types.js";
import { answeringJudge, boundaryConfig, fakeArtifacts, fakeCtx, fakePi, fakeZod, toolDetails, toolResultEvent, toolText, type FakePi } from "../../helpers.js";
import { scoped } from "../registry.js";

const { given, when, then } = scoped("jev_todo.feature");
const plan = { source: "PLAN.md", quote: "Keep imports unique, report the stored count, and reuse preview data." };
const requirements = [
	{ id: "R-import", source: "SPEC.md", quote: "Reimporting the same document retains exactly one stored record." },
	{ id: "R-summary", source: "SPEC.md", quote: "The summary displays the number of stored records." },
	{ id: "R-preview", source: "SPEC.md", quote: "The preview reuses its cached source." },
];
const config = { source: "import.config:raw", quote: "unique=true\n" };
const existing = { source: "import.test.ts", quote: "expect(storedRecords()).toHaveLength(1);" };
const importCheck = { procedure: "Reimport the same document and count stored records.", wrongResult: "Two records are stored for one document." };

interface TodoTask {
	id: string;
	result: string;
	requirements: string[];
	needs?: { id: string; output: string }[];
	inputs?: { source: string; quote: string }[];
	check: { procedure: string; wrongResult: string; existing?: { source: string; quote: string } };
	report?: { kind: "verified"; fingerprint: string; procedure: string; observation: { source: string; quote: string } };
}
interface TodoProject {
	version: number;
	plan: typeof plan;
	requirements: typeof requirements;
	epics: { id: string; tasks: TodoTask[] }[];
}
interface TodoWorld {
	pi: FakePi;
	ctx: unknown;
	judgeCalls: { state: unknown; questions: readonly JudgeQuestion[] }[];
	project: TodoProject;
	latest: unknown;
	unchanged: boolean;
	originalFingerprints?: { summary: string; preview: string };
}

const world = (value: unknown): TodoWorld => value as TodoWorld;
const projectFixture = (): TodoProject => ({
	version: 1, plan, requirements,
	epics: [
		{ id: "E-import", tasks: [{ id: "T-import", result: "Retain one record on reimport", requirements: ["R-import"], inputs: [config], check: { ...importCheck } }] },
		{ id: "E-summary", tasks: [{ id: "T-summary", result: "Report the stored record count", requirements: ["R-summary"],
			needs: [{ id: "T-import", output: "Stored records" }], check: { procedure: "Seed one record and read the summary.", wrongResult: "A summary count of zero." } }] },
		{ id: "E-preview", tasks: [{ id: "T-preview", result: "Reuse the cached preview data", requirements: ["R-preview"],
			check: { procedure: "Load the preview twice and count requests to the source.", wrongResult: "A second source request." } }] },
	],
});
const details = (w: TodoWorld) => toolDetails(w.latest);
const read = async (w: TodoWorld, path: string, text: string) => {
	await w.pi.emit("tool_result", toolResultEvent("read", { path }, text), w.ctx);
};
const submit = async (w: TodoWorld, action: string, options: { threshold?: number; evidence?: string } = {}) => {
	const artifact = `# Project TODO\n\n\`\`\`jev-todo-v1\n${JSON.stringify(w.project, null, 2)}\n\`\`\`\n`;
	const current = options.evidence === "bytes that no longer match" ? `${artifact}\nUpdated after the prior read.\n` : artifact;
	const dir = await fakeArtifacts({ "TODO.md": current });
	try {
		const path = join(dir, "local", "TODO.md");
		const before = await readFile(path);
		const ranged = options.evidence === "a ranged read";
		const source = ranged ? `${path}:1-2:raw` : `${path}:raw`;
		const text = before.toString("utf8");
		await read(w, source, ranged ? text.split("\n").slice(0, 2).join("\n") : text);
		w.latest = await w.pi.callTool("jev_todo", {
			action, source, threshold: options.threshold, ...(options.evidence === undefined ? {} : { artifact }),
		}, w.ctx);
		w.unchanged = before.equals(await readFile(path));
		return details(w);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};
const fingerprint = (w: TodoWorld, id: string): string => {
	const tasks = details(w)["tasks"] as { id: string; fingerprint?: unknown }[];
	const value = tasks.find(row => row.id === id)?.fingerprint;
	if (typeof value !== "string") throw new Error(`No fingerprint for ${id}`);
	return value;
};
const recordImportReceipt = async (w: TodoWorld, observed = true) => {
	await submit(w, "resume");
	const task = w.project.epics[0]!.tasks[0]!;
	const current = fingerprint(w, task.id);
	const observation = { source: "run.log", quote: `jev-todo-v1 ${task.id} ${current} verified\nPASS reimport: one stored record` };
	if (observed) await read(w, observation.source, observation.quote);
	task.report = { kind: "verified", fingerprint: current, procedure: importCheck.procedure, observation };
	await submit(w, "resume");
};

given("an import backlog with a summary that needs verified import records and an independent preview task", async raw => {
	const w = world(raw);
	w.pi = fakePi();
	w.ctx = fakeCtx();
	w.project = projectFixture();
	const label = (value: string) => ({ label: value, confidence: 1 });
	const answers = answeringJudge({
		inventory: label("complete"),
		coverage_0: label("covered"), coverage_1: label("covered"), coverage_2: label("covered"),
		necessity_0: label("required"), necessity_1: label("required"), necessity_2: label("required"), necessity_3: label("required"), necessity_4: label("required"),
		check_0: question => label(question.options?.["reuse_existing"] ? "reuse_existing" : "falsifiable"),
		check_1: label("falsifiable"), check_2: question => label(question.instructions.includes('"T-status"') ? "weak_check" : "falsifiable"),
		check_3: label("falsifiable"), check_4: label("falsifiable"),
		dependencies_0: label("necessary"), dependencies_1: label("necessary"), dependencies_2: label("necessary"), dependencies_3: label("necessary"), dependencies_4: label("necessary"),
		duplicate_1: label("distinct"), duplicate_2: label("distinct"), duplicate_3: label("distinct"), duplicate_4: label("distinct"),
	});
	w.judgeCalls = answers.calls;
	createJevController({ judge: answers.judge, config: boundaryConfig(), zod: fakeZod() }).register(w.pi.api);
	await w.pi.emit("before_agent_start", { reason: "prompt", prompt: "Review and resume the import project backlog." }, w.ctx);
	await read(w, plan.source, plan.quote);
	await read(w, "SPEC.md", requirements.map(row => row.quote).join("\n"));
	await read(w, config.source, config.quote);
});

given("an observed executable check would catch duplicate records", async raw => {
	const w = world(raw);
	w.project.epics[0]!.tasks[0]!.check.existing = existing;
	await read(w, existing.source, existing.quote);
});
given("another import check asserts only HTTP success while an unrelated rename has no requirement", raw => {
	world(raw).project.epics[0]!.tasks.push(
		{ id: "T-rename", result: "Rename the helper", requirements: [], check: { procedure: "Inspect the helper name.", wrongResult: "The old name is still in use." } },
		{ id: "T-status", result: "Show that reimport does not create a duplicate", requirements: ["R-import"],
			check: { procedure: "Reimport and assert that the response is HTTP 200.", wrongResult: importCheck.wrongResult } },
	);
});
given("the backlog cites but the session has not observed an executable check", raw => {
	world(raw).project.epics[0]!.tasks[0]!.check.existing = existing;
});
when("the developer asks Jev to review the backlog", async raw => { await submit(world(raw), "review"); });
const reviewedRow = (rows: unknown, id: string) => {
	if (!Array.isArray(rows)) throw new Error(`Expected review rows for ${id}`);
	return asRecord(rows.find(row => asRecord(row)?.["id"] === id));
};
then("Jev reports coverage for the import requirement and identifies the reusable executable check", raw => {
	const result = details(world(raw));
	expect(reviewedRow(result["coverage"], "R-import")).toEqual({ id: "R-import", tasks: ["T-import", "T-status"], verdict: "covered", confidence: 1 });
	expect(reviewedRow(result["tasks"], "T-import")).toMatchObject({ check: { verdict: "reuse_existing", confidence: 1 }, existing: { ...existing, observed: true } });
});
then("Jev flags the status-only check as weak and the rename as unsupported scope", raw => {
	const result = details(world(raw));
	expect(result["kind"]).toBe("defect");
	expect(reviewedRow(result["tasks"], "T-status")).toMatchObject({ check: { verdict: "weak_check", confidence: 1 }, wrongResult: importCheck.wrongResult });
	expect(reviewedRow(result["tasks"], "T-rename")).toMatchObject({ necessity: { verdict: "unsupported_scope" } });
});
then("Jev excludes the cited check from the judge material and does not recommend reuse", raw => {
	const w = world(raw);
	expect(w.judgeCalls).toHaveLength(1);
	expect(w.judgeCalls[0]?.questions.find(question => question.name === "check_0")?.options?.["reuse_existing"]).toBeUndefined();
	expect(JSON.stringify(w.judgeCalls[0]?.state)).not.toContain(existing.quote);
	const result = details(w);
	expect(result["kind"]).toBe("reviewed");
	expect(reviewedRow(result["tasks"], "T-import")).toMatchObject({ check: { verdict: "falsifiable", confidence: 1 }, existing: { ...existing, observed: false } });
});

when("the developer resumes from the current backlog without reports", async raw => { await submit(world(raw), "resume"); });
then("import is next, summary is waiting, and preview is independently ready", raw => {
	expect(details(world(raw))).toMatchObject({ kind: "reviewed", next: "T-import", ready: ["T-import", "T-preview"],
		tasks: [{ id: "T-import", state: "ready" }, { id: "T-summary", state: "waiting", waitingFor: ["T-import: Stored records (verified)"] }, { id: "T-preview", state: "ready" }] });
});
when("the developer records a current verified import receipt and resumes", async raw => recordImportReceipt(world(raw)));
const expectVerifiedImport = (w: TodoWorld) => {
	expect(details(w)).toMatchObject({ kind: "reviewed", next: "T-summary", ready: ["T-summary", "T-preview"], tasks: [
		{ id: "T-import", state: "verified", reportState: "applicable" }, { id: "T-summary", state: "ready" }, { id: "T-preview", state: "ready" },
	] });
};
then("import is verified and summary is next", raw => expectVerifiedImport(world(raw)));
when("the developer resumes with a matching import receipt whose output was never observed", async raw => recordImportReceipt(world(raw), false));
then("Jev marks the import receipt unobserved and keeps the summary waiting", raw => {
	expect(details(world(raw))).toMatchObject({ next: "T-import", ready: ["T-import", "T-preview"], tasks: [
		{ id: "T-import", state: "ready", reportState: "unobserved" }, { id: "T-summary", state: "waiting" }, { id: "T-preview", state: "ready" },
	] });
});
then("Jev does not ask the judge to decide readiness", raw => {
	expect(world(raw).judgeCalls).toHaveLength(0);
});
given("a current verified import receipt has made summary ready", async raw => {
	const w = world(raw);
	await recordImportReceipt(w);
	expectVerifiedImport(w);
});
when("the import result changes and the developer relabels the receipt with the new fingerprint but keeps the original output", async raw => {
	const w = world(raw);
	w.originalFingerprints = { summary: fingerprint(w, "T-summary"), preview: fingerprint(w, "T-preview") };
	const task = w.project.epics[0]!.tasks[0]!;
	const report = task.report!;
	task.result = "Retain one record and report that the import was repeated";
	await submit(w, "resume");
	const updated = fingerprint(w, task.id);
	expect(updated).not.toBe(report.fingerprint);
	task.report = { ...report, fingerprint: updated };
	await submit(w, "resume");
});
then("the import report is stale, summary is waiting again, and preview retains its fingerprint", raw => {
	const w = world(raw);
	const original = w.originalFingerprints;
	if (original === undefined) throw new Error("Capture the summary and preview fingerprints before changing the import result.");
	expect(details(w)).toMatchObject({ next: "T-import", ready: ["T-import", "T-preview"], tasks: [
		{ id: "T-import", state: "ready", reportState: "stale" }, { id: "T-summary", state: "waiting" }, { id: "T-preview", state: "ready" },
	] });
	expect(fingerprint(w, "T-summary")).not.toBe(original.summary);
	expect(fingerprint(w, "T-preview")).toBe(original.preview);
});
when("the developer attempts to resume using {string}", async (raw, evidence) => {
	await submit(world(raw), "resume", { evidence });
});
then("Jev requests a whole current read and does not select a next task", raw => {
	const w = world(raw);
	expect(details(w)["kind"]).toBe("unclear");
	expect(details(w)["next"]).toBeUndefined();
	expect(toolText(w.latest)).toContain("read the whole current project TODO artifact");
});
given("import and summary depend on one another", raw => {
	world(raw).project.epics[0]!.tasks[0]!.needs = [{ id: "T-summary", output: "Summary count" }];
});
then("Jev finds the cycle and selects only the unrelated preview task as ready", raw => {
	expect(details(world(raw))).toMatchObject({ kind: "defect", graph: { cycles: [["T-import", "T-summary", "T-import"]] },
		next: "T-preview", ready: ["T-preview"], tasks: [{ id: "T-import", state: "invalid" }, { id: "T-summary", state: "invalid" }, { id: "T-preview", state: "ready" }] });
});

when("cleanup is requested at the configured threshold of one completed epic", async raw => {
	await submit(world(raw), "cleanup", { threshold: 1 });
});
then("the proposal archives only the import epic and preserves summary's link to the import task", raw => {
	const w = world(raw);
	const result = details(w);
	expect(result).toMatchObject({ kind: "reviewed", completed: ["E-import"], proposedArchive: ["E-import"], preservedLinks: [{ from: "T-summary", to: "T-import" }] });
	const proposal = result["proposal"];
	if (typeof proposal !== "string") throw new Error("Expected a cleanup proposal");
	expect(proposal.startsWith("# Project TODO\n\n")).toBeTrue();
	const json = /^```jev-todo-v1\n([\s\S]*?)^```$/mu.exec(proposal)?.[1];
	if (json === undefined) throw new Error("The cleanup proposal did not preserve the backlog format");
	expect(JSON.parse(json)).toEqual({ ...w.project, epics: [
		{ ...w.project.epics[0], archived: true, archiveReason: expect.any(String) }, ...w.project.epics.slice(1),
	] });
});
then("the backlog file remains byte-for-byte unchanged", raw => {
	const w = world(raw);
	expect(w.unchanged).toBeTrue();
	expect(toolText(w.latest)).toContain("No files changed.");
});
when("cleanup is requested with {string}", async (raw, policy) => {
	const threshold = policy === "a threshold of two epics" ? 2 : undefined;
	await submit(world(raw), "cleanup", { threshold });
});
then("Jev reports one completed epic but no cleanup proposal and returns {string}", (raw, kind) => {
	expect(details(world(raw))).toMatchObject({ kind, completed: ["E-import"], proposedArchive: [], proposal: null, policyGap: kind === "unclear" });
});