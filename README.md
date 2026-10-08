<p align="center">
  <img src="docs/banner.webp" alt="jevstice" width="100%">
</p>

# jevstice

Jev (`jev-latest`) as a decision judge for [oh-my-pi](https://github.com/can1357/oh-my-pi):
the executor puts its business and architecture decisions, and its finished code reviews, to Jev
through fixed-option questions and acts on the answer, instead of guessing. Business, architecture
and opt-in security reviews run as advisory activities; the plan and completion checks are opt-in
backstops.

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

## Rework loop: N attempts, each a different approach

Rework is a loop of at most N attempts per stage per task (`maxReworkIterations`, default 3), and
every attempt must CHANGE THE APPROACH, not the wording (PRD 19). A submission names the approach it
takes:

```json
{
  "stage": "understanding_review",
  "task": "Plan the dashboard slice",
  "approach": "state the outcome plus the evidence that settles it",
  "proposal": "...",
  "options": [ { "id": "approve", "label": "...", "meaning": "..." } ],
  "evidence": [ { "kind": "user", "source": "task prompt", "quote": "..." } ]
}
```

- **A spent approach is refused before the judge is called.** The refusal names the approaches
  already tried on this stage, says which attempt spent the repeated one, consumes no consultation
  and no rework, and names the difference: the approach must change (tighten the trigger; split the
  item into narrower, separately checkable items; restate it as an outcome plus the evidence that
  settles it). The same approach in different words is not a new attempt. Comparison folds case and
  inner whitespace only.
- **A different approach is a new attempt**, even over unchanged wording: the approach is part of
  the rework-bound digest, so the attempt gets a fresh budget. The approval digest is untouched.
- **The attempts are bounded at N per stage per task.** After N attempts (each with its own
  approach) the bound is exhausted: the stage escalates to `ask_user` with the journal - which
  approaches were tried and what the judge answered each - and the exhaustion is recorded as an OPEN
  item. Jev never bends the wording until the judge agrees.
- **Every rejection feeds back the loop state**: the attempt number, the approaches already spent,
  and what the next attempt must change. The journal (attempts, approaches, verdicts with their
  reasons) lives in the session state (`reworkJournal`) and survives a restart, so a spent approach
  stays spent.
- Submissions that name no `approach` are untouched by this dimension and keep the older digest
  budget: an identical resubmission consumes it, a changed submission starts a fresh one.

## The answer obliges: the standing problems of a refusal (PRD 1.1 / FR-10)

The owner's rule is one sentence: *"если ты спросил судью и он сказал переделать значит выясняй что не
так и переделывай"*. A refusal is therefore not only a verdict in the transcript - it is a list of
problems the work has to answer.

- **What obliges.** A judged refusal (`revise`) that names at least one reason and carries a real
  confidence at or above the floor a blocking gate uses (`POLICY.minConfidenceToApprove`, 0.8,
  raise-only). A review is the one exception, by its own contract: a *finding* is how a review states
  a confident negative (declared statement polarity above the fixed threshold, `src/reviews.ts`), so
  it obliges without a choice-confidence. An abstention, a below-floor or unquantified refusal, a
  judge error and a frame escape create NO obligation: the fail-closed rule decides, and uncertainty
  is turned into neither an obligation nor an approval.
- **What is recorded.** The judge's own reasons, verbatim, de-duplicated and in the order it named
  them, as the standing problems of that task+stage (`outstandingRework` in the session state,
  restored on a restart). A later refusal of the same stage ADDS what it names; a problem already
  standing is never renumbered or dropped.
- **What reaches the session.** The refusal delivers the numbered list into the SAME session,
  together with what the next submission must do: change the WORK and answer every problem by
  position. The rework journal keeps its own rule beside it - the attempt must name a different
  approach.
- **What the judge sees.** The next consultation of that stage carries the standing problems and the
  declared answers verbatim inside the claim, with the question it is asked: does the quoted evidence
  show every named problem resolved? An approve is then an answer about the problem, not a fresh
  reading of the work.
- **What is not recorded.** While any standing problem is unanswered: no approval of that stage, no
  pass record a boundary consumes (the course-check `continue`, the aspect-coverage gap clearance,
  the refactor marking), no completion-streak credit. The outcome is `insufficient_evidence` naming
  `outstanding_rework_unanswered` and every problem.
- **What stays shut.** On a plan-granting stage (`understanding_review`, `direction_review`) an older
  approval no longer covers a later refusal: the mutation gate stays shut and names the problems, so
  no mutating work continues as if the judge had answered approve.
- **What clears it.** The judge's own approval of a submission that answered every problem, or an
  escalation THE JUDGE answered (`ask_user`; the blocker then carries the problems). Nothing else - an
  abstention, a judge error and a sub-floor answer leave it standing, and so does exhausting the
  attempt bound: that escalation was answered by no judge, it names the approaches spent, and
  spending attempts settles no problem.

```json
{
  "stage": "understanding_review",
  "task": "Plan the dashboard slice",
  "proposal": "...",
  "approach": "split the export item into narrower checkable items",
  "answers": ["the export module and its own test are now in the plan and named in the proposal"],
  "options": [ { "id": "approve", "label": "...", "meaning": "..." } ],
  "evidence": [ { "kind": "user", "source": "task prompt", "quote": "..." } ]
}
```

`answers` is positional: entry *i* answers problem *i* of the numbered list the refusal delivered. A
blank entry is a submission defect (refused before the judge call), and `answers` never resets the
rework budget - a submission that only re-words its answers is still the same submission.

Where the obligation cannot be enforced, and why:

- **Reviews stay advisory.** A finding obliges that review stage (the next review of it is not
  recorded as a pass until it answers), but a review holds no boundary, so nothing is blocked by it.
- **Stages whose refusal carries no confidence** (`claim_check`, `requirements_formalization`,
  `plan_mapping`, `acceptance_criteria`, `requirement_priorities`, `refactor_marking`) return derived
  marks rather than a judged refusal with a confidence, so no obligation is recorded for them: their
  refusals are surfaced exactly as before.
- **The acceptance side of the hand-off gate** runs on `message_end`, where the host cannot refuse a
  result: the verdict is recorded and fed back, never enforced.
- **The automatic periodic course check** is background and advisory by construction: it blocks
  nothing and spends no rework, so it creates no obligation.
- **Across stages** the obligation is per task+stage: a standing problem on one stage does not stop a
  submission on another, and only that stage's own boundary (the plan gate, the completion gate, the
  course-check pass) reflects it.
- `refactor_inventory` consults no judge at all (a declaration is not a question), so it can never
  carry an obligation.

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
`skill_routing` or `model_routing` stage to get a choice. An approved model is enforced at the next
subagent spawn. An approved skill takes effect in the running session: the controller delivers it to
the executor as an aside through the same channel every other verdict uses - the skill's id, its
label and the owner's own statement of what choosing it commits to - and records it in session state
as `routedSkill`. Nothing is delivered and nothing is recorded on a verdict other than `approve`; the
configured candidate list stays the only source a skill can come from. What the extension cannot do
is install a skill into the prompt: it delivers the selection, and the executor applies it from the
skill's own files. `allowlist` defaults to the model candidate
list; a model outside it is excluded before the judge sees it. Without candidates the stage refuses
explicitly - no candidates, no routing.

## Refactoring: the inventory and the marking (FR-13)

A refactoring is checked in two steps, and the first one has a deadline of its own.

1. BEFORE the first code edit of the task, submit `stage=refactor_inventory` with `inventory`: one
   `{id, name, verification}` per old function, where `verification` is the command that checks that
   function. The inventory is recorded in session state and delivered back into the session. A
   submission that arrives after the first edit is refused: an inventory written afterwards cannot
   establish what existed before the refactoring.
2. AFTER the refactoring, submit `stage=refactor_marking` with `inventoryMarks`: one
   `{id, evidence}` per inventory item, the evidence being that item's own artifact material - a code
   quote, a command output or a log excerpt. The judge marks every item `preserved` or `lost` from
   its own material. An item it can only mark `not_evidenced` (the material is a claim, or belongs to
   another item) keeps completion blocked under that item's id: the stop boundary names it and the
   work is not finished. The executor's own report is not evidence - material that is not an artifact
   is refused before the judge is asked.

The marking is bound to the work revision it was made at: any code edit after it makes the marking
stale and the boundary names every item again. A task that never recorded an inventory is unaffected.
The separate `capabilities` list still drives the completion coverage check (every declared
capability must be marked `applicable_and_addressed` from artifact evidence); the inventory is the
FR-13 path, where each item carries its verification command and its own preserved/lost marking.

```json
{
  "stage": "refactor_inventory",
  "task": "Refactor the export pipeline",
  "proposal": "Record the old functions this refactoring touches before the first edit.",
  "options": [{ "id": "recorded", "label": "Recorded", "meaning": "the inventory is recorded" }],
  "evidence": [{ "kind": "user", "source": "task prompt", "quote": "refactor the export pipeline" }],
  "inventory": [
    { "id": "export-json", "name": "exportJson()", "verification": "bun test tests/export.test.ts -t json" }
  ]
}
```

The inventory step consults no judge - a declaration is not a question; the marking is what is judged.
`proposal` and `options` stay required by the tool schema on both stages.

## Catalog checks

At the start of a new task the extension classifies it (development / analytics / query) and marks
the applicable plan topics through the judge against the bundled catalog. Both results are recorded
in session state and delivered as same-session feedback. The checks are advisory and non-blocking:
the task starts immediately, and an abstention, a judge failure or an unwired catalog records
uncertainty instead of stopping the work.

## Activities

The control points above (and below, in Stages) are the MECHANISM: each one declares where a
judge consultation fires and how its verdict acts. The ACTIVITY registry (`src/activities.ts`) is
the frame that says which mechanism belongs where: the named unit of work, its purpose, its
entrance boundary, the evidence it needs, its FIXED outcome set, its invariants and the outcome ->
action map the caller follows.

| Activity | Enters when | Evidence required | Outcomes | Invariants | Course mechanism | Enforcement |
| --- | --- | --- | --- | --- | --- | --- |
| `task_definition` | a new task prompt | the user's words verbatim | understood / incomplete / wrong / ask_user | the task is quoted, never paraphrased; an abstention escalates, never blocks | every later activity cites the requirement that authorizes the work | advisory today (plan gate covers it when armed) |
| `requirements_formalization` | after `task_definition`, before planning | user/spec quotes | formalized / item_untraceable / coverage_missing / ask_user | every formalized requirement carries a verbatim quote; a requirement without a quote is refused; every acceptance criterion references an accepted requirement | the formalized list becomes the checklist every later activity is judged against | advisory (`on_demand` records no approval) |
| `planning` | before the first mutation | the requirement list + the plan as a claim | approved / revise / insufficient_evidence / ask_user | no mutation before an approved plan (switchable); an open plan summary is not judgeable; the judge sets the order over the accepted items | the plan must name, for each requirement, the work that serves it; the judge's order is what the work follows | gate (`gates.mutation`), plus `claim_check` |
| `development` | after every mutation, at step boundaries | current action + requirement quote + progress artifacts | continue / return_to_requirement / replan / ask_user / verify_before_proceeding | an abstention never records continue; only a judged continue unlocks completion | per-requirement drift marking, deliberately and automatically | advisory (`course_check`), plus the destructive and hand-off gates |
| `review` | on demand, and before completion | code/diff quotes, execution output | accept / rework / escalate | the judge reads artifacts, not the author's report | the review is per requirement and per capability | advisory (`code_review`, `claim_check`, `aspect_coverage`) |
| `completion` | session stop | execution/code/log evidence per requirement, capability inventory | complete / incomplete / insufficient_evidence / ask_user | no completion without artifact evidence; a report alone never completes | the requirement list is the completion checklist | gate (`gates.completion`) |

How each activity is armed:

- `task_definition` - nothing to arm. The prompt is captured at `before_agent_start` (the
  requirement every gate quotes) and classified by the catalog check. Approval is the plan gate's
  when it is armed; nothing in this activity blocks on its own.
- `requirements_formalization` - always submittable, never gate-granting. Submit the draft
  numbered list and the user/spec quotes; the judge marks every item's traceability and every
  quote's coverage in one request. Every item names the submitted quote it derives from
  (`quoteId`); an item naming no quote, or an id that is not among the submitted quotes, is
  refused before any judge call - an item without a verbatim quote never enters the list. A
  completely accepted list is stored as the task's requirement checklist, keeping each item's
  number and its quote's verbatim text beside it; an item no quote entails comes back as
  `item_untraceable` and a quoted source no item captures as `coverage_missing` - both name what
  is missing, and neither becomes the checklist.
  The activity also owns FR-20: `stage=acceptance_criteria` formalizes the acceptance criteria of
  the ACCEPTED list. Each criterion is `{requirementId, text}`, the id being an accepted
  formalized requirement; a criterion referencing no accepted requirement is refused before any
  judge call, and the judge marks every criterion in one request against the referenced
  requirement's verbatim quote. An unmarkable answer fails closed with no criteria record, a
  criterion the judge does not accept is refused by name, and the completion boundary names every
  unaccepted criterion (and any criteria formalized from a retired requirement batch). A criteria
  list is advisory like the rest of this activity: it grants no gate.
- `planning` - armed by `gates.mutation` (default on) for the plan approval itself. Once a list is
  formalized, the plan gate additionally demands two things: the per-requirement mapping
  (`stage=plan_mapping` with `planClaims`, one `{requirementId, claim}` per formalized requirement
  id, the claim being that the plan serves it; the claim-check path marks each claim against the
  quoted evidence), and the judge's ORDER over the accepted items (FR-21, `stage=requirement_priorities`).
  The order needs no list from the executor: the controller supplies the accepted requirements, the
  judge assigns each one a priority class in one request, and the controller derives the order from
  those marks (tie-break: the item's position in the accepted list). The record carries the order,
  every ranked item's number and verbatim quote, the class marks with their confidences and the
  identity of the batch it ranks; a partial answer, or a class mark below the product's marking
  threshold (0.5 - the boundary per-claim, per-aspect and per-item requirement markings use, not the
  0.8 approval floor, which a live four-way class Choice never reaches) records no order. A new accepted
  batch retires the recorded order by name (the record keeps the reason) and the gate stays shut
  until a second judged call replaces it, recording the batch it superseded. Work that starts on an
  item the order ranks later than an unclaimed earlier item is NAMED in the session and recorded in
  the order (`outOfOrder`) - naming, never a block. A formalized requirement with no supported claim,
  or an accepted batch without a current order, leaves planning incomplete: the mutation gate names
  those ids and the stop boundary names them too. Without a formalization none of this is demanded
  and the gate behaves exactly as before.
- `development` - `course_check` is always submittable and can additionally run automatically: with
  `courseCheck.everyMutations` set, the controller consults the judge after the matching successful
  result of every Nth allowed mutating tool call and feeds the verdict back into the same session.
  It quotes the result's text as bounded execution evidence; an errored, missing or textless result
  cannot establish progress. The automatic consult is advisory (it never blocks, never spends the
  rework budget and never satisfies the completion boundary) and checks against the formalized list
  when one exists - each item's number with the verbatim source quote it names - else against the
  task prompt as the single requirement. A sub-floor or internally inconsistent judge answer is
  recorded as uncertainty, while a judge that could not be consulted is reported as not judged.
  The destructive-action gate and the hand-off gate are armed by `gates.destructive.patterns` and
  `stages.subagent_handoff` respectively. The FR-13 refactoring steps live here too: submit
  `refactor_inventory` before the first code edit of the task, `refactor_marking` after the work, and
  the stop boundary names every inventory item left without an evidence-backed marking.
- `review` - always submittable, never gate-granting.
- `completion` - armed by `gates.completion` (default on).

Every activity maps to at least one wired mechanism, every mechanism's stage is a registered
control point (or a controller-driven consult declared as such), and every declared outcome is
reachable from one of the activity's edges. An activity declared without a wired mechanism, or a
registered control point belonging to no activity, fails the test suite (`tests/activities.test.ts`)
- the spec calls that a defect. Outcome sets are enforced at runtime, not only in tests: an engine
answer the owning activity cannot express in its declared set fails closed (`insufficient_evidence`,
`judged: false`, naming the activity and the answer) instead of being recorded.

Use `stage=requirements_formalization` to formalize the task/spec, `stage=acceptance_criteria` for
the acceptance criteria of the accepted list and `stage=requirement_priorities` to let the judge
set the order (that one needs no list from the executor):

```json
{
  "stage": "requirements_formalization",
  "task": "Formalize the requirement list of this task",
  "proposal": "the numbered list derived from the quoted user requirement",
  "options": [{ "id": "formalized", "label": "Placeholder (required by the tool schema)",
                "meaning": "the formalization judge reads task, requirements and evidence" }],
  "requirements": [
    { "text": "the dashboard shows feature X", "quoteId": "quote-1" },
    { "text": "feature X survives a restart", "quoteId": "quote-2" }
  ],
  "evidence": [
    { "kind": "user", "source": "task prompt", "quote": "the dashboard must show feature X after loading" },
    { "kind": "spec", "source": "task prompt", "quote": "a restart must not lose feature X" }
  ]
}
```

With mock-free live judging the same submission came back as a numbered list with per-item
markings plus the coverage verdict naming the uncovered quote (`traceable: req-1 false, req-2 true,
req-3 false` for a fabricated item; `covered: quote-1 false, quote-2 true, quote-3 true`) - the
requirement list itself, not only a verdict.

The same three records then read as one chain: the accepted list (number + verbatim quote per item),
the criteria (`{requirementId, text}` per criterion, each with the judge's mark and the referenced
requirement's quote) and the order (`rank`, `requirementId`, `priorityClass`, `confidence`, `quote`
per item).

## One mechanism: descriptors, modes, deadlines

Every judge consultation the controller runs itself is a DESCRIPTOR in a single registry
(`src/gates.ts`, `GATE_REGISTRY`); the three gates and the three review activities are the same
mechanism in different modes. The review question sets and their runner live in `src/reviews.ts`.
A descriptor declares:

| Field | Meaning |
| --- | --- |
| `stage` | the registered control point the consult is filed under |
| `mode` | `blocking` - refuse only on a confident explicit negative; `advisory` - record and surface, never refuse |
| `trigger` | the control-point trigger the controller enforces (`mutation_gate`, `session_stop`, `on_demand`) |
| `boundary` | where the mechanism is reached (the host handler, or the submission path) |
| `armedBy` | the owner switch that arms it |
| `evidenceRequired` / `evidenceKinds` | what a consult must quote |
| `consult` | the frame: fixed question + claim shape built from the subject verbatim + offered options + refusal option (blocking); the fixed question set (review); or the approval binding (the plan gate) |

The six descriptors:

| Descriptor | Stage | Mode | Consulted by |
| --- | --- | --- | --- |
| `plan_mutation` | `understanding_review` / `direction_review` (+ `completion_review` at the stop) | blocking | the approval store, checked at `tool_call` and `session_stop` |
| `subagent_handoff` | `subagent_handoff` | blocking | `before_subagent_spawn` (dispatch) and the delivered delegated result (acceptance) |
| `destructive_action` | `destructive_action` | blocking | `tool_call`, for a `bash` command matching `gates.destructive.patterns` |
| `business_review` | `business_review` | advisory | submission (`stage=business_review`) |
| `architecture_review` | `architecture_review` | advisory | submission (`stage=architecture_review`) |
| `security_review` | `security_review` | advisory | submission, opt-in (`stage=security_review`) |

The two modes are structural, not conventional: a `decision` consult carries the refusal option and
the deadline, a `review` consult carries neither, and the registry validator
(`validateGateRegistry`) refuses a review that is not advisory, an advisory gate that carries a
refusal path, a refusal option that is not in the offered set, a descriptor whose stage is not a
registered control point, and any deadline at or above the host's 30s handler ceiling. Adding a gate
or a review is adding a descriptor - there is no second code path.

Deadlines: the internal consult deadline fires before the host does and takes the conservative path
for its event. On `tool_call` the host's timeout is fail-closed (it blocks), so a destructive-gate
verdict arriving after the deadline is never read (the command proceeds, the uncertainty is
recorded); on `before_subagent_spawn` the host drops a timed-out handler result and proceeds, so the
dispatch deadline has the same effect. The acceptance consult and the reviews are not on a
host-bounded handler: they run in the background or inside the tool call.

## Reviews: business, architecture, opt-in security

Three review activities are stages with FIXED question sets, recorded per-item results and no
blocking at all (judge verdict: business 0.86 and architecture 0.92 must-be, security 0.46 opt-in;
spec in `evidence/review-activities.md`):

- **`business_review`** - subject: the product as it stands, the customer's goal and problem, and
  the executor's decisions under review. Questions: how likely the product is to produce the
  promised outcome (0..9 rubric), how much of the described work serves it (0..9 rubric), a choice
  over the DECLARED risk candidates, the fixed statement "the product's value is unverified", and
  one statement per declared decision ("this decision serves the outcome and should be kept").
- **`architecture_review`** - subject: a module inventory, the test inventory, the observed
  duplication, the invariants. Questions: how well the implementation absorbs the next change
  (0..9 rubric), one statement per declared defect ("a maintainability defect that must be
  repaired"), a choice over the DECLARED candidate changes.
- **`security_review`** (opt-in) - subject: the declared surfaces. Questions: one statement per
  declared surface ("opens an attack or disclosure path"), a choice over the same declared surfaces
  for the single worst.

Submit them through `jev_decision` like any stage: `task` says what is under review, `evidence`
carries the quoted material, `claims` lists the declared items (decisions, defects, surfaces) - one
statement question per item - and `options` is the declared candidate set for the choice question.
The whole set goes to the judge in ONE request; the recorded result carries the scores with their
confidences, the chosen candidate and every per-item verdict (`JevState.reviews[stage]`), and the
same-session feedback names the findings. A review never refuses an action: only a confident
negative STATEMENT (per the question's polarity - a declared defect marked true, a decision marked
"do not keep", the value-unverified statement marked true) is reported as a finding to answer; an
abstention, a judge error, a low or absent confidence, a frame escape or a deadline loss records the
uncertainty and surfaces it, and a review never records a gate approval or a blocker.

A review costs a judge call, so it runs on demand (never on a timer). The question sets above are
the shipped defaults; an owner may replace them per stage through `stages.<stage>.questions`
(`[{id, kind, question, rubric?|noul?|candidates?, perItem?, findingWhen?}]`), fail-closed on
anything malformed.

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
  consultations do. The check also runs on its own when the owner sets
  `courseCheck.everyMutations`: on the matching successful result of every Nth allowed mutating tool
  call, the controller consults the judge in the background with a bounded quote of the result.
  It checks against the formalized requirement list when one exists - each item's number with its
  verbatim source quote - else against the task prompt as the single requirement. It records the
  verdict and feeds it back into the session.
  That automatic record is advisory - it never
  blocks, spends no rework budget and does not satisfy the completion boundary, which still needs a
  deliberate `course_check` with `continue`. Its three outcomes stay apart: a judged answer that
  cannot be acted on (a `continue`/`verify_before_proceeding` below the confidence floor, or a
  `continue` contradicting its own per-requirement markings) is stored as recorded uncertainty
  (`belowFloor: true` with the answer, its confidence and the judge's reasons) and surfaced as
  uncertainty, while only a judge that could not be consulted at all reads as not judged.
- **aspect_coverage** (`on_demand`): claimed aspects (catalog topic ids) are three-way marked by the
  judge against the topic catalog; `applicable_not_addressed` blocks completion until a later
  submission clears it. Completion capability coverage uses the same judge with `requireAll`, so a
  capability counts only when the judge marks it addressed from artifact evidence - mentioning its
  name is not enough.
- **claim_check** (`on_demand`): several claims judged in one request, one verdict per claim (see
  Claim check above). Advisory: it records per-claim markings in the session state and nothing else -
  no gate approval, no block.
- **subagent_handoff** (FR-11, `on_demand`, opt-in): when the config declares
  `stages.subagent_handoff`, the controller judges the work order of a task tool call before the
  spawn (`before_subagent_spawn`) against the requirement captured at task start. Only a judged
  `revise` at or above the confidence floor refuses a spawn; an abstention, judge error, low
  confidence, frame escape, missing or unattributable work order records the uncertainty and lets
  the work proceed. The captured work order is retired when the SPAWN is judged, never when the task
  tool's own `tool_result` arrives: omp 18.6.3 emits that result before `before_subagent_spawn`
  (measured 21:11:31.698 vs 21:11:31.705), so retiring on the result made the dispatch consult inert
  in the real host (`evidence/smoke-gates-findings.md`, F1). The acceptance side is a separate,
  explicitly opt-in switch - `gates.handoffAcceptance` - because omp's task tool returns a spawn
  acknowledgement, not the delegated result: the acceptance consult judges the result the host
  DELIVERS (`message_end` with the `async-result` delivery omp builds for a settled background job,
  `src/session/async-job-delivery.ts`), and the acknowledgement is never judged (F2). The host hook
  cannot refuse a delivery, so a confident negative is recorded as an unresolved blocker and fed
  back into the session. Undeclared, the stage is still submittable through the tool but no hand-off
  check runs - the PRD marks this policy unconfirmed (GAP:3).
- **destructive_action** (POLICY-DRAFT I, `on_demand`, opt-in): one descriptor, one option set, one
  refusal rule, two triggers.
  - The **command** trigger: when the config sets a non-empty `gates.destructive.patterns` list, a
    `bash` command matching any pattern is judged before it runs, with the command and the session
    task as evidence - a fresh execution-time decision the plan never covers (POLICY-DRAFT class I,
    `always_judge` 0.88). Patterns are case-insensitive literal substrings (whitespace collapsed), so
    pattern text is data and never a regular expression. An absent or empty list means this trigger
    does not exist (default off).
  - The **outside-root write** trigger: when the config sets `gates.destructive.outsideProjectWrites:
    true` (off by default, independent of the pattern list), a `write`, `edit` or `ast_edit` call
    whose target is a plain filesystem path outside the project root is judged before it runs, with
    the tool name, the target path(s) and a verbatim prefix of the content it would write as
    evidence. The project root is the working directory the config loader reads
    `<cwd>/.omp/jev.config.json` from; a relative target resolves against it and an absolute one is
    used as it stands. This is the path that was invisible before: the live session that wrote
    `/tmp/jev-smoke.ts` from a project elsewhere did so under a tool name no pattern list can reach
    (`evidence/measurement-2026-10-08-horizon/raw/horizon-api-control-r1.stdout.jsonl:3036`).
  Both triggers: only a judged `revise` at or above the confidence floor refuses the call; an
  abstention, a judge error, a low confidence, a frame escape or a verdict past the 25s internal
  deadline records the uncertainty and lets it run, and neither trigger ever approves anything
  (nothing is unlocked by not refusing). A `stages.destructive_action` template may replace the
  option set of both.
- **reviews** (`business_review`, `architecture_review`, `security_review`; `on_demand`,
  advisory): the review activities above. They record per-item results and surface them; they never
  refuse an action and never record an approval.

The three gates and the three reviews are descriptors of ONE mechanism (see "One mechanism" above):
`src/control-points.ts` still says where a stage fires, `src/gates.ts` says what each gate/review is
and how its answer acts, and the controller runs every consult through the same runner.

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
a fresh budget, so honest iteration cannot deadlock a stage. On top of that digest budget runs the
approach loop (see "Rework loop" above): an approach already spent on the stage is refused before
the judge is called, a new approach is a new attempt, and N distinct approaches exhaust the stage as
an OPEN item instead of being re-worded. Approvals bind to a task fingerprint,
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
| `requirements_formalization` | `on_demand` | numbered requirement list: per-item traceability + coverage verdict (activities framework); every item names the verbatim quote it derives from, an item naming none or an unknown one is refused before the judge call | `stages.requirements_formalization` |
| `acceptance_criteria` | `on_demand` | FR-20: acceptance criteria, one `{requirementId, text}` per criterion; an unreferenced or unknown reference is refused before the judge call, the judge marks every criterion, and unaccepted criteria are named at the stop boundary | `stages.acceptance_criteria` |
| `requirement_priorities` | `on_demand` | FR-21: the judge assigns a priority class to every accepted requirement in one request and the controller derives the order (documented tie-break); the record carries the order with each item's verbatim quote, a new accepted batch retires it by name | `stages.requirement_priorities` |
| `plan_mapping` | `on_demand` | per-requirement plan claims, marked by the claim-check path (planning activity) | `stages.plan_mapping` |
| `skill_routing` | `on_demand` | skill choice from `routing.skills`; an approved skill is delivered into the session and recorded | `stages.skill_routing` |
| `model_routing` | `on_demand` | model choice from `routing.models` | `stages.model_routing` |
| `refactor_inventory` | `on_demand` | FR-13: the old functions of a refactoring, each with its verification command, fixed before the first code edit; a later submission is refused | `stages.refactor_inventory` |
| `refactor_marking` | `on_demand` | FR-13: per-item preserved/lost marking after the refactoring, judged from each item's own artifact material; an item without material keeps completion blocked by name | `stages.refactor_marking` |
| `subagent_handoff` | `on_demand` | FR-11 hand-off check: dispatch before the spawn, acceptance on the delivered result (opt-in) | `stages.subagent_handoff` |
| `destructive_action` | `on_demand` | execution-time judge of a destructive `bash` command, and of a `write`/`edit`/`ast_edit` targeting a path outside the project root (both opt-in) | `stages.destructive_action` |
| `business_review` | `on_demand` | business review: two 0..9 scores, declared-risk choice, value statement, one statement per declared decision (advisory) | `stages.business_review` |
| `architecture_review` | `on_demand` | architecture review: 0..9 quality score, one statement per declared defect, declared-change choice (advisory) | `stages.architecture_review` |
| `security_review` | `on_demand` | security review: one statement per declared surface, worst-surface choice (advisory, opt-in) | `stages.security_review` |
| `important_decision` | `on_demand` | FR-10: an important decision put to the judge through fixed options | `stages.important_decision` |
| `code_review` | `on_demand` | FR-10: a finished code review put to the judge | `stages.code_review` |

`stages.<stage>` takes `instructions` (appended after the built-in untrusted-evidence policy) and
`options` (a full replacement option set: at least 2 items with unique ids, each `{id, label,
meaning}`). A review stage additionally takes `questions`: the fixed question set that replaces the
shipped one (`[{id, kind: "score"|"choice"|"noul", question, rubric?|noul?|candidates?, perItem?,
findingWhen?}]`), fail-closed on anything malformed. Only registry stages are valid keys - an unknown
stage key is a config error.
`course_check` keeps its fixed next-action ids unless a template replaces its options.

A config can also declare extra control points: `controlPoints.<name>` with
`{ "trigger": "on_demand", "instructions"?, "options"? }`. The name must match
`^[a-z][a-z0-9_]{2,63}$` and must not collide with a built-in preset; a declared point is judged
like any other stage but never blocks a tool call and records no gate approval - its verdict is
recorded and fed back, while rework is still counted (`mutation_gate` / `session_stop` triggers for
custom stages are a roadmap item).

Two further judge consultations run automatically at task start and are not submittable stages:
task classification (`development` / `analytics` / `query`) and plan-topic selection - the catalog
checks above. A third automatic consultation can run on completed mutations: with
`courseCheck.everyMutations` set, `course_check` runs after the matching successful result of
every Nth allowed mutation (see the preset above).

## Config

Two files, merged per key: `<cwd>/.omp/jev.config.json` (project) and
`~/.omp/agent/jev.config.json` (user). Missing files are the normal defaults case; a present but
invalid or unreadable file is a fail-closed error that keeps the gates registered and closed, naming
the file and the problem.

```json
{
  "gates": {
    "mutation": false,
    "destructive": { "patterns": ["rm -rf", "git push --force", "drop table"], "outsideProjectWrites": true },
    "handoffAcceptance": true
  },
  "courseCheck": { "everyMutations": 5 },
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
- `courseCheck` - `everyMutations` (integer >= 0, default off). User-owned like the gates: the user
  value wins when it sets the key. With N >= 1 the controller submits a `course_check` itself on the
  matching successful result of every Nth allowed mutating tool call, with its bounded text result
  as evidence; an error result triggers no consultation. An absent key or 0 leaves deliberate
  submissions unchanged. The automatic consult never blocks, never spends the rework budget and never
  satisfies the completion boundary. A malformed block fails closed naming the file and the key.
- `gates` - `mutation` and `completion` booleans (both default true) plus the `destructive` block.
  Merged per key, never whole-block: a user file that declares only some switches does not drop the
  project's others, and `destructive.patterns` is a union a project may add to but never remove (a
  live defect on 2026-10-08: the gate could not be armed from a project file). `gates.mutation:
  false` lifts the plan gate (mutating tools are no longer blocked while no plan-stage approval
  exists) and `gates.completion: false` lifts the stop gate; both switch block decisions only:
  judging, content digests and bounded rework are unchanged. `gates.destructive` takes two keys,
  merged per key: `patterns` (an array of non-empty strings, required) arms the execution-time
  destructive gate's command trigger - an absent or empty list means that trigger does not exist;
  `outsideProjectWrites` (a boolean, optional, off by default and validated as a boolean) arms its
  second trigger, the judgement of a `write`/`edit`/`ast_edit` whose target is a path outside the
  project root. The two triggers are independent in both directions: an empty pattern list does not
  disarm the write trigger, and arming the write trigger does not judge any command. The FR-11
  hand-off gate is not a `gates` switch: it runs only when
  the config declares `stages.subagent_handoff` (see the preset above). Its acceptance side - the
  check of the delegated result the host delivers - is a separate opt-in boolean,
  `gates.handoffAcceptance` (default false), because it depends on the host's background-result
  delivery rather than on a handler the smoke run has verified.

Meta options cannot be removed: they are appended to every judge choice regardless of any template.

## Limits

- The mutation gate covers the builtin tools `edit`, `write`, `ast_edit`, `bash`, `memory_edit`,
  `manage_skill`, `learn`, `retain` and `eval`; custom/MCP/xdev tools are outside it. A `write` whose
  `path` is exactly `xd://jev_decision` dispatches to the mounted judge device and bypasses the
  mutation gate, without granting an approval. Messages to `agent://` addresses also bypass the
  gate so task agents can report blockers. Other `write` targets remain gated. The gate also
  treats read-only `bash` commands as mutation-capable; use `read`, `glob` or `grep` to gather evidence
  before plan approval. `learn` and `retain` write the same user-level state as `memory_edit` and
  `manage_skill` (a lesson into long-term memory, and - with `learn` - a managed skill): the live session that
  made two `learn` calls wrote long-term memory and created a managed skill while the gate had
  nothing to bite. The remaining memory/context builtins (`checkpoint`, `rewind`, `context_notes`,
  `new_context`, `recall`, `reflect`) are NOT in the set, so they are not mutation-gated; the fix
  also has no effect where `gates.mutation` is off, which is how the same session was configured.
- The destructive-action gate has two triggers and two documented reach limits.
  - The **command** trigger covers `bash` only, reading the command from the tool call's `command`
    field, and matches the owner's patterns as case-insensitive literal substrings - a pattern is
    data, never a regular expression, so an owner typo cannot silently change what matches. It does
    not read a `bash` command's own file targets: a shell redirect or `sd`-style rewrite outside the
    project root is covered only if its text matches a pattern.
  - The **outside-root write** trigger covers the plain filesystem targets of `write`, `edit` and
    `ast_edit` calls: the `path`/`file_path` argument, the `paths` array, and - for `edit` - the
    targets named inside its own payload (the hashline `[PATH#TAG]` section headers and the
    apply-patch `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:`
    directives). The `MV` destination of a hashline move is NOT read. A target carrying a `://`
    scheme is never read as a filesystem path, so a `write` to an internal URL or a mounted tool
    device (`xd://<device>`, `local://`, `agent://`, `proc://`) reaches no judgement here, and neither
    does an archive or SQLite selector target. It cannot see the write tool's own `chmod +x` on a
    shebang file: that happens inside the tool call, after the boundary the handler runs at, so the
    permission change is inferable from the written call but never judged on its own. Reads are never
    affected: only a mutating call's target is read, and the plan gate's existing rules for mutations
    inside the project are unchanged.
  Both triggers are opt-in (`gates.destructive.patterns` for the first,
  `gates.destructive.outsideProjectWrites` for the second) and the second costs one judge
  consultation per out-of-root write, on a frame whose live record is abstention-prone (the
  command trigger's two live runs answered 0.38 and 0.4). A call the plan gate already refused is
  not judged: the plan gate's handler runs first and a block short-circuits the event.
- Gates are per session: each subagent session gets its own controller (own gates, approvals and
  state), and the parent's controller does not see the subagent's tool calls - the one cross-session
  hook is `before_subagent_spawn`, where the routed model is enforced. `session_stop` never fires for
  task/subagent sessions, so the completion gate applies to the main session only.
- `tool_result` cannot refuse a tool call: a handler may only rewrite its content, details or error
  flag, so the FR-11 acceptance verdict is recorded and fed back instead of blocking the call (and
  the acceptance consult runs on the delegated result the host delivers, not on that tool result).
- The FR-11 hand-off check reads the work order from the `task` tool call (keyed by toolCallId),
  because `before_subagent_spawn` carries neither the prompt nor a toolCallId. A spawn is judged only
  while exactly one captured order is pending: with parallel task calls the spawn cannot be
  attributed and nothing is judged, an `eval` `agent()` spawn is never judged, and captured orders
  are dropped when the task changes, after 2 minutes, or when the spawn that consumed them settles
  (the order is retired on the SPAWN, not on the task tool's own `tool_result`, which omp emits
  first - see F1 in the hand-off gate above).
- Provider prompt-cache hits for the Jev route are not claimed: that route reports exactly
  `input_tokens`/`output_tokens` and no cache field. The executor route does report them (`cacheRead`,
  `cacheWrite`) and a live cached-token hit was observed, but this repository contains no capture code
  for that route.
- The acceptance side of the hand-off gate is opt-in through `gates.handoffAcceptance` (off by
  default) because the host delivers the delegated result as a background completion; with it off,
  the spawn acknowledgement is recorded as not judged rather than judged wrongly.
- A dispatch refusal is recorded after the host's `task` tool result exists in the session (the
  verdict lands 299-428 ms later), so whether omp still cancels the spawn at that point is unproven:
  no refusal has been produced in a live run.
- The judge abstains on questions that rest on the owner's preference rather than on evidence in the
  request - "should this be built" asked of it returned `insufficient_evidence` (0.35-0.64) three
  times, and the product's fail-closed rule then leaves the decision unmade rather than guessing it.
  The obligation mechanism in "The answer obliges" was put to the judge the same way, in three
  approaches (a design choice, the three readings of the owner's sentence, and a contradiction claim
  against the quotes): all three came back `insufficient_evidence` (0.73 with `low_confidence`, 0.40,
  0.23), so the DESIGN is recorded OPEN - the behaviour is derived from the requirement, not from a
  judge approval, and it is the fail-closed rule that keeps a sub-floor or abstaining answer from
  obliging anything.
  The widened destructive-action boundary (the second trigger and frame, and the coverage of `learn`
  and `retain`) was put to the judge the same way, in three approaches (a design frame over quoted
  code and a session record; a narrow structural fact about the mechanism; the outcome stated with
  the artifacts that settle it): `approve` 0.28 (raw 0.38), `insufficient_evidence` 0.32, `approve`
  0.57 (raw 0.63) - all below the 0.8 floor, so the DESIGN is recorded OPEN. What the option
  questions say is unambiguous and is what the build follows: "a second trigger and frame in the
  existing descriptor" at 0.64 and then 0.84 probability against "a new blocking stage" at 0.25 and
  0.05 and "leave it bash-only" at 0.01 and 0.07; the second attempt's own narrow claim ("the
  judgement machinery is trigger-agnostic") was answered `not_established` at 0.87, which is why the
  descriptor's declared boundary, arming and evidence kinds were rewritten rather than left
  describing the old reach. No live run has yet produced a judgement from the write trigger; the
  frame's evidence kinds had to grow from `["spec","user"]` to include `code` and `log` for the
  quoted content, and the switch is off until an owner arms it.
- The product's value is not demonstrated in its own favour, and the fourth measurement is the
  decisive one. Three blind with-or-without runs first - a small-task set, a drift-prone set, and a
  horizon set on a frozen revision with the weakest cheap model the owner's configuration runs -
  found no outcome difference: across 136 requirement observations both arms kept everything, and the
  judge called every comparison a tie (in the decisive run of those three, a tie probability of 0.79
  and 0.76). A fourth run then went after the one task shape on which the cheap model genuinely
  fails: a refactor that must carry an edge-heavy behaviour surface through a rewrite, where the
  run's own signature declares an option field optional and its code rejects the absence. Paired
  runs, five per arm, one source revision proved single-revision (digest identical before and after,
  no `src/` file's mtime inside the run window), everything else held equal:

  | Arm | Requirements kept | The one failing requirement dropped | Mean wall time | Mean coding tokens | Judge consultations |
  | --- | --- | --- | --- | --- | --- |
  | plain omp | 43/45 | 2 of 5 runs | 52.2 s | 189,149 | 0 |
  | with this extension | 42/45 | 3 of 5 runs | 113.3 s | 692,262 | 21 |

  So: the extension did not rescue the failure, the 2-of-5 versus 3-of-5 difference is noise at this
  sample size, and what it cost is roughly double the wall time and over three times the coding
  tokens, plus judge traffic the control never pays. Across four measurements and 181 requirement
  observations, no run has this extension's arm doing better than the plain one. The one informative
  detail: in three of the five addon runs the extension made no requirement-level judgement at all
  (classification and topic selection only) and that requirement was dropped; in the single run where
  the requirement-level pipeline did run, the judge examined the section holding that rule, marked it
  satisfied at 0.90-0.91, and the requirement was kept - consistent with the consultation mattering,
  but one observation, and confounded by that session also being the longest and most thorough in the
  run. The weak model never called the decision tool on its own in any arm: every consultation came
  from the extension's automatic paths. `tools/measurement/` reproduces this and its self-test
  validates the checks first.
- Completion judging does not guarantee correctness.

## License

[MIT](LICENSE)
