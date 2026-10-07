# TASKS.md - durable handoff (user-requested)

If parent disappears: JevIntegrator owns everything below; parked reviewers (JevCodeReview, JevBehaviorReview) revive on direct `write agent://<id>`. Source of truth = actual tool output, never worker assertion.

## DAG

plan/types -> parallel client/catalog/extension -> integration proof -> parallel reviews -> fixes/reproof -> both CLEAR -> docs + local commit(s).

| # | Task | Owner | Status | Acceptance |
|---|------|-------|--------|-----------|
| 0 | Baseline: PRD+PLAN+package+src/types.ts commit | JevIntegrator | DONE - commit `f32d1c2` | PLAN.md lists all FR acceptance + conservative gate policy; types exact |
| 1 | TypeSafe client + evidence builder + CLI | JevClientWorker | DONE — commit 8b4c8ff | incl. MultiLabel judge library; F3/F5/F6 fixed |
| 2 | Catalog/classification/topic+skill+model routing | JevCatalogWorker | DONE (library, DEFERRED from MVP runtime) — commit 8b4c8ff | tsc clean, 34/34 |
| 3 | omp extension controller + entry | JevExtensionWorker | DONE — commit pending with integration | 18/18; live-smoked |
| 4 | Integration proof | JevIntegrator | DONE 2026-10-07 (superseded runs: final 128/128, tsc clean, guard clean, live probe ok) | evidence/ |
| 5 | Independent reviews | JevCodeReview + JevBehaviorReview | ROUND 2 RUNNING — FIXES_READY sent | B1-B7 + code findings 1-5 + overrides R1-R6 + SDK transport landed → CLEAR both |
| 6 | Docs + final implementation commit | JevIntegrator | PENDING | after both CLEAR |
| 7 | AC9 dogfooding | JevIntegrator | PENDING — after CLEAR; genuine corrections consumed by fix round → whole-project final review through addon (distinguished from rework loop) | evidence/ac9-dogfood.md |
| 8 | Live-Jev dev consultations (user order) | JevIntegrator | DONE | POLICY-DRAFT.md; evidence/jev-prd-review.md; evidence/jev-impl-review.md; 5 requests |
| 9 | Template overrides (user-approved in-scope) | Extension+Client workers | DONE — awaiting round-2 review | AC10; R1-R6 implemented |

## API status

~~Live API unreachable~~ **RESOLVED 2026-10-07**: official key `pass token/jev` works against direct `https://api.typesafe.ai/v1/systemone`. Observed: HTTP 200, jev-1.13.0, ~0.5s, noul/choice/score answers + usage. Judge quality on synthetic snippets: correct approve/revise pair with task context in state; report-only completion correctly insufficient_evidence; NOT a claimed accuracy measure. Live/paid calls: JevIntegrator ONLY. No network/router changes; one-off TLS resets handled by bounded client retries, no scope expansion.

## FR coverage map

See PLAN.md §"FR acceptance" (FR-01..FR-16). Gate policy: failure/low-confidence never approves; bounded rework; ask_user preserved.

## Post-MVP backlog (user-ordered, not implemented)

- FR-17 interaction templates (default templates versioned/tested; project-level override file; invalid override = fail-closed error; template inventory in README).
- POLICY-DRAFT.md post-approval items: high-risk bash pattern gate, spawn budget gate, destructive-action detector, memory/skill class policy, judge-every-edit vs plan+completion decision.
