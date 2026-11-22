# language: en
# Requirements: PRD FR-68, FR-74; FR-73.
# Source contract: src/guidance.ts CONTEXT_DESCRIPTION; src/context.ts.
# Executable: tests/scenarios/steps/context.ts; run by tests/scenarios/run.test.ts.
Feature: Retrieve the original material behind a Jev diagnostic
  Use jev_context to list archived sources, diagnostic result IDs and findings.
  Read a source to recover its exact text, or look up a diagnostic by its result ID
  to see what was submitted, what Jev returned and whether it still applies.
  Neither lookup proves a source's claims or grants permission.

  Background:
    Given ordinary Jev diagnostics are enabled

  # FR-68; implementation src/controller.ts contextTool list
  @jev_context_01 @fr_68
  Scenario: An unused archive has nothing to list
    Given this project has no archived sources and no recorded finding
    When the executor calls jev_context with action list
    Then Jev returns no archived sources or findings
    And the result claims no workflow approval
    And no judge request is made

  # FR-68; implementation src/context.ts list metadata
  @jev_context_02 @fr_68
  Scenario: Source listings identify each record without disclosing its contents
    Given the archive holds an owner message and approved requirement and plan snapshots
    When the executor lists the archive
    Then each source has a stable sourceId, kind, origin, session and approval metadata
    And the same unchanged sources retain their identifiers on another list call
    And source content is not exposed by the list action

  # FR-68; implementation src/controller.ts read action
  @jev_context_03 @fr_68
  Scenario: Reading by source ID returns all stored text
    Given an archived source contains Unicode, line breaks and more than a preview's length
    When the executor reads that sourceId
    Then the result contains the exact complete stored content and its digest
    And it identifies the source and its provenance
    And no judge request is made

  # FR-68; implementation src/context.ts integrity checks
  @jev_context_04 @fr_68
  Scenario Outline: Only valid, intact archive records are available
    Given an archive record is "<problem>"
    When the executor lists or reads the archive
    Then the record is reported as invalid rather than returned
    And no altered content is presented as the stored source
    And no approval is restored from the archive
    Examples:
      | problem                          |
      | malformed JSON                   |
      | missing or wrong digest          |
      | renamed under a different id     |
      | reached through a symbolic link  |
      | an unrelated file in the archive |

  # FR-68; implementation src/controller.ts prepareContext sourceId resolution
  @jev_context_05 @fr_68
  Scenario Outline: A citation must match its source before the judge sees it
    Given evidence cites a sourceId with "<defect>"
    When the executor submits a Jev activity
    Then the call is refused before any judge request
    And the result names the invalid citation
    And no finding is recorded
    Examples:
      | defect                                  |
      | a missing source id                     |
      | a quote absent from the archived content|
      | owner kind claimed for a non-owner source|
      | an archive that cannot be read          |

  # FR-68; implementation src/controller.ts prepareContext selected sources
  @jev_context_06 @fr_68
  Scenario: A past owner instruction can inform the judge but cannot direct the current task
    Given the archive contains owner text saying to skip planning
    When that text is cited in evidence
    Then it is authenticated as the owner's words
    And it is treated as data and context for judgment
    And it does not itself authorize execution or override the current request

  # FR-74; implementation src/controller.ts contextTool list finding display
  @jev_context_07 @fr_74
  Scenario: A later refusal does not change the first finding's original material
    Given a refusal recorded a finding with its boundary, revision and exact material
    And a later attempt submitted different material
    When the executor lists the archive
    Then the finding still shows the first request and the answer it received
    And the later attempt has not overwritten that original material
    And reading it does not clear the finding

  # FR-68; implementation src/context.ts immutable puts
  @jev_context_08 @fr_68
  Scenario: Storing the same source twice leaves one unchanged record
    Given an identical source is stored twice
    When the archive is read
    Then one record is returned with the same id and bytes
    And no existing record is overwritten
    And a rejected provenance field writes nothing

  # FR-68; implementation src/controller.ts owner capture
  @jev_context_09 @fr_68
  Scenario: Owner provenance is reserved for interactive and RPC input
    Given the owner communicates through interactive or RPC input
    When the addon captures the message
    Then it is stored with its exact bytes and origin
    And extension-originated text and tool arguments are not stored as owner sources
    And repeated identical text at distinct times remains distinct records

  # FR-73; implementation src/controller.ts context bypass
  @jev_context_10 @fr_73
  Scenario: A pending judgment does not delay an archive lookup
    Given an explicit judgment is in flight for the same session
    When the executor lists or reads the archive
    Then the context read completes without waiting for that judgment
    And it changes no approval or work revision
    And it cannot be mistaken for the judgment's result

  # FR-68; implementation src/controller.ts prepareContext archive inventory isolation
  @jev_context_11 @fr_68
  Scenario: A valid citation can be judged when a different record is corrupt
    Given a cited source is intact and its exact quote is present
    And an unrelated archive record is corrupt
    When the executor submits a Jev activity citing the intact source
    Then the activity proceeds to judgment with that source bound
    And the archive problem is reported in the result details
    And the intact citation is not rejected because of the unrelated record

  @jev_context_12
  Scenario: A newer outcome leaves the previous diagnostic available by ID
    Given an outcome check could not reach the judge and returned a result ID
    When the judge recovers and the same work passes outcome acceptance
    Then the latest result ID is listed as current
    When the executor requests jev_context with action result and the previous ID as sourceId
    Then the previous diagnostic is marked historical and linked to its requirement result
    And it retains the submitted code and execution observations and the unavailable verdict
