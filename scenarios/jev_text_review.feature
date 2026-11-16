# language: en
# Requirements: PRD FR-27, FR-20; FR-73.
# Source contract: src/guidance.ts TEXT_REVIEW_DESCRIPTION; tests/activities.test.ts FR-27.
# Normative business specification only; no step definitions or executable runner exist here.
Feature: Review exact text against the executor's submitted register rules
  The review names every violating fragment with the rule line the executor submitted.
  It writes no advice, translates nothing and makes no claim beyond the submitted rules.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-27; implementation src/activities.ts textReview
  @jev_text_review_01 @fr_27
  Scenario Outline: Apply each rule at its declared scope
    Given the exact text contains a heading, a pipe table, fenced code and two prose paragraphs
    And one submitted rule has scope "<scope>"
    When the text review runs
    Then a "<scope>" rule is applied to "<target>"
    And headings, tables and fenced code are never substituted for prose fragments
    Examples:
      | scope    | target                        |
      | text     | the complete exact text once  |
      | fragment | each canonical prose fragment |
      | omitted  | the complete exact text once  |

  # FR-27; implementation src/activities.ts defect rendering
  @jev_text_review_02 @fr_27
  Scenario: A violation quotes the submitted rule line verbatim
    Given the judge establishes that one prose fragment violates a submitted rule
    When the result is returned
    Then the result names the violating fragment
    And it reproduces the submitted rule text byte-identically
    And it adds no rewritten sentence or style advice

  # FR-27; implementation src/activities.ts clean branch
  @jev_text_review_03 @fr_27
  Scenario: No violation means the submitted rules are met
    Given a valid text and rule set
    When every rule check is decisively satisfied
    Then the result reports no violation for those rules
    And it does not claim general quality, truth or approval to publish

  # FR-20; implementation src/activities.ts unsettled branch
  @jev_text_review_04 @fr_20
  Scenario: Unsettled checks prevent a clean review
    Given one fragment/rule answer stays between the decision floors
    When the result is returned
    Then the result lists that unsettled fragment and rule
    And any separately established violations are listed as defects
    And the review is not reported as clean

  # FR-27; implementation src/activities.ts fragment bound
  @jev_text_review_05 @fr_27
  Scenario: Oversized fragment sets are refused without partial judgment
    Given the submitted text has more fragments than the configured review bound
    When the tool validates the text
    Then no judge request is made
    And the result asks the executor to split the text
    And no subset is silently approved

  # FR-27; implementation src/activities.ts validation
  @jev_text_review_06 @fr_27
  Scenario Outline: Invalid review material is refused locally
    Given the submission has "<defect>"
    When the text review validates it
    Then no judge request is made
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
  Scenario: A text defect is correction material, not a stop
    Given the text review establishes a violation
    When the executor edits the text or performs another project action
    Then the next action is not refused by the text finding
    And the finding remains recorded as diagnostic evidence
    And the executor may resubmit corrected text at any time

  # FR-73; implementation src/judge adapter, activities textReview
  @jev_text_review_08 @fr_73
  Scenario: Unavailable judgment is not a clean text
    Given a valid text review
    When the judge is unavailable
    Then the result states that no judgment exists
    And the text is not reported as meeting the rules
    And ordinary work continues

  # FR-22; implementation src/activities.ts submitToJudge identity
  @jev_text_review_09 @fr_22
  Scenario: Repeating unchanged text costs no new judgment
    Given the identical text and rules were already judged
    When the executor resubmits them unchanged
    Then no additional judge request is made
    And the recorded result is returned
    And the repetition grants no approval
