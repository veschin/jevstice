# Jevstice - Product Requirements

## Purpose and scope

Jev guides an OMP executor from the owner's high-level objective through requirements, planning, execution and acceptance. The extension enforces decisions at visible tool boundaries rather than relying on voluntary consultation. It reuses the TypeSafe typed-decision API and cannot observe private reasoning or act as an OS sandbox. [S34-S36]

The executor is the omp agent doing the work. Jev is the judge reached through the TypeSafe API. A simple task does not inherit development gates merely because it has a user prompt. [S2, S13]

An external-artifact review for documents, research outputs and legal communications is specified in FR-45 through FR-56. It is external-only and advisory by default. [S37-S39]

## Functional requirements

Each requirement specifies one independently observable behavior. The owner-request coverage was checked with Jev in separate preparation and execution batches; the planning-understanding clause was additionally checked as an independent claim. [J1, J2, J3]

Each entry that carried a `review required` mark was put to its own Jev review, and the mark was removed only by a recorded verdict at or above the approval floor (`POLICY.minConfidenceToApprove` 0.6 for a choice, 0.8 for a probability). The verdicts are recorded below.

The current autonomous-execution mandate [S34-S36] supersedes the former mandatory owner-confirmation and emergency-release behavior. Historical verdicts below describe the earlier requirements; they are not fresh validation of the revised policy.

### Review record

| Entry | Verdict | Entry | Verdict |
| --- | --- | --- | --- |
| FR-20 | established, 0.86 (interpretative readings: the need requires the class of the refusal and the next action) | FR-24 | established, 0.73 for the topic list the executor submits; the variant that parses a topic block out of the artifact was rejected at 0.20 and 0.46 and is not implemented |
| FR-21 | established, 0.69 | FR-25 | established, 0.92 |
| FR-22 | established, 0.89 | FR-26 | established, 0.62 |
| FR-23 | established, 0.92 | FR-27 | established, 0.79 and 0.79 |
| FR-28 | established, 0.70 and 0.67 (new owner requirement, S26) | | |

FR-45 through FR-56 below are implemented from S37-S39. No Jev verdict is recorded for them.

### Triage and preparation

- **FR-01 - Narrow topics.** WHEN a task requires specialized expertise, triage SHALL identify task-specific topics. [S1; J1:1]
- **FR-02 - Simple-task decision.** WHEN a task is simple, triage SHALL explicitly say that deeper development activities are unnecessary. [S2; J1:2]
- **FR-03 - Search relevance.** WHEN the executor submits web-search candidates with evidence and a proposed reason for each, Jev SHALL select a relevant candidate-and-reason pair. [S2, S3; J1:3]
- **FR-04 - Requirement decomposition.** DURING planning, the executor SHALL break the owner's request into individual concrete requirements. [S4; J1:4]
- **FR-05 - Understanding check.** DURING planning, Jev SHALL check each proposed requirement against the original objective and actual owner corrections; necessary implementation choices MAY be inferred by the executor and judged without a second owner message. [S4, S34]
- **FR-06 - Complete requirement set.** BEFORE planning, Jev SHALL establish that the proposed delivery covers the objective without contradictions or unrelated goals; suspected omissions SHALL be settled rather than silently treating uncertain answers as absence. [S5, S34]
- **FR-07 - Native plan mode.** WHILE omp's plan mode is active, the extension SHALL connect plan review to the actual host plan-mode boundary. [S6; J1:7]
- **FR-08 - Flexible consultation.** WHEN consulting Jev on its own question, the executor SHALL be able to choose Choice, Score, or Boolean. [S6; J1:8]
- **FR-09 - Consultation guidance.** The extension SHALL teach the executor how to use the flexible Jev consultation to obtain useful decisions. [S6; J1:9]
- **FR-10 - No per-prompt catalog.** The extension SHALL NOT automatically classify tasks and select generic topics on every user prompt. [S13; J1:10]

### Execution and review

- **FR-11 - Interval course check.** WHEN the configured number of visible implementation actions is reached, the extension SHALL request a course check with Jev. [S7; J2:1]
- **FR-12 - Completion-only course check.** WHEN configured for completion-only checking, the extension SHALL defer course checks until implementation ends. [S7; J2:2]
- **FR-13 - Uncertainty consultation.** WHEN uncertain during implementation, the executor SHALL be able to initiate a Jev consultation without waiting for a scheduled check. [S7; J2:3]
- **FR-14 - Business acceptance.** AT acceptance, the executor SHALL defend its work before Jev against the owner's business needs. [S8; J2:4]
- **FR-15 - Architecture acceptance.** AT acceptance, the executor SHALL defend its work before Jev from the architecture perspective. [S8; J2:5]
- **FR-16 - Developer review.** WHEN reviewing a checkpoint, commit, or diff, the executor SHALL defend the changed work before Jev as a developer. [S9; J2:6]
- **FR-17 - Completion decision.** BEFORE a developed task is reported complete, Jev SHALL check whether the work follows the owner's requirements. [S10; J2:7]
- **FR-18 - Important-decision boundary.** WHEN an important decision requires Jev and the executor reaches an enforceable visible boundary without submitting it, the extension SHALL block that boundary; an unknown `xd://` device SHALL be treated as consequential unless explicitly listed as read-only or a Jev route. [S11, S13; J2:8]
- **FR-19 - Business decision.** WHEN the executor faces a consequential business decision, it SHALL consult Jev with the task context. [S12; J2:9]

### Refusal handling and judge availability

- **FR-20 - Truthful refusal.** A refusal SHALL distinguish invalid input, unavailable judgment, established defects and uncertainty. Recovery guidance SHALL preserve accepted decisions and SHALL NOT invent a defect from a low probability. [S17, S35]
- **FR-21 - Judge availability.** After three consecutive availability failures, the extension SHALL notify the owner and permit continuation of the current request. Unavailable judgments SHALL remain unapproved and disclosed as OPEN.
- **FR-22 - Reconsider instead of repeating.** Refused material and its question set SHALL be recorded per task and decision. An identical resubmission SHALL cost no judge call; unrelated later decisions SHALL NOT erase an earlier refusal budget. [S19, S35]
- **FR-23 - Bounded enforcement.** After three refused submissions or three blocked calls at a boundary, the extension SHALL retain the unresolved decision as OPEN and permit continuation of the current request across inspection, plan, mutation, invocation and completion boundaries. Three blocked stops SHALL permit the following stop. Permission SHALL NOT manufacture Jev approval.

### Review rework

- **FR-24 - Staged plan review.** Jev SHALL review a high-level outline, then one detail per call. A detail SHALL name one complete artifact section, resolved from the artifact itself by a unique heading or exact full text; a substring, ambiguous heading or section changed during judgment SHALL be refused. Finalization SHALL compute the additional material as the artifact minus the approved sections, SHALL refuse overlapping approved sections, and SHALL bind the approval to the exact artifact bytes and task. [S22, S31-S36]
- **FR-37 - Partial plan approvals.** Passing steps SHALL remain approved while rejected steps are revised. A changed detail loses its own approval; a changed outline invalidates its dependent details; a section no longer present verbatim in the artifact SHALL be re-reviewed. Outline, detail and assembly refusal budgets SHALL remain separate; exhausted enforcement SHALL follow FR-23. Any plan revision SHALL invalidate acceptance and completion verdicts recorded for the previous plan.
- **FR-25 - Course checks.** Configured post-execution checks SHALL judge each recent action against the whole approved task. Serving one requirement SHALL NOT require serving every topic. Failed consequential executions SHALL also advance the revision. A successful course check SHALL NOT clear an unrelated developer finding. [S23, S35]
- **FR-26 - Acceptance judged from evidence.** WHEN code is accepted, the extension SHALL refuse the submission before any judge call unless its evidence carries at least one execution item (a command and its output) and at least one static code item (a diagnostic, a diff or a size measurement); the judge SHALL answer per plan topic whether that evidence shows the topic met, naming the evidence it rests on. [S24]
- **FR-27 - Text review tool.** The extension SHALL offer a tool that takes a text and the register rules it must satisfy, splits the text into bounded fragments and puts every submitted rule to the judge once per fragment; for each fragment a rule fails on, the tool SHALL return that rule line as the executor submitted it, writing no prose of its own. [S25]
- **FR-28 - The boundary teaches its own next step.** A refused call SHALL name the missing decision and the owner continuation command. The controller SHALL count blocked calls, notify the owner at the limit, and permit continuation with the finding OPEN rather than indefinitely repeating the gate.

- **FR-29 - Owner re-aim.** A re-aim SHALL quote an actual current owner message, replace the task and invalidate its old requirements, plan and acceptances. It SHALL NOT reuse old exhaustion state or grant execution without a new approved plan. A new direction SHALL NOT silently inherit old permission. [S27, S34-S35]

### Entry and what counts as consequential

- **FR-30 - Request weight read for free.** WHEN a request arrives, the extension SHALL read its text once, locally and before any judge call, and SHALL let it enter the judged workflow only if it names a change to the project or the reading does not recognise it; a request that asks to publish, inspect or verify work that already exists SHALL NOT enter it, and the reading SHALL decide entry only - it SHALL NOT take down the walls of a development task already registered, and the judge, not the reading, SHALL decide how deep an entered request goes. [S28]
- **FR-31 - Capability boundary.** Fully recognized read-only commands MAY pass without a work revision. Unknown executables, quoted executable syntax, substitutions, redirections, write options, opaque code, delegation and mutating devices SHALL remain consequential. Direct tool and device routes SHALL receive equivalent enforcement. [S29, S35]

- **FR-32 - Triage before project inspection.** WHEN a request enters the judged workflow, the executor SHALL call `jev_triage` before inspecting project files, searching the project, or drafting a plan; until triage settles the request, the extension SHALL hold project reads and searches, consequential shell calls, requirement submission and local plan-artifact writes, while allowing required skill reads and task tracking. [S30]

- **FR-33 - Autonomous requirements.** The executor SHALL derive checkable obligations and necessary implementation choices from the owner's objective and submit them to Jev without requiring owner confirmation. [S34]
- **FR-34 - Requirements gate.** Plan-artifact writes and plan review SHALL remain held until coverage reaches 0.6, every requirement reaches its support floor and candidate omissions are settled. Changes to requirements SHALL invalidate dependent approvals. [S31, S34-S35]
- **FR-35 - No mandatory owner loop.** A later owner message SHALL NOT be a prerequisite for requirements or planning. Actual owner corrections SHALL retain authority through the re-aim boundary. [S34]
- **FR-36 - Context continuity.** Requirements and staged/final plan approvals SHALL remain task-bound and survive a native plan handoff only when the artifact digest matches. Pending calls and stale judgment results SHALL NOT approve a different task or revision. [S33-S35]

- **FR-38 - Invocation authorization.** Before a consequential invocation executes, the host SHALL submit its complete payload for Jev authorization unless current-request continuation permission applies under FR-23 or FR-44. Oversized payloads SHALL be refused rather than truncated. Without that permission, quiet/simple requests SHALL authorize only the requested inspection, verification or publication.

- **FR-44 - Owner continuation.** An explicit owner approval through `/jev-continue` or a recognized standalone owner approval message SHALL immediately permit continuation of the current request across all addon gates. Tool arguments, quoted text and extension-originated input SHALL NOT count as owner approval. Changed requests and re-aims SHALL NOT inherit permission. Unresolved findings and refused verdicts SHALL remain recorded without claiming Jev acceptance. Owner source: "всегда должна быть возможность после моего аппрува как юзера, или после превышения всех попыток продолжать работу".


### Session UX improvements (owner-approved, 2026-10-27)

- [ ] **FR-39 - Automatic acceptance.** At completion, the controller SHALL collect observed code and execution evidence, submit missing business and architecture acceptance automatically, and return the unmet obligations without requiring manual acceptance calls.
- [ ] **FR-40 - Owner interruption.** A question or stop instruction from the owner SHALL permit a conversational response without accepting or discarding unfinished work. Consequential actions SHALL remain blocked until the owner resumes or changes direction.
- [ ] **FR-41 - Durable continuation.** Resuming an OMP session SHALL restore its task and accepted decisions from the native session journal. Changed files or plan sections SHALL invalidate only affected plan details; prior completion and execution acceptance SHALL require fresh verification after restart.
- [ ] **FR-42 - Local requirement changes.** A judged owner correction SHALL retain unaffected requirements, outline steps and plan details. Dependent decisions SHALL be reviewed again, and execution SHALL wait for a newly bound complete plan.
- [ ] **FR-43 - Evidence-first recovery.** Missing or unsuitable evidence SHALL return the unmet requirement and its approved verification section, directing the executor to observe that behavior before changing implementation. Only an established defect SHALL direct implementation repair.

These requirements supplement FR-14/15/26 and supersede the full-discard behavior in FR-29/36/37 where an unaffected decision is explicitly retained. Initial status: all five are not implemented; completion requires observed behavioral checks.

### External-artifact integrity review (anti-slop, owner request 2026-10-29)

The review covers documents, research outputs and legal communications intended for an audience outside the project. It combines claim verification, argument re-checking, source-strength marking and per-fragment language checks. It is not a truth guarantee: it checks submitted claims against submitted evidence and cannot authenticate a source or a quotation.

- **FR-45 - External-deliverable classification.** WHEN a request enters triage, Jev SHALL decide in the same batched call whether the deliverable is intended for an audience outside the project - a document, a research output or a legal communication - and the extension SHALL record that decision with the registered task. The anti-slop review and its boundaries SHALL apply only to an external deliverable: a task so classified, or a quiet publication request whose text names an external artifact. A quiet request that never enters triage incurs no triage question; the executor MAY invoke the review explicitly, and it remains advisory. [S37]

- **FR-46 - Anti-slop review scope.** The extension SHALL offer `jev_anti_slop` for the current external deliverable: a task triage classified as external, or a quiet publication request whose text names an external artifact. A submission SHALL carry the exact artifact text, the declared language, register, purpose and audience, at least one owner-supplied register rule, the factual claims with their quoted evidence and source class, the hypotheses with their falsifiers, and the inferences with their premises, warrant and conclusion. A submission for an internal task, a request that names no external artifact, an artifact, claim set, fragment set or question batch above the configured bounds, or a claim, hypothesis, premise or conclusion that does not occur verbatim in the artifact SHALL be refused before any judge call. The tool SHALL be read-only: it changes no file, no revision and no approval. [S37]

- **FR-47 - Claim verification and hallucination exclusion.** For every submitted factual claim, the extension SHALL ask whether the quoted evidence supports it, refutes it or does not establish it, with the answers `supported`, `refuted` and `not_enough_info`. A claim without an evidence quote, or with an evidence quote identical to the claim itself, SHALL be marked unsupported without a judge call. A decisive verdict SHALL require the anti-slop confidence floor of 0.8. A `refuted` answer at the floor SHALL be a blocker finding `contradicted_claim`; an unsupported claim SHALL be a blocker finding `unsupported_claim`; a claim the judge cannot settle SHALL be marked `unverified`, never trusted. The executor's assertion SHALL NOT count as evidence. [S37]

- **FR-48 - Explicit trust marks.** Every claim and inference SHALL carry one trust mark: `trusted`, `low_trust`, `distrusted` or `unverified`. `trusted` SHALL require a decisive supporting verdict at the floor and evidence from an accepted source class; `low_trust` SHALL require support from a weaker source; `distrusted` SHALL cover a decisive refutation, no evidence or an unfalsifiable hypothesis; `unverified` SHALL cover an inconclusive or unavailable answer. Source classes SHALL be `primary`, `official`, `peer_reviewed`, `reputable_secondary`, `anonymous` and `none`; `trusted` SHALL require at least `reputable_secondary`. The result text and `details` SHALL list every `distrusted` and `unverified` item with its reason class and the submitted evidence it rests on. The extension SHALL NOT mark an item trusted without a decisive verdict. [S37]

- **FR-49 - Conclusion re-check.** For every submitted inference, the extension SHALL ask whether the conclusion follows from the submitted premises under the stated warrant, with the answers `follows`, `does_not_follow` and `unclear`. The premises, warrant and conclusion SHALL be judged as submitted; the review SHALL NOT add an unsubmitted premise or warrant. A `does_not_follow` answer at the floor SHALL be a blocker finding `invalid_inference`; an `unclear` answer SHALL mark the inference `unverified`. [S37]

- **FR-50 - Hypothesis falsifiability.** A claim submitted as a hypothesis SHALL carry a falsifier: an observable condition that would refute it. A hypothesis without a falsifier SHALL be marked `distrusted` and recorded as a blocker finding `unfalsifiable_hypothesis` without a judge call. The extension SHALL ask whether the submitted falsifier is an observable condition that would refute the hypothesis; a negative answer at the floor SHALL produce the same finding. [S37]

- **FR-51 - Language and register.** The review SHALL require a declared language, a declared register and at least one owner-supplied register rule. It SHALL split the artifact into bounded fragments and ask, per fragment, whether the fragment is in the declared language and whether it violates each rule. A fragment outside the declared language SHALL be a blocker finding `language_mismatch`; a violated rule SHALL be a finding `register_violation` quoting the submitted rule line verbatim, and a rule MAY carry `severity: blocker`, otherwise the finding is a warning. The review SHALL NOT translate, rewrite or add style advice, and the language check SHALL NOT hardcode Russian or English. [S37]

- **FR-52 - Meta-text, redundancy and relevance.** For every fragment, the review SHALL ask whether the fragment talks about the document, its sections, the writing or analysis process, the author, or the reader's experience instead of carrying the artifact's substance. A fragment that does SHALL be a blocker finding `meta_text`. Functional cross-references that are part of an instrument's operative content are not meta-text; the owner's rules decide a borderline case. For every fragment, the review SHALL also ask whether it repeats material already present in the artifact or adds nothing to the declared purpose, with the answers `serves`, `repeats`, `off_topic` and `unclear`; `repeats` or `off_topic` at the floor SHALL be a warning finding `redundant_material`. The review's own result SHALL contain only findings, submitted rule lines and typed verdicts: it SHALL NOT summarize itself, describe its method, advise the reader or produce any other meta-text. [S38]

- **FR-53 - Finding identity, severity and binding.** Every finding SHALL carry a stable id derived from the task fingerprint or the quiet-publication request text, the reviewed artifact digest and the finding's material; a kind; a severity (`blocker` or `warning`); the claim or fragment it concerns; the typed verdict and confidence; and the submitted rule or evidence. The review SHALL bind to the task fingerprint and work revision, or to the request text for a quiet publication, and to the artifact digest, language, register and rules. A changed artifact, language or rule set SHALL invalidate the review and any waiver whose finding material changed; a review SHALL NOT approve a different task, request or revision. Blockers SHALL be `contradicted_claim`, `unsupported_claim`, `invalid_inference`, `unfalsifiable_hypothesis`, `language_mismatch` and `meta_text`; warnings SHALL be `low_trust_source`, `register_violation` unless the rule carries `severity: blocker`, `redundant_material` and `unverified_claim`. [S37]

- **FR-54 - Owner-selective waiver.** The owner SHALL be able to waive one finding by its stable id through an owner-originated command (`/jev-waive <id> [reason]`) or a recognized owner waiver message. The waiver SHALL record the finding id, review digest and task or quiet-publication request; tool arguments, quoted text and extension-originated input SHALL NOT waive a finding. A waived blocker SHALL NOT hold completion; the result SHALL list it as waived by the owner, never as Jev approval. A changed artifact or finding SHALL invalidate the waiver. [S37]

- **FR-55 - Advisory default and external-only enforcement.** The shipped anti-slop mode SHALL be `advisory`. In `advisory`, the executor SHALL submit the review before reporting an external deliverable complete; findings are reported, and neither a finding nor a missing review holds completion, while a missing review SHALL be disclosed. In `enforce`, completion SHALL be held while the current review is missing or any unwaived blocker remains, and an external-delivery invocation SHALL be held until a current review exists with no unwaived blocker; the action preflight SHALL decide whether an invocation delivers the artifact to an external audience. A quiet publication has no completion boundary; only its external-delivery invocation can be held. In `off`, the review is not required and the tool SHALL refuse to spend a judge call. Internal tasks SHALL never enter the review or its boundaries. [S37]

- **FR-56 - Bounds, splitting and fail-closed.** The review SHALL refuse before any judge call an artifact, claim set, fragment set or question batch above the configured bounds; it SHALL never truncate. A large artifact MAY be submitted in parts carrying `part.index` and `part.total`; the review record SHALL cover every part, and enforcement SHALL require every part at the current revision. A judge failure, malformed answer or missing answer SHALL leave the affected item `unverified`, SHALL create no trusted mark, and in `enforce` SHALL hold completion. Refused anti-slop submissions SHALL follow the existing refusal ledger and SHALL be counted at their own boundary; exhaustion SHALL leave the review OPEN and SHALL NOT manufacture a trusted mark. [S37]

#### Design basis

The review is a reduced claim-verification pipeline. It borrows established scientific devices and implements only the verdict and justification halves: the executor submits the claim and the evidence, and the judge returns typed labels. No web retrieval, source authentication or formal proof is claimed.

| Requested check | Mechanism | Source |
| --- | --- | --- |
| Hallucination exclusion | Claim-evidence verification with `supported`, `refuted` and `not_enough_info`, each backed by the evidence quote | FEVER [F1], SciFact [F2], AVeriTeC [F3] |
| Unreliable facts | Evidence classes and certainty levels; a decisive mark needs a quotable source at or above the accepted class | GRADE [F6] |
| Extra and false information | Refuted or unsupported claims become findings; meta-text and repetition are separate findings; owner register rules cover filler | S37-S38 |
| Logic re-check | Toulmin argument: grounds, warrant and claim; the judge tests whether the conclusion follows, not whether the prose persuades | Toulmin [F5] |
| Hypothesis check | A hypothesis must state an observable falsifier; an unfalsifiable claim is distrusted | Popper [F7] |
| Language and register | Per-fragment rule violations, with the owner's rule line quoted back; the existing text-review pattern | FR-27 [S25] |

The automated fact-checking survey [F4] supplies the general pipeline: claim detection, evidence retrieval, verdict prediction and justification. Jevstice leaves retrieval to the executor and keeps the verdict and justification. The redundancy and meta-text checks are owner-specific editorial requirements [S37-S38], not claims from the fact-checking literature.

- [F1] James Thorne, Andreas Vlachos, Christos Christodoulopoulos, Arpit Mittal. "FEVER: a Large-scale Dataset for Fact Extraction and VERification." NAACL 2018. https://arxiv.org/abs/1803.05355
- [F2] David Wadden, Shanchuan Lin, Kyle Lo, Lucy Lu Wang, Madeleine van Zuylen, Arman Cohan, Hannaneh Hajishirzi. "Fact or Fiction: Verifying Scientific Claims." EMNLP 2020. https://arxiv.org/abs/2004.14974
- [F3] Michael Schlichtkrull, Zhijiang Guo, Andreas Vlachos. "AVeriTeC: A Dataset for Real-world Claim Verification with Evidence from the Web." NeurIPS 2023 Datasets and Benchmarks. https://arxiv.org/abs/2305.13117
- [F4] Zhijiang Guo, Michael Schlichtkrull, Andreas Vlachos. "A Survey on Automated Fact-Checking." TACL 2022. https://arxiv.org/abs/2108.11896
- [F5] Stephen E. Toulmin. "The Uses of Argument." Cambridge University Press, 1958. Summary: https://owl.purdue.edu/owl/general_writing/academic_writing/historical_perspectives_on_argumentation/toulmin_argument.html
- [F6] Gordon H. Guyatt, Andrew D. Oxman, Gunn E. Vist, Regina Kunz, Yngve Falck-Ytter, Pablo Alonso-Coello, Holger J. Schünemann. "GRADE: an emerging consensus on rating quality of evidence and strength of recommendations." BMJ 2008;336:924-926. https://doi.org/10.1136/bmj.39489.470347.AD
- [F7] Karl R. Popper. "The Logic of Scientific Discovery." Hutchinson, 1959. Overview: https://plato.stanford.edu/entries/popper/

#### Implementation shape

1. Triage adds one external-deliverable question to its existing batch and records the answer with the task.
2. `jev_anti_slop` validates the artifact, language, register, rules, claims, hypotheses and inferences. It refuses a claim, hypothesis, premise or conclusion that does not occur verbatim in the artifact, and refuses any set above the configured bounds before spending a judge call.
3. One batched question set is built within the 200-question cap: one claim question per factual claim with usable evidence; one falsifier question and, when usable evidence exists, one claim question per hypothesis; one inference question per inference; and, per fragment, one language question, one meta-text question, one relevance question and one question per register rule. A claim with no usable evidence is marked unsupported without its own question.
4. The typed answers are read at the 0.8 anti-slop floor. Trust marks and findings are derived from those answers and the submitted source classes; the review is recorded against the task fingerprint, work revision and artifact digest.
5. In `advisory`, the result is reported and a missing review is disclosed at completion. In `enforce`, the completion and external-delivery boundaries read the recorded review and hold while it is missing or an unwaived blocker remains. The owner waives one finding by id; the waiver is recorded against the same review.

**Limits.** The review sees the submitted text and quotes. It cannot prove that a source exists, that a quotation is authentic, that the artifact file matches the submitted text, or that a language judgment is exhaustive. A `trusted` mark means the submitted evidence supported the claim at the floor; it does not mean the claim is true. The review reduces hallucination risk and makes distrust visible; it does not eliminate either.

## Constraints

- A simple web search must not incur automatic generic classification or the development acceptance gates; the executor may still invoke FR-03. [S2, S13, S14]
- A request that only publishes, inspects or verifies existing work must not cost a judge call or a boundary; the reading that decides this is local and happens before any call. [S28]
- No extension claim may imply that private model thoughts are observable; enforcement applies to visible actions and completion. [S13]
- A required consultation that fails, abstains, or has no usable answer must not count as approval. This retains the repository's fail-closed policy. [S16]
- Calls should occur at purposeful activity boundaries, not as repeated generic feedback. The owner has not prescribed a numeric call budget. [S14]
- This MVP favors the smallest code and tool surface that implements FR-01 through FR-44. [S15]
- The anti-slop review is external-only and advisory by default. It never establishes truth, never authenticates a source and never approves publication on its own. [S37]
- The reviewed artifact and the review output must not contain meta-text. [S38]
- No web retrieval or source authentication is claimed: the review checks submitted claims against submitted evidence. [S37]

## Current implementation inventory (code-derived, 2026-10-29)

This inventory is descriptive, not a new requirement. It records the behavior of the code at this revision; FR-01 through FR-56 remain normative. The inventory was checked with `bun test` (249 pass, 0 fail, 954 `expect()` calls, 10 files) and `bun run typecheck` (clean) on 2026-10-29.

| Area | Behavior in this revision | Code and verification |
| --- | --- | --- |
| Request entry | `weightOf` reads the prompt once, locally and for free. Publish, inspect and verify phrasing is `quiet`; a change word wins over a routine signal; unrecognised text is `judged`. The reading decides entry only and never opens a registered task's walls. | `src/screen.ts`; `tests/gates.test.ts` "FR-30"; `tests/controller.test.ts` "FR-30" |
| Tool surface | Nine registered tools: `jev_consult`, `jev_triage`, `jev_reaim`, `jev_search_relevance`, `jev_requirements`, `jev_plan_review`, `jev_acceptance`, `jev_review`, `jev_text_review`. `/jev-continue` and recognized owner approval messages release the current request. One judged activity runs per session at a time. | `src/controller.ts`; `tests/controller.test.ts` "the registered surface", "owner-authorized continuation" |
| Triage | One batched boolean decides depth; one boolean per submitted topic decides specialization. A simple result names the skipped activities and registers no task; a development result registers the task. The request must match the current owner prompt. | `src/activities.ts` `triage`; `tests/activities.test.ts` FR-01, FR-02 |
| Pre-triage inspection | Project reads and searches, consequential shell calls, requirement submission, local plan writes and plan review are held until triage. Skill reads, task tracking and non-project reads pass. | `src/gates.ts`; `tests/gates.test.ts`, `tests/controller.test.ts` FR-32 |
| Consequential classification | `write`, `edit`, `ast_edit`, `bash`, `eval`, `task` are consequential by target or command text; unknown tools and unknown devices are consequential; LSP actions are classified; a multi-call wrapper is judged by the calls it carries. Inspections and `git add`, `commit`, `push`, `fetch` pass. | `src/gates.ts` `isConsequentialMutation`, `isNonMutatingCommand`; `tests/gates.test.ts` FR-31 |
| Mutation gate | Holds a consequential change while triage or the plan is missing, the owner's latest message is unjudged, a course check is in flight, a finding is outstanding, the judge is unavailable or a boundary is exhausted. Plan preparation waits for requirements. A quiet reading and a simple verdict skip planning; a consequential write still goes to the action preflight, which for them allows only inspection, verification or publication serving the request. | `src/gates.ts` `mutationGate`, `requirementsBeforePlanGate`; `tests/gates.test.ts` |
| Action preflight | Every admitted consequential call is judged on its complete JSON payload before execution. An oversized payload is refused. An answer that arrives after the task, revision or owner request changed is discarded as stale, and the gates are re-read before execution. | `src/controller.ts`; `src/activities.ts` `actionCheck`; `tests/controller.test.ts` "FR-31 - the admitted payload is judged before it runs" |
| Requirements | One batched call returns per-item support, set coverage and omitted owner needs. A rejected, unsettled or missing item keeps the plan closed. Changes to the approved item list invalidate the plan and its acceptances. | `src/activities.ts` `requirements`; `tests/activities.test.ts` FR-04, FR-05, FR-06, FR-34 |
| Plan review | Requirements must pass first. The outline approves passing steps and retains them while rejected steps are revised. Detail review accepts one complete artifact section per step, resolved by unique heading or exact full text. Overlapping, ambiguous, missing or changed sections are refused. Final review checks assembly consistency and additional scope, then binds the approval to the artifact digest and task. | `src/activities.ts` `planReview`, `src/artifact.ts`; `tests/activities.test.ts` FR-37, section-binding tests |
| Plan handoff | The approve-and-execute switch restores the approved task, plan topics, requirements and draft in the new session only when the copied artifact still matches the approved digest. An ordinary clear, resume or edited artifact restores nothing. | `src/controller.ts`; `tests/controller.test.ts` FR-07 handoff cases |
| Acceptance | Business and architecture are submitted separately. Each requires at least one execution item and one code item. One question per plan topic checks the evidence against that topic. Acceptance is recorded at the work revision; a later consequential change invalidates it. | `src/activities.ts` `acceptance`; `tests/activities.test.ts` FR-14, FR-15, FR-26 |
| Developer review | A checkpoint, commit or diff is judged `sound`, `defect` or `unsupported`. A defect sets a hold; a judge-supported consultation, or a sound review that resolves the held finding, clears it. The review never replaces business or architecture acceptance. | `src/activities.ts` `review`, `consult`; `tests/activities.test.ts` FR-13, FR-16 |
| Text review | The text is split into at most 12 fragments; every submitted rule is asked once per fragment. A violated rule is quoted back byte-identical. An unsettled pair is not a clean review. | `src/activities.ts` `textReview`; `tests/activities.test.ts` FR-27 |
| Course check | `interval` checks after the configured number of successful consequential actions; `completion` checks only at the end. Each recent action is judged against the whole approved plan. A target outside the plan's paths marks a deviation; an interval check runs on that deviation or on the configured count. A check in flight holds changes; no plan topics means no check. | `src/activities.ts` `courseCheck`, `src/controller.ts`; `tests/controller.test.ts` FR-11, FR-12, FR-25 |
| Completion check | One call over the requirements, acceptance records, recent actions and (in completion mode) action directions. The verdict is recorded per work revision. A stop is held until both acceptances pass and the check agrees; repeated identical stops are bounded. | `src/activities.ts` `completionCheck`, `src/gates.ts` `completionGate`; `tests/controller.test.ts` FR-17 |
| Refusal ledger | A digest already refused at a boundary costs no judge call. Three refusals at one boundary record it as OPEN and permit continuation of the current request. Refused calls at a standing boundary are counted and announced. Exhaustion never manufactures approval. | `src/state.ts`, `src/activities.ts` `submitToJudge`; `tests/activities.test.ts`, `tests/gates.test.ts` FR-22, FR-23, FR-28 |
| Judge availability | Three consecutive availability failures declare the judge unavailable, notify the owner and permit continuation with decisions OPEN. Any usable answer clears the count. A malformed or below-floor answer neither approves nor counts as unavailable. | `src/activities.ts` `askJudge`, `src/state.ts`; `tests/controller.test.ts` FR-21 |
| Owner continuation | `/jev-continue` and the recognized standalone approval phrases permit the current request across all gates. Tool arguments, quoted text and extension-originated input do not grant permission. A new task or re-aim does not inherit it. | `src/controller.ts`, `src/state.ts`; `tests/controller.test.ts` "owner-authorized continuation" |
| Judge adapter | Choice, score and boolean questions; typed answers only; no free prose is invented. Request validation before any call; missing key, transport error, malformed answer, unknown label and out-of-range confidence are unusable and never approve. Key resolution uses environment variables or a resolver command. | `src/judge.ts`, `src/apikey.ts`; `tests/judge.test.ts`, `tests/apikey.test.ts` |
| Configuration | The user file loads before the project file. Reads `gates.mutation`, `gates.completion`, `courseCheck.mode` and `courseCheck.interval`; unknown keys are ignored; an invalid value keeps the shipped default and names the file and key. | `src/config.ts`; `tests/config.test.ts` |
| Artifact reader | Reads a `local://` artifact under the session artifact root, refuses a name that escapes the root, and falls back to the host's temporary root when the session root is absent. | `src/artifact.ts`; `tests/artifact.test.ts` |
| Live smoke | Direct-controller and real-OMP host workflows; records judge questions and typed answers; validates typed `details`; never prints or persists the key. | `tools/live-smoke.ts`, `tools/README.md`; `tools/live-smoke.test.ts` |
| Anti-slop review | Triage records an external deliverable; `jev_anti_slop` checks claims, hypotheses, inferences, language, register, meta-text and relevance, returns trust marks and findings, covers numbered parts, holds completion and external delivery in `enforce`, and records owner waivers. | `src/types.ts`, `src/config.ts`, `src/screen.ts`, `src/state.ts`, `src/activities.ts` `antiSlop`, `src/gates.ts`, `src/controller.ts`; `tests/anti-slop.test.ts`, `tests/config.test.ts`, `tests/controller.test.ts` |

## Source register

- **S1:** Owner, current conversation: "триаж задачи. если задача требует этого подбор узконаправленных топиков, например (высокая доступность, отказоустойчивость, ui)".
- **S2:** Owner: "если задача простая или не требует такого погружения, триаж должен сказать явно. например поиск в вебе не требует. но там jev может помочь с выборкой результатов".
- **S3:** Owner's comics-search example: "могла результаты поиска показать jev и посоветоваться что релевантно и почему".
- **S4:** Owner: "планирование задачи. разбивка моих требований на конкретные и проверка каждого через jev на понимание моделью относительно оригинального запроса".
- **S5:** Owner: "каждое самодостаточное и в сумме дают итоговое PRD".
- **S6:** Owner: "сделай пару ручек для конкретных вещей типа план мода (настоящая интеграция в план мод), триажа и так далее. и сделай гибкую ручку когда модель сама определяет тип запроса (чойс, скор, булин) и сама обращается к jev (тут суть научить модель общаться с ним и получать пользу)".
- **S7:** Owner: "имплементация задачи с постоянной сверкой курса, раз в N действий или только по завершении. модель должна советоваться когда она не уверена".
- **S8:** Owner: "приемка задачи. модель пытается защитить свою работу перед jev как бизнесово так и архитектурно".
- **S9:** Owner: "ревью чекпоинта/коммита/диффа где модель также защищается но уже как разработчик".
- **S10:** Owner: "модель только через него решала правильно ли она работает не отошла ли она от требований и что делать".
- **S11:** Owner: "я думаю аддон должен блокировать ллм пока она не будет пропускать важные решения через jev".
- **S12:** Owner: "инструмент форсит модель советоваться с jev чтобы он принимал бизнес решения из контекста или лучшие возможные".
- **S13:** Owner approved removing automatic per-request classification/topic selection and stated that the addon can check only visible actions and completion, not private reasoning (current conversation).
- **S14:** Owner: "переделай флоу так чтобы за минимум вызовов у нас было максимум пользы от jev".
- **S15:** Owner: "минимум кода".
- **S16:** Repository `POLICY` in the archived implementation (`src/types.ts` at commit `4c38d74`): judge errors and uncertain verdicts never approve.
- **S17:** Owner, current conversation: "аддон должен давать понять модели что делать с отказом. что это не временная ошибка".
- **S18:** Owner: "если jev недоступен по сети множество раз. надо уведомить пользователя и работать без него вообще".
- **S19:** Owner: "если он доступен но гейтит, надо обдумать качественно и принять меры, а не долбиться в стену".
- **S20:** Owner: "если он гейтит и руинит разработку, модель застряла, то либо модели кардинально надо пересмотреть все, либо остановить сессию как емердженси случай".
- **S21:** Owner, on the submitted edit list (item numbers as given): "2. да 3. да ... 10. запиши" - the judge-unavailable gate step, the attempt and transport limits, and this PRD record.
- **S22:** Owner: "преработка плана чтобы оценка шла по топикам и исключался вопрос дедлока".
- **S23:** Owner: "сверка курса сейчас похожа на фикцию и слишком часто делается, нужны правила когда спрашивать судью о курсе".
- **S24:** Owner: "приемка кода мне не нравится, тоже на фикцию похожа"; earlier in the same conversation: "надо кормить его описанием того что код делает + lsp + какие то статические вещи, может замер код смелла какой то".
- **S25:** Owner: "у джева был инструмент который укажет конкретные проблемы в тексте ... чтобы jev лучший шаблон прописал. целимся в формальную речь без жаргона и максимальную краткость без потери смысла".
- **S26:** Owner, current conversation: "модель не слушается jev, как ты сейчас не понимаешь что тебе делать. исправь это тоже. это одно из требований, адаптация модели к джеву".

- **S27:** Owner, current conversation: "разреши мне вмешаться явно в сесиию и выставлять курс".
- **S28:** Owner, current conversation: "давай улучшим extensions/jevstice чтобы он на всякие мелочи типа «коммить и пуш» не триггерился вообще, также не тригерился на планирование и другие бесполезные штуки".
- **S29:** Owner, the same request, whose instance names the class FR-31 covers: a commit or a push must not trigger the extension at all, and FR-30 alone would still hold one whenever the prompt carries a change word ("закоммить и запушь исправления") or the reading does not recognise it.
- **S30:** Owner, current conversation: "ожидается что модель со мной окнет все пункты сама в ходе триажа."
- **S31:** Owner, current conversation: "давай порог по плану понизим до 0.6".
- **S32:** Owner, current conversation: "разбей планирование на шаги с частичным аппрувом и все получится".
- **S33:** Owner, current conversation: "ты же знаешь что jev не видит и не помнит ничего? нужно явно давать контекст ему причем выбирать что туда пойдет".
- **S34:** Owner: "цель аддона даже самой глупой llm дать возможность делегировать решения в jev. и чтобы jev вел ее по задаче или задачам"; "я как пользователь даю крайне верхнеуровневое решение и больше ничего. а все остальное сделает llm и аддон".
- **S35:** Owner: "ты предполагаешь что модель не будет игнорировать инструмент и будет советоваться но это крайне оптимистично"; "модель глупа она генерирует текст и старается обойти стены вместо решения".
- **S36:** Owner: "не только плана а всего аддона"; "даю тебе добро на мажорные правки"; "не изобретай велосипед. посмотри то что есть и как это можно улучшить".
- **S37:** Owner, current conversation: "нужна антислоп проверка"; "каждый раз когда работа идет с документом, исследованием, или коммуникацией юридической. вообщем все что не для внутреннего использования"; "нужна жесткая проверка"; "1. исключение галлюцинаций 2. поиск ненадежных фактов 3. чистка лишней и ложной информации 4. перепроверка логических заключений"; "участие пользователя который может выборочно одобрять блокеры или моменты"; "антислоп не должен быть блокером по умолчанию и должен работать только в определенных задачах"; "также джев должен помечать явно какие вещи по его мнению не заслуживают доверия"; "отдельное внимание языку. это может быть русский английский и любой другой. выбранный язык должен соответсвовать по формату, например если пишется юридический док на русском. в нем не допускаются расхождения по стилю и нейрослоп и прочее"; "также найди какой то готовый фреймворк из научной среды по которому проверяются гипотезы и делаются фактчеки. нужна какая то простая реализация для нашего механизма проверок".
- **S38:** Owner, current conversation: "а еще мета текст в любом виде под запретом".
- **S39:** Owner, current conversation: "запиши в PRD и обнови провектные доки чтобы все текущие фичи актуальные из реального кода были явно прописаны".
- **J1:** Jev `requirements_formalization` preparation batch: nine items were not identified as untraceable; its tenth, planning understanding, was rejected and independently checked as J3.
- **J2:** Jev `requirements_formalization` execution batch: 9/9 traceable, 6/6 sources covered.
- **J3:** Jev `claim_check` of the two planning clauses against S4: 2/2 supported.

## Open questions and assumptions

No unresolved owner decision is required to specify the MVP. Host plan-mode hooks and TypeSafe primitive signatures require repository and SDK verification during implementation; this document does not assume particular APIs. FR-45 through FR-56 are implemented and require Jev review; no owner decision is outstanding.
