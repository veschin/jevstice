# language: en
# Normative specification, written from the sources before implementation audit.
# These scenarios have no step definitions or runner and are not executed tests.
Feature: Re-aim only an authentic replacement of the owner's task
  An owner clarification or addition must not become an escape from a finding.
  A genuine replacement starts a new approval scope without inheriting permission.

  Background:
    Given Jev ordinary mode is enabled
    And an active development task has approved requirements and an approved plan

  # Sources: [S:PRD] FR-29, FR-69; [S:catalog]; [S:owner].
  @jev_reaim_01
  Scenario: Establish a classified authentic replacement without re-triage
    Given the owner said "Stop the export flag work and fix the login redirect instead."
    And automatic owner classification established replacement at the approval floor
    When jev_reaim submits those exact words with matching authentic user evidence
    And the re-aim judge approves the replacement at the unchanged approval floor
    Then the reported current objective is the login redirect request under a new task identity
    And old requirements, plan, acceptance and completion approval cannot approve the new task
    And fresh requirements and a fresh approved plan are required without another triage

  # Sources: [S:PRD] FR-29, FR-44; [S:catalog]; [S:owner].
  @jev_reaim_02
  Scenario: Replacement drops old refusal state and continuation authority without granting execution
    Given the old task has an OPEN finding, refusal history and an owner continuation grant
    And a later authentic owner message is classified as replacement
    When jev_reaim establishes that replacement with a passing judgment
    Then the new task does not reuse the old finding, refusal count or continuation grant
    And the next consequential action is held for the new requirements and plan
    And the re-aim result does not claim that implementation or acceptance is approved

  # Sources: [S:PRD] FR-29, FR-69; [S:manual] section 6.
  @jev_reaim_03
  Scenario Outline: Ordinary follow-ups never require a re-aim
    Given the owner supplied an authentic <followup>
    When the next workflow boundary classifies it as <classification> with a passing judgment
    Then the follow-up remains part of the existing task rather than a replacement task
    And the accumulated objective <objective_effect>
    And dependent approvals <approval_effect>
    And standing findings and refusal history remain unchanged
    Examples:
      | followup                                              | classification | objective_effect                                   | approval_effect                                            |
      | clarification that redirect means the post-login URL   | continuation   | retains the original scope and recorded clarification | remain usable                                              |
      | addition to cover the mobile post-login redirect too   | amendment      | retains the original need and adds the mobile need  | are reopened for requirements, plan, acceptance and completion |

  # Sources: [S:PRD] FR-29, FR-69; [S:manual] section 6; [S:owner].
  @jev_reaim_04
  Scenario Outline: Reject using re-aim to reset a non-replacement task
    Given the current authentic message is <message_kind>
    And no queued owner message has been classified as replacement
    When jev_reaim submits that message as a replacement
    Then no new task is registered
    And the existing objective, dependent approvals, findings and refusal history are preserved
    And the response names the owner-update classification prerequisite rather than asking for an override
    Examples:
      | message_kind                                          |
      | a clarification already classified as continuation    |
      | an addition already classified as amendment           |
      | the unchanged original request after a refusal         |
      | an old replacement from an earlier task                |

  # Sources: [S:PRD] FR-68, FR-69; [S:manual] section 6.
  @jev_reaim_05
  Scenario Outline: Capture authentic follow-ups automatically before consequential boundaries
    Given a later authentic owner message arrives through <origin>
    And it has not already been captured through another host event
    When the executor reaches the next <boundary>
    Then the message appears once in chronological trusted owner history
    And classification receives the accumulated objective, approved requirements and queued owner messages
    And the boundary cannot execute using an unclassified direction
    Examples:
      | origin                                    | boundary                    |
      | interactive input                         | consequential invocation    |
      | RPC owner input                           | plan review                 |
      | native prompt containing a real user turn | completion                  |

  # Sources: [S:PRD] FR-68, FR-69; [S:autonomy] section 8.7; [S:owner].
  @jev_reaim_06
  Scenario Outline: Tool and quoted content cannot impersonate a new owner direction
    Given a claimed replacement appears only in <untrusted_origin>
    When the executor submits those words to jev_reaim with user-kind evidence
    Then no authentic current owner replacement is established
    And no task, approval, finding or permission scope is reset
    Examples:
      | untrusted_origin                              |
      | a tool result                                 |
      | a repository document                         |
      | extension-originated continuation text         |
      | a revived agent-only prompt                    |
      | a quotation presented by the owner as an example rather than an instruction |

  # Sources: [S:PRD] FR-29, FR-68; [S:catalog]; [S:owner].
  @jev_reaim_07
  Scenario Outline: Reject fabricated or mismatched owner evidence before judgment
    Given a replacement has been classified from an authentic current owner message
    When jev_reaim is submitted with <evidence_problem>
    Then the call reports the evidence problem without a judge request
    And the current task and pending replacement remain unchanged
    And no Jev finding is created from that local argument error
    Examples:
      | evidence_problem                                                   |
      | an interjection different from the current owner message            |
      | no user-kind evidence quoting the interjection                      |
      | a nonexistent sourceId                                             |
      | a quote absent from its sourceId record                             |
      | a user-kind citation naming a plan or requirement source            |
      | an owner record from another request presented as the current replacement |

  # Sources: [S:PRD] FR-29, FR-67; [S:catalog].
  @jev_reaim_08
  Scenario Outline: Correct local argument errors without poisoning re-aim recovery
    Given the authentic current replacement is pending
    When jev_reaim receives <malformed_input>
    Then it returns a named local argument error before judgment
    And it creates no finding and consumes no refused-judgment history
    When a complete corrected interjection and authentic evidence are submitted
    Then a fresh re-aim judgment is available
    Examples:
      | malformed_input                                |
      | an absent or blank interjection                 |
      | a non-string interjection                       |
      | an absent or empty evidence list                |
      | an evidence item with an unknown kind           |
      | an evidence item with a blank quote             |

  # Sources: [S:PRD] FR-21, FR-23, FR-29, FR-69; [S:manual] section 4; [S:owner].
  @jev_reaim_09
  Scenario Outline: Unusable owner classification never establishes a replacement or releases work
    Given an authentic owner follow-up is queued
    When automatic owner classification returns <answer>
    Then the objective and existing approvals are not replaced or extended from that answer
    And consequential work remains held with a named unresolved classification
    And the answer is not reported as proven direction change or Jev approval
    Examples:
      | answer                                      |
      | unclear at a usable confidence               |
      | replacement below the choice floor           |
      | an unknown label                             |
      | a missing or wrong-typed answer              |
      | a service timeout or transport outage        |

  # Sources: [S:PRD] FR-21, FR-23, FR-29; [S:manual] sections 4 and 5; [S:owner].
  @jev_reaim_10
  Scenario Outline: Non-passing re-aim answers retain the pending replacement and hold execution
    Given a current authentic classified replacement is pending
    When its re-aim judgment returns <answer>
    Then no replacement task or new execution permission is registered
    And the pending replacement remains available for supported correction
    And subsequent consequential calls remain held regardless of refusal or outage counts
    Examples:
      | answer                                   |
      | negative replacement verdict             |
      | affirmative verdict below its floor       |
      | missing or malformed typed answer         |
      | transport failure                         |

  # Sources: [S:PRD] FR-22, FR-23, FR-67; [S:manual] section 5; [S:owner].
  @jev_reaim_11
  Scenario: Rewording unchanged refused re-aim material buys no judgment or permission
    Given a valid re-aim submission has been judged and refused
    When the executor repeats it with only evidence order or duplicated quotes changed
    Then no unchanged judgment is retried
    And the original finding remains visible
    And repetition and refusal counts never establish the replacement or release execution

  # Sources: [S:PRD] FR-22, FR-29, FR-67, FR-69; [S:owner].
  @jev_reaim_12
  Scenario: Substantive corrected owner evidence can settle a refused replacement
    Given a valid replacement submission was refused because the direction was not supported
    And a later authentic owner clarification supplies changed supporting observations
    When the corrected classification and re-aim submission use that new authentic evidence
    Then a fresh judgment is available at the unchanged floor
    And a passing result establishes the supported replacement without old-task holds or permission
    And future consequential work waits for the new task's requirements and approved plan

  # Sources: [S:PRD] FR-36, FR-58, FR-69; [S:owner].
  @jev_reaim_13
  Scenario Outline: Discard asynchronous owner classification after its context changes
    Given owner classification is waiting for its judge answer
    When <change> occurs before a passing answer returns
    Then the obsolete classification cannot alter the current objective or approvals
    And the next boundary uses the current queued owner messages and current task context
    Examples:
      | change                                                  |
      | another authentic owner follow-up arrives                |
      | the task identity changes                               |
      | approved requirements or plan change                     |
      | a consequential action advances the work revision         |
      | ordinary mode is turned off and then on                   |

  # Sources: [S:PRD] FR-29, FR-36, FR-58; [S:owner].
  @jev_reaim_14
  Scenario Outline: Discard asynchronous re-aim approval after its binding changes
    Given a re-aim judgment is waiting for its answer
    When <change> occurs before an approving answer returns
    Then the stale answer cannot register a task or clear current findings
    And the result identifies staleness instead of reporting a successful re-aim
    Examples:
      | change                                                    |
      | a different current owner message arrives                  |
      | the task is replaced                                      |
      | the requirements or plan revision changes                  |
      | the work revision advances                                |
      | ordinary mode is turned off and then on                     |

  # Sources: [S:PRD] FR-29, FR-34, FR-36, FR-44; [S:catalog]; [S:owner].
  @jev_reaim_15
  Scenario: Old task activities cannot restore permission after re-aim
    Given an authentic replacement has been established successfully
    When the executor submits old-task requirements, plan handoff or acceptance material
    Then that material cannot restore the prior task's approval or continuation scope
    And the new task's current requirements and exact approved plan are required
    And a late old-task judgment cannot complete the new task

  # Sources: [S:PRD] FR-29, FR-69; [S:manual] section 6.
  @jev_reaim_16
  Scenario: No active task cannot be replaced through re-aim
    Given no development task is registered
    When jev_reaim submits a valid owner interjection and evidence
    Then the result names the missing active task prerequisite
    And no replacement judgment or task registration occurs

  # Sources: [S:PRD] FR-29, FR-68; [S:manual] section 1; [S:owner].
  @jev_reaim_17
  Scenario Outline: Native and device invocation enforce the same re-aim contract
    Given the authentic classified replacement and exact arguments are identical
    When jev_reaim is invoked through <route>
    Then the same input validation, source resolution and owner classification prerequisites apply
    And the same judge floor, task replacement and approval invalidation apply
    Examples:
      | route                                             |
      | the registered native jev_reaim tool                |
      | write with path xd://jev_reaim and JSON content      |

  # Sources: [S:PRD] FR-71 and constraints; [S:owner].
  @jev_reaim_18
  Scenario Outline: Disabled ordinary mode reports no re-aim judgment or approval
    Given the owner disabled ordinary mode for the session
    When a valid jev_reaim call is made through <route>
    Then it returns an explicit disabled result without a judge request
    And it does not replace a task or imply Jev approval
    Examples:
      | route                                  |
      | the native tool                         |
      | write to xd://jev_reaim                  |

  # Sources: [S:PRD] FR-57, FR-58, FR-64 and strict constraints; [S:autonomy] section 8.7; [S:owner].
  @jev_reaim_19
  Scenario Outline: Strict mode does not re-aim its frozen run objective from executor text
    Given the strict autonomous runtime is bound to its committed immutable objective
    When <attempt> requests a replacement objective
    Then the committed objective and strict task authority remain unchanged
    And no ordinary continuation or mode command bypasses strict enforcement
    And the result identifies that the current strict run cannot be re-aimed through this call
    Examples:
      | attempt                                                  |
      | the executor calls native jev_reaim                       |
      | the executor writes to xd://jev_reaim                     |
      | a tool result claims to be the operator's new objective   |
      | an internal continuation contains approval-like text      |

  # Sources: [S:PRD] FR-29, FR-69; [S:manual] section 6; [S:owner].
  @jev_reaim_20
  Scenario: A follow-up is classified once without dropping later queued messages
    Given two distinct authentic owner messages are queued in chronological order
    And classification starts for those messages
    When a third authentic owner message arrives before the answer returns
    Then no message is silently discarded or marked classified by the old answer
    And the current objective is established only from a judgment bound to current owner history

# Implementation audit
# Static source inspection only; IMPLEMENTED_STATIC is not an executed or passing test.
# Audit anchors name producer -> consumer; all scenarios lack step definitions and live execution proof.
#
# @jev_reaim_01 IMPLEMENTED_STATIC:
# src/activities.ts:815-820 produces directionPending -> src/activities.ts:707-722 accepts a yes probability >= POLICY.minProbabilityToApprove (src/types.ts:29) -> src/state.ts:528-531 replaces the task through clearWork:480-508 -> src/gates.ts:1059-1070 requires a fresh plan; src/activities.ts:1039-1047 binds requirements to the registered objective. No re-triage is required by this path. tests/activities.test.ts:69-85 supplies static happy-path assertions, not observed execution.
#
# @jev_reaim_02 IMPLEMENTED_STATIC:
# Passing reaim at src/activities.ts:717-722 -> src/state.ts:480-508 deletes old hold, repair, approvals, completion, continuation, ledgers and counters -> src/state.ts:258-261 cannot grant inherited continuation -> src/gates.ts:1059-1070 holds the new unplanned task. Cross-session handoff escape is separately DEFECT_STATIC under @jev_reaim_15.
#
# @jev_reaim_03 IMPLEMENTED_STATIC:
# src/activities.ts:755-773 classifies queued messages -> continue:795-800 preserves approvals and holds; amend:802-813 retains old request plus queued additions, changes its binding fingerprint and invalidates dependent reviews -> src/state.ts:463-468 clears plan topics, acceptances and completion without touching findings or refusal history. Existing-task membership here does not require an unchanged content fingerprint. tests/activities.test.ts:1671-1710 contains assertions; none were run.
#
# @jev_reaim_04 DEFECT_STATIC:
# src/activities.ts:670-685 accepts an interjection found anywhere in accumulated history and never requires directionPending or a current replacement classification -> a passing boolean at :707-718 reaches src/state.ts:528-531 and clears old work. src/controller.ts:693 invokes classification but ignores its classification result before running reaim at :698. Thus a classified continuation/amendment or old owner phrase can still be submitted for replacement; the required prerequisite is absent. This is a missing enforcement condition, not a claim that the real judge has misclassified a particular phrase.
#
# @jev_reaim_05 DEFECT_STATIC:
# Authentic input src/controller.ts:655-662 -> captureOwner:324-337 -> src/state.ts:278-288 retains chronological history/queue; native prompt fallback src/controller.ts:775-783 suppresses already captured input. But src/controller.ts:824-826 checks an old recovery hold before classification at :829-835, and direct run does the same at :690-693. With an unrelated standing finding, a consequential boundary or native reaim cannot first classify a newly authentic replacement. Requirements/plan calls remain available, but they are a detour, not automatic classification at the attempted boundary. Also :1052 skips classification at a quiet pending-message stop. No integration execution was performed.
#
# @jev_reaim_06 UNVERIFIED:
# Input-origin filter src/controller.ts:655-659 and revival exclusion :775 prevent ordinary tool/extension/revival data from entering captureOwner; src/activities.ts:673-681 rejects interjections absent from owner history/current request. For a quotation inside an authentic owner message, only judge instructions :690-693 distinguish quoted data from a true replacement. The request fallback :670-672 is not independently provenance-checked; actual host origin dispatch and adversarial quoted-message behavior have not been executed. Do not infer that source authentication proves a quoted instruction's intent.
#
# @jev_reaim_07 DEFECT_STATIC:
# src/controller.ts:300-308 -> src/context.ts:197-253 verifies source existence, bytes, metadata and owner kind before activity judgment; src/activities.ts:678-681 requires an identical user quote. However :673 uses substring membership in any historical owner message, not exact current replacement identity, so an old message or isolated phrase can reach judgment. prepareContext authenticates source kind/content, not membership in the current replacement. Passing judgment can then replace the task through :718 -> src/state.ts:528-531. The malformed sourceId rows are statically protected; the current-owner binding rows are not.
#
# @jev_reaim_08 IMPLEMENTED_STATIC:
# src/guidance.ts:345-348 exposes native input types; src/activities.ts:661-663 and :248-277 reject malformed strings/evidence before submitToJudge:686 -> refused:194-199 marks kind invalid -> src/state.ts:329-330 skips finding creation. A corrected submission has no local-error ledger entry. No malformed-input execution was performed.
#
# @jev_reaim_09 IMPLEMENTED_STATIC:
# src/judge.ts:154-180 rejects missing/wrong-typed/unknown choice answers -> src/activities.ts:774-794 requeues unavailable/missing answers and maps below-floor labels to unclear using src/judge.ts:263-271 and src/types.ts:19 -> src/activities.ts:823-831 records uncertainty -> src/controller.ts:346/src/state.ts:321-375 retain a hold -> src/gates.ts:1038-1045 blocks effects. A low confidence replacement is not proof of replacement. Later resolution of this uncertainty is separately defective under @jev_reaim_21.
#
# @jev_reaim_10 IMPLEMENTED_STATIC:
# src/judge.ts:154-166 rejects malformed boolean answers -> src/activities.ts:704-715 returns nonapproval without reaimTask -> src/controller.ts:701 records recovery -> src/gates.ts:1038-1045,1061-1062 holds effects. src/activities.ts:471-475 records availability only and src/state.ts:626-629 records counts without approval. No outage/rejection execution or network behavior is claimed.
#
# @jev_reaim_11 IMPLEMENTED_STATIC:
# src/activities.ts:683-685 keys reaim refusal identity by task and authentic history, excluding resubmitted prose/evidence order -> submitToJudge:494-504 rejects repeats before askJudge -> recordRefusal:710 persists the refused digest -> src/state.ts:321-375 preserves the original hold. No network call was observed; this conclusion follows the branch structure.
#
# @jev_reaim_12 IMPLEMENTED_STATIC:
# src/controller.ts:661 -> src/state.ts:278-282 appends the genuinely new authentic owner clarification -> src/activities.ts:685 changes the refusal identity -> submitToJudge:494-508 admits fresh judgment regardless of counts -> :717-722 and src/state.ts:480-531 establish a passing replacement and require new approvals. This proves the changed-owner-history path only: changes to selected supporting sources with identical owner history are excluded from the identity at :685, so that distinct correction path has no proof here.
#
# @jev_reaim_13 IMPLEMENTED_STATIC:
# src/activities.ts:442-445 snapshots task, revision, request, requirements, plan, owner history and queue -> :462-464 discards changed-context answers -> ownerUpdate:774-778 restores the taken batch ahead of newly queued messages. src/controller.ts:344-345 and :571-579 reject replaced-mode state objects. Tests/activities.test.ts:1758-1773 and tests/controller.test.ts:1612-1646 contain stale-owner assertions; neither was executed.
#
# @jev_reaim_14 DEFECT_STATIC:
# askJudge src/activities.ts:462-464 does prevent stale approval from reaching reaimTask, but reaim:704-706 calls unusable without kind stale -> unusable:218-225 labels the discarded answer unavailable -> src/controller.ts:701 -> src/state.ts:321-375 creates a current recovery hold from an obsolete answer. Controller mode guards :699,710-711 protect a replaced state, but do not correct same-state task/revision/owner changes. Safety rejection is implemented; the no-stale-finding/accurate-feedback requirement is not.
#
# @jev_reaim_15 DEFECT_STATIC:
# src/controller.ts:864-870 captures approved task/plan in closure-level handoff -> successful reaim through :698-703 clears state only, never that handoff -> session_before_switch:799-801 arms any remaining handoff -> session_switch:804-808 binds it to the new session -> restoreApprovedPlan:464-477 installs the old task and approvals whenever old artifact bytes match and new state is empty. No comparison with the later owner direction/current source task exists. The claimed stale-handoff execution is not observed; the static producer/consumer binding gap is concrete.
#
# @jev_reaim_16 IMPLEMENTED_STATIC:
# src/activities.ts:664-668 returns missing-task prerequisite before evidence/judge submission at :678-686 -> prerequisite:203-208 marks local invalid -> src/state.ts:329-330 creates no finding. tests/activities.test.ts:119-129 contains corresponding assertions; not executed.
#
# @jev_reaim_17 UNVERIFIED:
# Native registration src/controller.ts:728-744 binds catalog entry to run/reaim; tool_call:827-835 recognizes the write xd:// logical name for owner updates, and src/gates.ts:981-986 treats known Jev devices as non-mutating coordination. The actual host JSON device-to-registered-tool execution bridge is outside the inspected repository implementation; no real-host native/write equivalence probe ran. Shared-handler behavior alone is not end-to-end equivalence proof.
#
# @jev_reaim_18 IMPLEMENTED_STATIC:
# Owner mode switch src/controller.ts:571-590 replaces workflow state and marks disabled -> run:678 returns DISABLED_OUTCOME:194-197 before state lookup/judgment -> tool_call:812-813 returns early. Device execution is expected to use the registered handler, but its external host bridge remains unverified under @jev_reaim_17. No disabled-mode invocation was executed.
#
# @jev_reaim_19 IMPLEMENTED_STATIC:
# autonomy/runtime.ts:69-79 marks native reaim unsupported -> consequential:1186-1198 routes it and unsafe xd devices into admission -> beforeTool:1300-1315 refuses native reaim and xd://jev_reaim -> src/controller.ts:814-815 blocks before ordinary execution. Strict owner input/update paths are skipped at :656/:774/:342; ordinary mode/continuation bypasses are refused at :558-560/:600-602. Runtime restoration autonomy/runtime.ts:1019-1021 rejects a checkpoint task differing from the immutable objective. No strict adversarial execution was performed.
#
# @jev_reaim_20 IMPLEMENTED_STATIC:
# src/state.ts:278-288 appends owner messages and takes one queue batch -> src/activities.ts:444-464 includes both history/queue in the freshness comparison -> :774-778 prepends stale queued messages to later messages instead of dropping them. tests/activities.test.ts:1758-1773 and tests/controller.test.ts:1612-1646 supply static examples only.
#
# Additional cross-tool correction gap relevant to @jev_reaim_09 and @jev_reaim_12:
# An unclear classification produces a stable owner-update hold at src/activities.ts:823-827 -> later authentic clarification can be classified through requirements/plan calls allowed by src/gates.ts:1087-1102 -> passing continue at src/activities.ts:795-800 returns without retiring that owner-update hold -> controller updateOwner:346 calls recordRecovery, whose success path src/state.ts:334-335 returns without clearing existing state -> src/gates.ts:1038-1045 still blocks effects. The instructions at src/activities.ts:830 promise an evidence-bound consultation or explicit clarification, but ordinary diagnostics do not clear findings and the successful clarification path has no named-hold resolution. This static gap is not an executed reproduction and does not justify clearing unrelated findings.

# Source register
# [S:PRD] PRD.md: FR-21..23, FR-29, FR-34..36, FR-44, FR-57..58, FR-64, FR-67..69, FR-71 and constraints.
# [S:catalog] src/guidance.ts:26-27,342-351, documented jev_reaim contract and argument schema.
# [S:manual] src/jev-skill.md:5,31-36,41-47,54-68, documented invocation, provenance, recovery and owner updates.
# [S:autonomy] docs/autonomy.md:98,117,129-139, committed objective and separate operator authority.
# [S:owner] Delegated owner assignment: authentic replacement vs clarification/addition; automatic owner updates; task identity; dependent approval clearing; holds/continuation scope; stale answers; tool/quote impersonation; strict frozen objective; passed checks unlock promised next steps and substantive correction remains possible without counts, bypasses or lowered floors.
# [S:Gherkin] https://cucumber.io/docs/gherkin/reference/ (canonical Feature, Background, Scenario Outline, Examples, comment and tag syntax).

# Open questions
# None for the normative contract; execution and implementation gaps are recorded in the audit.

# Assumptions
# None.
