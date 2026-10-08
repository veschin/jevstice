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

# three arms on one long task, the third with the gates armed by a project config
bun run tools/measurement/run.ts --set refactor --only duration --arms control,addon,armed \
  --config armed=tools/measurement/armed.jev.config.json --repeats 5 --seed 20261008

# hard set: the failure-search task (12 requirements that live in a shipped SPEC.md)
bun run tools/measurement/run.ts --set hard --only ledger

# validate the measuring instrument only (no omp session, no judge, a few seconds)
bun run tools/measurement/run.ts --self-test

# search instrument: run the CONTROL arm only (no addon, no judge) on a candidate task and print
# the per-requirement machine verdicts; appends every attempt to a search log
bun run tools/measurement/screen.ts --set hard --only ledger --attempt "A1 ..." --repeats 2

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
bun run tools/measurement/run.ts --raw <dir>         # where the raw event streams go (a second run of
                                                     # the same set must not overwrite the first one's)
JEV_PROXY_DUMP_DIR=<dir> bun run tools/measurement/run.ts ...  # also dump every judge request/response body
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

**Arms.** `--arms a,b,c` selects which arms run (default `control,addon`). `control` loads no
extension; `addon` and `armed` both load `-e src/index.ts`, and `armed` additionally gets a per-arm
config:

- `--config <arm>=<path>` copies that JSON into the run's own scratch directory as
  `.omp/jev.config.json`. The extension's loader merges a project config over the owner's
  `~/.omp/agent/jev.config.json` **key by key**, so the override can flip individual switches
  (gates, `courseCheck`) while everything else still comes from the owner's real config. The exact
  JSON and its sha256 are printed in the log, once per arm in the header and in every run's capture.
- `tools/measurement/armed.jev.config.json` is the armed configuration used in the "armed" runs: the
  owner's file with only `gates.mutation: true`, `gates.completion: true`,
  `gates.handoffAcceptance: true` and `courseCheck.everyMutations: 1` added, so the plan gate, the
  completion gate, the acceptance side and a course check after every allowed mutation are all on.
- The judge compares **every pair** of selected arms, each pair blind and with its own randomisation
  from the recorded seed.

**Requirement-level accounting.** With the proxy's payload dump on
(`JEV_PROXY_DUMP_DIR`, set automatically per run), each consultation's request body is available, and
the harness classifies it: a consultation is *requirement level* when its payload judges the task's
requirements rather than only classifying or routing it — either structurally (the state carries a
non-empty `requirements` array whose items quote binding statements) or textually (it names a
requirement item `req-N`/`crit-N`/`quote-N`, a ticket section `SPEC.md §4`, or one of the task's
declared requirement ids). The per-run line, the per-arm roll-up and the matching excerpts are in
the log's "Observations" section, so "did the extension ever look at a requirement?" is answered
from payload evidence rather than from a hope.

**Judge-traffic accounting.** The addon's own judge consultations are HTTP calls made from inside
the extension, so the host's event stream cannot show them. The extension (like the CLI) honours
`TYPESAFE_API_URL`, so every spawned session is handed a `TYPESAFE_API_URL` pointing at a throwaway
in-process forwarding proxy (`tools/measurement/judge-proxy.ts`). Each request is relayed to the real
endpoint unchanged and recorded as one JSONL line per call — path, model, question ids, the top-level
keys of the request's `state`, status, latency, response token usage and a compact answer summary —
which makes "how many consultations did this run make and what did they cost" a count instead of a
guess. The API key rides in the Authorization header, is forwarded, and is never recorded. A relay
that fails (the endpoint resets sockets intermittently) is still recorded, with status 502 and the
error, so a consultation that produced no judgement is counted as exactly that. Every consultation is
also listed in the log itself, one line per call, next to the run it belongs to; the proxy is
validated on its own by `bun run tools/measurement/proxy-check.ts` (one real judge request, no omp
session).

To show *what* a consultation was about and not only that it happened, set `JEV_PROXY_DUMP_DIR` and
the proxy writes the verbatim request and response bodies, one JSON pair per call
(`<label>-<n>.request.json` / `.response.json`):

```bash
JEV_PROXY_DUMP_DIR=evidence/measurement-<date>-<set>/payloads bun run tools/measurement/run.ts ...
```

The bodies hold extension-composed states (task text, plans, candidate answers) and never headers, so
the API key stays out of them; the dump is what lets a reader check whether a judgement about a
particular requirement was ever made, rather than inferring it from an outcome.


**Activation probe.** Two extra sessions (one per arm, `--no-probe` to skip) ask the model to
print its tool names, so the log shows whether the addon was really loaded: `jev_decision` must
appear in the addon arm and must not appear in the control arm. This is model output, so it can be
refused or malformed: each arm is asked up to three times, an answer counts only if it contains a
list with both `read` and `bash` in it, and an arm that never produces such a list is reported as
**inconclusive** rather than "absent". `--self-test` is the deterministic check of the *checks*;
this probe is the (weaker, model-dependent) check of the *treatment*.

**Revision pinning.** The log records a content digest of every file under `src/` at the start of
the run, plus the git HEAD. Because the addon is developed in the same repository, a measurement is
only comparable to another measurement when that digest matches. At the end of the run the digest is
re-read and every `src/` file whose mtime falls inside the run window is listed as well: the addon
arm loads `-e src/index.ts` when a session starts, so a write that lands mid-run can hand different
sessions different revisions. The log states that explicitly ("NOT single-revision - discard") rather
than leaving it to the reader to infer from timestamps.

## The task set

Six sets live in `tools/measurement/tasks.ts` and are selected with `--set`:

- **`core`** — three small, single-deliverable tasks (`slug`, `median`, `transform`), each with one
  external check. Used for the first measurement ("does the addon change the outcome of a tiny task
  at all").
- **`drift`** — three tasks built for the class where a cheap model loses the thread: **six
  requirements in one prompt**, of which three or more can be silently dropped, one is an exact
  output format, one is a CLI flag, one is a **deferred feature the prompt forbids** (the distractor
  a careless run over-delivers on), and one is a leave-it-alone constraint on an input file. Each
  requirement is reported by the check script as a machine verdict (`REQ R1 PASS|FAIL ...`), so
  "kept" and "dropped" are objective per requirement and the judge never decides them.
- **`horizon`** — two eight-requirement tasks on a longer horizon (`horizon-api`, `horizon-sync`),
  where several requirement details exist only in a shipped `SPEC.md`, one requirement pulls against
  an earlier one, an existing module contract has to survive, and a deferred feature is forbidden.
- **`hard`** — failure-search task 1 (`ledger`): twelve requirements that live in a shipped
  `SPEC.md`, with a ticket-style prompt that points at the spec instead of enumerating them, an
  existing money module whose contract and test suite must survive untouched, a proportional
  allocation rule with an exact-total constraint, three extra carts exercised through `--file`
  (tie-break, zero subtotal, discount larger than the total) and a deferred `--csv` mode.
- **`tickets`** — failure-search task 2 (`tickets`): fourteen ticket sections on an existing
  three-module issue tracker, so the same decisions (priority list, id prefix, row form, ordering)
  have to hold in the store, the formatter and the CLI at once, with a frozen test suite, an
  API-stability rule against new exports and a packaging rule against new files.
- **`refactor`** — failure-search task 3 (`duration`) and the first task on which the control arm
  demonstrably dropped a requirement: an existing module pair with an edge-heavy behaviour surface
  (an ordered-unit duration parser with exact error messages, plus a half-open window predicate) has
  to be split in two, every existing behaviour has to survive the rewrite although the shipped test
  file covers only a fraction of it, the caller has to be cut over without a re-export shim, and two
  new rules (a `maxUnits` truncation and an ISO-8601 window entry point) carry the boundary cases
  the checks probe. Measured with both arms (`--repeats 5`): the control arm dropped R4 in 2 of 5
  runs and the addon arm in 3 of 5, the same edge in both, so the extension did **not** prevent the
  failure - `evidence/measurement-2026-10-08-failure-search.md` has the search, the result and the
  plain answer.

The first three sets are the measurement sets of runs 1–3; the last three were built by the failure
search (`screen.ts`, below) and are only carried into a two-arm run once the control arm is shown to
drop a requirement on them. The search, its attempts and its winner are in
`evidence/measurement-<date>-search.log`.

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
known-correct, known-partial and known-wrong solutions — 61 variants in total (9 for `core`, 12 for
`drift`, 12 for `horizon`, 8 for `hard`, 11 for `tickets`, 9 for `refactor`), including a tampered
test file, string-valued JSON, a solution that ignores `--sort`, a solution that mutates its inputs,
a solution that ignores `--min`, a solution that allocates the rounding remainder to the wrong lines,
a solution that ignores the frozen-module constraint, a solution that loses an existing module's
ordered-unit rule while rewriting it, a solution that leaves a re-export shim behind, a solution that
grows a module's public API, and one that **over-delivers on the deferred feature** — and fails
loudly if a check passes a wrong solution, fails a correct one, or reports the wrong per-requirement
verdicts. The full run does this first and embeds the table in the log. A measurement whose
instrument is broken is worthless, so this runs before any session and its result is part of the
evidence.

## The failure search (control arm only)

The measurement harness always runs both arms and consults the judge, which is the wrong tool for
finding a task that the cheap model fails at all: before a comparison is worth running, the control
arm alone has to drop a requirement. `tools/measurement/screen.ts` runs the control arm only - same
binary, same flags, same prompt, same scratch layout and the same check scripts as `run.ts` - and
prints the per-requirement machine verdicts:

```bash
bun run tools/measurement/screen.ts --set hard --only ledger --attempt "A1 ..." --repeats 2
```

Every attempt is appended to `evidence/measurement-<date>-search.log` with the per-requirement
verdict table, the check output verbatim, the final report verbatim, the model, the wall time, the
token usage and the `src/` content digest before and after, so the search is visible rather than only
its winner. It is a *search* instrument: a task that defeats the control arm there is then measured
with the real two-arm harness, and the screening log makes no claim about the addon. Nothing in
either tool decides that a task is realistic; that judgement is recorded in the log's attempt notes.

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
- `evidence/measurement-<date>-search.log` - the control-only screening log written by `screen.ts`:
  every attempt (including the ones whose task the control arm passed) with its per-requirement
  verdicts, check output, final report, model, wall time, token usage and `src/` digest before and
  after. `/tmp/jev-screen-<stamp>/` holds those scratch directories.
- `evidence/measurement-<date>-failure-search.md` - the readable account of that search: each attempt
  and what it showed, the decided task, the two-arm result on it (per repeat: machine verdicts, judge
  verdict, wall time, tokens, consultations, and whether any consultation touched the dropped
  requirement), the plain answer, and the limits.

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
