# Changelog

## Unreleased

- **The invisible write paths are visible to the gate.** Two paths that ran unjudged now reach a
  judgement, both opt-in and both off by default:
  - The destructive-action gate (`destructive_action`) gained a **second trigger and frame**: a
    `write`, `edit` or `ast_edit` call whose target is a plain filesystem path outside the project
    root is judged before it runs, with the tool name, the target path(s) and a verbatim prefix of
    the content it would write as evidence. It is armed by the new owner switch
    `gates.destructive.outsideProjectWrites` (validated as a boolean, merged per key, off by
    default). The command trigger and its `patterns` list are unchanged, and the two triggers are
    independent: an empty pattern list does not disarm the write trigger, and arming the write
    trigger judges no command. The descriptor's declared boundary, arming rule, required evidence and
    evidence kinds were rewritten to describe both triggers (`evidenceKinds` grew from
    `["spec","user"]` to `["spec","user","code","log"]`), and the judgement record carries which
    trigger produced it. Why this and not a longer pattern list: the observed out-of-root write
    happened under the `write` tool, which the handler never saw at all (its first line rejected
    every non-`bash` call), so no pattern could ever have matched it - a live session wrote
    `/tmp/jev-smoke.ts` from a project elsewhere
    (`evidence/measurement-2026-10-08-horizon/raw/horizon-api-control-r1.stdout.jsonl:3036`).
  - The plan gate's mutating-tool set gained `learn` and `retain`, so they are covered exactly the
    way `memory_edit` and `manage_skill` already were - they write the same user-level state (a
    lesson into long-term memory, and, with `learn`, a managed skill). The live session that made two
    `learn` calls ran with the gate armed for `edit`/`write` and had nothing covering the calls that
    wrote memory and created a skill.
  Failure behaviour, unchanged and stated for both new paths: an abstention, a judge error, a
  sub-floor confidence, a frame escape and a missed deadline let the action run and record the
  uncertainty - none of them refuses and none of them approves; only an explicit `revise` at or above
  the confidence floor refuses, and a recorded approve unlocks nothing.
  The design was put to the judge before it was built, in three approaches and with a changed
  approach each time (a design frame over quoted code and a session record; a narrow structural
  claim about the mechanism; the outcome plus the artifacts that settle it): `approve` 0.28 (raw
  0.38), `insufficient_evidence` 0.32, `approve` 0.57 (raw 0.63) - all below the 0.8 floor, so the
  disposition is recorded OPEN, with the option question naming this design at 0.64 then 0.84 against
  0.25/0.05 for a new blocking stage and 0.01/0.07 for leaving it bash-only. The second attempt's
  narrow claim ("the judgement machinery is trigger-agnostic") was rejected at `not_established`
  0.87, which is what forced the descriptor's own declared boundary to be rewritten instead of
  re-used. Documented in README "Gates", "Stages", "Config" and "Limits", including what remains
  invisible: the write tool's own `chmod +x` (it happens after the boundary), internal-URL and
  mounted-device targets, archive/SQLite selectors, the hashline `MV` destination, `bash` file
  redirects outside the root, and the memory/context builtins (`checkpoint`, `rewind`,
  `context_notes`, `new_context`) that are not in the mutating set.
- Verification: `bun run typecheck` clean; `bun test` 392 pass / 0 fail / 1901 expect() calls / 17
  files (376 before; 16 added for this behaviour, each proven to fail when its rule is removed by a
  mutation check against the green baseline - eight mutations run: the two new tool names, the
  arming guard, the outside-root filter, the refusal rule, the deadline branch, the scheme rule, the
  config validation and the config merge).
- **The fourth measurement: the extension did not rescue the failure.** On the one task shape where
  the cheap model genuinely fails - a refactor that must carry an edge-heavy behaviour surface
  through a rewrite, the run's own signature declaring an option field optional while its code
  rejects the absence - five paired runs per arm on one revision kept 43/45 requirements for plain
  omp and 42/45 with this extension; the same requirement was dropped in 2 of 5 control runs and 3
  of 5 addon runs, at 52.2 s / 189,149 coding tokens against 113.3 s / 692,262 plus 21 judge
  consultations. At this sample size 2-of-5 versus 3-of-5 is noise, so the honest reading is that the
  product's premise - a cheap model's drift is caught by putting a judge in its path - is not
  demonstrated, and that a positive result would require the requirement-level judgement to actually
  run (in three of the five addon runs it did not: classification and topic selection only) plus a
  third arm with the judge disabled to separate the pipeline's effect from extra effort. Across four
  measurements and 181 requirement observations, no run has this extension's arm doing better than
  the plain one.

## 1.0.0 - 2026-10-08

- **The answer obliges: the standing problems of a refusal (PRD 1.1 / FR-10).** The owner's sentence
  - "если ты спросил судью и он сказал переделать значит выясняй что не так и переделывай" - is now
  the product's behaviour, not only advice. A judged refusal that names reasons at or above the
  confidence floor records those reasons verbatim as the standing problems of that task+stage
  (`outstandingRework`), delivers them into the same session as a numbered list, and shows them to the
  next consultation of that stage together with the executor's declared `answers`. While any problem
  is unanswered, no approval and no pass record of that stage is written - not the plan or completion
  approval, not the course-check `continue`, not the aspect-coverage or refactor-marking pass - and on
  a plan-granting stage the mutation gate stays shut even when an older approval exists. The
  obligation clears only on the judge's own approval of a submission that answered every problem, or
  on an escalation the judge answered (`ask_user`); exhausting the attempt bound clears nothing, and
  an abstention, a sub-floor or unquantified refusal, a judge error and a frame escape create no
  obligation and clear none: the fail-closed rule decides. A review finding is the one refusal that
  obliges without a choice-confidence, by the review's own contract.
  Documented in README "The answer obliges", with the places it cannot be enforced named there. The
  design was put to the judge in three approaches (a design choice, three readings of the owner's
  sentence, a contradiction claim against the quotes): all three abstained (0.73 low_confidence, 0.40,
  0.23), so the design is recorded OPEN and the behaviour derives from the requirement.
- `answers` is a new positional field of `jev_decision` (one entry per standing problem, in the order
  the refusal named them); a blank entry is refused before any judge call, and the field never resets
  the rework budget.
- Verification: `bun run typecheck` clean; `bun test` 376 pass / 0 fail / 1773 expect() calls / 16
  files (363 before; 13 added for this behaviour, each proven to fail when its rule is removed by a
  mutation check against the green baseline - the withhold guards, the recording and delivery, the
  judge-facing block, the clearing rule, the confidence floor and frame-escape filter, the restore
  validator, the `answers` validation and both boundary checks).

## 1.0.0 - 2026-10-08

First complete release. The product does one thing: the executor puts its business and architecture
decisions, and its finished code reviews, to an external judge through fixed-option questions and acts
on the answer. File edits and commands are not part of mandatory agreement; the plan gate is a
switchable backstop.

What is in it:

- **One mechanism, not one code path per gate.** `src/gates.ts` holds descriptors (mode, trigger,
  boundary, evidence kinds, consult shape); one runner races an internal deadline under the host's
  handler timeout, normalises the verdict and refuses only on a confident explicit negative.
  `validateGateRegistry` rejects an inconsistent descriptor at load.
- **Reviews as activities**: business, architecture and opt-in security, each with a fixed question
  set, one recorded result per question, structurally unable to block.
- **The requirements chain**: formalization with a verbatim source quote per item, plan mapping,
  acceptance criteria tied to accepted requirements, and judge-assigned priorities the work follows.
- **Routing that takes effect**: a judge-selected skill is delivered into the running session, and a
  routed model is enforced at the next spawn.
- **Rework with a changed approach**: bounded attempts, every attempt a different approach, a repeat
  refused before the judge is consulted.
- **Refactoring checked capability by capability**: an inventory with a verification command per item,
  then an evidence-backed marking per item, with unmarked items named at completion.
- A standalone CLI over the same code path, project and user configuration with a trust split
  (user-owned switches, raise-only thresholds), and a self-check runner that reviews this repository
  through its own judge.

Verification: `bun run typecheck` clean; `bun test` 363 pass / 0 fail / 1656 expect() calls / 15
files; an independent review of the previous revision found two must-fix and two should-fix defects
and all four are closed; a live omp smoke and a re-verification proved the hand-off and destructive
gates fire in the real host; the acceptance criteria were re-run and every stale line corrected.

Stated plainly, because a release should not hide it:

- **The product's value is not demonstrated.** Three blind with-or-without runs (a small-task set, a
  drift-prone set, and a horizon set on a frozen revision with the weakest cheap model the owner's
  config runs) found no outcome difference: over 136 requirement observations both arms kept
  everything, and the judge called every comparison a tie. What was measured is cost - judge
  consultations the control arm never pays, and in the decisive run roughly twice the wall time. The
  weak model never called the decision tool on its own; every consultation came from the extension's
  automatic paths. `tools/measurement/` reproduces this, and its self-test validates the checks first.
  A fourth measurement then ran the one task shape on which the cheap model genuinely fails - a
  refactor that must carry an edge-heavy behaviour surface through a rewrite, where the run's own
  signature declares an option field optional while its code rejects the absence - as five paired
  runs per arm on a single revision: plain omp kept 43/45 requirements and this extension 42/45, the
  same requirement dropped in 2 of 5 control runs and 3 of 5 addon runs, at 52.2 s / 189,149 coding
  tokens against 113.3 s / 692,262 plus 21 judge consultations. The extension did not rescue the
  failure and the 2-of-5 versus 3-of-5 difference is noise at this sample size, so the premise that a
  cheap model's drift is caught by putting a judge in its path is not demonstrated; a positive result
  would need the requirement-level judgement to actually run (in three of the five addon runs the
  extension never reached the requirement level, classifying the task and picking topics only) and a
  third arm with the judge disabled to separate the pipeline's effect from extra effort. Across four
  measurements and 181 requirement observations, no run has this extension's arm doing better than
  the plain one.
- Two decisions the owner delegated to the judge returned abstentions (which below-floor measures to
  build; whether the plan and completion checks should stop work), so neither was built or tightened.
- Several requirement formulations remain OPEN after three approaches each, recorded with their
  numbers rather than smoothed over.

