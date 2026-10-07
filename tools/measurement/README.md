# Measurement harness: does the jevstice addon change task outcomes?

This is not a product feature and not part of `src/`. It exists to answer one question with
evidence: **when the owner's omp runs a small, objectively checkable task, does loading this
extension (the addon arm) produce a better result than plain omp (the control arm), and what
does it cost in time?**

A business review rated the product's value unverified and asked for a measurement instead of
more tests. This directory is that measurement. An honest "it does not help" is a valid result
here; a comfortable one is worthless.

## Run it

```bash
# full run: 3 tasks x 2 arms + 2 activation-probe sessions + 1 judge request per task
bun run tools/measurement/run.ts

# validate the measuring instrument only (no omp session, no judge, a few seconds)
bun run tools/measurement/run.ts --self-test

# just show what would run
bun run tools/measurement/run.ts --dry-run

# options
bun run tools/measurement/run.ts --out evidence/measurement-<date>.log   # where the log goes
bun run tools/measurement/run.ts --seed 12345        # reproduces the A/B assignment per task
bun run tools/measurement/run.ts --repeats 2         # N runs per task per arm (default 1)
bun run tools/measurement/run.ts --only slug,median  # subset of the task set
bun run tools/measurement/run.ts --timeout 420       # per-session limit in seconds
bun run tools/measurement/run.ts --no-probe          # skip the 2 activation-probe sessions
```

Requirements: `bun`, `omp` on `PATH`, and a judge key in `TYPESAFE_API_KEY` (or `JEVI_API_KEY`).
The key is read once, passed to the TypeSafe SDK, and **never printed, logged or persisted** -
the log only records that it was present.

## What it measures

Two arms, identical prompt and identical model, one fresh scratch directory per arm, both under
`/tmp`:

| arm | command | extension loaded |
| --- | --- | --- |
| control | `omp --mode json -p --no-extensions --model <MODEL> --auto-approve --no-session --max-time N <prompt>` | none |
| addon | the same, plus `-e src/index.ts` | jevstice (`src/index.ts`), using `~/.omp/agent/jev.config.json` |

`--no-extensions` is passed in **both** arms on purpose: `~/.omp/agent/extensions/jevstice` is a
symlink to this repo, so without the flag every session in any working directory would load the
addon and there would be no control group at all. With the flag, the registered extension set is
the only difference between the arms (none vs. jevstice only).

Per run the harness captures:

- the exact command line, exit code, wall time, and whether the harness had to kill the session;
- the complete host event stream (`.stdout.jsonl`) - untruncated, kept as a raw artifact;
- token usage and provider-reported cost, the models actually used, turn count, and the ordered
  list of tool calls;
- every file in the scratch directory with size, sha256 and content;
- the agent's final report text, verbatim;
- messages the extension injected into the conversation (role `custom`);
- the output of the task's own check commands.

Then, for each task, one TypeSafe `systemOne` request asks three questions in the claim-vs-quotes
framing (the task text is quoted verbatim; results are labelled only `A`/`B`, and the A/B
assignment is randomised per task from the recorded seed):

1. choice `better` - which result better satisfies the task as quoted (`A` / `B` / `TIE`);
2. noul `satisfies_A` - does result A satisfy the task as quoted (reported raw, `>= 0.5` = "satisfies",
   the same boundary `src/client.ts` uses for claim_check);
3. noul `satisfies_B` - the same for B.

The judge is given the task text, the produced files and their contents, the final reports, and
the objective check output. It is **not** given the command lines, the arm names, the wall times
or the token usage. Every request and response is written verbatim to
`evidence/measurement-<date>/raw/judge-<task>.{request,response}.json` and reproduced in the log.
Transport failures (the endpoint resets sockets intermittently) are retried with backoff and
recorded verbatim as observations.

**Activation probe.** Two extra sessions (one per arm, `--no-probe` to skip) ask the model to
print its tool names, so the log shows whether the addon was really loaded: `jev_decision` must
appear in the addon arm and must not appear in the control arm. This is model output, so it can be
refused or malformed: each arm is asked up to three times, an answer counts only if it contains a
list with both `read` and `bash` in it, and an arm that never produces such a list is reported as
**inconclusive** rather than "absent". `--self-test` is the deterministic check of the *checks*;
this probe is the (weaker, model-dependent) check of the *treatment*.

**Revision pinning.** The log records a content digest of every file under `src/` at the start of
the run, plus the git HEAD. Because the addon is developed in the same repository, a measurement is
only comparable to another measurement when that digest matches.

## The task set

Three small, objectively checkable tasks, each with a runnable external check that does not
involve the judge (`tools/measurement/tasks.ts`):

| task | prompt asks for | external check |
| --- | --- | --- |
| `slug` | a `slug()` function with regex rules, plus a bun:test file with >= 5 cases, tests passing | an independent script imports `src/slug.ts` and asserts 6 exact input/output pairs, then `bun test` must exit 0 |
| `median` | fix a bug in `src/stats.ts` so the given test suite passes, without touching the test | an independent script asserts 5 median values, checks the input array is not mutated, compares the test file's bytes to the setup digest, then `bun test` must exit 0 |
| `transform` | a `transform.ts` reading `sample.csv` and writing `out.json` (category -> numeric sum, keys sorted), run once | an independent script parses `out.json`, requires the keys `fruit`/`veg` with the numeric values 13 and 12 (formatting and whitespace are explicitly not part of the requirement), then re-runs the script and requires the same file again |

The check files are written into the scratch directory **after** the agent has finished, so the
agent can neither read nor satisfy them by accident. `--self-test` runs each check against a
known-correct and a known-wrong solution (nine variants, including a tampered test file and
string-valued JSON) and fails loudly if the checks do not discriminate; the full run does this
first and embeds the table in the log. A measurement whose instrument is broken is worthless, so
this runs before any session and its result is part of the evidence.

## Output

- `evidence/measurement-<date>.log` - the evidence log: exact commands, the instrument validation
  table, the activation probe, per-run captures with file contents and final reports, the judge's
  verbatim verdicts, a summary table (per task: which arm won, judged satisfaction per arm,
  objective check per arm, wall time per arm, tokens per arm) and an explicit verdict paragraph.
- `evidence/measurement-<date>/raw/` - the raw artifacts referenced by the log: the complete
  `.stdout.jsonl` event streams and `.stderr.log` per run, plus the judge request/response JSON.
- `/tmp/jev-measure-<stamp>/` - the scratch directories, left in place for inspection (each holds
  exactly what the agent left behind, minus the removed check file).

## What it does not measure

Stated here so the result is not over-read:

1. **Sample size.** Three tiny mechanical tasks, one run per arm. This cannot detect small or
   probabilistic effects and says nothing about long, open-ended or design-level work - the work
   the addon's gates are meant for. It is a smoke-level observation, not a benchmark.
2. **Gate pressure is absent.** Tasks run as non-interactive one-shots (`-p`) with
   `--auto-approve`, in a scratch directory with no git repository. The owner's config has
   `gates.mutation` and `gates.completion` set to `false`, so what the addon arm adds here is the
   decision tool, the routing/instruction layer and advisory checks - not the blocking gates.
3. **Cost is partial.** Only the coding model's token usage as reported by the host is captured.
   The addon's own judge consultations are invisible to this harness; they show up only indirectly
   as extra wall time, extra tool calls, or injected messages.
4. **The judge sees the check output**, so the per-result `noul` partly restates the check rather
   than forming an independent opinion. The check is the harder evidence; the judge adds a
   cross-check that the quoted evidence really shows the acceptance met.
5. **Blinding is imperfect.** The judge never sees arm labels, but a result's *content* can reveal
   its arm (a report mentioning the judge, injected catalog text, a different working style).
   Anything like that is visible verbatim in the captured evidence.
6. **No repetition, one machine, one model.** Wall-clock numbers are single-run measurements taken
   while the machine was shared with other work; the model is the owner's cheap default role model
   with the config's thinking level. Nothing here generalises to other models or to a quiet machine.
