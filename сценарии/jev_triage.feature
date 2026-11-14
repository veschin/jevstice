# language: en
Feature: Authentic request-scoped triage before judged project work
  Triage decides depth and external-deliverable scope without granting unrelated authority.
  These normative scenarios are specifications, not executed tests. [S:OWNER]

  # [S:PRD FR-10, FR-30, FR-72; S:MANUAL §1]
  @jev_triage_01
  Scenario Outline: Quiet observation needs no triage ritual
    Given no development task is registered
    When the authentic owner requests "<request>"
    And the executor performs only the requested recognized read-only observation
    Then no triage judgment is requested
    And the observation is not held for missing triage
    Examples:
      | request                                      |
      | Inspect the existing export command          |
      | Verify the existing test results             |
      | Сделай саммари статьи по публичной ссылке     |

  # [S:PRD FR-18, FR-30, FR-32; S:CATALOG jev_triage]
  @jev_triage_02
  Scenario Outline: A judged request must settle triage before project work
    Given an authentic owner request to add a dry-run flag has entered the judged workflow
    And no triage decision exists for that request
    When the executor attempts "<operation>"
    Then that operation is held without executing it
    And the refusal identifies triage as the missing decision with a corrective call shape
    Examples:
      | operation                          |
      | read a project source file         |
      | search project source              |
      | submit requirements                |
      | write a local plan artifact        |
      | edit a project file                |
      | run an opaque executable wrapper   |

  # [S:PRD FR-31, FR-32, FR-72; S:MANUAL §1]
  @jev_triage_03
  Scenario Outline: Necessary observation remains available before triage
    Given a judged request is waiting for triage
    When the executor attempts "<operation>"
    Then the operation is not refused for missing triage
    And no triage approval is manufactured
    Examples:
      | operation                                      |
      | read a required skill                          |
      | update task tracking                           |
      | read a public HTTPS documentation URL          |
      | run a recognized literal read-only shell command |

  # [S:PRD FR-02, FR-18, FR-38; S:CATALOG jev_triage; S:POLICY]
  @jev_triage_04
  Scenario: A decisive simple result permits the promised next step
    Given the authentic request is to verify existing export output
    When triage decisively classifies that request as simple with external scope settled
    Then the result explicitly lists the unnecessary deeper development stages
    And no development task is registered
    And the requested verification can reach its ordinary action authorization without requirements or plan review
    But an unrelated project mutation is not authorized by that simple result

  # [S:PRD FR-01, FR-18, FR-32, FR-34; S:CATALOG jev_triage]
  @jev_triage_05
  Scenario: A decisive development result opens inspection but not implementation
    Given the authentic request is to add a dry-run flag and update usage text
    When triage decisively classifies it as development with external scope settled
    Then the exact owner request is registered as the objective
    And project inspection and requirement submission are no longer held for missing triage
    But implementation remains held until requirements and staged plan approval

  # [S:PRD FR-01; S:CATALOG jev_triage]
  @jev_triage_06
  Scenario: Triage selects concrete expertise topics rather than a generic catalog
    Given the authentic request is to add a dry-run flag and update usage text
    And the submitted topics are "export CLI flag" and "usage text"
    When the judge settles development depth and each submitted topic's relevance
    Then only supported narrow task-specific topics are returned
    And rejected topics are not silently promoted into requirements
    And no generic expertise catalog is automatically attached to the prompt

  # [S:PRD FR-45, FR-46, FR-55; S:POLICY]
  @jev_triage_07
  Scenario Outline: External classification travels to the downstream review boundary
    Given a valid authentic request has settled development depth
    When the same triage batch decisively classifies the deliverable as "<scope>"
    Then the registered task carries external scope "<external>"
    And in anti-slop enforce mode "<downstream>"
    Examples:
      | scope    | external | downstream                                                           |
      | external | true     | external delivery waits for the current complete anti-slop review     |
      | internal | false    | no external-only anti-slop hold is imposed on the internal deliverable |

  # [S:PRD FR-20, FR-45; S:POLICY; S:OWNER]
  @jev_triage_08
  Scenario Outline: An unsettled classification never becomes a negative fact
    Given a valid authentic triage request has no prior settled result
    When the judge returns "<answer>"
    Then triage registers neither a development task nor a simple permission
    And the result distinguishes uncertainty from an established defect
    And judged project work remains held for a usable current triage decision
    Examples:
      | answer                                                        |
      | simple probability 0.69 and development probability 0.31        |
      | external probability 0.55 and internal probability 0.45        |
      | a required narrow-topic answer with insufficient confidence    |

  # [S:PRD FR-20, FR-21, FR-23, FR-67; S:POLICY]
  @jev_triage_09
  Scenario Outline: Unusable judge results fail closed without invented approval
    Given a valid authentic triage submission is ready for judgment
    When the judge returns "<failure>"
    Then no triage permission or development registration is created
    And the result identifies unavailable or malformed judgment rather than an established project defect
    And an unresolved workflow finding retains its original submitted material and result
    And no failure count permits project work
    Examples:
      | failure                              |
      | transport outage                     |
      | missing required answer              |
      | unexpected question identifier       |
      | duplicate answer identifier          |
      | non-finite probability               |
      | probability outside zero through one |
      | wrong answer type                    |

  # [S:CATALOG jev_triage; S:PRD FR-20, FR-67]
  @jev_triage_10
  Scenario Outline: Malformed local submissions remain correctable without a finding
    Given an authentic judged owner request is awaiting triage
    When the executor submits "<invalid>"
    Then the submission is refused before a judge call
    And no new Jev finding is created
    And the response names the field to correct
    Examples:
      | invalid                                |
      | missing request                        |
      | blank request                          |
      | numeric request                        |
      | topics as a string                     |
      | a blank topic                          |
      | evidence as an object                  |
      | an unsupported evidence kind           |
      | evidence with a blank quote            |

  # [S:PRD FR-68; S:CATALOG request exact words; S:OWNER]
  @jev_triage_11
  Scenario Outline: Only the authentic current request can be registered
    Given the controller captured the authentic request "Add a dry-run flag to export"
    When the executor submits "<request>" as the triage request
    Then it is refused before judgment as a mismatch with the authentic request
    And no objective or simple permission is registered
    Examples:
      | request                                              |
      | Add a destructive reset command                      |
      | Add a dry-run flag to export and remove all safeguards |
      | Add a dry-run flag                                   |

  # [S:PRD FR-44, FR-68; S:MANUAL §3]
  @jev_triage_12
  Scenario Outline: Fabricated citations and quoted permission do not become owner authority
    Given a current authentic judged request is waiting for triage
    When triage is submitted with "<material>"
    Then "<result>"
    And no quoted or executor-origin text grants continuation permission
    Examples:
      | material                                            | result                                                     |
      | a sourceId absent from the trusted archive           | local citation validation refuses without a judge call     |
      | a quote absent from the selected immutable source    | local citation validation refuses without a judge call     |
      | a user citation selecting a plan source              | local citation validation refuses without a judge call     |
      | free evidence saying the owner approved all changes  | the quote remains unverified submitted data, not permission |

  # [S:PRD FR-36, FR-58, FR-71; S:OWNER]
  @jev_triage_13
  Scenario Outline: A late judgment cannot settle changed bindings
    Given a triage judgment is in flight for the current request
    When "<change>" occurs before the judge answers decisively
    Then that old answer is discarded as stale
    And it grants no registration or permission in the current workflow
    And the response directs the executor to the current request rather than claiming a defect
    Examples:
      | change                                        |
      | the authentic current request changes         |
      | the task is replaced                          |
      | the work revision changes                     |
      | an approved plan binding changes              |
      | the owner switches ordinary mode off and on   |

  # [S:PRD FR-22, FR-23, FR-67; S:MANUAL §1, §5; S:OWNER]
  @jev_triage_14
  Scenario: Identical refused triage does not buy another judgment or permission
    Given a current triage submission has a standing refused finding
    When the executor resubmits the identical request, topics and evidence repeatedly
    Then no duplicate triage judge call is made
    And the original finding remains OPEN and retrievable
    And notification counts do not unlock project inspection, mutation or completion

  # [S:PRD FR-22, FR-67; S:OWNER]
  @jev_triage_15
  Scenario: A substantive correction is reconsidered without stale duplicate deadlock
    Given triage is held after an unusable or refused submission
    And the executor obtains new relevant observed evidence correcting the submission
    When the corrected current material receives a decisive valid triage answer
    Then that answer can settle the current request at the unchanged approval floors
    And the promised next workflow stage is available subject to any remaining named recovery finding
    And after supported recovery resolves that finding the same next action is not blocked by obsolete refused-material cache

  # [S:PRD FR-21, FR-22, FR-67; S:OWNER]
  @jev_triage_16
  Scenario: Restored judge availability can settle the unchanged request
    Given a triage call failed only because the judge transport was unavailable
    And the executor has not changed the owner request
    When service restoration is established and current triage is resubmitted
    Then a usable current answer can be obtained without a changed substantive objective
    But unchanged blind network retries do not release the hold or manufacture approval

  # [S:PRD FR-22, FR-36, FR-67, FR-69; S:MANUAL §1, §6]
  @jev_triage_17
  Scenario: Re-triage cannot erase a registered task's dependent decisions
    Given a development task has approved requirements and an approved plan
    And a developer finding is OPEN on that task
    When the executor submits triage again for the same request
    Then re-triage does not replace the registered task or reset its revision
    And the requirements, plan, acceptance bindings and original finding are preserved
    And triage is not used as recovery or permission to bypass the finding

  # [S:PRD FR-18, FR-30, FR-38, FR-44]
  @jev_triage_18
  Scenario: A simple verdict belongs only to its own owner request
    Given one authentic request received a decisive simple verdict
    When a different authentic owner request asks for a project change
    Then the old simple verdict does not permit that change
    And the new request needs its own current triage decision
    And no old continuation grant is inherited

  # [S:PRD FR-30, FR-69; S:MANUAL §6]
  @jev_triage_19
  Scenario Outline: Follow-ups to development use classification rather than re-triage
    Given a development task already has approved requirements and plan
    When an authentic follow-up is classified as "<classification>"
    Then "<effect>"
    And no simple triage result silently removes the registered development gates
    Examples:
      | classification | effect                                                            |
      | continuation   | existing approvals and findings remain                            |
      | amendment      | the objective extends and dependent approvals reopen without re-aim |
      | replacement    | re-aim is required before a fresh requirement and plan workflow     |
      | unclear        | consequential work waits for evidence-bound clarification          |

  # [S:PRD FR-31, FR-32, FR-38; S:CATALOG]
  @jev_triage_20
  Scenario Outline: Native and write-device routes have equivalent triage effects
    Given the same authentic owner request and valid submitted material
    When the executor submits triage through "<route>"
    And the same decisive valid judge result is returned
    Then the same request-scoped depth, topics and external classification are observable
    And the same prerequisites and subsequent action gates apply
    Examples:
      | route                                             |
      | native jev_triage                                  |
      | write xd://jev_triage with its JSON argument object |

  # [S:PRD FR-71; S:MANUAL §0]
  @jev_triage_21
  Scenario Outline: Disabled ordinary mode never masquerades as triage approval
    Given the owner has disabled the ordinary addon for this session
    When the executor invokes triage through "<route>"
    Then an explicit disabled or skipped result is returned without a judge call
    And no task, simple verdict, finding or source capture is created by that call
    And ordinary work does not wait for triage while disabled
    Examples:
      | route                |
      | native jev_triage     |
      | write xd://jev_triage |

  # [S:PRD FR-57, FR-58, FR-62, FR-71; S:MANUAL §0]
  @jev_triage_22
  Scenario: Strict workflow cannot be reset or bypassed through ordinary triage
    Given a bound strict autonomous run already has its registered development objective
    When the executor attempts triage again with ordinary disable or continuation text
    Then triage does not replace the strict objective or grant a simple-task bypass
    And ordinary mode or continuation text grants no strict admission permission
    And the current task still requires its applicable requirements and plan approvals

  # [S:PRD FR-68; S:CATALOG request exact words]
  @jev_triage_23
  Scenario Outline: Authentic owner capture supplies the request rather than executor inventions
    Given the native host receives the owner's complete request through "<origin>"
    When the executor submits that same request for triage
    Then the judged objective uses the captured owner text
    And agent companions and revival do not create additional owner records
    And a source-bound owner quote can select only a matching authentic owner record
    Examples:
      | origin                                     |
      | interactive input                          |
      | RPC input                                  |
      | a native user-containing print-mode prompt |

# Implementation audit
# Static inspection only. No scenario runner or step definitions were added, and no builds,
# tests, lint, formatters or live judge calls were run. IMPLEMENTED_STATIC means the inspected
# branch supports the specified behavior, not that this scenario passed in execution. [S:OWNER]
# Production files are concurrently editable by the parent; anchors below describe the live
# bytes inspected during this audit, not proof of any subsequent integrated revision. [S:OWNER]
#
# @jev_triage_01 DEFECT_STATIC
# Producer src/screen.ts:25-30 omits English "inspect" and "verify" from ROUTINE.
# "Inspect the existing export command" contains neither a recognized routine nor change token,
# so weightOf at :45-49 returns judged -> state.screenRequest src/state.ts:563-569 ->
# controller src/controller.ts:789-793 -> triageBeforeInspectionGate src/gates.ts:880-916
# holds the requested project read. The Russian summary row is supported; the verification row
# contains "test" and is recognized. Missing proof: native quiet-observation runs for all rows. [S:CODE]
#
# @jev_triage_02 IMPLEMENTED_STATIC
# Authentic request -> controller src/controller.ts:789-793 screenRequest ->
# src/gates.ts:874-916 inspection/requirements/local-plan refusal and :1012-1070 mutation refusal ->
# controller :837-843,:877-879 refuse before dispatch. src/gates.ts:245-246,:297-301,:389-393
# supplies the corrective triage shape; controller :507-523 counts but releases nothing.
# Missing proof: each native/device operation held without effects in a real host. [S:CODE]
#
# @jev_triage_03 IMPLEMENTED_STATIC
# src/gates.ts:887-908 exempts skill/nonproject/HTTP(S) reads and recognized read-only shell ->
# controller src/controller.ts:837-840 accepts the nonblocking triage verdict.
# Task tracking is absent from inspection tools and is read-only at src/gates.ts:48-68.
# Missing proof: host admission of the table rows while a real triage judgment is absent. [S:CODE]
#
# @jev_triage_04 IMPLEMENTED_STATIC
# src/activities.ts:901-917 recognizes decisive simple depth and names skipped stages ->
# src/state.ts:552-555 registerSimple -> src/gates.ts:1051-1057 bypasses deeper development ->
# controller src/controller.ts:882-904 still submits the complete consequential payload to actionCheck.
# tests/activities.test.ts:381-394 supports the simple branch but was not run here.
# Missing proof: requested verification admitted and unrelated mutation refused by a live judge. [S:CODE]
#
# @jev_triage_05 IMPLEMENTED_STATIC
# src/activities.ts:850-857 binds captured request content; :920-929 registerTask ->
# src/state.ts:515-520 -> src/gates.ts:881-883 opens inspection, :1059-1070 still requires plan;
# requirements src/activities.ts:1035-1045 consumes the registered objective.
# tests/activities.test.ts:360-378 supports registration and held mutation, not execution proof. [S:CODE]
#
# @jev_triage_06 IMPLEMENTED_STATIC
# Submitted topics -> src/activities.ts:879-886 asks one task-specific relevance question each ->
# saidTrue src/judge.ts:287-293 filters at the boolean floor -> activities :911,:921-929
# returns only selected labels. No generic catalog is generated in screen.ts:45-49.
# tests/activities.test.ts:360-378 asserts selected versus generic topics, not an observed pass.
# Gap: with no candidate topics the judge cannot introduce an omitted specialization; no scenario
# here assumes the typed boolean API can generate unsubmitted topic text. [S:CODE]
#
# @jev_triage_07 IMPLEMENTED_STATIC
# activities src/activities.ts:870-877 batches external classification with depth, :901,:920
# passes its decisive external value -> state src/state.ts:515-520 stores it ->
# antiSlopScope :727-742 -> actionCheck src/activities.ts:2594,:2688-2718 requires complete
# current reviews for external delivery in enforce mode. Internal scope is undefined.
# tests/anti-slop.test.ts:691-711 supports registration only; delivery execution remains unproved. [S:CODE]
#
# @jev_triage_08 DEFECT_STATIC
# activities src/activities.ts:901 treats every external probability below 0.7 as internal,
# including 0.55 -> registerTask :920 -> antiSlopScope src/state.ts:727-742 returns undefined ->
# actionCheck activities :2594 omits the external-delivery review boundary. Uncertainty bypasses
# the external-only review rather than settling internal scope at the same reliability floor.
# Topic probability below floor is silently excluded at :911 rather than explicitly unsettled.
# Depth uncertainty is held at :904-909, but its missing details.kind causes controller :701 ->
# state.recordRecovery :292-295,:336 to store generic refusal instead of uncertainty.
# Missing proof: current-host uncertainty cases and corrected implementation regression. [S:CODE]
#
# @jev_triage_09 UNVERIFIED
# Production adapter src/judge.ts:154-171 rejects absent/extra/wrong-type/nonfinite/out-of-range
# boolean answers; :243-251 catches transport failures -> activities :894-899 -> unusable :218-226 ->
# controller :701 -> recordRecovery src/state.ts:321-375 preserves the original finding.
# askJudge activities :471-475 counts availability without granting permission.
# Duplicate raw answer keys are not observable after the SDK supplies an object; normalization
# does not authenticate duplicate-key-free wire JSON. Missing proof: raw SDK duplicate-key behavior,
# injected typed Judge answers outside the adapter, and native malformed/outage execution. [S:CODE]
#
# @jev_triage_10 DEFECT_STATIC
# Native catalog src/guidance.ts:83-87 validates broad topic array shape but allows blank strings.
# activities src/activities.ts:860 -> readStrings :238-245 silently converts nonarrays to []
# and drops blank/nonstring topic entries; no local refusal is returned for those rows.
# Request/evidence validation :841-859,:248-277 -> refused :194-199 correctly creates invalid
# results -> controller :701 -> state.recordRecovery :327-330 creates no finding.
# Missing proof: malformed native versus device payload parity and exact error-field feedback. [S:CODE]
#
# @jev_triage_11 IMPLEMENTED_STATIC
# controller src/controller.ts:789-793 -> state.screenRequest :563-569 stores current text ->
# triage activities src/activities.ts:850-857 compares normalized content before judge submission :889.
# Same-content whitespace variants use original captured text, not the executor's spelling.
# tests/activities.test.ts:406-427 supports exact-content binding and mismatch refusal.
# Gap: if no request was captured at all, :857 falls back to executor-supplied request; this
# scenario requires a captured request and does not assert absent-host-input authentication. [S:CODE]
#
# @jev_triage_12 IMPLEMENTED_STATIC
# controller src/controller.ts:291-321 prepareContext resolves sourceId, verifies substring and
# owner source kind -> :695 before runActivity :698; catch :704-707 returns invalid without
# judgment/finding. activities :405-427 distinguishes verified provenance from free submitted data.
# Only authentic input handlers controller :655-673/:594-606 grant ordinary continuation.
# Missing proof: corrupted archive and free-quote injection across real native/device routes. [S:CODE]
#
# @jev_triage_13 DEFECT_STATIC
# askJudge activities src/activities.ts:442-464 snapshots task/revision/context and discards a
# changed result, but returns kind "unusable"; triage :894-899 invokes default unusable rather
# than stale -> controller :701 -> recordRecovery state :331-336 records an unavailable hold.
# Thus old answers do not approve changed bindings, but can manufacture a current finding.
# Mode replacement is correctly detached by controller :273,:686-699,:710-711.
# Missing proof: asynchronous interleavings for each table row in a fresh host. [S:CODE]
#
# @jev_triage_14 DEFECT_STATIC
# First unsettled triage -> recordRefusal activities src/activities.ts:905 with boundary "triage";
# controller :701 records heldFinding under "jev_triage" -> next material activities :425
# now contains that hold -> submitToJudge :492-495 obtains a different digest for identical params.
# The second identical submission can therefore spend a judge call before later repeats stabilize.
# submissionLedger state src/state.ts:638-649 prevents identical digests only; counts do not release.
# Also completionGate src/gates.ts:1220-1228 returns applies:false with no task despite a triage hold,
# so controller completion can terminate without resolving that triage finding.
# Missing proof: exact same-input repeat and stop sequence in the real host. [S:CODE]
#
# @jev_triage_15 DEFECT_STATIC
# New evidence changes material -> submitToJudge activities src/activities.ts:486-508 can judge
# a substantive correction at unchanged floors. But registration activities :913/:920 ->
# state.registerSimple :552-555 or registerTask :515-520 -> clearWork :480-506 erases the original
# triage hold and refusal history instead of preserving it until the named recovery resolves.
# Conversely clearResolvedHold state :444-447 retires exact hold-boundary rows only:
# controller "jev_triage" and submission ledger "triage" differ, leaving stale refusal rows.
# Missing proof: correction -> pass -> any required resolve -> original next-action admission;
# no historical action-cache incident is treated as proof of this triage defect. [S:CODE]
#
# @jev_triage_16 UNVERIFIED
# Outage -> activities src/activities.ts:894-899 returns unusable without recordRefusal ->
# submitToJudge :494-508 allows unchanged current material to reach askJudge again;
# valid answers :465-469 reset availability. A triage hold allows same failed activity through
# recoveryGate src/gates.ts:1102 and controller :690-698.
# No automatic network retry loop is present in that path; host/executor discipline for establishing
# service restoration before manual resubmission is not execution-proved by these bytes. [S:CODE]
#
# @jev_triage_17 IMPLEMENTED_STATIC
# Existing task -> activities src/activities.ts:844-848 returns prerequisite before registerTask;
# developer hold -> recoveryGate src/gates.ts:1077-1104 refuses unrelated triage even earlier.
# Neither branch calls clearWork or resets revision/dependent decisions.
# Missing proof: retriage attempted with all dependent approvals and an original standing finding. [S:CODE]
#
# @jev_triage_18 IMPLEMENTED_STATIC
# New before_agent_start -> controller src/controller.ts:789 deletes simple, :792 screens request;
# continuationAllowed state binding prevents inheriting different-request permission ->
# mutationGate src/gates.ts:1051-1057 requires current triage.
# Missing proof: different authentic request after simple approval with prior continuation grant. [S:CODE]
#
# @jev_triage_19 IMPLEMENTED_STATIC
# input -> controller src/controller.ts:655-663 captureOwner -> state.queueOwnerMessage :278-283 ->
# controller :829-835 updateOwner at applicable boundary -> ownerUpdate activities :795-831.
# Continuation preserves state, amendment :802-808 accumulates objective/invalidatePlan,
# replacement :815-820 sets directionPending, unclear :823-831 records uncertainty.
# Existing-task triage :844-848 cannot downgrade development to simple.
# Missing proof: native chronological follow-ups and dependent gate effects for all table rows. [S:CODE]
#
# @jev_triage_20 UNVERIFIED
# Native catalog registration controller src/controller.ts:728-744 routes to triage through run;
# gates src/gates.ts:191-201 identifies xd://jev_triage as nonmutating, controller :827-828
# recognizes the logical device name. Actual write-device JSON dispatch belongs to the host and
# is not implemented by these extension bytes. No xd://jev_triage host-equivalence result was
# observed; equivalence must not be claimed solely from native handler registration. [S:CODE]
#
# @jev_triage_21 UNVERIFIED
# controller src/controller.ts:571-590 swaps to disabled fresh state; run :678 and :710 returns
# DISABLED_OUTCOME; captureOwner :324-325, input :655-656, toolCall :812-817 and prompt :771
# bypass ordinary activity/source/gate effects. Native branch is statically supported.
# Missing proof: host write-device dispatch honors the same disabled result and creates no source;
# no actual native/device execution was performed here. [S:CODE]
#
# @jev_triage_22 IMPLEMENTED_STATIC
# strict restore autonomy/runtime.ts:993-1028 registers immutable run.objective under a committed
# audience receipt, deletes ordinary simple/continuation and refuses objective/audience mismatch ->
# triage src/activities.ts:844-848 refuses existing task replacement.
# Controller src/controller.ts:558-560/:599-602 refuses ordinary disable/continuation in strict mode;
# strict beforeTool :814-815 executes before ordinary admission.
# Missing proof: bound strict-run native attempts with quoted mode/continuation text. [S:CODE]
#
# @jev_triage_23 IMPLEMENTED_STATIC
# Interactive/RPC controller src/controller.ts:655-662 -> captureOwner :324-333 ->
# state.queueOwnerMessage :278-283; native reason=prompt fallback controller :778-782 deduplicates
# captured input; revive :775 and nonprompt companions create no fallback owner archive entry.
# prepareContext :303-308 requires authentic owner source for source-bound user quotes ->
# triage activities :850-857 uses captured request content.
# tests/controller.test.ts:1811-1826 supports initial print-prompt deduplication and revive exclusion;
# it is not an observed passing run. Missing proof: full real-host capture matrix and companion turns. [S:CODE]
#
# Source register
# S:OWNER = direct delegated assignment: normative English scenarios before live code audit;
# passed checks permit next steps, substantive correction remains possible, no stale deadlock,
# unsafe bypass, lowered floor, count permission or unchanged blind network retries.
# S:PRD = PRD.md, normative FR-01, FR-02, FR-10, FR-18, FR-20..23, FR-28..38,
# FR-44..46, FR-55, FR-57..58, FR-62, FR-67..72 and constraints.
# S:CATALOG = src/guidance.ts:23-24,80-93 (documented jev_triage contract and schema).
# S:POLICY = src/types.ts:4-6,19-43 (fail-closed floors and non-authorizing counters).
# S:MANUAL = src/jev-skill.md §§0..6 (documented user-visible workflow).
# S:GHERKIN = https://cucumber.io/docs/gherkin/reference/ (Feature, Scenario Outline, tags, comments).
# S:CODE = inspected src/activities.ts, src/controller.ts, src/gates.ts, src/judge.ts,
# src/screen.ts, src/state.ts, autonomy/runtime.ts and the precisely cited existing test sources.
# Open questions
# GAP-01: Parent/integrator must execute native/device and asynchronous scenario checks; this
# assignment prohibits running them and no Gherkin step definitions or runner are supplied.
# GAP-02: Host/SDK maintainers can establish whether raw duplicate JSON answer keys survive
# or are rejected before src/judge.ts receives its object; this repository path does not establish it.
# GAP-03: Parent/integrator must reconcile audit anchors/statuses if concurrent production edits
# supersede the inspected bytes; no static status here grants integration acceptance.
# Assumptions
# None.
