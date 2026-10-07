# Jev Implementation Plan

Status: implementation of PRD.md (2026-10-07). Scope fixed by parent directive; open PRD questions (GAP:1..6) stay open - this plan records conservative policy defaults, not user-approved answers.

## Architecture

Bun/TypeScript package, delivered as an omp extension (`src/index.ts` entry per omp 18.6.3 extension loader) plus a standalone CLI sharing the same code path.

- `src/types.ts` - shared contracts (integrator-owned).
- `src/client.ts` - real TypeSafe HTTP client: POST `{TYPESAFE_API_URL|https://api.typesafe.ai/v1/systemone}`, Bearer key from `JEVI_API_KEY` (fallback `TYPESAFE_API_KEY`), body `{state, model:"jev-latest", questions}`; schema validation; typed errors; retries only for documented 429/529. No credentials persisted.
- `src/evidence.ts` - builds judge `state` from `DecisionRequest`: verbatim evidence blocks (user/spec/code/execution/log/docs quotes), fixed options as choice criteria. Quoted text goes in state, never into instructions as policy.
- `src/cli.ts` - JSON request (stdin or file) -> same decide() -> JSON on stdout. Exit 0 = valid judge output (even revise); 2 = usage/invalid input; 4 = transport/auth. Live probe command included; API is currently unreachable (PRD §7 probe: OpenRouter 403, TypeSafe TLS reset) - error path must be exercised, not faked.
- `src/catalog.ts` - functional catalogs: task types (dev/analytics/query), 16 harden-plan-compatible topic packs with traceable provenance, skill/model candidates; classification + topic selection + routing go through the same Judge.
- `src/controller.ts` + `src/index.ts` - omp extension: `tool_call` gate for decision/review tools, `session_stop` completion enforcement (extension-only hook), `before_subagent_spawn` routing, `appendEntry` state for bounded rework (FR-14 same-session feedback via omp IRC; provider cache HIT is a hypothesis, we only preserve stable prefix and reuse the existing session).

## Policy defaults (conservative, documented as choices)

- Judge failure, unavailability, uncertainty, or confidence < 0.8 NEVER approves; outcome is revise/insufficient_evidence/ask_user.
- Rework bounded: max 3 executor↔judge iterations per stage, then escalate ask_user with a blocker; no fake success.
- Verdicts come only from the judge's own answer mapped to the fixed option set; no default approval.
- User decisions preserved: ask_user always surfaces, never auto-resolves.
- Model routing only among caller-configured candidates; judge model fixed `jev-latest`, never substituted; no fallback providers.
- Jev generates no text; it only selects/gates/scores. LLMs author plans and code.

## FR acceptance

| FR | Acceptance |
|----|------------|
| FR-01 | catalog classification maps dev/analytics/query via Choice judge; test: each type routes to its catalog entry; judge failure -> no classification, ask_user path |
| FR-02 | skill routing = Choice over available skills with evidence; test: judge mock returns option id -> controller selects it; low confidence -> not selected |
| FR-03 | model routing = Choice over caller-configured models only; test: unconfigured model never offered |
| FR-04 | topic selection = Choice/Noul over catalog packs; test: selected topic ids ⊆ catalog, provenance resolvable |
| FR-05 | understanding_review distinguishes correct/partial/wrong via fixed options; test covers all three mappings |
| FR-06 | direction_review gate returns approve/revise with reasons; revise increments bounded counter |
| FR-07 | completion_review on session_stop: without sufficient evidence verdict != approve -> block continuation with reasons; test: self-report alone insufficient |
| FR-08 | every DecisionResult carries verdict from fixed set; client test: response maps only to enumerated verdicts |
| FR-09 | executor toolset = decision tool + CLI + evidence builder registered via extension; smoke: tool callable in installed omp |
| FR-10 | important_decision/code_review tools enforce fixed options and evidence presence; test: empty evidence -> refuse before judge |
| FR-11 | subagent_handoff validates dispatch and acceptance via judge; recorded as implemented, policy unconfirmed by user (PRD GAP:3) |
| FR-12 | bounded cheap iterations: counter in appendEntry state; test: after 3 revise cycles -> escalate, no infinite loop |
| FR-13 | refactor_check: catalog of capability checks; test: each original feature tracked pass/fail, missing evidence -> not approve |
| FR-14 | same-session feedback: IRC/aside to running executor, no new session spawned; test: controller reuses sessionFile; no provider-cache claims made |
| FR-15 | evidence.ts emits verbatim quotes with kind+source; test: paraphrase impossible by construction (caller-supplied strings passed through) |
| FR-16 | acceptance requires code/execution/log/docs evidence, not report text; test: report-only evidence -> insufficient_evidence |

## Verification

Bun tests (unit + boundary), `tsc --noEmit`, guard.py --deep, LSP diagnostics; smoke against actually installed omp extension loader via explicit extension-path argument (no global install); live API probe proves error path and success path (official key via pass, integrator-only paid calls). Full verifiable completion criteria: ACCEPTANCE.md AC1-AC9, including mandatory dogfooding (AC9: a genuine project correction routed through the addon itself; PASS required before claiming finished).

## Known blockers (not solved here)

- ~~Live Jev API unreachable~~ RESOLVED 2026-10-07: official key (`pass token/jev`) works against the direct TypeSafe endpoint. Live proof (HTTP 200, jev-1.13.0, ~0.5s, usage returned): noul arithmetic 0.98; classification/choice, review and completion questions answered per schema. Observed judge behavior on synthetic snippets (NOT a claimed accuracy measure): with task context stated in `state`, a correct sum implementation → approve 0.96 and `xs.length` → revise 1.0 (an earlier phrasing with task only in criteria produced a false revise); report-only completion → insufficient_evidence 0.94; intermittent connection resets (~50%) with retry succeeding → client retries must include transport resets, not only 429/529.
- GAP:1 (success metrics), GAP:3 (mandatory checks/verdict policy) remain user decisions; defaults above.
