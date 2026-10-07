# Jev - decision judge for oh my pi

Jev (TypeSafe systemone, `jev-latest` = jev-1.13.0) is a type-safe decision model: it answers Noul/Choice/Score questions - it never generates text. This package wires it into omp as the architect/lead judge: the main model and task agents validate important decisions, code reviews, completion claims, and route skills/models/topics through fixed option sets.

Status, observed coverage, and honest limits: see `PLAN.md` and `PRD.md`.

## Install

```sh
cd ~/ai/jev
bun install          # dev deps only (typescript, @types/bun)
```

As an omp extension (loads from `.omp/extensions/` per omp 18.6.3):

```sh
ln -s ~/ai/jev ~/.omp/extensions/jev
```

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

## Policy defaults (choices, not user-approved requirements)

- Judge failure / unavailability / confidence < 0.8 -> `revise`/`insufficient_evidence`/`ask_user`; never approve.
- Executor↔judge rework bounded at 3 iterations, then escalate with a blocker.
- Model routing only among caller-configured candidates; judge model fixed `jev-latest`, no fallback.
- Completion claims need code/execution/log/docs evidence; a report alone cannot approve.
