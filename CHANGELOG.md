# Changelog

## Unreleased

- Replaced the automatic per-prompt topic catalog and the old decision workflow with explicit triage, search relevance, requirement checks, native plan review, flexible Choice/Score/Boolean consultation, course checks, separate business and architecture acceptance, and developer review.
- The boundaries close the gaps a live plan-mode run exposed: the plan title is normalized exactly as omp normalizes it (spaces to hyphens, unusable characters dropped, a trailing `-plan` not doubled), so `write xd://propose "Coverage report"` matches the approval of `local://Coverage-report-plan.md`; an approved plan survives the approve-and-execute session switch only while the copied artifact still hashes to the approved digest, and an ordinary clear or a later edit restores nothing; the first consequential change of a session waits for a triage decision, and a confirmed simple verdict covers only that request; a course check in flight holds further changes; a `jev_consult` answer clears a review hold only when it answers that finding; `jev_search_relevance` gained an explicit none-relevant option; a plan longer than 16,000 characters is refused before the judge is called instead of truncating an unseen tail.
- The judge adapter derives Boolean decision confidence from the yes probability (`max(p, 1-p)`), rejects score answers outside the submitted rubric, rejects non-`noul` Boolean fields, and reports a transport failure without echoing material that may contain the key.
- Kept simple read-only tasks free of automatic judge calls. Development actions and completion use visible, fail-closed boundaries; an unresolved judge answer does not grant approval.
- Removed the standalone CLI and the old runtime. The prior implementation is archived at commit `4c38d74`; its release notes and measurements remain in git history.
- Disabled the ordinary-session extension entry while the replacement is under verification. This section does not claim a release or a live-judge acceptance.
- Verification: `bun run typecheck` clean; `bun test` 117 pass / 0 fail / 393 expect() calls across 8 files; a live host launch (`omp -p -e ./src/index.ts`) held the first write with the triage reason while `jev_triage` stayed callable. A follow-up live run drove all seven activities through the production judge adapter (jev-1.13.0, 21 calls, `evidence/live-jev-acceptance-2026-10-08.md`, gitignored): triage registered the development task at 0.98, business acceptance was approved at exactly the 0.80 floor on a single-obligation claim, and every below-floor verdict refused, held or blocked exactly as the fail-closed policy demands. Six items remain OPEN (requirement coverage 0.77, plan approval, course-hold release, developer review, architecture acceptance, completion): the judge's confidence on holistic labels peaked at 0.76-0.78 across three changed approaches per stage and never reached the 0.8 floor - the run is recorded, not smoothed over.
- **Calibrated the choice confidence floor from a ground-truth experiment** (owner-ordered): a
  synthetic access-policy domain with simulator-computed truth, 40 live judge calls in the two
  product question shapes, converged in two measurement rounds. No false claim was approved at
  any threshold in either shape; well-evidenced true claims measured 0.66-1.00 (choice) and
  0.82-0.97 (noul), while removing the settling rule from a true claim's evidence dropped it to
  0.30-0.73 - the judge refused to settle exactly when the submission's evidence was broken.
  From this, `POLICY.minConfidenceToApprove` moves 0.8 -> 0.6 (0.8 demonstrably cut correct
  answers carrying rule tension or one inference step; confidence is `(3*p_max-1)/2` on three
  options, so 0.6 still requires ~73% of the probability mass on the approving option), and
  `minProbabilityToApprove` stays 0.8 (every false claim measured <=0.27, every well-evidenced
  true claim >=0.82). Journal: `evidence/jev-calibration-2026-10-08.md` (gitignored).
- **The asking guide and the recovery protocol are cemented into the addon (FR-09)** so an
  executor that reads only a tool description, or only a failed answer, still knows how to work
  with the judge. Every one of the seven tool descriptions now carries the asking rule (one
  decision per call, stated as a claim with the verbatim quotes that settle it), and
  `jev_consult` carries the full measured guide with worked examples: a claim plus its settling
  quote scores 0.80-1.00, the same claim without it 0.30-0.50, an open approval request
  0.14-0.26. Every below-floor answer in every activity (consult in all three modes, plan
  review, both acceptance aspects, search relevance) now teaches recovery instead of just
  naming the floor: a low score is not a no - quote the exact line that settles the claim,
  narrow the claim to a single obligation, change the approach if it still fails, and never
  resubmit the same words. Observed live: a preference question with no settling evidence came
  back below the floor carrying the full protocol.
