# Live Jevstice smoke

`live-smoke.ts` is the one live-verification entry that replaced the old measurement and review
harnesses. It uses the production judge (`createTypeSafeJudge`) and the real activity/controller
paths; a refusal is recorded and reported, never treated as a pass.

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

## Removed harnesses

`tools/measurement/` and `tools/reviews/` were deleted: they imported `src/guards`, `src/client` and
`src/reviews`, which no longer exist. They measured an older product and could not run. Their live
job - confirm the current workflow with the real judge and the real host - is now this smoke.
