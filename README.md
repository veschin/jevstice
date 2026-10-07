# Jev - decision judge for oh my pi

Jev (TypeSafe systemone, `jev-latest` = jev-1.13.0) is a type-safe decision model: it answers Noul/Choice/Score questions - it never generates text. This package wires it into omp as the architect/lead judge: the main model and task agents validate important decisions, code reviews, completion claims, and route skills/models/topics through fixed option sets.

Status, observed coverage, and honest limits: see `PLAN.md` and `PRD.md`.

## Launch (verified)

```sh
cd /tmp/jev-smoke   # any project dir
TYPESAFE_API_KEY="$(pass show token/jev)" omp \
  -e /home/veschin/ai/jev/src/index.ts \
  -p "<your task; the agent must call the jev_decision tool for plan/completion gates>" \
  --model zai/glm-5.3-flash
```

No global install/config changes. In an interactive session the same `-e` flag loads the extension; the agent submits decisions via the registered `jev_decision` tool (never via file writes).

## Credentials

Never stored by Jev. Provide at runtime:

```sh
export TYPESAFE_API_KEY="$(pass show token/jev)"   # or your own env
```

Optional: `TYPESAFE_API_URL` (default `https://api.typesafe.ai/v1/systemone`).

## CLI

```sh
bun run src/cli.ts probe            # live reachability check; error JSON on stderr, exit 4 on failure
bun run src/cli.ts request.json     # DecisionRequest (or - for stdin) -> DecisionResult JSON on stdout
```

Request JSON: `{stage, task, proposal, options:[{id,label,meaning}], evidence:[{kind,source,quote}]}`. Exit codes: 0 = valid judge verdict (even revise); 2 = invalid input; 4 = transport/auth/config error. Errors go to stderr as JSON; stdout stays empty on failure. Judge failure never approves.

## Templates and overrides

Defaults (stage instructions, option sets, thresholds, capability defaults) are versioned in the package. Override file (JSON), searched at:

1. `<cwd>/.omp/jev.config.json` (project)
2. `~/.omp/agent/jev.config.json` (user)

```json
{
  "confidenceThreshold": 0.9,
  "stages": {
    "direction_review": {
      "instructions": "Additional project-specific review focus (appended after the built-in untrusted-evidence policy).",
      "options": [ { "id": "proceed", "label": "Proceed", "meaning": "continue the plan" },
                   { "id": "stop", "label": "Stop", "meaning": "abort" } ]
    }
  },
  "capabilities": ["feature-id-a", "feature-id-b"]
}
```

Trust model: config files are trusted input from the person running omp; a project file shapes prompts but cannot weaken the approval floor (`confidenceThreshold` may only raise it above 0.8; precedence user > project for the threshold, project > user for prompt-shaping keys). Invalid override → the extension refuses to register `jev_decision` with the file path and problem — never a silent fallback.

## Known limits

- Mutation gate covers builtin mutating tools (edit, write, ast_edit, bash, memory_edit, manage_skill); custom/MCP tools are outside it.
- Subagent sessions load their own extensions: gates are per-session; a subagent's mutations are not seen by the parent's gate but the subagent must satisfy its own plan/completion gates.
- Provider prompt-cache hits are NOT claimed; cache measurement is deferred scope.
- Completion judging reduces but does not eliminate wrong-approval risk; numeric quality metrics remain an open user decision (PRD GAP:1).

## Policy defaults (choices, not user-approved requirements)

- Judge failure / unavailability / confidence < 0.8 -> `revise`/`insufficient_evidence`/`ask_user`; never approve.
- Executor↔judge rework bounded at 3 iterations, then escalate with a blocker.
- Model routing only among caller-configured candidates; judge model fixed `jev-latest`, no fallback.
- Completion claims need code/execution/log/docs evidence; a report alone cannot approve.
