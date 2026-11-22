# language: en
# Requirements: PRD FR-08, FR-09, FR-13, FR-19, FR-20, FR-22; FR-67 superseded.
# Source contract: src/guidance.ts CONSULT_DESCRIPTION; src/jev-skill.md sections 4-5.
# Executable: tests/scenarios/steps/consult.ts; run by tests/scenarios/run.test.ts.
Feature: Ask the judge one advisory question
  The executor provides a question and the context needed to answer it. The
  requested mode determines how the answer is reported. No answer clears an
  existing finding or authorizes a project action.

  Background:
    Given ordinary Jev diagnostics are enabled
    And judge answers are bound to the current task and work revision

  # FR-08; implementation src/activities.ts consult
  @jev_consult_01 @fr_08 @fr_13
  Scenario Outline: The consultation mode determines what answer comes back
    Given a valid "<mode>" consultation with question, context and "<definition>"
    When the judge returns a usable "<answer>" at the applicable floor
    Then the consultation returns that typed answer
    And the judge receives the submitted question and context
    And no project action, acceptance or completion is approved
    Examples:
      | mode    | definition                              | answer                        |
      | choice  | two distinct labeled alternatives       | a submitted label             |
      | score   | two or more ordered rubric criteria     | a score on that rubric        |
      | boolean | distinct true and false meanings        | a yes probability             |

  # FR-08; implementation src/activities.ts consult validation
  @jev_consult_02 @fr_08
  Scenario Outline: An invalid submission identifies the problem without asking the judge
    Given the executor submits a "<defect>" consultation
    When the tool validates the arguments
    Then no judge request is made
    And the result points to the field that is invalid or missing
    And no finding or approval is recorded
    Examples:
      | defect                               |
      | choice with one alternative          |
      | score with one criterion             |
      | boolean without trueMeaning          |
      | missing question                     |
      | missing context                      |

  # FR-67, FR-76; implementation src/activities.ts consult recovery rejection
  @jev_consult_03 @fr_76
  Scenario: A consultation cannot be used to obtain a repair permit
    Given the executor submits mode "recovery" or a repair request
    When the consultation is validated
    Then it is refused locally
    And the result directs the executor to continue work with the finding recorded
    And the tool creates neither a repair permit nor a finding-resolution phase

  # FR-20; implementation src/activities.ts consult floors
  @jev_consult_04 @fr_20
  Scenario Outline: Confidence below the mode's floor leaves the question open
    Given a valid <mode> consultation
    When the judge answer stays below its approval floor
    Then the result explicitly marks the answer inconclusive
    And the result does not claim an approved decision or a proven defect
    And the executor may resubmit only with materially changed material
    Examples:
      | mode    |
      | choice  |
      | score   |
      | boolean |

  # FR-22; implementation src/activities.ts consult boundary identity
  @jev_consult_05 @fr_22
  Scenario: A new question is not constrained by the verdict on another question
    Given one consultation question was refused or left unsettled
    When the executor asks a different question with different material
    Then the judge considers the second question on its own submitted material
    And the earlier result does not block or approve the second question
    And the earlier finding remains recorded

  # FR-73; implementation src/activities.ts consult diagnostic note
  @jev_consult_06 @fr_73
  Scenario: A usable answer leaves an earlier diagnostic intact
    Given a diagnostic finding is recorded for the task
    When the executor obtains a usable consultation answer
    Then the response says the existing finding remains on record
    And the answer neither clears it nor authorizes or blocks an effect
    And the next tool call and completion do not wait for the finding

  # FR-09; implementation src/controller.ts prepareContext, activities evidence
  @jev_consult_07 @fr_09
  Scenario: The tool verifies quoted evidence before sending it to the judge
    Given the executor submits a question with quoted code and an archive sourceId
    When the tool prepares the question and checks its evidence
    Then the exact quote is verified against the archived source before judging
    And the judge receives the submitted question, context and evidence
    And no unsubmitted private reasoning is invented as context

  # FR-19; implementation src/activities.ts material
  @jev_consult_08 @fr_19
  Scenario: The answer applies to the registered task and work revision
    Given a development task is registered
    When a consultation is judged
    Then the registered objective and current approvals accompany the submitted material
    And the answer is bound to that task and work revision
    And a change to the task or revision makes that answer stale

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_consult_09 @fr_73
  Scenario: Judge unavailability does not create a decision or delay completion
    Given a valid consultation
    When the judge is unavailable
    Then no decision is returned
    And the result says there was no judgment
    And ordinary work and completion remain available

  # FR-73; implementation src/controller.ts tool boundary
  @jev_consult_10 @fr_73
  Scenario: Selecting an alternative does not authorize the corresponding change
    Given a consultation approved a proposed alternative
    When the executor performs the corresponding project change
    Then only the host's permissions determine whether the change can execute
    And the consultant answer is not recorded as action authorization
    And any action diagnostic remains separate evidence
