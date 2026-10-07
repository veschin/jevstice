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
