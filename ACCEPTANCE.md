# ACCEPTANCE.md - verifiable completion criteria

Format: GIVEN/WHEN/THEN + executable command + expected state + observed result + evidence location. A criterion is DONE only with observed tool output recorded here; worker/reviewer assertions are not evidence. FAIL/BLOCKED on any AC prevents "complete" - honest status is committed instead. Accuracy of Jev judgments (model-quality multiplier) is explicitly NOT an acceptance target: user set no corpus/threshold [GAP:1].

## AC1 - Real omp load + live official API (FR-09)
GIVEN `~/ai/jev` symlinked into `~/.omp/extensions/jev`, `TYPESAFE_API_KEY` resolved from `pass show token/jev` in-process.
WHEN `omp` is started in a scratch dir with a synthetic prompt that triggers a decision tool call.
THEN the extension registers (visible in extension load output), the decision request reaches `https://api.typesafe.ai/v1/systemone`, HTTP 200, `model: jev-1.*` in response.
Evidence: `<evidence/ac1-omp-load.log>`, `<evidence/ac1-live-decide.json>` (sanitized; key never printed).
Observed: PENDING.

## AC2 - Classification + topics + skills + allowlisted model, actually used (FR-01..FR-04)
GIVEN catalog data present; model allowlist = caller-configured cheap models only.
WHEN a synthetic development task is classified and planned.
THEN the systemone answer selects task type, applicable topic ids (⊆ catalog, provenance resolvable), skills, and one allowlisted model; the runtime (controller) applies the selection - chosen skill/model name appears in the subsequent agent dispatch/records, not just a returned recommendation; a non-allowlisted model can never be selected (negative probe).
Evidence: `<evidence/ac2-routing.json>` + runtime log line showing applied selection.
Observed: PENDING.

## AC3 - Evidence provenance + negative decision causes real rework feedback (FR-05, FR-06, FR-12, FR-15)
GIVEN a DecisionRequest quoting a user/spec line verbatim.
WHEN the judge returns `revise`.
THEN the constructed request preserves the verbatim quote+source (byte-identical round-trip through evidence builder), and the revise outcome is delivered into the SAME session as feedback (see AC7) with the judge's reasons, and the bounded-rework counter increments.
Evidence: `<evidence/ac3-roundtrip.test-output>`, `<evidence/ac3-rework.log>`.
Observed: PENDING.

## AC4 - Gate denials + fail-closed + read-only stays allowed (FR-08, FR-10, FR-16, POLICY)
GIVEN POLICY defaults (failure never approves; confidence < 0.8 never approves).
WHEN (a) a mutation-bearing tool_call occurs before plan approval, (b) completion is declared without review/requirements evidence, (c) API key is missing or the endpoint is unreachable (probe: `TYPESAFE_API_URL=http://127.0.0.1:1`), (d) judge confidence below threshold.
THEN (a) tool call is blocked with reason, (b) session_stop blocks continuation with reasons, (c) outcome is a typed error / `insufficient_evidence`+`ask_user` - never approve, (d) verdict downgraded, never approve. Read-only tools (file reads, evidence collection) remain allowed in all cases.
Commands: `bun run src/cli.ts probe` (no key → exit 4 clean JSON); `TYPESAFE_API_URL=http://127.0.0.1:1/v1/systemone TYPESAFE_API_KEY=dummy bun run src/cli.ts /tmp/req.json` (exit 4; positional request file, no `decide` subcommand).
Evidence: `<evidence/ac4-gates.test-output>`, `<evidence/ac4-fail-closed.log>`.
Observed: PENDING.

## AC5 - Staleness/replay: approval bound to reviewed content (FR-10, FR-16)
GIVEN an approved decision recorded via appendEntry state with a content digest.
WHEN the underlying task/proposal content changes (digest mismatch) or a stored approval is replayed against different content.
THEN the previous approval is invalid: the controller re-judges or blocks; a replayed approve for changed content is rejected as stale.
Evidence: `<evidence/ac5-staleness.test-output>`.
Observed: PENDING.

## AC6 - Refactor capability inventory (FR-13)
GIVEN a synthetic "original feature" list (3+ capabilities) with per-capability verification commands.
WHEN completion is requested after a mock refactor where one capability was omitted.
THEN completion is denied, naming the omitted capability; when all capabilities are fulfilled and their verifications executed, completion becomes eligible (evidence-backed).
Evidence: `<evidence/ac6-refactor.test-output>`.
Observed: PENDING.

## AC7 - Same-session correction + cache assessment (FR-14)
GIVEN a running executor session in installed omp; record session/agent identity before and after.
WHEN the judge issues a correction (revise).
THEN the correction is delivered to the SAME session/agent (identity unchanged; no new sessionFile), through `pi.sendMessage` steer/aside; system+tools prefix stays stable across the correction.
Cache sub-criterion: provider usage fields (cached/prompt tokens) are captured from the executor LLM route if the configured cheap provider reports them; a demonstrated cached-token hit is recorded; if the provider does not report cache usage, this is recorded as an explicit BLOCKER - caching is NOT claimed. Latency or Jev-side usage never substitutes for provider cache evidence. No premium fallback; no private prompts.
Evidence: `<evidence/ac7-session-identity.log>`, `<evidence/ac7-usage.json>`.
Observed: PENDING.

## AC8 - Independent review + reproducible checks + clean commits
GIVEN integrated tree.
WHEN JevCodeReview and JevBehaviorReview run independently (READY_FOR_REVIEW -> findings -> FIXES_READY loop).
THEN both return CLEAR; all checks reproducible from commands in README/ACCEPTANCE (bun test, tsc --noEmit, guard.py --deep, live probe); local commits contain requirements/plan/code/docs; no secrets (key only via env/pass, never in files/commits); no global config or network changes.
Observed: PENDING.

## AC9 — Dogfooding: finishing THIS addon through THIS addon (user-mandated)
GIVEN the addon integrated and loadable in real omp via explicit extension path (no global install), official live Jev, key via pass in-process.
WHEN a GENUINE pending correction to this project remains (integration finding, reviewer finding, or failing check — never an invented task), the integrator submits it through the project's own registered decision interface (CLI/extension tool) with quoted evidence (task text + code/execution quotes), receives the Jev verdict, and executes the correction in the same omp worker session, then routes the code-review decision AND the completion decision through the addon with actual changed code/test output as evidence.
THEN sanitized record exists: verdicts, reasons, and the linkage verdict→action→diff/commit; approval is never faked/forced; ordinary `probe` calls and unit mocks do NOT satisfy this criterion.
If no genuine correction remains by integration end, an evidence-backed whole-project final review through the addon is still required and recorded as such, explicitly distinguished from a demonstrated rework loop.
Evidence: `<evidence/ac9-dogfood.md>` (request/response JSON sanitized, diff/commit refs).
Observed: PENDING.

## Probe additions
- Replay probe: reuse a captured approve verdict against modified content -> must reject (AC5).
- Iteration-exhaustion probe: force 3 revise cycles -> escalation, no infinite loop, no fake success (AC3/AC4, FR-12).
- Uncertainty probe: mock judge confidence 0.7 -> verdict not approve (AC4).
