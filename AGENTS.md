# Repository Guidelines

Practical guidance for AI assistants and contributors working in this repo.

## Project Overview

`jevstice` is an [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension: Jev (`jev-latest`, served by the TypeSafe systemone API) acts as a decision judge. The executor agent brings the decisions it can see to the judge instead of guessing, and the extension holds the visible boundaries where an unanswered decision would be consequential.

What the executor can consult:

- `jev_consult` - one decision in the shape that fits it: `choice` (between submitted alternatives), `score` (on a submitted rubric) or `boolean` (a yes probability). Used for uncertainty during implementation, for a consequential business decision with task context (FR-19), and whenever a decision should not rest on the executor's guess.
- `jev_triage` - does the request need the deeper activities at all, and which narrow task-specific topics does it need? A simple result names the skipped activities and registers nothing.
- `jev_reaim` - registers an actual owner change of direction, replaces the task and drops its old approvals; a re-aimed task needs fresh requirements and a fresh plan (FR-29).
- `jev_search_relevance` - which submitted search candidate is relevant, with the executor's own submitted reason returned (FR-03).
- `jev_requirements` - per-item understanding of the requirement list against the owner's request, plus its coverage and the omitted owner needs, in one batched call (FR-04..FR-06).
- `jev_plan_review` - the plan artifact defended topic by topic before the judge: the executor submits each topic with the artifact section that governs it, the paths it changes and the requirement it serves, and one question per topic decides it; the approval binds the task fingerprint and the artifact's exact bytes (FR-07, FR-24).
- `jev_acceptance` - the finished work defended separately as `business` and as `architecture` (FR-14, FR-15).
- `jev_review` - a checkpoint, commit or diff defended as a developer (FR-16).
- `jev_text_review` - a text split into fragments, with the register rule each failing fragment violates quoted back (FR-27).
- `jev_anti_slop` - an external document, research output or legal communication defended against quoted evidence: claim verdicts, inference re-checking, hypothesis falsifiability, language, register and meta-text findings, explicit trust marks, numbered parts and owner waivers (FR-45..FR-56).

What reaches those boundaries:
- a request is read once when its prompt arrives, locally and for free (`src/screen.ts`): one that only publishes, inspects or verifies existing work is `quiet`, costs no judge call and holds nothing, and everything else - including any text the reading does not recognise - enters the judged workflow, where the judge and not the reading decides the depth (FR-30). The reading decides entry only: a development task already registered keeps its walls;
- a shell command is consequential only when it can reach the working tree: inspections and publication pass without a boundary or a revision bump, while a command the classifier cannot read fully is held (FR-31).

The boundaries it holds:
- for a judged request, project reads and searches, consequential shell calls, requirement submission and local plan writes are held until the request is triaged; skill reads, task tracking, non-project reads and recognised non-mutating shell calls pass (FR-32);
- the plan-mode proposal `write xd://propose` needs a plan approval for the artifact being proposed, and the approval survives the approve-and-execute session switch only while the copied artifact still matches the approved digest;
- the first consequential change of a session waits for a triage decision (`jev_triage`): a confirmed simple task then passes without the deeper stages, and the verdict belongs to that one request; a development task then waits for requirements and a plan (FR-18, FR-34);
- a consequential change is held while the registered development task has no approved plan, while a course check is in flight, or while a finding is outstanding - unless the judge proved unavailable or that boundary was released after its refusal bound, in which case it passes and the refusal stays an OPEN item (FR-21, FR-23);
- every consequential invocation the deterministic gates admit is judged on its complete JSON payload before execution; an oversized payload is refused, a stale answer is discarded and the gates are re-read before execution (FR-38);
- `session_stop` is held until both acceptance aspects passed at the current work revision and the completion check agrees (FR-17);
- for an external task in `enforce` mode, completion and an external-delivery invocation wait until the current anti-slop review covers every part with no unwaived blocker; the owner waives one finding with `/jev-waive` and an advisory finding never holds (FR-45..FR-56);
- `/jev-continue` or a recognized standalone owner approval message releases the current request across all gates; tool arguments, quoted text and extension-originated input never grant permission, and a new task does not inherit it (FR-44).

Nothing classifies prompts and nothing calls the judge before a tool is invoked or a boundary is reached: a plain read-only question or web search costs zero judge calls and no gate (FR-10, S13), and the one reading that does happen reads the request text only, never the project (FR-30).

Fail-closed is the core invariant (see `POLICY` in `src/types.ts`): judge errors, malformed answers, missing answers and answers below the floor never approve. There are no meta-option escapes to map - any deviation from the submitted question set fails the whole outcome. Stop refusals are bounded (`POLICY.maxStopBlocks`): the same unchanged refusal is recorded as an OPEN item instead of looping. Any change must preserve this; tests pin it.

## Architecture & Data Flow

Ordinary `src/` stays flat, with no build step; the optional autonomy module lives in the `autonomy/` directory and the manifest never imports it. Dependencies point right:

- `types.ts` - shared vocabulary (`Evidence`, `Aspect`, `JevConfig`, `ToolOutcome`, the anti-slop claim/review/finding types), the `asRecord` guard and `POLICY` (floors, evidence and anti-slop bounds, transport defaults).
- `judge.ts` - the single judge adapter: `JudgeQuestion`/`JudgeAnswer`/`JudgeOutcome`, request validation before any call, fail-closed normalization of SDK answers, and the answer accessors (`choseLabel`, `saidTrue`, `probabilityOf`, `scoreOf`, `answerOf`). The SDK returns no free prose, so nothing here invents an explanation.
- `apikey.ts` - key resolution: environment variable first, then a resolver command whose stdout is the key. The key reaches the client and nothing else; a failure resolves to `undefined`.
- `config.ts` - project `<cwd>/.omp/jev.config.json` overrides user `~/.omp/agent/jev.config.json`; reads `gates.mutation`, `gates.completion`, `courseCheck.mode`, `courseCheck.interval`, `antiSlop.mode` and `billing.balance` / `billing.inputCostPerMillion` / `billing.outputCostPerMillion`. `courseCheck.mode` ships as `completion`; `antiSlop.mode` ships as `advisory` and accepts `off`, `advisory` and `enforce`. The billing balance is a configured snapshot because the public TypeSafe API has no balance endpoint. Unknown keys are ignored (old files still load) and an invalid value keeps the shipped default, naming the file and the key.
- `screen.ts` - the free reading of a request (`weightOf`): `quiet` for publish-inspect-verify phrasing, `judged` for everything else including unrecognised text (FR-30). Lexical and deterministic; it decides entry only.
- `state.ts` - per-session gate state, fingerprints (`sha256`) and the ledgers: the screen's reading of the current request, task registration with the external flag, simple verdicts, requirements and plan drafts, action records, revision, acceptance records, the stop-block ledger, the refused-submission ledger, refused calls per boundary, the deviation latch, direction-pending state, the owner continuation grant, the anti-slop review/waiver records and the session usage/activity counters (FR-22, FR-23, FR-29, FR-44, FR-45..FR-56). State is in memory and is dropped on restart.
- `gates.ts` - the visible boundaries as pure decisions: what counts as a consequential change including the shell-command classifier (`isNonMutatingCommand`, FR-31), the triage-before-inspection gate (FR-32), the requirements-before-plan gate (FR-34), the mutation gate reason (each refusal names its boundary and renders the copy-ready next call, FR-28), the `xd://propose` gate, the completion gate with the anti-slop hold (FR-55), and the target-against-plan comparison the course check hangs off (FR-25).
- `activities.ts` - the ten activities plus the three judged checks (`actionCheck`, `courseCheck`, `completionCheck`): request validation, question building, the guarded judge call, typed-answer interpretation, state update, human-readable text. `antiSlop` adds claim-evidence verdicts, Toulmin inference checks, falsifiability, language/register/meta-text/relevance findings, trust marks and part coverage. The guard in front of the judge keeps the refusal ledger: a digest already refused at a boundary costs no call, and the boundary releases itself once the bound is reached (FR-22, FR-23). The file is about 2250 lines; read the activity being changed plus `material()` and the shared validators first.
- `artifact.ts` - reading a `local://` artifact from disk, so the plan review binds an approval to the artifact's bytes rather than to the caller's copy.
- `controller.ts` - the omp wiring: registers the ten tools, `/jev-continue`, `/jev-waive` and `/jev-status`, holds the `input` / `tool_call` / `tool_result` / `session_stop` handlers, restores a digest-bound plan across the approve-and-execute switch, serialises judged activities per session, keys state per session, counts activity outcomes and judge usage for the periodic status, and runs the automatic checks. About 1000 lines.
- `autonomy/index.ts` - strict-only extension entry, loaded by the supervisor instead of the manifest: it registers deny hooks, requires both nonempty run/store locators, then dynamically loads the runtime.
- `autonomy/runtime.ts` - opt-in strict runtime: restored workflow state, explicit decision context, durable intent admission, dependency hashing, matched native result settlement, evidence-bound completion and `jev_autonomy`.
- `autonomy/store.ts` - private Bun SQLite authority: immutable objective/policy, exclusive overlapping roots, ownership epochs, checkpoints, immutable blobs, decisions and intent journal. Ordinary sessions never open it.
- `autonomy/scope.ts` - Linux systemd user-scope creation, exact cgroup identity and whole-scope containment/fence receipts. Process-group signalling is not a containment substitute.
- `autonomy/driver.ts` - `start`, `resume`, `status`, `stop` supervisor CLI; bound OMP RPC process, custom wake acknowledgment, context injection, resource accounting and operator cancellation. It launches the child with `autonomy/index.ts` as the extension entry and is not a general RPC proxy.
- `index.ts` - the ordinary extension entry; `package.json` declares `src/index.ts` under `omp.extensions`, so an installed checkout loads it in ordinary sessions. It registers only the ordinary controller: autonomy locators are ignored and nothing under `autonomy/` is imported.

Data flow of one activity: tool call -> parameter validation (a malformed submission is refused before any call) -> `deps.judge(state, questions)` -> typed answers (a selected label, a rubric score, or a yes probability) -> approval-floor check -> recorded state or a refusal -> text and `details` back to the executor.

The automatic checks run at visible boundaries: an action check judges every admitted consequential invocation before execution, an interval course check follows successful consequential actions, and the completion check runs at `session_stop`. Their outcomes reach the executor as session messages.

## Key Directories

- `src/` - ordinary runtime code, flat, one concern per file, plus `jev-skill.md` (ordinary workflow guidance only; the strict autonomous guidance lives in `autonomy/runtime.ts`).
- `autonomy/` - the optional strict module: `index.ts` (explicit entry), `runtime.ts`, `store.ts`, `scope.ts` and `driver.ts`. Not in the package manifest, never imported by ordinary code.
- `tests/` - flat `*.test.ts` mirroring src modules, plus `tests/helpers.ts` (fake judge, fake host, fake artifacts, `boundaryConfig`).
- `tools/` - live smoke against the production judge and the real OMP host, plus `tools/README.md` and `armed.jev.config.json`.
- `docs/` - README banner and the optional autonomy module's lifecycle/deployment reference.
- `PRD.md` is the owner-approved, tracked source of the functional requirements. `ACCEPTANCE.md`, `PLAN.md`, `TASKS.md` and `evidence/` are ignored working records. Do not remove `PRD.md` from the index.

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

The current observed baseline is `bun test` 486 pass / 0 fail / 2170 `expect()` calls / 16 files and a clean `bun run typecheck --noUnusedLocals --noUnusedParameters` after the consultation-budget correction. A fresh real ordinary host workflow passed. Earlier checks separately proved ordinary operation with the optional module absent and stray locators present, and strict startup. Ordinary live smoke needs a real judge key and, for `host`, an installed OMP/model; it does not exercise external review. Strict live scenarios additionally need Linux cgroup v2 and a working systemd user manager, and they run only the optional module. Missing prerequisites are not passes; see `tools/README.md`.

API key: `TYPESAFE_API_KEY` env (also `JEVI_API_KEY`), or a resolver command in `TYPESAFE_API_KEY_COMMAND` (e.g. `pass show token/jev`). No key -> the judge reports an unusable answer; it never approves.

There is no build, lint/format tooling or CI. The only CLI is the opt-in strict supervisor (`bun run autonomy`, which runs `autonomy/driver.ts`); ordinary operation remains an OMP extension and never loads that module. Verify with `bun test`, `bun run typecheck` and a real-host smoke covering the changed path. `package.json` declares `src/index.ts` under `omp.extensions`, so an installed checkout loads in ordinary sessions; `omp --no-extensions -e <path>/src/index.ts` loads a checkout explicitly. The optional module's child uses `autonomy/index.ts` as its explicit entry instead. Restart the host after extension changes; a loaded process does not hot-replace its schemas and hooks.

## Code Conventions & Common Patterns

- Tabs, double quotes, semicolons, `const`-only, arrow functions, trailing commas. Files camelCase.
- No classes. The controller is a factory (`createJevController`) returning `{ register(pi) }`; everything else is plain functions, interfaces and `as const` tables.
- Error handling: activities return `ToolOutcome` - `{ok: true}` means a well-formed judge answer was obtained (the verdict may still be a refusal), `{ok: false}` means refused or unusable. Nothing throws at a gate: an unexpected error means "block", never "approve".
- Small static, string-keyed lookup tables are `Record<string, true>` (`MUTATING_TOOLS`, `COORDINATION_SCHEMES`, `EVIDENCE_KINDS`); `Set`/`Map` are for dynamic membership.
- Dependency injection via plain function types: `Judge`, `ActivityDeps {judge, config, readArtifact?}`, `ControllerDeps {judge, config, zod}`, `createTypeSafeJudge({resolveKey, model?, createClient?})`. Every dependency has a production default; tests override through the same seams.
- Async: plain `async/await`; `node:crypto` SHA-256 for fingerprints and artifact digests. Fire-and-forget work (the course check) is wrapped in its own try/catch, since an unhandled rejection in this in-process extension is fatal to the session.
- State: ordinary sessions use `Map<sessionId, JevState>` in the controller closure; restarting drops their approvals. Strict runs restore only from the verified private SQLite authority under a current ownership binding; native journals and summaries cannot grant execution permission. Changed tracked bytes invalidate current acceptance/completion and old execution observations before checkpoint digests are refreshed. A new session requires fresh execution observation; unchanged refusal material remains waiting across that reset.
- Doc comments cite requirement IDs (`FR-07`, `FR-18`) - keep the IDs when editing the code they mark.
- `asRecord` is defined once in `types.ts` and shared; do not add a schema dependency for it (schemas come from the injected `pi.zod`).
- Public and project artifacts (README, CHANGELOG, PRD, TASKS, commits, this file) are English.

## Important Files

- `package.json` - scripts `test`, `typecheck`, `autonomy` (runs `autonomy/driver.ts`); `engines: {bun: ">=1.1"}`, single runtime dep `@typesafe-ai/sdk`, and the `omp.extensions` manifest entry `src/index.ts`. Strict supervision additionally uses Bun's built-in SQLite and Linux systemd/cgroup capabilities, without a new package dependency.
- `src/index.ts` - read first (~35 lines): the factory omp calls, config load, production judge and ordinary controller registration. It never reads autonomy locators.
- `autonomy/index.ts` - the optional module's explicit entry: deny hooks, locator validation, then the dynamic runtime load. Only `autonomy/driver.ts` launches it.
- `src/types.ts` - `POLICY` and the shared vocabulary.
- `src/controller.ts` (~950 lines) - tool registration, `/jev-continue`, `/jev-waive`, the handlers, the plan handoff and the artifact reader wiring; read `PiApi` (structural typing over the omp host) first.
- `src/activities.ts` (~2445 lines) - one function per activity and the judged checks, including `antiSlop`; read the activity you are changing plus `material()` (the evaluated state) and the shared validators at the top.
- `src/screen.ts` - short (~50 lines): the request reading that decides entry before any judge call.
- `src/gates.ts` (~875 lines) + `src/state.ts` (~553 lines) - the boundary decisions and the state they read, including the anti-slop hold and review coverage.
- `tools/live-smoke.ts` (~925 lines) - the live workflow and host verifier; `tools/README.md` documents its modes and evidence.
- `tsconfig.json` - strict + `noUncheckedIndexedAccess`, `noEmit`, `types: ["bun"]`.

## Runtime/Tooling Preferences

- Bun >= 1.1 is required and is both runtime and test runner; this code is not Node-tested. Use `bun run`, not `node`/`npx`/`npm`.
- TypeScript is typecheck-only (`noEmit`): there is no compiled artifact and no `dist/`. Shipping is `git clone` into `~/.omp/agent/extensions/jevstice`; the manifest entry is already declared and dependencies auto-install on first run. No npm publish.
- Do not add lint/format tooling, build steps, or schema/validation dependencies without asking - their absence is a deliberate choice.

## Testing & QA

- Framework: `bun:test` only. Run everything with `bun test`; single file: `bun test tests/gates.test.ts`.
- Layout: flat module tests plus cross-cutting anti-slop, autonomous entry/runtime/store/scope/driver/smoke-oracle tests and `tools/live-smoke.test.ts`. Sixteen test files in the current baseline. Autonomous runtime tests use real local child processes and native scopes; no unit test calls a network judge.
- Style: `describe`/`test` + `expect`; behavioral test names that cite requirement IDs (e.g. `FR-01`, `FR-11`, `fail-closed`). Shared helpers in `tests/helpers.ts`: `answeringJudge` (answers a question table, or derives an answer from the question), `failingJudge`, `fakePi` (registers tools and handlers and lets a test emit `tool_call`/`tool_result`/`session_stop`), `fakeCtx`, `fakeArtifacts` (a temp session artifact root), `fakeZod`, `blockReason`, `stopDecision`, `until`, `boundaryConfig` (the shipped configuration with one boundary turned off).
- Canonical patterns to follow: the judge is always an injected fake (no network in any test); fail-closed cases (judge error, malformed answer, below-floor answer, missing key) assert *non-approval*; gate tests assert both the block and the accepted path; the plan-review tests read a real artifact from a temp root; the API key must never appear in a request body.
- Static check: `python3 ~/.omp/agent/managed-skills/code-guard/scripts/guard.py --deep` runs `tsc --noEmit` over `src`, `autonomy` and `tests` (the repo has no prettier/eslint config, so that channel reports "skipped").
- No coverage thresholds, no CI. The repo's own bar: a claim is done only with observed tool output recorded, never an agent's assertion - apply that when reporting test results.

## Execution retrospective: autonomy work

I prolonged the owner's wait through the execution errors below. The work repaired real regressions, but I did not prove the original ordinary-addon failure fixed or deliver the requested full-autonomy outcome.

- **Missed injected guidance.** I verified the physical module split before checking its workflow asset, requiring another change and final verification round. Inventory entry points, inherited activation variables and injected guidance before the final isolation checks.
- **Unproductive decision rounds.** I spent reviews without settling decisions, including local refusals never sent to Jev. Submit one claim with exact artifact quotes and observed output. Retry a substantive judgment only with new settling evidence or a changed implementation; do not paraphrase or switch channels to escape a hold. Preserve accepted stages, floors and OPEN findings; continuation permission is not approval.
- **Unverified tools and protocol.** I delegated an LSP-required move without checking worker tools and asserted an RPC field the installed host did not return. Verify the actual execution context first. Keep required operations inline when the worker lacks the tool; distinguish a faulty test assumption from a product defect.
- **Premature completion tracking.** I closed items before owner-level proof, although final reports disclosed gaps. Require current evidence for named criteria and required acceptance before closing a deliverable. Keep unmet criteria OPEN; green tests and safe waiting do not prove full delivery. Do not repeat an unchanged nonterminal trial or replay an unknown effect to obtain a pass.

The seven-scenario matrix recorded about 49.5 minutes of scenario runtime, not a measured wasted-time total. Necessary verification was part of the work; the exact avoidable delay was not measured. Evidence: the session transcript, `/tmp/jev-autonomy-smoke-NcZOpe/matrix.json` and the ordinary-guidance before/after probes.

| Conclusion and corrective rule | Jev verdict | Confidence |
| --- | --- | --- |
| Inventory injected guidance before final isolation verification | supported | 0.86 |
| Bound review attempts by materially changed evidence | supported | 0.84 |
| Verify actual worker and protocol capabilities | supported | 0.90 |
| Bind completion markers to the owner's observed outcome | supported | 0.98 |

An initial broader diagnosis/prioritization claim was inconclusive at 0.38 and was not adopted; the guidance finding was narrowed and settled with the exact controller-to-asset dependency. These four approvals concern the retrospective and rules, not earlier addon/autonomy correctness or unresolved implementation acceptance.

An earlier draft's style check (0.24), the append-scope consultation (0.54) and automatic write preflight remained inconclusive. Normal-mode continuation allowed this append after three blocked calls; it did not approve those OPEN decisions.

Subsequent whole-task acceptance checks were inconclusive: business 0.20 and architecture 0.28. No whole-task approval was obtained; this does not revoke or widen the four per-conclusion approvals above. Further unchanged submissions were stopped.

The follow-up repair confirmed that a held finding incorrectly merged distinct consultation questions into one refusal budget: three usable independent answers exhausted it, and a fourth question never reached Jev. The correction reuses the existing per-question boundary without lowering approval floors or clearing the finding. Jev supported this decision at 0.98; failing-before/passing-after regressions and fresh-process activity/host evidence are recorded in `tools/README.md`. This targeted repair does not claim full autonomy delivery or turn the earlier whole-task acceptance findings into approvals.

Latest follow-up acceptance remained unapproved: business returned `business_gap` at 0.35; architecture's aspect verdict passed, but its three plan-topic evidence checks stayed below the floor at 0.41, 0.48 and 0.65. Both acceptance budgets reached 3/3, permitting continuation with those findings OPEN rather than approved. The repair choice at 0.98 and developer review at 0.88 concern the targeted ordinary-addon correction, not full autonomy or whole-task acceptance.
