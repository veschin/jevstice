# language: en
# Requirements: PRD FR-01, FR-02, FR-10, FR-30, FR-45, FR-72, FR-73.
# Source contract: src/guidance.ts TRIAGE_DESCRIPTION; src/jev-skill.md section 1.
# Executable: tests/scenarios/steps/triage.ts; run by tests/scenarios/run.test.ts.
Feature: Triage records request depth and external scope without granting permission
  A request is read once, locally, and judged only when it needs deeper activity.
  Triage records the objective and narrow topics. It never blocks project reads,
  and its absence or uncertainty is a diagnostic fact, not an execution error.

  # FR-30; implementation src/screen.ts, src/controller.ts before_agent_start
  @jev_triage_01 @fr_30 @fr_72
  Scenario Outline: A quiet request needs no triage call
    Given no development task is registered
    When the owner asks to "<request>"
    And the executor performs only the requested recognized read-only work
    Then no triage judgment is requested
    And project reads and public URL reads remain available
    And no development registration is invented
    Examples:
      | request                                        |
      | inspect the existing export command            |
      | verify the existing test results               |
      | summarize a public article at an HTTPS URL     |

  # FR-02, FR-30; implementation src/activities.ts triage (registration branch)
  @jev_triage_02 @fr_02 @fr_30
  Scenario: A judged development request registers the exact objective
    Given the owner asks to add a dry-run flag and update the usage text
    When triage decides at the floor that the request requires development
    Then the exact owner request is registered as the task objective
    And the result names the task fingerprint
    And no approval of implementation is recorded

  # FR-02; implementation src/activities.ts triage simple branch
  @jev_triage_03 @fr_02
  Scenario: A simple request names the skipped stages
    Given the owner asks only to verify existing output
    When triage decides at the floor that the request is simple
    Then the result lists the deeper stages that are unnecessary
    And no development task is registered
    And the requested ordinary work is not held for requirements or a plan

  # FR-01; implementation src/activities.ts triage topic selection
  @jev_triage_04 @fr_01
  Scenario: Only concrete requested expertise topics are retained
    Given the executor proposes the topics "export CLI flag" and "general development"
    When triage judges each topic for this specific request
    Then "export CLI flag" is retained only at the floor
    And "general development" is rejected as a generic label
    And the rejected topic is not silently promoted into a requirement

  # FR-10; implementation src/activities.ts triage question set
  @jev_triage_05 @fr_10
  Scenario: No generic catalog is attached to every prompt
    Given an ordinary owner prompt arrives
    When the addon prepares guidance
    Then no generic expertise catalog is selected automatically
    And only topics actually submitted for the current request are judged

  # FR-45; implementation src/activities.ts triage external question
  @jev_triage_06 @fr_45
  Scenario: Triage records whether the deliverable is external
    Given a request whose deliverable is a document for an outside audience
    When triage settles depth and external scope in one batch
    Then the registered task records the external classification
    And an internal code change is not classified as an external deliverable

  # FR-45, FR-73; implementation src/activities.ts triage external uncertainty
  @jev_triage_07 @fr_45
  Scenario: Uncertain external scope is not silently treated as internal
    Given triage returns external probability 0.55 and internal probability 0.45
    When the result is recorded
    Then the deliverable is kept in external review scope
    And later anti-slop review is not silently excluded
    And no external delivery is authorized by the classifier

  # FR-20, FR-30; implementation src/activities.ts triage unsettled branch
  @jev_triage_08 @fr_20
  Scenario: Unsettled triage registers nothing and is recorded as uncertainty
    Given a valid triage submission
    When development and simple probabilities both stay below the floor
    Then no development task and no simple result are registered
    And the result is classified as inconclusive rather than a defect
    And the executor may continue independent work and submit clearer material

  # FR-30; implementation src/activities.ts triage request validation
  @jev_triage_09 @fr_30
  Scenario: A mismatched request is refused locally with the current words
    Given the current owner message is "Add the export flag"
    When the executor submits "Add a login redirect" to triage
    Then no judge request is made
    And the result names the current owner message and its digest
    And the executor can resubmit the exact owner text

  # FR-30; implementation src/activities.ts triage registered-task prerequisite
  @jev_triage_10 @fr_30
  Scenario: Triage is registered once per request
    Given a development task is already registered
    When the executor calls triage again for the same request
    Then the result names the existing task as the prerequisite
    And it directs the executor to requirements, planning or jev_reaim
    And no second task identity is created

  # FR-73; implementation src/controller.ts tool_call boundary
  @jev_triage_11 @fr_73
  Scenario: Missing triage does not block project work
    Given a judged change has no triage decision yet
    When the executor reads a project file or performs a consequential action
    Then the action is not refused for missing triage
    And the work is recorded as not yet reviewed rather than approved
    And the host remains the authority for the action

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_triage_12 @fr_73
  Scenario: A judge outage registers no task and does not stop work
    Given a valid triage request is ready
    When the judge is unavailable during triage
    Then no development or simple registration is created
    And the triage result states that no judgment exists
    And ordinary work continues under the host's permissions
