# Jevstice mandatory rules

These rules bind every Jevstice session, including a hurried one. `MUST` and `MUST NOT` are literal: a skipped `MUST` is a violation, not a preference.

## Before the first call

- MUST read the matching tool description in the tool list before the first call and use it as the call template.
- MUST NOT call a tool to probe it, and MUST NOT guess its parameters or discover its contract by failure.
- MUST quote the owner's exact words and the exact file text as evidence; MUST NOT paraphrase evidence.

## One request, one workflow

- MUST call `jev_triage` once per new owner request before any consequential change. Read-only inspection and skill reads pass without triage.
- When triage names the task development, MUST submit `jev_requirements` once with one checkable item per owner obligation. MUST NOT ask the owner to confirm the list.
- MUST pass `jev_plan_review` in this order: outline, one detail per step, finalize. MUST NOT change project files before final approval.
- MUST implement the approved plan. MUST NOT add unrequested scope.
- MUST submit `jev_acceptance` for both business and architecture, with observed execution and code evidence.
- MUST use `jev_consult` for a decision the code and the request cannot settle. MUST NOT guess a consequential decision.

## Judgments are verdicts

- A refusal, an inconclusive answer, a below-floor confidence, or a "revise" is a verdict about the submitted claim. It never approves.
- MUST change the evidence or the implementation before any retry.
- MUST NOT resubmit the same framing, with or without reworded text.
- MUST NOT record a below-floor or inconclusive answer as approval.

## Attempt limits

- Every boundary has a bounded number of refusals. A spent budget never turns a finding into approval.
- After the limit, the unresolved finding stays OPEN.
- MUST NOT claim approval and MUST NOT hide an OPEN finding.
- MUST verify the implementation normally.
- When the controller reports that the limit was reached, MUST retry the intended operation, not the refused submission.
- Continuation MUST come from the owner: `/jev-continue` or a standalone approval message. That permission is never Jev approval.

## Tool rules

- MUST use `jev_reaim` only when the owner actually changes direction, with the owner's message quoted verbatim. MUST NOT use `jev_reaim` to escape a refusal, reset the task, or restore an old direction.
- MUST use `jev_search_relevance` with one query, at least two candidates, and a reason for each.
- MUST submit `jev_text_review` the exact text and exact rules; `scope: "text"` judges the whole text once. MUST revise only the fragments it returns.
- MUST submit `jev_anti_slop` the exact external artifact, its declared audience and register, and the evidence for every claim before reporting an external deliverable complete. The shipped mode is advisory: report its findings, and the owner waives one with `/jev-waive <finding-id> <reason>`.
- MUST submit `jev_review` for a checkpoint, commit, or diff with changed-code evidence and verification output.
- A quiet request that only publishes, inspects, or verifies existing work needs no triage. A change still waits for the gates above.

## Tool examples

Every example below is the required call shape, not a suggestion. MUST copy every key and replace each `<...>` with the owner's exact text or the exact evidence. MUST NOT invent keys, omit required keys, or call a tool in another shape.

### `jev_triage`

```json
{"request":"<the owner's exact request>","topics":["<one narrow topic>"]}
```

MUST call it once before any consequential change.

### `jev_requirements`

```json
{"request":"<the same owner request>","items":[{"text":"<one checkable obligation>","source":"<the exact request line>"}]}
```

MUST derive every item yourself; MUST NOT ask the owner to confirm it.

### `jev_consult`

```json
{"mode":"choice","question":"<one decision>","context":"<the state that matters>","alternatives":[{"label":"a","meaning":"<what a commits to>"},{"label":"b","meaning":"<what b commits to>"}],"evidence":[{"kind":"code","quote":"<exact quote>","source":"<file>"}]}
```

For a yes-or-no decision use `{"mode":"boolean","question":"<one decision>","context":"<state>","trueMeaning":"<what yes means>","falseMeaning":"<what no means>"}`. MUST change the claim or the evidence before resubmitting a refusal.

### `jev_reaim`

```json
{"interjection":"<the owner's exact new words>","evidence":[{"kind":"user","quote":"<the same words>"}]}
```

MUST use it only on a real direction change; MUST NOT use it to escape a refusal.

### `jev_search_relevance`

```json
{"query":"<one search question>","candidates":[{"title":"<result>","url":"<url>","evidence":"<exact excerpt>","reason":"<why it answers the query>"},{"title":"<second result>","evidence":"<excerpt>","reason":"<why it answers or does not answer>"}]}
```

MUST submit at least two candidates; the reason is yours.

### `jev_plan_review`

```json
{"phase":"outline","steps":[{"id":"s1","summary":"<one high-level action>","requirement":"<exact approved obligation>"}],"evidence":[{"kind":"user","quote":"<owner words>"}]}
```

```json
{"phase":"detail","plan":"local://<slug>-plan.md","topic":{"id":"s1","section":"<exact heading or full section>","paths":["<changed path>"],"requirement":"<same exact obligation>"},"evidence":[{"kind":"code","quote":"<section text>"}]}
```

```json
{"phase":"finalize","plan":"local://<slug>-plan.md","evidence":[{"kind":"user","quote":"<owner words>"}]}
```

MUST pass outline, then one detail per step, then finalize; MUST NOT change project files before final approval.

### `jev_acceptance`

```json
{"aspect":"business","claim":"<what the owner asked and what the work achieves>","evidence":[{"kind":"execution","quote":"<command and output>","source":"<command>"},{"kind":"code","quote":"<changed code>","source":"<file>"}]}
```

MUST submit business and architecture separately, at the current revision.

### `jev_review`

```json
{"kind":"diff","target":"<file>","claim":"<what the change does>","evidence":[{"kind":"code","quote":"<changed code>","source":"<file>"},{"kind":"execution","quote":"<test output>","source":"<command>"}]}
```

MUST quote the changed code and the verification output.

### `jev_text_review`

```json
{"text":"<the exact text>","rules":[{"class":"<rule class>","rule":"<the exact rule line>","scope":"text"}]}
```

MUST revise only the returned fragments.

### `jev_anti_slop`

```json
{"artifact":"<the exact external text>","language":"<language>","register":"<register>","purpose":"<purpose>","audience":"<audience>","rules":[{"class":"<class>","rule":"<rule>"}],"claims":[{"id":"c1","text":"<claim from the artifact>","kind":"fact","evidence":[{"kind":"<source kind>","quote":"<quoted support>","sourceClass":"primary","source":"<source>"}]}]}
```

A hypothesis MUST use `"kind":"hypothesis"` and carry a `falsifier`. MUST report every finding; the owner waives one with `/jev-waive`.

## Bad cases

- Bad: a reworded `jev_triage` after the first verdict. This is brute force. MUST NOT repeat it.
- Bad: `jev_reaim` after a refusal, to reset the gates. MUST NOT use it that way.
- Bad: the same activity resubmitted until attempts run out. This is looping, not rework. MUST NOT do it.
- Bad: a tool called to discover its parameters. This is probing. MUST NOT do it.
- Bad: an inconclusive answer or an exhausted budget reported as approval. MUST NOT do it.
- Bad: completion claimed while a finding is OPEN. MUST NOT do it.

## Good cases

- Good: a new development request arrives; before any call the model MUST read the matching descriptions, then call `jev_triage` once and submit `jev_requirements` once.
- Good: the triage verdict names development; the model MUST use `jev_plan_review` in outline, detail, finalize order before changing files.
- Good: implementation is underway; an unsettled decision MUST go to one `jev_consult` with quoted evidence, a candidate search to `jev_search_relevance`, a text to `jev_text_review`, and a checkpoint to `jev_review`.
- Good: the plan is finished; the model MUST submit `jev_acceptance` for business and architecture, and MUST run `jev_anti_slop` before any external delivery.
- Good: the owner changes direction; the model MUST use `jev_reaim` once with the owner's exact words, then fresh requirements and a fresh plan.
- Good: a read-only question gets no `jev_triage` and no judge call; the model MUST answer it directly.
- Good: after a refusal the model MUST read its category, change the evidence or the implementation, and submit one retry.
- Good: when the budget is spent the finding MUST stay OPEN; the model MUST verify the work and ask the owner for continuation.
