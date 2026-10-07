# Self-check runner

`bun tools/reviews/run.ts` (needs the judge key: `env TYPESAFE_API_KEY_COMMAND='pass show token/jev' bun tools/reviews/run.ts`)

It collects the repository facts itself - module inventory, test inventory and counts, the suite
result, the recent commits, the open task rows, the previous review - and asks the judge the fixed
review question sets: business (outcome likelihood, how far the goal is met, the biggest risk,
whether the value is measured), architecture (how well it is built, whether the largest module still
dominates, the single most valuable change), tests (does the suite protect behaviour) and process
(is the working loop sound). Nothing here blocks anything: it reports.

Output: `evidence/reviews/<timestamp>.md` - the verdicts with confidences, the facts the judge saw,
the recent commits, the open tasks, and a pointer to the previous run so movement is visible.

Why it exists (owner order 2026-10-08): "я хочу чтобы ты регулярно проводил проверки и без моего
участия ... как можно раньше создай механизм таких проверок и внедряй его в работу".

## Cadence (binding)

Run it after every wave of work lands, and before any commit that claims progress. Read the report
before deciding what to do next; a verdict that contradicts the plan is a finding, not a nuisance.
The product-side equivalent (the same question sets as review activities, fired automatically at the
boundary) is task D5.
