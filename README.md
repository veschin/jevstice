# jevstice - Jev as architect over any omp executor

*justice + Jev - jevstice for all.*

jevstice wires the TypeSafe decision model **Jev** (`jev-latest` = jev-1.13.0) into [oh-my-pi](https://github.com/can1357/oh-my-pi) as a universal decision-point engine: the executor answers THROUGH the judge instead of guessing - *am I working correctly, have I drifted from the requirements, what do I do next, is this done?* Jev answers only Noul/Choice/Score questions over fixed option sets; it never writes prose, and it can always escape a badly-framed question via mandatory meta-options (`ALL_OPTIONS_WRONG`, `PARTIALLY_RIGHT_NONE_FULL`, `NO_FIT_OTHER_REASON`).

Status, observed coverage, and honest limits: see `PLAN.md`, `ACCEPTANCE.md`, and `evidence/`.

## Quickstart

```sh
# one-shot launch (no global install):
cd <your-project>
TYPESAFE_API_KEY="$(pass show token/jev)" omp \
  -e /path/to/jevstice/src/index.ts \
  -p "<your task; the agent must call the jev_decision tool>" \
  --model <your-model>

# CLI:
TYPESAFE_API_KEY="$(pass show token/jev)" bun src/cli.ts probe          # reachability check
TYPESAFE_API_KEY="$(pass show token/jev)" bun src/cli.ts request.json   # DecisionRequest -> verdict
```

Project-dir install (`.omp/extensions/`) or user-global `~/.omp/agent/extensions/` also work via omp's native discovery - those are user actions, not done by this repo.

## Gates (the presets)

- **plan** (`understanding_review` / `direction_review`): file-mutating calls are blocked until the judge approves a plan backed by verbatim quoted evidence. Reads stay free.
- **completion** (`completion_review`): "done" requires execution/code/log evidence - a report alone never approves. Confidence in [0.6, 0.8) needs **2 consecutive approves** (calibration-tolerant); below 0.6 never counts.
- **course_check**: per-requirement drift Noul + a next-action from a fixed set (`continue`, `return_to_requirement`, `replan`, `ask_user`, `verify_before_proceeding`).
- **aspect_coverage**: forgotten-aspect detection - claimed aspects are three-way marked against a topic catalog (`applicable_and_addressed` / `applicable_not_addressed` / `not_applicable`); missed aspects block completion until addressed.

Everything is fail-closed: judge errors, malformed answers, meta-option escapes and low confidence can **never** approve. Rework is bounded (3 iterations per stage, then an explicit `ask_user` - no fake success). Approvals bind to a task fingerprint + content digest + work revision, so stale approvals can't be replayed.

## Configuration

Optional JSON overrides, searched at `<cwd>/.omp/jev.config.json` (project) then `~/.omp/agent/jev.config.json` (user):

```json
{
  "confidenceThreshold": 0.9,
  "completion": { "consecutiveApproves": 3, "confidenceFloor": 0.7 },
  "stages": {
    "direction_review": {
      "instructions": "extra review focus (appended after the built-in untrusted-evidence policy)",
      "options": [ { "id": "proceed", "label": "Proceed", "meaning": "continue" } ]
    }
  },
  "controlPoints": { "my_checkpoint": { "trigger": "on_demand", "instructions": "..." } }
}
```

Thresholds and counts are raise-only. Service/meta options cannot be removed. Invalid config -> the extension refuses to register the tool, naming the file and the problem - never a silent fallback. Config files are trusted input from the person running omp; a project file shapes prompts but cannot weaken the approval floor.

## Known limits

- The mutation gate covers builtin mutating tools only; custom/MCP tools are outside it.
- Subagent sessions enforce their own gates (per-session state); the parent does not see subagent tool calls.
- Provider prompt-cache hits are not claimed or measured.
- Completion judging reduces, but does not eliminate, wrong-approval risk.

## License

[MIT](LICENSE)
