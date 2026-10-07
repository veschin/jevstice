# Repository Guidelines

Practical guidance for AI assistants and contributors working in this repo.

## Project Overview

`jevstice` is an [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension: Jev (`jev-latest`, served by the TypeSafe systemone API) acts as a decision judge. The executor agent validates important steps through fixed-option questions instead of guessing. Gates: plan review (file mutations blocked until approved), completion review (execution/code/log evidence required), `course_check`, `aspect_coverage`.

Fail-closed is the core invariant (see `POLICY` in `src/types.ts`): judge errors, malformed answers, meta-option escapes and low confidence never approve. Rework is bounded at 3 iterations per stage, then `ask_user`. Any change must preserve this; tests pin it.

## Architecture & Data Flow

Flat `src/`, no subdirectories, no build step. Layering (dependencies point right):

- `types.ts` - shared types + `POLICY` constant; everything else builds on it.
- `guards.ts` / `evidence.ts` - type guards; request validation and prompt policy (`EVIDENCE_POLICY` treats evidence as untrusted data; service/meta options can never approve).
- `client.ts` - judge transport via `@typesafe-ai/sdk` (`createJudge`, `createMultiLabelJudge`, `createCourseCheckJudge`, `validateAnswers`, multilabel sharding).
- `catalog.ts` - bundled `catalog-data.json`; topic selection and model/skill routing; 255-option Choice sharding (`planShards`).
- `control-points.ts` - `CONTROL_POINT_REGISTRY`: stages and triggers (`mutation_gate` / `session_stop` / `on_demand`).
- `config.ts` - template config: project `<cwd>/.omp/jev.config.json` overrides user `~/.omp/agent/jev.config.json`; thresholds are raise-only; invalid config refuses to load, naming the file and the problem.
- `controller.ts` - `JevController`: registers the `jev_decision` tool with omp, holds per-session `JevState`, binds approvals to SHA-256 task fingerprint + content digest + work revision, persists state via omp custom session entries (`jev.state`).
- `index.ts` - extension entry (`"omp": {"extensions": ["src/index.ts"]}` in package.json). `createJevExtension(deps)` loads config, builds production judges, constructs the controller, `controller.register(pi)`.
- `cli.ts` - standalone runner (stdin / file / inline JSON; `probe` subcommand).

Decision data flow: control point fires -> controller blocks the executor and asks for a `jev_decision` call -> `validateDecisionInput` normalizes (never throws) -> fingerprint/`revisionHash` computed -> `buildRequestBody` injects policy + options -> `systemOne()` HTTP call -> `validateAnswers` -> meta-option mapping (never approve) -> `downgradeUncertain` / `normalizeJudgeResult` -> verdict (`approve` / `revise` / `insufficient_evidence` / `ask_user`) stored in `JevState`.

## Key Directories

- `src/` - all runtime code, flat, one concern per file (11 files).
- `tests/` - flat `*.test.ts` mirroring src modules; `tests/helpers.ts`, `tests/fixtures/`.
- `docs/` - README banner only.
- Root process docs `PRD.md`, `PLAN.md`, `TASKS.md`, `ACCEPTANCE.md`, `POLICY-DRAFT.md` and `evidence/` are deliberately **untracked** (listed in `.gitignore`). Never commit them; the public repo keeps product files only.

## Development Commands

```sh
bun install                # dependencies (bun is the only package manager; no lockfiles other than bun.lock)
bun test                   # full test suite (bun:test)
bun run typecheck          # tsc --noEmit - the only static check
bun run src/cli.ts probe   # smoke-test the judge end to end (needs API key)
```

API key: `TYPESAFE_API_KEY` env (also `JEVI_API_KEY`), or a resolver command in `TYPESAFE_API_KEY_COMMAND` (e.g. `pass show token/jev`). No key in a test context -> fail-closed stub judge, never silent approval.

There is no build, no lint, no format tooling, no CI. Verification before handoff is `bun test` + `bun run typecheck`; commit messages in this repo record those results.

## Code Conventions & Common Patterns

- Indentation is mixed by file: tabs in `controller.ts`, `config.ts`, `control-points.ts`, `index.ts`, `guards.ts`; 2 spaces in `types.ts`, `client.ts`, `catalog.ts`, `evidence.ts`, `cli.ts`. Match the file you are editing; do not reformat whole files.
- Double quotes, semicolons, `const`-only, arrow functions, trailing commas. Files camelCase. No default exports except `src/index.ts`. One class (`JevController`); everything else plain functions, interfaces, `as const` tables.
- Error handling: custom `Error` subclasses with `name` set (`CatalogError`, `JevApiError` with `code`/`status`, `JevConfigError` with `file`) for caller-facing failures. Validators return result objects (`{ok, reasons}` / `ValidationProblem[]`) instead of throwing; `validateDecisionInput` and the gate paths never throw - an unexpected error means "block", not "approve".
- Dependency injection via plain function types (`Judge`, `MultiLabelJudge`, `CourseCheckJudge`) and `Partial<ControllerDeps>` / `CliDeps {env?, fetchFn?}`. Every dependency has a production default; tests override via the same seams (`createJevController` is marked "Test seam / DI entry point").
- Async: plain `async/await`; `crypto.subtle` SHA-256 for fingerprints; CLI stdin via `Bun.stdin.stream()`. No streams elsewhere.
- State: per-controller `JevState` instance state; module-level registries are `ReadonlySet`/`ReadonlyMap`/`as const`. No singletons beyond the extension closure.
- Doc comments cite requirement/test IDs (`FR-12`, `R5`, `AC5`, `POLICY.failureNeverApproves`) - keep the IDs when editing the code they mark.
- `isRecord` is intentionally defined twice (`guards.ts`, `client.ts` - "no external schema dep", client.ts:107); do not "fix" this duplication by adding a dependency.
- Public artifacts (README, CHANGELOG, commits, this file) are English; internal process docs are Russian.

## Important Files

- `package.json` - 3 scripts, `engines: {bun: ">=1.1"}`, `omp.extensions` manifest field, single runtime dep `@typesafe-ai/sdk`.
- `src/index.ts` - read first (~180 lines): extension wiring, production judge construction, config-driven registration refusal.
- `src/types.ts` - shared vocabulary and `POLICY`.
- `src/control-points.ts` - small gate registry; the stages that exist.
- `src/controller.ts` - ~51 KB, dominates the logic. Read selectively: `ControllerDeps`/`PiApi` (structural typing over the omp host), `validateDecisionInput`, `normalizeJudgeResult`, `JevController.register()`.
- `src/config.ts` + README "Config" - merge and raise-only rules.
- `tsconfig.json` - strict + `noUncheckedIndexedAccess`, `noEmit`, `types: ["bun"]`.

## Runtime/Tooling Preferences

- Bun >= 1.1 is required and is both runtime and test runner; this code is not Node-tested. Use `bun run`, not `node`/`npx`/`npm`.
- TypeScript is typecheck-only (`noEmit`): there is no compiled artifact and no `dist/`. Shipping is `git clone` into `~/.omp/agent/extensions/jevstice`; dependencies auto-install on first run. No npm publish.
- Do not add lint/format tooling, build steps, or schema/validation dependencies without asking - their absence is a deliberate choice.

## Testing & QA

- Framework: `bun:test` only. Run everything with `bun test`; single file: `bun test tests/client.test.ts`.
- Layout: flat `tests/*.test.ts`, one file per src module (`catalog`, `client`, `cli`, `config`, `controller`, `evidence`) plus `tests/integration.test.ts` which spawns the real CLI via `spawnSync` with `tests/fixtures/*.json`.
- Style: `describe`/`test` + `expect`; behavioral test names that cite requirement IDs (e.g. `FR-01`, `POLICY.failureNeverApproves`). Shared helpers in `tests/helpers.ts` (`makeMockJudge`, `approveOption`, `lowConfidenceApprove`, `sampleRequest`); per-file fakes: fetch stubs, mock judges, a fake `pi` harness.
- Canonical patterns to follow: judges are always injected fakes (no network in unit tests); fail-closed cases (judge error, malformed payload, low confidence) must assert *non-approval*; evidence round-trips are asserted byte-identical; the API key must never appear in a request body.
- CLI exit-code contract (pinned by tests): `0` = valid judge output (even `revise`), `2` = usage/invalid input, `4` = config/transport/auth failure.
- No coverage thresholds, no CI. The repo's own bar: a claim is done only with observed tool output recorded, never an agent's assertion - apply that when reporting test results.
