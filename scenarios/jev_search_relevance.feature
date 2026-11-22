# language: en
# Requirements: PRD FR-03, FR-20; FR-73.
# Source contract: src/guidance.ts SEARCH_DESCRIPTION; tests/activities.test.ts FR-03.
# Executable: tests/scenarios/steps/search_relevance.ts; run by tests/scenarios/run.test.ts.
Feature: Identify which submitted excerpt answers a search question
  The executor supplies the excerpts and explains why each might answer the question.
  The diagnostic can name a candidate or find none suitable. It returns the
  executor's reason as written and grants no authority to act on the result.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-03; implementation src/activities.ts searchRelevance
  @jev_search_relevance_01 @fr_03
  Scenario: The choice returns the matching candidate and its original reason
    Given each of two candidates has an exact excerpt and the executor's reason for considering it
    When the judge selects the second candidate at the confidence floor
    Then only the second submitted candidate appears as the selection
    And the returned reason is byte-identical to the executor's second reason
    And no judge-authored explanation is added

  # FR-03; implementation src/activities.ts validation
  @jev_search_relevance_02 @fr_03
  Scenario Outline: Reject an incomplete search submission locally
    Given the query or candidate list has "<defect>"
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
  Scenario: Recommend a new search when none of the excerpts answers
    Given the judge decides at the floor that no submitted candidate answers the query
    When the executor submits the search question and candidate excerpts
    Then no candidate is selected
    And the result directs the executor to search again with better evidence
    And no unrelated candidate is substituted

  # FR-20; implementation src/activities.ts below-floor selection
  @jev_search_relevance_04 @fr_20
  Scenario Outline: A tentative answer leaves the source unselected
    Given the judge selects "<selection>" below the confidence floor
    When the executor submits the search question and candidate excerpts
    Then no candidate is treated as selected
    And the result is inconclusive rather than a defect in a candidate
    And a new judgment requires changed candidates or excerpts
    Examples:
      | selection          |
      | one candidate      |
      | none relevant      |

  # FR-03, FR-73; implementation src/activities.ts search result details
  @jev_search_relevance_05 @fr_03
  Scenario: Citing the selected source is a separate project action
    Given a candidate was selected for the current query
    When the executor writes a note citing the selected source
    Then the selection does not itself authorize a project change or publication
    And the citation moves the project revision without changing the owner objective
    And the note write is recorded separately as unchecked work

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_search_relevance_06 @fr_73
  Scenario: A judge outage leaves the search unresolved without blocking other work
    Given the executor has a valid query and candidate list
    When the judge is unavailable
    Then no candidate is selected
    And the result states that no judgment exists
    And the executor may continue independent work

  # FR-22; implementation src/activities.ts submitToJudge identity
  @jev_search_relevance_07 @fr_22
  Scenario: Unchanged query and evidence reuse the previous answer
    Given a prior judgment exists for this query and candidate list
    When the executor resubmits them unchanged
    Then no additional judge request is made
    And the prior result is returned as the recorded answer
    And the attempt count creates no permission
