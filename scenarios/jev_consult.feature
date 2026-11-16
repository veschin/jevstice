# language: en
# Requirements: PRD FR-08, FR-09, FR-13, FR-19, FR-20, FR-22; FR-67 superseded.
# Source contract: src/guidance.ts CONSULT_DESCRIPTION; src/jev-skill.md sections 4-5.
# Normative business specification only; no step definitions or executable runner exist here.
Feature: Consult one decision with a typed diagnostic answer
  Choice, score and boolean consultations answer one question from submitted context.
  The answer informs the executor; it clears no finding and authorizes no effect.

  Background:
    Given ordinary Jev diagnostics are enabled
    And judge answers are bound to the current task and work revision

  # FR-08; implementation src/activities.ts consult
  @jev_consult_01 @fr_08 @fr_13
  Scenario Outline: Return the submitted answer shape
    Given a valid "<mode>" consultation with question, context and "<definition>"
    When the judge returns a usable "<answer>" at the applicable floor
    Then the consultation returns that typed answer
    And the answer is accompanied by the submitted context that grounded it
    And no project action, acceptance or completion is approved
    Examples:
      | mode    | definition                              | answer                        |
      | choice  | two distinct labeled alternatives       | a submitted label             |
      | score   | two or more ordered rubric criteria     | a score on that rubric        |
      | boolean | distinct true and false meanings        | a yes probability             |

  # FR-08; implementation src/activities.ts consult validation
  @jev_consult_02 @fr_08
  Scenario Outline: Malformed consultation arguments are refused locally
    Given the executor submits a "<defect>" consultation
    When the tool validates the arguments
    Then no judge request is made
    And the result names the missing or invalid field
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
  Scenario: Recovery and repair consultations are not available
    Given the executor submits mode "recovery" or a repair request
    When the consultation is validated
    Then it is refused locally
    And the result directs the executor to continue work with the finding recorded
    And no repair permit or finding-resolution phase is created

  # FR-20; implementation src/activities.ts consult floors
  @jev_consult_04 @fr_20
  Scenario Outline: Below-floor answers are unsettled, not decisions
    Given a valid <mode> consultation
    When the judge answer stays below its approval floor
    Then the result is unsettled and marked inconclusive
    And the result does not claim an approved decision or a proven defect
    And the executor may resubmit only with materially changed material
    Examples:
      | mode    |
      | choice  |
      | score   |
      | boolean |

  # FR-22; implementation src/activities.ts consult boundary identity
  @jev_consult_05 @fr_22
  Scenario: Different questions are judged independently
    Given one consultation question was refused or left unsettled
    When the executor asks a different question with different material
    Then the second question is judged on its own submitted material
    And the earlier result does not block or approve the second question
    And the earlier finding remains recorded

  # FR-73; implementation src/activities.ts consult diagnostic note
  @jev_consult_06 @fr_73
  Scenario: The answer does not clear a standing finding
    Given a diagnostic finding is recorded for the task
    When the executor obtains a usable consultation answer
    Then the result states that the finding remains a diagnostic record
    And the answer neither clears it nor authorizes or blocks an effect
    And the next tool call and completion do not wait for the finding

  # FR-09; implementation src/controller.ts prepareContext, activities evidence
  @jev_consult_07 @fr_09
  Scenario: Submitted evidence and context are what the judge sees
    Given the executor submits a question with quoted code and an archive sourceId
    When the consultation is prepared
    Then the exact quote is verified against the archived source before judging
    And the judge receives the submitted question, context and evidence
    And no unsubmitted private reasoning is invented as context

  # FR-19; implementation src/activities.ts material
  @jev_consult_08 @fr_19
  Scenario: A registered task is included as decision context
    Given a development task is registered
    When a consultation is judged
    Then the registered objective and current approvals accompany the submitted material
    And the answer is bound to that task and work revision
    And a changed task or revision makes the answer stale

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_consult_09 @fr_73
  Scenario: An unavailable judge yields no decision and no hold
    Given a valid consultation
    When the judge is unavailable
    Then no decision is returned
    And the result states that no judgment exists
    And ordinary work and completion remain available

  # FR-73; implementation src/controller.ts tool boundary
  @jev_consult_10 @fr_73
  Scenario: Consultation advice is not an execution approval
    Given a consultation approved a proposed alternative
    When the executor performs the corresponding project change
    Then the host's permissions decide whether the change executes
    And the consultant answer is not recorded as action authorization
    And any action diagnostic remains separate evidence
