# Changelog

## Unreleased

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
- Two decisions the owner delegated to the judge returned abstentions (which below-floor measures to
  build; whether the plan and completion checks should stop work), so neither was built or tightened.
- Several requirement formulations remain OPEN after three approaches each, recorded with their
  numbers rather than smoothed over.

