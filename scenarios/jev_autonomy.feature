# language: en
# Requirements: PRD FR-57 through FR-66; FR-73, FR-76.
# Contract: docs/autonomy.md. Executable bindings: tests/scenarios/steps/autonomy.ts.
Feature: Supervise an opt-in autonomy run within the owner's authority
  The optional supervisor binds one objective to the roots, effects and limits the owner authorized.
  In a supervised session, jev_autonomy reports or requests run transitions. Jev findings describe
  the work; they cannot change what the executor is allowed to do.

  @jev_autonomy_01 @fr_57
  Scenario: Inherited run locators leave an ordinary OMP session unchanged
    Given an OMP session loaded Jevstice through its ordinary package entry
    And the environment contains both autonomy run and store locators
    When the ordinary executor reads a file or requests delegation
    Then the session neither acquires a strict run nor exposes jev_autonomy
    And the ordinary entry still does not load the strict module
    And the ordinary diagnostic tools remain available without a stop hold

  @jev_autonomy_02 @fr_57
  Scenario: Only an explicit supervisor launch binds the strict child
    Given the owner supplied an objective and policy to the autonomy supervisor
    When the supervisor starts a child with valid run and store locators
    Then the child starts with the explicit strict extension and committed run binding
    And missing or invalid locators are refused without ordinary-mode fallback

  @jev_autonomy_03 @fr_64
  Scenario Outline: A request cannot enlarge the committed "<limit>"
    Given the owner committed a run policy with a fixed "<limit>"
    When the executor or a model message requests an expansion
    Then the original value still governs the run
    And a Jev verdict, prompt text and inherited variables cannot raise that limit
    Examples:
      | limit                   |
      | canonical project roots |
      | project effect class    |
      | publication effect      |
      | maxJudgeCalls           |
      | maxExecutorCalls        |
      | maxRuntimeMs            |
      | maxContextBytes         |
      | maxArtifactBytes        |

  @jev_autonomy_04 @fr_59
  Scenario: A consequential call can start only after its intent is durable
    Given the executor proposed a consequential invocation
    When the supervisor allows the invocation
    Then the ledger commits the exact intent and its required artifact bytes together
    And the invocation cannot start if that commit fails
    And the native journal points to the ledger but cannot authorize an invocation

  @jev_autonomy_05 @fr_61
  Scenario: Two active runs cannot own overlapping writable roots
    Given an active run owns a canonical writable project root
    When a second run claims the same root or an overlapping root
    Then the supervisor refuses the second claim
    And a symlink to the root does not make the claim independent
    And a run on a disjoint root can acquire its own ownership

  @jev_autonomy_06 @fr_73
  Scenario: A negative Jev finding changes neither permission nor progress
    Given a project write is permitted by the committed policy
    When Jev reports the write as off course and outside its assessed authority
    Then the negative assessment is retained as a diagnostic
    And the write can be admitted and settled while jev_autonomy remains able to request rotation
    And the diagnostic grants no authority for an unsupported effect

  @jev_autonomy_07 @fr_58
  Scenario: A diagnostic about older work cannot become current evidence
    Given a diagnostic request is tied to a particular run, revision, policy and set of artifact bytes
    When its binding no longer matches the current work
    Then the ledger marks the answer stale
    And the current decision carries no evidence from that answer
    And the stale answer does not change admission

  @jev_autonomy_08 @fr_65
  Scenario: Operator stop interrupts the executor without asking Jev
    Given the supervised run has an active executor
    When the operator stops the run through the supervisor
    Then the supervisor immediately closes admission and cancels queued wakeups
    And it aborts active work without asking Jev
    And it confirms durable cancellation only after the cancellation is committed
    And if that commit fails, the supervisor still aborts and does not relaunch or claim durability

  @jev_autonomy_09 @fr_65
  Scenario: Cancellation reports containment without promising rollback
    Given the operator stopped a run with observed or possible effects
    When the operator reads the stopped run's status
    Then the report shows the cancellation and what was contained
    And the report makes no claim that an executed effect was undone
    And any effect still unknown must be reconciled

  @jev_autonomy_10 @fr_61
  Scenario: Recovery does not replay an invocation whose result is missing
    Given a durable tool intent has no terminal result on record
    When a replacement executor recovers the run
    Then the pending intent represents an unknown effect rather than a failure
    And jev_autonomy requires observed evidence to reconcile the intent
    And a retry needs observable proof that it is safe or a provider idempotency guarantee
    And an effect that cannot be reconciled keeps the run waiting

  @jev_autonomy_11 @fr_60
  Scenario: A replacement session keeps records but must refresh execution evidence
    Given a checkpoint retains accepted requirements and accepted plan details
    When the run resumes in a replacement session
    Then the replacement sees the committed record and still-current decisions
    And changed dependencies invalidate affected acceptance and completion without discarding unrelated decisions
    And the replacement needs fresh observations to establish execution acceptance
    And neither a fork nor a session summary confers ownership on its own

  @jev_autonomy_12 @fr_62
  Scenario: Exhausting the judge budget does not prevent authorized execution
    Given the run has used all of its judge calls
    When the run reaches a point that would request a diagnostic
    Then the run records the diagnostic as skipped
    And further execution continues to depend on deterministic safety checks
    And retrying an unchanged refused artifact does not turn its finding into an approval

  @jev_autonomy_13 @fr_63
  Scenario: Completion preserves diagnostic gaps instead of claiming all checks passed
    Given the current revision has observed execution and retained code evidence
    When the executor stops with no pending effect to settle
    Then the run can record terminal completion without Jev approval
    And the completion record identifies missing or failed acceptance and review evidence
    And the terminal result is distinct from a successful acceptance or review

  @jev_autonomy_14 @fr_66
  Scenario: Strict execution requires whole-scope containment
    Given Linux systemd, cgroup v2 or whole-scope fencing is missing
    When the owner requests a strict supervisor launch
    Then the owner sees a refusal or wait that identifies the missing capability
    And the supervisor does not fall back to process-group signalling
    And it does not start execution under weaker guarantees

  @jev_autonomy_15 @fr_64
  Scenario: Supervisor status reports run facts without exposing the objective
    Given a strict run has a waiting intent and a recorded diagnostic finding
    When the owner reads status through the supervisor
    Then the report shows the committed run identifier, state, usage counts and pending intents
    And the report omits the objective and stored secrets
    And reading the report does not alter ownership, intents or effects

  @jev_autonomy_16 @fr_58
  Scenario: Reading context or checking course creates no project effect
    Given a bound run has an approved plan
    When the executor uses jev_context or jev_course_check
    Then the tool call is handled as a diagnostic
    And neither tool creates an intent for a project effect
    And its result is tied to the active run and work revision

  @jev_autonomy_17 @fr_63
  Scenario: Publication authority and reviewed bytes are recorded separately
    Given the owner's committed policy allows publication
    And a current review covers the exact artifact bytes
    When the executor submits those bytes in a publication invocation
    Then the runtime admits the invocation under the committed policy
    And the committed publication payload matches the reviewed bytes
    And the Jev finding is retained as evidence rather than used as permission to publish

  @jev_autonomy_18 @fr_76
  Scenario: Approval-like text cannot change supervisor control
    Given the run has a recorded finding
    When a message looks like an owner approval or contains /jev-continue
    Then the message grants no continuation, waiver or repair authority
    And the supervisor accepts operator stop through its separate control channel
    And the finding stays in the record as a diagnostic

  @jev_autonomy_19 @fr_62
  Scenario: A running background job is still pending at the end of a turn
    Given a committed invocation returned a native receipt saying its background job is running
    When the executor ends its turn before the job reports a terminal result
    Then the run waits for the pending background effect
    And the launch receipt does not count as a terminal result
    And the run cannot commit completion before observing the outcome
    And jev_autonomy status reports the pending intent without settling it

  @jev_autonomy_20 @fr_65
  Scenario: Rotation replaces a fenced executor without completing the run
    Given the active run has requested a new executor session
    When the supervisor processes the rotation request
    Then the run still has no terminal completion record
    And the supervisor fences the old executor's entire scope before launching the replacement
    And the replacement launch requires a separate committed lifecycle decision

  @jev_autonomy_21
  Scenario: An evidenced infeasibility declaration ends the run without independent verification
    Given a bound run has no pending intent and Jev is unavailable
    When the executor calls jev_autonomy infeasible first without evidence and then with an observed blocker
    Then the unsupported declaration is refused
    And the evidenced declaration records terminal infeasibility as executor-declared and unverified
    And the declaration neither requests a Jev judgment nor counts as successful completion
