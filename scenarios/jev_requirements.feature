# language: en
# Requirements: PRD FR-04, FR-05, FR-06, FR-33, FR-34, FR-35, FR-36; FR-73.
# Source contract: src/guidance.ts REQUIREMENTS_DESCRIPTION; src/jev-skill.md section 2.
# Normative business specification only; no step definitions or executable runner exist here.
Feature: Requirements establish complete, supported obligations without an owner loop
  The executor derives checkable obligations from the owner's objective and submits them once.
  An approved set is context for planning, not permission to execute, and a refusal is
  diagnostic material for correction.

  # FR-04, FR-05, FR-33, FR-35; implementation src/activities.ts requirements
  @jev_requirements_01 @fr_04 @fr_33 @fr_35
  Scenario: Derive and approve obligations without a second owner message
    Given development triage registered "Add a dry-run flag and document its usage"
    And the executor derived one checkable obligation for each part of the request
    When every item and overall coverage meet their floors
    Then the requirement set is approved for that task
    And no owner confirmation is requested
    And implementation choices are not rejected merely because the owner did not name them

  # FR-04, FR-05; implementation src/activities.ts requirements item questions
  @jev_requirements_02 @fr_05
  Scenario: Judge every obligation against its exact source line
    Given three obligations cite their originating request lines
    When the batched requirement review runs
    Then each item receives its own supported, rejected or unsettled decision
    And the result shows the submitted source line for each item
    And one unsupported item prevents whole-set approval

  # FR-05; implementation src/activities.ts readItems
  @jev_requirements_03 @fr_05
  Scenario: An obligation without its source is refused before judging
    Given an obligation carries empty source text
    When the requirements tool validates the submission
    Then no judge request is made
    And the result names the missing source
    And no requirement set is approved

  # FR-06; implementation src/activities.ts coverage and candidateNeeds
  @jev_requirements_04 @fr_06
  Scenario: Coverage and suspected omissions are reported separately
    Given the executor submits obligations and one suspected omitted owner need
    When coverage is not established and the need is missing
    Then the result separates overall coverage, rejected items and the uncovered need
    And the executor can add the missing obligation and resubmit
    And the refusal is not called an exhausted attempt

  # FR-06; implementation src/activities.ts coverage floor
  @jev_requirements_05 @fr_06
  Scenario: Coverage at the floor establishes complete scope
    Given the judge returns coverage at exactly the configured 0.6 floor
    And every item is supported at its probability floor
    When the result is classified
    Then coverage is reported as established
    And the approved requirement set becomes available to planning

  # FR-20; implementation src/activities.ts unsettled classification
  @jev_requirements_06 @fr_20
  Scenario: Unsettled requirement answers are uncertainty, not defects
    Given one item answer stays between the approval and rejection floors
    When the requirement result is reported
    Then that item is named as not settled
    And the overall set remains unapproved
    And no specific missing obligation is invented from the low probability

  # FR-34, FR-36; implementation src/activities.ts planContext, src/state.ts invalidatePlan
  @jev_requirements_07 @fr_34
  Scenario: Changing the approved set reopens dependent planning
    Given an approved requirement set supports an approved outline
    When the executor submits a materially different requirement set
    Then the old planning approvals no longer count as current
    And the plan review requires the new approved obligations
    And any acceptance recorded for the old scope is not reused

  # FR-33; implementation src/controller.ts snapshotApproval, src/context.ts
  @jev_requirements_08 @fr_33
  Scenario: An approved requirement set is archived as exact evidence
    Given a requirement set is approved for the current task
    When the approval is recorded
    Then the exact obligation text is stored with task and approval provenance
    And jev_context can list and read it later
    And reading the snapshot restores no execution permission

  # FR-73; implementation src/controller.ts tool boundary
  @jev_requirements_09 @fr_73
  Scenario: Unapproved requirements do not stop project work
    Given a development task exists but its requirements are not approved
    When the executor edits a project file
    Then the edit is not refused for missing requirement approval
    And the work is recorded as not yet reviewed
    And the diagnostic is disclosed as an open coverage gap

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_requirements_10 @fr_73
  Scenario: A judge outage leaves requirements unapproved and work available
    Given a valid requirement submission
    When the judge is unavailable
    Then no requirement set is approved
    And the result states that no judgment exists
    And the executor may continue independent work and resubmit the exact material later

  # FR-22; implementation src/activities.ts submitToJudge deduplication
  @jev_requirements_11 @fr_22
  Scenario: Repeating the identical list buys no new judgment
    Given a requirement list was refused and recorded
    When the executor resubmits byte-identical obligations and sources
    Then no judge request is made
    And the earlier result is returned as the diagnostic record
    And the refusal count grants no permission
