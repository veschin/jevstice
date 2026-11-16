# language: en
# Requirements: PRD FR-24, FR-34, FR-36, FR-37; FR-73.
# Source contract: src/guidance.ts PLAN_REVIEW_DESCRIPTION; src/jev-skill.md section 2.
# Normative business specification only; no step definitions or executable runner exist here.
Feature: Staged plan review binds approvals to the exact plan artifact
  Outline, one detail per step and final assembly are separate judgments.
  Passing steps remain accepted while rejected steps are revised. An approved plan is
  diagnostic context for later checks, not a lock on implementation.

  Background:
    Given a development task is registered
    And its requirements are approved for the current task

  # FR-24; implementation src/activities.ts reviewPlanOutline
  @jev_plan_review_01 @fr_24
  Scenario: An outline cites only approved obligations
    Given an outline maps step "s1" to approved obligation R1
    When every step cites an exact approved obligation and passes its floor
    Then the outline is reported approved with its step ids
    And the next review stage is one detail per approved step

  # FR-24; implementation src/activities.ts outline requirement check
  @jev_plan_review_02 @fr_24
  Scenario: An outline step citing an unapproved requirement is refused locally
    Given an outline step cites a requirement absent from the approved set
    When the outline is submitted
    Then no judge request is made
    And the result names the step and requires an exact approved obligation
    And the outline is not recorded as approved

  # FR-37; implementation src/activities.ts passing-step retention
  @jev_plan_review_03 @fr_37
  Scenario: Passing steps survive a rejected sibling
    Given an outline has two steps and the first passes while the second is rejected
    When the corrected outline is submitted
    Then the first step remains approved
    And only the revised step receives a new decision
    And whole-outline approval waits for every submitted step

  # FR-37; implementation src/activities.ts invalidatePlan on outline change
  @jev_plan_review_04 @fr_37
  Scenario: A changed outline reopens its dependent details
    Given an outline and one step detail were approved
    When a materially changed outline is submitted
    Then the dependent detail approval no longer counts
    And the changed outline is judged again
    And unrelated approved steps remain available as context

  # FR-24; implementation src/activities.ts reviewPlanDetail section resolution
  @jev_plan_review_05 @fr_24
  Scenario Outline: A detail must name one complete, unique artifact section
    Given the plan artifact contains section "Implementation"
    When the detail names "<selector>"
    Then the result is "<outcome>"
    Examples:
      | selector                                   | outcome                                  |
      | the exact unique heading                   | the complete section is judged           |
      | a substring of the section                 | refused before judgment                  |
      | a heading repeated twice in the artifact   | refused as ambiguous                     |
      | a heading inside a fenced code block       | not accepted as a section selector       |

  # FR-24; implementation src/activities.ts artifact change check
  @jev_plan_review_06 @fr_24
  Scenario: A plan file changed during judgment is stale
    Given a detail judgment is in flight for exact artifact bytes
    When the artifact changes before the answer returns
    Then the answer is discarded as stale
    And the changed section must be reviewed again
    And no approval is recorded for the changed bytes

  # FR-24, FR-37; implementation src/activities.ts overlap check
  @jev_plan_review_07 @fr_24
  Scenario: Overlapping approved sections are refused
    Given one step's section was approved
    When another step names a section that overlaps it
    Then the submission is refused
    And the approved step remains approved
    And the overlapping step must use a disjoint section

  # FR-24; implementation src/activities.ts finalizePlan
  @jev_plan_review_08 @fr_24
  Scenario: Final assembly judges only consistency and added material
    Given every outline step has an approved detail
    When the final plan is submitted with the complete artifact
    Then assembly consistency and added material are judged
    And already accepted step details are not reassessed
    And approval binds to the artifact digest, URL and task fingerprint

  # FR-24; implementation src/activities.ts stalePlanDetails finalize
  @jev_plan_review_09 @fr_24
  Scenario: A removed or changed approved section requires re-review
    Given a step's complete section was approved
    When the current artifact no longer contains that exact section
    Then finalization is refused
    And only the affected section must be reviewed again
    And no final approval is recorded for the changed artifact

  # FR-36; implementation src/controller.ts snapshotApproval, src/context.ts
  @jev_plan_review_10 @fr_36
  Scenario: The approved plan is archived with exact bytes
    Given a final plan is approved for the current task
    When the approval is recorded
    Then the exact plan bytes are stored with their digest and task identity
    And a plan whose bytes do not match that digest cannot stand in for it
    And reading the archived plan restores no execution permission

  # FR-73; implementation src/controller.ts tool call and action diagnostics
  @jev_plan_review_11 @fr_73
  Scenario: Implementation before plan approval is recorded, not stopped
    Given a development task has no approved final plan
    When the executor changes a project file
    Then the change is not refused for missing plan approval
    And the action remains recorded as not checked because no approved plan was available
    And the missing plan review is disclosed as a diagnostic gap

  # FR-24, FR-34; implementation src/activities.ts planReview prerequisites
  @jev_plan_review_12 @fr_34
  Scenario: The staged sequence returns a named prerequisite
    Given no approved requirement set exists
    When the executor requests an outline review
    Then the result names the missing requirement approval
    And it supplies the corrective call
    And nothing was judged and no finding is recorded

  # FR-07; PENDING/UNVERIFIED: plan review reads a local:// artifact; no host plan-mode hook is registered.
  @pending @jev_plan_review_13 @fr_07
  Scenario: Plan review is anchored to the native host plan-mode boundary
    Given the host enters its native plan mode for the current task
    When the executor writes and reviews the plan
    Then plan review is connected to that actual host boundary
    And leaving plan mode is observed by the addon
    And the approval binds the same artifact bytes the host plan mode presents

  # FR-24; implementation src/artifact.ts exact UTF-8 decode
  @jev_plan_review_14 @fr_24
  Scenario Outline: Plan artifact bytes are decoded exactly
    Given the plan artifact contains "<case>"
    When the artifact is read for review
    Then "<outcome>"
    Examples:
      | case                                   | outcome                                                        |
      | a UTF-8 BOM before the first heading   | the BOM remains part of the exact reviewed text                |
      | an invalid UTF-8 byte sequence         | the artifact cannot be read and no bytes are silently replaced |
