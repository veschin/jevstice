# language: en
# Requirements: PRD FR-71 (session switch), FR-76, FR-77; owner decision 2026-11-15.
# Source contract: AGENTS.md session mode section; src/jev-skill.md section 0.
# Executable: tests/scenarios/steps/session_mode.ts; run by tests/scenarios/run.test.ts.
Feature: Owner controls diagnostic checks per session
  The owner can pause and resume Jev's checks without changing host permissions,
  configuration files or the safety limits of an optional strict supervisor.

  # FR-77; implementation src/controller.ts /jev handler
  @jev_session_mode_01 @fr_71 @fr_77
  Scenario: Report the current diagnostic mode
    Given Jev diagnostics are on for this session
    When the owner runs /jev with no argument
    Then the report says that diagnostics are on
    And it states that work never requires a Jev continuation permission
    And no model turn is started by the report

  # FR-77; implementation src/controller.ts disabled session set
  @jev_session_mode_02 @fr_71 @fr_77
  Scenario: Pausing checks leaves ordinary work and completion available
    Given Jev diagnostics are on
    When the owner runs /jev off
    Then Jev stops judging tool activity, source capture and workflow prompt injection for that session
    And a consequential project action is not refused for a missing Jev decision
    And ending the session is not held for Jev

  # FR-77; implementation src/controller.ts DISABLED_OUTCOME
  @jev_session_mode_03 @fr_77
  Scenario: A Jev tool call while checks are off is skipped, not approved
    Given the owner has turned Jev diagnostics off for this session
    When the executor calls any Jev tool
    Then the result states that Jevstice is off and no judgment ran
    And the result is marked disabled and skipped
    And no approval, acceptance or finding is recorded

  # FR-77, FR-76; implementation src/controller.ts /jev on branch, src/state.ts freshState
  @jev_session_mode_04 @fr_77
  Scenario: Resuming checks starts a fresh ordinary workflow
    Given the owner has turned diagnostics off after earlier approvals and findings
    When the owner runs /jev on
    Then diagnostics resume with a fresh task workflow
    And earlier approvals and findings are not restored as current decisions
    And session judge usage, activity totals and diagnostic totals remain visible

  # FR-77; implementation src/controller.ts /jev registration and message path
  @jev_session_mode_05 @fr_77
  Scenario: Only the owner's native command can switch the mode
    Given an ordinary session with Jev loaded
    When extension-originated text or a tool argument says "/jev off" or "аппрув"
    Then the diagnostic mode does not change
    And no continuation or waiver authority is created
    And only the registered owner command can report or switch the mode

  # FR-77; implementation src/controller.ts /jev branch without configuration writes
  @jev_session_mode_06 @fr_77
  Scenario: The switch edits neither configuration nor permissions
    Given a project configuration file exists
    When the owner switches diagnostics off and back on
    Then the configuration file is unchanged
    And host tool permissions are unchanged
    And the next loaded session starts with diagnostics on

  # FR-77; implementation src/controller.ts disabledSessions keyed by session
  @jev_session_mode_07 @fr_77
  Scenario: The mode is scoped to one session
    Given two sessions share the same project and configuration
    And the owner turns diagnostics off in the first session
    When both sessions continue working
    Then only the first session has checks off
    And the second session continues its own diagnostic behavior
    And no approval crosses from one session to the other

  # FR-77; implementation src/controller.ts stale-mode rejection
  @jev_session_mode_08 @fr_77
  Scenario: A judgment in flight is discarded when the owner switches the mode
    Given a judge request is in flight for an earlier mode
    When the owner turns diagnostics off
    Then the in-flight answer is not recorded as a current diagnostic
    And it does not approve or block work in the new mode

  # FR-77; implementation src/controller.ts /jev invalid argument notice
  @jev_session_mode_09 @fr_77
  Scenario: An unrecognized argument reports the accepted forms
    Given the owner runs /jev with an unsupported argument
    When the command is handled
    Then the mode is unchanged
    And the owner sees that /jev, /jev on and /jev off are the accepted forms

  # FR-77; implementation src/controller.ts sendMessage deliverAs nextTurn
  @jev_session_mode_10 @fr_77
  Scenario: Switching while the executor is busy queues the next turn
    Given the executor is working in the session
    When the owner turns diagnostics on or off
    Then the mode message is queued for the next turn without steering the active batch
    And the queued message carries only mode guidance, not a permission change
    And an idle session does not start a model turn merely to announce the mode

  # FR-77, FR-76; implementation src/controller.ts /jev handler, strict branch
  @jev_session_mode_11 @fr_77
  Scenario: In a supervised run the switch changes diagnostics only
    Given a strict supervised run is active
    When the owner turns diagnostics off
    Then strict roots, effect permissions, resource limits and containment remain in force
    And the run's durable safety records are not discarded
    And Jev verdicts remain diagnostic evidence in that run

  # FR-75, FR-77; implementation src/controller.ts /jev-status handler
  @jev_session_mode_12 @fr_77
  Scenario: Status remains available in either mode
    Given the owner switches diagnostics off or on
    When the owner runs /jev-status
    Then the report names the session mode
    And it shows the last recorded diagnostic coverage without presenting it as approval
    And it does not resume checks while the mode is off
