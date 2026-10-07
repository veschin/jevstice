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

Dependencies install automatically on first run (bun). Requires a Jev API key: `TYPESAFE_API_KEY` env, or `TYPESAFE_API_KEY_COMMAND` with a
resolver such as `pass show token/jev` (the extension and the CLI use the same resolution).

## Usage

```sh
cd <your-project>
TYPESAFE_API_KEY="$(pass show token/jev)" omp -p "<task; the agent calls the jev_decision tool>" --model <model>

TYPESAFE_API_KEY="$(pass show token/jev)" bun ~/.omp/agent/extensions/jevstice/src/cli.ts probe
TYPESAFE_API_KEY="$(pass show token/jev)" bun ~/.omp/agent/extensions/jevstice/src/cli.ts request.json
```

All submissions to the judge are written in English: the executor's own text (task, proposal,
option labels and meanings) is English, while quoted evidence keeps its source wording verbatim.

## Routing

Skill and model routing read the candidate lists the owner holds:

```json
{
  "routing": {
    "skills": [ { "id": "harden-plan", "label": "harden-plan", "meaning": "harden a plan with a curated checklist" } ],
    "models": [ { "id": "deepseek/deepseek-flash", "label": "fast", "meaning": "cheap, for mechanical work" } ],
    "allowlist": ["deepseek/deepseek-flash"]
  }
}
```

The judge chooses only from those candidates, so it can never invent a skill or a model. Submit the
`skill_routing` or `model_routing` stage to get a choice; an approved skill is recorded, and an
approved model is enforced at the next subagent spawn. `allowlist` defaults to the model candidate
list. Without candidates the stage refuses explicitly - no candidates, no routing.

## Catalog checks

At the start of a new task the extension classifies it (development / analytics / query) and marks
the applicable plan topics through the judge against the bundled catalog. Both results are recorded
in session state and delivered as same-session feedback. The checks are advisory and non-blocking:
the task starts immediately, and an abstention, a judge failure or an unwired catalog records
uncertainty instead of stopping the work.

## Gates

- **plan** (`understanding_review` / `direction_review`): file mutations blocked until the
  judge approves a plan backed by verbatim quoted evidence. Reads stay free. Submit the plan as a
  claim checked against the quotes (`state what it asserts, which quote supports it`): the judge
  verifies claims against quoted sources and does not score an open plan summary. Set
  `gates.mutation: false` to lift this gate entirely.
- **completion** (`completion_review`): execution/code/log evidence required; a report alone
  never approves. Confidence in [0.6, 0.8) requires 2 consecutive approves; below 0.6 never counts.
  Every task - read-only included - needs plan approval, a fresh course_check and completion
  evidence before the session may stop.
- **course_check**: per-requirement drift check plus a next action from a fixed set
  (`continue`, `return_to_requirement`, `replan`, `ask_user`, `verify_before_proceeding`).
  Run it at the task/plan boundary, after each work mutation and before claiming completion;
  only a judged `continue` satisfies the completion gate. Benign outcomes never consume the
  rework bound; redirects and failed consultations do.
- **aspect_coverage**: claimed aspects three-way marked by the judge against a topic catalog;
  missed aspects block completion until addressed. Completion capability coverage uses the same
  judge with `requireAll`, so a capability counts only when the judge marks it addressed from
  artifact evidence - mentioning its name is not enough.

Fail-closed: judge errors, malformed answers, meta-option escapes (`ALL_OPTIONS_WRONG`,
`PARTIALLY_RIGHT_NONE_FULL`, `NO_FIT_OTHER_REASON`) and low confidence never approve.
Rework bounded at 3 iterations per stage, then `ask_user`. Approvals bind to a task
fingerprint, content digest and work revision.

## Config

`<cwd>/.omp/jev.config.json` (project), then `~/.omp/agent/jev.config.json` (user):

```json
{
  "gates": { "mutation": false },
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

Thresholds and counts are raise-only. Meta options cannot be removed. Invalid or unreadable
config keeps the gates registered and closed, naming the file and the problem.

`gates.mutation: false` is user-owned and lifts the plan gate: mutating tools are no longer
blocked while no plan-stage approval exists. `gates.completion: false` lifts the stop gate
(completion approval, the fresh course_check and the aspect teeth). Both default to on; judging,
content digests and bounded rework are unchanged by either.

## Limits

- Mutation gate covers builtin tools only, including `eval`; custom/MCP/xdev tools are outside it.
- Subagent gates are per-session; the parent does not see subagent tool calls.
- Provider prompt-cache hits are not measured.
- Completion judging does not guarantee correctness.

## License

[MIT](LICENSE)
