# Jevstice business acceptance and traceability

## 1. Identification

| Item | Value |
| --- | --- |
| Document | Business acceptance and traceability |
| Product | Jevstice 2.2.0, OMP extension |
| Scope | Ordinary diagnostic addon, its owner commands, configuration, credentials, owner follow-up and the optional strict supervisor |
| Requirement source | `PRD.md` (owner-approved functional requirements FR-01..FR-78) |
| Behaviour source | `AGENTS.md` "Current owner contract", `src/jev-skill.md`, tool catalog in `src/guidance.ts` |
| Scenario source | `scenarios/*.feature` (17 files; definition count, ids and executability are checked by `tests/scenarios/run.test.ts`) |
| Gherkin reference | <https://cucumber.io/docs/gherkin/reference/> |
| Acceptance status in this document | Static traceability only. This document asserts no pass or fail from a test, typecheck, live judge call, host run or strict run. |
| Executable status | `tests/scenarios/run.test.ts` loads `tests/scenarios/steps/*.ts` and runs each scenario against production code. Missing steps fail unless the scenario is the exact known-unsupported allowlist (`jev_plan_review_13`, `jev_owner_followup_12`); a supported allowlist entry fails the contract. |

## 2. Purpose and business outcome

Jevstice lets an OMP executor obtain an independent diagnostic review of its work. The owner
receives truthful coverage, findings and cost information. Jevstice must not become an execution
authority: the host owns tool permissions and completion, and the optional strict supervisor owns
deterministic safety through roots, effect classes, budgets, ownership, containment and durable
intent.

The business outcome accepted here is:

1. Every public Jev tool returns a truthful, typed diagnostic with enough context to correct the work.
2. No Jev result, attempt count, owner approval-like text or missing service blocks ordinary work or
   ordinary completion.
3. The owner can pause and resume diagnostics, understand configuration and cost, and rely on
   authentic owner context without a continuation or waiver mechanism.
4. The optional strict module preserves its deterministic safety envelope and never treats Jev as a
   veto or as expanded permission.

## 3. Definitions and status vocabulary

| Term | Meaning |
| --- | --- |
| Diagnostic | A recorded judgment outcome: `passed`, `failed`, `inconclusive`, `unavailable` or `not_checked`. It is evidence, not permission. |
| Finding | The preserved record of a non-pass or uncertainty, with boundary, work revision, submitted material and returned result. |
| Ordinary completion | The host's session stop and final response. Jev does not gate it. |
| Strict supervisor | The optional `autonomy/` module started only through `bun run autonomy`; it enforces deterministic safety. |
| Owner follow-up | An authentic interactive/RPC message captured and classified as continuation, amendment, replacement or unclear. |
| `Implemented` | The inspected code path exists and repository tests exist for it. Not proof that a test or live run passed. |
| `Implemented, live unproven` | Code and unit/integration tests exist; no current real-host or production-judge observation is recorded here. |
| `Partial` | Some required behaviour is present and at least one stated obligation is not. |
| `GAP` | A concrete conflict or missing behaviour with file/range evidence. |
| `Pending` | An owner-promised PRD requirement that is not implemented or not accepted. |
| `Unverified` | No static evidence can decide the claim; an execution or live run is required. |

Approval floors are defined in `src/types.ts` `POLICY`: choice/score confidence 0.6, boolean
probability 0.7, requirements coverage 0.6, plan coverage 0.6, anti-slop 0.8. A below-floor answer
is inconclusive, never a proven defect and never an approval.

## 4. Acceptance conditions

The business surface is acceptable when all of the following hold and are observed:

- **AC-01:** The 12 ordinary tools and 2 owner commands (`/jev`, `/jev-status`) are registered; no
  `/jev-continue`, `/jev-waive`, repair permit or resolution mode is registered.
- **AC-02:** Every ordinary Jev tool result while diagnostics are on carries `details.diagnostics`
  with `checks` and `work` groups, each holding exactly the five diagnostic classes.
- **AC-03:** A consequential tool call and `session_stop` complete without waiting for a judge,
  acceptance or finding; negative, inconclusive, unavailable and stale results remain recorded.
- **AC-04:** `/jev off` disables judgments, source capture and prompt injection without changing
  configuration, host permissions or strict safety; `/jev on` starts a fresh workflow without
  restoring old approvals.
- **AC-05:** Configuration reads only `antiSlop.mode` (`off`/`advisory`) and `billing.*`; obsolete
  gate/course keys do nothing; `enforce` falls back to advisory with file/key disclosure.
- **AC-06:** A missing key or judge outage yields unavailable judgment, never approval or a work hold.
- **AC-07:** Business and architecture acceptance are separate current-revision records requiring
  execution and code evidence; neither is completion permission.
- **AC-08:** External-artifact findings are advisory, stable and non-authoritative; no waiver command
  exists and no result claims a delivery hold.
- **AC-09:** The strict supervisor preserves frozen roots/effects/limits, exclusive ownership,
  durable intent, containment, cancellation and restart invalidation; Jev remains diagnostic.
- **AC-10:** Every feature scenario carries a stable scenario tag and at least one PRD requirement tag;
  every group below names implementation, a runnable verification command and its known gaps.

## 5. Surface inventory

| Surface | Kind | Failure contract |
| --- | --- | --- |
| `jev_triage` | tool | Local validation or judge failure registers no task; project work continues. |
| `jev_requirements` | tool | No approval on missing coverage; no owner loop; work continues. |
| `jev_plan_review` | tool | Staged tool prerequisites; refusals are diagnostic; work is not locked. |
| `jev_consult` | tool | Choice/score/boolean only; recovery/repair refused; no authority. |
| `jev_search_relevance` | tool | Selects submitted candidate+reason or none; no invented prose. |
| `jev_reaim` | tool | Only an authentic owner replacement; no bypass or inherited permission. |
| `jev_course_check` | tool | Named prerequisite without a plan; on/off/unclear classified; no release. |
| `jev_acceptance` | tool | Separate aspects; execution+code evidence; no completion permission. |
| `jev_review` | tool | Developer evidence only; defect is diagnostic; no acceptance substitution. |
| `jev_text_review` | tool | Submitted rules only; unsettled is not clean; no rewriting. |
| `jev_anti_slop` | tool | External only; advisory findings; bounds fail closed; no waiver. |
| `jev_context` | tool | Archive list/read; provenance not truth or approval; no judge call. |
| `/jev`, `/jev-status` | owner commands | Diagnose/switch checks; no configuration write or permission change. |
| `jev_autonomy` | strict tool | Optional; deterministic safety; diagnostic Jev; no owner-control expansion. |
| `TYPESAFE_API_KEY`, `JEVI_API_KEY`, `TYPESAFE_API_KEY_COMMAND` | credentials | Missing/failing key resolves to unavailable judge. |

## 6. Traceability matrix

Commands are the verification path, not evidence of a result in this document. Run tests with `bun`
per `AGENTS.md`. Single file: `bun test tests/<file>.test.ts`. The full suite is `bun test`.
File and line anchors describe the inspected working revision; shared files may move while the
parent integrates.

| Area and feature | PRD requirements | Scenario tags | Implementation anchors | Verification command(s) | Status and gaps |
| --- | --- | --- | --- | --- | --- |
| Diagnostic contract — `jev_diagnostics.feature` | FR-17, FR-22, FR-31, FR-72, FR-73, FR-74, FR-75 | `jev_diagnostics_01..16` | `src/state.ts:157-187` (recordDiagnostic/diagnosticSummary); `src/controller.ts:147-160` (toolResponse); `src/controller.ts:351-388` (run wrapper); `src/controller.ts:475-529` (diagnoseAction/settleBackground); `src/controller.ts:397-427` (status/mode) | `bun test tests/diagnosticController.test.ts`; `bun test tests/controller.test.ts`; `bun test tests/controllerLifecycle.test.ts`; `bun tools/live-smoke.ts direct --scenario diagnostics` | Implemented. Ordinary completion and background checks covered by controller tests. FR-17 completion check is not an ordinary gate (see GAP-10). No live host run observed here. |
| Session mode — `jev_session_mode.feature` | FR-71, FR-76, FR-77 | `jev_session_mode_01..12` | `src/controller.ts:397-427` (`/jev`, `/jev-status`); `src/controller.ts:147-160` (disabled result); `src/controller.ts:428-437` (state reset); `src/controller.ts:428-473` (events, disable checks) | `bun test tests/controller.test.ts` (mode, stale answer, status tests); `bun tools/live-smoke.ts host --scenario workflow --model deepseek/deepseek-flash` | Implemented, host command routing live unproven. `/jev on` fresh workflow retains usage/stats/diagnostics; sources stay archived. Strict switch changes diagnostics only. |
| Configuration and credentials — `jev_configuration.feature` | FR-73, FR-78 | `jev_configuration_01..12` | `src/config.ts:17-24` defaults; `src/config.ts:37-44` paths; `src/config.ts:57-74` mode validation; `src/config.ts:98-163` (loadJevConfig); `src/apikey.ts:23-58` (resolveApiKey); `src/judge.ts:216-255` (createTypeSafeJudge); `src/controller.ts` `session_start` notification | `bun test tests/config.test.ts`; `bun test tests/apikey.test.ts`; `bun test tests/judge.test.ts`; `bun test tests/scenarios/run.test.ts` | Implemented. Obsolete keys ignored; enforce falls back to advisory; no live balance query. Session start sends the exact problem text to the owner UI and no `jev.config` model message. Key secrecy is structural; no test can prove absence from every possible log. |
| Owner follow-up — `jev_owner_followup.feature` | FR-41 (unimplemented), FR-42, FR-68, FR-69, FR-73, FR-76 | `jev_owner_followup_01..14` | `src/controller.ts:284-298` owner capture; `src/controller.ts:438-473` input/prompt capture; `src/activities.ts:693-792` classification; `src/state.ts` retained requirements/plan; `src/context.ts:17-353` archive | `bun test tests/controller.test.ts`; `bun test tests/context.test.ts`; `bun test tests/state.test.ts`; `bun test tests/activities.test.ts`; `bun test tests/scenarios/run.test.ts` | Capture, classification, amendment, replacement and unaffected-decision retention are implemented with scenario coverage. FR-41 ordinary journal restore is still unimplemented and is the only owner-follow-up scenario in the runner allowlist. Restart behavior is unit-covered but not live. |
| Triage — `jev_triage.feature` | FR-01, FR-02, FR-10, FR-30, FR-45, FR-72, FR-73 | `jev_triage_01..12` | `src/screen.ts` (weightOf); `src/activities.ts:793-898` (triage); `src/controller.ts:446-474` (before_agent_start) | `bun test tests/activities.test.ts` (FR-01/02); `bun test tests/controller.test.ts`; `bun tools/live-smoke.ts direct --scenario factorio` | Implemented. One stale response sentence says changes stay blocked (GAP-04). External uncertainty stays in review scope. No task on outage. |
| Requirements — `jev_requirements.feature` | FR-04, FR-05, FR-06, FR-22, FR-33, FR-34, FR-35, FR-36, FR-73 | `jev_requirements_01..11` | `src/activities.ts:989-1115` (requirements); `src/state.ts:440-447` (invalidatePlan); `src/controller.ts:299-312` (snapshotApproval) | `bun test tests/activities.test.ts` (FR-04/05/06); `bun test tests/state.test.ts` | Implemented. Approval requires every item supported, coverage established and candidate needs settled. Unapproved requirements do not block work; plan review has its own prerequisite. |
| Plan review — `jev_plan_review.feature` | FR-07 (pending), FR-24, FR-34, FR-36, FR-37, FR-73 | `jev_plan_review_01..14` | `src/activities.ts:1163-1551` (reviewPlanOutline/reviewPlanDetail/finalizePlan/planReview); `src/artifact.ts:8-40` (readLocalArtifact); `src/controller.ts:299-312` (snapshotApproval) | `bun test tests/activities.test.ts` (plan stages, content binding); `bun test tests/artifact.test.ts` (BOM and invalid UTF-8) | Implemented except FR-07. Passing steps retained; changed outline invalidates dependent details; final approval binds digest/bytes/task. A BOM is preserved and invalid UTF-8 is refused rather than normalized. No host plan-mode hook was found (GAP-07). Approval does not lock implementation. |
| Consultation — `jev_consult.feature` | FR-08, FR-09, FR-13, FR-19, FR-20, FR-22, FR-76 | `jev_consult_01..10` | `src/activities.ts:538-613` (consult); `src/guidance.ts:20-23`; `src/controller.ts:251-283` (prepareContext citation validation) | `bun test tests/activities.test.ts` (FR-08); `bun test tests/judge.test.ts` | Implemented. Recovery mode explicitly refused. Answers carry a diagnostic note and do not clear findings. |
| Search relevance — `jev_search_relevance.feature` | FR-03, FR-20, FR-22, FR-73 | `jev_search_relevance_01..07` | `src/activities.ts:899-988` (searchRelevance); `src/guidance.ts` SEARCH_DESCRIPTION | `bun test tests/activities.test.ts` (FR-03) | Implemented. Submitted candidate/reason returned; none-relevant is valid; below-floor unusable. |
| Re-aim — `jev_reaim.feature` | FR-29, FR-69, FR-73, FR-76 | `jev_reaim_01..09` | `src/activities.ts:614-692` (reaim); `src/state.ts:488-511` (registerTask/reaimTask) | `bun test tests/activities.test.ts` (FR-29); `bun test tests/state.test.ts` | Implemented. One stale prerequisite still names the removed `/jev-continue` (GAP-05). Re-aim clears old approvals/findings; no re-triage. |
| Course check — `jev_course_check.feature` | FR-11/FR-12 (removed scheduling), FR-20, FR-25, FR-70, FR-73, FR-75 | `jev_course_check_01..11` | `src/activities.ts:2808-2895` (courseCheck); `:2715-2807` (explicitCourseCheck); `src/controller.ts:475-497` (diagnoseAction) | `bun test tests/activities.test.ts`; `bun test tests/controller.test.ts` | Implemented. Named prerequisite without plan; off-course defect; below-floor on-course inconclusive; approving check is evidence only. |
| Acceptance — `jev_acceptance.feature` | FR-14, FR-15, FR-26, FR-36, FR-39, FR-43, FR-73, FR-74 | `jev_acceptance_01..15` | `src/activities.ts:1552-1696` (evidence basis, unmet sections); `src/controller.ts` `diagnoseCompletion` (automatic acceptance for an approved plan); `src/controller.ts:368-370` (pending-effect prerequisite); `src/state.ts:553-579` (acceptance/revision) | `bun test tests/activities.test.ts` (FR-14/15/26/43); `bun test tests/state.test.ts`; `bun test tests/scenarios/run.test.ts` | Separate aspects, revision binding, topic gates, literal command/output evidence and approved verification sections are implemented. Automatic acceptance runs only when an explicit plan was approved. Acceptance returns a prerequisite while a background effect is unobserved; this is not an execution hold. Scenario coverage exists; no test pass is asserted here. |
| Developer review — `jev_review.feature` | FR-16, FR-20, FR-22, FR-73 | `jev_review_01..09` | `src/activities.ts:1697-1765` (review); `src/guidance.ts` REVIEW_DESCRIPTION | `bun test tests/activities.test.ts` (FR-16) | Implemented. Sound review is evidence; defect is diagnostic; never replaces acceptance. |
| Text review — `jev_text_review.feature` | FR-20, FR-22, FR-27, FR-73 | `jev_text_review_01..09` | `src/activities.ts:1766-1907` (textReview); `:1909-1933` (readRules/proseFragmentsOf) | `bun test tests/activities.test.ts` (FR-27) | Implemented. Text scope judged once; fragment scope excludes headings/tables/code; submitted rule line returned verbatim; no advice. |
| Anti-slop — `jev_anti_slop.feature` | FR-45..FR-56, FR-63, FR-73, FR-78 | `jev_anti_slop_01..17` | `src/activities.ts:1950-2140` (readAntiSlop); `:2140-2546` (antiSlop); `src/state.ts:702-790` (antiSlopScope/antiSlopStatus); `src/activities.ts:2547-2709` (actionCheck delivery diagnostic) | `bun test tests/anti-slop.test.ts`; `bun tools/live-smoke.ts direct --scenario workflow` | Implemented core, GAP-06. Advisory findings, trust marks, falsifiers, fragments, bounds and multi-part coverage exist. The `write xd://jev_*` device route is classified as a non-mutating diagnostic call (Main fix). Residual `/jev-waive` and "cannot be delivered" text contradicts FR-54/76/78; old delivery/waiver test names remain. No waiver command is registered. |
| Context archive — `jev_context.feature` | FR-68, FR-73, FR-74 | `jev_context_01..11` | `src/controller.ts:328-344` (contextTool); `:251-283` (prepareContext citation/inventory isolation); `src/context.ts:17-353` (createContextArchive); `src/controller.ts:284-312` (captureOwner/snapshotApproval) | `bun test tests/context.test.ts`; `bun test tests/controller.test.ts` | Implemented. Tamper, digest, symlink and malformed-record checks covered by tests. A selected intact source remains usable when an unrelated archive record is corrupt; the archive problem is returned in result details. Context reads bypass the explicit judgment queue. Archive reads restore no approval. |
| Strict supervisor — `jev_autonomy.feature` | FR-57..FR-66, FR-73, FR-76 | `jev_autonomy_01..20` | `autonomy/index.ts` (entry); `autonomy/runtime.ts:741` (createAutonomyRuntime); `autonomy/store.ts:359-1491` (openAutonomyStore); `autonomy/scope.ts:90-599` (scope/fence); `autonomy/driver.ts:2875-3200` (start/resume/status/stop CLI) | `bun test tests/autonomyEntry.test.ts`; `bun test tests/autonomyStore.test.ts`; `bun test tests/autonomyScope.test.ts`; `bun test tests/autonomyDriver.test.ts`; `bun test tests/autonomy.test.ts`; `bun tools/autonomy-smoke.ts --scenario all --deadline 600` | Implemented with open acceptance. FR-61 and FR-63 remain unchecked in PRD; end-to-end live strict acceptance is unproven (GAP-09). Main reports a known-running async stop loop and rotation_request fake-completed regression; repair is in progress and **not accepted here** (GAP-15). Ordinary mode loads none of this module. |

## 7. Detailed acceptance by business surface

### 7.1 Diagnostic contract (FR-73..FR-75)

**Required business behaviour.** A judgment can pass, fail, be inconclusive, be unavailable or not
run. Every result is retained; none is an execution error or permission. `/jev-status` reports work
coverage, check coverage and current-revision acceptance separately.

**Observable acceptance.** A failed review followed by an unrelated write completes; `session_stop`
does not wait; the result carries the five-key diagnostic shape; background action checks start as
`not_checked`; an asynchronous launch remains `not_checked`; a below-floor answer is `inconclusive`;
a malformed call is `not_checked`; a stale answer is discarded without a finding.

An asynchronous launch records the action and a pending effect. Only a terminal async result with
the matching job id, tool type and a non-earlier timestamp settles that effect and starts its action
diagnostic; unmatched results leave it `not_checked`. While an effect is unobserved, acceptance
returns a prerequisite rather than a judgment, and ordinary work/completion continue. A Jev tool
invoked through `write xd://jev_*` is a diagnostic call, not a project mutation, and does not advance
the project work revision.

**Evidence.** `src/state.ts:145-182`; `src/controller.ts:147-160,351-388,475-557`;
`tests/diagnosticController.test.ts`; `tests/controller.test.ts`; `tests/controllerLifecycle.test.ts`. Async result delivery and identity
are under active repair by Main; `jev_diagnostics_15` states the intended contract, not a passed
live observation.

**Gaps.** FR-17 is not implemented as an ordinary completion pre-check; completion is deliberately
independent (GAP-10). No live host observation is recorded here.

### 7.2 Owner session mode (FR-71, FR-76, FR-77)

**Required business behaviour.** `/jev` reports or switches diagnostics for one in-memory session.
`off` stops checks, source capture, prompt injection and judged execution; a Jev call returns an
explicit skipped result. `on` starts a fresh workflow, retaining usage and diagnostic totals but not
old approvals or findings. No configuration or permission changes. A mode change is a `nextTurn`
message with `triggerTurn: false`: it never steers an in-flight batch, its mode-only instruction may
enter provider context at the next turn boundary, and it starts no idle model turn.

**Evidence.** `src/controller.ts:397-427`; `tests/controller.test.ts` (off/on, isolation, stale
answer, status tests). Live: `bun tools/live-smoke.ts host --scenario workflow`.

**Gaps.** Host command routing is not observed in this document. In strict mode, the switch affects
diagnostics only; safety limits remain.

### 7.3 Configuration and credentials (FR-78)

**Required business behaviour.** Only `antiSlop.mode` (`off`/`advisory`) and `billing.*` are read.
Obsolete gate/course keys are ignored. `enforce` is invalid, falls back to advisory and is reported
with file/key. Invalid values keep effective values and report. At session start the owner sees the
warning and the exact problem text through the host UI notification; no configuration details are
sent as model content. Credentials resolve from environment then command; missing/failing
credentials produce unavailable judgment.

**Evidence.** `src/config.ts:16-163`; `src/apikey.ts:23-55`; `src/judge.ts:216-255`;
`tests/config.test.ts`; `tests/apikey.test.ts`; `tests/judge.test.ts`.

**Gaps.** A balance is an owner-supplied snapshot, not a live API value. The startup problem notice
is covered by the configuration scenario with an injected host context; no native host run is
recorded here.

### 7.4 Owner follow-up and restart (FR-68, FR-69, FR-41 unimplemented, FR-42 covered)

**Required business behaviour today.** Authentic interactive/RPC input is archived exactly and
classified at the next workflow boundary. Continuation preserves approvals; amendment extends the
objective and invalidates dependent decisions while keeping unaffected requirements and plan
details; replacement requires `jev_reaim`; unclear is diagnostic uncertainty. Approval-looking text
creates no override.

**Evidence.** `src/controller.ts:284-312,438-473`; `src/activities.ts:693-792`;
`src/state.ts` retained requirements/plan; `src/context.ts`; `tests/controller.test.ts`;
`tests/context.test.ts`; `tests/activities.test.ts`; `tests/state.test.ts`;
`tests/scenarios/steps/owner_followup.ts`.

**Pending promises.**

- FR-41: ordinary restart does not restore task/accepted decisions from the native journal; ordinary
  state is session-local (`src/controller.ts` clears on `session_start`). `jev_owner_followup_12` is
  the runner-allowlisted unimplemented case. GAP-02.
- FR-42: `jev_owner_followup_13` and `_14` have executable scenario coverage for unaffected-decision
  retention and the diagnostic re-binding; no pass is asserted here. Its "execution SHALL wait"
  clause conflicts with FR-73 and is not a current obligation. GAP-08 is closed in the status note.

### 7.5 Tools: triage, requirements, plan, consult, search, re-aim, course, review, text

The tool groups share one acceptance rule: a valid judgment returns a typed diagnostic; invalid
input and missing prerequisites are recorded as not checked and create no finding; a stale answer is
discarded; an outage is unavailable; repeated unchanged material costs no second call; none of these
results authorizes or blocks an effect.

**Evidence anchors.** `src/activities.ts:538-613` (consult), `614-692` (re-aim), `793-898` (triage),
`899-988` (search), `989-1115` (requirements), `1157-1551` (plan), `1697-1765` (review),
`1766-1907` (text), `2715-2895` (course). Tests: `tests/activities.test.ts`,
`tests/controller.test.ts`, `tests/state.test.ts`, `tests/gates.test.ts`.

**Known textual conflicts.** Triage still says "changes stay blocked until the plan is approved"
(`src/activities.ts:889`), re-aim names `/jev-continue` (`src/activities.ts:621`), and the staff
manual still says a finding "remains OPEN" (`src/jev-skill.md:81`). These are wording defects that
contradict the diagnostic contract; they are listed as GAP-04/05/06.

### 7.6 Acceptance (FR-14, FR-15, FR-26)

**Required business behaviour.** Business and architecture are separate aspects at the current
revision. Both require at least one execution item and one code item before judgment. The claim is
not evidence. Each plan topic is judged; one unmet topic prevents whole-aspect acceptance. Below-floor
and unsupported answers are inconclusive; an established business/architecture gap is a defect. A
later consequential action or plan change invalidates prior acceptance.

**Evidence.** `src/activities.ts:1552-1696`; `src/state.ts:546-580`;
`tests/activities.test.ts` (FR-14/15/26); `tests/state.test.ts`.

**Gaps.** The execution preflight checks the evidence kind, not that the quote contains both command
and output (`src/activities.ts:1571-1577`); topic questions are boolean and carry no answer field
naming the evidence (`src/activities.ts:1603-1609`). Both are GAP-01. FR-39 automatic acceptance and
FR-43 evidence-first recovery remain pending (GAP-02, GAP-03).

### 7.7 Anti-slop and external delivery (FR-45..FR-56)

**Required business behaviour.** Review only external deliverables. Validate all required material
and bounds before any call. Verify claims against submitted evidence, mark trust, require
falsifiers, re-check inferences, and check language/register/meta-text/relevance per fragment.
Findings are stable, advisory and disclosed. No waiver command, repair permit or delivery permission
exists. Strict delivery additionally requires the authorized effect class and exact reviewed bytes.

**Evidence.** `src/activities.ts:1950-2546`; `src/state.ts:702-790`;
`tests/anti-slop.test.ts`.

**Gaps.** Residual result text says an artifact "cannot be delivered until each is corrected or
waived" and asks the owner for `/jev-waive` (`src/activities.ts:2517`, `:2669`); the catalog
description repeats the waiver clause (`src/guidance.ts:48`); waiver APIs remain in state
(`src/state.ts:720-740`). No command is registered, so this is contradictory guidance rather than a
working gate — GAP-06. Old test names still describe "delivery waits" and "owner waives" and must be
reconciled.

### 7.8 Context archive (FR-68)

**Required business behaviour.** List stable sources and metadata without content; read one complete
source with digest; authenticate cited `sourceId` and exact quote before judgment; reject tampered,
renamed, malformed or symlinked records; preserve the original finding material; restore no
approval. Context reads do not wait for an explicit judgment.

**Evidence.** `src/controller.ts:251-283,328-344`; `src/context.ts:17-353`; `tests/context.test.ts`;
`tests/controller.test.ts`. An intact, explicitly cited source remains usable when an unrelated
archive record is corrupt; the inventory problem is returned in the result details rather than
invalidating the selected source.

**Gaps.** None identified. The context scenarios execute in `tests/scenarios/run.test.ts`; this
document asserts no pass.

### 7.9 Strict supervisor (FR-57..FR-66)

**Required business behaviour.** Explicit activation only; frozen policy envelope; exclusive
overlapping-root ownership; durable intent before effect; exact containment/fencing; operator stop
without waiting for Jev; unknown-effect reconciliation; restart restores records but invalidates
stale execution acceptance; judge budgets skip diagnostics only; completion records evidence without
claiming validation.

**Evidence.** `autonomy/index.ts`; `autonomy/runtime.ts:741`; `autonomy/store.ts:359-1491`;
`autonomy/scope.ts:90-599`; `autonomy/driver.ts:2875-3200`; `docs/autonomy.md`.
Tests: `tests/autonomyEntry.test.ts`, `tests/autonomyStore.test.ts`, `tests/autonomyScope.test.ts`,
`tests/autonomyDriver.test.ts`, `tests/autonomy.test.ts`.
Live: `bun tools/autonomy-smoke.ts --scenario all --deadline 600`.

**Gaps.** FR-61 and FR-63 are unchecked in PRD. Real post-compaction completion and crash-effect
reconciliation remain unapproved. Full current strict live acceptance is unproven — GAP-09. Main
further reports two strict lifecycle regressions under repair: a known-running asynchronous effect
can keep a stop loop alive, and a `rotation_request` was observed as falsely completed. Neither is
accepted by this document; scenarios `jev_autonomy_19` and `_20` state the required behavior, and
GAP-15 tracks the repair.

### 7.10 Pending and conflicting PRD promises

These promises are mapped explicitly so Main can integrate them into `PRD.md` without silently
reducing scope. Their feature scenarios are tagged `@pending` or `@gap_*`.

| PRD | Exact promised outcome | Feature scenario | Current status |
| --- | --- | --- | --- |
| FR-39 | At completion, collect observed code and execution evidence, submit missing business and architecture acceptance automatically, and return unmet obligations without manual acceptance calls. | `jev_acceptance_12` | Executable scenario and `src/controller.ts` `diagnoseCompletion` path exist for an explicitly approved plan. The scenario suite records the result; this document asserts no pass. |
| FR-41 | Resuming an OMP session restores its task and accepted decisions from the native session journal; changed files or plan sections invalidate only affected details; prior completion and execution acceptance require fresh verification after restart. | `jev_owner_followup_12` | Unimplemented and allowlisted by the runner. Current ordinary state is session-local and cleared on `session_start`. The strict module has its own durable ledger, not the native-journal promise. |
| FR-42 | A judged owner correction retains unaffected requirements, outline steps and plan details; dependent decisions are reviewed again; execution waits for a newly bound complete plan. | `jev_owner_followup_13`, `_14` | Unaffected-decision retention has executable scenario coverage. The execution-wait clause conflicts with FR-73 and is not a current obligation. No pass is asserted here. |
| FR-43 | Missing or unsuitable evidence returns the unmet requirement and its approved verification section, directing observation before implementation repair; only an established defect directs repair. | `jev_acceptance_13` | Executable scenario coverage; acceptance returns approved verification sections in `details.unmetSections`. No pass is asserted here. |
| FR-07 | Plan review is connected to the actual host plan-mode boundary. | `jev_plan_review_13` | Unimplemented and allowlisted by the runner. Review reads a `local://` artifact; no host plan-mode hook was found. |
| FR-17 | Before a developed task is reported complete, Jev checks whether the work follows the owner's requirements. | `jev_diagnostics_02` (current diagnostic behaviour) | Conflicting. Ordinary completion deliberately does not run a completion check; strict runtime records evidence-bound completion. Reconcile FR-17 with FR-73/FR-62. |
| FR-38 | Before a consequential invocation executes, submit its complete payload for Jev authorization. | No positive scenario; superseded behavior. | Conflicting and not implemented. Contradicts FR-73/FR-76; the PRD supersession table omits FR-38. |

## 8. Gap register (for Main)

> **Status update (2026-11-15, after the audit snapshot).** Rows GAP-01, GAP-03, GAP-04, GAP-05,
> GAP-06, GAP-08, GAP-10, GAP-11 and GAP-12 are closed: acceptance now requires literal execution
> and code evidence with a per-topic basis; unmet plan topics return their approved verification
> section; the triage, re-aim and anti-slop prose no longer mentions blocking, `/jev-continue` or
> status; the waiver storage and validators were deleted; owner follow-ups retain unaffected
> requirements; ordinary completion is diagnostic-only; and the PRD marks FR-34/38/54/56 as
> superseded or diagnostic. GAP-14 is closed: `tests/scenarios/run.test.ts` executes every
> scenario and fails a missing step unless it is one of the two allowlisted unimplemented cases.
> GAP-02 (durable ordinary restore), GAP-07 (host plan-mode hook), GAP-09/GAP-15 (strict live
> acceptance) and GAP-13 (dead recovery vocabulary in comments) remain open. The row text below is
> the historical snapshot and is not a current defect list.

| ID | Severity | Affected requirement / scenario | Evidence | Required resolution |
| --- | --- | --- | --- | --- |
| GAP-01 | High | FR-26; `jev_acceptance_05`, `jev_acceptance_06` | `src/activities.ts:1571-1577` accepts evidence by kind only; `src/activities.ts:1603-1609` sends boolean topic questions and no evidence-naming answer field | Validate command+output (or require explicit output quote) and return the evidence basis per topic, or narrow the PRD with owner approval. |
| GAP-02 | High | FR-41; `jev_owner_followup_12`; FR-39; `jev_acceptance_12` | `src/controller.ts:428-431` clears session state on `session_start`; no ordinary journal restore. `src/controller.ts:558-565` ordinary stop has no automatic acceptance collection. Main reports implementation in progress. | Implement or explicitly defer ordinary durable restore and automatic acceptance in PRD; accept only after tests and a real restore/completion observation. |
| GAP-03 | High | FR-43; `jev_acceptance_13` | Acceptance text names unmet topics/requirements but returns no approved verification section (`src/activities.ts:1661-1668,1678-1693`) | Return the unmet requirement's approved verification section and evidence-first next step. |
| GAP-04 | High | FR-73/FR-76; `jev_triage_11` | `src/activities.ts:889` says "changes stay blocked until the plan is approved" | Replace with diagnostic wording: work is recorded unreviewed; plan is context. |
| GAP-05 | High | FR-76; `jev_reaim_05` | `src/activities.ts:621` tells the executor `/jev-continue continues the current request` | Remove the removed command; name triage/requirements/re-aim correctly. |
| GAP-06 | High | FR-54, FR-55, FR-76, FR-78; `jev_anti_slop_16` | `src/activities.ts:2517`, `:2669`; `src/guidance.ts:48`; `src/state.ts:720-740`; `tests/anti-slop.test.ts` old names | Remove waiver/delivery-hold prose and obsolete waiver APIs/tests, or document an explicit owner decision restoring them (contradicts FR-76/78). |
| GAP-07 | Medium | FR-07; `jev_plan_review_13` | No host plan-mode hook found in `src/controller.ts` event registration; review uses a `local://` artifact (`src/activities.ts:1301-1415`) | Connect to the actual host plan-mode boundary or mark FR-07 unverified/deferred. |
| GAP-08 | Medium | FR-42; `jev_owner_followup_13`, `_14` | `src/activities.ts:766-773` deletes requirements/plan and invalidates acceptance on amendment; PRD FR-42 still requires execution to wait. Main reports the owner-amendment retention work is assigned/in progress. | Retain unaffected decisions, remove the superseded execution-wait clause, and accept only after regression proof. |
| GAP-09 | High | FR-61, FR-63; `jev_autonomy_05`, `_13` | PRD unchecked entries; `docs/autonomy.md` states full current live autonomy acceptance remains open | Run and record real strict acceptance, or keep the module explicitly not fully accepted. |
| GAP-10 | Medium | FR-17; `jev_diagnostics_02` | Ordinary `session_stop` does not run `completionCheck`; `src/controller.ts:558-565` returns without it. Strict runtime uses evidence-bound completion (`autonomy/runtime.ts`) | Reconcile FR-17 with the diagnostic contract: either make completion checking optional/diagnostic or mark it strict-only. |
| GAP-11 | High | PRD FR-38 vs FR-73/FR-76 | `PRD.md:152` still requires Jev authorization before a consequential invocation; the supersession table omits FR-38 | Add FR-38 to the supersession record and remove the authorization clause, or explicitly retain it with an owner decision that conflicts with FR-73. |
| GAP-12 | High | PRD FR-29/34/38/42/54/55/56/71 mixed current/superseded text | `PRD.md:148` FR-34 still says plan writes and review "remain held"; `PRD.md:152` FR-38 requires Jev authorization; FR-42 requires execution to wait; FR-54 still describes `/jev-waive`; FR-55/56 still use enforcement language; FR-71 still mentions a continuation grant; FR-29 says a plan grants execution | Keep one diagnostic clause set; mark every hold/authorization/waiver sentence historical. |
| GAP-13 | Low | Repository maintenance | `src/state.ts:105-107,240-241,253,583-595,626-654`; `src/types.ts:32-38,95`; `src/activities.ts:1524` retain "hold", "OPEN", "blocking", waiver and recovery terminology; `src/jev-skill.md:81` says a finding "remains OPEN" | Rename or remove dead recovery/waiver vocabulary so maintenance comments cannot reintroduce a gate. |
| GAP-14 | Medium | Gherkin executability | No step definitions/runner exists; `package.json` has no Cucumber dependency | Main decides whether to add executable step definitions; otherwise keep the feature set labelled normative only. |
| GAP-15 | High | FR-62, FR-65; `jev_autonomy_19`, `_20` | Main observed a known-running async strict effect keeping a stop loop alive and a `rotation_request` falsely recorded as completed; `autonomy/runtime.ts` and `autonomy/driver.ts` repairs are in progress | Fix both lifecycle paths and provide green regression tests proving the run stays waiting/rotation is not completion; do not claim strict lifecycle acceptance before that proof. |

## 9. Superseded obligations and non-promises

The following earlier PRD clauses are not current business obligations and must not be restated as
promises: `/jev-continue`, `/jev-waive`, approval-message overrides, repair permits, resolution
phases, OPEN findings that block, refusal/stop/ignored-call budgets that release or block, automatic
interval/completion course checks, `enforce` mode, plan-write/plan-review holds (FR-34), Jev
authorization of invocations (FR-38), and execution-waiting clauses on owner corrections or re-aims
(FR-29/42). See the FR-18/21/23/28/32/40/44/54/55/67/69/70/71/72 historical clauses and
`PRD.md` supersession record.

The feature set therefore contains no scenario that promises a work hold, a continuation command, a
waiver command or a Jev-granted execution permission. Scenarios that mention those words do so only
to require their refusal or absence.

## 10. Verification plan (not executed here)

Minimum current checks once implementation changes land:

```sh
bun test tests/diagnosticController.test.ts tests/controller.test.ts tests/controllerLifecycle.test.ts
bun test tests/activities.test.ts tests/state.test.ts tests/gates.test.ts
bun test tests/config.test.ts tests/apikey.test.ts tests/judge.test.ts
bun test tests/anti-slop.test.ts tests/context.test.ts tests/artifact.test.ts
bun test tests/autonomyEntry.test.ts tests/autonomyStore.test.ts tests/autonomyScope.test.ts
bun tools/live-smoke.ts direct --scenario diagnostics
bun tools/live-smoke.ts direct --scenario workflow
bun tools/live-smoke.ts host --scenario workflow --model deepseek/deepseek-flash --max-time 900
bun tools/autonomy-smoke.ts --scenario all --deadline 600
```

The executable suite uses stable scenario ids such as `jev_diagnostics_01` and requirement tags
such as `fr_73` as scenario tags. Filter a run by its test name (the scenario id is part of the
name) or by the entire scenario file; a filtered run is a selection of tests, not by itself a
result. Missing steps fail unless the runner allowlist names the exact unsupported scenario.

## 11. Acceptance record

| Date | Scope | Result |
| --- | --- | --- |
| 2026-11-15 | Feature reconciliation to the diagnostic-only owner contract | Complete as a specification and traceability deliverable. 17 feature files, 209 scenarios, stable scenario and requirement tags, no executable claim at that revision. |
| 2026-11-15 | Business implementation acceptance | Not granted. GAP-01..GAP-14 remain open; no tests or live runs were executed for this document. |
| 2026-11-18 | Executable scenario contract and owner-facing output | Documentation revision: the runner executes every scenario, missing steps fail except the two allowlisted cases, and the configuration scenario checks exact owner-UI warnings with no model message. No test pass is asserted here. |

The feature files and this document must be rechecked whenever the PRD, owner contract, ordinary
controller, anti-slop reporting or strict supervisor changes.
