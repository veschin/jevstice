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
# core set: 3 small tasks, one run per arm (the first measurement)
bun run tools/measurement/run.ts --set core

# drift set: 3 six-requirement tasks, per-requirement machine verdicts (the second measurement)
bun run tools/measurement/run.ts --set drift

# validate the measuring instrument only (no omp session, no judge, a few seconds)
bun run tools/measurement/run.ts --self-test

# validate the judge-traffic proxy alone (one real judge request, no omp session)
bun run tools/measurement/proxy-check.ts

# just show what would run
bun run tools/measurement/run.ts --set drift --dry-run

# options
bun run tools/measurement/run.ts --out evidence/measurement-<date>.log   # where the log goes
                                                       # (--set core: measurement-<date>.log,
                                                       #  --set drift: measurement-<date>-drift.log)
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

**Judge-traffic accounting.** The addon's own judge consultations are HTTP calls made from inside
the extension, so the host's event stream cannot show them. The extension (like the CLI) honours
`TYPESAFE_API_URL`, so every spawned session is handed a `TYPESAFE_API_URL` pointing at a throwaway
in-process forwarding proxy (`tools/measurement/judge-proxy.ts`). Each request is relayed to the real
endpoint unchanged and recorded as one JSONL line per call — path, model, question ids, status,
latency, response token usage and a compact answer summary — which makes "how many consultations did
this run make and what did they cost" a count instead of a guess. The API key rides in the
Authorization header, is forwarded, and is never recorded. The proxy is validated on its own by
`bun run tools/measurement/proxy-check.ts` (one real judge request, no omp session).

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

Two sets live in `tools/measurement/tasks.ts` and are selected with `--set`:

- **`core`** — three small, single-deliverable tasks (`slug`, `median`, `transform`), each with one
  external check. Used for the first measurement ("does the addon change the outcome of a tiny task
  at all").
- **`drift`** — three tasks built for the class where a cheap model loses the thread: **six
  requirements in one prompt**, of which three or more can be silently dropped, one is an exact
  output format, one is a CLI flag, one is a **deferred feature the prompt forbids** (the distractor
  a careless run over-delivers on), and one is a leave-it-alone constraint on an input file. Each
  requirement is reported by the check script as a machine verdict (`REQ R1 PASS|FAIL ...`), so
  "kept" and "dropped" are objective per requirement and the judge never decides them.

| task | the six requirements | the distractor (R5) |
| --- | --- | --- |
| `drift-report` | summary.json with numeric per-category count/total; the empty-amount row skipped; an exact one-line stdout message; a `--sort=asc\|desc` flag | the deferred `--csv` mode must NOT be implemented |
| `drift-merge` | `mergeItems` with first-seen order and last-wins duplicates; `totalQty` unchanged; >= 3 new tests with `bun test` green; no input mutation; exactly two module exports | the planned `dedupeItems` alias / `mergeAll` must NOT be added |
| `drift-triage` | triage.json with sorted `byKind` and a tie-broken `slowest`; malformed lines skipped silently; a `--min=<ms>` filter; `--help` usage on stderr | the deferred `--watch` mode must NOT be implemented |

Two details make the drift set bite: `drift-report`'s `note` column contains commas inside quotes
(so the amount column only stays aligned if the CSV is parsed properly), and every prompt ends by
asking for a per-requirement kept/dropped list in the final report — which is itself a working-memory
probe, visible to the judge but never machine-counted.

### The core set

| task | prompt asks for | external check |
| --- | --- | --- |
| `slug` | a `slug()` function with regex rules, plus a bun:test file with >= 5 cases, tests passing | an independent script imports `src/slug.ts` and asserts 6 exact input/output pairs, then `bun test` must exit 0 |
| `median` | fix a bug in `src/stats.ts` so the given test suite passes, without touching the test | an independent script asserts 5 median values, checks the input array is not mutated, compares the test file's bytes to the setup digest, then `bun test` must exit 0 |
| `transform` | a `transform.ts` reading `sample.csv` and writing `out.json` (category -> numeric sum, keys sorted), run once | an independent script parses `out.json`, requires the keys `fruit`/`veg` with the numeric values 13 and 12 (formatting and whitespace are explicitly not part of the requirement), then re-runs the script and requires the same file again |

The check files are written into the scratch directory **after** the agent has finished, so the
agent can neither read nor satisfy them by accident. `--self-test` runs each check against
known-correct, known-partial and known-wrong solutions — 19 variants in total, including a tampered
test file, string-valued JSON, a solution that ignores `--sort`, a solution that mutates its inputs,
a solution that ignores `--min`, and one that **over-delivers on the deferred feature** — and fails
loudly if a check passes a wrong solution, fails a correct one, or reports the wrong per-requirement
verdicts. The full run does this first and embeds the table in the log. A measurement whose
instrument is broken is worthless, so this runs before any session and its result is part of the
evidence.

## Output

- `evidence/measurement-<date>-<set>.log` (core: `evidence/measurement-<date>.log`) - the evidence
  log: exact commands, the instrument validation table, the activation probe, per-run captures with
  file contents and final reports, per-requirement machine verdicts, judge-traffic accounting, the
  judge's verbatim verdicts, a summary table (per task: which arm won, judged satisfaction per arm,
  objective check per arm, wall time per arm, tokens per arm, judge calls per arm) plus the
  per-requirement table across arms, and an explicit verdict paragraph.
- `evidence/measurement-<date>[-<set>]/raw/` - the raw artifacts referenced by the log: the complete
  `.stdout.jsonl` event streams and `.stderr.log` per run, the judge request/response JSON, and one
  `.judge-traffic.jsonl` per run recording every judge call that run made (no API key).
- `/tmp/jev-measure-<stamp>/` - the scratch directories, left in place for inspection (each holds
  exactly what the agent left behind, minus the removed check file).

## What it does not measure

Stated here so the result is not over-read:

1. **Sample size.** Three tasks, one run per arm per set. This cannot detect small or probabilistic
   effects and says nothing about long, open-ended or design-level work. It is a smoke-level
   observation, not a benchmark, and one task flipping changes the tally.
2. **Gate pressure is absent.** Tasks run as non-interactive one-shots (`-p`) with
   `--auto-approve`, in a scratch directory with no git repository. The owner's config has
   `gates.mutation` and `gates.completion` set to `false`, so what the addon arm adds is the
   decision tool, the routing/instruction layer and advisory checks - not the blocking gates.
3. **Extension cost is measured, extension internals are not.** The judge consultations are counted
   and their token usage summed from the proxy, but whether a given consultation changed the model's
   behaviour is not observable: the consultation happens inside the extension, and the addon's own
   cost is not in the coding model's token numbers.
4. **The judge sees the check output and the per-requirement verdicts**, so the per-result `noul`
   partly restates the checks rather than forming an independent opinion. The checks are the harder
   evidence; the judge adds a cross-check that the quoted evidence really shows the acceptance met.
5. **Blinding is imperfect.** The judge never sees arm labels, but a result's *content* can reveal
   its arm (a report mentioning the judge, injected catalog text, a different working style).
   Anything like that is visible verbatim in the captured evidence.
6. **No repetition, one machine, one model.** Wall-clock numbers are single-run measurements taken
   while the machine was shared with other work; the model is the owner's cheap default role model
   with the config's thinking level. Nothing here generalises to other models or to a quiet machine.
