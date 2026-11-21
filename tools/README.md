# Live Jevstice smoke

`live-smoke.ts` verifies the ordinary controller through the package's only manifest entry,
`src/index.ts`. `autonomy-smoke.ts` verifies the optional strict module, which the manifest never
loads: its only activation path is the separate CLI (`bun run autonomy`, i.e. `autonomy/driver.ts`),
which launches the child with `autonomy/index.ts` as its extension entry.

Both use the production judge and real OMP where indicated. Missing credentials, unavailable
services and refusals are recorded as observed failures; they are never converted into skipped or
passing results, and no run retries unchanged material to obtain a favorable answer.

## Current contract

Jev results are diagnostics. The controller classifies visible tool calls deterministically, records
what was observed, and never blocks ordinary execution or completion. A failed check stays failed; an
inconclusive answer establishes neither a defect nor an approval; an outage or stale answer
establishes nothing; a local argument error is not checked because no judgment ran. Findings remain
disclosed with their boundary, work revision, exact submitted material and returned result, and
`jev_context({"action":"list"})` prints that record.

Every Jev tool result while diagnostics are on carries `details.diagnostics`, with `checks` and `work` objects that each carry
`passed`, `failed`, `inconclusive`, `unavailable` and `not_checked`. `checks` counts Jev activity
results; `work` counts coverage of consequential tool results. A consequential result starts as
`not_checked`; the action diagnostic then runs in the background after the completed result, using
the current approved plan when one is available. An asynchronous launch without a settled action
diagnostic remains `not_checked`; observing a launch or terminal result alone is not a passing check.
`/jev-status` reports both groups and current-revision business and architecture acceptance without
starting a model turn. Automatic action and completion checks no longer publish a session summary
or update OMP's status strip.
The 2.3.1 release passed 968 tests (two pending) and the deep TypeScript check.
An OMP 18.22.2 terminal probe with a deterministic judge showed one status entry with the settled
outcome and no separate verdict in the transcript (`/tmp/jev-footer-p3qpLi/pane.txt`).

There is no continuation command, approval-message override, repair permit or resolution phase.
`/jev-continue`, `/jev-waive` and `jev_consult mode: "recovery"` are removed; the consult accepts only
`choice`, `score` and `boolean`. The native `/jev` command switches diagnostics (`off`, `on`, or no
argument to report) for one session, and `/jev-status` reports the diagnostic state. The switch never
edits configuration and changes no host permission.

Read-only admission is bounded and quote-aware, and an `http://`/`https://` read is an external read
rather than a project inspection. Those classifiers decide what is consequential enough to record;
they do not decide whether a call may execute.

## Issue 2: actionable review diagnostics

The [benchmark](https://arxiv.org/html/2611.02155v1#A2.T3) reports 89.3% recall for Jev 1.14
with definitions alone, 98.2% with Opus examples, and 120 ms median latency with Opus examples.
The original run's exact submissions were not available. Missing headings were a plausible cause,
not an established cause. In a fresh pre-change probe, adding the headings and caption left the
swapped recall value marked supported. The regression covers an unlabeled row, verified context,
the condition swap and an inconclusive answer. A live probe of the final prompt rejected the swapped
value with the headed table alone and with source prose. It supported the correct value with source
prose; the correct table-only and row-only submissions remained inconclusive
(`/tmp/jev-issue-2.6Yo6rO/benchmark-final.jsonl`).

The initial classifier returned external for `File a GitHub issue` but not `Create a GitHub issue`;
both still needed triage because neither had quiet request weight. Native OMP now reaches the
review for explicit creation and returns `not_checked` with `out_of_scope` for an existing-issue
review. Rule severity was already explicit: use `blocker` for a mandatory register rule and
`warning` for editorial preferences. Sentence selection narrows a settled finding when reliable;
other cases retain the paragraph. No step grants publication permission.

- The selected candidate passed `bun run typecheck` and `bun test` in an isolated tree:
  911 passed, 0 failed and 2 pending (`/tmp/jev-issue-candidate.DskcZU/test.log`).
- Native fact-check: the observed Section 6 excerpt contradicted the swapped figure and returned
  `correct_claim` (`/tmp/jev-fact-native-final.WH0UBM/omp.jsonl`).
- Native anti-slop: a mandatory register finding quoted `We kinda need this fixed.` while the
  overall review remained inconclusive (`/tmp/jev-editorial-final.7KNHqe/omp.jsonl`). The existing
  issue review was skipped (`/tmp/jev-issue-skip.L3BZvH/omp.jsonl`).
- A fresh OMP process selected the installed issue-acceptance skill for an existing issue. It
  accepted the measurement, disputed the proposed cause and fix, and left the tracker unchanged
  (`/tmp/jev-issue-skill.lSq0Ez/omp.jsonl`).

## Issue 3: task and integrated acceptance

Run `bun tools/acceptance-baseline.ts` with the configured TypeSafe key. The runner freezes six
synthetic scenarios, writes the fixture code in isolated workspaces and records the Bun command,
output and exit code where a check is specified. Each scenario contributes one final revision;
the runner does not repeat attempts or select the best result. It reports non-runs separately.

Observed with `jev-latest` on cohort `e2514aeb590f`:

| Measure | Eligible | Approved | Weak task | Missing evidence | Defect | Inconclusive | Unavailable | Not checked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Planned tasks | 6 | 3 | 1 | 1 | 1 | 0 | 0 | 0 |
| Integrated reviews | 4 | 1 | 0 | 0 | 0 | 0 | 0 | 3 |
| Unplanned results | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |

The three integrated reviews did not run because not all tasks passed. The unplanned non-run
had no execution evidence. The cohort includes deliberate failures and does not estimate
approval rates for production sessions.

A fresh OMP process registered a two-task outline, wrote `clamp.ts`, and ran a Bun check that
printed `0` and `5`. The native `jev_acceptance` outcome returned two accepted tasks and one
accepted integrated review, all at revision 2.

## OMP 19.1 command routing

In a fresh OMP 19.1 session, use separate `bash` calls without a PTY:

```bash
jev_requirements --help
jev_acceptance --help
jev_requirements -j '{"items":[]}'
jev_acceptance -j '{"aspect":"outcome"}'
```

Both help calls returned their schemas. The execution events identified `jev_requirements` and
`jev_acceptance` as the actual inner tools. With no registered project objective or evidence, each
returned its local validation or prerequisite result; this checked routing, not judgment approval.
The focused controller, fact-check, and autonomy tests passed (125 tests), including the
regression for standalone diagnostics versus a command with a file redirection.

## Modes

| Mode | Judge | What it verifies |
| --- | --- | --- |
| `direct --scenario workflow` | Production Jev | Triage, requirements, staged plan review, consequential implementation, acceptance and completion through the real controller and real judge. Verifies that consequential calls execute, diagnostics are attached, acceptance is recorded as a typed verdict, and the session settles. |
| `direct --scenario factorio` | Production Jev | Planning-only run: triage, requirements, outline, one detail per step and finalization. The approved plan is the deliverable; no implementation, acceptance or completion is claimed. |
| `direct --scenario diagnostics` | Injected deterministic judge | A negative developer review and a negative business acceptance, plus a judge outage. Verifies that both remain truthfully recorded and that a subsequent consequential call and completion still proceed. This is deterministic controller coverage, not a live judge result. |
| `host --scenario workflow` | Production Jev, real OMP | The real `omp` CLI loads `src/index.ts` with `-e`; the model exercises the registered `jev_*` tools through native routes, writes the planned files, runs the test command and submits acceptance. Verifies that the pre-plan write was not blocked, native tool results carry the diagnostic shape, and recorded failed diagnostics agree with any observed negative verdict. |
| `host --scenario factorio` | Production Jev, real OMP | The same native planning route for the planning-only scenario; project writes are rejected as an observed failure. |
| `verify-existing` | None | Revalidates a saved host run offline, with no model, judge or network call. |

Direct mode drives the real controller, gates, activities and state through the same fake-host seams
the tests use. Host mode passes `--max-time` to omp and kills the subprocess at `--max-time + 60s`, so
a hung provider or tool loop cannot run unattended. All project writes happen in disposable
directories under the system temporary directory.

The smoke never prints, logs or persists the TypeSafe key. The extension reads it from
`TYPESAFE_API_KEY` (`JEVI_API_KEY`, or `TYPESAFE_API_KEY_COMMAND`; see `src/apikey.ts`), and the
script records only judge questions, typed answers, tool outcomes and artifacts.

## What the checks do and do not claim

The direct workflow submits the complete write content in both the `tool_call` and `tool_result`
events, so the action diagnostic sees what would actually be written. After finalization it performs
the sequenced writes, records each terminal result and reads the resulting diagnostics. Acceptance is
submitted for both aspects and each typed verdict is recorded. A refused acceptance is a truthful
failed diagnostic; the run does not call it an approval merely because execution and completion
continued.

The `diagnostics` scenario deliberately starts its negative review while the last background action
check may still be in flight. A diagnostic finding must not invalidate that unrelated foreground
judgment; a stale result there is a source regression, not a harness artifact. The scenario does not
wait for background checks to settle or retry a stale answer.

The host mode normalizes omp's `write xd://jev_*` device route: the logical call arrives under
`result.details.xdev` as `{tool, args, inner}`. Validation reads typed `inner` details
(`needsDevelopment`, `approved`, `planDigest`, `diagnostics`) rather than English reply text. It
requires the extension to be loaded and exercised, the planned files and test command to execute,
and the diagnostic record to be present and consistent. It does not require an acceptance approval:
a negative verdict must be recorded as negative, not converted into a pass.

No smoke claims full live-workflow quality, whole-task acceptance, autonomy acceptance or
release readiness. A run establishes only the observations written to its evidence directory.

## Commands

```bash
# Ordinary controller with the production judge. Needs the judge key.
bun tools/live-smoke.ts direct --scenario workflow
bun tools/live-smoke.ts direct --scenario factorio

# Deterministic negative/outage continuation probe through the real controller; no judge key.
bun tools/live-smoke.ts direct --scenario diagnostics

# Actual omp host launch with the extension loaded. Needs omp, a model and the judge key.
bun tools/live-smoke.ts host --scenario workflow
bun tools/live-smoke.ts host --scenario factorio

# Optional: keep evidence in a known directory, pick the host model and its deadline.
bun tools/live-smoke.ts host --scenario workflow --out /tmp/jev-host --model deepseek/deepseek-flash --max-time 900

# Revalidate a saved host run offline: no model, judge or network call.
bun tools/live-smoke.ts verify-existing --out /tmp/jev-host --scenario workflow
bun -e 'import { verifyExistingHostRun } from "./tools/live-smoke.ts"; console.log(verifyExistingHostRun("/tmp/jev-host", "workflow"))'
```

A refusal that prevents an expected stage from being reached, a missing `jev_*` call, a missing
expected write or command, or an untruthful diagnostic record exits with code 1 and is listed in
`summary.json`. A negative Jev verdict by itself does not fail the run when the run's stated purpose
is to verify that work continued; it fails when the record hides it or when the run requires a
specific approval.

## Evidence

Each run creates a fresh temporary evidence directory and prints it on the last line. `--out`
puts it elsewhere. Files:

| File | Contents |
| --- | --- |
| `summary.json` | mode, scenario, pass/fail, judge kind, judge-call count, failures, evidence path |
| `judge.jsonl` (`direct`, production judge) | every submitted question set, its material and the typed outcome |
| `judge.jsonl` (`direct diagnostics`) | the injected typed answers and the submitted questions they answer |
| `transcript.jsonl` (`direct`) | tool calls and outcomes, diagnostics, stages |
| `artifacts/<plan>.md` | the exact plan artifact submitted to plan review |
| `workspace/` (`direct workflow`) | the files actually written and the real `bun test` output |
| `omp-events.jsonl` / `omp-stderr.txt` (`host`) | raw print-mode events and stderr |
| `prompt.txt` (`host`) | the exact autonomous prompt |

## Configuration during a smoke

The smoke writes no configuration fixture. The current schema reads `antiSlop.mode` (`off` or
`advisory`) and `billing.*`; obsolete `gates.*` and `courseCheck.*` keys are ignored, and
`antiSlop.mode: "enforce"` falls back to `advisory` with a named problem. The native `/jev off`
switch remains a separate per-session diagnostic control.

## Observed diagnostic-contract verification — 2026-11-15

- `bun test`: 530 passed, none failed, 2352 assertions across 20 files, after the acceptance
  evidence-basis change and the removal of the unreachable waiver storage.
- `bun run typecheck --noUnusedLocals --noUnusedParameters`: passed on the current source.
- `code-guard --deep src autonomy tests tools`: clean TypeScript check; formatter/linter channels
  were skipped because this repository has no corresponding configuration.
- Injected negative/outage smoke: passed at `/tmp/jev-live-smoke-BuklYu`. Two failed checks and
  unavailable checks remained diagnostic; later writes and completion proceeded.
- Production-judge direct workflow: passed at `/tmp/jev-live-smoke-cFesXK` with 12 judge calls.
  Both acceptance aspects passed for that disposable slug example, not for Jevstice as a whole.
- Native OMP 18.20.2 workflow with `deepseek/deepseek-flash`: passed at
  `/tmp/jev-live-smoke-a763ON`, exit 0, with native calls and typed diagnostic records.
- A separate native command probe found only `/jev` and `/jev-status` under the Jev prefix,
  accepted `/jev-status` locally with zero model turns and no extension errors
  (`/tmp/jev-native-diagnostics-lMUR9G.jsonl`).

These local evidence paths are machine-specific. This verification does not establish complete
strict-supervisor real-host coverage, comparative demos, release readiness or a whole-project
Jev acceptance verdict.


## Strict autonomy smoke

Strict scenarios need judge credentials and an authenticated OMP model, plus Linux `/proc`, cgroup v2
and a working systemd user manager. Those prerequisites belong to the optional module alone; an
ordinary host run needs none of them and never imports `autonomy/`. The scenarios start disposable
supervised projects outside this checkout, exercise actual native tool results and operator commands,
and retain their evidence. The harness cleans up owned child scopes and refuses an evidence directory
inside the checkout.

```sh
# List scenarios and separately labelled deterministic coverage without starting a run.
bun tools/autonomy-smoke.ts --list

# One live startup or completion path; --deadline is the per-scenario deadline in seconds.
bun tools/autonomy-smoke.ts --scenario startup --deadline 300
bun tools/autonomy-smoke.ts --scenario completion --deadline 600

# All eight live scenarios, or a comma-separated subset.
bun tools/autonomy-smoke.ts --scenario all --deadline 600
bun tools/autonomy-smoke.ts --scenario async,async-result,cancel,crash --deadline 600

# Optional model, OMP executable and private evidence root.
bun tools/autonomy-smoke.ts --scenario admission --model deepseek/deepseek-flash --omp omp --out /tmp/jev-strict-admission
```

| Scenario | Live observation |
| --- | --- |
| `startup` | Native RPC readiness, bound bootstrap/context, committed custom wake, actual provider start and judged work. |
| `completion` | One immutable objective reaches current-revision acceptance and completion without later owner input. |
| `async` | A real native Bash background invocation remains pending until the matching native wait-tool terminal result. |
| `async-result` | Automatic custom async-result delivery settles exactly the matching pending invocation. |
| `compaction` | Native compaction preserves the committed objective, plan and fresh provider context. |
| `cancel` | Operator stop fences the entire executor scope, preserves an unresolved effect and closes later admission. |
| `crash` | Supervisor loss and recovery fence surviving detached processes without claiming or replaying the unknown effect. |
| `admission` | Overlapping roots and a competing supervisor are refused; cancellation releases the roots. |

`matrix.json` distinguishes executed/passed live scenarios from deterministic test coverage.
Each scenario directory contains `summary.json`, `events.json`, `state.json` and bounded process
output; the exact observations and cleanup result accompany the pass/fail status. Exit 0 means
the selected live checks passed, exit 1 means a failed scenario, exit 2 means invalid CLI input,
and exit 78 means a real deployment prerequisite was missing. Listing deterministic coverage
does not execute those tests; run `bun test` separately.

The strict smoke uses explicit disposable authorization envelopes. It does not authorize running
an arbitrary objective against a user's project, expand a production run's budget or prove
exactly-once remote effects. See [the autonomy reference](../docs/autonomy.md) for those limits.

## Release demos

`tools/release-demos.ts` records one real session per public tool and renders it into a terminal GIF.
It is not a test: it starts `omp` with `-e <checkout>/src/index.ts`, the installed
`deepseek/deepseek-flash` entry (displayed as DeepSeek V4.1 Flash), `--no-extensions`,
`--no-context-files`, `--no-rules`, `--no-skills`, `--no-lsp`, `--no-title` and `--auto-approve`,
inside a disposable `/tmp` workspace with an isolated `PI_CODING_AGENT_DIR`. The model key comes from
`omp token` and is never printed. Tool calls the agent makes through `write xd://…` are shown under
their effective names; unrelated real calls stay visible in the evidence instead of being hidden.

```sh
# List the scenarios and the exact installed model entry.
bun tools/release-demos.ts list
bun tools/release-demos.ts model

# One session, saving the sanitized evidence next to the demo.
bun tools/release-demos.ts run <tool> --save demos/tools/<tool>/evidence

# Write demo.tape, render demo.gif with vhs and extract three frames.
bun tools/release-demos.ts record [<tool> ...]
```

Each `demos/tools/<tool>/` directory holds the GIF, the tape that produced it and, under `evidence/`,
the prompt, the model identity, the raw NDJSON event stream and the recorded outcome. The stream
keeps settled events (messages, turns, tool calls and results) and omits streaming deltas, which only
repeat the final message. A GIF that shows a saved run is a replay of that run and says so; a failed
or inconclusive verdict stays in the recording rather than being cut. Recordings over a minute skip
idle waits (identical terminal frames) so the GIF stays watchable; the evidence stream keeps the real
timeline.

`jev_reaim` needs two owner messages in one process, because the second is only a change of direction
relative to the first. Its scenario therefore drives OMP's RPC mode: the first message is sent as a
`prompt`, later ones as `steer`, and the driver waits for each real `agent_start`/`agent_end` pair
before sending the next message. A turn that never completes fails the demo with a named reason
instead of silently continuing. All twelve scenarios have a recording.

The recordings depend on the local `vhs`, `ttyd` and `ffmpeg` installations. A missing dependency
fails the render instead of producing a placeholder.

## Ordinary workflow comparison and native cards — 2026-11-18

`bun tools/workflow-comparison.ts --arm both --baseline <frozen-baseline> --candidate
<candidate-checkout> --out <results>` runs two prompts twice per arm. It checks files and behavior
independently of the model or Jev verdict. Use `--summarize <results>` to rebuild the aggregate.
The recorded run used DeepSeek Flash, low thinking and a 300-second cap. It reported 24/24
requirements and 4/4 deliveries in each arm, with 45 versus 4 explicit Jev calls and means of
77.6 versus 13.6 seconds. Two revised runs made no Jev calls; both revised outcome verdicts were
inconclusive. The small, sequential-arm sample does not establish a quality gain.
Evidence: `evidence/workflow-comparison/final-20261118T075334Z/run/summary.json`.

The native terminal trace at `/tmp/jev-native-card-final-dNWfN0` shows the mounted plan-review
prerequisite as `Not checked`, the context lookup as `Complete`, and the full tool text after
expansion. The deterministic outage smoke passed (`/tmp/jev-live-smoke-ncYoOt`).

## Historical live records

The entries below are preserved as recorded history. They describe earlier contracts - automatic
release, a blocking refusal hold, repair permits, owner continuation and the older read-only
classifier - and none of them validates current diagnostic behavior. Paths under `/tmp` may no longer
exist. The observed counts are those recorded at the time, not current-suite or release claims.

| Record | Scope | Evidence |
| --- | --- | --- |
| Legacy-test audit (2026-11-14) | Production judge reviewed 558 existing runtime cases; two duplicate disabled-gate assertions were deleted after supported decisions. The resulting suite and typecheck were reported clean then. | `/tmp/jev-test-audit-2026-11-14.json`, `/tmp/jev-test-audit-evidence-2026-11-14.json` |
| Two-phase recovery contract (superseded) | A live OMP/DeepSeek probe recorded a forbidden write refused at 1.00 and one exact replacement authorized at 0.83. The repair-permit feature is now obsolete; the run is not evidence for the diagnostic contract. | `/tmp/jev-recovery-probe/run-2026-11-13T11-33-47-418Z-4ee9fa` |
| Below-floor recovery (superseded) | A live probe's finding resolution scored 0.79 below the then-0.8 floor and the hold remained. The recovery scenario is removed. | `/tmp/jev-mvp-host-Nl0C5J/summary.json` |
| Native session-mode RPC (historical) | `/jev off` and `/jev on` completed without starting a model turn under the earlier session-control contract. | `/tmp/jev-mode-rpc-9Hz2n1` |
| Native read admission (historical) | A real OMP/DeepSeek run read `https://example.org/` for `саммари` and executed exact inspection commands; `/jev-status` reported zero judge requests. | `/tmp/jev-read-host-EMy3zV` |
| Legacy workflow attempts | Earlier direct/host workflow and Factorio runs under blocking-gate contracts. Their refusals and approvals used the old machinery. | `/tmp/jev-live-smoke-JcOdrU`, `/tmp/jev-live-smoke-otwn6s`, `/tmp/jev-live-smoke-IJQaxA`, `/tmp/jev-live-smoke-xcQzEt` |

## Removed harnesses

`tools/measurement/` and `tools/reviews/` were deleted: they imported `src/guards`, `src/client` and
`src/reviews`, which no longer exist. Their live job - confirm the current controller with the real
judge and the real host - is now this smoke. The repair/recovery scenario machinery was removed with
the recovery contract; `direct --scenario diagnostics` replaces it with continuation and diagnostic
truth checks.
