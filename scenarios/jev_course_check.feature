# language: en
# Requirements: PRD FR-25, FR-70 (hold clause superseded); FR-73, FR-75.
# Source contract: src/guidance.ts COURSE_CHECK_DESCRIPTION; src/jev-skill.md section 7.
# Executable: tests/scenarios/steps/course_check.ts; run by tests/scenarios/run.test.ts.
Feature: Check current work against the approved plan
  The executor can submit one claim about the work and its next action. The
  result applies to that submission and revision. A departure from plan is
  recorded as a finding, not as a reason to stop unrelated work.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-25, FR-70; implementation src/activities.ts explicitCourseCheck
  @jev_course_check_01 @fr_70
  Scenario: A planned action can be checked before implementation begins
    Given the task has an approved plan and at least one plan topic
    And no implementation action has been recorded yet
    When the executor submits a concise claim about the planned work
    Then the claim is judged against the objective, requirements and plan
    And the result gives the course verdict and its confidence
    And no file change is authorized by the answer

  # FR-70; implementation src/activities.ts prerequisite branch
  @jev_course_check_02 @fr_70
  Scenario: No approved plan means no judgment about the current course
    Given the task has no approved plan or plan topic
    When the executor calls jev_course_check with a claim
    Then the tool says an approved plan is needed for the check
    And it states that nothing was judged and no finding was recorded
    And it does not report the work as on course

  # FR-70; implementation src/activities.ts claim validation
  @jev_course_check_03 @fr_70
  Scenario: An empty claim does not reach the judge
    Given the executor calls jev_course_check without claim text
    When the tool validates the submission
    Then no judge request is made
    And the tool asks for a concise claim
    And no finding is recorded

  # FR-25, FR-70; implementation src/activities.ts off-course classification
  @jev_course_check_04 @fr_25
  Scenario: Off course at the confidence floor records a defect for the checked revision
    Given a valid course-check submission
    When the judge answers off_course at the choice floor
    Then the result names the departure as an established defect
    And the finding identifies the checked boundary and revision
    And the result states that it blocks no other work

  # FR-20, FR-70; implementation src/activities.ts below-floor on-course
  @jev_course_check_05 @fr_20
  Scenario: An on-course answer below the floor proves neither alignment nor deviation
    Given a valid course-check submission
    When the judge answers on_course below the choice floor
    Then the tool reports the answer as inconclusive
    And it is not treated as a reliable approval or a proven deviation
    And the executor may submit clearer observable evidence

  # FR-73; implementation src/activities.ts approving branch
  @jev_course_check_06 @fr_73
  Scenario: An on-course verdict leaves unrelated findings and acceptance unchanged
    Given an unrelated diagnostic finding is recorded for the task
    When the executor obtains an on-course answer at the floor
    Then the previous finding stays on record
    And the approving check does not authorize a file change
    And it does not replace business or architecture acceptance

  # FR-25, FR-75; implementation src/controller.ts automatic course check path
  @jev_course_check_07 @fr_25
  Scenario: One action can fit the plan without addressing every topic
    Given the plan has several topics
    And one recent action serves one approved requirement
    When the automatic course diagnostic evaluates that action
    Then it judges the action against the whole approved task
    And the action need not address every plan topic at once
    And the verdict is recorded as diagnostic coverage

  # FR-73, FR-75; implementation src/controller.ts tool_result async branch
  @jev_course_check_08 @fr_75
  Scenario: A failed or still-running action does not count as a passing check
    Given a consequential action fails or starts a background effect
    When the result is observed
    Then a failed action advances the work revision
    And an unfinished background effect remains not checked
    And the record shows no passing course check for either case

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_course_check_09 @fr_73
  Scenario: A judge outage leaves alignment unknown and work available
    Given a valid course-check submission
    When the judge is unavailable
    Then the result says there was no judgment
    And no defect is invented
    And ordinary work and completion remain available

  # FR-73; implementation src/activities.ts stale answer check
  @jev_course_check_10 @fr_73
  Scenario: An answer for an earlier revision cannot judge the current work
    Given a course check is in flight for revision 6
    When the task or revision changes before the answer returns
    Then the check discards the answer as stale
    And it neither approves nor condemns the new revision
    And no current course decision is recorded

  # FR-11, FR-12 superseded by FR-78; implementation src/config.ts ignores courseCheck.*
  @jev_course_check_11 @fr_11 @fr_12
  Scenario: Obsolete settings cannot schedule automatic checks
    Given a configuration file contains courseCheck.mode or courseCheck.interval
    When the configuration is loaded
    Then the settings schedule neither periodic nor completion-only checks
    And only the callable jev_course_check remains available
    And the obsolete keys change no execution or completion behavior
