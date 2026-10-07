<p align="center">
  <img src="docs/banner.webp" alt="jevstice" width="100%">
</p>

# jevstice

Jev (`jev-latest`) as a decision judge for [oh-my-pi](https://github.com/can1357/oh-my-pi):
the executor validates every important step through fixed-option questions instead of guessing.

## Install

```sh
git clone https://github.com/veschin/jevstice ~/.omp/agent/extensions/jevstice
```

Dependencies install automatically on first run (bun). Requires a Jev API key
(`TYPESAFE_API_KEY` env or `pass show token/jev`).

## Usage

```sh
cd <your-project>
TYPESAFE_API_KEY="$(pass show token/jev)" omp -p "<task; the agent calls the jev_decision tool>" --model <model>

TYPESAFE_API_KEY="$(pass show token/jev)" bun ~/.omp/agent/extensions/jevstice/src/cli.ts probe
TYPESAFE_API_KEY="$(pass show token/jev)" bun ~/.omp/agent/extensions/jevstice/src/cli.ts request.json
```

## Gates

- **plan** (`understanding_review` / `direction_review`): file mutations blocked until the
  judge approves a plan backed by verbatim quoted evidence. Reads stay free.
- **completion** (`completion_review`): execution/code/log evidence required; a report alone
  never approves. Confidence in [0.6, 0.8) requires 2 consecutive approves; below 0.6 never counts.
- **course_check**: per-requirement drift check plus a next action from a fixed set
  (`continue`, `return_to_requirement`, `replan`, `ask_user`, `verify_before_proceeding`).
- **aspect_coverage**: claimed aspects three-way marked against a topic catalog;
  missed aspects block completion until addressed.

Fail-closed: judge errors, malformed answers, meta-option escapes (`ALL_OPTIONS_WRONG`,
`PARTIALLY_RIGHT_NONE_FULL`, `NO_FIT_OTHER_REASON`) and low confidence never approve.
Rework bounded at 3 iterations per stage, then `ask_user`. Approvals bind to a task
fingerprint, content digest and work revision.

## Config

`<cwd>/.omp/jev.config.json` (project), then `~/.omp/agent/jev.config.json` (user):

```json
{
  "confidenceThreshold": 0.9,
  "completion": { "consecutiveApproves": 3, "confidenceFloor": 0.7 },
  "stages": {
    "direction_review": {
      "instructions": "appended after the built-in untrusted-evidence policy",
      "options": [ { "id": "proceed", "label": "Proceed", "meaning": "continue" } ]
    }
  },
  "controlPoints": { "my_checkpoint": { "trigger": "on_demand", "instructions": "..." } }
}
```

Thresholds and counts are raise-only. Meta options cannot be removed. Invalid config
refuses to load, naming the file and the problem.

## Limits

- Mutation gate covers builtin tools only; custom/MCP tools are outside it.
- Subagent gates are per-session; the parent does not see subagent tool calls.
- Provider prompt-cache hits are not measured.
- Completion judging does not guarantee correctness.

## License

[MIT](LICENSE)
