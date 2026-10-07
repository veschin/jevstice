# TASKS.md - durable handoff (user-requested)

If parent disappears: JevIntegrator owns everything below; parked reviewers (JevCodeReview, JevBehaviorReview) revive on direct `write agent://<id>`. Source of truth = actual tool output, never worker assertion.

## DAG

plan/types -> parallel client/catalog/extension -> integration proof -> parallel reviews -> fixes/reproof -> both CLEAR -> docs + local commit(s).

| # | Task | Owner | Status | Acceptance |
|---|------|-------|--------|-----------|
| 0 | Baseline: PRD+PLAN+package+src/types.ts commit | JevIntegrator | DONE - commit `f32d1c2` | PLAN.md lists all FR acceptance + conservative gate policy; types exact |
| 1 | TypeSafe client + evidence builder + CLI | JevClientWorker | IN FLIGHT | real POST /v1/systemone, Bearer env key never persisted; schema validation; retries incl. transport resets (429/529 + ECONNRESET); exit 0/2/4 contract; typed errors |
| 2 | Catalog/classification/topic+skill+model routing | JevCatalogWorker | DONE (untested mid-flight) | selection ⊆ catalog, provenance resolvable, judge failure -> no default pick, 255-shard boundaries; tests in tests/catalog.test.ts |
| 3 | omp extension controller + entry | JevExtensionWorker | IN FLIGHT | tool_call gate, session_stop completion enforcement (evidence-backed), before_subagent_spawn routing, appendEntry bounded rework (max 3), same-session feedback via pi.sendMessage |
| 4 | Integration proof | JevIntegrator | PENDING | bun tests green, tsc --noEmit clean, guard.py --deep, LIVE CLI probe/decide against api.typesafe.ai (key via pass, never printed), actual installed omp extension load smoke |
| 5 | Independent reviews | JevCodeReview + JevBehaviorReview | PARKED - send READY_FOR_REVIEW after #4 | findings -> routed to owning worker; FIXES_READY loop until CLEAR from both |
| 6 | Docs + final implementation commit | JevIntegrator | PENDING | README/CHANGELOG/PRD updated with observed coverage + blockers; commit only after both CLEAR; no push |
| 7 | AC9 dogfooding | JevIntegrator | PENDING | genuine correction routed through addon in real omp + live Jev; same-session execution; sanitized evidence/ac9-dogfood.md; PASS required before "finished" |

## API status

~~Live API unreachable~~ **RESOLVED 2026-10-07**: official key `pass token/jev` works against direct `https://api.typesafe.ai/v1/systemone`. Observed: HTTP 200, jev-1.13.0, ~0.5s, noul/choice/score answers + usage. Judge quality on synthetic snippets: correct approve/revise pair with task context in state; report-only completion correctly insufficient_evidence; NOT a claimed accuracy measure. Live/paid calls: JevIntegrator ONLY. No network/router changes; one-off TLS resets handled by bounded client retries, no scope expansion.

## FR coverage map

See PLAN.md §"FR acceptance" (FR-01..FR-16). Gate policy: failure/low-confidence never approves; bounded rework; ask_user preserved.
