# language: en
# Requirements: PRD FR-04, FR-05, FR-06, FR-33, FR-34, FR-35, FR-36; FR-73.
# Source contract: src/guidance.ts REQUIREMENTS_DESCRIPTION; src/jev-skill.md section 2.
# Executable: tests/scenarios/steps/requirements.ts; run by tests/scenarios/run.test.ts.
Feature: Check obligations against the owner's request
  Each submitted obligation needs a quote from the request. The review checks
  whether the quotes support the obligations and whether the list covers the
  objective. An approved list informs planning; it does not authorize work.

  # FR-04, FR-05, FR-33, FR-35; implementation src/activities.ts requirements
  @jev_requirements_01 @fr_04 @fr_33 @fr_35
  Scenario: A complete, supported list needs no additional owner confirmation
    Given development triage registered "Add a dry-run flag and document its usage"
    And the executor derived one checkable obligation for each part of the request
    When every item and overall coverage meet their floors
    Then the requirement set is approved for that task
    And no owner confirmation is requested
    And the review allows supported implementation choices the owner did not specify

  # FR-04, FR-05; implementation src/activities.ts requirements item questions
  @jev_requirements_02 @fr_05
  Scenario: Each obligation gets its own verdict and source quote
    Given three obligations cite their originating request lines
    When the batched requirement review runs
    Then each item receives its own supported, rejected or unsettled decision
    And the judge checks each obligation against its submitted source quote
    And one unsupported item prevents whole-set approval

  # FR-05; implementation src/activities.ts readItems
  @jev_requirements_03 @fr_05
  Scenario: A blank source stops the submission before it reaches the judge
    Given an obligation carries empty source text
    When the requirements tool validates the submission
    Then no judge request is made
    And the tool identifies the missing source
    And no requirement set is approved

  # FR-06; implementation src/activities.ts coverage and candidateNeeds
  @jev_requirements_04 @fr_06
  Scenario: The report distinguishes an omitted need from rejected items
    Given the executor submits obligations and one suspected omitted owner need
    When coverage is not established and the need is missing
    Then the report lists coverage, rejected obligations and the omitted need separately
    And the executor can add the missing obligation and resubmit
    And the refusal is not called an exhausted attempt

  # FR-06; implementation src/activities.ts coverage floor
  @jev_requirements_05 @fr_06
  Scenario: Exactly 0.6 is enough for coverage when all items are supported
    Given the judge returns coverage at exactly the configured 0.6 floor
    And every item is supported at its probability floor
    When the result is classified
    Then the result says the list establishes coverage
    And the approved requirement set becomes available to planning

  # FR-20; implementation src/activities.ts unsettled classification
  @jev_requirements_06 @fr_20
  Scenario: An uncertain item keeps the list unapproved without proving an omission
    Given one item answer stays between the approval and rejection floors
    When the requirement result is reported
    Then the report identifies the item whose support remains uncertain
    And the overall set remains unapproved
    And no specific missing obligation is invented from the low probability

  # FR-34, FR-36; implementation src/activities.ts planContext, src/state.ts invalidatePlan
  @jev_requirements_07 @fr_34
  Scenario: Revising the obligations makes the old planning approvals stale
    Given an approved requirement set supports an approved outline
    When the executor submits a materially different requirement set
    Then the old plan approvals no longer apply to the new requirement set
    And the plan review requires the new approved obligations
    And any acceptance recorded for the old scope is not reused

  # FR-33; implementation src/controller.ts snapshotApproval, src/context.ts
  @jev_requirements_08 @fr_33
  Scenario: The archive preserves the wording and provenance of approved obligations
    Given a requirement set is approved for the current task
    When the approval is recorded
    Then the exact obligation text is stored with task and approval provenance
    And jev_context can list the archived approval and retrieve its content
    And reading the snapshot restores no execution permission

  # FR-73; implementation src/controller.ts tool boundary
  @jev_requirements_09 @fr_73
  Scenario: Project edits can proceed while requirement coverage is open
    Given a development task exists but its requirements are not approved
    When the executor edits a project file
    Then the edit is not refused for missing requirement approval
    And the edit is recorded as not yet reviewed
    And the diagnostic is disclosed as an open coverage gap

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_requirements_10 @fr_73
  Scenario: A judge outage leaves the submission without a verdict
    Given a valid requirement submission
    When the judge is unavailable
    Then no requirement set is approved
    And the tool reports that no judgment was made
    And the executor may continue independent work and resubmit the exact material later

  # FR-22; implementation src/activities.ts submitToJudge deduplication
  @jev_requirements_11 @fr_22
  Scenario: An exact repeat returns the previous refusal without judging again
    Given a requirement list was refused and recorded
    When the executor resubmits byte-identical obligations and sources
    Then no judge request is made
    And the tool returns the earlier diagnostic
    And the refusal count grants no permission
