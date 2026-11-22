# language: en
# Requirements: PRD FR-24, FR-34, FR-36, FR-37; FR-73.
# Source contract: src/guidance.ts PLAN_REVIEW_DESCRIPTION; src/jev-skill.md section 2.
# Executable: tests/scenarios/steps/plan_review.ts; run by tests/scenarios/run.test.ts.
# The only @pending scenario is the runner-allowlisted native host plan-mode case.
Feature: Review an outline, its sections and the assembled plan
  The executor submits an outline, then a section for each approved step, then
  the complete plan. Unchanged passing work need not be judged again. Final
  approval identifies the exact artifact; it is not permission to implement it.

  Background:
    Given a development task is registered
    And its requirements are approved for the current task

  # FR-24; implementation src/activities.ts reviewPlanOutline
  @jev_plan_review_01 @fr_24
  Scenario: Approved outline steps become eligible for detail review
    Given an outline maps step "s1" to approved obligation R1
    When every step cites an exact approved obligation and passes its floor
    Then the outline is reported approved with its step ids
    And the result calls for a detail review for each approved step

  # FR-24; implementation src/activities.ts outline requirement check
  @jev_plan_review_02 @fr_24
  Scenario: An unknown obligation keeps the outline from reaching the judge
    Given an outline step cites a requirement absent from the approved set
    When the outline is submitted
    Then no judge request is made
    And the result identifies the step and asks for an exact approved obligation
    And the outline is not recorded as approved

  # FR-37; implementation src/activities.ts passing-step retention
  @jev_plan_review_03 @fr_37
  Scenario: Revising a rejected step does not reopen an unchanged passing step
    Given an outline has two steps and the first passes while the second is rejected
    When the corrected outline is submitted
    Then the first step remains approved
    And the judge rechecks only the revised step
    And whole-outline approval waits for every submitted step

  # FR-37; implementation src/activities.ts invalidatePlan on outline change
  @jev_plan_review_04 @fr_37
  Scenario: Changing an outline step invalidates its dependent detail
    Given an outline and one step detail were approved
    When a materially changed outline is submitted
    Then approval of the dependent detail is no longer valid
    And the changed outline is judged again
    And unrelated approved steps remain available as context

  # FR-24; implementation src/activities.ts reviewPlanDetail section resolution
  @jev_plan_review_05 @fr_24
  Scenario Outline: A detail resolves only to a unique complete heading section
    Given the plan artifact contains section "Implementation"
    When the executor selects the detail section using "<selector>"
    Then the result is "<outcome>"
    Examples:
      | selector                                   | outcome                                  |
      | the exact unique heading                   | the complete section is judged           |
      | a substring of the section                 | refused before judgment                  |
      | a heading repeated twice in the artifact   | refused as ambiguous                     |
      | a heading inside a fenced code block       | not accepted as a section selector       |

  # FR-24; implementation src/activities.ts artifact change check
  @jev_plan_review_06 @fr_24
  Scenario: A detail answer cannot approve a file edited while the judge was working
    Given a detail judgment is in flight for exact artifact bytes
    When the artifact changes before the answer returns
    Then the review discards the answer as stale
    And the changed section must be reviewed again
    And no approval is recorded for the changed bytes

  # FR-24, FR-37; implementation src/activities.ts overlap check
  @jev_plan_review_07 @fr_24
  Scenario: A second step cannot claim part of an already approved section
    Given one step's section was approved
    When another step names a section that overlaps it
    Then the submission is refused
    And the approved step remains approved
    And the second step needs a section that does not overlap

  # FR-24; implementation src/activities.ts finalizePlan
  @jev_plan_review_08 @fr_24
  Scenario: Final review checks how the approved sections fit together
    Given every outline step has an approved detail
    When the final plan is submitted with the complete artifact
    Then the judge reviews how the sections fit together and what was added
    And already accepted step details are not reassessed
    And approval binds to the artifact digest, URL and task fingerprint

  # FR-24; implementation src/activities.ts stalePlanDetails finalize
  @jev_plan_review_09 @fr_24
  Scenario: Finalization identifies the approved section that needs another review
    Given a step's complete section was approved
    When the current artifact no longer contains that exact section
    Then finalization is refused
    And the result asks for a new review of only the affected section
    And no final approval is recorded for the changed artifact

  # FR-36; implementation src/controller.ts snapshotApproval, src/context.ts
  @jev_plan_review_10 @fr_36
  Scenario: The archive keeps the exact approved artifact, not a substitute
    Given a final plan is approved for the current task
    When the approval is recorded
    Then the archive stores the exact plan bytes, their digest and the task identity
    And a plan whose bytes do not match that digest cannot stand in for it
    And reading the archived plan restores no execution permission

  # FR-73; implementation src/controller.ts tool call and action diagnostics
  @jev_plan_review_11 @fr_73
  Scenario: A file edit before final approval is recorded as unchecked
    Given a development task has no approved final plan
    When the executor changes a project file
    Then the change is not refused for missing plan approval
    And the record says the change was not checked because no approved plan was available
    And the missing plan review is disclosed as a diagnostic gap

  # FR-24, FR-34; implementation src/activities.ts planReview prerequisites
  @jev_plan_review_12 @fr_34
  Scenario: An outline request without requirement approval names the next call
    Given the task no longer has a requirement approval on record
    When the executor requests an outline review
    Then the result names the missing requirement approval
    And the result directs the executor to jev_requirements
    And nothing was judged and no finding is recorded

  # FR-07; PENDING/UNVERIFIED: plan review reads a local:// artifact; no host plan-mode hook is registered.
  @pending @jev_plan_review_13 @fr_07
  Scenario: The host's native planning view and review refer to the same artifact
    Given the current task is in the host's native plan mode
    When the executor submits the plan written in that mode for review
    Then the review is associated with that native plan-mode session
    And the addon observes the host leaving plan mode
    And approval identifies the exact bytes shown by the host's planning view

  # FR-24; implementation src/artifact.ts exact UTF-8 decode
  @jev_plan_review_14 @fr_24
  Scenario Outline: Review preserves the original UTF-8 or rejects undecodable bytes
    Given the plan artifact contains "<case>"
    When plan review reads the artifact
    Then "<outcome>"
    Examples:
      | case                                   | outcome                                                        |
      | a UTF-8 BOM before the first heading   | the BOM remains part of the exact reviewed text                |
      | an invalid UTF-8 byte sequence         | the artifact cannot be read and no bytes are silently replaced |
