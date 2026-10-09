# Changelog

## 1.1.0 - 2026-10-09

- **The course check judges real evidence per topic (FR-11, FR-25).** Measured live (2026-10-09):
  six interval checks answered on_course at 0.40 -> 0.07 over 200-character excerpts while the hold
  boundary had released, so none of them could hold anything. The recorded action excerpt now
  carries the change material itself - the tool input bounded by `POLICY.maxActionExcerptChars`
  (200 -> 2000) plus the result excerpt; the course check asks one choice question per approved plan
  topic (`direction:<topicId>`) instead of one global open question, a failed topic is named in the
  hold, and without plan topics no course question is asked at all; and once the hold boundary is
  released, the interval check no longer fires - a hold that boundary cannot enforce is a judge call
  with no effect. The completion check's folded-in course questions follow the same per-topic shape.

- **The gates degrade symmetrically and the owner can re-aim (FR-29).** Measured in the jellyfin
  session: business acceptance refused three times, the boundary released, and the completion gate
  kept demanding what the released boundary could never grant - a terminal loop. `completionGate`
  now skips an aspect whose acceptance boundary has released (the release stays an OPEN item);
  `jev_reaim` registers the owner's interjection as the course in one judged question and re-aims
  the task with every wall down; the deviation latch resets on an on-course verdict instead of
  firing on every later action (26 checks in 15 minutes, measured); a `bash` result is judge
  evidence that no longer moves the work revision or invalidates acceptance records; and every
  refused acceptance names its remaining refusal budget. The plan-review coverage floor drops to
  `POLICY.minCoverageConfidence` (0.6): three live reviews measured coverage 0.75/0.61/0.73 while
  every individual topic passed its own 0.8 floor - the global question double-punished the set.

- **The eight entries marked `review required` were validated with Jev and implemented (FR-20..FR-27),
  and the new owner requirement that a model does not follow the judge was added as FR-28.** Each
  entry was put to its own Jev review and the mark removed only by a recorded verdict at or above the
  floor: FR-20 0.86, FR-21 0.69, FR-22 0.89, FR-23 0.92, FR-24 0.73, FR-25 0.92, FR-26 0.62, FR-27
  0.79 and 0.79, FR-28 0.70 and 0.67; the PRD's review record carries them. Every attempt changed its
  approach and the journal stayed a bound of three per framing.
- **The plan review no longer deadlocks (FR-24).** `jev_plan_review` takes `topics` - per topic an id,
  the artifact section that governs it, the paths it changes and the requirement it serves - refuses a
  topic whose quoted section is absent from the artifact before any judge call, and puts one question
  per topic in one batched call; an approval needs every topic at the floor, and a refusal names the
  topic with its own next action. The single question over the whole artifact, which answered serves
  0.48 / revise 0.77 / serves 0.48 across three live submissions, is gone.
- **A refusal teaches its own next step (FR-20, FR-28).** Every refusal carries the class of the
  failure (a defect of the submitted material, or the judge failing to answer) and exactly one next
  action; every gate refusal renders the next call with its arguments, the same instruction is
  delivered once per boundary as an aside message, the refused calls are counted, and at
  `POLICY.maxIgnoredBoundaryCalls` the owner is told which calls were attempted.
- **A stuck boundary releases itself (FR-22, FR-23).** Every judged submission is recorded with the
  digest of the material that was judged; a resubmission whose digest was already refused at that
  boundary is refused without a judge call, and at `POLICY.maxRefusalsPerStage` the boundary is
  released for the request as an OPEN item with its numbers while the owner is notified - the release
  approves nothing.
- **The judge's absence is survivable (FR-21).** After `POLICY.maxJudgeFailures` availability failures
  in a row the extension tells the owner once and passes the mutation and completion boundaries
  without a judge answer; any usable answer restores them, and a malformed or below-floor answer counts
  as neither.
- **The course check runs on a trigger, not on a count (FR-25)**: a change outside the paths the plan's
  topics name, or the configured count, whichever comes first, with the topics and the deviation in
  the material. Acceptance is judged from submitted evidence - one execution item and one static code
  item, refused before any judge call when either is missing - per plan topic (FR-26). A new
  `jev_text_review` tool splits a text and quotes back the register rule a fragment violates, writing
  no advice of its own (FR-27).
- Verification: `bun run typecheck` clean; `bun test` 138 pass / 0 fail / 487 expect() calls across 8
  files; a live host launch held the first write with the copy-ready `jev_triage` call, refused a
  topic-less plan review before any judge call, and answered the text review. A four-topic plan was
  then approved on the live judge - coverage 0.92, weakest topic 0.81 - and the write that the gate had
  held passed; a three-topic plan for a request with four obligations was refused with coverage 0.24
  and only its weakest topic named, so the verdicts attribute to topics rather than to the artifact as
  a whole. The release path was exercised live too: three refusals at the plan boundary produced the
  OPEN item with its digests and the owner message, and the write attempted right after it passed.
  That run also exposed and fixed one defect: an unsettled triage verdict was classified as the
  judge's fault instead of the submission's.
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
