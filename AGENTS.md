# Repository Guidelines

Practical guidance for AI assistants and contributors working in this repo.

## Project Overview

`jevstice` is an [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension.
Jev (`jev-latest`, served by the TypeSafe API) reviews submitted decisions and work as diagnostics.
It never grants or withholds execution permission.

## Current owner contract

- Work and completion do not wait for Jev. A negative, missing, stale, inconclusive or unavailable
  check never blocks the next action, evidence inspection, correction, independent work or completion.
- An initially reviewed plan supplies context for later checks, not a lock on implementation.
  Missing requirements or plan inputs may prevent that particular check from running, never the work.
- Ask the owner only when a genuinely critical decision requires their consent. Continue independent
  safe work while waiting. A Jev finding alone is not a reason to request permission.
- Do not restore `/jev-continue`, approval-message overrides, repair permits or `/jev-waive`.
  No finding needs clearing before useful work continues.
- Keep verdicts truthful: failed, inconclusive, unavailable and not checked are distinct.
  A below-floor answer establishes neither approval nor a defect. Execution success is not check
  approval, and a passing action-conformance check is not proof of implementation correctness.
- Report work coverage and check outcomes separately through `details.diagnostics` and `/jev-status`.
  Business and architecture acceptance are separate current-revision records.
- Actual host permissions remain authoritative. The optional strict supervisor preserves frozen
  roots, effect permissions, resource budgets, ownership, durable intent identity, containment and
  reconciliation of unobserved effects. These are deterministic safety limits, not Jev vetoes.

## Diagnostic tools

- `jev_triage`: request depth and task-specific review topics.
- `jev_requirements`: checkable obligations and owner-request coverage.
- `jev_plan_review`: outline, detail per step, finalize; approval binds exact artifact bytes.
- `jev_consult`: `choice`, `score` or `boolean`; no recovery/repair/resolve mode.
- `jev_search_relevance`: candidate relevance and the submitted reason.
- `jev_reaim`: record an actual owner replacement of direction, not a bypass.
- `jev_course_check`: whether work conforms to the current plan.
- `jev_acceptance`: `outcome` reviews observed delivery; business and architecture are separate.
- `jev_review`: checkpoint, commit or diff review.
- `jev_text_review`: exact text against submitted register rules.
- `jev_anti_slop`: external-artifact findings, always diagnostic.
- `jev_context`: trusted sources and exact session-local diagnostic results.
- `jev_fact_check`: observed evidence, relevance and owner-question coverage for draft claims.
- `jev_issue`: optional tracker draft preparation, readback verification and linked developer review.
- `jev_todo`: optional review, resumption and cleanup proposals for an observed backlog.
- `jev_autonomy`: control for a bound supervised run. The strict catalog omits `jev_fact_check`, `jev_issue` and `jev_todo`.

For mounted commands, run `<tool> --help`, then submit `<tool> -j '<JSON>'` in `bash` without a
PTY. Use typed arguments when the host lists the tool directly. For a development task, check
requirements against the owner's exact words before editing and call `jev_acceptance` with
`aspect: "outcome"` after verification. Triage and staged planning are useful when their
diagnostics answer a concrete question. Recheck only when new evidence addresses a named gap.

## Architecture & Data Flow

Ordinary `src/` stays flat, with no build step; the optional autonomy module lives in the `autonomy/` directory and the manifest never imports it. Dependencies point right:

- `types.ts` - shared vocabulary (`Evidence`, `Aspect`, `JevConfig`, `ToolOutcome`, the anti-slop claim/review/finding types), the `asRecord` guard and `POLICY` (floors, evidence and anti-slop bounds, transport defaults).
- `judge.ts` - the single judge adapter: `JudgeQuestion`/`JudgeAnswer`/`JudgeOutcome`, request validation before any call, fail-closed normalization of SDK answers, and the answer accessors (`choseLabel`, `saidTrue`, `probabilityOf`, `scoreOf`, `answerOf`). The SDK returns no free prose, so nothing here invents an explanation.
- `apikey.ts` - key resolution: environment variable first, then a resolver command whose stdout is the key. The key reaches the client and nothing else; a failure resolves to `undefined`.
- `config.ts` - project `<cwd>/.omp/jev.config.json` overrides user configuration; reads `antiSlop.mode` (`off` or `advisory`) and `billing.*`. Unknown keys are ignored. Removed `enforce` values are diagnosed and retain the effective advisory preference. A balance is an owner-supplied snapshot, not a queried API balance.
- `screen.ts` - the free reading of a request (`weightOf`): `quiet` for publish-inspect-verify phrasing, `judged` for everything else including unrecognised text (FR-30). Lexical and deterministic; it decides entry only.
- `state.ts` - task fingerprints, exact plan bindings, action revisions, diagnostic findings, check/work counts, acceptance and usage. Ordinary state is session-local; strict checkpoints persist validated diagnostic counts.
- `gates.ts` - pure shell/tool effect classifiers and target-against-plan comparison. No ordinary execution or completion gate remains.
- `activities.ts` - validated diagnostic activities, owner-update classification and conformance checks. Repeated unchanged material is deduplicated. Stale state or changed plan bytes invalidate the answer, not continued work.
- `artifact.ts` - reading a `local://` artifact from disk, so the plan review binds an approval to the artifact's bytes rather than to the caller's copy.
- `controller.ts` - ordinary tool registration, commands, native observations, source validation and detached diagnostics. Context reads bypass the explicit judgment queue. Ordinary work and completion do not await an acceptance verdict.
- `guidance.ts` - canonical tool schemas and examples; `src/jev-skill.md` is the injected ordinary workflow and `skills/jevstice/SKILL.md` is the discoverable package skill. Update applicable surfaces when changing a public contract.
- `diagnosticResults.ts`, `factCheck.ts`, `issueWork.ts`, `todoWork.ts` - session-local results and optional workflows grounded in observed evidence.
- `context.ts` - immutable project-local owner and approved-artifact records under `.omp/jev/context`, with identity/digest verification on reads; archive reads restore no approval.
- `autonomy/index.ts` - strict-only extension entry, loaded by the supervisor instead of the manifest: it registers deny hooks, requires both nonempty run/store locators, then dynamically loads the runtime.
- `autonomy/runtime.ts` - opt-in strict runtime: restored workflow state, explicit decision context, durable intent admission, dependency hashing, matched native result settlement, evidence-bound completion and `jev_autonomy`.
- `autonomy/store.ts` - private Bun SQLite authority: immutable objective/policy, exclusive overlapping roots, ownership epochs, checkpoints, immutable blobs, decisions and intent journal. Ordinary sessions never open it.
- `autonomy/scope.ts` - Linux systemd user-scope creation, exact cgroup identity and whole-scope containment/fence receipts. Process-group signalling is not a containment substitute.
- `autonomy/driver.ts` - `start`, `resume`, `status`, `stop` supervisor CLI; bound OMP RPC process, custom wake acknowledgment, context injection, resource accounting and operator cancellation. It launches the child with `autonomy/index.ts` as the extension entry and is not a general RPC proxy.
- `index.ts` - the ordinary extension entry; `package.json` declares `src/index.ts` under `omp.extensions`, so an installed checkout loads it in ordinary sessions. It registers only the ordinary controller: autonomy locators are ignored and nothing under `autonomy/` is imported.

Data flow of one activity: tool call -> parameter validation (a malformed submission is refused before any call) -> `deps.judge(state, questions)` -> typed answers (a selected label, a rubric score, or a yes probability) -> approval-floor check -> recorded state or a refusal -> text and `details` back to the executor.

Completed consequential calls with current plan context start background action-conformance checks.
Asynchronous results without a settled diagnostic stay not checked. Neither execution nor completion
waits for these checks. A failed native call is not disguised as successful implementation.

Session check mode is an in-memory `Set<sessionId>` in the controller closure. `/jev off` pauses
diagnostics, source capture and injection; `/jev on` starts a fresh ordinary workflow while retaining
usage and diagnostic totals. State identity rejects stale callbacks across the switch. Strict safety
still runs when diagnostics are off and strict durable state is not discarded.

## Key Directories

- `src/` - ordinary runtime code, flat, one concern per file, plus `jev-skill.md` (ordinary workflow guidance only; the strict autonomous guidance lives in `autonomy/runtime.ts`).
- `autonomy/` - the optional strict module: `index.ts` (explicit entry), `runtime.ts`, `store.ts`, `scope.ts` and `driver.ts`. Not in the package manifest, never imported by ordinary code.
- `tests/` - flat `*.test.ts` mirroring src modules, plus `tests/helpers.ts` (fake judge, fake host, fake artifacts, `boundaryConfig`).
- `tools/` - verification against deterministic fixtures, the production judge and the real OMP host; see `tools/README.md`.
- `scenarios/` - English Gherkin: one feature per tool, plus configuration, session-mode, owner-follow-up and cross-tool diagnostics. Keep stable feature-scoped IDs and use observable consequences. The Bun runner binds steps in `tests/scenarios/steps/`; missing steps fail except the explicitly documented unsupported host boundaries.
- `demos/` and `site/` - separate recorded/public presentation work; demo output does not establish release acceptance. Keep raw session evidence local.
- `docs/` - architecture and operational references. Press drafts and kits remain local.
- `PRD.md` - tracked product requirements, constraints and source history. `TODO.md`, `PLAN.md`, `TASKS.md`, `ACCEPTANCE.md` and `evidence/` are local working records, not release inputs.

## Development Commands

```sh
bun install        # dependencies (bun is the only package manager; no lockfiles other than bun.lock)
bun test           # full test suite (bun:test)
bun run typecheck  # tsc --noEmit - the only static check
bun tools/live-smoke.ts direct --scenario workflow  # production judge, no host
bun tools/live-smoke.ts host --scenario workflow    # real omp host
bun tools/autonomy-smoke.ts --scenario startup --deadline 300 # strict real-host startup
bun tools/autonomy-smoke.ts --scenario all --deadline 600     # all strict live scenarios
bun run autonomy status                                    # autonomy/driver.ts: start|resume|status|stop
```

Historical test counts, blocking-workflow probes and recovery approvals are not verification of the current diagnostic contract. Record current commands and observed results in `HANDOFF.md` and `tools/README.md`; do not claim release readiness or whole-autonomy acceptance from an earlier run.

API key: `TYPESAFE_API_KEY` env (also `JEVI_API_KEY`), or a resolver command in `TYPESAFE_API_KEY_COMMAND` (e.g. `pass show token/jev`). No key -> the judge reports an unusable answer; it never approves.

There is no build, lint/format tooling or CI. The only CLI is the opt-in strict supervisor (`bun run autonomy`, which runs `autonomy/driver.ts`); ordinary operation remains an OMP extension and never loads that module. Verify with `bun test`, `bun run typecheck` and a real-host smoke covering the changed path. `package.json` declares `src/index.ts` under `omp.extensions`, so an installed checkout loads in ordinary sessions; `omp --no-extensions -e <path>/src/index.ts` loads a checkout explicitly. The optional module's child uses `autonomy/index.ts` as its explicit entry instead. Restart the host after extension changes; a loaded process does not hot-replace its schemas and hooks.

## Code Conventions & Common Patterns

- Tabs, double quotes, semicolons, `const`-only, arrow functions, trailing commas. Files camelCase.
- No classes. The controller is a factory (`createJevController`) returning `{ register(pi) }`; everything else is plain functions, interfaces and `as const` tables.
- Error handling: activities return `ToolOutcome`; call validity and the verdict are distinct. An unexpected judge failure records an unavailable diagnostic, never permission and never an ordinary work block.
- Small static, string-keyed lookup tables are `Record<string, true>` (`MUTATING_TOOLS`, `COORDINATION_SCHEMES`, `EVIDENCE_KINDS`); `Set`/`Map` are for dynamic membership.
- Dependency injection via plain function types: `Judge`, `ActivityDeps {judge, config, readArtifact?}`, `ControllerDeps {judge, config, zod}`, `createTypeSafeJudge({resolveKey, model?, createClient?})`. Every dependency has a production default; tests override through the same seams.
- Async: plain `async/await`; `node:crypto` SHA-256 for fingerprints. Every detached diagnostic catches rejection; a background judgment must not crash the host or delay native work.
- State: ordinary sessions use a `Map<sessionId, JevState>` and an in-memory mode set. Strict runs restore validated private SQLite state under the current ownership binding. Changed tracked bytes invalidate stale execution/acceptance evidence. Native logs and model verdicts cannot expand authority.
- Doc comments cite requirement IDs (`FR-07`, `FR-18`) - keep the IDs when editing the code they mark.
- `asRecord` is defined once in `types.ts` and shared; do not add a schema dependency for it (schemas come from the injected `pi.zod`).
- Public and project artifacts (README, CHANGELOG, PRD, TASKS, commits, this file) are English.

## Important Files

- `package.json` - scripts `test`, `typecheck`, `autonomy` (runs `autonomy/driver.ts`); `engines: {bun: ">=1.1"}`, single runtime dep `@typesafe-ai/sdk`, and the `omp.extensions` manifest entry `src/index.ts`. Strict supervision additionally uses Bun's built-in SQLite and Linux systemd/cgroup capabilities, without a new package dependency.
- `src/index.ts` - read first (~35 lines): the factory omp calls, config load, production judge and ordinary controller registration. It never reads autonomy locators.
- `autonomy/index.ts` - the optional module's explicit entry: deny hooks, locator validation, then the dynamic runtime load. Only `autonomy/driver.ts` launches it.
- `src/types.ts` - `POLICY` and the shared vocabulary.
- `src/controller.ts` - host interfaces, diagnostic tools, check-mode commands, owner capture and background accounting.
- `src/activities.ts` - activity validators, `material()` and judged evidence; read the whole changed activity.
- `src/screen.ts` - lexical request reading, not an execution gate.
- `src/gates.ts` and `src/state.ts` - pure effect classification and recorded diagnostic/task state.
- `tools/live-smoke.ts` - direct diagnostic/production-judge and native-host verification; see `tools/README.md`.
- `tsconfig.json` - strict + `noUncheckedIndexedAccess`, `noEmit`, `types: ["bun"]`.

## Runtime/Tooling Preferences

- Bun >= 1.1 is required and is both runtime and test runner; this code is not Node-tested. Use `bun run`, not `node`/`npx`/`npm`.
- TypeScript is typecheck-only (`noEmit`): there is no compiled artifact and no `dist/`. Install a checkout with `omp plugin link <checkout>` to load both the manifest entry and `skills/jevstice/SKILL.md`. For a one-session checkout, pass the package directory to `omp --no-extensions -e <checkout>` to discover the skill as well as the entry. No npm publish.
- Do not add lint/format tooling, build steps, or schema/validation dependencies without asking - their absence is a deliberate choice.

## Testing & QA

- Run `bun test tests/scenarios/run.test.ts` for executable Gherkin; run `bun test` and `bun run typecheck` for a release candidate.
- Use the shared deterministic fixtures in `tests/helpers.ts`; unit and Gherkin tests do not call the network judge. Use temporary artifacts where bytes or paths form part of the contract.
- Negative, malformed, below-floor and unavailable results must assert non-approval **and continued ordinary work/completion**. Preserve actual supervisor-safety rejection tests. Plan tests read real temporary artifacts; no API key may enter submitted material.
- Static check: `python3 ~/.omp/agent/managed-skills/code-guard/scripts/guard.py --deep` runs `tsc --noEmit` over `src`, `autonomy` and `tests` (the repo has no prettier/eslint config, so that channel reports "skipped").
- No coverage thresholds, no CI. The repo's own bar: a claim is done only with observed tool output recorded, never an agent's assertion - apply that when reporting test results.

## Release preparation

- Compare `HEAD` and the latest release tag; reconcile `package.json` and `CHANGELOG.md`. Follow SemVer for the public tool surface.
- Group runtime changes with their tests, schemas, skills and user documentation. Keep site or demo changes separate. Do not include local configuration, raw receipts, caches, credentials or press drafts.
- Verify the candidate with the full suite, typecheck and a fresh OMP run covering the changed boundary. Record commands and observed results in `HANDOFF.md` and `tools/README.md`. Distinguish deterministic coverage, live host observations and Jev verdicts. Do not infer full strict autonomy acceptance from startup or unit tests.
- Keep preparation local unless the owner expressly authorizes tagging, pushing or publishing. Do not sweep pre-existing changes into a commit.

