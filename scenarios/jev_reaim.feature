# language: en
# Requirements: PRD FR-29, FR-69; FR-44 superseded; FR-73, FR-76.
# Source contract: src/guidance.ts REAIM_DESCRIPTION; src/jev-skill.md section 6.
# Executable: tests/scenarios/steps/reaim.ts; run by tests/scenarios/run.test.ts.
Feature: Switch tasks only when the owner replaces the objective
  The executor cites the owner's new direction verbatim in jev_reaim.
  An established replacement starts a new task without carrying over the previous
  checks. A clarification or addition leaves the original task in place.

  Background:
    Given an active development task has approved requirements and an approved plan
    And the owner's authentic messages are recorded in session history

  # FR-29; implementation src/activities.ts reaim, src/state.ts reaimTask
  @jev_reaim_01 @fr_29
  Scenario: A verified replacement starts the login redirect task
    Given the owner said "Stop the export flag work and fix the login redirect instead."
    And the owner history establishes a replacement at the approval floor
    When the executor submits those exact words with matching authentic user evidence
    Then Jev reports the login redirect objective under a different task ID
    And requirements, plan, acceptance and findings from the old task no longer apply
    And fresh requirements and a fresh plan review are required without another triage

  # FR-29; implementation src/activities.ts interjection history check
  @jev_reaim_02 @fr_29
  Scenario: A quote the owner never sent cannot replace the task
    Given the proposed interjection does not occur in any authentic owner message
    When the executor submits it with quoted evidence
    Then the call is refused before any judge request
    And the current task remains unchanged
    And Jev does not treat the executor's proposed words as the owner's

  # FR-29; implementation src/activities.ts evidence requirement
  @jev_reaim_03 @fr_29
  Scenario: An authentic message still needs the verbatim user evidence
    Given a valid interjection occurs in owner history
    When the submitted evidence lacks an identical user-kind quote
    Then Jev refuses the request without asking the judge
    And no task change is recorded
    And the result states that caller evidence cannot establish who said it

  # FR-29, FR-69; implementation src/activities.ts reaim judge instruction
  @jev_reaim_04 @fr_29
  Scenario Outline: Keeping or clarifying the export work does not replace it
    Given the owner history contains "<message>"
    When the executor submits it as a re-aim
    Then the judge does not establish a replacement at the floor
    And the existing task keeps its requirement and plan approvals
    And the message remains available to the normal follow-up classification
    Examples:
      | message                                      |
      | also keep the existing output format          |
      | clarify that the flag applies to JSON export  |
      | the export flag still matters                 |

  # FR-29; implementation src/activities.ts reaim no-task prerequisite
  @jev_reaim_05 @fr_29
  Scenario: With no registered task, start with triage
    Given no development task is registered
    When the executor calls jev_reaim
    Then Jev points the executor to jev_triage
    And no task is created
    And the message does not reference a removed continuation command

  # FR-76; implementation src/activities.ts reaim rejection, consult recovery removal
  @jev_reaim_06 @fr_76
  Scenario: Re-aim cannot clear an existing finding
    Given a diagnostic finding or refused submission exists
    When the executor submits a re-aim whose only purpose is to escape that finding
    Then the judge does not establish an owner replacement
    And the original finding is still present
    And no continuation, waiver or repair permit is created

  # FR-29; implementation src/activities.ts external classification on re-aim
  @jev_reaim_07 @fr_29
  Scenario: A new objective for an outside audience records external scope
    Given a genuine replacement asks for a document for an outside audience
    When the re-aim is approved
    Then the replacement task is marked external
    And the anti-slop review applies as an advisory check
    And the external classification does not authorize publication

  # FR-20, FR-73; implementation src/activities.ts reaim below-floor branch
  @jev_reaim_08 @fr_20
  Scenario: A replacement answer below the floor leaves the original task active
    Given a valid re-aim submission
    When the replacement probability is below the floor
    Then the task ID and objective stay the same
    And the result is classified as a refusal of the replacement claim
    And the executor may continue the current task or submit materially different owner evidence

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_reaim_09 @fr_73
  Scenario: A judge outage does not establish a new objective
    Given a valid re-aim submission
    When the judge is unavailable
    Then no task change is recorded
    And Jev reports there was no decision
    And ordinary work continues under the current task and host permissions
