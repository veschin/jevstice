import { expect, test } from "bun:test";
import { issueWork } from "../src/issueWork.js";
import type { Judge } from "../src/judge.js";

const noJudge: Judge = async () => { throw new Error("Deterministic issue verification called the judge"); };

const target = { platform: "gitlab", host: "git.example.test", destination: "team/sub/project" };
const title = "Export drops the final row";
const body = "Read CSV export after adding a row.\n";
const url = "https://git.example.test/team/sub/project/-/issues/12";
const query = "glab api --hostname git.example.test --paginate 'projects/team%2Fsub%2Fproject/issues?scope=all'";
const readback = { source: "glab api --hostname git.example.test projects/team%2Fsub%2Fproject/issues/12", quote: JSON.stringify({ web_url: url, iid: 12, title, description: body }) };
const verify = (source: string, quote: string) => source === readback.source && quote === readback.quote;

const input = { phase: "verify", target, title, body, readback };

test("only exact observed same-project readback confirms filing", async () => {
	expect((await issueWork(noJudge, input, verify)).details).toMatchObject({ kind: "reviewed", status: "filed", url });
	for (const wrong of [{ ...input, body: body.trim() }, { ...input, target: { ...target, destination: "team/project" } }, { ...input, readback: { ...readback, source: "unseen" } }]) {
		const result = await issueWork(noJudge, wrong, verify);
		expect(result.ok).toBeFalse();
		expect(result.details?.["status"]).not.toBe("filed");
	}
});

test("prepare resolves a known duplicate only from the observed same-target inventory", async () => {
	const inventory = {
		source: "native tracker list",
		quote: JSON.stringify({ target, query, issues: [{ title, body, url }] }),
	};
	const draft = { ...input, phase: "prepare", inventory, fields: [] };
	const observed = (source: string, quote: string) => source === inventory.source && quote === inventory.quote;
	expect((await issueWork(noJudge, draft, observed)).details).toMatchObject({ kind: "defect", status: "not_filed", duplicate: url });
	expect((await issueWork(noJudge, draft, verify)).details).toMatchObject({ kind: "unclear", status: "not_filed" });
});

test("prepare checks individual fields before the overall draft and flags the missing expected behavior", async () => {
	const inventory = {
		source: "native tracker list",
		quote: JSON.stringify({ target, query, issues: [] }),
	};
	const calls: string[][] = [];
	const judge: Judge = async (_, questions) => {
		calls.push(questions.map(question => question.name));
		return {
			ok: true,
			answers: questions.map(question => ({
				name: question.name, mode: "choice", confidence: 1,
				label: question.options?.["report_or_proposal"] ? "report_or_proposal" : "supported",
			})),
		};
	};
	const draft = {
		...input, phase: "prepare", inventory,
		fields: [{ kind: "observation", quote: title }, { kind: "reproduction", quote: body.trim() }],
	};
	const observed = (source: string, quote: string) => source === inventory.source && quote === inventory.quote;
	const result = await issueWork(judge, draft, observed);
	expect(calls).toEqual([["target", "inventory", "field_0", "field_1"], ["overall"]]);
	expect(result.details).toMatchObject({ kind: "defect", status: "not_filed", missing: ["expected"] });
});

test("developer reviews the GitHub observation separately from the proposed diagnosis", async () => {
	const target = { platform: "github", host: "github.example.test", destination: "team/project" };
	const observation = "Export reports two rows but writes only one.";
	const hypothesis = "The cache caused the missing row.";
	const body = `${observation}\n${hypothesis}`;
	const url = "https://github.example.test/team/project/issues/42";
	const readback = { source: "gh api --hostname github.example.test repos/team/project/issues/42", quote: JSON.stringify({ html_url: url, number: 42, title, body }) };
	const evidence = { source: "control run", quote: "Reproduced without the cache; exported one of two rows." };
	const observed = (source: string, quote: string) => [readback, evidence].some(ref => ref.source === source && ref.quote === quote);
	const judge: Judge = async (_, questions) => ({
		ok: true,
		answers: questions.map(({ name }) => ({ name, mode: "choice", label: "supported", confidence: 1 })),
	});
	const segments = [
		{ kind: "observation", quote: observation, disposition: "accept", basis: "Confirmed in the control run.", evidence: [evidence] },
		{ kind: "hypothesis", quote: hypothesis, disposition: "disagree", basis: "The failure also reproduced without the cache.", evidence: [evidence] },
	];
	const result = await issueWork(judge, { phase: "understand", target, title, body, readback, segments }, observed);
	expect(result.details).toMatchObject({ kind: "reviewed", url, segments: [
		{ kind: "observation", disposition: "accept", verdict: "supported" },
		{ kind: "hypothesis", disposition: "disagree", verdict: "supported" },
	] });
});
