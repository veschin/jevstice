# language: en
# Requirements: PRD FR-03, FR-20; FR-73.
# Source contract: src/guidance.ts SEARCH_DESCRIPTION; tests/activities.test.ts FR-03.
# Executable: tests/scenarios/steps/search_relevance.ts; run by tests/scenarios/run.test.ts.
Feature: Search relevance selects from submitted candidates without inventing prose
  The executor supplies candidates, their evidence and its own reason for each.
  Jev selects a candidate or none. The returned reason is the executor's submitted text,
  and the selection grants no permission to fetch, publish or change anything.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-03; implementation src/activities.ts searchRelevance
  @jev_search_relevance_01 @fr_03
  Scenario: Return the selected candidate with its submitted reason
    Given two candidates each carry an exact evidence excerpt and a submitted reason
    When the judge selects the second candidate at the confidence floor
    Then the result identifies only the second submitted candidate
    And the returned reason is byte-identical to the executor's second reason
    And no judge-authored explanation is added

  # FR-03; implementation src/activities.ts validation
  @jev_search_relevance_02 @fr_03
  Scenario Outline: Invalid candidate sets are refused before judging
    Given the submission has "<defect>"
    When the tool validates the candidates
    Then no judge request is made
    And the result names the invalid candidate field
    And no selection is recorded
    Examples:
      | defect                              |
      | fewer than two candidates           |
      | a candidate without evidence        |
      | a candidate without a submitted reason |
      | an empty query                      |

  # FR-03; implementation src/activities.ts none-relevant option
  @jev_search_relevance_03 @fr_03
  Scenario: No relevant candidate is a valid result
    Given the judge decides at the floor that no submitted candidate answers the query
    When the result is returned
    Then no candidate is selected
    And the result directs the executor to search again with better evidence
    And no unrelated candidate is substituted

  # FR-20; implementation src/activities.ts below-floor selection
  @jev_search_relevance_04 @fr_20
  Scenario Outline: A below-floor selection is unusable
    Given the judge selects "<selection>" below the confidence floor
    When the result is classified
    Then no candidate is treated as selected
    And the result is inconclusive rather than a defect in a candidate
    And a new judgment requires changed candidates or excerpts
    Examples:
      | selection          |
      | one candidate      |
      | none relevant      |

  # FR-03, FR-73; implementation src/activities.ts search result details
  @jev_search_relevance_05 @fr_03
  Scenario: The selected source is evidence, not action authority
    Given a candidate was selected for the current query
    When the executor opens or cites that source
    Then the selection does not itself authorize a project change or publication
    And host permissions and the current task remain authoritative
    And any action diagnostic is recorded separately

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_search_relevance_06 @fr_73
  Scenario: An unavailable judge yields no selection and no stop
    Given a valid search-relevance submission
    When the judge is unavailable
    Then no candidate is selected
    And the result states that no judgment exists
    And the executor may continue independent work

  # FR-22; implementation src/activities.ts submitToJudge identity
  @jev_search_relevance_07 @fr_22
  Scenario: Repeating unchanged candidates costs no judgment
    Given the same query and candidates were already judged
    When the executor resubmits them unchanged
    Then no additional judge request is made
    And the prior result is returned as the recorded answer
    And the attempt count creates no permission
