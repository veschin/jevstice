# language: en
# Source contract: src/factCheck.ts; tests/factCheck.test.ts.
Feature: Check exact draft claims against observed sources
  A fact-check reports what the submitted excerpts establish about each claim.
  It applies only to the submitted draft and does not approve publication.

  @jev_fact_check_01
  Scenario: Full table context supports the value for the stated condition
    Given an opened benchmark table reports 70% baseline recall and 85% recall with the flag enabled
    When the draft claims 85% recall with the flag enabled and cites the row, headings and caption
    Then the review marks the claim supported and recommends keeping it
    And the review is limited to the submitted draft, not publication approval

  @jev_fact_check_02
  Scenario: A value from the baseline contradicts a claim about the enabled flag
    Given an opened benchmark table reports 70% baseline recall and 85% recall with the flag enabled
    When the draft claims 70% recall with the flag enabled and cites the row, headings and caption
    Then the review marks the claim contradicted and recommends correcting or removing it
    And the judge receives the exact claim and must match its comparison condition

  @jev_fact_check_03
  Scenario: A verbatim row alone does not identify the comparison columns
    Given an opened benchmark table reports 70% baseline recall and 85% recall with the flag enabled
    When the draft claims 85% recall with the flag enabled and cites only the table row
    Then the review marks the excerpt verified but asks for the missing table context

  @jev_fact_check_04
  Scenario Outline: A supportive answer cannot substitute for observed evidence
    Given an opened benchmark table reports 70% baseline recall and 85% recall with the flag enabled
    When the draft claims 85% recall with the flag enabled and submits "<evidence>"
    Then the review reports "<verdict>" and recommends "<action>" despite a supportive judge answer

    Examples:
      | evidence                          | verdict            | action           |
      | no excerpts                       | undecidable        | leave_unresolved |
      | excerpts from an unopened source  | unverified_excerpt | reopen_source    |
      | a fabricated quote from the table | unverified_excerpt | reopen_source    |

  @jev_fact_check_05
  Scenario: A tentative judgment does not establish the claim
    Given an opened benchmark table reports 70% baseline recall and 85% recall with the flag enabled
    When complete excerpts accompany a claim of 85% recall but the judge is below the confidence floor
    Then the claim stays unresolved despite its verified excerpts
