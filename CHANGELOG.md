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
- 238/238 tests, `tsc --noEmit` clean.
