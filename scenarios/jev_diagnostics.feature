# language: en
# Requirements: PRD FR-73, FR-74, FR-75; FR-17 (not an ordinary gate), FR-25/FR-56 superseded clauses.
# Source contract: AGENTS.md "Current owner contract"; src/jev-skill.md sections 4-5, 8.
# Normative business specification only: no step definitions, runner or executable acceptance
# suite exists in this repository. Step definitions are NOT claimed.
Feature: Jev records diagnostic coverage and never decides execution or completion
  Every judgment is evidence for the owner and the executor. It is not permission.
  A failed, inconclusive, unavailable or not-checked result is disclosed truthfully and
  ordinary work and completion continue under the host's actual permissions.

  Background:
    Given ordinary Jev diagnostics are enabled for this session
    And the host owns tool admission, filesystem permissions and completion

  # FR-73; implementation src/controller.ts, src/state.ts; verification bun test tests/diagnosticController.test.ts
  @jev_diagnostics_01 @fr_73
  Scenario: A failed check is recorded without stopping the next action
    Given an approved development task has just received a negative developer review
    When the executor performs another consequential project action
    Then that action is not refused because of the negative review
    And the negative review remains recorded with its own boundary and work revision
    And no execution error is invented from the negative verdict

  # FR-73; implementation src/controller.ts session_stop path
  @jev_diagnostics_02 @fr_17 @fr_73
  Scenario: Completion does not wait for Jev acceptance
    Given a development task has no business acceptance and no architecture acceptance
    And one diagnostic finding is recorded at the current revision
    When the executor ends the ordinary session
    Then the session stop is not rejected for missing acceptance
    And the missing acceptance and the finding are disclosed as diagnostics
    And no Jev approval is claimed for the completed work

  # FR-74; implementation src/state.ts recordDiagnostic
  @jev_diagnostics_03 @fr_74
  Scenario Outline: Below-floor answers are inconclusive, never proven defects
    Given a valid judgment request returns "<answer>"
    When the result is classified
    Then the recorded class is inconclusive
    And the work is not described as defective
    And no approval is recorded
    Examples:
      | answer                                                    |
      | an approving label below the choice confidence floor      |
      | an on-course label below the boolean probability floor    |
      | an unsettled choice with no decisive confidence           |

  # FR-74; implementation src/state.ts recordDiagnostic, src/controller.ts toolResponse
  @jev_diagnostics_04 @fr_74
  Scenario Outline: Local argument errors are not checked and create no finding
    Given the executor submits "<invalid submission>" to a Jev tool
    When the submission is rejected locally
    Then no judge request is made
    And the result is recorded as not checked
    And no diagnostic finding is created
    And the corrected call remains possible
    Examples:
      | invalid submission                        |
      | jev_acceptance without evidence           |
      | jev_review without a target               |
      | jev_search_relevance with one candidate   |
      | jev_text_review with an empty rule list   |

  # FR-74; implementation src/activities.ts stale paths, src/controller.ts current check
  @jev_diagnostics_05 @fr_74
  Scenario: A stale answer is discarded without becoming a finding
    Given a judgment is in flight for revision 4 of the current task
    When the work advances to revision 5 before the answer returns
    Then the returned answer is recorded as stale and discarded
    And it does not approve or condemn revision 5
    And no diagnostic finding is created for the stale answer

  # FR-74; implementation src/state.ts recordRecovery, src/controller.ts toolResponse
  @jev_diagnostics_06 @fr_74
  Scenario: The original failed material survives later attempts
    Given a requirements submission was refused with exact material at revision 3
    When the executor submits materially different requirements at revision 4
    Then the later submission does not overwrite the original failed material
    And the original boundary, revision, submitted JSON and result remain readable
    And the later attempt appears in the activity diagnostics without replacing that finding

  # FR-75; implementation src/state.ts diagnostic counts, src/controller.ts toolResponse
  @jev_diagnostics_07 @fr_75
  Scenario: Every Jev tool result exposes both diagnostic ledgers
    Given diagnostics are on and at least one Jev tool has run
    When the executor reads any Jev tool result
    Then details.diagnostics contains a checks group and a work group
    And each group contains exactly passed, failed, inconclusive, unavailable and not_checked
    And checks counts judged activity results
    And work counts coverage of consequential tool results

  # FR-75; implementation src/controller.ts diagnoseAction
  @jev_diagnostics_08 @fr_75
  Scenario: A completed consequential result starts not checked and is judged afterwards
    Given an approved plan is current for the task
    When a consequential tool result completes
    Then the work coverage first counts that result as not checked
    And an action-conformance diagnostic runs in the background
    And the next tool call and the session stop do not wait for that background check

  # FR-75; implementation src/controller.ts tool_result asynchronous branch
  @jev_diagnostics_09 @fr_75
  Scenario: An asynchronous effect stays not checked until its terminal result is observed
    Given a consequential invocation starts a background effect
    When only the launch result has been observed
    Then the work coverage for that invocation remains not checked
    And no passed diagnostic is attributed to the unfinished effect
    And observing the later terminal result does not by itself become an approval

  # FR-75; implementation src/controller.ts statusText, /jev-status handler
  @jev_diagnostics_10 @fr_75
  Scenario: Session status reports coverage and acceptance as separate facts
    Given checks have passed, failed and been left not checked in this session
    And business acceptance is recorded while architecture acceptance is missing
    When the owner runs /jev-status
    Then the report shows the work group and the checks group separately
    And it names current-revision business and architecture acceptance separately
    And it reports judge calls and estimated spend
    And no passed action check is presented as proof of the implementation

  # FR-73, FR-74; implementation src/activities.ts finding records, jev_context list
  @jev_diagnostics_11 @fr_74
  Scenario: A finding is disclosed with its class and observability
    Given a valid judgment established a defect at a named boundary
    When the executor reports that finding
    Then the report names the boundary, work revision and decision class
    And it does not call uncertainty a defect
    And it states that the finding grants no approval and blocks no work or completion

  # FR-22; implementation src/activities.ts submitToJudge deduplication
  @jev_diagnostics_12 @fr_22
  Scenario: Repeating unchanged material costs no second judgment
    Given a submission was judged and its material was recorded
    When the executor resubmits byte-identical material at the same binding
    Then no additional judge request is made
    And the earlier result is returned as the recorded diagnostic
    And neither repetition nor an attempt count becomes permission or an approval

  # FR-31, FR-72; implementation src/gates.ts isConsequentialMutation
  @jev_diagnostics_13 @fr_31
  Scenario: Recognized read-only work costs no judgment
    Given the executor reads a project file or runs a recognized literal read command
    When the tool result is observed
    Then no consequential work coverage is recorded for that call
    And no judgment is requested merely to observe existing state
    And the observation is not held for missing planning

  # FR-31; implementation src/gates.ts MUTATING_TOOLS, READ_ONLY_TOOLS
  @jev_diagnostics_14 @fr_31
  Scenario Outline: Opaque and mutating work stays consequential without being blocked
    Given the executor invokes "<operation>"
    When the call is classified
    Then it is recorded as consequential work
    And it is eligible for a diagnostic judgment on its actual payload
    And the classification does not itself refuse the call
    Examples:
      | operation                                  |
      | an unknown tool or MCP route               |
      | eval or delegated task code                |
      | an LSP action that can apply an edit       |
      | a shell command that changes the tree      |
      | a publication command                      |

  # FR-75; implementation src/controller.ts settleBackground, async-result context
  @jev_diagnostics_15 @fr_75
  Scenario: An asynchronous effect settles only on its matching terminal result
    Given an asynchronous launch recorded a pending effect with job id, tool type and start time
    When a terminal async result with the same job id and type arrives later
    Then the pending effect settles and its action diagnostic runs
    And the settled effect advances work evidence once
    And replaying the same terminal result does not count it twice
    And a mismatched job id, mismatched tool type or earlier timestamp does not settle it
    And the unsettled effect remains recorded as not checked

  # FR-31, FR-75; implementation src/gates.ts NON_MUTATING_DEVICES
  @jev_diagnostics_16 @fr_31
  Scenario: Jev tool calls through write devices are not project mutations
    Given the executor invokes a Jev tool through write with path xd://jev_anti_slop
    When the call is classified
    Then it is treated as a Jev diagnostic call rather than a project change
    And it does not advance the project work revision
    And its own judgment is recorded on the checks ledger
