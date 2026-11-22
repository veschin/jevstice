# language: en
# Requirements: PRD FR-16, FR-20; FR-73.
# Source contract: src/guidance.ts REVIEW_DESCRIPTION; src/jev-skill.md section 8.
# Executable: tests/scenarios/steps/review.ts; run by tests/scenarios/run.test.ts.
Feature: Review a development change without approving its delivery
  Submit a checkpoint, commit or diff to jev_review with changed code and observed
  verification. A sound verdict covers that change alone; a defect calls for a
  correction without stopping ordinary work.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-16; implementation src/activities.ts review
  @jev_review_01 @fr_16
  Scenario Outline: A supported change is sound for the target under review
    Given a current <kind> target with changed-code quotes and observed verification output
    When the executor requests a review of that target with the claim and evidence
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
  Scenario Outline: An incomplete review never reaches the judge
    Given the review request has no "<field>"
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
  Scenario: A release is not a developer review target
    Given the executor submits kind "release"
    When Jev checks the review kind
    Then the result accepts only checkpoint, commit or diff
    And no judge request is made

  # FR-73; implementation src/activities.ts defect branch
  @jev_review_04 @fr_73
  Scenario: A supported defect calls for a correction without stopping work
    Given a valid developer review
    When the judge establishes a defect at the floor
    Then the finding is recorded with the target and class
    And the result asks the executor to correct the quoted change
    And the next tool call and session completion are not blocked

  # FR-20; implementation src/activities.ts inconclusive branch
  @jev_review_05 @fr_20
  Scenario: Weak or unsupported evidence leaves the change unjudged
    Given a valid developer review
    When the answer is below the floor or reports unsupported material
    Then the result is inconclusive
    And the quoted change is not called defective
    And the executor may submit materially better changed-code evidence

  # FR-73; implementation src/activities.ts sound branch
  @jev_review_06 @fr_73
  Scenario: A sound change leaves acceptance and publication undecided
    Given a developer review reports the change sound to keep
    When both acceptance aspects are missing
    Then the review explicitly distinguishes its verdict from acceptance
    And business and architecture records remain missing
    And the sound review does not authorize publication or completion

  # FR-73; implementation src/activities.ts review evidence
  @jev_review_07 @fr_73
  Scenario: The judge sees the original diff and command output
    Given the executor quotes a diff and a command's observed output
    When the review is judged
    Then the judge receives the two quotes unchanged
    And a claim without those quotes is insufficient evidence
    And no judge-authored explanation is returned

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_review_08 @fr_73
  Scenario: A judge outage leaves no review verdict
    Given a valid developer review
    When the judge is unavailable
    Then Jev reports that no decision exists
    And no defect is invented
    And work continues under the host's permissions

  # FR-22; implementation src/activities.ts review identity
  @jev_review_09 @fr_22
  Scenario: Resubmitting the same review returns the previous verdict
    Given a developer review was already judged for a target
    When the executor resubmits the identical target, claim and evidence
    Then no additional judge request is made
    And Jev returns the previously recorded review
    And no attempt count grants permission
