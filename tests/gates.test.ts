import { describe, expect, test } from "bun:test";
import { completionGate, isConsequentialMutation, isNonMutatingCommand, isProposeCall, mutationGate, planArtifactUrl, proposeGate } from "../src/gates.js";
import { weightOf } from "../src/screen.js";
import { freshState, recordAcceptance, recordAction, registerSimple, registerTask, screenRequest, sha256, type JevState } from "../src/state.js";
import type { JevConfig } from "../src/types.js";
import { boundaryConfig } from "./helpers.js";

function config(overrides: Partial<JevConfig["gates"]> = {}): JevConfig {
	return boundaryConfig(overrides);
}

/** A state with a registered task and one consequential change behind it. */
function developed(): JevState {
	const state = freshState();
	registerTask(state, "Add the coverage report");
	recordAction(state, { tool: "write", target: "src/report.ts", excerpt: "wrote the report" });
	return state;
}

describe("T3 - what counts as a consequential change", () => {
	test("FR-18: working-tree changes are consequential, coordination and judge routes are not", () => {
		expect(isConsequentialMutation("write", { path: "src/a.ts" })).toBe(true);
		expect(isConsequentialMutation("write", { path: "vault://notes.md" })).toBe(true);
		expect(isConsequentialMutation("write", { path: "conflict://1" })).toBe(true);
		expect(isConsequentialMutation("edit", { paths: ["src/a.ts", "src/b.ts"] })).toBe(true);
		expect(isConsequentialMutation("ast_edit", { paths: ["src/a.ts"] })).toBe(true);
		expect(isConsequentialMutation("write", {})).toBe(true);
	});

	test("FR-18: the registered judge tools, agent messages and session artifacts pass", () => {
		expect(isConsequentialMutation("write", { path: "xd://jev_consult" })).toBe(false);
		expect(isConsequentialMutation("write", { path: "agent://helper" })).toBe(false);
		expect(isConsequentialMutation("write", { path: "local://x-plan.md" })).toBe(false);
		expect(isConsequentialMutation("write", { path: "proc://bg_1" })).toBe(false);
		expect(isConsequentialMutation("write", { path: "xd://read" })).toBe(false);
		expect(isConsequentialMutation("read", { path: "src/a.ts" })).toBe(false);
		expect(isConsequentialMutation("web_search", { query: "x" })).toBe(false);
	});

	test("FR-18: a mounted mutating device is consequential", () => {
		expect(isConsequentialMutation("write", { path: "xd://ast_edit", content: "{}" })).toBe(true);
		expect(isConsequentialMutation("write", { path: "xd://bash", content: "{}" })).toBe(true);
	});

	test("FR-18: a mutating shell command and a target under the legacy alias are consequential too", () => {
		expect(isConsequentialMutation("bash", { command: "rm -rf build" })).toBe(true);
		expect(isConsequentialMutation("write", { file_path: "src/a.ts", content: "x" })).toBe(true);
		expect(isProposeCall("write", { file_path: "xd://propose", content: "coverage-report" })).toBe(true);
		expect(isConsequentialMutation("write", { file_path: "xd://propose", content: "coverage-report" })).toBe(false);
	});

	test("FR-31: inspecting the working tree costs no boundary, even untriaged", () => {
		for (const command of [
			"git status",
			"git diff HEAD",
			"git log --oneline -5",
			"git show HEAD",
			"git rev-parse --show-toplevel",
			"git ls-files",
			"ls -la src",
			"cat package.json",
			"rg -n todo src",
			"grep -n x notes.txt",
			"wc -l src/a.ts",
			"pwd",
			"jq .name package.json",
		]) {
			expect({ command, consequential: isConsequentialMutation("bash", { command }) }).toEqual({ command, consequential: false });
		}
	});

	test("FR-31: staging and publishing cost no boundary either", () => {
		for (const command of [
			"git add -A",
			"git add src/a.ts && git commit -m 'feat: add a'",
			"git commit -am wip",
			"git push",
			"git push -u origin master",
			"git fetch --prune",
		]) {
			expect({ command, consequential: isConsequentialMutation("bash", { command }) }).toEqual({ command, consequential: false });
		}
	});

	test("FR-31: a message's own punctuation and operators are data, not shell syntax", () => {
		expect(isConsequentialMutation("bash", { command: `git commit -m "feat(core): add a && b"` })).toBe(false);
		expect(isConsequentialMutation("bash", { command: `git commit -m 'fix: (v2) > 1'` })).toBe(false);
		expect(isConsequentialMutation("bash", { command: `git commit -m "afk while I run the tests; back in 10"` })).toBe(false);
	});

	test("FR-31: anything that reaches the working tree stays consequential", () => {
		for (const command of [
			"rm -rf build",
			"git checkout .",
			"git reset --hard HEAD",
			"git clean -fd",
			"git pull",
			"bun test",
			"node build.js",
			"sed -i s/a/b/ src/a.ts",
			"echo x > out.txt",
			"git status && rm -rf build",
			"ls | xargs rm",
			"unknown-command --flag",
			"ls -o out.txt",
			"git diff --output=patch.txt",
			"sort --output=sorted.txt notes.txt",
		]) {
			expect({ command, consequential: isConsequentialMutation("bash", { command }) }).toEqual({ command, consequential: true });
		}
	});

	test("FR-31: shell-capable reporting programs remain consequential", () => {
		for (const command of [
			"awk 'BEGIN {system(\"rm -rf build\")}'",
			"env rm -rf build",
			"printf '!rm -rf build\\n' | bc",
		]) {
			expect(isConsequentialMutation("bash", { command })).toBe(true);
		}
	});

	test("FR-31: a substitution, a redirection or a background operator is never read as reporting", () => {
		expect(isNonMutatingCommand("git commit -m \"$(cat msg)\"")).toBe(false);
		expect(isNonMutatingCommand("`rm -rf build`")).toBe(false);
		expect(isNonMutatingCommand("git log > log.txt")).toBe(false);
		expect(isNonMutatingCommand("cat x | tee y")).toBe(false);
		expect(isNonMutatingCommand("ls &")).toBe(false);
		expect(isNonMutatingCommand("git commit -m \"cost is ${PRICE}\"")).toBe(false);
	});
});

describe("T3 - the mutation gate", () => {
	test("FR-18: a session with no triage is held until the request is triaged", () => {
		const verdict = mutationGate(freshState(), config(), "write", { path: "src/a.ts" });

		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("jev_triage");
	});

	test("FR-02: a confirmed simple task passes the gate without the complex stages", () => {
		const state = freshState();
		state.simple = { fingerprint: sha256("Search the web for the release date"), request: "Search the web for the release date" };

		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(false);
	});

	test("FR-10, FR-18: read-only tools and judge routes stay free in an untriaged session", () => {
		const state = freshState();

		expect(mutationGate(state, config(), "read", { path: "src/a.ts" }).block).toBe(false);
		expect(mutationGate(state, config(), "web_search", { query: "release date" }).block).toBe(false);
		expect(mutationGate(state, config(), "write", { path: "xd://jev_consult", content: "{}" }).block).toBe(false);
		expect(mutationGate(state, config(), "write", { path: "local://x-plan.md", content: "# plan" }).block).toBe(false);
		expect(mutationGate(state, config(), "write", { path: "agent://helper", content: "status?" }).block).toBe(false);
	});

	test("FR-18: a registered development task is held until its plan is reviewed", () => {
		const state = freshState();
		registerTask(state, "Add the coverage report");

		const verdict = mutationGate(state, config(), "write", { path: "src/a.ts" });

		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("jev_plan_review");
		expect(verdict.reason).toContain("local://");
	});

	test("FR-11: a course check in flight holds consequential changes until its verdict returns", () => {
		const state = developed();
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://x-plan.md", planDigest: "d", confidence: 0.9 };
		state.checkPending = true;

		const verdict = mutationGate(state, config(), "write", { path: "src/a.ts" });

		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("course check");
	});

	test("FR-07: an approved plan opens the gate, and coordination writes stay open while it is shut", () => {
		const state = freshState();
		const task = registerTask(state, "Add the coverage report");

		expect(mutationGate(state, config(), "write", { path: "local://x-plan.md" }).block).toBe(false);
		expect(mutationGate(state, config(), "write", { path: "xd://jev_plan_review" }).block).toBe(false);
		expect(mutationGate(state, config(), "write", { path: "agent://helper" }).block).toBe(false);

		state.plan = { taskFingerprint: task.fingerprint, planUrl: "local://x-plan.md", planDigest: sha256("plan"), confidence: 0.9 };
		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(false);
	});

	test("an approval of another task does not open the gate", () => {
		const state = developed();
		state.plan = { taskFingerprint: sha256("some other task"), planUrl: "local://x-plan.md", planDigest: "d", confidence: 0.9 };

		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(true);
	});

	test("a finding holds consequential changes until it is consulted", () => {
		const state = developed();
		state.plan = { taskFingerprint: state.task?.fingerprint ?? "", planUrl: "local://x-plan.md", planDigest: "d", confidence: 0.9 };
		state.hold = { reason: 'the course check at revision 1 answered "off_course" (confidence 0.91)' };

		const verdict = mutationGate(state, config(), "write", { path: "src/a.ts" });

		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("off_course");
		expect(verdict.reason).toContain("jev_consult");
	});

	test("a disabled mutation gate holds nothing", () => {
		const state = freshState();
		registerTask(state, "Add the coverage report");

		expect(mutationGate(state, config({ mutation: false }), "write", { path: "src/a.ts" }).block).toBe(false);
	});
});

describe("T3 - the plan-mode proposal boundary", () => {
	test("a proposal without a plan review is blocked and names the artifact to review", () => {
		const state = freshState();
		registerTask(state, "Add the coverage report");
		const input = { path: "xd://propose", content: "coverage-report" };

		expect(isProposeCall("write", input)).toBe(true);
		expect(isProposeCall("read", input)).toBe(false);
		const verdict = proposeGate(state, config(), input);

		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("local://coverage-report-plan.md");
		expect(verdict.reason).toContain("jev_plan_review");
	});

	test("FR-02: a request triage confirmed simple proposes its plan without a plan review", () => {
		const state = freshState();
		registerSimple(state, "Write the release note");

		expect(proposeGate(state, config(), { path: "xd://propose", content: "release note" }).block).toBe(false);
	});

	test("a proposal with no slug is blocked", () => {
		const state = freshState();
		const verdict = proposeGate(state, config(), { path: "xd://propose", content: "   " });

		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("slug");
	});

	test("FR-07: a title that cannot be a file name is blocked with the same reason", () => {
		const verdict = proposeGate(freshState(), config(), { path: "xd://propose", content: "src/plan.md" });

		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("slug");
	});

	test("FR-07: the proposal title is normalized the way plan mode normalizes it", () => {
		const state = freshState();
		const task = registerTask(state, "Coverage report");
		state.plan = {
			taskFingerprint: task.fingerprint,
			planUrl: planArtifactUrl("Coverage-report"),
			planDigest: sha256("plan body"),
			confidence: 0.93,
		};

		const spaced = proposeGate(state, config(), { path: "xd://propose", content: "Coverage report" });

		expect(spaced.block).toBe(false);
		expect(spaced.url).toBe("local://Coverage-report-plan.md");
	});

	test("FR-07: a trailing -plan and a trailing .md in the title are not doubled", () => {
		const state = freshState();
		const task = registerTask(state, "Coverage report");
		state.plan = {
			taskFingerprint: task.fingerprint,
			planUrl: "local://coverage-report-plan.md",
			planDigest: "d",
			confidence: 0.9,
		};

		expect(proposeGate(state, config(), { path: "xd://propose", content: "coverage-report-plan" }).block).toBe(false);
		expect(proposeGate(state, config(), { path: "xd://propose", content: "coverage-report.md" }).block).toBe(false);
	});

	test("an approved artifact of the current task opens the boundary and reports its URL", () => {
		const state = freshState();
		const task = registerTask(state, "Add the coverage report");
		state.plan = {
			taskFingerprint: task.fingerprint,
			planUrl: planArtifactUrl("coverage-report"),
			planDigest: sha256("plan body"),
			confidence: 0.93,
		};

		const verdict = proposeGate(state, config(), { path: "xd://propose", content: "coverage-report" });

		expect(verdict.block).toBe(false);
		expect(verdict.url).toBe("local://coverage-report-plan.md");
	});

	test("a proposal of a different artifact than the approved one is blocked", () => {
		const state = freshState();
		const task = registerTask(state, "Add the coverage report");
		state.plan = { taskFingerprint: task.fingerprint, planUrl: planArtifactUrl("other"), planDigest: "d", confidence: 0.9 };

		const verdict = proposeGate(state, config(), { path: "xd://propose", content: "coverage report" });

		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("local://other-plan.md");
	});
});

describe("T5 - the completion boundary", () => {
	test("FR-17: a read-only session and a task that changed nothing never enter the gate", () => {
		expect(completionGate(freshState(), boundaryConfig()).applies).toBe(false);

		const state = freshState();
		registerTask(state, "Answer a question");
		expect(completionGate(state, boundaryConfig()).applies).toBe(false);
	});

	test("FR-14, FR-15: developed work cannot settle while an acceptance aspect is missing", () => {
		const state = developed();

		const gate = completionGate(state, boundaryConfig());

		expect(gate.applies).toBe(true);
		expect(gate.reason).toContain("business");
		expect(gate.reason).toContain("architecture");
		expect(gate.reason).toContain("jev_acceptance");

		recordAcceptance(state, { aspect: "business", revision: state.revision, label: "serves_business_need", approved: true, confidence: 0.9 });
		expect(completionGate(state, boundaryConfig()).reason).toContain("architecture");

		recordAcceptance(state, { aspect: "architecture", revision: state.revision, label: "sound_for_next_change", approved: true, confidence: 0.9 });
		expect(completionGate(state, boundaryConfig()).reason).toBeUndefined();
	});

	test("FR-23, FR-17: a released acceptance boundary satisfies the completion requirement", () => {
		const released = developed();
		released.released = ["acceptance:business"];
		recordAcceptance(released, { aspect: "architecture", revision: released.revision, label: "sound_for_next_change", approved: true, confidence: 0.9 });

		expect(completionGate(released, boundaryConfig()).reason).toBeUndefined();

		const held = developed();
		recordAcceptance(held, { aspect: "architecture", revision: held.revision, label: "sound_for_next_change", approved: true, confidence: 0.9 });

		expect(completionGate(held, boundaryConfig()).reason).toContain("business");
	});

	test("FR-14: a subsequent change invalidates a stale acceptance", () => {
		const state = developed();
		recordAcceptance(state, { aspect: "business", revision: state.revision, label: "serves_business_need", approved: true, confidence: 0.9 });
		recordAcceptance(state, { aspect: "architecture", revision: state.revision, label: "sound_for_next_change", approved: true, confidence: 0.9 });
		recordAction(state, { tool: "edit", target: "src/report.ts", excerpt: "more work" });

		expect(completionGate(state, boundaryConfig()).reason).toContain("business");
	});

	test("a finding holds the completion boundary as well", () => {
		const state = developed();
		state.hold = { reason: 'the developer review answered "defect"' };

		const gate = completionGate(state, boundaryConfig());

		expect(gate.applies).toBe(true);
		expect(gate.reason).toContain("defect");
	});

	test("a disabled completion gate lets the session settle", () => {
		expect(completionGate(developed(), config({ completion: false })).applies).toBe(false);
	});
});

describe("FR-21, FR-23 - unavailable or released boundaries stop holding changes", () => {
	test("FR-28: the triage and plan refusals name the call with its arguments and the boundary", () => {
		const state = freshState();
		const triage = mutationGate(state, config(), "write", { path: "src/a.ts" });
		const call = /Next call: jev_triage\((\{.*\})\)/.exec(triage.reason ?? "")?.[1];

		expect(call).toBeDefined();
		expect(JSON.parse(call ?? "")).toHaveProperty("request");
		expect(triage.boundary).toBe("triage");

		registerTask(state, "Report the coverage of the last run");
		const plan = mutationGate(state, config(), "write", { path: "src/a.ts" });

		expect(plan.reason).toContain("Next call: write local://<slug>-plan.md, then jev_plan_review(");
		expect(plan.boundary).toBe("plan");
	});


	test("FR-21: an unavailable judge stops holding the boundaries", () => {
		const state = freshState();
		state.judgeUnavailable = true;
		registerTask(state, "Report the coverage of the last run");

		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(false);
		expect(completionGate(state, boundaryConfig()).applies).toBe(false);
	});

	test("FR-23: a released boundary stops holding the changes it held", () => {
		const state = freshState();
		registerTask(state, "Report the coverage of the last run");
		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(true);

		state.released = ["plan"];

		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(false);
	});
});

describe("FR-30 - the request screen decides whether a request enters the workflow", () => {
	test("a request read as a publication, an inspection or a verification holds nothing", () => {
		const state = freshState();
		screenRequest(state, "закоммить и запушь текущее состояние");

		expect(mutationGate(state, config(), "bash", { command: "bun test" }).block).toBe(false);
		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(false);
		expect(proposeGate(state, config(), { path: "xd://propose", content: "coverage-report" }).block).toBe(false);
	});

	test("a request that changes the project waits for triage", () => {
		const state = freshState();
		screenRequest(state, "добавь отчёт по покрытию");

		expect(state.request?.weight).toBe("judged");
		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(true);
	});

	test("an unknown or unreadable request is judged rather than passed", () => {
		expect(weightOf("")).toBe("judged");
		expect(weightOf("сделай хорошо")).toBe("judged");
		expect(weightOf("implement the report")).toBe("judged");
		expect(weightOf("прогони тесты")).toBe("quiet");
		expect(weightOf("where is the parser defined?")).toBe("quiet");
		expect(weightOf("проверь и поправь форматирование")).toBe("judged");
		expect(mutationGate(freshState(), config(), "write", { path: "src/a.ts" }).block).toBe(true);
	});

	test("FR-30: change intent wins over a routine review signal", () => {
		expect(weightOf("review and improve parser")).toBe("judged");
	});

	test("the screen does not override a task that already entered the workflow", () => {
		const state = freshState();
		registerTask(state, "добавь отчёт по покрытию");
		screenRequest(state, "закоммить и запушь");

		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(true);
	});

	test("the judge's simple verdict opens the gate for a judged request", () => {
		const state = freshState();
		screenRequest(state, "добавь отчёт по покрытию");
		registerSimple(state, "добавь отчёт по покрытию");

		expect(mutationGate(state, config(), "write", { path: "src/a.ts" }).block).toBe(false);
	});

	test("a commit, a push and an inspection stay free with nothing recorded at all", () => {
		expect(mutationGate(freshState(), config(), "bash", { command: "git commit -am 'feat: x' && git push" }).block).toBe(false);
		expect(mutationGate(freshState(), config(), "bash", { command: "git status" }).block).toBe(false);
	});

	test("turning both gates off is how an owner asks for a quiet session", () => {
		const state = freshState();
		registerTask(state, "добавь отчёт по покрытию");

		expect(mutationGate(state, config({ mutation: false }), "write", { path: "src/a.ts" }).block).toBe(false);
		expect(proposeGate(state, config({ mutation: false }), { path: "xd://propose", content: "coverage-report" }).block).toBe(false);
		expect(completionGate(state, config({ completion: false })).applies).toBe(false);
	});
});
