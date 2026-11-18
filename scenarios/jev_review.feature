# language: en
# Requirements: PRD FR-16, FR-20; FR-73.
# Source contract: src/guidance.ts REVIEW_DESCRIPTION; src/jev-skill.md section 8.
# Executable: tests/scenarios/steps/review.ts; run by tests/scenarios/run.test.ts.
Feature: Developer review judges the submitted change as a developer
  Checkpoint, commit and diff reviews answer whether quoted changed code is safe to keep.
  A sound review is evidence, not release or acceptance; a defect is recorded for correction.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-16; implementation src/activities.ts review
  @jev_review_01 @fr_16
  Scenario Outline: Review each developer target
    Given a current <kind> target with changed-code quotes and observed verification output
    When the executor submits the target, a supported claim and that evidence
    And the judge approves the claim at the choice floor
    Then the result reports a sound developer review for that target
    And the review remains evidence for the developer question only
    Examples:
      | kind       |
      | checkpoint |
      | commit     |
      | diff       |

  # FR-16; implementation src/activities.ts review validation
  @jev_review_02 @fr_16
  Scenario Outline: Missing review fields are refused locally
    Given the review omits "<field>"
    When the tool validates the submission
    Then no judge request is made
    And the result names the missing field
    And no finding is recorded
    Examples:
      | field   |
      | kind    |
      | target  |
      | claim   |
      | evidence|

  # FR-16; implementation src/activities.ts REVIEW_KINDS
  @jev_review_03 @fr_16
  Scenario: An unsupported review kind is refused
    Given the executor submits kind "release"
    When the review is validated
    Then the result accepts only checkpoint, commit or diff
    And no judge request is made

  # FR-73; implementation src/activities.ts defect branch
  @jev_review_04 @fr_73
  Scenario: A defect finding is recorded without blocking the next change
    Given a valid developer review
    When the judge establishes a defect at the floor
    Then the finding is recorded with the target and class
    And the result directs the executor to correct the quoted change
    And the next tool call and session completion are not blocked

  # FR-20; implementation src/activities.ts inconclusive branch
  @jev_review_05 @fr_20
  Scenario: An unsettled review establishes no defect
    Given a valid developer review
    When the answer is below the floor or reports unsupported material
    Then the result is inconclusive
    And the quoted change is not called defective
    And the executor may submit materially better changed-code evidence

  # FR-73; implementation src/activities.ts sound branch
  @jev_review_06 @fr_73
  Scenario: A sound review is not acceptance
    Given a developer review reports the change sound to keep
    When both acceptance aspects are missing
    Then the result states that acceptance remains separate
    And business and architecture records remain missing
    And the sound review does not authorize publication or completion

  # FR-73; implementation src/activities.ts review evidence
  @jev_review_07 @fr_73
  Scenario: Review evidence is the submitted changed code and output
    Given the executor quotes a diff and a command's observed output
    When the review is judged
    Then the judge receives exactly those quoted items
    And a claim without those quotes is insufficient evidence
    And no judge-authored explanation is returned

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_review_08 @fr_73
  Scenario: An unavailable judge leaves the review unestablished
    Given a valid developer review
    When the judge is unavailable
    Then the result states that no judgment exists
    And no defect is invented
    And work continues under the host's permissions

  # FR-22; implementation src/activities.ts review identity
  @jev_review_09 @fr_22
  Scenario: Repeating unchanged review material costs no judgment
    Given a developer review was already judged for a target
    When the executor resubmits the identical target, claim and evidence
    Then no additional judge request is made
    And the recorded result is returned
    And no attempt count grants permission
