# Changelog

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

