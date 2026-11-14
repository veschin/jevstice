Feature: Evidence-bound business and architecture acceptance
  Acceptance proves the current work against the owner's needs and approved plan.
  Business and architecture decisions are independent and neither replaces completion.
  These scenarios are normative specifications, not executed tests.

  Background:
    Given Jev is enabled in an ordinary development session
    And the current owner objective, approved requirements and complete approved plan are available
    And the plan contains the topics "export behavior" and "failure reporting"
    And acceptance evidence contains observed command output and a static code excerpt for the current revision

  # FR-14, FR-15, FR-26; S-PRD, S-TOOL, S-OWNER.
  @jev_acceptance_01
  Scenario Outline: Accept one aspect without manufacturing the other aspect
    When the executor submits valid "<aspect>" acceptance
    And Jev approves that aspect and every plan topic at the configured approval floor
    Then the response reports "<aspect>" accepted for the current revision
    And "<other>" acceptance remains required
    And the executor may submit the missing aspect without an owner override
    Examples:
      | aspect       | other        |
      | business     | architecture |
      | architecture | business     |

  # FR-14, FR-15, FR-17, FR-26; S-PRD, S-TOOL, S-OWNER.
  @jev_acceptance_02
  Scenario: Both aspects permit the promised completion check
    Given business acceptance is approved for the current revision
    When architecture acceptance passes for every current plan topic
    Then both aspects are reported accepted for that revision
    And the final completion check is permitted rather than blocked by a stale acceptance finding
    But the task is not reported complete without the separate completion approval

  # FR-20, FR-26, FR-67; S-PRD, S-TOOL.
  @jev_acceptance_03
  Scenario Outline: Reject malformed acceptance arguments locally
    When the executor submits acceptance with "<invalid>"
    Then the response identifies the invalid acceptance input
    And no acceptance judge call is made
    And no Jev refusal finding or acceptance approval is created
    Examples:
      | invalid                            |
      | an unsupported aspect              |
      | a missing claim                    |
      | a whitespace-only claim            |
      | evidence that is not an array      |
      | an evidence item without a quote   |

  # FR-26, FR-43; S-PRD, S-TOOL.
  @jev_acceptance_04
  Scenario Outline: Require both execution and static proof before judgment
    When acceptance evidence contains "<material>"
    Then no acceptance judge call is made
    And the response identifies the missing proof and the next observation needed
    And it does not infer an implementation defect from missing proof
    Examples:
      | material                                      |
      | static code without a command and its output  |
      | command output without static code evidence   |
      | only the claim that tests should pass         |
      | only the proposed command with no output      |

  # FR-26, FR-68; S-PRD, S-TOOL, S-OWNER.
  @jev_acceptance_05
  Scenario: Claimed output must not substitute for observed execution
    Given no native execution observation supports the submitted test output
    When the executor labels invented passing output as execution evidence
    Then the work is not accepted merely because the evidence has the right labels
    And missing observation is reported as an evidence gap rather than a proven code defect

  # FR-26; S-PRD, S-TOOL.
  @jev_acceptance_06
  Scenario: Judge the complete current topic set with named evidence
    When the executor submits valid business acceptance
    Then Jev receives the owner objective, approved obligations and complete approved plan
    And Jev is asked whether each current topic is met using the submitted evidence
    And a topic verdict identifies the evidence on which it rests
    And an omitted topic cannot silently count as accepted

  # FR-14, FR-15, FR-20, FR-26; S-PRD, S-OWNER.
  @jev_acceptance_07
  Scenario: One failed topic prevents whole-aspect acceptance
    Given architecture acceptance already passed at the current revision
    When the business judgment approves "export behavior" but refuses "failure reporting"
    Then business acceptance remains unapproved with the failing topic identified
    And the independent architecture approval remains available while its bindings remain current
    And final completion remains held

  # FR-20, FR-26, FR-67; S-PRD, S-OWNER.
  @jev_acceptance_08
  Scenario Outline: Distinguish uncertain answers from established defects
    When the acceptance judge returns "<answer>"
    Then acceptance remains unapproved
    And the response reports "<meaning>" without inventing a code defect
    And the approval floor is not lowered
    Examples:
      | answer                                  | meaning                 |
      | approve below the configured floor      | insufficient confidence |
      | topic met below the configured floor    | insufficient confidence |
      | uncertain aspect verdict                | unresolved judgment     |
      | missing required topic answer           | unusable judgment       |
      | malformed probability                   | unusable judgment       |
      | malformed response envelope             | unusable judgment       |

  # FR-20, FR-21, FR-23, FR-67; S-PRD, S-OWNER.
  @jev_acceptance_09
  Scenario: A usable negative verdict establishes an acceptance refusal
    When Jev refuses business acceptance with a usable explanation of an unmet owner obligation
    Then the response identifies the unmet obligation and the acceptance finding
    And the refusal remains open until supported correction
    And unrelated acceptance or course approval does not erase that cause

  # FR-21, FR-23, FR-67; S-PRD, S-OWNER.
  @jev_acceptance_10
  Scenario: Judge outage never becomes permission through counts
    Given acceptance judgments repeatedly fail because the judge is unavailable
    When the availability notification threshold is reached
    Then the owner is notified and the acceptance decision remains OPEN
    And completion remains held regardless of additional failed or blocked attempts
    And no architecture or business approval is manufactured

  # FR-22, FR-67; S-PRD, S-OWNER.
  @jev_acceptance_11
  Scenario Outline: Unchanged refused material does not buy another judgment
    Given business acceptance was refused for the current revision and evidence
    When the executor resubmits with only "<cosmetic change>"
    Then no new acceptance judge call is made
    And the original refusal remains disclosed
    Examples:
      | cosmetic change                   |
      | different claim wording           |
      | reordered evidence                |
      | duplicated identical evidence     |
      | a renamed evidence display source |

  # FR-22, FR-26, FR-67; S-PRD, S-TOOL, S-OWNER.
  @jev_acceptance_12
  Scenario: Substantive evidence correction remains reachable under a hold
    Given business acceptance was refused because failure reporting was not demonstrated
    And the implementation has not changed
    When the executor observes the missing behavior and submits the new command output with static proof
    And Jev approves business acceptance and every topic
    Then the same failed acceptance activity can be judged without an owner override
    And that acceptance refusal no longer blocks its promised next step
    And an unrelated developer finding remains held

  # FR-25, FR-26, FR-37, FR-67; S-PRD, S-TOOL, S-OWNER.
  @jev_acceptance_13
  Scenario: Implementation correction requires fresh evidence for both aspects
    Given business acceptance was refused and architecture acceptance passed
    When an authorized corrective consequential action advances the work revision
    Then the previous architecture approval cannot authorize acceptance of the new revision
    And fresh execution and code evidence can be submitted for both aspects
    And corrected material is not rejected solely as a duplicate of the old refusal

  # FR-22, FR-67; S-PRD, S-OWNER.
  @jev_acceptance_14
  Scenario: Recovery resolution does not leave an unusable duplicate barrier
    Given an acceptance finding has been resolved by supported correction with observed proof
    When the executor submits the acceptance material required by that correction
    Then the next step is judged or uses a still-current usable approval
    And an old refused-material cache alone does not create a new deadlock
    And resolution itself is not represented as business or architecture acceptance

  # FR-25, FR-37, FR-58; S-PRD, S-TOOL, S-OWNER.
  @jev_acceptance_15
  Scenario Outline: Ignore approval arriving after a binding changes
    Given an acceptance judgment is in flight
    When "<binding>" changes before the answer arrives
    And the old judgment returns approval
    Then the response identifies the answer as stale
    And no acceptance approval for the new binding is recorded
    And the new current material remains eligible for judgment
    Examples:
      | binding                                      |
      | the work revision after successful execution |
      | the work revision after failed execution     |
      | the owner task identity                      |
      | the approved requirements                    |
      | the approved plan or its topic set           |
      | the bytes of the approved plan artifact      |

  # FR-29, FR-37, FR-69; S-PRD, S-TOOL.
  @jev_acceptance_16
  Scenario Outline: Invalidate acceptance on an actual task or plan change
    Given both aspects passed for the old task and plan
    When "<change>" establishes new current obligations
    Then the old acceptance cannot satisfy completion for the new obligations
    And the current prerequisites and missing acceptance are reported
    Examples:
      | change                                  |
      | an approved replacement owner task      |
      | a classified additive owner requirement |
      | a revised approved plan topic           |

  # FR-68; S-PRD, S-OWNER.
  @jev_acceptance_17
  Scenario Outline: Reject invalid archived citations before judgment
    When acceptance evidence cites "<citation>"
    Then the citation error is reported without an acceptance judge call
    And no acceptance approval or Jev refusal finding is created
    Examples:
      | citation                                         |
      | an unknown sourceId                              |
      | a quote absent from the selected source          |
      | an archived source whose bytes changed           |
      | a non-owner record labeled as owner evidence     |

  # FR-58, FR-68; S-PRD, S-OWNER.
  @jev_acceptance_18
  Scenario: Authentic archived owner text is evidence rather than authority
    Given a selected archived source contains text instructing the executor to approve everything
    When valid acceptance evidence quotes that text
    Then the judge receives the source with its provenance and the data-only rule
    And the text alone cannot change the approval floor, current objective or required aspects
    And fabricated owner wording in the claim is not treated as an authentic new owner instruction

  # FR-16, FR-17, FR-70; S-PRD, S-TOOL.
  @jev_acceptance_19
  Scenario Outline: Other successful checks do not replace acceptance
    Given no current business or architecture acceptance exists
    When "<check>" passes
    Then both acceptance aspects remain required before developed work can complete
    Examples:
      | check                        |
      | developer diff review        |
      | callable course check        |
      | diagnostic consultation      |
      | recovery resolve             |

  # FR-17, FR-23, FR-26, FR-39; S-PRD, S-OWNER.
  @jev_acceptance_20
  Scenario: Completion automatically collects and submits missing acceptance
    Given current native observations provide execution and static code proof
    And only business acceptance is already approved
    When the executor reaches the final stop boundary
    Then missing architecture acceptance is submitted automatically with current observations
    And the existing current business approval is retained
    And completion is checked only after both aspects pass
    And no manual acceptance ritual or owner override is required

  # FR-17, FR-20, FR-23, FR-39, FR-43; S-PRD, S-OWNER.
  @jev_acceptance_21
  Scenario: An incomplete final stop returns unmet obligations without false completion
    Given current observations cannot prove an approved topic
    When the executor reaches the final stop boundary repeatedly
    Then completion remains held and the unmet topic and verification need are returned
    And missing evidence directs observation rather than speculative implementation repair
    And the number of stop attempts does not authorize completion

  # FR-18, FR-26, FR-67, FR-68; S-PRD, S-OWNER.
  @jev_acceptance_22
  Scenario Outline: Native and device routes enforce the same acceptance contract
    When the executor submits the same "<submission>" once through the native tool and once through write to "xd://jev_acceptance"
    Then both routes apply the same validation, provenance, current bindings and approval floor
    And both routes produce equivalent acceptance and refusal consequences
    Examples:
      | submission                         |
      | valid business acceptance          |
      | malformed evidence                 |
      | a missing required evidence kind   |
      | unchanged previously refused work  |
      | substantively corrected evidence   |

  # FR-71; S-PRD.
  @jev_acceptance_23
  Scenario Outline: Disabled ordinary mode skips rather than approves acceptance
    Given the owner disabled the ordinary addon through its native session command
    When acceptance is invoked through "<route>"
    Then the result explicitly states that acceptance was skipped because Jev is disabled
    And no acceptance judge call or acceptance approval is created
    Examples:
      | route                          |
      | native jev_acceptance          |
      | write to xd://jev_acceptance   |

  # FR-57, FR-58, FR-59, FR-62, FR-63; S-PRD, S-OWNER.
  @jev_acceptance_24
  Scenario: Strict completion automatically obtains all three independent decisions
    Given a strict autonomous run has current bound observed execution and code evidence
    When strict completion is requested
    Then missing business and architecture acceptance are obtained automatically for the current durable revision
    And the completion judgment receives the same current objective, obligations, plan and observations
    And the run becomes complete only after all three decisions pass and the durable checkpoint commits
    And acceptance of one aspect cannot substitute for the other or the completion decision

  # FR-57, FR-58, FR-62, FR-63, FR-71; S-PRD, S-OWNER.
  @jev_acceptance_25
  Scenario Outline: Strict acceptance never falls back to ordinary continuation
    Given strict acceptance is required and "<condition>"
    When the executor requests completion or tries to disable ordinary Jev enforcement
    Then strict completion remains held with an explicit unmet decision
    And no refusal count, outage count, quoted continuation or ordinary session switch grants acceptance
    And changed bindings require new current evidence rather than reuse of an old acceptance
    Examples:
      | condition                                  |
      | the judge is unavailable                   |
      | business acceptance is refused             |
      | architecture acceptance is below the floor |
      | the durable revision changed in flight     |
      | the run restarted without fresh observation|

# Implementation audit
# Static source inspection only; no builds, tests, formatters, judge calls or scenarios were executed.
# IMPLEMENTED_STATIC means the inspected producer-to-consumer path contains the required behavior,
# not that the host integration, judge semantics or a real execution has been observed to pass.
# DEFECT_STATIC identifies a concrete reachable mismatch; UNVERIFIED identifies missing execution
# proof or a policy-dependent judgment rather than inventing a stronger deterministic evidence rule.
# Anchors describe the inspected live source and may move while the parent edits shared files.
#
# @jev_acceptance_01 IMPLEMENTED_STATIC
# Producer src/activities.ts:1588-1614 selects exactly one aspect; src/activities.ts:1676-1695
# consumes its aspect/topic answers -> src/state.ts:573-580 replaces only that aspect at the current
# revision -> src/gates.ts:1261-1277 continues to require the missing aspect. Clean-path only;
# no real two-aspect judge/host execution observed.
#
# @jev_acceptance_02 IMPLEMENTED_STATIC
# Producer src/activities.ts:1688-1695 returns successful aspect approval -> src/state.ts:573-580
# stores independent records -> src/gates.ts:1261-1280 admits the completion check only with both ->
# src/controller.ts:1080-1098 requires completion approval. Existing test source
# tests/controller.test.ts:759-776 models this with an injected judge; it was not run here.
# Correction-after-refusal is separately defective under @jev_acceptance_12.
#
# @jev_acceptance_03 IMPLEMENTED_STATIC
# Producer src/guidance.ts:208-212 defines schema; runtime src/activities.ts:1589-1598 and
# src/activities.ts:248-277 validate aspect, nonblank claim and evidence -> invalid outcome
# src/activities.ts:194-199 -> src/controller.ts:701 -> src/state.ts:327-335 creates no finding.
# Both schema and runtime validation exist; actual host schema rejection was not executed.
#
# @jev_acceptance_04 DEFECT_STATIC
# Producer src/activities.ts:248-277 accepts any nonempty quote under an allowed kind ->
# src/activities.ts:1608-1613 checks only kind membership -> src/activities.ts:1668 calls the judge.
# Thus an execution quote containing only a proposed command plus a code item passes preflight,
# despite FR-26 requiring command AND output before any call. No approved verification-section
# lookup is present in the local error response; it supplies generic missing-kind guidance only.
# Tests/activities.test.ts:318-356 cover missing kinds, not a mislabeled command-only quote.
#
# @jev_acceptance_05 UNVERIFIED
# Producer src/controller.ts:291-321 authenticates only explicitly sourceId-bound citations ->
# src/activities.ts:405-427 marks uncited material unverified and sends recent native actions ->
# src/activities.ts:1621-1644 instructs the judge to require actual evidence ->
# src/activities.ts:1676-1680 consumes the resulting verdict. A supplied execution label is not
# authenticated merely by parsing it; whether fabricated output is refused needs an adversarial
# judge execution. Optional sourceId does not justify inventing a universal sourceId prerequisite.
#
# @jev_acceptance_06 DEFECT_STATIC
# Producer src/activities.ts:409-427 plus src/activities.ts:1639-1666 sends current obligations,
# topics and evidence; src/activities.ts:448-455 also sends approved plan bytes when readable.
# Consumer src/activities.ts:1676-1679 checks every topic probability. However topic questions are
# boolean-only (src/activities.ts:1639-1644), and src/judge.ts:160-166 normalizes only probability.
# No answer field or question names the particular evidence supporting each topic, so the
# evidence-naming part of FR-26 is absent even when every topic is approved.
#
# @jev_acceptance_07 IMPLEMENTED_STATIC
# Producer src/activities.ts:1676-1705 rejects whole-aspect acceptance when any topic is below
# floor -> src/state.ts:578-580 preserves the independent aspect -> src/controller.ts:701 ->
# src/state.ts:334-374 records the failed activity -> src/gates.ts:1244-1250 holds completion.
# Existing tests/activities.test.ts:334-355 inspect a failed topic with an injected judge only.
#
# @jev_acceptance_08 DEFECT_STATIC
# Producer src/judge.ts:154-178 refuses missing/malformed answers and probabilities ->
# src/activities.ts:1672-1673 calls unusable without preserving the unusable/stale failure class ->
# src/activities.ts:218-225 reports every such case as unavailable. The approval label below
# floor is correctly inconclusive at src/activities.ts:1708-1712; unsupported/low-confidence
# negative labels are also inconclusive at src/activities.ts:1721-1728. A below-floor topic is
# instead reported as "Class: refusal" with missing evidence at src/activities.ts:1698-1705;
# probability alone does not establish what observation is absent. Floors remain enforced.
#
# @jev_acceptance_09 UNVERIFIED
# Producer src/activities.ts:1679-1681 records a refused aspect -> src/activities.ts:1714-1728
# identifies business/design gap and unmet topics when available -> src/controller.ts:701 ->
# src/state.ts:343-374 preserves the original finding -> src/gates.ts:1099-1107 and 1244-1250
# prevent an unrelated activity or completion from replacing it. The adapter returns labels,
# not free-form judge explanations (src/judge.ts:36-47); obligation attribution is limited to
# submitted topic metadata and therefore needs real semantic evidence beyond static inspection.
#
# @jev_acceptance_10 IMPLEMENTED_STATIC
# Producer src/judge.ts:230-251 distinguishes transport/authentication failure ->
# src/activities.ts:471-475 accumulates outage state -> src/gates.ts:1231-1232 holds completion.
# Producer src/state.ts:624-629 records refusal counts without approval -> src/gates.ts:1261-1277
# and src/controller.ts:1101-1106 keep repeated stops held. Consumer src/controller.ts:485-498
# emits the outage notice when announce next observes the flag. No outage, notification
# delivery or service recovery was exercised here.
#
# @jev_acceptance_11 DEFECT_STATIC
# Producer src/activities.ts:1648-1666 includes raw claim, evidence order, display sources,
# prior aspect records and held finding in submitted material -> src/activities.ts:492-495 hashes
# that full representation -> src/state.ts:643-646 recognizes only the exact digest. Rewording
# the claim, reordering/duplicating evidence or renaming source display text buys another call.
# Even an identical first retry can hash differently after the refusal creates a hold and
# records the failed aspect. Recovery consultation has a separate normalized identity
# (src/activities.ts:553-563); ordinary acceptance does not use it.
#
# @jev_acceptance_12 DEFECT_STATIC
# Producer src/gates.ts:1102 permits re-submission of the failed native jev_acceptance activity ->
# src/activities.ts:1668,1679,1688-1695 can accept substantively new proof -> src/controller.ts:701
# invokes recordRecovery, whose successful-result branch returns without clearing the existing
# hold (src/state.ts:334-335). Neither recordAcceptance (src/state.ts:578-580) nor acceptance
# success clears its own failed-activity finding. Consumer src/gates.ts:1244-1250 therefore still
# blocks completion after corrected acceptance passes; unrelated hold preservation is correct.
#
# @jev_acceptance_13 IMPLEMENTED_STATIC
# Producer src/controller.ts:1006-1013 records successful and failed consequential executions ->
# src/state.ts:589-605 advances revision -> src/state.ts:573-574 no longer returns old acceptance.
# New revision and evidence participate in src/activities.ts:409-427,492-495, so old refusal
# identity alone does not reject the corrected submission. Authorized repair still must pass
# its exact binding at src/state.ts:431-436; no actual corrective effect was executed here.
#
# @jev_acceptance_14 DEFECT_STATIC
# Producer src/activities.ts:1647,1681 stores refused digests under acceptance:business or
# acceptance:architecture, but src/controller.ts:701 calls recordRecovery under jev_acceptance.
# Consumer src/state.ts:440-447 retires submission entries only by exact hold.boundary equality;
# jev_acceptance does not match either acceptance ledger boundary. Consequently resolving
# that finding does not retire its refused digests, and src/state.ts:643-646 can still reject
# old material. The inspected parent completion-cache fix at src/state.ts:448-450 addresses
# completion findings, not this acceptance namespace mismatch. No reproduction was run.
#
# @jev_acceptance_15 DEFECT_STATIC
# Producer src/activities.ts:442-445 snapshots task/revision/workflow -> src/activities.ts:462-464
# discards changed in-memory bindings, but acceptance consumes that failure through the
# unavailable path at src/activities.ts:1672-1673 -> src/controller.ts:701 records a new hold,
# unlike the no-finding stale contract. Ordinary approved artifact bytes are read only before
# judgment (src/activities.ts:448-455), not after it: an out-of-band plan-file change during the
# call with unchanged in-memory state is not detected there. Strict producer
# autonomy/runtime.ts:1657-1678 does recheck plan bytes and run/dependency identities.
#
# @jev_acceptance_16 IMPLEMENTED_STATIC
# Producer src/activities.ts:802-811 invalidates requirements/plan/acceptance on amendment ->
# src/state.ts:463-467 clears acceptance and completion; replacement at src/activities.ts:815-820
# sets directionPending -> src/gates.ts:1252-1253 holds completion. Plan review calls
# invalidatePlan when its binding changes (src/activities.ts:1566-1571). Replacing the task
# clears old workflow state through src/state.ts:479-508. Tests/activities.test.ts:1289-1299
# are source support for plan invalidation, not an observed passing test.
#
# @jev_acceptance_17 IMPLEMENTED_STATIC
# Producer src/controller.ts:300-308 resolves sourceId, checks exact quote and owner-kind origin ->
# src/context.ts:240-253 verifies stored records; content digest is checked at
# src/context.ts:219-224 -> preparation failure is invalid at src/controller.ts:704-707 ->
# src/state.ts:329-330 creates no finding. No archive corruption exercise was performed.
#
# @jev_acceptance_18 UNVERIFIED
# Producer src/controller.ts:290-321 includes selected sources and authentic owner inventory ->
# src/activities.ts:405-427 sends the explicit data/provenance rule and actual objective ->
# src/judge.ts:263-277 consumers use fixed choice/probability floors. Archived prose has no
# imperative execution path in those producers; actual resistance to adversarial owner/source
# text still requires a real judge case, not a claim that a prompt rule proves compliance.
#
# @jev_acceptance_19 IMPLEMENTED_STATIC
# Producer src/activities.ts:1779-1784 returns developer review as evidence, not acceptance;
# course approval src/activities.ts:2890-2897 likewise grants no acceptance; recovery clearing
# src/state.ts:440-454 does not write an acceptance record -> src/gates.ts:1261-1277 independently
# requires both aspects. No cross-tool integration execution was performed.
#
# @jev_acceptance_20 DEFECT_STATIC
# Producer src/controller.ts:1077-1090 calls completionGate before any automatic collection ->
# src/gates.ts:1261-1277 returns a manual ACCEPTANCE_CALL whenever an aspect is missing.
# No ordinary stop path invokes acceptance or builds observed evidence; automation exists
# only in autonomy/runtime.ts:2453-2485. Therefore ordinary FR-39 is not implemented.
# Existing tests/controller.test.ts:725-736 assert the old manual hold, not this promised flow.
#
# @jev_acceptance_21 DEFECT_STATIC
# Producer src/gates.ts:1269-1277 returns missing aspects and a manual call, not the specific
# unmet obligation with its approved verification section -> src/controller.ts:1101-1106
# repeats that reason and keeps the stop held. Count safety is implemented, but evidence-first
# observation guidance and automatic topic diagnosis are not supplied for ordinary completion.
# FR-39/43 are explicitly unchecked at PRD.md:131-137; their documented status is not approval.
#
# @jev_acceptance_22 UNVERIFIED
# Producer src/controller.ts:728-744 registers the native tool with the shared execution wrapper;
# src/controller.ts:827-835 recognizes write xd://jev_acceptance as a logical owner-update
# boundary; src/gates.ts:182-200 classifies that device as nonmutating. Consumer native run
# src/controller.ts:690-702 performs provenance, recovery and activity logic. The actual host
# write-device dispatch into this registered executor is outside the inspected repository path;
# neither parity nor a route-specific bypass was executed. A route-parity host check is missing.
#
# @jev_acceptance_23 UNVERIFIED
# Producer src/controller.ts:194-198 defines skipped/enabled:false, no approval ->
# native wrapper src/controller.ts:677-678 returns it before any activity; outer tool boundary
# src/controller.ts:812-813 bypasses ordinary enforcement while disabled. Native semantics are
# implemented statically; the host device dispatch/result for write xd:// is unobserved as in
# @jev_acceptance_22, so the complete two-route scenario is not claimed proven.
#
# @jev_acceptance_24 IMPLEMENTED_STATIC
# Producer autonomy/runtime.ts:2173-2206 collects captured immutable project bytes and observed
# actions -> autonomy/runtime.ts:2453-2485 obtains missing aspects and retains current passed
# ones -> autonomy/runtime.ts:2487-2502 requires separate current completion approval ->
# autonomy/runtime.ts:2504-2527 commits completed state or reports commit failure. Strict
# judgeFor at autonomy/runtime.ts:1507-1545 binds objective, policy and run identity. Existing
# tests/autonomy.test.ts:1393-1456 contain injected-judge fixtures, including actual command
# execution inside the test source; those tests were not run and are not real deployment proof.
#
# @jev_acceptance_25 IMPLEMENTED_STATIC
# Producer src/controller.ts:558-560 refuses the ordinary switch in strict mode; strict judge
# autonomy/runtime.ts:1457-1468 requires current binding and fresh session execution observation ->
# autonomy/runtime.ts:1657-1678 rejects changed bindings -> autonomy/runtime.ts:2476-2502 persists
# a refusal/outage wait rather than completing. Unchanged durable waits may end an idle native
# turn at autonomy/runtime.ts:2367-2371 while the run remains uncompleted; ending a turn is not
# acceptance. Restart invalidation is supported by tests/autonomy.test.ts:1459-1479, not executed.

# Source register
# S-PRD: PRD.md FR-14/15/16/17/18/20/21/22/23/25/26/29/37/39/43/57/58/59/62/63/67/68/69/70/71.
# S-TOOL: src/guidance.ts:38-42,205-224; documented jev_acceptance contract and examples, not implementation proof.
# S-OWNER: delegated owner assignment for jev_acceptance: independent aspects, current revision/topic evidence, actual execution/code proof, partial approvals, failure/correction/recovery, stale/duplicate/outage, final stop/completion and strict automatic acceptance; passed checks permit promised next step, failures permit substantive correction, no unsafe bypass or count permission.
# S-GHERKIN: https://cucumber.io/docs/gherkin/reference/; Feature, Scenario Outline, Examples, comments and tags.

# Open questions
# GAP-1: No scenario runner or step definitions were supplied; parent integration verification must establish executable coverage and real judge/host behavior.

# Assumptions
# None.
