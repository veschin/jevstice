---
name: jevstice
description: "Read at OMP session startup when the Jevstice addon is available. Use when deciding which Jev check to run, submitting evidence, or interpreting a Jevstice result."
---

# Jevstice

**Boundary:** Jev checks are advisory. Continue the owner's work under actual host permissions and supervisor limits. A verdict cannot authorize an effect, prevent ordinary completion, or substitute for verification.

## Current state

This skill follows the ordinary OMP workflow. The optional strict supervisor has a separate run contract.

## Call a check

Use the route advertised in the active session. In OMP 19.1 and later, run `<tool> --help` in `bash` to see the schema for a mounted command, then invoke it as a standalone command with `-j` and one shell-quoted JSON argument. Do not use a PTY or wrap the call in `eval`. Wait for any background result before using the verdict.

```bash
jev_context -j '{"action":"list"}'
```

If OMP lists a Jev tool directly, supply the same JSON arguments to that tool. If an older OMP session advertises an `xd://` device, use that session's advertised `read` and `write` route. OMP 19.1 removed that route.

Jev is the TypeSafe model. Jevstice submits selected context to `jev-latest` and receives a choice, a rubric score, or a yes probability. Choice and score confidence describe how concentrated the answer is; confidence is not the score or the probability that a claim is true. Jevstice applies check-specific thresholds and renders the diagnostic from the typed answer. The model does not supply a free-text rationale. Use the verdict class, named gap and cited material together. Do not submit credentials or private material that the owner has not authorized sending to TypeSafe.

## Ordinary project change

1. **Requirements.** Call `jev_requirements` before changing the project. Submit one independently checkable `text` per requested behavior with an exact `source` quote from the owner. Omit `request` to use the captured prompt. Keep implementation choices out of the obligations. For the request `Add a --dry-run flag and document it in help.`, the JSON arguments are:

   ```json
   {"items":[{"text":"--dry-run reports planned writes without writing any files.","source":"Add a --dry-run flag"},{"text":"The command's help explains --dry-run.","source":"document it in help"}]}
   ```

2. **Execute and verify.** Implement the requested behavior and exercise it through the actual interface. Preserve the changed code and the literal verification command and output in OMP tool results. For the example, exercise `--dry-run` in a disposable directory, check that the expected report appears and no file changes, and inspect `--help`. Verify after the last edit; a later edit clears retained execution evidence. An asynchronous launch is not its result.
3. **Outcome.** Call `jev_acceptance` with `{"aspect":"outcome"}`. Do not pass a hand-written claim in place of recorded observations. Without a registered plan, the check uses approved requirements and retained code and execution results. With a registered plan, it checks each task and runs integrated review only after all tasks pass on the same revision. Improve a vague task by giving it an observable outcome and a check. Assess evidence-backed cuts separately; keep anything required for the behavior.
4. **Report.** Correct a defect established by the evidence. Recheck only when a specific new observation addresses the gap. Report what ran and what it demonstrated separately from Jev's verdict and any unresolved finding. Do not add triage, staged planning, aspect acceptance, or developer review just to finish.

## Other work

| Situation | Check |
| --- | --- |
| Local read, search, or summary | Answer directly. Do not run routine project checks. |
| Research or requested fact-check | Use `jev_fact_check` on the exact draft. Give each assertion a verbatim draft quote, a self-contained statement preserving scope, and quotes from opened sources. Use the exact URL, path, or command OMP observed; search snippets are leads. Quote table headings, units, conditions, row and caption together, or use unambiguous source prose. Include counterevidence and distinguish factual support, relevance and coverage. A research reminder calls for an attempt, not a passing verdict. |
| External document, research output, or communication | Follow the editing protocol in `jev_anti_slop` and submit the exact revised artifact and all claims with evidence. Include premises and warrant for inferences and a falsifier for hypotheses. Use empty `rules` only when the built-in English or Russian rules suffice, and empty `claims` only for assertion-free text. Apply a finding to the quoted passage, and report incomplete checks. A review is not publication permission. |
| A project user files an issue, or a developer takes one on | Use optional `jev_issue`. Author: check for duplicates; use `prepare` to separate reported, expected and reproducible behavior from proposed causes or fixes. File with `gh` or `glab` only when authorized, then `verify` the exact tracker readback. Developer: read relevant comments and evidence; use `understand` for segment-level dispositions, `develop` for scoped work and checks linked to the reviewed requirements, and `accept` for the observed result after the last edit. Use the previous result ID, not a paraphrase, in each linked phase. Do not judge validity by effort or treat Jev as permission to close the issue. |
| A reviewed plan contains substantial multi-step work | Keep one durable project TODO. Use `jev_todo review` to remove work with no requirement or required consumer and to reject checks that would pass despite the wrong result. Reuse adequate tests; use Gherkin only where contrasting cases clarify the behavior. Save exact check outputs. In a fresh session, reread the TODO and its cited evidence before `resume`. Use `cleanup` with the owner's threshold, never an invented one. |
| A separate decision remains open | Use `jev_consult`: `choice` for explicit alternatives, `score` for an ordered rubric, or `boolean` for one proposition with defined yes and no meanings. State one question and quote the evidence that could settle it. Jev cannot recover permissions or choose the owner's objective. |
| Search candidates or a specific rule for prose need review | Use `jev_search_relevance` to compare candidates and excerpts, or `jev_text_review` for the exact text and explicit whole-text or fragment rules. |
| The owner asks for deeper project review | Use `jev_triage` for scope and topics. For `jev_plan_review`, submit outline, one detail per step quoting its complete `local://` plan section, then finalize against the actual artifact bytes. Give each step a checkable outcome tied to an exact approved requirement. `jev_course_check` compares current work to the approved plan; `jev_review` covers a specific diff, commit or checkpoint. `jev_acceptance` also supports separate `business` and `architecture` claims with literal execution and code evidence. |
| The owner follows up | A clarification continues the task; an addition reopens affected checks. Use `jev_reaim` with the exact owner message only when the owner replaces the objective. Do not reset a task to evade a finding. |
| A strict supervised run is active | Follow the supervisor's injected contract, including its bound objective, tool limits and durable effect tracking. Use its business and architecture acceptance paths, not ordinary `outcome`. A missing effect result requires reconciliation under that contract; never infer that the effect did not happen. |

For checks that accept `sourceId`, use `jev_context` to list records and retrieve the exact excerpt from the owner, requirements, or plan. Binding a quote to an archived source verifies its provenance, not its factual truth or authority. Free quotes need a concrete locator; do not paraphrase them as evidence. The archive also helps inspect the original submission and result behind a finding.

When a tool prints `Jev result: result-…`, inspect it with `jev_context` using `action: "result"` and the displayed ID as `sourceId`. A historical result remains inspectable but does not support a current check.

## Failure modes

| Result or symptom | Response |
| --- | --- |
| Failed with an evidenced defect | Inspect the cited observation, fix the defect, and verify again. Retain unresolved findings in the report. |
| Inconclusive or below its threshold | Report uncertainty. Narrow the question or add new evidence; do not infer a pass or a defect. |
| Unavailable | No verdict exists. Check service or configured credentials only if relevant; continue independent work. The addon resolves `TYPESAFE_API_KEY` or `JEVI_API_KEY` first, then `TYPESAFE_API_KEY_COMMAND`. Never print the resolved key. |
| Stale | The task, revision, mode, or artifact changed. Reuse no old verdict for the current state. |
| Missing prerequisite or invalid input | Nothing was judged. Supply the specific missing input or correct the schema; do not report a failed judgment. |
| Disabled, skipped, or not checked | Report the reason. Do not treat absence of a finding as a pass. |
| Acceptance cannot see verification | Run the narrow check after the final edit and make the relevant output visible to OMP. Observe any pending job result before submitting acceptance. |
| Skill or tools absent | Verify the addon is loaded in the active OMP profile with skill discovery enabled. The owner can restart OMP after installation or update. Continue without Jev if it is not available. |

Only the owner runs `/jev`, `/jev off`, `/jev on`, and `/jev-status`. The status command separates check outcomes from work coverage. Off suspends checks for this session without changing permissions; on starts a fresh ordinary diagnostic workflow and retains usage totals. No continuation command, waiver or repair permit is required.

## Session mistakes

- A successful command was reported as passing acceptance. Report the command result and the check verdict separately.
- A matching table number was treated as support although it came from another condition. Cite the condition alongside the number.

## Scripts

None. The skill uses the tools mounted by the addon. It is bundled with Jevstice, so no separate global skill or reuse copy is needed.

**Before yielding:** State what was verified and which Jev checks passed, found a defect, stayed inconclusive, were unavailable, or did not run. Do not wait for a more favorable verdict.
