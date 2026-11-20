# language: en
# Requirements: PRD FR-14, FR-15, FR-26, FR-39, FR-43; FR-73, FR-74.
# Source contract: src/guidance.ts ACCEPTANCE_DESCRIPTION; src/jev-skill.md section 8.
# Executable: tests/scenarios/steps/acceptance.ts; run by tests/scenarios/run.test.ts.
Feature: Business and architecture acceptance rest on observed evidence
  Each aspect is submitted and recorded separately at the current revision.
  Acceptance is diagnostic evidence for the owner; it neither authorizes execution
  nor holds ordinary completion, and a failed aspect is corrected with new evidence.

  Background:
    Given a development task is registered at the current work revision
    And ordinary Jev diagnostics are enabled

  # FR-14, FR-15; implementation src/activities.ts acceptance
  @jev_acceptance_01 @fr_14 @fr_15
  Scenario: Business and architecture are independent records
    Given the executor submits business acceptance with execution and code evidence
    When that aspect passes at its floor
    Then business acceptance is recorded for the current revision
    And architecture acceptance remains a separate missing record
    And the result names the missing aspect without manufacturing it

  # FR-14; implementation src/activities.ts aspect replacement
  @jev_acceptance_02 @fr_14
  Scenario: Recording one aspect replaces only its own earlier verdict
    Given both aspects were accepted at revision 5
    When business is submitted again at revision 5 and changes its verdict
    Then the business record is replaced
    And the architecture record at revision 5 is unchanged

  # FR-26; implementation src/activities.ts evidence kinds preflight
  @jev_acceptance_03 @fr_26
  Scenario Outline: Acceptance requires execution and code evidence before judging
    Given an acceptance submission carries "<evidence>"
    When the tool validates it
    Then no judge request is made
    And the result names the missing evidence class
    And no acceptance is recorded
    Examples:
      | evidence                       |
      | only a claim                   |
      | only code quotes               |
      | only execution quotes          |
      | nothing                        |

  # FR-26; implementation src/activities.ts readEvidence
  @jev_acceptance_04 @fr_26
  Scenario: The executor's claim is not evidence for itself
    Given the claim asserts that a feature works
    When the submission carries that claim text and no execution or code item
    Then it is refused before judgment
    And the result states that a claim about the work is not observation of the work

  # FR-26; implementation src/activities.ts evidence-basis questions; the command/output check is judged, not text-parsed
  @jev_acceptance_05 @fr_26
  Scenario: Execution evidence carries a command and its observed output
    Given an acceptance submission includes an execution item
    When that item is validated
    Then the item contains the command that ran and its observed output
    And a bare proposed command without output does not satisfy execution evidence
    And a mislabeled command-only quote does not reach judgment

  # FR-26; implementation src/activities.ts topic_i_execution and topic_i_code answers; the evidence id is returned
  @jev_acceptance_06 @fr_26
  Scenario: Every plan topic names the evidence it rests on
    Given the approved plan has three topics
    When acceptance is judged
    Then each topic receives its own verdict
    And each passed topic identifies the submitted evidence that establishes it
    And a topic without supporting evidence is not reported as met

  # FR-26, FR-74; implementation src/activities.ts approving and unmet branches
  @jev_acceptance_07 @fr_26
  Scenario: One unmet topic prevents whole-aspect acceptance
    Given the aspect-level answer approves the claim
    When at least one plan topic remains below its floor
    Then the aspect is not accepted
    And the result lists the unmet topic ids and requirements
    And the evidence gap is named as the next correction

  # FR-20; implementation src/activities.ts below-floor and defect labels
  @jev_acceptance_08 @fr_20
  Scenario Outline: Uncertainty and established gaps are distinguishable
    Given the judge returns "<answer>"
    When the acceptance result is recorded
    Then the class is "<class>"
    And the work is not described more strongly than the answer supports
    Examples:
      | answer                                        | class       |
      | the approving label below the confidence floor| inconclusive|
      | the unsupported label at any confidence       | inconclusive|
      | a business_gap label at the floor             | defect      |
      | an architecture_defect label at the floor     | defect      |

  # FR-36, FR-37; implementation src/state.ts recordAcceptance, recordAction
  @jev_acceptance_09 @fr_36
  Scenario: A later work change invalidates earlier acceptance
    Given both aspects were accepted at revision 4
    When a consequential implementation action advances the work to revision 5
    Then neither earlier acceptance counts for revision 5
    And fresh execution and code evidence are required for a new acceptance
    And a plan revision also invalidates the previous acceptance

  # FR-73; implementation src/controller.ts tool boundary
  @jev_acceptance_10 @fr_73
  Scenario: Acceptance is not an execution or completion permission
    Given an acceptance judgment is refused
    When the executor continues implementation and ends the session
    Then neither action is blocked by the refusal
    And completion is not presented as accepted work
    And the refusal remains disclosed as a diagnostic

  # FR-73; implementation src/activities.ts review, courseCheck
  @jev_acceptance_11 @fr_73
  Scenario: Other checks never substitute for acceptance
    Given a developer review passed and a course check reported on course
    When the executor relies on them as acceptance
    Then business and architecture acceptance remain missing
    And neither check is reported as approval of the delivered outcome

  # FR-39; implementation src/controller.ts diagnoseCompletion
  @jev_acceptance_12 @fr_39
  Scenario: Completion reviews each plan task against observed work
    Given a developed task reaches completion with a registered plan
    When the ordinary completion boundary is observed
    Then the addon collects observed code and execution evidence
    And it checks each plan task automatically
    And it names the missing verification without requiring manual acceptance calls

  # FR-43; implementation src/activities.ts unmetSections
  @jev_acceptance_13 @fr_43
  Scenario: Missing evidence returns the unmet requirement and its verification section
    Given acceptance evidence is missing or unsuitable for one requirement
    When the result is returned
    Then it names the unmet requirement
    And it names that requirement's approved verification section
    And it directs the executor to observe that behavior before changing implementation
    And only an established defect directs an implementation repair

  # FR-73, FR-74; implementation src/activities.ts stale path
  @jev_acceptance_14 @fr_73
  Scenario: A changed task or plan discards an in-flight acceptance answer
    Given an acceptance judgment is in flight
    When the task, revision or approved plan changes before the answer returns
    Then the answer is discarded as stale
    And it is not recorded as acceptance or as a defect
    And the current revision remains without that acceptance

  # FR-73, FR-75; implementation src/controller.ts pending-effect acceptance prerequisite
  @jev_acceptance_15 @fr_73
  Scenario: Acceptance is not judged while a background effect is unobserved
    Given an asynchronous project effect has been launched and not yet settled
    When the executor submits acceptance
    Then the result names unobserved background effects as the prerequisite
    And no acceptance judgment is made and no finding is recorded
    And ordinary work and completion continue
