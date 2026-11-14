# Jevstice handoff — 2026-11-14

## Final state of this session

- **Observed at the last run:** `bun test` 567 pass / 0 fail / 2582 assertions / 18 files; `bun run typecheck --noUnusedLocals --noUnusedParameters` clean; code-guard deep check clean on the changed files.
- **Recovery deadlocks fixed and regression-proven:** inconclusive action preflights no longer block their own corrected resubmission (`src/gates.ts`); duplicate identity no longer changes when the refusal creates its hold (`src/activities.ts`); resolution retires only the exact refused submission (`src/state.ts`); failed completion caches and below-floor defect classifications were already corrected earlier in the session.
- **Still open:** plan steps s2 (strict runtime), s3 (routes and async), s4 (plans and owner authority), s5 (confidence, evidence, freshness), s6 (evidence inspection), plus the two interrupted static scenario audits and full real-host validation. The findings are recorded below with anchors; none is approved.
- **Deadlock diagnosis:** `local://jev-deadlock-fix.md` (superseded by the applied gate fix, kept for the second gap: `repair` asks "what does this correct" for an unexecuted action).
- The owner disabled Jevstice for the session before the final fixes, so those edits and this record were made outside Jev judgment; the open finding was left OPEN, never reported as approved.


## Stop condition and owner intent

The owner ended the session because time ran out and requested this written record. Do not treat this handoff as implementation acceptance or permission to bypass Jev.

The requested outcome is a reliable addon: a passed check enables its promised next transition; a failed check permits substantive diagnosis and correction until approval, without stale-refusal deadlocks, unsafe overrides, lower approval floors or repeated identical paid judgments. The owner additionally requested one parallel Sol agent per tool, English normative Gherkin scenarios in `сценарии`, followed by code/logic audits, especially for mistakes by inexpensive executor models.

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

| File under `сценарии/` | Definitions | Agent audit handoff |
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
- Anti-slop below-floor required checks can yield a nominally complete review without proof; result prose can contradict advisory mode or overstate delivery permission. Enforced review at revision zero and uncertain external-delivery classification also need regressions. See `сценарии/jev_anti_slop.feature`.
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
