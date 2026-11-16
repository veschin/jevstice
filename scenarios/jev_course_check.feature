# language: en
# Requirements: PRD FR-25, FR-70 (hold clause superseded); FR-73, FR-75.
# Source contract: src/guidance.ts COURSE_CHECK_DESCRIPTION; src/jev-skill.md section 7.
# Normative business specification only; no step definitions or executable runner exist here.
Feature: A course check reports whether current work follows the approved plan
  The executor can ask one concise question about its current work and next action.
  An on-course answer is evidence about that submission; it is not a release, and an
  off-course or unavailable answer is a diagnostic, not an execution stop.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-25, FR-70; implementation src/activities.ts explicitCourseCheck
  @jev_course_check_01 @fr_70
  Scenario: Judge an explicit claim before any recent action
    Given the task has an approved plan and at least one plan topic
    And no implementation action has been recorded yet
    When the executor submits a concise claim about the planned work
    Then the claim is judged against the objective, requirements and plan
    And the result reports the typed course answer and confidence
    And no file change is authorized by the answer

  # FR-70; implementation src/activities.ts prerequisite branch
  @jev_course_check_02 @fr_70
  Scenario: Missing plan returns a named prerequisite, not a clean bill
    Given the task has no approved plan or plan topic
    When the executor calls jev_course_check with a claim
    Then the result names the approved-plan prerequisite
    And it states that nothing was judged and no finding was recorded
    And it does not report the work as on course

  # FR-70; implementation src/activities.ts claim validation
  @jev_course_check_03 @fr_70
  Scenario: A course check without a claim is refused locally
    Given the executor calls jev_course_check without claim text
    When the tool validates the submission
    Then no judge request is made
    And the result asks for one concise claim
    And no finding is recorded

  # FR-25, FR-70; implementation src/activities.ts off-course classification
  @jev_course_check_04 @fr_25
  Scenario: An off-course answer records an established defect
    Given a valid course-check submission
    When the judge answers off_course at the choice floor
    Then the result names the departure as an established defect
    And the finding is recorded with its boundary and revision
    And the result states that it blocks no other work

  # FR-20, FR-70; implementation src/activities.ts below-floor on-course
  @jev_course_check_05 @fr_20
  Scenario: A below-floor on-course answer is inconclusive
    Given a valid course-check submission
    When the judge answers on_course below the choice floor
    Then the result is inconclusive
    And it is not treated as a reliable approval or a proven deviation
    And the executor may submit clearer observable evidence

  # FR-73; implementation src/activities.ts approving branch
  @jev_course_check_06 @fr_73
  Scenario: An approving check does not clear another finding
    Given an unrelated diagnostic finding is recorded for the task
    When the executor obtains an on-course answer at the floor
    Then the earlier finding remains recorded
    And the approving check does not authorize a file change
    And it does not replace business or architecture acceptance

  # FR-25, FR-75; implementation src/controller.ts automatic course check path
  @jev_course_check_07 @fr_25
  Scenario: A recent action may serve one approved topic
    Given the plan has several topics
    And one recent action serves one approved requirement
    When the automatic course diagnostic evaluates that action
    Then it judges the action against the whole approved task
    And it does not require the action to serve every topic at once
    And the verdict is recorded as diagnostic coverage

  # FR-73, FR-75; implementation src/controller.ts tool_result async branch
  @jev_course_check_08 @fr_75
  Scenario: Failed and asynchronous actions are recorded truthfully
    Given a consequential action fails or starts a background effect
    When the result is observed
    Then a failed action advances the work revision
    And an unfinished background effect remains not checked
    And neither case becomes a passing course check

  # FR-73; implementation src/activities.ts judgeFailure
  @jev_course_check_09 @fr_73
  Scenario: An unavailable judge leaves the course unestablished
    Given a valid course-check submission
    When the judge is unavailable
    Then the result states that no judgment exists
    And no defect is invented
    And ordinary work and completion remain available

  # FR-73; implementation src/activities.ts stale answer check
  @jev_course_check_10 @fr_73
  Scenario: A stale course answer is discarded
    Given a course check is in flight for revision 6
    When the task or revision changes before the answer returns
    Then the answer is discarded as stale
    And it neither approves nor condemns the new revision
    And no current course decision is recorded

  # FR-11, FR-12 superseded by FR-78; implementation src/config.ts ignores courseCheck.*
  @jev_course_check_11 @fr_11 @fr_12
  Scenario: Scheduled course checks are not silently restored
    Given a configuration file contains courseCheck.mode or courseCheck.interval
    When the configuration is loaded
    Then no interval-scheduled or completion-only course check is configured
    And only the callable jev_course_check remains available
    And the obsolete keys change no execution or completion behavior
