# Repository Guidelines

Practical guidance for AI assistants and contributors working in this repo.

## Project Overview

`jevstice` is an [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension: Jev (`jev-latest`, served by the TypeSafe systemone API) acts as a decision judge. The executor agent brings the decisions it can see to the judge instead of guessing, and the extension holds the visible boundaries where an unanswered decision would be consequential.

What the executor can consult:

- `jev_consult` - one decision in the shape that fits it: `choice` (between submitted alternatives), `score` (on a submitted rubric) or `boolean` (a yes probability). Used for uncertainty during implementation, for a consequential business decision with task context (FR-19), and whenever a decision should not rest on the executor's guess.
- `jev_triage` - does the request need the deeper activities at all, and which narrow task-specific topics does it need? A simple result names the skipped activities and registers nothing.
- `jev_search_relevance` - which submitted search candidate is relevant, with the executor's own submitted reason returned (FR-03).
- `jev_requirements` - per-item understanding of the requirement list against the owner's request, plus its coverage and the omitted owner needs, in one batched call (FR-04..FR-06).
- `jev_plan_review` - the plan artifact defended topic by topic before the judge: the executor submits each topic with the artifact section that governs it, the paths it changes and the requirement it serves, and one question per topic decides it; the approval binds the task fingerprint and the artifact's exact bytes (FR-07, FR-24).
- `jev_acceptance` - the finished work defended separately as `business` and as `architecture` (FR-14, FR-15).
- `jev_review` - a checkpoint, commit or diff defended as a developer (FR-16).
- `jev_text_review` - a text split into fragments, with the register rule each failing fragment violates quoted back (FR-27).

The boundaries it holds:
- the plan-mode proposal `write xd://propose` needs a plan approval for the artifact being proposed, and the approval survives the approve-and-execute session switch only while the copied artifact still matches the approved digest;
- the first consequential change of a session waits for a triage decision (`jev_triage` or `jev_requirements`): a confirmed simple task then passes without the deeper stages, and the verdict belongs to that one request (FR-18);
- a consequential change is held while the registered development task has no approved plan, while a course check is in flight, or while a finding is outstanding - unless the judge proved unavailable or that boundary was released after its refusal bound, in which case it passes and the refusal stays an OPEN item (FR-21, FR-23);
- `session_stop` is held until both acceptance aspects passed at the current work revision and the completion check agrees (FR-17).

Nothing classifies prompts and nothing calls the judge before a tool is invoked or a boundary is reached: a plain read-only question or web search costs zero judge calls and no gate (FR-10, S13).

Fail-closed is the core invariant (see `POLICY` in `src/types.ts`): judge errors, malformed answers, missing answers and answers below the floor never approve. There are no meta-option escapes to map - any deviation from the submitted question set fails the whole outcome. Stop refusals are bounded (`POLICY.maxStopBlocks`): the same unchanged refusal is recorded as an OPEN item instead of looping. Any change must preserve this; tests pin it.

## Architecture & Data Flow

Flat `src/`, no subdirectories, no build step. Dependencies point right:

- `types.ts` - shared vocabulary (`Evidence`, `Aspect`, `JevConfig`, `ToolOutcome`), the `asRecord` guard and `POLICY` (floors, evidence bounds, transport defaults).
- `judge.ts` - the single judge adapter: `JudgeQuestion`/`JudgeAnswer`/`JudgeOutcome`, request validation before any call, fail-closed normalization of SDK answers, and the answer accessors (`choseLabel`, `saidTrue`, `probabilityOf`, `scoreOf`, `answerOf`). The SDK returns no free prose, so nothing here invents an explanation.
- `apikey.ts` - key resolution: environment variable first, then a resolver command whose stdout is the key. The key reaches the client and nothing else; a failure resolves to `undefined`.
- `config.ts` - project `<cwd>/.omp/jev.config.json` overrides user `~/.omp/agent/jev.config.json`; reads `gates.mutation`, `gates.completion`, `courseCheck.mode`, `courseCheck.interval`. Unknown keys are ignored (old files still load) and an invalid value keeps the fail-closed default, naming the file and the key.
- `state.ts` - per-session gate state, fingerprints (`sha256`) and the ledgers: task registration, action records, revision, acceptance records, the stop-block ledger, the refused-submission ledger and the open item a released boundary leaves (FR-22, FR-23).
- `gates.ts` - the visible boundaries as pure decisions: what counts as a consequential change, the mutation gate reason (each refusal names its boundary and renders the copy-ready next call, FR-28), the `xd://propose` gate, the completion gate, and the target-against-plan comparison the course check hangs off (FR-25).
- `activities.ts` - the eight activities plus the two automatic checks (`courseCheck`, `completionCheck`): request validation, question building, the guarded judge call, typed-answer interpretation, state update, human-readable text. The guard in front of the judge keeps the refusal ledger: a digest already refused at a boundary costs no call, and the boundary releases itself once the bound is reached (FR-22, FR-23).
- `artifact.ts` - reading a `local://` artifact from disk, so the plan review binds an approval to the artifact's bytes rather than to the caller's copy.
- `controller.ts` - the omp wiring: registers the tools, holds the `tool_call` / `tool_result` / `session_stop` handlers, keys state per session, runs the automatic checks.
- `index.ts` - extension entry (the `omp.extensions` manifest field in package.json is currently absent on purpose, so ordinary sessions load no addon).

Data flow of one activity: tool call -> parameter validation (a malformed submission is refused before any call) -> `deps.judge(state, questions)` -> typed answers (a selected label, a rubric score, or a yes probability) -> approval-floor check -> recorded state or a refusal -> text and `details` back to the executor.

The automatic checks run at visible boundaries: an interval course check follows successful consequential actions, and the completion check runs at `session_stop`. Their outcomes reach the executor as session messages.

## Key Directories

- `src/` - all runtime code, flat, one concern per file (10 files).
- `tests/` - flat `*.test.ts` mirroring src modules, plus `tests/helpers.ts` (fake judge, fake host, fake artifacts).
- `docs/` - README banner only.
- `PRD.md` is the owner-approved, tracked source of the new functional requirements. `TASKS.md` is an ignored working plan; older process files under the repository root and `evidence/` remain ignored. Do not remove `PRD.md` from the index.

## Development Commands

```sh
bun install        # dependencies (bun is the only package manager; no lockfiles other than bun.lock)
bun test           # full test suite (bun:test)
bun run typecheck  # tsc --noEmit - the only static check
```

API key: `TYPESAFE_API_KEY` env (also `JEVI_API_KEY`), or a resolver command in `TYPESAFE_API_KEY_COMMAND` (e.g. `pass show token/jev`). No key -> the judge reports an unusable answer; it never approves.

There is no CLI, no build, no lint, no format tooling, no CI. Verification before handoff is `bun test` + `bun run typecheck` and a host-level smoke run. The addon stays disabled for ordinary sessions; load the source file explicitly for a smoke run.

## Code Conventions & Common Patterns

- Tabs, double quotes, semicolons, `const`-only, arrow functions, trailing commas. Files camelCase.
- No classes. The controller is a factory (`createJevController`) returning `{ register(pi) }`; everything else is plain functions, interfaces and `as const` tables.
- Error handling: activities return `ToolOutcome` - `{ok: true}` means a well-formed judge answer was obtained (the verdict may still be a refusal), `{ok: false}` means refused or unusable. Nothing throws at a gate: an unexpected error means "block", never "approve".
- Small static, string-keyed lookup tables are `Record<string, true>` (`MUTATING_TOOLS`, `COORDINATION_SCHEMES`, `EVIDENCE_KINDS`); `Set`/`Map` are for dynamic membership.
- Dependency injection via plain function types: `Judge`, `ActivityDeps {judge, config, readArtifact?}`, `ControllerDeps {judge, config, zod}`, `createTypeSafeJudge({resolveKey, model?, createClient?})`. Every dependency has a production default; tests override through the same seams.
- Async: plain `async/await`; `node:crypto` SHA-256 for fingerprints and artifact digests. Fire-and-forget work (the course check) is wrapped in its own try/catch, since an unhandled rejection in this in-process extension is fatal to the session.
- State: a `Map<sessionId, JevState>` inside the controller closure; module-level tables are `as const`. State is deliberately in memory - a restart drops an approval and the gate closes again, which is the safe direction.
- Doc comments cite requirement IDs (`FR-07`, `FR-18`, `POLICY.failureNeverApproves`) - keep the IDs when editing the code they mark.
- `asRecord` is defined once in `types.ts` and shared; do not add a schema dependency for it (schemas come from the injected `pi.zod`).
- Public and project artifacts (README, CHANGELOG, PRD, TASKS, commits, this file) are English.

## Important Files

- `package.json` - 2 scripts (`test`, `typecheck`), `engines: {bun: ">=1.1"}`, single runtime dep `@typesafe-ai/sdk`. The `omp.extensions` manifest field is absent until the addon is enabled again.
- `src/index.ts` - read first (~40 lines): the factory omp calls, config load, production judge, controller registration.
- `src/types.ts` - `POLICY` and the shared vocabulary.
- `src/controller.ts` (~420 lines) - tool registration, the handlers, the artifact reader wiring; read `PiApi` (structural typing over the omp host) first.
- `src/activities.ts` (~870 lines) - one function per activity; read the activity you are changing plus `material()` (the evaluated state) and the shared validators at the top.
- `src/gates.ts` + `src/state.ts` - the boundary decisions and the state they read.
- `tsconfig.json` - strict + `noUncheckedIndexedAccess`, `noEmit`, `types: ["bun"]`.

## Runtime/Tooling Preferences

- Bun >= 1.1 is required and is both runtime and test runner; this code is not Node-tested. Use `bun run`, not `node`/`npx`/`npm`.
- TypeScript is typecheck-only (`noEmit`): there is no compiled artifact and no `dist/`. Shipping is `git clone` into `~/.omp/agent/extensions/jevstice` with the manifest field restored; dependencies auto-install on first run. No npm publish.
- Do not add lint/format tooling, build steps, or schema/validation dependencies without asking - their absence is a deliberate choice.

## Testing & QA

- Framework: `bun:test` only. Run everything with `bun test`; single file: `bun test tests/gates.test.ts`.
- Layout: flat `tests/*.test.ts`, one file per src module (`judge`, `apikey`, `config`, `state`, `gates`, `artifact`, `activities`, `controller`).
- Style: `describe`/`test` + `expect`; behavioral test names that cite requirement IDs (e.g. `FR-01`, `FR-11`, `POLICY.failureNeverApproves`). Shared helpers in `tests/helpers.ts`: `answeringJudge` (answers a question table, or derives an answer from the question), `failingJudge`, `fakePi` (registers tools and handlers and lets a test emit `tool_call`/`tool_result`/`session_stop`), `fakeCtx`, `fakeArtifacts` (a temp session artifact root), `fakeZod`, `blockReason`, `stopDecision`, `until`.
- Canonical patterns to follow: the judge is always an injected fake (no network in any test); fail-closed cases (judge error, malformed answer, below-floor answer, missing key) assert *non-approval*; gate tests assert both the block and the accepted path; the plan-review tests read a real artifact from a temp root; the API key must never appear in a request body.
- Static check: `python3 ~/.omp/agent/managed-skills/code-guard/scripts/guard.py --deep` runs `tsc --noEmit` over `src` and `tests` (the repo has no prettier/eslint config, so that channel reports "skipped").
- No coverage thresholds, no CI. The repo's own bar: a claim is done only with observed tool output recorded, never an agent's assertion - apply that when reporting test results.
