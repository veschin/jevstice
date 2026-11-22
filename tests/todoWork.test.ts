import { expect, test } from "bun:test";
import { todoWork } from "../src/todoWork.js";
import type { Judge } from "../src/judge.js";
import type { ToolOutcome } from "../src/types.js";

const judge: Judge = async () => { throw new Error("This path must not use the judge."); };
const plan = { source: "PLAN.md", quote: "Deliver repeatable imports, a summary, and cached previews." };
const requirements = [
	{ id: "R-import", source: "SPEC.md", quote: "Reimporting a document keeps exactly one stored record." },
	{ id: "R-summary", source: "SPEC.md", quote: "The summary shows the number of stored records." },
	{ id: "R-preview", source: "SPEC.md", quote: "The preview reuses the cached source." },
];
const check = { procedure: "Import the same document twice and count stored records.", wrongResult: "Two stored records." };
const input = { source: "import.config", quote: "unique=true" };
const fixture = () => ({
	version: 1,
	plan,
	requirements,
	epics: [
		{ id: "E-import", tasks: [{ id: "T-import", result: "Store exactly one record on reimport", requirements: ["R-import"], inputs: [input], check }] },
		{ id: "E-summary", tasks: [{ id: "T-summary", result: "Show the stored record count", requirements: ["R-summary"], check: { procedure: "Seed one record and compare summary count.", wrongResult: "Summary reports zero." }, needs: [{ id: "T-import", output: "Stored records" }] }] },
		{ id: "E-preview", tasks: [{ id: "T-preview", result: "Reuse the cached preview", requirements: ["R-preview"], check: { procedure: "Load the same preview twice and count source requests.", wrongResult: "A second source request." } }] },
	],
});
const execute = async (project: unknown, action = "resume", threshold?: number, observed = true, runLog = "", inputText = input.quote, reviewer = judge) => {
	const artifact = `# Project TODO\n\n\`\`\`jev-todo-v1\n${JSON.stringify(project, null, 2)}\n\`\`\`\n`;
	const sources = new Map([
		[plan.source, plan.quote], ["SPEC.md", requirements.map(row => row.quote).join("\n")], ["run.log", runLog], ["import.test.ts", "expect(storedRecords()).toHaveLength(1);"],
		[input.source, inputText],
		["PROJECT-TODO.md", observed ? artifact : `${artifact}\nEdited since it was observed.`],
	]);
	return await todoWork(reviewer, { action, source: "PROJECT-TODO.md", artifact, threshold }, (source, quote, whole) => {
		const text = sources.get(source);
		return whole ? text === quote : text?.includes(quote) === true;
	});
};
const tasksOf = (result: ToolOutcome) => result.details?.["tasks"] as Array<{ id: string; state: string; fingerprint: string }>;

test("resumption preserves unrelated evidence but invalidates changed prerequisites and their dependents", async () => {
	const project = fixture();
	const first = tasksOf(await execute(project));
	expect(first.map(row => [row.id, row.state])).toEqual([["T-import", "ready"], ["T-summary", "waiting"], ["T-preview", "ready"]]);
	const runLog = `jev-todo-v1 T-import ${first[0]!.fingerprint} verified\nPASS import: one stored record`;
	const report = { kind: "verified", fingerprint: first[0]!.fingerprint, procedure: check.procedure, observation: { source: "run.log", quote: runLog } };
	const archivedCandidate = { ...project.epics[0]!, tasks: [{ ...project.epics[0]!.tasks[0]!, report }] };
	const resumed = { ...project, epics: [archivedCandidate, ...project.epics.slice(1)] };
	expect(tasksOf(await execute(resumed, "resume", undefined, true, runLog)).map(row => row.state)).toEqual(["verified", "ready", "ready"]);
	expect((await execute(resumed, "cleanup", 2, true, runLog)).details?.["proposedArchive"]).toEqual([]);
	const cleanup = await execute(resumed, "cleanup", 1, true, runLog);
	expect(cleanup.details?.["proposedArchive"]).toEqual(["E-import"]);
	expect(cleanup.details?.["proposal"]).toEqual(expect.stringContaining('"archived": true'));
	expect(cleanup.details?.["proposal"]).toEqual(expect.stringContaining('"id": "T-import"'));
	expect(cleanup.details?.["preservedLinks"]).toEqual([{ from: "T-summary", to: "T-import" }]);
	const changedInput = await execute(resumed, "resume", undefined, true, runLog, `${input.quote}\nlegacy=true`);
	expect(tasksOf(changedInput).map(row => row.state)).toEqual(["unverified_source", "waiting", "ready"]);
	const archived = { ...resumed, epics: [{ ...archivedCandidate, archived: true }, ...resumed.epics.slice(1)] };
	expect((await execute(archived, "resume")).details).toMatchObject({ next: "T-preview", ready: ["T-preview"] });
	expect((await execute(resumed, "cleanup", undefined, true, runLog)).details).toMatchObject({ policyGap: true, proposal: null });
	const changed = { ...resumed, epics: [{ ...archivedCandidate, tasks: [{ ...archivedCandidate.tasks[0]!, result: "Store the original record and report a duplicate." }] }, ...project.epics.slice(1)] };
	const changedTasks = tasksOf(await execute(changed, "resume", undefined, true, runLog));
	expect(changedTasks.map(row => row.state)).toEqual(["ready", "waiting", "ready"]);
	expect(changedTasks[1]!.fingerprint).not.toBe(first[1]!.fingerprint);
	expect(changedTasks[2]!.fingerprint).toBe(first[2]!.fingerprint);
	const relabeled = { ...changed, epics: [{ ...changed.epics[0]!, tasks: [{ ...changed.epics[0]!.tasks[0]!, report: { ...report, fingerprint: changedTasks[0]!.fingerprint } }] }, ...changed.epics.slice(1)] };
	expect(tasksOf(await execute(relabeled, "resume", undefined, true, runLog))[0]?.state).toBe("ready");
	expect((await execute(resumed, "resume", undefined, false)).details?.["kind"]).toBe("unclear");
});

test("review distinguishes unsupported scope from an existing check and a misleading scenario", async () => {
	const original = fixture();
	const importTask = {
		...original.epics[0]!.tasks[0]!,
		check: { ...check, existing: { source: "import.test.ts", quote: "expect(storedRecords()).toHaveLength(1);" } },
	};
	const project = { ...original, epics: [{ id: "E-import", tasks: [
		importTask,
		{ id: "refactor", result: "Rename the helper", requirements: [], check },
		{ id: "scenario", result: "Demonstrate that a reimport does not duplicate records", requirements: ["R-import"],
			check: { procedure: "Given an existing document, when imported again, then the response is 200.", wrongResult: "Two records exist." } },
	] }, ...original.epics.slice(1)] };
	const reviewer: Judge = async (_, questions) => {
		const expected = { check_0: "reuse_existing", check_2: "weak_check", coverage_0: "covered" };
		return { ok: true, answers: questions.map(question => ({
			mode: "choice", name: question.name, confidence: 0.99,
			label: expected[question.name as keyof typeof expected] ?? Object.keys(question.options ?? {})[0],
		})) };
	};
	const result = await execute(project, "review", undefined, true, "", input.quote, reviewer);
	expect(result.details).toMatchObject({ kind: "defect", tasks: expect.arrayContaining([
		expect.objectContaining({ id: "T-import", check: { verdict: "reuse_existing", confidence: 0.99 } }),
		expect.objectContaining({ id: "refactor", necessity: { verdict: "unsupported_scope" } }),
		expect.objectContaining({ id: "scenario", check: { verdict: "weak_check", confidence: 0.99 } }),
	]) });
});
