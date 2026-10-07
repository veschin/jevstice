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

Requires Bun >= 1.1 (`package.json` `engines`). The extension declares one runtime dependency,
`@typesafe-ai/sdk`; a fresh clone has no `node_modules`, and Bun's auto-install resolves it on first
run (run `bun install` in the clone to do it explicitly).

Requires a Jev API key: `TYPESAFE_API_KEY` env (`JEVI_API_KEY` is also read), or
`TYPESAFE_API_KEY_COMMAND` with a resolver such as `pass show token/jev` (the extension and the CLI
use the same resolution, env first). `TYPESAFE_API_URL` overrides the endpoint. Without a key the
extension still loads and read-only work stays possible, but every decision submission fails closed
(`judged:false`, never approve).

## Usage

```sh
cd <your-project>
TYPESAFE_API_KEY="$(pass show token/jev)" omp -p "<task; the agent calls the jev_decision tool>" --model <model>

TYPESAFE_API_KEY="$(pass show token/jev)" bun ~/.omp/agent/extensions/jevstice/src/cli.ts probe
TYPESAFE_API_KEY="$(pass show token/jev)" bun ~/.omp/agent/extensions/jevstice/src/cli.ts request.json
```

The CLI takes a request file, an inline `{...json...}` argument, or stdin (`-`, or no argument when
stdin is piped). It exits `0` when the judge answered (any verdict), `2` for usage or invalid input,
`4` for config/transport/auth failure. `probe` sends one synthetic classification call (no project
data) and prints `{ ok, verdict, latencyMs }` so judge reachability is checkable on its own.

All submissions to the judge are written in English: the executor's own text (task, proposal,
option labels and meanings) is English, while quoted evidence keeps its source wording verbatim.

## Consultation protocol

The judge's answer quality is decided by how the request is framed (measured live), so the product
forces the working shape instead of advising it:

- **One decision per request.** Write a claim and ask whether the quoted evidence supports it.
  An open request to approve a summary is answered `insufficient_evidence` (measured 0.14-0.26
  against 0.79-0.96 for the same material phrased as a claim).
- **3-6 short, non-duplicate quotes**, and on plan stages at least one requirement quote
  (`kind: "user"` or `"spec"`) that appears verbatim inside the proposal - that is what makes the
  plan a claim checked against evidence rather than a wish.
- **2-4 real alternatives** whose `meaning` states what choosing them commits the executor to.
  Options that only restate each other waste the decision.
- **Ungrounded proposals are refused before the judge is called** (plan stages): no consultation,
  no rework consumed, and the message names the fix.
- **An abstention is not a verdict.** `insufficient_evidence` means the evidence is insufficient -
  the fix is better evidence, not the same request again. A judge-chosen service option
  (`ALL_OPTIONS_WRONG`, `PARTIALLY_RIGHT_NONE_FULL`, `NO_FIT_OTHER_REASON`) means the offered option
  set was wrong; the reason carries what to change before re-submitting.
- **The strongest form is parallel per-claim questions** in one request: the `claim_check` stage
  (see below). Revised submissions get a fresh rework budget; identical repeats do not.

## Claim check

`stage=claim_check` puts several claims in one request and returns one verdict per claim, judged
only from the quoted evidence (`supported` / not supported, the Noul boundary is 0.5):

```json
{
  "stage": "claim_check",
  "task": "Decide how to wire the per-claim judge",
  "proposal": "the claims of the wiring decision, checked against the measured regimes",
  "options": [
    { "id": "not_judged", "label": "Placeholder (required by the tool schema)",
      "meaning": "claim_check judges the claims, not this option set" }
  ],
  "claims": [
    "the multi-label path already judges items in one request",
    "the wiring decision needs four separate consultations"
  ],
  "evidence": [
    { "kind": "execution", "source": "evidence/consultation-forcing.md",
      "quote": "Parallel per-claim questions in ONE request (multi-label/Noul) | per-claim yes/no, decisive" }
  ]
}
```

2+ claims are required (a single claim is a plain decision stage). The per-claim verdicts land in
the submission summary and in session state (`lastClaimCheck`); unsupported claims come back as
`revise` with the claims named, and an unmarkable claim fails closed as `insufficient_evidence`
naming that claim. The stage is advisory like the other `on_demand` presets - it never records a
gate approval and never unlocks anything. `options` and `proposal` stay required fields of the tool
schema, but the claim judge reads only `task`, `claims` and `evidence`.

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
list; a model outside it is excluded before the judge sees it. Without candidates the stage refuses
explicitly - no candidates, no routing.

## Catalog checks

At the start of a new task the extension classifies it (development / analytics / query) and marks
the applicable plan topics through the judge against the bundled catalog. Both results are recorded
in session state and delivered as same-session feedback. The checks are advisory and non-blocking:
the task starts immediately, and an abstention, a judge failure or an unwired catalog records
uncertainty instead of stopping the work.

## Gates

- **plan** (`understanding_review` / `direction_review`, trigger `mutation_gate`): mutating tool
  calls are blocked until the judge approves a plan for the current task. Reads stay free. Submit the
  plan as a claim checked against verbatim quoted evidence (`state what it asserts, which quote
  supports it`): the judge verifies claims against quoted sources and does not score an open plan
  summary. A plan-stage submission is refused before the judge is called, consuming no rework and
  naming the fix, when its proposal quotes no submitted evidence verbatim (at least one quote of 20+
  characters), when it carries no `user`/`spec` evidence, or when it accumulates any two quality
  problems (a repeated quote, a quote shorter than 20 characters). A single quality problem is judged
  with a warning. Set `gates.mutation: false` to lift this gate entirely.
- **completion** (`completion_review`, trigger `session_stop`): execution/code/log evidence required;
  a report alone never approves. Every task - read-only included - needs a plan-stage approval, a
  fresh `course_check` with `continue` and a completion approval for the current task fingerprint
  and work revision before the session may stop. Set `gates.completion: false` to lift the stop gate
  (completion approval, the fresh course_check and the aspect teeth); `gates.mutation: false` also
  drops the plan requirement from it.
- **course_check** (`on_demand`): per-requirement drift check plus a next action from a fixed set
  (`continue`, `return_to_requirement`, `replan`, `ask_user`, `verify_before_proceeding`; the three
  meta options are always appended). Run it at the task/plan boundary, after each work mutation and
  before claiming completion; only a judged `continue` recorded for the current task and work
  revision satisfies the completion gate (`verify_before_proceeding` never unlocks). Benign outcomes
  (`continue`, `verify_before_proceeding`) consume no rework; redirects, `ask_user` and failed
  consultations do.
- **aspect_coverage** (`on_demand`): claimed aspects (catalog topic ids) are three-way marked by the
  judge against the topic catalog; `applicable_not_addressed` blocks completion until a later
  submission clears it. Completion capability coverage uses the same judge with `requireAll`, so a
  capability counts only when the judge marks it addressed from artifact evidence - mentioning its
  name is not enough.
- **claim_check** (`on_demand`): several claims judged in one request, one verdict per claim (see
  Claim check above). Advisory: it records per-claim markings in the session state and nothing else -
  no gate approval, no block.
- **subagent_handoff** (FR-11, `on_demand`, opt-in): when the config declares
  `stages.subagent_handoff`, the controller judges each hand-off to a task agent twice - the work
  order before the spawn (`before_subagent_spawn`) and the returned result after it (`tool_result`) -
  against the requirement captured at task start. Only a judged `revise` at or above the confidence
  floor refuses a spawn; an abstention, judge error, low confidence, frame escape, missing or
  unattributable work order records the uncertainty and lets the work proceed. The acceptance side
  cannot refuse a tool result (that host hook only rewrites it), so a confident negative is recorded
  as an unresolved blocker and fed back into the session. Undeclared, the stage is still submittable
  through the tool but no hand-off check runs - the PRD marks this policy unconfirmed (GAP:3).

Confidence floors: an approve is recorded only at or above `confidenceThreshold` (default 0.8). At
that default bar a completion approve in [0.6, 0.8) counts toward
`completion.consecutiveApproves` (default 2) and a completed streak becomes the approval; below 0.6
never counts. Raising `confidenceThreshold` disables the streak (single strict bar).

Fail-closed: judge errors, malformed answers, meta-option escapes (`ALL_OPTIONS_WRONG`,
`PARTIALLY_RIGHT_NONE_FULL`, `NO_FIT_OTHER_REASON`) and low confidence never approve. A
meta-option escape says the offered option set was wrong, and the returned reason carries the fix
(replace or restate the options, or reframe the claim) so the next attempt changes the frame instead
of repeating it. Rework is bounded per stage: an identical resubmission is refused after 3 attempts
and escalates to `ask_user`, while a changed submission (different task, proposal or evidence) starts
a fresh budget, so honest iteration cannot deadlock a stage. Approvals bind to a task fingerprint,
the content digest of the exact submission and the work revision; a new task or later work
invalidates them.

## Stages

These are the built-in presets of `CONTROL_POINT_REGISTRY` (`src/control-points.ts`); each is a
submittable `stage` and is shaped by the config key shown:

| Stage | Trigger | What it does | Config key |
| --- | --- | --- | --- |
| `understanding_review` | `mutation_gate` | plan approval; mutations stay blocked until it holds | `stages.understanding_review` |
| `direction_review` | `mutation_gate` | alternative plan approval for the same block | `stages.direction_review` |
| `completion_review` | `session_stop` | completion review; demands execution/code/log evidence | `stages.completion_review` |
| `course_check` | `on_demand` | per-requirement drift + fixed next-action choice | `stages.course_check` |
| `aspect_coverage` | `on_demand` | three-way aspect marking against the catalog topics | `stages.aspect_coverage` |
| `claim_check` | `on_demand` | per-claim support marking against the quoted evidence (one request) | `stages.claim_check` |
| `skill_routing` | `on_demand` | skill choice from `routing.skills` | `stages.skill_routing` |
| `model_routing` | `on_demand` | model choice from `routing.models` | `stages.model_routing` |
| `subagent_handoff` | `on_demand` | FR-11 hand-off check at the task-tool boundary (opt-in) | `stages.subagent_handoff` |
| `important_decision` | `on_demand` | FR-10: an important decision put to the judge through fixed options | `stages.important_decision` |
| `code_review` | `on_demand` | FR-10: a finished code review put to the judge | `stages.code_review` |

`stages.<stage>` takes `instructions` (appended after the built-in untrusted-evidence policy) and
`options` (a full replacement option set: at least 2 items with unique ids, each `{id, label,
meaning}`). Only registry stages are valid keys - an unknown stage key is a config error.
`course_check` keeps its fixed next-action ids unless a template replaces its options.

A config can also declare extra control points: `controlPoints.<name>` with
`{ "trigger": "on_demand", "instructions"?, "options"? }`. The name must match
`^[a-z][a-z0-9_]{2,63}$` and must not collide with a built-in preset; a declared point is judged
like any other stage but never blocks a tool call and records no gate approval - its verdict is
recorded and fed back, while rework is still counted (`mutation_gate` / `session_stop` triggers for
custom stages are a roadmap item).

Two further judge consultations run automatically at task start and are not submittable stages:
task classification (`development` / `analytics` / `query`) and plan-topic selection - the catalog
checks above.

## Config

Two files, merged per key: `<cwd>/.omp/jev.config.json` (project) and
`~/.omp/agent/jev.config.json` (user). Missing files are the normal defaults case; a present but
invalid or unreadable file is a fail-closed error that keeps the gates registered and closed, naming
the file and the problem.

```json
{
  "gates": { "mutation": false },
  "confidenceThreshold": 0.9,
  "completion": { "consecutiveApproves": 3, "confidenceFloor": 0.7 },
  "capabilities": ["json-round-trip", "cli-probe"],
  "stages": {
    "direction_review": {
      "instructions": "appended after the built-in untrusted-evidence policy",
      "options": [
        { "id": "proceed", "label": "Proceed", "meaning": "continue" },
        { "id": "revise", "label": "Revise", "meaning": "send the plan back" }
      ]
    }
  },
  "controlPoints": { "my_checkpoint": { "trigger": "on_demand", "instructions": "..." } }
}
```

Per key, with its trust rule:

- `stages` - stage instructions and option sets (see Stages above). Merged stage by stage; the
  project entry wins for a stage both files declare.
- `controlPoints` - declarative on-demand stages. Merged name by name; the project entry wins.
- `capabilities` - default capability inventory for completion coverage. The effective set is the
  union of this list and the submission's own `capabilities`, so a caller cannot narrow it. The
  project list wins over the user list.
- `routing` - owner-held candidate lists (`skills`, `models`, optional `allowlist`). User-owned: the
  user file wins when it sets the key, so a project value applies only while the user file is silent.
- `completion` - `consecutiveApproves` (integer >= 1) and `confidenceFloor` (0..1). Raise-only: the
  effective values are `max(policy default, configured)`, and a floor above the strict bar is
  rejected at load as inert. Merged per key; the project value wins for keys the user file omits.
- `confidenceThreshold` - the approval floor. User-owned and raise-only: the user value wins over a
  project one, and the effective floor is `max(0.8, configured)`, so lowering it has no effect.
  Raising it also disables the mid-band completion streak.
- `gates` - `mutation` and `completion` booleans, both default true. User-owned: when the user file
  declares `gates`, the project block is ignored. `gates.mutation: false` lifts the plan gate
  (mutating tools are no longer blocked while no plan-stage approval exists) and
  `gates.completion: false` lifts the stop gate. Both switch block decisions only: judging, content
  digests and bounded rework are unchanged. The FR-11 hand-off gate is not a `gates` switch: it runs
  only when the config declares `stages.subagent_handoff` (see the preset above).

Meta options cannot be removed: they are appended to every judge choice regardless of any template.

## Limits

- The mutation gate covers the builtin tools `edit`, `write`, `ast_edit`, `bash`, `memory_edit`,
  `manage_skill` and `eval`; custom/MCP/xdev tools are outside it.
- Gates are per session: each subagent session gets its own controller (own gates, approvals and
  state), and the parent's controller does not see the subagent's tool calls - the one cross-session
  hook is `before_subagent_spawn`, where the routed model is enforced. `session_stop` never fires for
  task/subagent sessions, so the completion gate applies to the main session only.
- `tool_result` cannot refuse a tool call: a handler may only rewrite its content, details or error
  flag, so the FR-11 acceptance verdict is recorded and fed back instead of blocking the call.
- The FR-11 hand-off check reads the work order from the `task` tool call (keyed by toolCallId),
  because `before_subagent_spawn` carries neither the prompt nor a toolCallId. A spawn is judged only
  while exactly one captured order is pending: with parallel task calls the spawn cannot be
  attributed and nothing is judged, an `eval` `agent()` spawn is never judged, and captured orders
  are dropped when the task changes or after 2 minutes.
- Provider prompt-cache hits are not measured.
- Completion judging does not guarantee correctness.

## License

[MIT](LICENSE)
