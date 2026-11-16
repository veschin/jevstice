# language: en
# Requirements: PRD FR-45 through FR-56; FR-54/FR-55 waiver/enforcement clauses superseded; FR-73, FR-78.
# Source contract: src/guidance.ts ANTI_SLOP_DESCRIPTION; src/jev-skill.md section 8.
# Normative business specification only; no step definitions or executable runner exist here.
# The shipped mode is advisory: findings are reported and never authorize or block ordinary work.
Feature: External-artifact integrity review reports findings without delivery authority
  The review checks submitted claims, inferences, language and register against submitted
  evidence and owner rules. It does not authenticate sources, translate, rewrite or approve
  publication, and its findings never become execution or completion permission.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-45, FR-46; implementation src/activities.ts antiSlopScope
  @jev_anti_slop_01 @fr_45
  Scenario: Review only an external deliverable
    Given a document intended for an audience outside the project
    When the executor submits the exact artifact and its required declarations
    Then the review runs for that external deliverable
    And an internal code change or internal note is refused as out of scope

  # FR-45; implementation src/activities.ts triage external classification
  @jev_anti_slop_02 @fr_45
  Scenario: An uncertain external classification stays in review scope
    Given triage's external answer is below the confidence floor
    When the task is registered
    Then the deliverable is not silently classified as internal
    And explicit review remains available
    And no publication is authorized by the classification

  # FR-55, FR-78; implementation src/activities.ts mode off prerequisite
  @jev_anti_slop_03 @fr_55
  Scenario: Anti-slop off refuses without a judge call
    Given anti-slop mode is off in configuration
    When the executor submits an external artifact
    Then the result names the configuration prerequisite
    And no judge request is made
    And no trusted mark or finding is invented

  # FR-55; implementation src/activities.ts antiSlop advisory result
  @jev_anti_slop_04 @fr_55
  Scenario: Advisory findings do not hold ordinary work or completion
    Given an external artifact review records a blocker finding in advisory mode
    When the executor continues work and ends the session
    Then neither action is blocked by the finding
    And the result lists the finding for the executor to disclose to the owner
    And it is never reported as Jev delivery approval

  # FR-46; implementation src/activities.ts readAntiSlop validation
  @jev_anti_slop_05 @fr_46
  Scenario Outline: Required review material is validated before judging
    Given the submission omits or invalidates "<defect>"
    When the review is validated
    Then no judge request is made
    And the result names the invalid field
    And the artifact is not partially reviewed
    Examples:
      | defect                                      |
      | artifact text                               |
      | language                                    |
      | register                                    |
      | purpose                                     |
      | audience                                    |
      | owner-supplied rules                        |
      | at least one claim or inference             |
      | a claim that does not occur in the artifact |
      | unknown source class                        |

  # FR-47, FR-48; implementation src/activities.ts claim results
  @jev_anti_slop_06 @fr_47
  Scenario: Claim evidence determines the trust mark
    Given a factual claim quotes evidence that supports it at the floor
    And the evidence source class is reputable_secondary or stronger
    When the claim is judged
    Then the claim is marked trusted with the supporting verdict
    And a refuted claim at the floor is a blocker contradicted_claim
    And a claim the judge cannot settle is unverified, never trusted

  # FR-47, FR-48; implementation src/activities.ts evidence filter and unsupported branch
  @jev_anti_slop_07 @fr_47
  Scenario Outline: Unsupported claims need no separate judge call
    Given a claim has "<problem>"
    When the review runs
    Then the claim is marked distrusted and unsupported
    And a blocker unsupported_claim finding is recorded
    And the executor's own assertion is not counted as evidence
    Examples:
      | problem                               |
      | no evidence items                     |
      | only an evidence quote identical to the claim |

  # FR-48; implementation src/activities.ts accepted source classes
  @jev_anti_slop_08 @fr_48
  Scenario: Weak sources cannot produce a trusted mark
    Given a claim is supported at the floor by an anonymous source
    When the trust mark is assigned
    Then the claim is low_trust rather than trusted
    And a warning low_trust_source finding is recorded
    And the supporting evidence remains listed

  # FR-49; implementation src/activities.ts inference results
  @jev_anti_slop_09 @fr_49
  Scenario: Conclusions are checked against submitted premises and warrant
    Given an inference quotes its premises from the artifact and states a warrant
    When the judge answers that the conclusion does not follow at the floor
    Then the inference is distrusted
    And a blocker invalid_inference finding is recorded
    And no unsubmitted premise or warrant is added

  # FR-50; implementation src/activities.ts falsifier logic
  @jev_anti_slop_10 @fr_50
  Scenario Outline: A hypothesis needs an observable falsifier
    Given a hypothesis claim has "<falsifier>"
    When the review judges falsifiability
    Then the claim is "<trust>"
    And the result is "<finding>"
    Examples:
      | falsifier                          | trust      | finding                    |
      | no submitted falsifier             | distrusted | unfalsifiable_hypothesis   |
      | a falsifier rejected at the floor  | distrusted | unfalsifiable_hypothesis   |
      | an accepted observable falsifier   | judged by claim evidence | none for falsifiability |

  # FR-51, FR-52; implementation src/activities.ts fragment findings
  @jev_anti_slop_11 @fr_51 @fr_52
  Scenario: Fragments are checked for language, register, meta-text and relevance
    Given a large artifact is split into bounded fragments
    When the review runs
    Then a fragment outside the declared language is a blocker language_mismatch
    And a violated rule quotes the submitted rule line and uses its declared severity
    And meta-text is a blocker meta_text while repetition or off-topic material is a warning
    And functional cross-references in operative content are not treated as meta-text

  # FR-56; implementation src/activities.ts bounds and part handling
  @jev_anti_slop_12 @fr_56
  Scenario: Bounds and parts fail closed rather than truncating
    Given an artifact, rule set, claim set or question batch exceeds its configured bound
    When the review is submitted
    Then it is refused before any judge call
    And no prefix is reviewed as though it were the whole artifact
    And a multi-part artifact is complete only when every declared part at the current content is reviewed

  # FR-53; implementation src/activities.ts finding identity
  @jev_anti_slop_13 @fr_53
  Scenario: Findings carry stable identity and binding
    Given a review records a finding
    When the same artifact, language, register and rules are reviewed again
    Then the finding id is stable
    And a changed artifact, language or rule set invalidates the earlier review
    And a review cannot approve a different task or work revision

  # FR-56, FR-73; implementation src/activities.ts uncertain and judgeFailure
  @jev_anti_slop_14 @fr_56
  Scenario: Unavailable or below-floor reviews leave items unverified
    Given the judge is unavailable or an answer falls below the anti-slop floor
    When the review result is returned
    Then no review part is recorded as complete
    And affected claims and inferences remain unverified
    And no trusted mark is manufactured
    And ordinary work and completion are not held

  # FR-53, FR-73; implementation src/activities.ts review freshness
  @jev_anti_slop_15 @fr_53
  Scenario: A changed review part supersedes only the affected part
    Given a multi-part review has an accepted part at revision 4
    When one part is submitted again with changed artifact bytes
    Then the changed part replaces its earlier review record
    And unrelated parts remain recorded
    And the changed part cannot inherit the earlier content's findings

  # FR-54, FR-76; GAP: residual /jev-waive text remains in results; no command is registered.
  @gap_fr_54 @jev_anti_slop_16 @fr_54
  Scenario: Findings are disclosed without a waiver or delivery command
    Given the review records a blocker finding
    When the executor reports it
    Then the finding remains a diagnostic record
    And no /jev-waive, repair permit or finding-resolution command is available
    And no result asks the owner to waive the finding before work continues
    And owner acknowledgement, if any, does not become Jev approval

  # FR-63, FR-73; implementation autonomy/runtime delivery, activities actionCheck
  @jev_anti_slop_17 @fr_63
  Scenario: Strict delivery keeps deterministic authority over reviewed bytes
    Given a strict run is authorized for a publication effect
    And the exact artifact bytes have a current review
    When a delivery invocation is admitted
    Then the supervisor's policy and containment decide admission
    And the delivered bytes must match the reviewed bytes
    And Jev findings remain diagnostic evidence rather than a delivery permission
