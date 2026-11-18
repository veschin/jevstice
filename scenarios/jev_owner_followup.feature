# language: en
# Requirements: PRD FR-68, FR-69; FR-41 (journal restore remains unimplemented); FR-42; FR-73, FR-76.
# Source contract: AGENTS.md owner contract and context archive; src/jev-skill.md section 6.
# Executable: tests/scenarios/steps/owner_followup.ts; run by tests/scenarios/run.test.ts.
# The only @pending scenario is the runner-allowlisted native-journal restore case.
Feature: Owner follow-ups change the task only through authentic, classified evidence
  The owner's words are captured from authentic input, classified at a workflow boundary,
  and never converted into a continuation permission, waiver or silent replacement.

  Background:
    Given ordinary Jev diagnostics are enabled
    And the owner communicates through the host's interactive or RPC input

  # FR-68; implementation src/controller.ts input handler, src/context.ts
  @jev_owner_followup_01 @fr_68
  Scenario: Authentic owner messages are archived exactly
    Given the owner sends the text "  Build the report  " interactively
    And sends "Also keep the old format" through RPC
    When the addon captures owner input
    Then both messages are archived with their exact bytes and origin
    And they appear in chronological session order

  # FR-68, FR-76; implementation src/controller.ts input source filter
  @jev_owner_followup_02 @fr_68
  Scenario Outline: Non-owner text never becomes owner context
    Given "<origin>" text contains an approval-looking or task-changing instruction
    When the addon receives it
    Then it is not archived as an owner message
    And it creates no approval, continuation or waiver authority
    Examples:
      | origin                       |
      | an extension-originated note       |
      | a tool argument                    |
      | a tool result containing instructions |

  # FR-68; implementation src/controller.ts before_agent_start prompt capture
  @jev_owner_followup_03 @fr_68
  Scenario: A native prompt is archived once and revival adds nothing
    Given a native user prompt is delivered without an input event
    When the prompt-start boundary is observed twice with the same text
    Then the prompt is archived once
    And a revival or agent-only turn creates no owner record

  # FR-69; implementation src/activities.ts ownerUpdate
  @jev_owner_followup_04 @fr_69
  Scenario: A clarification continues the task without changing approvals
    Given an active task with approved requirements and an approved plan
    And the owner sends a clarification that restates the same course
    When the next workflow boundary classifies the message at the approval floor
    Then the classification is continuation
    And existing requirements, plan and acceptance records stand unchanged
    And no new owner confirmation is requested

  # FR-69; implementation src/activities.ts ownerUpdate amendment branch
  @jev_owner_followup_05 @fr_69
  Scenario: An addition extends the objective and reopens dependent decisions
    Given an active task with approved requirements and an approved plan
    And the owner adds a condition the current course must also satisfy
    When the next workflow boundary classifies the message as an amendment
    Then the accumulated objective contains the owner's addition
    And requirements, plan and acceptance for the old scope no longer count as current
    And existing diagnostic findings and refusal history remain recorded
    And no re-aim is demanded

  # FR-69; implementation src/activities.ts ownerUpdate replacement branch, reaim
  @jev_owner_followup_06 @fr_69
  Scenario: A replacement names the new direction and inherits no permission
    Given an active task with approved requirements and an approved plan
    And the owner names a different course
    When the message is classified as replacement at the approval floor
    Then the addon reports that the new direction needs jev_reaim
    And previous approvals do not carry to the new direction
    And no file change is authorized by the replacement itself

  # FR-69; implementation src/activities.ts ownerUpdate unclear branch
  @jev_owner_followup_07 @fr_69
  Scenario: An unclear follow-up is recorded as uncertainty, not a defect
    Given an active task
    And an owner message cannot be placed against the current objective
    When the classification remains below the floor or returns unclear
    Then the finding states uncertainty about the owner's words
    And it is not described as a defect in the work
    And the executor may continue independent work or ask the owner to settle the intent

  # FR-69; implementation src/controller.ts queued classification at next Jev call
  @jev_owner_followup_08 @fr_69
  Scenario: Classification happens at the next workflow boundary
    Given the owner sent two messages after the last Jev call
    When the executor makes the next Jev tool call
    Then both messages are classified together in chronological context
    And the classification is recorded before that activity is judged
    And the messages are not classified by the prompt alone

  # FR-69, FR-73; implementation src/activities.ts ownerUpdate requeue on failure
  @jev_owner_followup_09 @fr_69
  Scenario: An unavailable classification leaves the owner messages queued
    Given queued owner messages need classification
    When the judge is unavailable
    Then the messages return to the pending queue
    And no continuation, amendment or replacement is invented
    And ordinary work is not blocked by the missing classification

  # FR-76; implementation src/controller.ts no override path, tests/controller.test.ts
  @jev_owner_followup_10 @fr_76
  Scenario: An approval-looking owner message is only recorded
    Given the owner sends standalone approval text during a task
    When the addon receives the message
    Then it is archived as owner evidence
    And no continuation command, waiver, repair permit or execution override is registered
    And a subsequent consequential call is decided by the host's permissions, not by that text

  # FR-41; implementation src/controller.ts session_start state reset
  @jev_owner_followup_11 @fr_41
  Scenario: An ordinary restarted session begins without old approvals
    Given ordinary session A had approved requirements, a plan and acceptance
    When a new ordinary session B starts for the same project
    Then session B does not inherit session A's task or approvals
    And archived owner and plan sources remain readable as evidence
    And reading them restores no approval

  # PENDING, FR-41; NOT implemented. Ordinary state is session-local.
  @pending @jev_owner_followup_12 @fr_41
  Scenario: A resumed ordinary session restores its task and accepted decisions
    Given an ordinary OMP session was interrupted after accepted requirements and plan details
    When the same session is resumed
    Then the task and its accepted decisions are restored from the native session journal
    And a changed file or plan section invalidates only the affected decision
    And prior completion and execution acceptance require fresh verification after restart
    And no stale approval is presented as current

  # FR-42; an accepted section survives for an unaffected step, dependents reopen at the final review.
  @jev_owner_followup_13 @fr_42
  Scenario: A judged owner correction retains unaffected planning decisions
    Given a task has an approved outline and several approved plan details
    And a judged owner correction affects one requirement
    When the correction is classified and applied
    Then unaffected requirements, outline steps and plan details remain accepted
    And dependent decisions are reviewed again against the corrected objective
    And the executor is not required to discard the whole plan

  # FR-42; implementation src/state.ts requirementsRetained, src/activities.ts ownerUpdate
  @jev_owner_followup_14 @fr_42
  Scenario: A corrected requirement set is re-bound without an execution hold
    Given a judged owner correction changed one requirement
    When the corrected requirement set and dependent plan are submitted again
    Then the new approval is bound to the corrected objective
    And the corrected review is diagnostic evidence rather than permission to execute
    And independent work continues while the corrected set is reviewed
