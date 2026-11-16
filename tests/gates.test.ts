import { describe, expect, test } from "bun:test";
import {
	isConsequentialMutation,
	isNonMutatingCommand,
	isPublishingCommand,
	isReadOnlyCommand,
	targetOutsidePlan,
	type GateVerdict,
} from "../src/gates.js";
import type { PlanTopic } from "../src/types.js";

describe("T3 - what counts as a consequential change", () => {
	test("FR-18: working-tree changes are consequential, coordination and judge routes are not", () => {
		expect(isConsequentialMutation("write", { path: "src/a.ts" })).toBe(true);
		expect(isConsequentialMutation("write", { path: "vault://notes.md" })).toBe(true);
		expect(isConsequentialMutation("write", { path: "conflict://1" })).toBe(true);
		expect(isConsequentialMutation("edit", { paths: ["src/a.ts", "src/b.ts"] })).toBe(true);
		expect(isConsequentialMutation("ast_edit", { paths: ["src/a.ts"] })).toBe(true);
		expect(isConsequentialMutation("write", {})).toBe(true);
		// An opaque patch names no readable target, so it is a change.
		expect(isConsequentialMutation("edit", { patch: "*** Begin Patch\n*** Update File: src/a.ts" })).toBe(true);
	});

	test("FR-18: the registered judge tools, agent messages and session artifacts pass", () => {
		expect(isConsequentialMutation("write", { path: "xd://jev_consult" })).toBe(false);
		expect(isConsequentialMutation("write", { path: "agent://helper" })).toBe(false);
		expect(isConsequentialMutation("write", { path: "local://x-plan.md" })).toBe(false);
		expect(isConsequentialMutation("write", { path: "proc://bg_1" })).toBe(false);
		expect(isConsequentialMutation("write", { path: "xd://read" })).toBe(false);
		expect(isConsequentialMutation("read", { path: "src/a.ts" })).toBe(false);
		expect(isConsequentialMutation("web_search", { query: "x" })).toBe(false);
		expect(isConsequentialMutation("wait", {})).toBe(false);
	});

	test("an external artifact review never invalidates itself through its device route", () => {
		expect(isConsequentialMutation("jev_anti_slop", {})).toBe(false);
		expect(isConsequentialMutation("write", { path: "xd://jev_anti_slop", content: "{}" })).toBe(false);
	});

	test("FR-31: opaque execution is consequential - eval, delegation and device dispatch", () => {
		expect(isConsequentialMutation("eval", { language: "py", code: "print('read only')" })).toBe(true);
		expect(isConsequentialMutation("task", { context: "c", tasks: [{ task: "only read", solutionSpace: "one fix" }] })).toBe(true);
		expect(isConsequentialMutation("write", { path: "xd://eval", content: "{}" })).toBe(true);
		expect(isConsequentialMutation("write", { path: "xd://debug", content: "{}" })).toBe(true);
		expect(isConsequentialMutation("write", { path: "xd://mcp__google_sheets_update_cells", content: "{}" })).toBe(true);
	});

	test("FR-31: an LSP call that can apply an edit is consequential, a query is not", () => {
		expect(isConsequentialMutation("lsp", { action: "diagnostics", file: "src/a.ts" })).toBe(false);
		expect(isConsequentialMutation("lsp", { action: "references", file: "src/a.ts", line: 3, symbol: "x" })).toBe(false);
		expect(isConsequentialMutation("lsp", { action: "rename", file: "src/a.ts", new_name: "y" })).toBe(true);
		expect(isConsequentialMutation("lsp", { action: "code_actions", file: "src/a.ts", apply: true, query: "fix" })).toBe(true);
		expect(isConsequentialMutation("lsp", { action: "request", query: "textDocument/rename" })).toBe(true);
		expect(isConsequentialMutation("lsp", {})).toBe(true);
		expect(isConsequentialMutation("write", { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file: "src/a.ts" }) })).toBe(false);
		expect(isConsequentialMutation("write", { path: "xd://lsp", content: JSON.stringify({ action: "rename", file: "src/a.ts", new_name: "y" }) })).toBe(true);
	});

	test("FR-31: an unknown tool and an unknown MCP route are consequential, known reads are not", () => {
		expect(isConsequentialMutation("some_new_tool", { path: "src/a.ts" })).toBe(true);
		expect(isConsequentialMutation("mcp__google_sheets_update_cells", { spreadsheetId: "s", range: "A1", values: [] })).toBe(true);
		expect(isConsequentialMutation("mcp__some_mutating_server_tool", {})).toBe(true);
		expect(isConsequentialMutation("mcp__google_sheets_get_sheet_data", { spreadsheetId: "s" })).toBe(false);
	});

	test("FR-31: the parallel wrapper is judged by the calls it carries", () => {
		const write = { tool_uses: [{ recipient_name: "read", parameters: { path: "src/a.ts" } }, { recipient_name: "write", parameters: { path: "src/a.ts" } }] };
		const reads = { tool_uses: [{ recipient_name: "read", parameters: { path: "src/a.ts" } }, { recipient_name: "grep", parameters: { pattern: "x" } }] };

		expect(isConsequentialMutation("multi_tool_use.parallel", write)).toBe(true);
		expect(isConsequentialMutation("multi_tool_use.parallel", reads)).toBe(false);
		expect(isConsequentialMutation("multi_tool_use.parallel", {})).toBe(true);
	});

	test("FR-18: a mutating shell command and a target under the legacy alias are consequential too", () => {
		expect(isConsequentialMutation("bash", { command: "rm -rf build" })).toBe(true);
		expect(isConsequentialMutation("write", { file_path: "src/a.ts", content: "x" })).toBe(true);
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
			`od -c result.txt; echo "---"; wc -c result.txt; echo "---"; ls -la; echo "---"; test -e forbidden.txt && echo "FORBIDDEN EXISTS" || echo "forbidden.txt absent"`,
			"[ -f src/a.ts ] && echo yes",
		]) {
			expect({ command, consequential: isConsequentialMutation("bash", { command }) }).toEqual({ command, consequential: false });
		}
	});

	test("FR-31: staging and publishing cost no boundary either", () => {
		for (const command of [
			"git add -A",
			"git add src/a.ts && git commit -m update",
			"git commit -am wip",
			"git push",
			"git push -u origin master",
			"git fetch --prune",
		]) {
			expect({ command, consequential: isConsequentialMutation("bash", { command }) }).toEqual({ command, consequential: false });
		}
	});

	test("FR-31: harmless quoted arguments are literal, while quoted write options are not", () => {
		for (const command of [
			`git commit -m "feat(core): add a && b"`,
			`git commit -m 'fix: (v2) > 1'`,
			`git log --format="%h %s"`,
			`echo "a; b"`,
			`grep -n "x|y" notes.txt`,
		]) {
			expect({ command, consequential: !isNonMutatingCommand(command) }).toEqual({ command, consequential: false });
		}
		// Repository metadata is exempt from the ordinary tree classification, not from strict observation.
		expect(isReadOnlyCommand(`git commit -m "feat(core): add a && b"`)).toBe(false);
		expect(isNonMutatingCommand(`sort "-o" out.txt in.txt`)).toBe(false);
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
			"tree -o out.txt src",
			"git diff --output=patch.txt",
			"sort --output=sorted.txt notes.txt",
		]) {
			expect({ command, consequential: isConsequentialMutation("bash", { command }) }).toEqual({ command, consequential: true });
		}
	});

	test("FR-31: a quoted program, a path program and a positional output file stay consequential", () => {
		for (const command of [
			`"touch" true`,
			`'ls' -la`,
			`/tmp/ls -la`,
			`bin/cat package.json`,
			"xxd notes.bin notes.out",
			"sort -oout.txt notes.txt",
			`echo "'$(touch out.txt)'"`,
			`sort "-o" out.txt in.txt`,
			"uniq notes.txt notes.out",
			`ls; "touch" marker`,
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

	test("FR-31: the reported read-only compound commands are not changes", () => {
		const gitReport =
			`echo '=== commits only local ==='; git log --oneline --no-decorate FETCH_HEAD..HEAD; echo; echo '=== diff stat github..local ==='; git diff --stat FETCH_HEAD..HEAD; echo; echo '=== changed paths ==='; git diff --name-status FETCH_HEAD..HEAD`;
		const boundPath =
			`S=~/.omp/agent/managed-skills/confluence/scripts/confluence; wc -l $S; rg -n 'expand|page\\)|body\\)|REST|rest/api' $S | head -40`;

		expect(isNonMutatingCommand(gitReport)).toBe(true);
		expect(isReadOnlyCommand(gitReport)).toBe(true);
		expect(isPublishingCommand(gitReport)).toBe(false);
		expect(isNonMutatingCommand(boundPath)).toBe(true);
		// The leading assignment is an environment change, not a project read: strict observation stays closed.
		expect(isReadOnlyCommand(boundPath)).toBe(false);
	});

	test("FR-31: separators inside quotes stay literal, separators outside split segments", () => {
		for (const command of [
			"git log --oneline | wc -l",
			"git status && git diff --stat",
			"git diff || echo clean",
			"echo one; echo two; git show HEAD",
			`git log --oneline --grep='fix: (v2) > 1'`,
			`echo "a; b"`,
		]) {
			expect({ command, consequential: !isNonMutatingCommand(command) }).toEqual({ command, consequential: false });
		}
	});

	test("FR-31: a literal leading assignment is followed only where it is used", () => {
		expect(isNonMutatingCommand("S=src/a.ts; wc -l $S")).toBe(true);
		expect(isNonMutatingCommand(`S=src/a.ts; wc -l "$S"`)).toBe(true);
		expect(isNonMutatingCommand("S=src; rg -n todo $S | head -5")).toBe(true);
		expect(isNonMutatingCommand("wc -l $S")).toBe(false);
		// A skipped conditional reassignment leaves the name unknown, so it cannot hide a write flag.
		expect(isNonMutatingCommand("S=-o; false && S=ok; sort $S out.txt")).toBe(false);
		expect(isNonMutatingCommand("S=ok; false && S=-o; sort $S out.txt")).toBe(false);
		// A pipeline assignment runs in a subshell and never reaches the next command.
		expect(isNonMutatingCommand("S=src/a.ts | cat; wc -l $S")).toBe(false);
	});

	test("FR-31: reporting programs keep their own write and exec options", () => {
		for (const command of [
			"sort -o out.txt notes.txt",
			"sort -oout.txt notes.txt",
			"sort --output=out.txt notes.txt",
			"tree -o out.txt src",
			"file -C -m magic",
			"rg --pre 'rm -rf build' pattern .",
			"sort --compress-program='touch out.txt' notes.txt",
			"git log --output=log.txt",
			"git diff --ext-diff",
		]) {
			expect({ command, consequential: !isNonMutatingCommand(command) }).toEqual({ command, consequential: true });
		}
		for (const command of ["grep -i todo notes.txt", "rg -i todo src", "grep -o 'x' notes.txt", "df --output=source", "ls -o notes.txt", "sort -k1 notes.txt"]) {
			expect({ command, consequential: !isNonMutatingCommand(command) }).toEqual({ command, consequential: false });
		}
	});

	test("FR-31: unknown expansions, substitution, redirection and dynamic programs stay consequential", () => {
		for (const command of [
			"wc -l $UNSET",
			"wc -l ${UNSET}",
			"wc -l ${S:-default}",
			`echo "$HOME"`,
			`echo "$(pwd)"`,
			"echo `pwd`",
			"ls < notes.txt",
			"git log 2>/dev/null",
			"ls &",
			"S=ls; $S -la",
			"S=grep; $S -n x notes.txt",
			"S=$(touch out.txt); echo done",
			"S=$UNSET; echo done",
			"echo $[1+1]",
		]) {
			expect({ command, consequential: !isNonMutatingCommand(command) }).toEqual({ command, consequential: true });
		}
		expect(isNonMutatingCommand("echo '$HOME'")).toBe(true);
		expect(isNonMutatingCommand('echo "\\$HOME"')).toBe(true);
	});

	test("FR-31: metadata and publication stay distinct from strict observation", () => {
		for (const command of ["git add -A", "git commit -m x", "git push"]) {
			expect(isNonMutatingCommand(command)).toBe(true);
			expect(isReadOnlyCommand(command)).toBe(false);
		}
		expect(isPublishingCommand("git push")).toBe(true);
		expect(isPublishingCommand("git push > /dev/null")).toBe(true);
		expect(isPublishingCommand("git diff --stat")).toBe(false);
		expect(isReadOnlyCommand("git log --oneline")).toBe(true);
	});
});

describe("effect classification is diagnostic, never an authorization", () => {
	const topics: PlanTopic[] = [
		{ id: "report", section: "## Report", paths: ["src/report.ts", "docs"], requirement: "write the report" },
	];

	test("a target inside an approved plan path is not outside it", () => {
		expect(targetOutsidePlan("write", "src/report.ts", topics)).toBe(false);
		expect(targetOutsidePlan("write", "src/report.ts/nested", topics)).toBe(false);
		expect(targetOutsidePlan("write", "docs", topics)).toBe(false);
	});

	test("an unrelated target is outside every approved path", () => {
		expect(targetOutsidePlan("write", "src/other.ts", topics)).toBe(true);
	});

	test("shell and opaque execution carry no path target, so they are never deviations by target", () => {
		expect(targetOutsidePlan("bash", "rm -rf src", topics)).toBe(false);
		expect(targetOutsidePlan("eval", "anything", topics)).toBe(false);
		expect(targetOutsidePlan("task", "anything", topics)).toBe(false);
	});

	test("without plan paths no target can be outside the plan", () => {
		expect(targetOutsidePlan("write", "src/anything.ts", [])).toBe(false);
		expect(targetOutsidePlan("write", "src/anything.ts", [{ ...topics[0]!, paths: [] }])).toBe(false);
	});

	test("GateVerdict remains the machine shape for host-reported diagnostics", () => {
		const verdict: GateVerdict = { block: true, boundary: "authority", reason: "outside the immutable envelope" };
		expect(verdict.block).toBe(true);
		expect(verdict.boundary).toBe("authority");
	});
});
