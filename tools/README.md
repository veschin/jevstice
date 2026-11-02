# Live Jevstice smoke

`live-smoke.ts` verifies the ordinary workflow through the package's only manifest entry,
`src/index.ts`. `autonomy-smoke.ts` verifies the optional strict module, which the manifest never
loads: its only activation path is the separate CLI (`bun run autonomy`, i.e. `autonomy/driver.ts`),
which launches the child with `autonomy/index.ts` as its extension entry.
Both use the production judge and real OMP where indicated. A refusal or a missing prerequisite
is recorded rather than treated as a pass.

Two live modes, plus an offline validator:

| Mode | What it proves |
| --- | --- |
| `direct` | The controller, its gates, the activities and the production judge complete the workflow in one process. Every judge question and typed answer is recorded. |
| `host` | The real `omp` CLI loads `src/index.ts` with `-e`, the model exercises the registered `jev_*` tools, and the gate blocks the first project write before triage. Validation reads typed `details` (`needsDevelopment`, `approved`, `planDigest`) rather than English reply text. |

Every consequential call that clears the deterministic gates is judged by the action preflight on its
complete JSON payload before execution. The direct smoke therefore submits the full write content in
both the `tool_call` and `tool_result` events, never a path alone, so the preflight sees what would
actually be written.

In host mode omp routes an extension tool through `write xd://jev_*`; the logical call arrives under
`result.details.xdev` as `{tool, args, inner}`. Host validation normalizes that wrapper before
checking, so `jev_triage`, `jev_plan_review` and `jev_acceptance` are verified from their typed
`inner` details. Acceptance requires the last submission for each aspect to be approved, with both
aspects recorded at the same work revision; an earlier refusal followed by evidenced correction is
the intended workflow.

The smoke never prints, logs or persists the TypeSafe key. The extension reads it from
`TYPESAFE_API_KEY` (`JEVI_API_KEY`, or `TYPESAFE_API_KEY_COMMAND`; see `src/apikey.ts`), and the
script only records judge questions, answers, tool outcomes and the plan artifact.

## Commands

```bash
# The key is read from the environment by the extension; it is never an argument and is never logged.
env TYPESAFE_API_KEY_COMMAND='pass show token/jev' bun tools/live-smoke.ts direct --scenario workflow

# Direct scenario: triage -> requirements -> outline -> one detail per step -> finalize ->
# implementation -> both acceptance aspects -> completion. Needs the judge key.
bun tools/live-smoke.ts direct --scenario workflow

# Planning only, exact request "Напиши Factorio в этом каталоге.": triage -> requirements ->
# outline -> one detail per step -> finalize -> end the planning probe. The proposal is a
# browser-playable 2D factory game (grid/camera/build controls, mining, belts, inserters,
# smelting/assembly recipes, inventory, electricity, research/end goal, save/load). Every product
# section carries its own browser-observed check; the research section also carries an end-to-end
# journey check. The approved plan is the deliverable; no game file is written, no acceptance or
# completion is claimed.
bun tools/live-smoke.ts direct --scenario factorio

# Actual omp host launch with the extension loaded. Needs omp, a model and the judge key.
bun tools/live-smoke.ts host --scenario workflow
bun tools/live-smoke.ts host --scenario factorio

# Optional: keep evidence in a known directory, pick the host model and its deadline.
bun tools/live-smoke.ts host --scenario workflow --out /tmp/jev-host --model deepseek/deepseek-flash --max-time 900

# Revalidate a saved host run offline: no model, judge or network call.
bun tools/live-smoke.ts verify-existing --out /tmp/jev-host --scenario workflow
bun -e 'import { verifyExistingHostRun } from "./tools/live-smoke.ts"; console.log(verifyExistingHostRun("/tmp/jev-host", "workflow"))'
```

The host mode passes `--max-time` to omp and also kills the subprocess at `--max-time + 60s`, so a
hung provider or tool loop cannot run unattended. Exit code 0 means every checked stage passed. A refusal, a missing `jev_*` call, a missing gate
block, a failed command or a completion hold exits with code 1 and is listed in `summary.json`.
Do not retry the same submission for luck: at most three materially different approaches per
refused decision, then report the wall with its evidence.

## Live attempts journal

The live loop keeps the path and the verbatim score for every attempt; an attempt that repeats the
same proposal without changing the approach does not count.

| Attempt | Scenario | Evidence | Verbatim result |
| --- | --- | --- | --- |
| direct workflow | workflow | `/tmp/jev-live-smoke-JcOdrU` | PASSED |
| host workflow | workflow | `/tmp/jev-live-smoke-otwn6s` | PASSED after xdev normalization: triage needsDevelopment `true` at `0.99`; requirements approved at `0.95`; final plan `serves` at `0.95`; business first refused at revision 3, then approved at `0.98`; architecture approved at `0.95`, both at revision 4. The earlier refusal followed by observed checks is the intended path, not a failure. |
| factorio attempt 1 | factorio | `/tmp/jev-live-smoke-CSEgkD` | Refused only on requirement 8, automated browser checks, at `0.73`; product requirements 1-7 scored `0.85-0.97`; coverage `0.93`. |
| factorio attempt 2 | factorio (direct) | `/tmp/jev-live-smoke-pRaYzU` | PASS |
| factorio host | factorio (host) | `/tmp/jev-live-smoke-0NDYTX` | PASS: requirements `0.87`, outline `0.93`, seven detail choices `ready` at confidence `0.96-1.00`, final plan `0.91`; no game implementation claimed. |
| ordinary consultation-budget repair | workflow | `/tmp/jev-live-smoke-zYZwyh` | PASS in a fresh real OMP process with the production judge; exit 0, 4542 events, no validation problems. The changed held-finding path was exercised separately in a fresh Bun process with a deterministic injected judge: `/tmp/jev-consult-boundary-QxUbwo/summary.json` records four distinct decisions for each of Choice, Score and Boolean, all reaching the judge without clearing the finding, permitting continuation or releasing mutations. The two permanent regressions failed before the fix; the integrated suite then passed 486 tests / 2170 expectations / 16 files, and strict unused-code typechecking passed. |

## Evidence

Each run creates a fresh temporary evidence directory and prints it on the last line. `--out`
puts it elsewhere. Files:

| File | Contents |
| --- | --- |
| `summary.json` | mode, scenario, pass/fail, judge-call count, failures, evidence path |
| `judge.jsonl` (`direct`) | every submitted question set, its material and the typed outcome |
| `transcript.jsonl` (`direct`) | gate decisions, tool calls and outcomes, course checks, stages |
| `artifacts/<plan>.md` | the exact plan artifact the judge approved |
| `workspace/` (`direct` workflow) | the files actually written and the real `bun test` output |
| `omp-events.jsonl` / `omp-stderr.txt` (`host`) | raw print-mode events and stderr |
| `prompt.txt` (`host`) | the exact autonomous prompt |

## Armed configuration fixture

`armed.jev.config.json` is the current shape: both gates on and an interval course check after
every consequential action. Copy it to the project being exercised:

```bash
mkdir -p .omp && cp tools/armed.jev.config.json .omp/jev.config.json
```

The shipped defaults in `src/config.ts` are `completion` mode with interval 3 and `antiSlop.mode`
`advisory`; the fixture is for a live run where every action is checked. Old keys (`routing`,
`handoffAcceptance`, `everyMutations`) are ignored if present in an older file; only
`gates.mutation`, `gates.completion`, `courseCheck.mode`, `courseCheck.interval` and
`antiSlop.mode` are read. `antiSlop.mode` accepts `off`, `advisory` and `enforce`. The live smoke
does not yet exercise the anti-slop review; `tests/anti-slop.test.ts` covers it.

## Strict autonomy smoke

Strict scenarios need the same judge credentials and authenticated OMP model, plus Linux `/proc`,
cgroup v2 and a working systemd user manager. Those prerequisites belong to the optional module
alone; an ordinary host run needs none of them and never imports `autonomy/`. The scenarios start
disposable supervised projects outside this checkout, exercise actual native tool results and
operator commands, and retain their evidence.
The harness cleans up owned child scopes and refuses an evidence directory inside the checkout.

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

## Removed harnesses

`tools/measurement/` and `tools/reviews/` were deleted: they imported `src/guards`, `src/client` and
`src/reviews`, which no longer exist. They measured an older product and could not run. Their live
job - confirm the current workflow with the real judge and the real host - is now this smoke.
