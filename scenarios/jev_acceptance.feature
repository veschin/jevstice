# language: en
# Requirements: PRD FR-14, FR-15, FR-26, FR-39, FR-43; FR-73, FR-74.
# Source contract: src/guidance.ts ACCEPTANCE_DESCRIPTION; src/jev-skill.md section 8.
# Executable: tests/scenarios/steps/acceptance.ts; run by tests/scenarios/run.test.ts.
Feature: Check the delivered outcome against observed work
  For ordinary project work, request jev_acceptance with aspect outcome. Jev reads
  the recorded code changes and execution rather than asking for a claim. With a
  registered plan it checks each task before reviewing the integrated change.
  Optional business and architecture submissions keep separate records for the
  current revision. None of these diagnostics stops ordinary work or completion.

  Background:
    Given a development task is registered at the current work revision
    And ordinary Jev diagnostics are enabled

  # FR-14, FR-15; implementation src/activities.ts acceptance
  @jev_acceptance_01 @fr_14 @fr_15
  Scenario: Business evidence does not establish an architecture verdict
    Given the executor submits business acceptance with execution and code evidence
    When that aspect passes at its floor
    Then business acceptance is recorded for the current revision
    And architecture acceptance remains a separate missing record
    And the result names the missing aspect without manufacturing it

  # FR-14; implementation src/activities.ts aspect replacement
  @jev_acceptance_02 @fr_14
  Scenario: Revisiting business acceptance does not replace the architecture result
    Given both aspects were accepted at revision 5
    When business is submitted again at revision 5 and changes its verdict
    Then the new business verdict replaces the earlier business verdict
    And the architecture record at revision 5 is unchanged

  # FR-26; implementation src/activities.ts evidence kinds preflight
  @jev_acceptance_03 @fr_26
  Scenario Outline: The judge needs quotes from execution and changed code
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
  Scenario: Saying that a feature works does not verify it
    Given the claim asserts that a feature works
    When the submission carries that claim text and no execution or code item
    Then it is refused before judgment
    And the result states that a claim about the work is not observation of the work

  # FR-26; implementation src/activities.ts evidence-basis questions; the command/output check is judged, not text-parsed
  @jev_acceptance_05 @fr_26
  Scenario: A test command alone does not show that it ran
    Given an acceptance submission includes an execution item
    When that item is validated
    Then the item contains the command that ran and its observed output
    And a bare proposed command without output does not satisfy execution evidence
    And a mislabeled command-only quote does not reach judgment

  # FR-26; implementation src/activities.ts topic_i_execution and topic_i_code answers; the evidence id is returned
  @jev_acceptance_06 @fr_26
  Scenario: Each of three planned behaviors gets its own evidence basis
    Given the approved plan has three topics
    When acceptance is judged
    Then Jev reports a separate verdict for each topic
    And each passed topic identifies the submitted evidence that establishes it
    And a topic without supporting evidence is not reported as met

  # FR-26, FR-74; implementation src/activities.ts approving and unmet branches
  @jev_acceptance_07 @fr_26
  Scenario: A favorable overall answer cannot make up for a missing topic
    Given the aspect-level answer approves the claim
    When at least one plan topic remains below its floor
    Then the aspect is not accepted
    And the result lists the unmet topic ids and requirements
    And the evidence gap is named as the next correction

  # FR-20; implementation src/activities.ts below-floor and defect labels
  @jev_acceptance_08 @fr_20
  Scenario Outline: An uncertain answer is not a confirmed defect
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
  Scenario: A verdict from revision 4 does not apply to revision 5
    Given both aspects were accepted at revision 4
    When a consequential implementation action advances the work to revision 5
    Then neither earlier acceptance counts for revision 5
    And fresh execution and code evidence are required for a new acceptance
    And a plan revision also invalidates the previous acceptance

  # FR-73; implementation src/controller.ts tool boundary
  @jev_acceptance_10 @fr_73
  Scenario: A refusal remains visible but cannot stop ordinary work
    Given an acceptance judgment is refused
    When the executor continues implementation and ends the session
    Then neither action is blocked by the refusal
    And completion is not presented as accepted work
    And the refusal remains disclosed as a diagnostic

  # FR-73; implementation src/activities.ts review, courseCheck
  @jev_acceptance_11 @fr_73
  Scenario: A sound code review and an on-course check do not verify delivery
    Given a developer review passed and a course check reported on course
    When the executor relies on them as acceptance
    Then business and architecture acceptance remain missing
    And neither check is reported as approval of the delivered outcome

  # FR-39; implementation src/controller.ts diagnoseCompletion
  @jev_acceptance_12 @fr_39
  Scenario: Ordinary completion checks the registered plan without a manual call
    Given a developed task reaches completion with a registered plan
    When the ordinary completion boundary is observed
    Then the addon collects observed code and execution evidence
    And it checks each plan task automatically
    And it names the missing verification without requiring manual acceptance calls

  # FR-43; implementation src/activities.ts unmetSections
  @jev_acceptance_13 @fr_43
  Scenario: A missing observation points back to the plan's verification instructions
    Given acceptance evidence is missing or unsuitable for one requirement
    When the result is returned
    Then the result identifies the requirement not yet demonstrated
    And it names that requirement's approved verification section
    And it directs the executor to observe that behavior before changing implementation
    And only an established defect directs an implementation repair

  # FR-73, FR-74; implementation src/activities.ts stale path
  @jev_acceptance_14 @fr_73
  Scenario: An answer belongs to the task and revision that were submitted
    Given an acceptance judgment is in flight
    When the task, revision or approved plan changes before the answer returns
    Then the answer is discarded as stale
    And it is not recorded as acceptance or as a defect
    And the current revision remains without that acceptance

  # FR-73, FR-75; implementation src/controller.ts pending-effect acceptance prerequisite
  @jev_acceptance_15 @fr_73
  Scenario: A still-running background effect leaves acceptance unchecked
    Given an asynchronous project effect has been launched and not yet settled
    When the executor submits acceptance
    Then the result names unobserved background effects as the prerequisite
    And no acceptance judgment is made and no finding is recorded
    And ordinary work and completion continue

  @jev_acceptance_16
  Scenario: Outcome checks recorded verification after it finishes and reuses the result
    Given recorded code changes and a running verification for an approved requirement
    When the executor checks outcome acceptance without a claim or quotes
    Then Jev reports the pending verification without judging the outcome
    When the verification finishes and the executor checks again
    Then the outcome passes and cites the recorded code and completed test output
    And repeating the check on unchanged work returns the verdict without another judgment
    When the executor edits the code and checks again without rerunning verification
    Then Jev asks for execution evidence and does not reuse the previous verdict

  @jev_acceptance_17
  Scenario: Passing the plan task lets Jev check the assembled result separately
    Given a registered plan with an observed result for its task
    When the executor checks outcome acceptance without a claim or quotes
    Then the plan task passes with the recorded test output as its basis
    And Jev runs an integrated review and reports its own evidence and verdict
