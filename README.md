<p align="center">
  <img src="docs/banner.webp" alt="Jevstice" width="100%">
</p>

<h1 align="center">Jevstice</h1>

<p align="center"><strong>Jev records diagnostic judgment at OMP tool boundaries. It never grants or withholds execution permission.</strong></p>

<p align="center">
  <a href="https://veschin.github.io/jevstice/">See Jev in action</a> ·
  <a href="#install">Install</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#diagnostics">Diagnostics</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#optional-autonomy">Autonomy</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <img alt="Bun 1.1 or newer" src="https://img.shields.io/badge/Bun-1.1%2B-black">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2ea44f"></a>
  <img alt="OMP extension" src="https://img.shields.io/badge/OMP-extension-6f42c1">
  <img alt="Version 2.3.1" src="https://img.shields.io/badge/version-2.3.1-e05d44">
</p>

Jevstice connects [oh-my-pi](https://github.com/can1357/oh-my-pi) to Jev (`jev-latest`, TypeSafe API), a typed decision judge. The executor submits the decisions it can see - requirements, plans, search candidates, acceptance claims and single uncertain choices - and receives a typed verdict.

Each verdict is a diagnostic record. A failed, inconclusive or unavailable check stays failed, inconclusive or unavailable in the record; it does not become an execution error, a repair permit, an owner approval or a permission to stop working. Findings are disclosed with their boundary, work revision, exact submitted material and returned result. The host owns tool permissions, and useful work and model completion continue independently from check acceptance.

Jevstice observes visible tool boundaries, not private reasoning: it cannot read the model's thoughts, authenticate submitted evidence or run an OS sandbox. See the warning under [Diagnostics](#diagnostics).

> [!NOTE]
> Jevstice is an OMP extension, not a standalone CLI. The ordinary addon needs Bun 1.1 or newer, OMP and a TypeSafe API key. The optional strict autonomy module adds Linux-only prerequisites.

## Install

| Requirement | Detail |
| --- | --- |
| Runtime | Bun 1.1 or newer |
| Host | [oh-my-pi](https://github.com/can1357/oh-my-pi) |
| Judge key | `TYPESAFE_API_KEY`, `JEVI_API_KEY`, or a command in `TYPESAFE_API_KEY_COMMAND` |

### 1. Clone the extension

```sh
git clone https://github.com/veschin/jevstice.git ~/.omp/agent/extensions/jevstice
```

OMP reads the manifest entry `src/index.ts` from `package.json`. Dependencies install on first run; run `bun install` in the checkout if your setup does not install them.

### 2. Provide the key

```sh
export TYPESAFE_API_KEY="..."
# or resolve it only when the judge is called:
export TYPESAFE_API_KEY_COMMAND='pass show token/jev'
```

The key is read lazily and passed only to the judge client. A missing or rejected key produces an unavailable judgment; it does not stop the host or the work.

### 3. Restart OMP

The host loads extension schemas and hooks at process start. Restart OMP after installing or updating the extension.

To load a checkout for one session without changing the installation:

```sh
omp --no-extensions -e /path/to/jevstice/src/index.ts
```

## Tools

Jevstice registers thirteen tools in ordinary sessions. `src/guidance.ts` defines their descriptions and schemas. Ordinary startup shows a short workflow instead of the full catalog.

For the bundled workflow, link the checkout with `omp plugin link /path/to/jevstice` and restart
OMP. In OMP 19.1, run `<tool> --help` in `bash` for Jev commands, then pass the arguments with
`-j '<JSON>'`. If OMP lists the tool directly, pass the JSON to that tool instead.

| Tool | Diagnostic decision |
| --- | --- |
| `jev_triage` | Does this request need development planning, and which topics does it need? |
| `jev_search_relevance` | Which supplied search candidate is relevant, or is none? |
| `jev_fact_check` | Which research claims are supported, which topics belong, and does the draft answer the owner's question? |
| `jev_requirements` | Does each proposed requirement follow from the owner's request, and does the set cover it? |
| `jev_plan_review` | Does the outline, each plan section and the assembled plan serve the task? |
| `jev_consult` | One diagnostic choice, score or boolean question. |
| `jev_context` | List or read the project's trusted context archive, including requirement and plan snapshots. |
| `jev_course_check` | Does the submitted current-work claim, proposed next action and evidence follow the approved task? |
| `jev_acceptance` | Which plan tasks or requirements does the observed work establish, and what can be removed? |
| `jev_review` | Does a checkpoint, commit or diff hold up as developer work? |
| `jev_reaim` | Is this an owner change of direction that replaces the current task? |
| `jev_text_review` | Which prose fragments violate the submitted rules, and which rule does each violate? |
| `jev_anti_slop` | Do the artifact's claims, inferences, hypotheses and language hold against quoted evidence? |

`jev_consult` accepts only `mode: "choice"`, `mode: "score"` or `mode: "boolean"`. Every mode answers one question and grants no approval, permission or execution authority. The former `mode: "recovery"` and its `repair`/`resolve` phases are gone: a diagnosis never authorizes or blocks an effect.

Two command names are registered; `/jev` takes `off`, `on` or no argument:

| Command | Effect |
| --- | --- |
| `/jev` | Report whether diagnostic checks are on or off in this session. |
| `/jev off` | Stop diagnostic checks, source capture, prompt injection and judged tool execution for this session. |
| `/jev on` | Restore checks with a fresh workflow. |
| `/jev-status` | Report session mode, diagnostic coverage, activity outcomes, judge requests and estimated spend. |

`/jev off` and `/jev on` change checks only. They do not change host permissions, supervisor safety limits or the result of work in progress, and they write no configuration file. Repeating the current mode is idempotent. `/jev on` retains the session's usage and diagnostic totals, does not restore old findings or task state, and discards an in-flight judgment. A mode change is queued as a `nextTurn` message with `triggerTurn: false` and never steers an in-flight batch. During a busy change its mode-only instruction may enter provider context at the next turn boundary; an idle session reports the result without starting a model turn.

## Diagnostics

The controller classifies each visible tool call with deterministic effect classifiers in `src/gates.ts` (a consequential change, a publication, or a target outside the approved plan) and records what happened. It does not block the call: ordinary `tool_call` handlers return no decision, and `session_stop` returns no completion hold.

### Status shape

OMP renders explicit Jev tool results as compact, themed rows. Expand a row to read the full
diagnostic. Jev does not post an automatic session summary or populate the OMP status strip.
Run `/jev-status` to see the full work, check, acceptance and spend summary without starting a
model turn.
The model still receives the complete tool results and actionable background feedback.

Every Jev tool result while diagnostics are on carries `details.diagnostics`:

```json
{
  "checks": { "passed": 4, "failed": 1, "inconclusive": 0, "unavailable": 0, "not_checked": 2 },
  "work":   { "passed": 0, "failed": 0, "inconclusive": 0, "unavailable": 0, "not_checked": 3 }
}
```

Both objects always carry the five keys `passed`, `failed`, `inconclusive`, `unavailable` and `not_checked`. `checks` counts Jev activity results; `work` counts coverage of consequential tool results. A consequential result is first counted as `not_checked`; the action diagnostic then runs in the background after a completed result, using the current approved plan when available. An asynchronous launch without a settled action diagnostic remains `not_checked`; launching or observing a job is not a passing check. The `/jev-status` summary reports both groups and current-revision business and architecture acceptance separately. Usage records and passing conformance checks are not proof of successful implementation.

### Ordinary task workflow

For a project change, call `jev_requirements` with derived items; omit `request` to use the
captured owner prompt. After verifying the change, call `jev_acceptance` with `{"aspect":"outcome"}`.
With a registered plan, Jev checks each task independently. It distinguishes a weak task
description from missing evidence, uncertainty and an observed defect. Once all tasks pass on
the same revision, Jev checks the integrated change. Both levels cite observed material when
recommending a cut. Jev also schedules this review at completion without delaying work, asking
for routine owner approval, or starting another turn. See the results with `/jev-status`.

Without a registered plan, Jev compares approved requirements with observed code and execution.
A later source change invalidates earlier verification. Business and architecture checks remain
available separately. A quiet local read or summary does not need a Jev call.

### Research fact-check

An explicit fact-check or research request, an observed search, or an external read triggers a
fact-check reminder in ordinary sessions. Before delivering, submit the exact draft to
`jev_fact_check` with self-contained claims, verbatim claim fragments, and source excerpts.
Give each source by the exact locator used to open it. Jevstice checks quoted material against
recent `read` and `bash` results from that turn. Search snippets alone do not count as evidence.
For table claims, quote the relevant row with its headings, units, conditions and caption.
An unambiguous passage in the source can establish a result when the extracted columns are unclear.
Each verdict gives a next action: reopen an unverified source, add missing context, correct an
evidenced contradiction, or leave a below-confidence result unresolved.

The protocol adapts [VERIFY, FactBench §4](https://arxiv.org/html/2410.22257v2#S4): separate
checkable assertions, retrieve evidence through OMP, and distinguish support, contradiction and
insufficient evidence. [FActScore](https://aclanthology.org/2023.emnlp-main.741/) measures the
share of supported assertions; [SAFE](https://neurips.cc/virtual/2024/poster/96675) checks
individual facts against search and estimates recall using a preferred answer length. Jevstice
checks completeness against the original question instead. It judges each claim and draft topic
for relevance separately from truth, and distinguishes local evidence from broader conclusions.

If the model skips the tool, OMP receives one request to continue for the review. Jevstice reports
a skipped review as not checked and never waits for a passing verdict. The review identifies the
submitted draft by digest; changes do not inherit its verdict. Review changed claims before
delivery and disclose unresolved findings. `/jev off` disables reminders and checks.

### What a failed check means

- A refusal or negative verdict is a **failed** diagnostic. The tool result reports the observable result, reason and one next action; the exact submitted material and returned result stay in `details` and are listed by `jev_context({"action":"list"})`.
- An answer below its floor is **inconclusive**: no defect and no approval is established.
- A judge outage, a stale answer or a changed artifact is **unavailable** or **not checked**: nothing was established.
- A local argument error creates no judge judgment; correct the field and resubmit. It is **not checked**, not a failed check.
- Duplicate identical submissions may be answered from the recorded refusal record without another paid call. Changing the question, evidence or submitted material makes a genuinely new decision possible.

Capability checks and strict supervisor safety are separate from these diagnostics. The optional strict runtime keeps its owner-authorized roots, resource limits, effect identity, durable intent ledger and pending-effect reconciliation; a Jev verdict is evidence there, not authority. Ordinary Jevstice does not change host tool permissions.

> [!WARNING]
> Jevstice cannot authenticate submitted evidence, detect every deceptive submission or observe a remote effect after the host reports it. A passing check is not proof that work is correct; a failing check is not proof that an effect was unsafe, refused or rolled back.

## Configuration

The project file `<project>/.omp/jev.config.json` overrides the user file `~/.omp/agent/jev.config.json`.

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `antiSlop.mode` | `off`, `advisory` | `advisory` | External-artifact review policy. Findings remain diagnostic. |
| `billing.balance` | non-negative number | unset | Owner's TypeSafe balance snapshot in dollars. |
| `billing.inputCostPerMillion` | non-negative number | `0.042` | Input token price used for spend estimates. |
| `billing.outputCostPerMillion` | non-negative number | `0` | Output token price used for spend estimates. |

```json
{
  "antiSlop": { "mode": "advisory" },
  "billing": { "balance": 10, "inputCostPerMillion": 0.042, "outputCostPerMillion": 0 }
}
```

An invalid value keeps the value already in force and names the file, key and retained value. Unknown keys are ignored. `billing.balance` is a configured snapshot; the public TypeSafe API exposes no live balance endpoint.

When a session starts, each configuration problem is delivered to the owner through the host's UI notification with the exact problem text. Configuration details are not sent as a model-visible session message, so a broken file cannot inject instructions or hidden context into the model.

Older files may still carry `gates.mutation`, `gates.completion`, `courseCheck.mode`, `courseCheck.interval` or `antiSlop.mode: "enforce"`. The gate and course-check keys are ignored because there is no blocking boundary or automatic schedule to configure. `enforce` is invalid in the current schema: it falls back to `advisory` with a named configuration problem. The `antiSlop` review is described below.

## Anti-slop review

`jev_anti_slop` reviews an external document, research output or legal communication. It returns `supported`, `refuted` or `not_enough_info` per claim, checks inferences against premises and a stated warrant, requires a falsifier for a hypothesis, and reports language, register and meta-text violations per fragment. A quote identical to the claim does not count as evidence.

An explicit request to create or file an issue can bring its draft into review scope. A request
to inspect an existing issue does not. When scope or configuration skips the review, the tool
reports it as not checked and names the reason. An editorial finding quotes an exact sentence
when it can locate the issue reliably; otherwise it quotes the paragraph. Mark mandatory rules
with `severity: "blocker"` and preferences with `"warning"` (the default). These classifications
do not authorize or prevent publication.

The tool includes numbered Russian and English editing protocols with before-and-after examples.
The executor follows the steps to preserve meaning, cut filler and repetition, replace formulaic
sentence structures, and remove decorative symbols from editable prose. Quotations, names,
uncertainty, code, mathematical notation, citations and useful Markdown remain intact.

Russian and English reviews automatically check symbols, wording, syntax and coherence in addition
to the supplied rules. Use `rules: []` when no additional rule is needed; unsupported languages
still require explicit rules. Use `claims: []` only when the text contains no factual assertions:
an empty list does not verify claims omitted from the submission.

Each finding includes the affected quotation and a correction instruction. The tool does not
rewrite the artifact: the executor edits it and submits the changed exact text for another review.
An inconclusive or unavailable check is not a clean review, and unchanged submissions must not be
repeated to seek approval. The protocols guide a model; they do not guarantee its writing quality.

| Mode | Behavior |
| --- | --- |
| `off` | The review is disabled; the tool returns a named prerequisite. |
| `advisory` | Findings are reported. This is the shipped default. |

Findings are diagnostic records. They do not override host permissions and are never Jev approval. The review cannot authenticate a source or prove a claim true. Its claim checks follow FEVER, SciFact and AVeriTeC; inference checks follow Toulmin; source strength follows GRADE; hypothesis checks follow Popper's falsifiability test.

## Optional autonomy

<details>
<summary><strong>Experimental strict supervisor for Linux</strong></summary>

The optional module runs one immutable objective through requirements, staged planning, implementation, verification and current-revision acceptance without owner-confirmation rounds. It is a separate strict runtime: ordinary `/jev off`, `/jev on` and ordinary diagnostics do not apply to it, and the owner stops it only through the supervisor. It keeps the authoritative checkpoint, exact local artifacts, judge context and invocation intents in a private SQLite ledger. The package manifest never loads it: `bun run autonomy` starts `autonomy/driver.ts`, which launches the supervised child with `autonomy/index.ts` as its extension entry.

Full autonomy acceptance remains open. Post-compaction completion and crash-effect reconciliation did not complete in real trials. A simple objective passed end to end, but the unresolved trials are not passing results.

Strict supervision requires Linux with cgroup v2, a working systemd user manager, Bun, OMP, an authenticated executor model and the TypeSafe key or resolver. The supervisor fences the recorded systemd scope before recovery or cancellation can establish containment. It does not install a service and does not promise a restart after its own process exits.

The owner places the objective and policy outside the writable project roots:

```json
{
  "roots": ["/srv/project"],
  "effects": ["project"],
  "maxJudgeCalls": 200,
  "maxExecutorCalls": 500,
  "maxRuntimeMs": 3600000,
  "maxContextBytes": 262144,
  "maxArtifactBytes": 1048576
}
```

All limits are required positive integers. `publication` is a separate effect that must be authorized in the initial policy.

```sh
bun run autonomy start --objective /srv/jev-control/objective.txt --policy /srv/jev-control/policy.json
bun run autonomy status
bun run autonomy resume --run RUN_ID
bun run autonomy stop --run RUN_ID --reason "operator stop"
```

Keep the starting terminal attached: a durable wait does not end the supervisor. The default store is `~/.omp/agent/jevstice/autonomy.sqlite`; `--store` selects another private local database outside every writable root. `start` and `resume` accept `--omp` and `--model`.

See [the autonomy reference](docs/autonomy.md) for the lifecycle, deployment limits and requirements FR-57 through FR-66, and [the smoke guide](tools/README.md#strict-autonomy-smoke) for the real-host scenarios.

</details>

## Demos

On the [Jevstice site](https://veschin.github.io/jevstice/), you can replay Luna's revisions and compare two booking notices against the signed studio policy.

## Development

```sh
bun install
bun test
bun run typecheck
```

The suite uses injected judges and makes no live API calls. Static checks and the live smoke are the caller's responsibility; this README records no suite count or release verdict.

To exercise the website without a test dependency, serve the checkout locally (`python3 -m http.server --bind 127.0.0.1`) and open `http://127.0.0.1:8000/tests/site-playback.html`. It checks that the booking notice plays through to the correction and stops when the reader picks a version.

Live checks use the production judge; the `diagnostics` scenario uses an injected judge and needs no key. Host mode also needs a real OMP process:

```sh
bun tools/live-smoke.ts direct --scenario workflow
bun tools/live-smoke.ts direct --scenario factorio
bun tools/live-smoke.ts direct --scenario diagnostics
bun tools/live-smoke.ts host --scenario workflow --model deepseek/deepseek-flash --max-time 300
```

`direct --scenario diagnostics` exercises a negative verdict and an outage as deterministic controller coverage, not a live judge result. Host mode verifies that native tool calls execute without a Jev hold and that the recorded diagnostics match the observed outcomes. [tools/README.md](tools/README.md) lists modes, evidence files and limits.

[PRD.md](PRD.md) records the functional requirements, including the superseding 2026-11-15 diagnostic contract. [AGENTS.md](AGENTS.md) records repository conventions and test baselines.

## License

Jevstice is released under the [MIT license](LICENSE).
