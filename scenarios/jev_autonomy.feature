# language: en
# Requirements: PRD FR-57 through FR-66; FR-73, FR-76.
# Source contract: docs/autonomy.md; AGENTS.md optional strict module.
# Executable: tests/scenarios/steps/autonomy.ts; run by tests/scenarios/run.test.ts.
# The strict module is optional, Linux/systemd-specific and not loaded by the package manifest.
# Open real-host strict acceptance is recorded in HANDOFF.md, not by a pending scenario tag.
Feature: Optional strict supervision preserves owner safety limits
  The owner authorizes one objective and an envelope once. The supervisor enforces roots,
  effect classes, resource limits, ownership and containment deterministically. Jev reviews
  are diagnostic evidence in this mode too; they neither add nor remove authority.

  # FR-57, FR-66; implementation src/index.ts, autonomy/index.ts
  @jev_autonomy_01 @fr_57
  Scenario: Ordinary sessions never activate strict authority
    Given an ordinary OMP session loads the package manifest
    And inherited autonomy store or run variables are present
    When the executor calls an ordinary or strict tool
    Then no strict run ownership or execution authority is created
    And the strict module is not imported by the ordinary entry
    And ordinary diagnostics follow the ordinary contract

  # FR-57, FR-66; implementation autonomy/index.ts, autonomy/driver.ts
  @jev_autonomy_02 @fr_57
  Scenario: Strict execution starts only through its explicit supervisor
    Given the owner runs the autonomy supervisor with an objective and policy
    When both run and store locators are valid
    Then the supervised child loads the strict entry explicitly
    And missing or invalid locators refuse the run rather than falling back

  # FR-64; implementation autonomy/driver.ts parseAutonomyPolicy
  @jev_autonomy_03 @fr_64
  Scenario Outline: The authorized envelope is frozen and non-expandable
    Given a committed run policy sets "<limit>"
    When the executor or a model message asks for more
    Then the committed value remains the limit
    And no Jev verdict, prompt text or inherited environment expands it
    Examples:
      | limit                  |
      | canonical project roots|
      | project effect class   |
      | publication effect     |
      | maxJudgeCalls          |
      | maxExecutorCalls       |
      | maxRuntimeMs           |
      | maxContextBytes        |
      | maxArtifactBytes       |

  # FR-59; implementation autonomy/store.ts, autonomy/runtime.ts
  @jev_autonomy_04 @fr_59
  Scenario: No side effect starts before its durable intent
    Given a consequential strict invocation is proposed
    When the supervisor admits it
    Then the exact intent and required artifact bytes are committed atomically
    And a failed commit means no effect starts
    And native journal entries reference the ledger rather than grant permission

  # FR-61; implementation autonomy/store.ts ownership epochs
  @jev_autonomy_05 @fr_61
  Scenario: Overlapping writable roots have one owner
    Given one nonterminal run owns a canonical writable root
    When another run requests the same or an overlapping root
    Then the second run is refused
    And a symlink alias does not bypass the conflict
    And disjoint roots may proceed independently

  # FR-57, FR-73; implementation autonomy/runtime.ts diagnostic binding
  @jev_autonomy_06 @fr_73
  Scenario: Jev verdicts do not decide strict admission
    Given a strict invocation is deterministically safe within the envelope
    When its Jev diagnostic is negative, unavailable or below the floor
    Then the result remains recorded as that diagnostic
    And it does not by itself block admission, reconciliation, rotation or completion
    And it does not authorize an effect either

  # FR-58, FR-73; implementation autonomy/runtime.ts stale checks
  @jev_autonomy_07 @fr_58
  Scenario: A stale diagnostic cannot describe current strict work
    Given a diagnostic is bound to an earlier run, revision, policy or artifact bytes
    When the current work differs
    Then the answer is recorded as stale
    And it is not attached as evidence for the current decision
    And it changes no admission state

  # FR-65; implementation autonomy/driver.ts stopAutonomy, scope fencing
  @jev_autonomy_08 @fr_65
  Scenario: Operator stop closes admission without waiting for Jev
    Given a strict run is active
    When the operator sends stop through the supervisor
    Then admission closes immediately and queued wakeups are cancelled
    And active work is aborted without a Jev call
    And cancellation is acknowledged as durable only after its commit
    And a failed commit still stops work and suppresses relaunch without claiming durability

  # FR-65; implementation autonomy/driver.ts fencing
  @jev_autonomy_09 @fr_65
  Scenario: Stopping is not a rollback claim
    Given a stopped run has observed or possible effects
    When the operator inspects the run
    Then the status reports cancellation and containment facts
    And it does not claim that executed effects were rolled back
    And unknown effects still require reconciliation

  # FR-61; implementation autonomy/runtime.ts reconcile
  @jev_autonomy_10 @fr_61
  Scenario: An intent without a result is unknown, not failed
    Given a committed invocation has no recorded terminal result
    When the run is recovered
    Then the intent is treated as unknown
    And observable state is inspected before any retry
    And a retry occurs only when observed state or provider idempotency proves it safe
    And an irreconcilable effect remains a deterministic safety wait

  # FR-60, FR-62; implementation autonomy/store.ts sessions, runtime restore
  @jev_autonomy_11 @fr_60
  Scenario: Restart restores records but not stale permission
    Given a run was checkpointed with accepted requirements and plan details
    When a replacement session resumes the run
    Then the committed record and unchanged decisions are restored
    And changed dependencies invalidate only the affected acceptance and completion
    And prior execution acceptance requires fresh observation
    And a fork or summary does not independently inherit ownership

  # FR-62; implementation autonomy/store.ts decisions, driver retry
  @jev_autonomy_12 @fr_62
  Scenario: Diagnostic retry budgets skip judgment only
    Given the judge budget or retry deadline is exhausted
    When a strict lifecycle diagnostic is due
    Then that diagnostic request is skipped and recorded as such
    And actual executive progress follows deterministic safety facts
    And an unchanged refused artifact does not become approved by repetition

  # FR-63; implementation autonomy/runtime.ts completion
  @jev_autonomy_13 @fr_63
  Scenario: Strict completion records evidence and discloses gaps
    Given observed execution and captured code evidence for the current revision
    When the run reaches a terminal stop
    Then the run can commit completion without a Jev approval
    And missing or failed acceptance and review evidence is recorded
    And terminal completion is not presented as a claim that those checks passed

  # FR-66; implementation autonomy/scope.ts capability check
  @jev_autonomy_14 @fr_66
  Scenario: Missing containment capability refuses strict execution
    Given Linux systemd, cgroup v2 or whole-scope fencing is unavailable
    When the owner starts a strict run
    Then the run is refused or held with the missing capability named
    And process-group signalling is not used as a containment substitute
    And no strict guarantee is silently downgraded

  # FR-64; implementation autonomy/driver.ts statusAutonomy
  @jev_autonomy_15 @fr_64
  Scenario: Status reports committed facts without granting permission
    Given a bound strict run with a pending intent and a recorded finding
    When the owner requests autonomy status
    Then the report names the run, status, budget and pending-effect facts that are stored
    And it does not print the objective or stored secrets
    And the act of reading status changes no ownership, intent or effect

  # FR-58, FR-73; implementation autonomy/runtime.ts safe devices
  @jev_autonomy_16 @fr_58
  Scenario: Context and course diagnostics remain callable in a strict run
    Given a bound strict run with an approved plan
    When the executor calls jev_context or jev_course_check
    Then the call is treated as a safe diagnostic device
    And it does not create a project effect
    And its answer is bound to the current run and revision

  # FR-63, FR-73; implementation autonomy/runtime.ts reviewed delivery
  @jev_autonomy_17 @fr_63
  Scenario: Publication uses only authorized, reviewed bytes
    Given the committed policy authorizes the publication effect class
    And the exact artifact bytes have a current review
    When the run delivers the artifact
    Then the deterministic policy admits the effect
    And delivered content matches the reviewed bytes
    And a Jev finding is recorded as evidence, not as delivery permission

  # FR-76; implementation autonomy/index.ts no recovery mode
  @jev_autonomy_18 @fr_76
  Scenario: Strict mode has no continuation or waiver escape hatch
    Given a strict run has a diagnostic finding
    When an owner-like approval message or /jev-continue text appears
    Then it creates no continuation, waiver or repair authority
    And only the operator stop channel changes run control
    And the finding remains diagnostic evidence

  # FR-62; implementation autonomy/runtime.ts pending effect observation (repair in progress)
  @jev_autonomy_19 @fr_62
  Scenario: A known-running asynchronous effect keeps the strict run uncompleted
    Given a committed strict intent has a native background job known to be running
    When the run evaluates completion or rotation
    Then the run remains in a waiting state for that effect
    And the launch receipt is not recorded as a completed effect
    And terminal completion is not committed before observation

  # FR-65; implementation autonomy/driver.ts rotation handling (repair in progress)
  @jev_autonomy_20 @fr_65
  Scenario: A rotation request is not a completed run
    Given a strict run requests session rotation
    When the supervisor records the lifecycle transition
    Then the run is not marked completed by the rotation request
    And the current scope is fenced before any replacement launch
    And a replacement requires its own committed decision
