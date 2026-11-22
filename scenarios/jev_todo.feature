# language: en
# Requirements: PRD FR-88, FR-89, FR-90.
Feature: Review, resume, and clean up the observed project backlog
  Jev reads the current backlog and its sources to explain what is covered,
  what is ready, and what can move to history. It neither runs the checks nor edits the backlog.

  Background:
    Given an import backlog with a summary that needs verified import records and an independent preview task

  @jev_todo_01 @fr_88
  Scenario: Review distinguishes a reusable check from weak and unneeded work
    Given an observed executable check would catch duplicate records
    And another import check asserts only HTTP success while an unrelated rename has no requirement
    When the developer asks Jev to review the backlog
    Then Jev reports coverage for the import requirement and identifies the reusable executable check
    And Jev flags the status-only check as weak and the rename as unsupported scope

  @jev_todo_02 @fr_88
  Scenario: An unobserved executable check is not proof of coverage
    Given the backlog cites but the session has not observed an executable check
    When the developer asks Jev to review the backlog
    Then Jev excludes the cited check from the judge material and does not recommend reuse

  @jev_todo_03 @fr_89
  Scenario: A current import receipt makes its dependent task ready
    When the developer resumes from the current backlog without reports
    Then import is next, summary is waiting, and preview is independently ready
    When the developer records a current verified import receipt and resumes
    Then import is verified and summary is next
    And Jev does not ask the judge to decide readiness

  @jev_todo_04 @fr_89
  Scenario: Updating the reported fingerprint does not make old output current
    Given a current verified import receipt has made summary ready
    When the import result changes and the developer relabels the receipt with the new fingerprint but keeps the original output
    Then the import report is stale, summary is waiting again, and preview retains its fingerprint

  @jev_todo_09 @fr_89
  Scenario: A receipt with the right fingerprint still needs observed output
    When the developer resumes with a matching import receipt whose output was never observed
    Then Jev marks the import receipt unobserved and keeps the summary waiting
    And Jev does not ask the judge to decide readiness

  @jev_todo_05 @fr_89
  Scenario Outline: Resumption refuses evidence other than the whole current backlog
    When the developer attempts to resume using "<evidence>"
    Then Jev requests a whole current read and does not select a next task
    And Jev does not ask the judge to decide readiness
    Examples:
      | evidence                     |
      | a ranged read                |
      | bytes that no longer match   |

  @jev_todo_06 @fr_89
  Scenario: A dependency cycle does not stop unrelated ready work
    Given import and summary depend on one another
    When the developer resumes from the current backlog without reports
    Then Jev finds the cycle and selects only the unrelated preview task as ready
    And Jev does not ask the judge to decide readiness

  @jev_todo_07 @fr_90
  Scenario: Cleanup proposes archive history without breaking dependencies or editing the backlog
    Given a current verified import receipt has made summary ready
    When cleanup is requested at the configured threshold of one completed epic
    Then the proposal archives only the import epic and preserves summary's link to the import task
    And the backlog file remains byte-for-byte unchanged
    And Jev does not ask the judge to decide readiness

  @jev_todo_08 @fr_90
  Scenario Outline: Cleanup returns no proposal without a met threshold
    Given a current verified import receipt has made summary ready
    When cleanup is requested with "<policy>"
    Then Jev reports one completed epic but no cleanup proposal and returns "<kind>"
    And the backlog file remains byte-for-byte unchanged
    Examples:
      | policy                      | kind     |
      | no configured threshold     | unclear  |
      | a threshold of two epics    | reviewed |
