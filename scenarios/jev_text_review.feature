# language: en
# Requirements: PRD FR-27, FR-20; FR-73.
# Source contract: src/guidance.ts TEXT_REVIEW_DESCRIPTION; tests/activities.test.ts FR-27.
# Executable: tests/scenarios/steps/text_review.ts; run by tests/scenarios/run.test.ts.
Feature: Report violations of the rules submitted for an exact text
  A review identifies the passage and quotes the rule it violates.
  Its result says nothing about matters outside the submitted rules.
  It does not rewrite or translate the text.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-27; implementation src/activities.ts textReview
  @jev_text_review_01 @fr_27
  Scenario Outline: Use the declared scope to choose what each rule checks
    Given a draft mixes two prose paragraphs with a heading, a pipe table and fenced code
    And one submitted rule has scope "<scope>"
    When the executor submits the text for review
    Then a "<scope>" rule is applied to "<target>"
    And headings, tables and fenced code are never substituted for prose fragments
    Examples:
      | scope    | target                        |
      | text     | the complete exact text once  |
      | fragment | each canonical prose fragment |
      | omitted  | the complete exact text once  |

  # FR-27; implementation src/activities.ts defect rendering
  @jev_text_review_02 @fr_27
  Scenario: Quote the offending passage and the original rule
    Given the judge establishes that one prose fragment violates a submitted rule
    When the executor submits the text for review
    Then the result names the violating fragment
    And it reproduces the submitted rule text byte-identically
    And the result offers neither a replacement sentence nor style advice

  # FR-27; implementation src/activities.ts clean branch
  @jev_text_review_03 @fr_27
  Scenario: A clean result applies only to the rules checked
    Given a valid text and rule set
    When every rule check is decisively satisfied
    Then the diagnostic reports that no submitted rule was violated
    And it does not claim general quality, truth or approval to publish

  # FR-20; implementation src/activities.ts unsettled branch
  @jev_text_review_04 @fr_20
  Scenario: Report the unsettled rule alongside confirmed violations
    Given one fragment/rule answer stays between the decision floors
    When the executor submits the text for review
    Then the result lists that unsettled fragment and rule
    And any separately established violations are listed as defects
    And the review is not reported as clean

  # FR-27; implementation src/activities.ts fragment bound
  @jev_text_review_05 @fr_27
  Scenario: Ask for smaller submissions instead of reviewing a prefix
    Given the submitted text has more fragments than the configured review bound
    When the tool validates the text
    Then the judge receives no request
    And the result asks the executor to split the text
    And no subset is silently approved

  # FR-27; implementation src/activities.ts validation
  @jev_text_review_06 @fr_27
  Scenario Outline: Reject malformed inputs without calling the judge
    Given the submission has "<defect>"
    When the text review validates it
    Then the judge receives no request
    And the result names the invalid field
    And no finding is recorded
    Examples:
      | defect                                   |
      | empty text                               |
      | an empty rule list                       |
      | a rule without class or text             |
      | an unknown rule scope                    |
      | fragment rules with no prose fragment     |

  # FR-73; implementation src/activities.ts text review does not gate
  @jev_text_review_07 @fr_73
  Scenario: A violation stays on record without blocking the next action
    Given the text review establishes a violation
    When the executor makes a subsequent project edit
    Then the next action is not refused by the text finding
    And the finding remains recorded as diagnostic evidence
    And the executor may resubmit corrected text at any time

  # FR-73; implementation src/judge adapter, activities textReview
  @jev_text_review_08 @fr_73
  Scenario: A judge outage cannot establish compliance
    Given a valid text review
    When the judge is unavailable
    Then the result states that no judgment exists
    And the tool does not say the text meets the rules
    And ordinary work continues

  # FR-22; implementation src/activities.ts submitToJudge identity
  @jev_text_review_09 @fr_22
  Scenario: Return the recorded judgment for an identical submission
    Given the identical text and rules were already judged
    When the executor resubmits them unchanged
    Then resubmission makes no additional judge request
    And the recorded result is returned
    And the repetition grants no approval
