# Jevstice handoff

## 2.4.0 release

Jevstice 2.4.0 adds optional issue and backlog diagnostics. The issue diagnostic separates author preparation and readback from developer understanding, development and acceptance. The backlog diagnostic offers review, resumption and cleanup proposals.

### Commit boundaries

| Include together | Keep separate or local |
| --- | --- |
| Runtime modules, registered schemas, unit and Gherkin tests, bundled skill and the corresponding README, PRD and changelog entries. | Site capture updates and the demo recorder belong in a separate change. The four modified PNGs have no current reference in `site/index.html`. |
| The executable smoke correction, verification notes and package version. The remote `v2.3.2` tag points at `1b1a2d3`, the OMP 19.1 routing fix; `451e588` introduced per-task acceptance. | Keep `TODO.md`, raw demo event data, local plans, configuration, credentials, caches and press drafts out of commits. Retain the scenario review ledger as historical evidence; rewritten scenarios do not inherit its verdicts. |

The release uses package version 2.4.0 and tag `v2.4.0`.

See [2.4.0 verification](tools/README.md#240-verification) for the current candidate's observed results and remaining release limits.

## Current contract

Jevstice records diagnostic judgment at visible OMP tool boundaries. It does not grant or withhold
execution permission. A failed check stays failed; an inconclusive answer establishes neither a
defect nor an approval; an unavailable or stale answer establishes nothing; a local argument error is
not checked because no judgment ran. Findings are disclosed with their original boundary, work
revision, exact submitted material and returned result. Ordinary effects and model completion
proceed independently from check acceptance.

The host owns tool execution and completion. The optional strict supervisor keeps its own
owner-authorized roots, resource limits, effect identity, durable ledger and pending-effect
reconciliation; Jev verdicts are evidence inside that runtime, not authority.

## OMP 19.1 command routing

OMP 19.1 replaced `xd://` with shell tool commands. The bundled skill and the ordinary injected
workflow now follow the active host inventory. The strict supervisor keeps its Jev tools direct.
See [the native routing smoke](tools/README.md#omp-191-command-routing) for observed dispatches.

## Superseded features and unfinished claims

- **Obsolete:** the two-phase `jev_consult mode: "recovery"` (`repair` authorizes one exact action,
  `resolve` clears a finding), repair permits, refusal holds that block consequential work, and the
  duplicate/replay machinery built around them. Definitions may still exist in source coordinates
  until the owning code change lands; the public contract no longer exposes or promises them.
- **Removed:** `/jev-continue`, `/jev-waive`, approval-message overrides such as `аппрув`, and
  instructions to wait for an owner override or for checks to pass.
- **Unfinished:** the earlier release demos and whole-task acceptance are not current passing
  results. The 2026-11-14 two-phase recovery probe and the earlier below-floor recovery are prior
  contracts, retained only as history. The 2.1.0 release carried an optional autonomy module whose
  full acceptance was open then and remains open now. Do not describe any of these runs as evidence
  for the diagnostic contract, release readiness or full autonomy acceptance.

## Current public interface

- Twelve ordinary tools: `jev_triage`, `jev_search_relevance`, `jev_requirements`,
  `jev_plan_review`, `jev_consult` (choice/score/boolean only), `jev_context`, `jev_course_check`,
  `jev_acceptance`, `jev_review`, `jev_reaim`, `jev_text_review`, `jev_anti_slop`.
- Owner commands: `/jev` (report, `off`, `on`), `/jev-status`. The session switch changes checks
  only, writes no configuration, and changes no host permission.
- Every Jev tool result carries `details.diagnostics` with `checks` and `work`, each carrying
  `passed`, `failed`, `inconclusive`, `unavailable` and `not_checked`. A consequential tool result
  starts as `not_checked`; an asynchronous effect still pending remains `not_checked`. The status
  summary reports both groups and the current-revision business and architecture acceptance
  separately.
- Configuration: `antiSlop.mode` (`off`, `advisory`) and `billing.*`. Older `gates.*`,
  `courseCheck.*` and `antiSlop.mode: "enforce"` keys are obsolete: unknown keys are ignored, and an
  `enforce` value falls back to `advisory` with a named problem.

## Observed verification — 2026-11-15

- `bun test`: **530 passed, 0 failed, 2352 assertions, 20 files**, after the acceptance
  evidence-basis change and the diagnostic result contract.
- Twelve per-tool recordings exist under `demos/tools/` (GIF, tape, frames, raw event stream, model
  identity, outcome); `jev_reaim` is recorded through a two-message RPC session. Long recordings skip
  idle frames; the evidence keeps the real timeline.
- `bun run typecheck --noUnusedLocals --noUnusedParameters`: passed on the current source.
- `code-guard --deep src autonomy tests tools`: clean TypeScript analysis; formatter and linter
  channels skipped because no corresponding configuration exists.
- Acceptance now requires literal basis evidence: `execution_evidence` and `code_evidence` at the
  plan level, plus a selected execution and code evidence item per plan topic, with a missing or
  below-floor basis reported as `unresolved` instead of inferred. The four FR-26 regressions failed
  before the change and pass after it.
- A negative diagnostic is a normal tool result carrying a "diagnostic only" note; only a malformed
  local submission is a tool error. The recorded outcomes, counts and any hold are unchanged.
- A follow-up that adds work retains the unaffected approved requirements without re-judging them,
  filters the plan draft to them and reopens review; `jev_reaim` refuses a phrase that merely occurs
  inside an older owner message before any judge call.
- The normative Gherkin files live in `scenarios/`. `tests/scenarios/` parses them and turns every
  scenario into a test: a scenario whose steps are all defined runs against production code, and any
  other scenario is reported as `todo`, never as a pass. Steps are feature-scoped, so the same
  sentence may mean different things in two files. Executable so far: `jev_reaim` 11/11,
  `jev_triage` 14/14 (this file found a real defect: `inspect …` was read as judged, now quiet),
  `jev_consult` 18/18, `jev_context` 18/18, `jev_search_relevance` 11/11, `jev_review` 14/14,
  `jev_text_review` 15/15, `jev_requirements` 11/11, `jev_plan_review` 17/18 (the host plan-mode
  hook does not exist), `jev_course_check` 11/11, `jev_acceptance` 21/21, `jev_diagnostics` 25/25,
  `jev_session_mode` 12/12, `jev_configuration` 25/25, `jev_anti_slop` 28/28, `jev_autonomy` 27/27.
  The full suite is 825 pass, 0 fail, 2 todo, 5354 assertions.
- FR-42 retention is now implemented: an amendment keeps an already-accepted outline step and section
  for every unaffected requirement and drops only the dependent ones (`src/activities.ts` amend
  branch); its scenario runs (owner follow-up 15 pass, 1 todo) and the regression failed before the
  change.
- The autonomy scenarios now run for real: the supervisor and strict runtime are exercised under
  observed systemd user scopes, with bounded waits and cleanup (0 leftover scopes or processes).
- Two `todo` scenarios remain, both real gaps: one owner-follow-up scenario needs durable session
  restore (ordinary state is a per-session in-memory map), and one plan-review scenario needs a host
  plan-mode boundary — the installed OMP extension event union exposes no plan-mode event. The second
  is a host capability gap, not a test stub.
- `tools/review-scenarios.ts` asks the judge about one scenario at a time, with the cited requirement
  and an implementation excerpt, and records the verdict in `scenarios/reviews.json`; unchanged
  scenarios are not paid for twice. The triage verdicts so far are mixed (3 approved, the rest
  flagged), so per-scenario judge agreement is not claimed.
- Ordinary controller regressions cover an approved plan followed by a negative course check,
  missing planning context, judge outages, an unresolved judge promise, independent context reads,
  continued project calls and completion, and truthful diagnostic counts.

- Strict targeted coverage preserves root/ownership/manifest checks, out-of-root script-symlink
  rejection, intent identity and pending-effect reconciliation while removing Jev vetoes.
- Deterministic negative/outage smoke passed at `/tmp/jev-live-smoke-BuklYu`: two failed checks
  remained failed, outages remained unavailable, and subsequent writes and completion proceeded.
- Production-judge direct workflow passed at `/tmp/jev-live-smoke-cFesXK`: 12 judge calls and
  both acceptance aspects passed for the disposable slug example, not for this whole project.
- Native OMP 18.20.2 with `deepseek/deepseek-flash` passed the workflow smoke at
  `/tmp/jev-live-smoke-a763ON`, exit 0, with native calls and typed diagnostic records.
- Native command inspection found `/jev` and `/jev-status`, no continuation/waiver command,
  and accepted the status command locally with zero model turns and no extension errors
  (`/tmp/jev-native-diagnostics-lMUR9G.jsonl`).

The background-finding race is fixed: an unrelated diagnostic finding no longer participates in
the task/approval staleness comparison. Its regression failed before the correction and passed
afterward; the smoke deliberately overlaps background and foreground checks without a wait or retry.
Genuine task, revision, owner input, approval and artifact changes still invalidate stale answers.

Evidence paths above are local machine artifacts, not portable release assets.

## Remaining scope

- Full revised strict-supervisor real-host startup/completion/cancellation/crash coverage remains
  unproved. Deterministic tests do not replace those deployment scenarios.
- The matched 3D-game comparison was rebuilt with a style-pinned prompt and a 15-minute cap:
  both runs exited 0 (397 s without the addon, 613 s with it), both artifacts passed the browser
  checks, and the addon's ship matched the requested cone while the baseline drew a disc. The UI
  comparison retains its earlier 300-second pair. Neither is a benchmark.
- All twelve tools have a rendered GIF under `demos/tools/` plus the tape, three frames, the sanitized
  event stream, the exact model identity and the outcome. `jev_reaim` is recorded through a
  two-message RPC session; the driver sends the second owner message as `steer` and waits for the real
  turn boundaries.
- `docs/presale-reddit.md` and `docs/presale-twitter.md` are the release drafts. They are English,
  cite the observed results above and claim no measured advantage.
- No current Jev whole-project acceptance, commit, tag or publication is claimed.
- Existing loaded hosts need a restart to load changed hooks, tool schemas and injected guidance.
  Old global/user-authored instructions may still prescribe the superseded workflow; Jev findings
  themselves are diagnostic, not a reason to ask for continuation.

---

# Historical record — 2026-11-14 (superseded, retained)

> The record below describes the earlier blocking-recovery contract and the state observed then. It
> is retained for audit history. It is not current behavior, not a current verification result, and
> not evidence that the diagnostic contract passed. Its repair-permit feature is obsolete and the
> release demos it mentions remain unfinished.

## 2026-11-14 session record

## Final state of this session

- **Observed at the last run:** `bun test` 567 pass / 0 fail / 2582 assertions / 18 files; `bun run typecheck --noUnusedLocals --noUnusedParameters` clean; code-guard deep check clean on the changed files.
- **Recovery deadlocks fixed and regression-proven:** inconclusive action preflights no longer block their own corrected resubmission (`src/gates.ts`); duplicate identity no longer changes when the refusal creates its hold (`src/activities.ts`); resolution retires only the exact refused submission (`src/state.ts`); failed completion caches and below-floor defect classifications were already corrected earlier in the session.
- **Still open:** plan steps s2 (strict runtime), s3 (routes and async), s4 (plans and owner authority), s5 (confidence, evidence, freshness), s6 (evidence inspection), plus the two interrupted static scenario audits and full real-host validation. The findings are recorded below with anchors; none is approved.
- **Deadlock diagnosis:** `local://jev-deadlock-fix.md` (superseded by the applied gate fix, kept for the second gap: `repair` asks "what does this correct" for an unexecuted action).
- The owner disabled Jevstice for the session before the final fixes, so those edits and this record were made outside Jev judgment; the open finding was left OPEN, never reported as approved.


## Stop condition and owner intent

The owner ended the session because time ran out and requested this written record. Do not treat this handoff as implementation acceptance or permission to bypass Jev.

The requested outcome is a reliable addon: a passed check enables its promised next transition; a failed check permits substantive diagnosis and correction until approval, without stale-refusal deadlocks, unsafe overrides, lower approval floors or repeated identical paid judgments. The owner additionally requested one parallel Sol agent per tool, English normative Gherkin scenarios in `scenarios`, followed by code/logic audits, especially for mistakes by inexpensive executor models.

## Results actually obtained

### Implemented, not yet committed in this follow-up

- Resolved action-preflight findings retire matching-boundary duplicate-refusal records, retaining history/counts. Identical action material is judged again; a fresh refusal still blocks execution. Changes: `src/state.ts`, `tests/controller.test.ts`.
- Explicit and interval course checks no longer classify below-floor `off_course` answers as proven defects. Developer reviews and completion classification also distinguish reliable defects from uncertainty. Changes: `src/activities.ts`, `tests/activities.test.ts`.
- Resolving a completion finding clears its failed completion and stop caches. The next stop can reevaluate the unchanged work revision without a pointless project mutation. Changes: `src/state.ts`, `tests/controller.test.ts`.
- The production recovery smoke now checks identical refused-action replay at the unchanged revision after exact repair admission, requiring a new actual judge call and respecting its fresh refusal. Changes: `tools/live-smoke.ts`.
- `CHANGELOG.md` records these fixes and their verification.

**Important limitation:** refusal retirement still matches raw boundary names and marks the whole matching boundary. It does not yet bind every resolved workflow finding to an exact submission boundary plus digest. The broader audit found tool-name/ledger-name mismatches. Do not describe the current fix as solving every recovery cache.

### Observed verification

| Check | Observed result | Scope |
|---|---|---|
| Full `bun test` | 564 pass, 0 fail, 2571 assertions, 17 files | Existing suite plus current regressions; not proof of all invariants |
| `bun run typecheck --noUnusedLocals --noUnusedParameters` | Passed | Current TypeScript source |
| Code-guard deep check | Clean on edited code paths | Includes no-emit checking; no formatter/linter config exists |
| Targeted controller recovery checks | 3 pass, 0 fail | Fresh positive/negative action judgments and resolved completion |
| Production Jev direct recovery smoke | Passed: `/tmp/jev-live-smoke-CwwYWN` | Real judge, exact repair, unchanged-revision replay, acceptance/completion; direct mode uses an in-process host harness, not a real OMP process |

The completion-cache regression failed before its fix and passed afterward. Earlier action-replay and confidence-classification regressions also failed before correction. Raw final suite/typecheck output is retained as `artifact://93` in this session.

No new commit or push was made for this follow-up. The previously completed owner-authorized commit/push was `83cb9d6ca9602d8c724d4b72eb95c4412a5d68db` on `origin/main`; that is an earlier checkpoint, not these latest edits. Do not discard existing work to recreate it.

The original separate running ai-wizard/together session was not resumed or proven repaired in place. An already loaded OMP process does not hot-replace this extension: restart/reload is required to use changed hooks and schemas. Do not silently launch another competing project writer.

## Normative Gherkin artifacts

Thirteen Sol agents were launched in parallel, one for each ordinary Jev tool plus the optional strict control tool. Their scenarios describe intended behavior, not a transcription of implementation. Each file contains source references and an `Implementation audit` comment section separating static implementation, static discrepancies and unverified behavior.

At the stop snapshot there were **13 files and 332 Scenario/Scenario Outline definitions**; Examples rows are not counted separately:

| File under `scenarios/` | Definitions | Agent audit handoff |
|---|---:|---|
| `jev_triage.feature` | 23 | Completed |
| `jev_requirements.feature` | 26 | Cancelled at owner stop; finish/reconcile audit |
| `jev_plan_review.feature` | 28 | Cancelled at owner stop; finish/reconcile audit |
| `jev_consult.feature` | 29 | Completed, including corrected strict-repair classification |
| `jev_context.feature` | 25 | Completed |
| `jev_course_check.feature` | 26 | Completed |
| `jev_acceptance.feature` | 25 | Completed |
| `jev_review.feature` | 21 | Completed |
| `jev_text_review.feature` | 24 | Completed |
| `jev_anti_slop.feature` | 32 | Completed |
| `jev_reaim.feature` | 20 | Completed |
| `jev_search_relevance.feature` | 22 | Completed |
| `jev_autonomy.feature` | 31 | Completed |

The files are saved, but **no Gherkin parser validation or scenario execution was performed**. There are no added Cucumber step definitions or runner. Static audit findings are not failing runtime reproductions. Some findings overlap across files; do not count every `DEFECT_STATIC` mention as a distinct bug. Inspect current source before adopting any stronger contract inferred by an agent.

Task model routing was temporarily changed to launch the requested Sol workers, then restored to its original session values. No persistent routing change was saved. Unfinished requirements/plan workers were cancelled; other workers were told to stop. Do not wait for them on resume.

## Remaining work — priority order

The following are open static findings unless explicitly identified as fixed above. The per-tool feature audits contain fuller producer-to-consumer anchors and evidence gaps.

### 1. Repair the shared refusal/recovery state machine

- Bind each refusal-backed finding to its exact submission ledger boundary and digest. Controller holds commonly use `jev_requirements`, `jev_review`, `jev_text_review`, `jev_search_relevance`, `jev_plan_review`; ledger rows use `requirements`, `review`, `text`, `search`, `plan:outline`, `plan:detail:<id>`, `plan:finalize`. `clearResolvedHold` currently cannot retire those mismatched rows. See `src/controller.ts:698-701`, `src/state.ts:440-454`, `src/activities.ts` refusal producers.
- Make refusal identity stable against the act of recording a hold. Default `submitToJudge` hashes `material.heldFinding`; the first refusal creates a hold afterward, so an identical first replay obtains a new digest and paid judgment. Diagnostic, requirements, review, text, search and triage audits trace this. Preserve genuinely independent questions and substantive new evidence; do not solve it by clearing all caches.
- Retire only the exact resolved submission, preserving unrelated refusals even at the same boundary. Add controller-level regressions, not only direct activity tests that never create controller holds.
- Explicit course checks and anti-slop have missing refusal-ledger recording paths. Distinguish local invalid input, transport outage, uncertain judgment and reliable negative judgment before deciding what is cached.
- `askJudge` detects stale context but returns an unusable outcome; callers commonly convert it to `unavailable`, and `recordRecovery` can manufacture a current hold. Preserve stale classification end to end. Relevant anchors: `src/activities.ts:442-464`, caller `unusable(...)` paths, `src/controller.ts:701`, `src/state.ts:331-335`.
- Serialize or otherwise atomically consume exact repair authority through final admission. The consult audit traces two overlapping admissions obtaining repair-derived approval before the first consumes it; after that first action-preflight hold is retired, the second can proceed without its own fresh judgment. Static interleaving only; add a deterministic concurrent regression.

### 2. Restore strict recovery and nonterminal completion

- `autonomy/runtime.ts:1331-1333` unconditionally rejects standing holds before shared exact-repair recognition; `admit` repeats that check at `1755-1758`. Allow only a valid exact repair to reach all remaining strict authority/judgment/intent checks; retain single-use and freshness constraints.
- Strict stop can judge completion while a hold stands, then attempt a completed transaction. `autonomy/store.ts:1092` correctly rejects it, but `runtime.commit:838-840` closes admission permanently, including recovery. Detect the expected held prerequisite before completion/commit and keep recovery available. Stop path: `runtime.ts:2447-2524`.
- Executed reconciliation updates actions/checkpoint/pending but not current dependency bindings/artifacts (`runtime.ts:3191-3235`). The next `judgeFor` can reject already-reconciled bytes as changed dependencies (`1461-1464`). Rebind observed current bytes and invalidate affected approvals within the settlement transaction.
- Oversized artifact rejection can permanently close admission without the promised durable resource wait (`store.ts:2070-2075`, runtime commit error path). Reproduce before changing behavior.

### 3. Fix tool-route equivalence and asynchronous effects

- Ordinary `NON_MUTATING_DEVICES` omits `jev_anti_slop` although the direct tool is read-only (`src/gates.ts:193-204`). Routed review can advance revision and invalidate itself immediately. Test actual `tool_call -> tool execution -> tool_result` behavior under enforced delivery.
- Strict `SAFE_DEVICES` omits `jev_context`: direct context inspection is allowed, the documented write-device route is refused (`autonomy/runtime.ts:81-94,1195-1200,1313-1315`).
- Held-tool routing checks run before logical route normalization in some paths. Verify all twelve ordinary tools and strict control through the installed host, not by table inspection alone.
- Ordinary async start is recorded as successful completion; the controller does not settle later native `async-result` delivery. Pending jobs may mutate/fail after acceptance without invalidation (`src/controller.ts:996-1013`). Track exact pending job identity, consume terminal receipts and record actual revision/failure consequences. Strict async handling is separate and must not regress.

### 4. Make proposal/handoff and owner changes preserve authority

- Historical plan/propose exhaustion is checked before current approved plan admission (`src/gates.ts:1159-1170`), potentially blocking a corrected approved artifact forever. Counts remain diagnostic.
- Proposal/handoff can omit an unresolved finding/refusal history when restoring task/plan into a new session. Either hold execution handoff or preserve governing unresolved state; do not manufacture owner continuation (`src/controller.ts:455-478,864-870`).
- Cached handoffs survive re-aim and may restore old task/approvals after a later session switch. Verify real host approve-and-execute versus ordinary clear semantics; do not assume every `reason: new` is approval.
- Re-aim accepts historical owner substrings without requiring a current classified replacement (`src/activities.ts:670-685`). Existing holds can prevent queued authentic owner changes from being classified because gates run before `updateOwner`. Preserve clarification/addition versus replacement semantics.
- Plan negative stage responses may omit `approved:false`, so wrapper failure detection does not record the promised finding. Finish the cancelled plan audit before redesigning stage outcomes.

### 5. Close confidence, evidence and exact-content gaps

- Triage can treat uncertain external classification as internal and omit uncertain topics (`src/activities.ts:901,911`); enforced external checks can therefore be skipped. Validate raw topic/candidate input rather than silently dropping malformed entries.
- Anti-slop below-floor required checks can yield a nominally complete review without proof; result prose can contradict advisory mode or overstate delivery permission. Enforced review at revision zero and uncertain external-delivery classification also need regressions. See `scenarios/jev_anti_slop.feature`.
- Text review/anti-slop/search use trimming helpers on material whose contract promises verbatim preservation. Verify intended exact-content semantics and preserve original submitted text/rules/reasons where required. Text review also lacks the documented artifact-size bound.
- Review/acceptance evidence checks may validate labels rather than required changed-code and observed-command-output content. Do not invent judge explanations: the SDK returns typed answers, not free prose. Treat fabricated-evidence resistance and prompt injection as unverified until exercised.
- Ordinary consultations/acceptance/course checks need post-answer approved-artifact byte freshness checks, not only pre-judge readback. Malformed UTF-8/BOM normalization versus literal-byte approval also needs a precisely bounded contract/reproduction, not an assumed defect claim.
- Manual course checks lack the automatic check's in-flight completion guard; completion may use a cached pass or a queued completion after the manual failure without rereading the hold. Initial course findings also omit full submitted evidence/original result.

### 6. Keep evidence inspection usable during failures

- Context inspection shares the judge serialization queue, so it can wait behind a pending judgment.
- `prepareContext` enumerates the archive before context reads; one corrupt unrelated record can block valid reads and original-finding retrieval (`src/controller.ts:319,695`; `src/context.ts:340-343`).
- Provenance wording describes selected earlier-task/owner records as approved for the current task (`src/activities.ts:405-406`); archive provenance is not present-task approval or permission. Keep authentic old evidence inspectable without overstating its authority.
- Separate explicit documented contracts from inferred strengthening: accepting an unused list argument, purpose/audience group binding and reverse evidence-kind restrictions require careful source review, not automatic scope expansion.

## Resume procedure

1. Read this handoff, current source and the relevant `.feature` audit; preserve existing uncommitted edits. Do not repeat the old test audit or reread past sessions wholesale.
2. Finish/reconcile the requirements and plan static audits; validate all feature syntax with an official Gherkin parser in an isolated environment. No dependency has been added for this.
3. Deduplicate shared findings. Reproduce the highest-priority consumer-visible failure in existing Bun controller/runtime harnesses before implementing its minimal fix. Passing old tests do not refute a new demonstrated failure.
4. Exercise actual production Jev and real OMP native/device routes for the repaired transitions. A real judge with an in-process fake host is not a full real-host test. Never retry unchanged uncertain judgments to obtain a favorable answer.
5. Run the narrow regression after each fix, then integrated tests/typecheck/code guard once at the end. Record observed outputs and remaining gaps; never equate owner continuation, counts or an open finding with approval.
6. Only report whole-addon reliability/acceptance if evidence covers it. Current work has **not** proved all invariants, full autonomy acceptance or guaranteed freedom from future deadlocks.
