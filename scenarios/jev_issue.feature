# language: en
# Requirements: PRD FR-85, FR-86, FR-87.
Feature: Review a tracker issue without filing or closing it
  Jev checks the author's draft and the developer's work against observed tracker evidence.
  Posting and closure remain separate native actions that require owner authorization.

  Background:
    Given a session is examining issue 42 in the import project's tracker

  @jev_issue_01 @fr_85
  Scenario: A duplicate-free draft is ready for an authorized handoff
    Given the scoped tracker inventory was observed with no candidates
    When the author asks Jev to prepare the draft
    Then Jev returns the exact destination, title and body for a separate native handoff
    And Jev says filing still requires exact owner authorization

  @jev_issue_02 @fr_85
  Scenario: An exact duplicate stops the draft review before judging
    Given the observed inventory contains the exact draft as issue 42
    When the author asks Jev to prepare the draft
    Then Jev returns issue 42 rather than a posting handoff
    And the request does not reach the judge

  @jev_issue_03 @fr_85
  Scenario Outline: An unsuitable inventory cannot establish the absence of duplicates
    Given the draft cites an inventory that is "<problem>"
    When the author asks Jev to prepare the draft
    Then Jev returns "<kind>" and no posting handoff
    And the request does not reach the judge
    Examples:
      | problem             | kind    |
      | unobserved          | unclear |
      | for another project | defect  |

  @jev_issue_12 @fr_85
  Scenario: A differently worded issue can already cover the draft's behavior
    Given the scoped inventory contains a differently worded report of the same duplicate-record behavior
    When the author asks Jev to prepare the draft
    Then Jev returns the equivalent issue rather than a posting handoff

  @jev_issue_04 @fr_86
  Scenario: Native readback confirms the issue, not its author
    Given the native client returned the complete matching issue
    When the author asks Jev to verify filing
    Then Jev confirms issue 42 was filed without claiming who posted it
    And the request does not reach the judge

  @jev_issue_05 @fr_86
  Scenario Outline: Filing is not confirmed by a near match
    Given the issue evidence has "<problem>"
    When the author asks Jev to verify filing
    Then filing remains unverified with a "<kind>" result
    And the request does not reach the judge
    Examples:
      | problem                          | kind    |
      | no observed output               | unclear |
      | a non-native command             | unclear |
      | a different body                 | defect  |
      | a different project URL          | defect  |

  @jev_issue_06 @fr_87
  Scenario: Rejecting a diagnosis does not discard a supported requirement
    Given the native client returned the complete matching issue
    And a repository contract and a cache-disabled control run were observed
    When the developer asks Jev to review the requirement and the diagnosis separately
    Then the one-record requirement is a change obligation and the rejected diagnosis is not

  @jev_issue_07 @fr_87
  Scenario: The report itself cannot disprove its own diagnosis
    Given the native client returned the complete matching issue
    When the developer cites only the issue text to disagree with its diagnosis
    Then Jev identifies the missing independent evidence even though the judge backed the disposition

  @jev_issue_08 @fr_87
  Scenario: Development maps a real obligation to a check with a counterexample
    Given Jev recorded the one-record requirement as an obligation for issue 42
    When the developer submits a change and a check that would detect duplicate records
    Then Jev records that proposal as ready for development, not as implemented

  @jev_issue_09 @fr_87
  Scenario Outline: Development cannot borrow the wrong review or invent an obligation
    Given Jev recorded the one-record requirement as an obligation for issue 42
    When the developer submits a plan that "<problem>"
    Then Jev returns "<kind>" without marking development ready
    And the request does not reach the judge
    Examples:
      | problem                                | kind    |
      | names a filing verification as its prior | unclear |
      | reuses the review after the issue changed | unclear |
      | treats the rejected diagnosis as required | invalid |

  @jev_issue_10 @fr_87
  Scenario: Delivery needs a passing terminal check after the last edit
    Given Jev recorded a development review for the one-record requirement
    And the developer edited the implementation after that review
    When the developer asks Jev to accept delivery before rerunning the check
    Then Jev names the missing terminal check and does not accept delivery
    When the check finishes with an error and the developer asks again
    Then Jev does not accept the failed check even if the judge supports it
    When the check passes with the one-record result and the developer asks again
    Then Jev accepts the recorded delivery against the development review
    And no tracker status, publication or closure is changed

  @jev_issue_11 @fr_87
  Scenario: A once-accepted check cannot prove a newer edit
    Given Jev recorded a development review for the one-record requirement
    And delivery was accepted after the edit and passing check
    When the developer changes the implementation again and asks Jev to accept without a new run
    Then Jev names the missing terminal check and does not accept delivery
