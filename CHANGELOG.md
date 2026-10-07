# Changelog

## 0.1.0 - 2026-10-07

- Baseline: PRD, PLAN.md, package config, shared types contract (DecisionRequest/DecisionResult/Judge/MultiLabelJudge, TypeSafe systemone wire types, POLICY defaults).
- Live API unblocked: official key (`pass token/jev`) verified against direct TypeSafe endpoint - HTTP 200, jev-1.13.0, ~0.5s latency, usage returned. Synthetic live proof: noul, classification, topic relevance, code-review pair (approve 0.96 / revise 1.0 with task context in state), completion evidence gating (report-only -> insufficient_evidence 0.94). Intermittent transport resets observed -> client retry must cover resets.
- Slices: catalog/classification/routing (done, deferred-scope library per MVP cut), client+evidence+CLI (done), omp extension controller (done).
- Integration (2026-10-07): 111/111 tests green, `tsc --noEmit` clean, `guard.py --deep` clean. Live proof in real omp (explicit `-e` path, no global changes): plan gate blocks mutations until approved plan; missing key fails closed (`judged:false`, never approve); full round-trip through official api.typesafe.ai returns real verdicts (`judged:true`) inside the session. Evidence: `evidence/`.
- MVP per user focus: same-executor evidence-backed decision → live Jev verdict → correction → review/completion gates. Deferred: auto skill/model routing, large topic selection, provider cache measurement (AC7 sub-criterion), full refactor inventory stays test-backed.
- Review loop: round 1 findings (code 5, behavior B1-B7) all fixed and verified; round 2 both reviewers CLEAR (behavior incl. SDK supply-chain check).
- Official SDK transport adopted (@typesafe-ai/sdk 0.6.0, project-local) under unchanged signatures; hand-rolled wire removed.
- Template overrides implemented per R1-R6 (fail-closed load, only-raise threshold clamp, split precedence, policy-first instructions).
- Live-Jev dev consultations: gating-policy draft (POLICY-DRAFT.md), PRD gap review, implementation satisfaction review (evidence/).
- AC9 dogfood executed: whole-project final review through the addon in real omp; live verdict insufficient_evidence (0.41, judged=true) — fail-closed held; completion remains a user decision.
- Final state: 128/128 tests, tsc clean, guard --deep clean, both reviews CLEAR, AC observed statuses recorded in ACCEPTANCE.md.
- Universal decision-point engine: control-points registry (4 presets), stages derived from registry, config `controlPoints` (on_demand) with fail-closed validation; course_check preset (per-requirement drift Noul + fixed next-action Choice) with live round-trip proof.
- Round-3 scope: 140/140 tests, tsc clean, guard clean; live-Jev idea reviews (evidence/jev-ideas-review.md) confirmed generalize direction (9/10) and implementation gap.
- Round 4-5: per-requirement drift judge wired into production course_check (createCourseCheckJudge; requirements = verbatim user/spec quotes; continue/verify recorded only, redirects -> revise + same-session feedback, ask_user escalates); duplicate-requirement dedupe; config threshold threaded into course-check floor. 148/148 tests, tsc clean, guard clean; live drift round-trip (0.74 -> verify_before_proceeding). Reviews CLEAR rounds 3-5.
- Polish phase (Jev-guided, 6 requests / 5 changes): evidence pre-check, verdict summary lines, friction texts, discriminating drift phrasing, drift visibility; judge-ordered freeze.
- Field trial: minecraft clone built autonomously via the addon (deepseek-flash); work execution-verified; completion gate fail-closed on 5 sub-floor approves -> honest escalation (calibration finding for GAP:3). Verdict: evidence/mc-session-verdict.md.
- Meta-options: every judge Choice carries ALL_OPTIONS_WRONG/PARTIALLY_RIGHT_NONE_FULL/NO_FIT_OTHER_REASON + meta_reason; escape never approves (review CLEAR).
- Release gate: aspect-drift teeth persist across restarts; completion streak only at policy-default threshold (raised thresholds = strict single bar); inert confidenceFloor rejected at load; README rewritten for public release; MIT license; renamed jevstice. 174/174 tests, tsc clean, guard clean; reviews CLEAR rounds 6-8.

## 0.2.0 - 2026-10-07

- Audit fixes (all reproduced before, regression-tested after):
  - Invalid/unreadable config no longer unregisters the extension: gates stay registered and fail closed with the file+problem named (PRD 12.2/12.7; integration tests through the real entrypoint).
  - Calibration-tolerant completion works in production: the SDK client reports a typed `completionCandidate` for mid-band approves (strict verdict stays `insufficient_evidence`); the controller counts 2 consecutive candidates bound to task+work+content digest (PRD 17.1). CLI output unchanged.
  - Read-only tasks are gated: session_stop demands plan approval, a fresh judged course_check (continue) and completion evidence once a task fingerprint exists, mutated or not (PRD 12.2, FR-07).
  - Benign course_check outcomes (continue/verify_before_proceeding) no longer consume the rework bound; only redirects, escalations and failed consultations do (PRD 14).
  - Completion capability coverage is judge-assessed per aspect (fixed three-way Choice, untrusted-evidence policy, fail-closed on malformed/low-confidence/meta) instead of keyword matching; `requireAll` downgrades not_applicable for declared capabilities; `aspects` added to the tool schema (PRD 15/FR-13, AC12 reachable via the registered tool).
  - Wired course_check validates the judge contract (fixed next-action set, exact onTrack keys, finite confidence at/above floor; drift never continues) and binds freshness to task+workRevision; raised completion config applies on mid-session reload.
- Live-Jev review loop for this release: remediation plan direction_review + per-requirement course_check (both flagged the two weak areas before implementation); final release review through the addon CLI returned revise 0.33 -> verify_before_proceeding 0.60 (all six requirements on track) -> insufficient_evidence 0.38 - below the 0.6 floor, so release approval escalates to the user per POLICY (no faked success; same whole-project calibration ceiling as the field trial).
- 217/217 tests, `tsc --noEmit` clean, LSP diagnostics clean; guard fast tier has no js/ts analyzer configured in this repo (deliberately no lint/format tooling).

## 0.3.0 - 2026-10-07

- `gates.mutation` switch (user-owned, default on): `false` lifts the plan gate so mutating tools
  are no longer blocked while no plan-stage approval exists. Judging, digests, bounded rework and
  the completion binding are unchanged; the stop gate drops the plan requirement under the same
  switch. Written because the gate had no way back once plan-stage approvals stopped arriving.
- One transport retry policy: the SDK retry is switched off and this module owns transport-class
  retries (socket resets, timeouts, rate limits) with exponential backoff. Live: 2 of 3 extension
  calls died with APIConnectionError after maxRetries=4 while plain fetch to the same endpoint
  succeeded; stacking SDK retries on top of ours turned an unreachable endpoint into a 30s+ hang.
- `eval` added to the mutation gate: it spawns processes and writes files from inside the kernel
  without a tool_call of its own, so it was a straight bypass of the gate.
- CLI tests made hermetic (two cases relied on an empty ambient environment).
- Threshold diagnosis (live, 15 judged calls): approval confidence is not option-count-limited -
  a decisive evidence set yields approve 0.94-0.96 on both 2-way and 7-way questions. It collapses
  to 0.14-0.26 when the question asks for an open judgement (approve my plan) and reaches 0.79 when
  the same plan is phrased as a claim checked against quoted sources. The 0.8 floor is calibrated
  for verification, not for plan approval; the plan stage therefore fails closed permanently.
  225/225 tests, tsc clean.

## 0.3.1 - 2026-10-07

- Key resolution unified (`src/apikey.ts`): one path for the CLI and the extension - environment
  variable first, else the resolver command. The extension resolves the key lazily and memoized,
  so a host that keeps the secret in `pass` needs no exported variable; a transient resolver
  failure is retried instead of poisoning the session. The main judge and both sub-judges
  (course check, aspect coverage) use the resolved key.
- Plan-stage directive in the tool description: file a plan as a claim checked against the quoted
  evidence (what it asserts, which quote supports it), with the measured numbers - an open plan
  summary with no quotable anchor is answered insufficient_evidence.
- Submissions to the judge are English by rule: the executor's own text (task, proposal, option
  labels, meanings) is English; quoted evidence keeps its source wording verbatim. Stated in the
  tool description and in the README, asserted by a test.
- Second permanent-block path found and switched: the stop gate requires a judged `course_check`
  with a `continue` record at or above the 0.6 confidence floor, but the next-action question
  offers eight options and the judge's confidence on it lands below the floor, so the completion
  boundary could never be satisfied. `gates.completion` (user-owned, default on) lifts the stop
  gate - completion approval, the fresh course_check and the aspect teeth - while judging, digests
  and bounded rework stay unchanged.
- Rework bound no longer closes a stage on honest answers. It now counts an identical
  resubmission; a submission whose content differs is new work and gets a fresh budget. Three
  honest `revise` answers used to exhaust the stage for the whole task and escalate
  ("do not continue rework"), which deadlocked the owner, while PRD 1.1 asks for many cheap
  iterations. Identical repeats are still refused, so the anti-loop property is unchanged.
- 238/238 tests, `tsc --noEmit` clean.

## 0.4.0 - 2026-10-07

- FR-01 and FR-04 wired into the runtime: at the start of a new task the extension classifies the
  task and marks the applicable plan topics through the judge over the bundled catalog, records both
  in session state and delivers them as same-session feedback. Advisory and non-blocking - the task
  starts immediately (measured 0 ms) and the checks land in the background; an abstention, a judge
  failure or an unwired catalog records uncertainty instead of stopping the work.
- Live proof (real endpoint, fake host): `Jev catalog: task type development; applicable topics
  algorithm, architecture, backend, data, general, infrastructure, research, security` for a REST
  API task - obtained 0 ms after the task start.
- The wiring follows the judge's own parallel verdict per requirement: the requirements establish
  that the checks run automatically, and do NOT establish that candidate lists are discovered from
  the environment. FR-02/FR-03 (skill and model routing) therefore wait for an owner-held candidate
  list in the config.
- 242/242 tests, `tsc --noEmit` clean.

## 0.4.1 - 2026-10-07

- FR-02/FR-03 wired: `skill_routing` and `model_routing` are registry stages and the controller
  routes them through the catalog library against the candidate lists the owner holds in
  `jev.config.json` (`routing.skills`, `routing.models`, optional `routing.allowlist`, which
  defaults to the model candidate list). An approved skill is recorded; an approved model is
  enforced at the next subagent spawn. A model outside the allowlist never reaches the judge.
- Without candidates the stage refuses explicitly (`routing.skills` / `routing.models` named) and
  judges nothing - the old code approved such a submission while applying nothing, which read as a
  successful routing that never happened. That dead branch is removed.
- Live check against the real endpoint: the routing path runs end to end, the judge abstained on a
  one-line evidence set (0.33 skill, 0.67 model) and nothing was applied - the honest outcome.
- 249/249 tests, `tsc --noEmit` clean.

## 0.5.0 - 2026-10-07

- FR-10 stages registered: `important_decision` and `code_review` were declared in the stage
  vocabulary but had no control point, so the executor could not submit them; both are now
  on-demand presets that never grant an approval. The declared-but-unregistered `refactor_check`
  name is removed (its coverage lives in completion_review capabilities, AC6).

- Consultation forcing (owner order: "чем лучше продукт форсит условия, тем лучше будет результат"),
  implementing the measured regimes recorded in `evidence/consultation-forcing.md`:
  - Plan stages (`understanding_review` / `direction_review`) gained a pre-judge grounding check: a
    proposal that does not quote one submitted evidence item (>= 20 characters) verbatim is refused
    BEFORE any judge call, consuming no rework, and the refusal names the fix. Rationale: an
    ungrounded plan question is answered insufficient_evidence at 0.14-0.26 and reads as judge
    failure, while the same material phrased as a claim reaches 0.79-0.96. It composes with the
    existing requirement-evidence and duplicate/short-quote checks without duplicating their
    messages, and a pre-check refusal now carries a summary line naming its problems instead of a
    bare verdict.
  - `claim_check`: new `on_demand` preset for the measured strongest regime - 2..N claims judged in
    ONE request, one Noul per claim, one verdict per claim. A dedicated judge keeps that per-claim
    question form with claim-support wording; the existing multi-label path is not reused because
    its question asks whether an item applies to the task, which is a different question (a live
    direction_review consultation approved the dedicated-Noul design, 0.85). Per-claim results land
    in the submission summary and in session state (`lastClaimCheck`, restored across restarts);
    unsupported claims come back as `revise` naming them; an unmarkable claim fails closed as
    `insufficient_evidence` naming that claim; never gate-granting. Fewer than two claims is
    refused before any judge call.
  - The registered tool description now states the consultation protocol: one decision per request;
    a claim checked against quoted evidence; 3-6 short non-duplicate quotes with at least one
    requirement quote on plan stages; 2-4 alternatives whose meanings state what choosing them
    commits to; the product's own pre-check refuses an ungrounded proposal before any judge call;
    and an abstention is not a verdict.
  - Escape options carry the fix: `ALL_OPTIONS_WRONG` / `PARTIALLY_RIGHT_NONE_FULL` /
    `NO_FIT_OTHER_REASON` reasons now name what to change (replace or restate the options, reframe
    the claim), and the summary line of an `insufficient_evidence` frame escape carries it too.
- README documents the protocol and the new preset; the grounding rule is part of the plan-gate
  bullet.

FR-11 sub-agent hand-off gate (Jev sits in the lead-agent -> task-agent delegation path):
  - New `subagent_handoff` control point (`on_demand`, `verdictMapping: standard`) and the two
    boundary checks behind it: dispatch (work order judged against the requirement captured at task
    start) and acceptance (returned result judged against the same requirement plus the work order).
    Wired only when the config declares `stages.subagent_handoff` - the policy is unconfirmed
    (PRD GAP:3) and POLICY-DRAFT lists spawn judging as a post-approval item, so an unwired config
    behaves exactly as before.
  - Blocking is deliberately narrow: only a judged `revise` at or above the confidence floor, with
    the offered option set naming the refusal and no frame-escape marker, refuses a spawn. An
    abstention, judge error, low confidence, missing requirement, frame escape, unattributable work
    order or an answer past the 25s internal deadline records the uncertainty and lets the spawn
    through (host handler timeout is 30s and drops a late result, so a late negative must never be
    recorded as a refusal that applied). A live consultation put the judge's own choice at
    explicit-negative-only 0.92; the claim itself was not approved (0.45), which is why the gate
    stays opt-in.
  - Acceptance rides `tool_result` (the only hook that observes a task result, and one that cannot
    refuse a call): a confident negative becomes an unresolved blocker plus same-session feedback,
    and the consult is not awaited so judge latency cannot delay the result reaching the model.
  - Work orders are captured from the `task` tool call keyed by toolCallId, consumed one per spawn,
    retired when the call settles, cleared when the task changes and aged out after 2 minutes -
    a call refused before execution (block/preflight/deny) never emits `tool_result` and must not
    disarm the check. Attribution stays conservative: with several calls in flight the spawn event
    carries no toolCallId, so the spawn is not judged at all.
  - `bun test` 283/283 (12 of them this slice), `tsc --noEmit` clean, no API key in logs.
- Release totals: 283/283 tests (+22 consultation forcing, +12 FR-11 hand-off), `tsc --noEmit` clean.

## 0.5.1 - 2026-10-07

Execution-time destructive-action gate (POLICY-DRAFT class I: destructive actions - `rm -rf`, force
push, schema drop - must ALWAYS be judged, fresh decision at execution time, the plan does not
cover them; judge verdict `always_judge` at confidence 0.88, `pol_I` 0.92):
  - New `destructive_action` control point (`on_demand`, `verdictMapping: standard`), consulted by
    the controller itself from the `tool_call` boundary. It is armed only by a non-empty
    `gates.destructive.patterns` list (user-owned, default off): absent or empty means the gate does
    not exist, and an invalid block fails closed naming the file and the problem. A `bash` command
    matching any pattern is judged before it runs, with the command and the session task as evidence.
  - Blocking is deliberately narrow, the same condition as the FR-11 hand-off gate: only a judged
    `revise` at or above the confidence floor, with the offered option set naming the refusal and no
    frame-escape marker, refuses the call. An abstention, a judge error, a low confidence, a frame
    escape or a verdict past the 25s internal deadline records the uncertainty in session state and
    lets the command run - an abstention never blocks (blocking on one becomes a permanent block, as
    measured). The internal deadline sits under the host's 30s `tool_call` handler bound, whose
    on-timeout policy is fail-closed, so it fires first and takes the fail-open path; a verdict that
    lands later is never read, so a late answer can never pin a refusal that was not applied.
  - Matching semantics (Jev consulted; the judge abstained at 0.29, so the conservative reading was
    taken): patterns are case-insensitive literal substrings with whitespace collapsed - the pattern
    text is data, cannot be malformed and cannot turn an owner typo into a different match.
  - A separate `tool_call` handler (same shape as the FR-11 dispatch side) keeps the plan gate's
    result deterministic: a plan-gate block short-circuits the event, so an already-blocked command
    never spends a consultation.
  - `bun test` 302/302 (14 of them this slice: 4 config, 10 controller), `tsc --noEmit` clean.
  - Integration shim corrected while adding the second `tool_call` handler: the fake host kept one
    handler per event in a last-wins map, which would silently drop a gate; it now keeps the same
    handler list the real runner does (`ext.handlers.get(event)`, first `block` wins).

## 0.6.0 - 2026-10-08

Activities framework (owner order 2026-10-07): the activity level above the control-point mechanism.
  - `src/activities.ts` - the registry of the six activities (task_definition,
    requirements_formalization, planning, development, review, completion, spec
    `evidence/activities-framework.md`): each declares its purpose, entrance boundary, required
    evidence, FIXED outcome set, invariants, outcome -> action map (`continue` /
    `return_to_activity` / `replan` / `escalate` / `block`), enforcement mode with the switch that
    arms it, the course mechanism, and the wired mechanisms (stage + `gate`/`stage`/`controller`
    wiring) that implement it. The control-point registry stays the mechanism; the activity registry
    is the frame that says which mechanism belongs where.
  - `validateActivityRegistry` reports every way a declaration can be decorative: an activity with
    no mechanism, a mechanism whose stage the engine does not know, a gate wiring on a non-gate
    trigger, a controller wiring without a location, an outcome no edge can produce, an edge outside
    the outcome set, a verdict no edge answers, an outcome without an action. `stagesWithoutActivity`
    reports the reverse (a registered control point belonging to no activity). `tests/activities.test.ts`
    fails the suite on any of them - a declared-but-unwired activity is a defect.
  - Outcome sets are enforced at runtime, not only in tests: an engine answer the owning activity
    cannot express in its declared set fails closed (`insufficient_evidence`, `judged: false`, naming
    the activity and the answer) before any approval is recorded. The guard resolves through the
    controller's `activities` dependency, so a doctored registry is testable.
  - New `requirements_formalization` control point (`on_demand`, advisory, never gate-granting) and
    its per-item marking judge (`createRequirementsFormalizationJudge`, one request, Noul per item,
    sharded at the API limit, exact-id contract, fail-closed): the draft numbered list comes back
    with each item marked traceable to a quoted user/spec item, plus the coverage verdict naming the
    quoted source texts no requirement captures. An item no quote entails is refused as
    `item_untraceable` and named; a quote no item captures is `coverage_missing` and named; only a
    fully accepted list is stored as `complete` and used as the task's requirement checklist. Two
    readings were put to the judge live before implementing: "a formalized requirement must be
    stated or directly entailed by a submitted user/spec quote" (approve, `state_or_entail`, 0.95)
    and "coverage is judged per submitted quote, not against the task as a whole" (approve,
    `per_quote`, 0.88).
  - New `plan_mapping` control point (`on_demand`) - planning's per-requirement mapping: for every
    formalized requirement, the submitted claim that the plan serves it is marked by the existing
    claim_check path (one Noul per claim, one request); a formalization with a single requirement
    goes through one claim-shaped decision instead (the marking path starts at two claims). A
    requirement with no submitted claim, or with a claim the quoted evidence does not support,
    leaves planning incomplete: the mutation gate names those requirement ids, the stop boundary
    names them too, and the gate opens only when every formalized requirement is mapped. Without a
    formalization nothing changes (no formalization, no mapping demanded).
  - Automatic course check (owner order during the slice: the agent must be able to consult the
    judge DURING the session - `courseCheck.everyMutations`, user-owned, default off; PRD 14
    "периодически и на границах"). After every N allowed mutating tool calls the controller submits
    `course_check` itself, in the background (judge latency reaches 33s on the resetting endpoint,
    so it must never hold a turn), against the formalized requirement list when one exists and else
    the task prompt as the single requirement. The verdict is recorded in session state
    (`lastAutoCourseCheck`) and fed back into the same session: continue and
    verify_before_proceeding are recorded, return_to_requirement/replan go back as a remark,
    ask_user becomes a recorded blocker; a judge error, an unusable answer, a sub-floor confidence
    or a missing requirement records uncertainty and blocks nothing. It never spends the rework
    budget (the executor did not choose to spend it) and never satisfies the completion boundary,
    which still needs a deliberate course_check with `continue`.
  - Live round-trip of the formalization judge (real client, real endpoint): a 3-item draft list
    against 3 quoted sources returned `traceable: req-1 false, req-2 true, req-3 false` (the
    fabricated GPU item refused) and `covered: quote-1 false, quote-2 true, quote-3 true` - the
    requirement list itself, not only a verdict. The first attempt died with the documented socket
    reset and needed the transport retry budget.
  - README gains the "Activities" section (the spec table plus how each activity is armed), the two
    new stages, the `courseCheck` config key and the automatic-consult sentence.
  - `bun test` 341/341 (39 new: 14 activities registry, 6 client formalization, 16 controller
    formalization/planning/periodic-course-check/outcome-guard, 3 config), `tsc --noEmit` clean.

## 0.6.1 - 2026-10-08

Rework loop with approach variation (owner order 2026-10-08, PRD 19 / TASKS "Rules of the loop"):
"ты должен делать N попыток что то переработать или улучшить. при этом каждый раз меняя подход,
чтобы не зацикливаться". The bounded rework now carries the approach dimension, not only the digest.

  - `approach` is a new optional submission field (`ValidatedDecisionInput.approach`): a short name of
    the move this attempt takes, e.g. "tighten the trigger", "split into narrower items". It is
    validated like the other optional fields (non-empty string, trimmed) and refused pre-judge when
    malformed. Submissions that name no approach keep the previous digest-bound semantics unchanged.
  - New per-`taskFingerprint:stage` journal in the session state (`JevState.reworkJournal`,
    `ReworkAttempt`/`ReworkJournal`): every JUDGED attempt with the approach it named and the judge's
    own verdict plus verbatim reasons (capped at 240 chars), the exhaustion flag `open`, and the
    persisted validator `restoreReworkJournal` (malformed entries dropped, attempt numbers re-derived
    positionally). A restart therefore cannot forget which approaches are spent.
  - A repeated approach is refused BEFORE any judge call, naming the approaches already spent and the
    attempt that spent the repeated one; the refusal consumes no consultation and no rework (same
    pre-judge refusal policy as the grounding pre-check). Comparison folds case and inner whitespace
    only. The check runs at the head of the pipeline, so it covers every stage including the wired
    presets (course_check, claim_check, formalization, plan_mapping, aspect_coverage) and capability
    coverage.
  - The bound counts ATTEMPTS, not consultations: after N attempts (each with its own approach) the
    stage escalates with `ask_user`, the blocker carries the journal (which approaches were tried and
    what the judge answered each), and the exhaustion is recorded as an OPEN item - the wording is
    never bent until the judge agrees.
  - The approach is part of the REWORK-BOUND digest only: a new approach is a new attempt even over
    unchanged wording, while the approval digest (AC5) is byte-for-byte what it was, so restored
    approvals keep binding.
  - Rejection feedback names the attempt number, the approaches already spent and what the next
    attempt must change; the verdict summary line appends `attempt N/M with approach "..."` for
    approach-carrying submissions. The tool description states the rule (at most N attempts per stage
    per task, every attempt a different approach, exhaustion as an OPEN item) and the schema exposes
    `approach`.
  - Designed with a live judge consultation (one request, claim vs quoted evidence): "an attempt that
    repeats an approach already spent on the same task+stage must be refused BEFORE the judge is
    called" - returned `approve`, `refuse_before_judge`, confidence 0.81. The conservative reading was
    taken on the one point the alternatives left open: an approach-free submission is never counted
    into the loop bound, so the PRD 1.1 iteration path cannot deadlock.
  - README gains the "Rework loop" section plus the fail-closed cross-reference; `bun test` 348/348
    (7 new controller tests), `tsc --noEmit` clean.

## 0.7.0 - 2026-10-08

One gate/review mechanism (D1, judge: the top change, 0.91, from the architecture review that scored
the codebase 2.32/9) plus the review activities (D5, judge: business 0.86 and architecture 0.92
must-be, security 0.46 opt-in), and the two host-order defects the live omp smoke found in the
hand-off gate (F1, F2).

  - `src/gates.ts` is the mechanism: ONE registry of six descriptors (`plan_mutation`,
    `subagent_handoff`, `destructive_action`, `business_review`, `architecture_review`,
    `security_review`). A descriptor declares the subject and the evidence it must quote
    (`evidenceRequired`, `evidenceKinds`), the consult frame (fixed question + claim shape built from
    the subject verbatim + offered options + refusal option, or the fixed question set of a review,
    or the approval binding of the plan gate), the internal deadline, the MODE (`blocking` refuses
    only on a confident explicit negative; `advisory` records and surfaces and has no refusal path)
    and the boundary that consults it. Adding a gate or a review is adding a descriptor.
  - The three gates keep their behaviour byte for byte: same messages, same records
    (`HandoffRecord`, `DestructiveRecord`), same restore validators, same option sets, same
    refusals. What changed is where the logic lives: `consultGate` runs the frame, the deadline race,
    the judge call, `normalizeJudgeResult` and the shared refusal condition
    (`confidentNegative`) once; `src/deadline.ts` holds the single deadline helper plus
    `HOST_HANDLER_TIMEOUT_MS`; the plan and completion boundaries read their granting stages from the
    descriptor instead of a hard-coded trigger string; `gateLine` renders both gate records.
  - `validateGateRegistry` (asserted empty by the suite) is what keeps "adding a descriptor"
    honest: a missing descriptor, a stage that is not a registered control point, a trigger
    mismatch, a refusal option that is not offered, a review that is not advisory, an advisory gate
    with a refusal path, a per-item question without a finding polarity, or any deadline at or above
    the host's 30s handler ceiling is reported.
  - F1 (blocking, live smoke): the captured work order was retired by the task tool's own
    `tool_result`, which omp 18.6.3 emits BEFORE `before_subagent_spawn` (21:11:31.698 vs
    21:11:31.705), so the dispatch consult never fired in the real host while its unit tests passed.
    The order is now retired when the SPAWN is judged (or when the capture ages out, the task
    changes, or the dispatch is refused).
  - F2 (blocking, live smoke): the acceptance side judged the spawn acknowledgement ("Spawned agent
    ...; results auto-deliver") instead of the delegated result, and persisted it as blockers
    against work nobody had done. The acceptance consult now runs on the result the host DELIVERS -
    the `message_end` custom message omp builds for a settled background job (`customType:
    "async-result"`, src/session/async-job-delivery.ts) - and never on the tool result; it is
    explicitly opt-in (`gates.handoffAcceptance`, default false) and, while armed, the
    acknowledgement is recorded as `not judged: ... the spawn acknowledgement, not the delegated
    result` rather than judged. It still refuses nothing (that host hook cannot refuse a delivery).
  - `src/reviews.ts`: the three review stages with the spec's FIXED question sets (business: two 0..9
    scores, the declared-risk choice, the fixed value-unverified statement, one statement per
    declared decision; architecture: the 0..9 quality score, one statement per declared defect, the
    declared-change choice; security: one statement per declared surface, the worst-surface choice),
    their 0..9 rubrics, the per-item expansion and the ONE-request runner. Fail-closed per question
    id and kind: a missing, unknown, wrong-kind or out-of-range answer, a judge error, a deadline
    loss or a candidate-frame escape keeps NO per-item result and records the uncertainty.
  - Reviews are recorded in the session state (`JevState.reviews[stage]`) with the scores and their
    confidences, the chosen candidate and every statement verdict (item text, verdict, noul value,
    finding polarity), surfaced as same-session feedback, and restored after a restart only when the
    persisted record validates (a malformed one is dropped, never trusted). A review records no gate
    approval and pushes no blocker: only a confident negative STATEMENT (per the question's polarity)
    is reported as a finding the executor must answer. The three stages are claimed by the `review`
    activity in `src/activities.ts`, so `stagesWithoutActivity()` stays empty.
  - Config: `stages.<stage>.questions` replaces a review's question set (`fail-closed` on anything
    malformed; review stages only) and `gates.handoffAcceptance` arms the acceptance side. The
    `reviews` restore validator and the review judge (`createReviewJudge`, one systemone request for
    the whole fixed set, service options appended to every choice) follow the existing client
    discipline: validated request, per-answer contract check, fail-closed.
  - Live round-trip: `tools/reviews/product-reviews.ts` runs one business and one architecture
    review through the shipped mechanism against the real endpoint and writes the recorded per-item
    state to `evidence/reviews/<stamp>-product-reviews.md`.
  - Designed with two live judge consultations (claim vs quoted evidence): "the shape that satisfies
    adding a gate or review is adding a descriptor, not a new code path is ONE descriptor type whose
    consultation kind is a field" - returned `approve`, `one_descriptor_type`, confidence 0.81. The
    question "may an advisory review ever refuse" abstained twice (0.77, 0.56); the conservative
    reading ordered by the spec was taken and is structural: an advisory descriptor is a review and
    carries no refusal option at all.
  - README gains "One mechanism: descriptors, modes, deadlines" and "Reviews: business, architecture,
    opt-in security", the review stage rows, the `questions` override and `gates.handoffAcceptance`.
  - `bun test` 335/335 target (12 new: 6 gate/host-order, 6 review). Observed at hand-off: 333
    pass, 2 fail — both are two pre-existing cases in `tests/controller.test.ts` that assert the
    pre-F2 acceptance behaviour (`the acceptance-side verdict is recorded from the task result
    hook`, `an accepted result records the verdict without a blocker`); they encode the host order
    F2 replaced, are owned by the test-pruning slice, and were reported to the integrator rather
    than rewritten here. `bun run typecheck` clean; `src/index.ts` imports clean.

## 0.8.0 - 2026-10-08

FR-02 (the last mile of skill routing) and FR-13 (refactoring: the inventory before the first code
edit, the per-item marking after it). Both were designed through the judge before being built; the
verbatim verdicts are recorded under the matching bullet.

FR-02 - a judge-selected skill now takes effect in the running session.
  - Before: `submitRouting` recorded the selection in `JevState.routedSkill` and read it nowhere, so an
    approved skill was a returned recommendation and nothing in the session changed. The suite could not
    catch the regression either: the only assertion was on the state field.
  - Now: `activateSkill` (`src/controller.ts`) delivers the selection to the executor through the same
    channel every other verdict uses - `pi.sendMessage(..., { deliverAs: "aside", triggerTurn: false })` -
    carrying the selected candidate's id, its label and the owner's own `meaning`, and records
    `routedSkill` at the same time. A candidate the owner did not configure can never be activated (the
    judge only ever sees the configured list) and no verdict other than `approve` delivers or records
    anything. What the extension deliberately does not do is install a skill into the prompt: it delivers
    the selection, and the executor applies the skill from its own files.
  - Tests: `tests/skill-activation.test.ts` (2). The delivery test fails when the injection is removed
    (verified by mutation); the second fails when a selection the judge did not approve starts driving
    the work.
  - Live judge design consultation (`jev-1.13.0`), three attempts with a changed approach each because
    the loop forbids repeating a frame. Attempt 1, the product's own verdict frame over one design claim
    (`src/cli.ts`, the request in `/tmp`): `{"verdict":"insufficient_evidence","reasons":["low_confidence"],"confidence":0.52}`.
    Attempt 2, claim plus mechanism choice over the direct systemone instrument: claim
    `{"type":"noul","noul":0.34}`; mechanism `{"type":"choice","choice":"session_feedback","confidence":0.78}`,
    probabilities `session_feedback 0.82 / session_and_spawn 0.04 / state_only 0.03`. Attempt 3, restated
    as an outcome plus the artifacts that settle it: `{"type":"noul","noul":0.44}`; mechanism
    `{"type":"choice","choice":"session_feedback","confidence":0.95}`, probabilities
    `session_feedback 0.96 / session_and_spawn 0.01 / state_only 0.01`.
  - Reading, recorded honestly: the requirement-interpretation claim stayed below 0.5 across all three
    approaches and is left as an OPEN item in this note rather than bent until it passed; the design
    decision itself was answered decisively twice (0.78 then 0.95 confidence for the same mechanism) and
    is what was built - in-session delivery, no per-spawn propagation. Transport: the first CLI call died
    with the documented socket reset and the direct call needed four retries.

FR-13 - a refactoring now has a fixed inventory and an evidence-backed marking per item.
  - New control points `refactor_inventory` and `refactor_marking`, claimed by the `development`
    activity (`src/activities.ts`), so `stagesWithoutActivity()` stays empty. `refactor_inventory`
    refuses a submission that arrives after the first code edit of the task - tracked as
    `taskStartWorkRevision` against the monotonic `workRevision`, reset when the task fingerprint
    changes - records the items in `JevState.refactorInventory` and delivers the id/command list back
    into the session. It consults no judge: a declaration is not a question.
  - `refactor_marking` requires one `{id, evidence}` per inventory item and refuses, before any judge
    call, material that carries no artifact kind (`code`/`execution`/`log`) - the executor's own report
    is not evidence. `createRefactorMarkingJudge` (`src/client.ts`) then marks every item `preserved` /
    `lost` / `not_evidenced` from THAT item's own material in one request, with the mandatory service
    options appended and fail-closed handling: a judge error, a frame escape, an unknown marking, a
    missing answer or a sub-floor confidence records nothing at all.
  - The completion boundary (`unmetStopGates`) names every inventory item without an evidence-backed
    marking at the current work revision; a `not_evidenced` item blocks completion under its own id, a
    code edit after the marking makes it stale and re-opens the gap naming the items, and a task that
    never recorded an inventory is unaffected. `JevState.lastRefactorMarking` carries the work revision
    the marking was made at; both new records have restore validators, and a malformed persisted record
    is dropped rather than trusted.
  - Tests: `tests/refactor-inventory.test.ts` (9): the inventory is recorded with its commands and
    delivered; a late inventory is refused and nothing is recorded; a report-only marking is refused and
    the boundary still names the item; an evidence-backed marking is recorded per item and the item stops
    blocking; a `not_evidenced` item blocks under its own id only; a later code edit makes the marking
    stale; a judge that fails or escapes records nothing; and the judge's wire contract (each item's
    material travels inside that item's own state entry; a low-confidence or service-option answer yields
    no marking).
  - Live judge design consultation (`jev-1.13.0`), three attempts with a changed approach. Attempt 1,
    the product's own verdict frame: `{"verdict":"insufficient_evidence","reasons":["low_confidence"],"confidence":0.44}`.
    Attempt 2, one umbrella claim plus the choice of vehicle: claim `{"type":"noul","noul":0.32}`;
    vehicle `{"type":"choice","choice":"two_stages","confidence":0.88}`, probabilities
    `two_stages 0.90 / inventory_stage_marking_inline 0.02 / extend_capabilities 0.01`. Attempt 3, the
    umbrella claim split into one narrow claim per separately checkable part, with the vehicle repeated:
    part 1 (the inventory and its verification commands, and the refusal after the first edit)
    `{"type":"noul","noul":0.73}`, part 2 (an outcome per item taken from that item's own material)
    `{"type":"noul","noul":0.58}`, part 3 (an item without material keeps the boundary shut by name; a
    report is refused) `{"type":"noul","noul":0.56}` - all three above the 0.5 bar, so the design is
    accepted; vehicle `{"type":"choice","choice":"two_stages","confidence":0.95}`, probabilities
    `two_stages 0.96`. Transport: two CLI attempts died with socket resets and were retried through the
    direct instrument.

Both features end to end: the FR-02 effect is produced by the registered tool path (`stage=skill_routing`
through `jev_decision` -> `submitRouting` -> `activateSkill`), and the FR-13 steps are registered stages
consumed by the same `submitDecisionCore` pipeline (validation -> rework bound -> preset -> activity
guard) whose records the `session_stop` boundary reads.

Test count: 333 before this slice (HEAD 35b4d76), 344 after (+11: 2 FR-02, 9 FR-13), every one of them
failing when its behaviour breaks (two verified by mutation, removal of the injection and removal of the
before-the-first-edit refusal).

Also in this slice: a one-line fix in the hand-off acceptance uncertainty text, which read with a
doubled prefix ("Jev handoff (acceptance) not judged: not judged: the task tool result is ..."). The
note no longer repeats the recorder's own prefix. Found in the live omp smoke of the same day
(evidence/smoke-gates-reverify.log, cases C and D). The live smoke also measured that a dispatch verdict
lands 299-428 ms AFTER the host's task `tool_result`; whether omp still cancels a spawn at that point is
unproven, so nothing in this change rests on it.
