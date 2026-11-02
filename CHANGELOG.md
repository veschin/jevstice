# Changelog

## 2.1.0 - 2026-11-02

### Release

- Cleanup ahead of the release: the checkout held no scratch files, generated caches or dead code, so no tracked file was removed; the loose autonomy module, its tests, its smoke tool and its guide were committed here.
- 2.1.0 is the first release that carries the optional autonomy module, `jev_anti_slop`, the `jev_text_review` rule scope and the periodic session status. The strict autonomous workflow stays opt-in; its live acceptance items remain open and are listed below.

### Added

- Optional autonomy module: the strict coordinator, private SQLite ledger, Linux scope adapter and supervisor now live in `autonomy/runtime.ts`, `autonomy/store.ts`, `autonomy/scope.ts` and `autonomy/driver.ts`, with the strict-only entry `autonomy/index.ts`. The package manifest still declares only `src/index.ts`; an ordinary session registers the ordinary controller, ignores both `JEVSTICE_AUTONOMY_*` locators and never imports `autonomy/`. `bun run autonomy` starts `autonomy/driver.ts`, and an invalid strict binding still refuses startup before any Linux/SQLite load. The ordinary skill asset now carries only ordinary guidance: the strict autonomous paragraphs moved into the module runtime's request context, so an ordinary session receives no strict-autonomy instruction.
- `jev_anti_slop` reviews an external document, research output or legal communication: claim-evidence verdicts (`supported`, `refuted`, `not_enough_info`), Toulmin inference checks, hypothesis falsifiers, per-fragment language/register/meta-text/relevance findings, explicit trust marks, numbered parts and owner waivers. Triage records whether the deliverable is external. `antiSlop.mode` ships as `advisory`; `enforce` holds completion and external delivery while the current review is missing or an unwaived blocker remains. `/jev-waive <id>` records the owner's decision, not Jev approval.
- `jev_text_review` now takes a rule `scope`: `text` (default) judges the whole submission once, `fragment` judges each prose fragment; headings and table blocks are never judged as sentences. The result lists the failing fragments and rules in the visible text, and an unsettled pass no longer spends the refusal budget.
- Session status: every ten activity calls and on `/jev-status` the addon reports per-tool `ok/fail` counts, judge calls and `spend/balance`, for example `spend 0.0012/10$`. Spend is computed from the judge's token usage and the `billing` cost settings; `billing.balance` is the owner's TypeSafe balance snapshot because the public API exposes no balance endpoint.
- Opt-in strict autonomy: `bun run autonomy start|resume|status|stop`, a private SQLite run/artifact/decision/intent ledger, explicitly bound custom-turn continuation, whole-systemd-scope fencing, exclusive canonical project roots, durable waiting, operator cancellation and evidence-bound completion. Strict runs have no normal-mode continuation or waiver bypass and require Linux cgroup v2/systemd user-scope support.
- Autonomous audit verification: `bun test` 480 pass / 0 fail / 2138 `expect()` calls / 15 files; `bun run typecheck --noUnusedLocals --noUnusedParameters` clean. The smoke guide separates ordinary-host and strict live scenarios from deterministic coverage.
- Separation verification (2026-11-01), after the final workflow-guidance move: `bun test` 484 pass / 0 fail / 2142 `expect()` calls / 16 files; `bun run typecheck --noUnusedLocals --noUnusedParameters` clean; code guard deep check clean over 16 changed files. A real ordinary host workflow and native RPC state request passed with the entire `autonomy/` directory absent and both locators set to stray nonempty values. The ordinary-environment regression failed before the extraction and passed afterward; an observed ordinary prompt contained strict guidance before its relocation and no longer did afterward. A real optional-module startup passed against the relocated driver and entry; `bun run autonomy status` also read the resulting cancelled run with no live child or pending effect.
- Full autonomy acceptance remains open. Post-compaction completion and crash-effect reconciliation stayed unapproved in focused real-host trials; these are reported as nonterminal failures, not converted into passing results, and extracting the module neither repairs nor approves them.
- Earlier anti-slop verification (2026-10-29): `bun test` 264 pass / 0 fail / 989 `expect()` calls / 10 files; `bun run typecheck` clean. The real-host smoke does not exercise the anti-slop scenario.

### Documentation

- PRD records the external-artifact anti-slop requirements FR-45 through FR-56, their scientific basis and limits, and a code-derived inventory of the current implementation.
- README, AGENTS.md and ACCEPTANCE.md now describe the current request screen, triage-before-inspection boundary, full-payload action preflight, plan review, refusal ledgers, owner continuation, anti-slop review, configuration, test baseline and live-smoke entry points.
- Documented the implemented strict autonomous module, deployment prerequisites, initial authority/resource policy, supervisor commands, lifecycle and FR-57 through FR-66 evidence map. Normal-mode continuation remains unchanged.
- README, AGENTS.md, PRD.md, docs/autonomy.md and tools/README.md now describe the ordinary addon and the optional autonomy module as separate entries: the manifest loads only `src/index.ts`, an ordinary session ignores the autonomy locators and imports nothing under `autonomy/`, and the supervisor CLI and its `autonomy/index.ts` entry are the only activation path.

### Fixed

- Consultations retain their existing per-question refusal boundary while a developer or course finding is held. Different questions no longer share that finding's refusal budget or block one another after exhaustion. Exact repeats still cost no judge call, same-question refusals remain bounded, and only supported primary and finding-resolution answers clear the finding. Verification: two new regressions failed before the correction; the integrated suite passed 486 tests with 2170 expectations across 16 files, strict unused-code typechecking and code guard passed, a fresh-process activity probe covered all three modes, and the production-judge ordinary host workflow passed.
- Strict checkpoints compare dependency bytes before refreshing their hashes. External changes advance the revision and invalidate acceptance, completion and old execution observations; changed plan bytes also invalidate plan approval. A dependency changed during a judge call discards its answer.
- Native Bash-generated planned outputs now enter the existing artifact/manifest tracking. Missing planned files retain an explicit absence dependency, so later appearance cannot inherit authorization for the old state.
- Autonomous acceptance uses hash-checked current captured project bytes beyond the recent-action window and genuine durable workflow observations. New sessions require fresh execution evidence, including for manually submitted acceptance. Resetting an old action window preserves an unchanged refused wait; it is not new evidence or approval.
- Crash-recovery lifecycle judgment now includes the committed whole-scope fence receipts needed to authorize handling of inherited intents. An inconclusive launch answer still preserves the durable wait and launches nothing; no floor or stored refusal is bypassed.
- Strict smoke verifies settlement by the exact invocation identity instead of conflating distinct admitted calls with the same command or treating the rolling action window as complete history.
- Queued Jev activities retain their submission context: a changed session, owner request, task, simple-work registration or work revision refuses the queued call before judgment.
- Ignored tool-call counts are independent per boundary and reset for a changed owner request; interleaved refusals no longer prevent bounded continuation or release a new request using old counts.
- Consequential mutations under simple and quiet requests now advance the revision and invalidate stale external-artifact reviews, including after a failed mutation. Task tracking passes before triage without an action judgment.
- Anti-slop re-review invalidates the previous affected part before judgment. Failed judgments leave the part incomplete and remain retryable without poisoning the material-refusal ledger.
- Finding identities include the affected evidence or argument, so changed supporting material invalidates old waivers. A quote identical to the claim itself cannot count as evidence or establish source strength.
- Choice and score responses require the matching type discriminator; malformed answers cannot be normalized into an approval.
- Requirements accept the same Unicode/whitespace-equivalent request forms as triage and submit the canonical registered owner text for judgment.
- Configuration diagnostics describe the retained inherited values instead of falsely claiming shipped defaults or an unset balance.
- Text review preserves prose adjacent to headings, pipe tables and fenced code instead of skipping the whole blank-line fragment. Fence state remains consistent across blank lines and LF/CRLF endings. Numbered questions receive one canonical prose array rather than conflicting raw/prose indices; whole-text summaries no longer claim defects in zero prose fragments.
- Workflow guidance now uses OMP's supported `systemPrompt` result and preserves earlier policy entries on ordinary, owner-approval and continuation turns. The obsolete append-only result was ignored by the installed host.
- Diagnostic questions about a failure ("почему сломан", "не работает", "ты уже чинил этот баг?", "broken", "why") are read as quiet inspections instead of judged change requests; a fix request still wins through the change lexicon.
- Triage compares the submitted request with the current owner message after Unicode, whitespace and line-ending normalization instead of byte equality, and a mismatch shows the expected text with its digest so the executor can copy it rather than guess. The canonical owner text is what the judge and the registered task receive.
- The ignored-call limit no longer exhausts the activity refusal budget: three blocked project reads permit continuation and leave `jev_triage` callable. Task tracking itself is not blocked. The OPEN item is still recorded and announced.
- A quiet follow-up clears a stale pending direction, so the gate no longer quotes an older message that `jev_reaim` must reject. `jev_reaim` without a registered task now names `jev_triage` or `/jev-continue` instead of a dead end.
- Plan detail approvals bind to complete artifact sections resolved from the artifact itself (unique heading or exact full text), not to caller-supplied substrings: the finalize stage no longer treats 99% of an approved plan as unjudged "additional material", which repeatedly failed assembly after every part had passed. Overlapping sections, sections changed during judgment, and headings inside fenced code are refused.
- Oversized evidence quotes are refused before any judge call instead of being silently truncated to a prefix, and the request itself is never clipped; a judge answer that arrives while the request, approvals or hold changed is discarded as stale.
- Re-finalizing or revising a plan (outline, detail or digest change) now invalidates acceptance and completion verdicts recorded against the previous plan.
- Restored bounded enforcement: exhausted judgment, tool-boundary, availability and stop attempts permit continuation with unresolved decisions OPEN, never falsely approved.
- Added `/jev-continue` and explicit owner approval messages to release all addon gates for the current request. Quoted text and extension-originated input do not grant permission; new requests do not inherit it.
- Updated the injected workflow to remove the obsolete owner-confirmation loop and permanent-block instructions.

## 2.0.0 - 2026-10-27

### Breaking changes

- Jev authorization is mandatory before consequential invocations when mutation gating is enabled. Exhausted refusal budgets and judge outages no longer release execution or completion boundaries.
- Requirements derive from the user objective without a separate owner-confirmation field. Plan submissions use outline, detail and finalize stages; approved details survive revisions to other steps.
- Start a fresh OMP session after upgrading so the new tool schemas and controller load together. Existing gate configuration remains supported; this release does not change the owner's installation or launch settings.

### Verification

- 215 tests pass; TypeScript and code-guard deep checks are clean.
- Real-Jev execution passed through requirements, staged planning, action authorization, behavior checks, both acceptance aspects and completion in OMP.
- A separate seven-step Factorio plan passed in OMP at final confidence 0.91. This verifies planning, not a Factorio implementation.

### Fixed

- Requirements now derive from the owner's objective without a mandatory owner-confirmation round. Necessary implementation choices are proposals for Jev, not missing owner permission.
- Planning retains partial outline/detail approvals. Details use typed readiness/defect choices; finalization checks exact section presence, assembly consistency and new scope instead of rejudging every accepted step.
- Consequential invocations receive automatic, full-payload Jev authorization before execution. Opaque executable/delegated/device routes are no longer exempt merely because their tool names differ.
- Refusal exhaustion and judge unavailability keep required decisions blocked. Task replacement, re-aim and plan handoffs no longer inherit or manufacture execution permission.
- Approved artifacts are digest-bound; stale asynchronous answers cannot accept later work. Failed executions invalidate earlier acceptance because failure does not prove absence of side effects.
- Course checks judge each action against the whole plan. An uncertain text review cannot pass; unrelated developer reviews cannot clear a held finding.
- Invalid configuration section types report their source and retain defaults.
- Removed obsolete measurement/review scripts that imported deleted modules. `tools/live-smoke.ts` uses the existing controller/SDK and actual OMP host to record planning, execution and acceptance evidence.
- Shell quoting and escaping now require invocation judgment instead of being stripped by the read-only classifier; quoted output flags and nested substitutions can no longer hide writes.

## 1.2.0 - 2026-10-14

- **A request is read once, for free, before any judge call (FR-30).** `src/screen.ts` reads the
  prompt text when it arrives and decides entry only: a request that asks to publish, inspect or
  verify work that already exists - "commit and push", "run the tests", "where is the parser
  defined?" - does not enter the judged workflow, while a request that names a change to the project,
  and any request the reading does not recognise, does. The screen is one-sided on purpose: a wrong
  `judged` costs one triage call and the judge itself then answers "simple task", while a wrong
  `quiet` would run real development unjudged and silently, so unknown text always pays. It decides
  entry only - a development task triage already registered keeps its walls when a later request says
  "commit and push" - and it is lexical and deterministic, reading the request text and never the
  project. The reading recognises the owner's English and Russian phrasing, because those are the
  requests actually written.

- **A shell command is consequential only when it can reach the working tree (FR-31).**
  `isNonMutatingCommand` parses the command text, so inspections (`git status`, `git diff`, `git log`,
  `ls`, `cat`, `rg`, `jq`, `wc`) and publication (`git add`, `git commit`, `git push`, `git fetch`)
  are no longer held and no longer move the work revision: a session of nothing but commits and
  pushes costs no judge call and shows no message. A command the extension cannot read fully - a
  redirection, `$(...)` or a backtick, a writer such as `tee` in a pipeline, `sed -i` and other write
  flags, `rm`, an unknown program or an unknown `git` subcommand - stays consequential, because
  holding something harmless is cheaper than passing something real. A commit message's own `&`, `;`
  and quotes are read as data rather than as shell syntax.
- **Command interpreters remain consequential, and change intent overrides routine wording (FR-30, FR-31).** The safe reporting list excludes `awk`, `env`, and `bc`, which can invoke commands. The request screen treats `improve` as a change signal, so "review and improve parser" enters the judged workflow.

- **A simple task's plan proposal is not held (FR-02).** `proposeGate` passes `write xd://propose`
  once triage has confirmed the request simple: planning a simple task needs no plan review and costs
  no judge call.

- **The course question is deferred by default (FR-12).** `courseCheck.mode` ships as `completion`,
  so the course of a developed task is judged once when the work ends instead of on every third
  consequential change; `interval` remains an explicit owner choice for tasks where a late reversal
  costs more than a check.

- Tool descriptions carry one shared `WORKFLOW_NOTE` through `described(...)`, so the executor reads
  what a request has to be before a call is required of it rather than wording repeated per
  registration. `DEFAULT_CONFIG.courseCheck` is the only shipped default that changed; the gates, the
  floors, the refusal ledger and the fail-closed policy are untouched.

- Verification: `bun test` 172 pass / 0 fail / 626 expect() calls across 8 files; `bun run typecheck`
  clean. Live `omp` 18.10.4 sessions with this checkout loaded explicitly and `TYPESAFE_API_KEY_COMMAND`
  replaced by a probe that records every key resolution: "закоммить и запушь текущее состояние" made 0
  resolutions, showed no Jevstice message and finished the git work itself, while "добавь файл
  notes.md со словом привет" was held by the triage message and reached the judge (the probe credential
  is unusable, so that session then recorded the unavailable-judge path of FR-21). No test reaches the
  live judge.

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
