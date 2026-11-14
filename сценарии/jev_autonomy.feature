# language: en
Feature: Evidence-bound strict autonomous lifecycle
  The strict run advances on current usable decisions within its frozen owner envelope.
  These normative acceptance scenarios precede the implementation audit and are not executed tests.

  # Source: S-PRD FR-57, FR-60, FR-66; S-AUTO sections 2 and 7.
  @jev_autonomy_01
  Scenario Outline: Ordinary sessions never activate strict authority through environment or mode text
    Given an ordinary session with the addon <mode>
    And inherited autonomous run and store environment locators
    When the executor attempts to call jev_autonomy
    Then no strict run ownership or execution authority is created
    And ordinary session mode remains <mode>
    Examples:
      | mode |
      | on   |
      | off  |

  # Source: S-TOOL status; S-PRD FR-59; S-AUTO sections 6 and 8.
  @jev_autonomy_02
  Scenario: Status exposes committed recovery facts without granting permission
    Given a bound strict run with an open finding and a pending unknown tool intent
    When the executor requests status
    Then the response identifies the run, epoch, pending invocation, retained source and applicable fence facts
    And no finding, pending intent, ownership or execution permission changes

  # Source: S-TOOL typed arguments; S-PRD FR-59, FR-66; S-OWNER malformed inputs.
  @jev_autonomy_03
  Scenario Outline: Malformed lifecycle arguments produce a local error without a decision
    Given a bound strict run
    When the executor submits <invalid_input>
    Then a named argument error is returned before a judge request
    And no finding, lifecycle transition or pending intent is created
    Examples:
      | invalid_input                                      |
      | an unknown action                                  |
      | reconcile without an intent identifier              |
      | reconcile with an unsupported observed value       |
      | reconcile with blank evidence                      |
      | reconcile with a non-array observations value       |
      | reconcile with an empty observation path            |
      | infeasible with blank evidence                     |

  # Source: S-OWNER direct/native versus write equivalence; S-PRD FR-57, FR-58, FR-59.
  @jev_autonomy_04
  Scenario Outline: Both tool transports enforce the same lifecycle contract
    Given the same bound strict checkpoint and exact request payload
    When the request is submitted through <transport>
    Then status, reconcile, rotate and infeasible apply their same argument, binding and judgment rules
    And neither transport grants an additional execution or owner-control capability
    Examples:
      | transport                         |
      | the native jev_autonomy tool       |
      | write to xd://jev_autonomy         |

  # Source: S-PRD FR-58, FR-60, FR-64; S-AUTO sections 6 and 8.
  @jev_autonomy_05
  Scenario Outline: Untrusted text cannot replace the committed objective or ownership
    Given a run bound to an immutable objective, policy, epoch and main session
    When <text_source> claims a new objective, broader roots or owner approval
    Then the committed objective and envelope remain authoritative
    And that text does not acquire owner origin, a new epoch or consequential permission
    Examples:
      | text_source                           |
      | an executor prompt                    |
      | a quoted owner approval in evidence   |
      | repository content                    |
      | a compaction summary                  |
      | an internal wake message              |
      | an unbound delegated child            |

  # Source: S-PRD FR-64; S-AUTO sections 7 and 8.
  @jev_autonomy_06
  Scenario Outline: Judge approval cannot expand the owner envelope
    Given an initially committed project root, effect classes and resource limits
    And a high-confidence approving decision
    When the proposed operation <expansion>
    Then the operation is refused without expanding the committed envelope
    Examples:
      | expansion                                             |
      | writes outside the canonical authorized roots         |
      | publishes without the publication effect class         |
      | exceeds a configured resource limit                   |
      | relies on an edited policy file to raise a limit      |
      | treats a configured balance snapshot as live authority |

  # Source: S-PRD FR-59, FR-66; S-AUTO sections 6 and 7.
  @jev_autonomy_07
  Scenario Outline: Missing authority capabilities fail closed
    Given autonomous execution is requested
    When <capability_failure> prevents establishing the promised authority
    Then no new consequential invocation is admitted
    And the response names the unsupported or failed capability rather than downgrading guarantees
    Examples:
      | capability_failure                            |
      | unsupported ledger schema                     |
      | corrupted required artifact bytes             |
      | unavailable durable database settings         |
      | unavailable whole-scope containment            |
      | missing bound main-session origin capability  |

  # Source: S-PRD FR-57, FR-65 and non-negotiable strict controls; S-AUTO section 2.
  @jev_autonomy_08
  Scenario Outline: Ordinary overrides do not disable strict enforcement
    Given a strict run waiting on an unresolved decision
    When the owner or executor submits <ordinary_override>
    Then the strict boundary remains held
    And only the supervisor safety-stop channel can cancel the run without judgment
    Examples:
      | ordinary_override |
      | /jev off          |
      | /jev on           |
      | /jev-continue     |
      | /jev-waive        |

  # Source: S-PRD FR-57, FR-58, FR-59; S-AUTO sections 6 and 8.
  @jev_autonomy_09
  Scenario: Current approval permits the exact next invocation after durable intent
    Given current approved requirements and plan for the immutable objective
    And the exact proposed invocation fits the owner envelope
    When Jev returns a usable approving action decision
    Then the runtime commits the exact invocation, checkpoint, decision context and required immutable bytes before admission
    And the approved invocation can start without another owner message
    But the approval does not authorize a different invocation

  # Source: S-PRD FR-58; S-AUTO sections 6 and 8.
  @jev_autonomy_10
  Scenario Outline: A changed decision dependency invalidates an asynchronous answer
    Given an action judgment is outstanding for a bound invocation and observed dependencies
    When <binding_change> occurs before its answer is consumed
    Then the answer cannot admit execution or grant a repair permit for the changed state
    And the runtime requires a fresh applicable decision
    Examples:
      | binding_change                             |
      | the task version changes                   |
      | the approved plan bytes change             |
      | the work revision changes                  |
      | a tracked file changes                     |
      | a tracked absent file appears              |
      | the epoch or session generation changes    |
      | the exact invocation payload changes       |

  # Source: S-PRD FR-59, FR-61; S-AUTO sections 6 and 8.
  @jev_autonomy_11
  Scenario: Failure to commit an intent never falls back to native journal permission
    Given a current usable action approval
    When the durable intent transaction fails
    Then the invocation does not start
    And a native journal entry, summary or in-memory approval cannot substitute for the missing commit
    And the run remains explicitly waiting or closed to consequential work

  # Source: S-OWNER exact repair permits and no stale deadlock; S-PRD FR-57, FR-58, FR-67; S-AUTO section 6.
  @jev_autonomy_12
  Scenario Outline: A finding permits substantive repair without becoming an override
    Given an open finding about <finding_type>
    And safe observations establish a materially corrected repair proposal within the approved workflow
    When the applicable recovery judgment approves one exact repair action in the current binding
    Then that exact repair can pass strict admission after its durable intent is committed
    And after admission the finding <finding_state>
    But no unrelated consequential action is authorized
    Examples:
      | finding_type                                | finding_state                                       |
      | an existing defect requiring repair          | remains open until observed resolving proof is accepted |
      | an action-preflight refusal that never ran   | is retired for the exact approved replacement        |

  # Source: S-OWNER exact repair permits; S-PRD FR-57, FR-58; S-AUTO section 8.
  @jev_autonomy_13
  Scenario Outline: A repair permit is not reusable or transferable
    Given one exact repair action is approved for an open finding
    When <permit_mismatch> is attempted
    Then the mismatching action is refused
    And the finding is neither silently resolved nor replaced by a lower approval floor
    Examples:
      | permit_mismatch                                  |
      | another payload consumes the permit              |
      | a later task or revision uses the permit         |
      | a second invocation reuses the consumed permit   |
      | another finding identifier uses the permit       |
      | another session or epoch uses the permit         |

  # Source: S-PRD FR-57, FR-62; S-AUTO sections 6 and 10; S-OWNER held stop remains recoverable.
  @jev_autonomy_14
  Scenario: A held completion stop keeps the recovery channel usable
    Given a strict run with an unresolved finding and unfinished work
    When the native session stop attempts completion
    Then completion is blocked without cancelling the run or permanently closing recovery admission
    And safe observations, diagnostic consultation and an applicable substantive repair remain usable
    And a corrected current decision can advance the promised next step without an owner override

  # Source: S-TOOL reconcile; S-PRD FR-61; S-AUTO sections 6 and 8.
  @jev_autonomy_15
  Scenario Outline: Reconciliation settles an observed outcome without replaying the invocation
    Given a pending tool intent with complete retained invocation context
    And its execution is settled or its inherited scope has the exact durable fence receipt
    And fresh selected project observations account for every material effect
    When Jev supports the proposed outcome <outcome> with a usable current decision
    Then that intent is settled as <outcome>
    And no original invocation is replayed
    And an executed effect is not reported as proof of command success
    Examples:
      | outcome      |
      | executed     |
      | not_executed |

  # Source: S-TOOL observations; S-PRD FR-58, FR-64; S-AUTO section 8.
  @jev_autonomy_16
  Scenario Outline: Reconciliation cannot substitute declarations for actual project observations
    Given a pending unknown tool intent
    When reconciliation submits <invalid_observation>
    Then it is rejected without settling the intent or granting consequential permission
    Examples:
      | invalid_observation                                              |
      | an identifier that is not a pending tool intent                   |
      | an observation outside the authorized roots                      |
      | a path to a secret-bearing ledger outside the roots              |
      | a caller-supplied content object instead of observation path strings |

  # Source: S-TOOL inherited reconciliation; S-PRD FR-61; S-AUTO section 6.
  @jev_autonomy_17
  Scenario Outline: Inherited effects require their exact proven fence
    Given an unknown tool intent inherited from an earlier epoch
    When its reconciliation relies on <insufficient_fence>
    Then the intent remains unknown and consequential admission remains held
    And quiescence is not described as proof of its past success
    Examples:
      | insufficient_fence                              |
      | lease expiry alone                              |
      | a different scope fence                         |
      | a receipt that omits the exact intent            |
      | only parent-process death                       |
      | an executor assertion that the process is gone   |

  # Source: S-PRD FR-57, FR-62; S-AUTO sections 6 and 8.
  @jev_autonomy_18
  Scenario Outline: Unusable lifecycle judgments retain a durable recoverable wait
    Given a valid reconciliation or infeasibility proposal
    When the judge returns <answer>
    Then no pending effect is settled and no terminal infeasible state is claimed
    And the original cause and waiting reason remain available
    And retries follow the answer class without treating attempt counts as permission
    Examples:
      | answer                              |
      | an answer below the confidence floor |
      | an unsupported or mismatching label  |
      | a malformed response                 |
      | no answer for the requested question |
      | a substantive refusal                |
      | a retryable transport outage         |

  # Source: S-PRD FR-58; S-AUTO sections 6 and 8.
  @jev_autonomy_19
  Scenario: Selected reconciliation observations must remain fresh throughout judgment
    Given reconciliation has selected actual present and absent project-file observations
    When one selected observation or the pending intent changes during the judge request
    Then the answer is discarded without settling the intent
    And the executor is directed to obtain fresh evidence

  # Source: S-PRD FR-58, FR-61, FR-63; S-AUTO section 8; S-OWNER fresh dependency binding.
  @jev_autonomy_20
  Scenario: Executed reconciliation advances the manifest to the observed changed bytes
    Given an unknown invocation changed a tracked dependency from approved bytes A to observed bytes B
    And fresh observations of B remain stable through an approving executed reconciliation
    When the runtime records the settled effect and next checkpoint
    Then subsequent decisions bind to B rather than the old manifest for A
    And approvals dependent on A are invalidated
    And the same settled change does not create an endless stale-dependency refusal

  # Source: S-PRD FR-59, FR-61; S-AUTO sections 6 and 8.
  @jev_autonomy_21
  Scenario: A native asynchronous launch is not a terminal effect result
    Given an admitted tool invocation launches a native background job
    When the immediate tool result reports that work remains running
    Then its exact intent remains pending with the native job identity
    And consequential work and completion remain held
    When the matching native terminal result arrives in the bound epoch
    Then the runtime records that observed terminal result against the same intent
    And unrelated or duplicate terminal deliveries cannot settle another intent

  # Source: S-PRD FR-61, FR-63; S-AUTO sections 6 and 8.
  @jev_autonomy_22
  Scenario: A failed terminal result does not establish absence of effects
    Given an admitted native invocation may have partially changed project or external state
    When its observed terminal result is a failure
    Then the runtime preserves the distinction between an attempted invocation and established effects
    And missing effect evidence cannot become acceptance or permission for a blind retry

  # Source: S-PRD FR-59, FR-60, FR-61; S-AUTO sections 6 and 8.
  @jev_autonomy_23
  Scenario: Restore uses the ledger rather than native summaries as authority
    Given a checkpoint with exact objective, requirements, plan bytes, findings and unknown intents
    When the bound executor restarts with a stale native reference or compaction summary
    Then the committed ledger restores the authoritative context and unaffected approvals
    And unknown effects remain unknown until applicable reconciliation
    And a fork or inherited environment cannot independently acquire ownership

  # Source: S-PRD FR-58, FR-63; S-AUTO sections 6 and 8.
  @jev_autonomy_24
  Scenario: Restarted completion requires fresh execution evidence and current delivery bytes
    Given prior business, architecture and completion approvals before restart
    When the restored run proposes completion without fresh observed execution
    Then completion remains held
    When fresh execution and current business and architecture acceptance support completion
    Then a current completion approval can terminate the run once
    But regenerated or mixed publication bytes cannot inherit an earlier external review

  # Source: S-TOOL rotate; S-PRD FR-57, FR-59, FR-60, FR-61; S-AUTO sections 6 and 7.
  @jev_autonomy_25
  Scenario: Rotation is a durable request rather than permission to start a replacement
    Given a bound active strict run
    When the executor requests rotation with a reason
    Then the request is committed and new consequential work remains held
    And the supervisor waits for safe settlement and fences the old scope before a replacement can own execution
    And a developmental replacement requires its current applicable judgment
    And exact artifacts and authoritative objective survive the new generation

  # Source: S-PRD FR-60, FR-62; S-AUTO sections 6 and 8.
  @jev_autonomy_26
  Scenario Outline: Unacknowledged wake requests never authorize blind duplicate turns
    Given one committed pending wake for the current run, epoch and session generation
    When <wake_event> occurs
    Then a mismatching or absent start cannot confirm the wake
    And the run preserves its wait without a duplicate wake in that generation
    And a replacement generation requires proof that the old request cannot start
    Examples:
      | wake_event                            |
      | the host drops the custom turn        |
      | the wake acknowledgment deadline expires |
      | a late start arrives from an old generation |
      | an unrelated session emits agent_start |

  # Source: S-TOOL infeasible; S-PRD FR-57, FR-62, FR-64; S-AUTO section 6.
  @jev_autonomy_27
  Scenario: Infeasibility is an evidenced terminal decision rather than unfinished completion
    Given the frozen objective cannot safely be achieved within its envelope
    And the executor supplies actual evidence of that limitation
    When Jev returns a usable current infeasibility approval
    Then the run durably becomes infeasible and future work is not woken
    And the outcome is not reported as completed or owner-cancelled

  # Source: S-PRD FR-62, FR-64; S-AUTO sections 6 and 7.
  @jev_autonomy_28
  Scenario: Refused material needs a substantive correction rather than another identical request
    Given a lifecycle decision was substantively refused and its original cause is retained
    When the executor resubmits identical material
    Then no unchanged network retry or approval by repetition occurs
    When newly observed evidence or a corrected supported proposal changes the material
    Then a fresh applicable judgment is possible within remaining limits
    And passing it permits only its promised next step

  # Source: S-PRD FR-64; S-AUTO sections 6 and 7.
  @jev_autonomy_29
  Scenario Outline: Resource exhaustion preserves the run without permission inflation
    Given an unfinished strict run
    When <limit> is exhausted
    Then the run durably waits with the exhausted limit named
    And no consequential action, forced completion or expanded budget is inferred
    Examples:
      | limit             |
      | judge attempts    |
      | executor requests |
      | configured runtime |
      | bounded context bytes |
      | immutable artifact bytes |

  # Source: S-PRD FR-65; S-AUTO sections 6 and 8.
  @jev_autonomy_30
  Scenario Outline: Supervisor safety cancellation stops immediately without a judge decision
    Given the judge is unavailable and active or queued work exists
    When a genuine operator stop arrives and its cancellation commit <commit_result>
    Then admission closes, queued wakeups are cancelled and active work is aborted without waiting for Jev
    And automatic relaunch is suppressed
    And the response reports cancellation durability as <durability>
    And unknown effects are not declared rolled back or successfully completed
    Examples:
      | commit_result | durability           |
      | succeeds      | durably committed    |
      | fails         | not durably committed |

  # Source: S-PRD FR-61, FR-66; S-AUTO sections 6 and 7.
  @jev_autonomy_31
  Scenario Outline: Ownership takeover cannot outrun scope fencing
    Given a prior executor may still act on the run or an overlapping canonical writable root
    When <takeover_attempt> requests execution authority
    Then exclusive run and root admission is required before new consequential work
    And the old whole scope must be proven fenced before replacement execution is admitted
    And stale epochs cannot commit answers, intents or checkpoints
    Examples:
      | takeover_attempt                             |
      | a second supervisor for the same run          |
      | another run using an overlapping root        |
      | a resume after lease expiry                  |
      | an old child using inherited binding values  |

# Implementation audit
# Method: static producer -> consumer traces only, using live source snapshots C1C6
# (runtime), 1E2A (store), 4163 (driver), B80C (scope), 39EE (controller),
# C3C5 (activities), FD61 (state), 1B61 (gates), and 1D11 (judge).
# IMPLEMENTED_STATIC means a supporting code path exists, not that a scenario passed.
# DEFECT_STATIC identifies a source-level counterpath, not an observed runtime failure.
# UNVERIFIED means the complete contract crosses a boundary not established here.
# No builds, tests, formatters, smoke runs or Gherkin execution were performed.
#
# jev_autonomy_01 IMPLEMENTED_STATIC:
# src/index.ts:24-31 registers only the ordinary controller ->
# autonomy/index.ts:13-27 alone reads locators and creates/registers the runtime.
# Source import/registration separation supports nonactivation in either ordinary mode.
# Gap: installed host tool inventory under ordinary on/off was not observed.
#
# jev_autonomy_02 IMPLEMENTED_STATIC:
# runtime.ts:3010-3035 reads the run and reports status -> statusText:2964-2997
# exposes policy/binding/pending facts -> retainedIntentContext:2258-2287 and
# fenceReceiptFor:1230-1237 supply exact historical source and matching receipts.
# No control-state mutation occurs in the already-bound status branch.
# Gap: status can bootstrap stateFor on first attachment; a cold status is not proof of a read-only attach.
#
# jev_autonomy_03 IMPLEMENTED_STATIC:
# runtime.ts:3000-3008 validates action; :3069-3085 validates reconcile identity,
# observed value/evidence/path shape; :3250-3257 validates infeasible arguments
# before judgeFor:3163/:3283. Local controlError:2952-2955 creates no finding.
# Gap: native schema rejection versus manual argument validation was not exercised.
#
# jev_autonomy_04 UNVERIFIED:
# runtime.ts:1194-1198 exempts write xd://jev_autonomy from consequential admission ->
# registerTool:3327-3351 dispatches native calls to runControl:3000-3320.
# No repository adapter dispatches an xd write into that native execute function;
# that mounting belongs to the installed host, whose dispatch was not observed.
# Both routes' malformed-input and state-equivalence behavior remains an integration gap.
#
# jev_autonomy_05 IMPLEMENTED_STATIC:
# controller.ts:655-656 skips ordinary owner-input capture in strict mode ->
# :766-774 does not screen executor prompts as new strict owner requests ->
# runtime.restore:1003-1025 binds task/audience to committed objective ->
# verifyRun:887-936 rejects unbound process/session/scope origins ->
# store.update:1976-2014 rejects objective, policy, epoch and ownership mutation.
# Gap: this is control-plane integrity, not authenticated truth of quoted evidence.
#
# jev_autonomy_06 IMPLEMENTED_STATIC:
# store.create:1533-1558 normalizes/freezes policy and roots ->
# runtime.beforeTool:1340-1383 checks canonical targets/protected paths/publication ->
# actionCheck activities.ts:2620-2627 asks within_authority ->
# runtime.admit:1781-1796 requires accepted exact current decision ->
# store.update:2001-2003/:2034-2037 prevents policy/count expansion.
# Gap: arbitrary same-user native effects are not an OS sandbox (S-AUTO section 3);
# complete real-host effect containment and configured-balance treatment were not executed.
#
# jev_autonomy_07 IMPLEMENTED_STATIC:
# autonomy/index.ts:9-11 installs deny hooks before runtime import ->
# store.configureDatabase:1197-1209 verifies durable pragmas/integrity ->
# verifySchema:1180-1194 and artifact:2109-2115 reject incompatible/missing authority ->
# scope.checkAutonomyScopeCapability:230-267 refuses unavailable host containment ->
# runtime.verifyRun:887-936 requires actual process/scope/session binding.
# Gap: filesystem durability and installed-host origin capabilities need real-host observation.
#
# jev_autonomy_08 IMPLEMENTED_STATIC:
# controller.ts:557-560 rejects mode switch in strict runs; :600-602 rejects
# continuation; :611-613 rejects waiver -> runtime strictConfig:747-751 forces
# mutation/completion/enforced review -> supervisor cancellation bypasses only judgment.
# Gap: native owner-command behavior was not exercised.
#
# jev_autonomy_09 IMPLEMENTED_STATIC:
# controller.toolCall:893-904 submits exact native payload/callId ->
# runtime.judgeFor:1701-1728 retains usable action+authority decision ->
# runtime.admit:1765-1856 rechecks payload, revision, session, dependencies and
# atomically adds the exact intent -> store.update:1955-2106 commits with checkpoint.
# Gap: no host invocation observed between successful commit and actual tool execution.
#
# jev_autonomy_10 IMPLEMENTED_STATIC:
# runtime.judgeFor:1482-1495 captures task/revision/plan/references ->
# :1653-1678 compares epoch/generation/task/revision/manifest/live bytes ->
# admit:1769-1801 checks payload and binding again before intent.
# Gap: no asynchronous mutation races were executed in this assignment.
#
# jev_autonomy_11 IMPLEMENTED_STATIC:
# runtime.admit:1834-1856 commits before deleting the per-call decision ->
# commit:828-840 closes admission on failed store update ->
# controller.ts:958-976 returns a tool block on failed admit.
# store.transaction:1134-1147 rolls back an uncommitted transaction.
# Gap: power-loss and native-journal ordering were not observed.
#
# jev_autonomy_12 DEFECT_STATIC:
# activities.consult:574-575 produces the exact state.repair permit ->
# state.permittedRepair:432-436 recognizes payload/finding/workflow bindings ->
# gates.recoveryGate:1099-1101 and mutationGate:1037-1038 allow that exact repair,
# but controller.toolCall:814-815 calls runtime.beforeTool first ->
# runtime.ts:1331-1333 unconditionally blocks any open hold, before those permit consumers.
# runtime.admit:1755-1758 repeats the same guard. Thus an approved repair cannot
# reach the required strict action/intent path while its finding remains open.
# The intended preflight retirement consumer is controller.ts:947-953, unreachable
# through this held precheck. Gap: no integrated recovery invocation was run.
#
# jev_autonomy_13 IMPLEMENTED_STATIC:
# activities.consult:545-546 snapshots exact proposed arguments and :574-575 stores
# finding/workflow binding -> state.ts:423-436 compares exact action and binding ->
# controller.ts:947-953 consumes state.repair -> runtime.admit:1765-1801 separately
# requires exact unused callId/payload/current epoch/session decision.
# Gap: the usable success path is blocked by defect 12; cross-generation replay of
# persisted permits has no integration execution proof, and repairBinding itself
# does not contain epoch/session fields.
#
# jev_autonomy_14 DEFECT_STATIC:
# controller.session_stop:1038-1044 -> runtime.stop:2447-2489 may judge acceptance
# and completion with a standing hold; it does not first return a recovery wait.
# If those checks approve, :2505-2524 attempts a completed transaction ->
# store.completionProblem:1092 rejects the still-open finding via update:2082-2084 ->
# runtime.commit:838-840 treats that invariant rejection as permanent storage closure.
# closedReason then blocks judgeFor:1443-1444 and runControl:3037, including recovery.
# This is a conditional source counterpath, not proof that the judge actually
# approved such a stop. Gap: no held-stop-to-repair real-host trace was executed.
#
# jev_autonomy_15 IMPLEMENTED_STATIC:
# runtime.runControl:3085-3115 requires a pending settled/fenced exact intent and
# retained original context -> :3120-3125 asks outcome, not whole-command success ->
# :3182-3235 requires matching above-floor outcome and removes only that intent.
# :3241-3245 explicitly records observed outcome without replay.
# Gap: provider idempotency and all external effects require observations not supplied by static reading.
#
# jev_autonomy_16 IMPLEMENTED_STATIC:
# runtime.ts:3080-3085 validates selected path strings and pending tool identity ->
# observeRecoveryPaths:2221-2254 enforces canonical authorized paths and captures
# actual present/absent complete bytes -> :3140-3141 includes them with retained source.
# Caller evidence remains untrusted data, not cryptographically authenticated evidence.
# Gap: no claim is made that arbitrary fabricated free-text evidence is deterministically detected.
#
# jev_autonomy_17 IMPLEMENTED_STATIC:
# store.recordFence:1714-1760 creates scope+intent receipts after positive proof ->
# runtime.fenceReceiptFor:1230-1237 matches exact intent and scope ->
# runControl:3087-3107 refuses an inherited effect without that receipt ->
# :3121-3125 still requires outcome judgment, not success from quiescence.
# Gap: live detached-process fencing was not observed here.
#
# jev_autonomy_18 IMPLEMENTED_STATIC:
# judge.normalizeAnswers:154-180 rejects malformed/missing/foreign answers ->
# runtime.judgeFor:1688-1697 persists transport wait/backoff ->
# reconcile:3163-3187 and infeasible:3283-3298 persist explicit undecided waits;
# :3183/:3295 enforce unchanged choice/boolean floors.
# Gap: no network outage or malformed provider reply was induced.
#
# jev_autonomy_19 IMPLEMENTED_STATIC:
# observeRecoveryPaths:2221-2254 captures selected bytes/absence ->
# judgeFor:1657-1678 rejects changed general bindings/dependencies ->
# runControl:3175-3180 rereads selected observations and the exact pending intent
# before :3190-3237 can commit settlement.
# Gap: no concurrent file/intent update was executed.
#
# jev_autonomy_20 DEFECT_STATIC:
# runControl:3114/:3141 selects live B and :3175-3180 proves its stability ->
# executed reconciliation:3191-3235 calls commit with artifacts undefined and
# updates action/checkpoint/pending/waiting only -> commit:828-837 delegates to
# store.update, whose default artifacts={} at :1951 does not refresh manifest.
# run.manifest can therefore still name A -> next judgeFor:1461-1464 refuses
# changed dependencies; admit:1797-1801 also refuses them.
# checkpointLocked:1894-1907 can eventually refresh hashes, but it is not part
# of successful reconciliation and may clear the newly observed execution window.
# Gap: no post-reconcile decision/acceptance loop was run, so an endless runtime
# deadlock is not claimed; the stale manifest counterpath is static.
#
# jev_autonomy_21 IMPLEMENTED_STATIC:
# controller.tool_result:996-998 routes native async details ->
# runtime.recordToolResult:1991-1999 distinguishes running from terminal ->
# :2074-2093 retains job identity/pending state ->
# context hook:3364-3366 or native-wait:2112-2116 ->
# settleBackgroundResult:2124-2158 matches job/type/time/epoch/generation/session
# and records the original intent result; duplicate completed matches disappear.
# Gap: installed host native message shapes/timing were not observed.
#
# jev_autonomy_22 IMPLEMENTED_STATIC:
# recordToolResult:2024-2029 classifies error as unknown effect ->
# :2088-2091 retains the pending intent with observed failure ->
# beforeTool:1319-1326 and stop:2373-2383 block new effects/completion ->
# runControl reconciliation is required for settlement.
# Gap: no failed external effect and provider observation were executed.
#
# jev_autonomy_23 IMPLEMENTED_STATIC:
# store.bindChild:1891-1895 / bindSession:1931-1939 preserve workflow but clear
# session-bound execution acceptance -> runtime.restore:993-1109 checks objective,
# requirements, plan digest and changed dependencies, retaining ledger bytes ->
# stateFor:1126-1141 rejects unbound sessions and clears cached action decisions.
# Gap: actual post-compaction completion and crash recovery remain open in
# S-PRD FR-61/FR-63 and S-AUTO section 1; native summaries were not replayed here.
#
# jev_autonomy_24 IMPLEMENTED_STATIC:
# store.bindSession:1935-1939 clears old acceptances/completion/actions ->
# runtime.judgeFor:1466-1468 requires fresh execution ->
# stop:2453-2524 requires both aspects and current completion ->
# activities.actionCheck:2641-2647/:2720-2726 binds external delivery to reviewed bytes.
# Gap: real post-restart completion/delivery remains unexecuted and not accepted by this audit.
#
# jev_autonomy_25 IMPLEMENTED_STATIC:
# runControl.rotate:3047-3057 commits rotation wait ->
# beforeTool:1328-1329 closes new effects ->
# driver.ts:2813-2837 waits for childIsSettled and whole-scope stop proof ->
# driver recovery:2349-2367 fences, :2464-2516 judges complete replacement context ->
# :2549-2584 launches only current approval.
# Gap: no live rotation/compaction/artifact continuity was observed.
#
# jev_autonomy_26 IMPLEMENTED_STATIC:
# runtime.maybeWake:2788-2815 preserves uncertain pending wake after deadline ->
# :2820-2856 commits binding/id/deadline before sending agent-attributed custom turn ->
# acknowledgeWake:2884-2903 only confirms matching run/session/generation ->
# register:3378-3381 invokes acknowledgment on agent_start.
# Gap: turn_start:3383-3386 only sets activity, so a host emitting only turn_start
# has no demonstrated acknowledgment route; no installed-host event trace was captured.
#
# jev_autonomy_27 IMPLEMENTED_STATIC:
# runtime.runControl:3250-3257 validates evidence and absence of unknown effects ->
# :3260-3266 asks evidenced within-envelope impossibility ->
# :3295-3319 requires usable boolean approval before durable terminal state ->
# driver.ts:2801-2811 fences terminal child instead of relaunching.
# Gap: no live infeasibility decision or terminal fencing was observed.
#
# jev_autonomy_28 IMPLEMENTED_STATIC:
# runtime.reconcile material:3129-3159 feeds submissionLedger ->
# :3159-3161 rejects unchanged refused material without a network call ->
# :3183-3185 records refusal; infeasible:3277-3297 has the same material ledger path.
# recordDecisionWait:2323-2335 retains materialDigest; maybeWake:2783-2785 does not
# manufacture a turn from unchanged waiting state.
# Gap: corrected-evidence progress and no-paid-retry behavior were not executed.
#
# jev_autonomy_29 DEFECT_STATIC:
# Judge exhaustion runtime.ts:1605-1613 and runtime exhaustion:2732-2752 record
# resource waits; driver.ts:2391-2424 checks judge/executor/runtime limits.
# However store.update:2070-2075 throws on an oversized artifact during a result
# commit -> runtime.commit:838-840 permanently closes admission after rollback,
# without committing a named durable artifact-resource wait.
# This fails the durable-wait row for artifact bytes while still failing closed;
# no budget bypass is claimed. Gap: no exhaustion path was executed.
#
# jev_autonomy_30 IMPLEMENTED_STATIC:
# driver.superviseRun:2697-2701 / :2793-2799 reacts to abort independently of judge ->
# cancellationResult:1748-1752 distinguishes committed cancellation from failure ->
# store.cancel:2118-2130 commits terminal status and removes wake ->
# stopActiveChild:1110-1144 fences/aborts physical work ->
# cancellationResult:1790-1803 reports durability and returns without relaunch.
# Gap: immediate scheduling latency, cancellation failure and actual abort were not measured.
#
# jev_autonomy_31 IMPLEMENTED_STATIC:
# store.create:1553-1558 atomically excludes overlapping reserved roots ->
# reservedRoots:1483-1491 keeps live/unknown terminal roots reserved ->
# claim:1643-1665 rejects live prior owner and advances administrative epoch ->
# driver recovery:2349-2367 proves scope fence before launchChild:2583 ->
# scope.fenceAutonomyScope:599-633 kills whole cgroup and proves quiescence ->
# store.update:1955-1974 rejects stale/nonbound callers.
# The administrative supervisor claim may precede fencing; it is not permission
# for a replacement executor to act. Gap: overlapping-run/fork/lease races were not executed.

# Source register
# S-PRD: PRD.md, autonomous module FR-57 through FR-66, strict session-control constraints, FR-67 recovery semantics as constrained by the strict runtime.
# S-AUTO: docs/autonomy.md, sections 2, 6, 7, 8 and 10 (normative lifecycle and acceptance contract).
# S-TOOL: autonomy/runtime.ts:3326-3345, published jev_autonomy description and typed argument schema only, read before implementation audit.
# S-OWNER: delegated assignment: status/reconcile/rotate/infeasible; consuming strict admission/stop/restore; immutable objective/roots/epochs; exact repair permits; durable intent/no blind replay; native async settlement; fresh dependencies; recoverable held stop; fencing/resources/cancellation; route equivalence; malformed and untrusted input coverage.
# S-GHERKIN: https://cucumber.io/docs/gherkin/reference/ (one Feature, English steps, tags, Scenario Outlines and comments).
# Open questions
# GAP-1: Real-host lifecycle and crash reconciliation outcomes require integration execution by the parent; these scenarios have no runner or step definitions and are not executed tests.
# Assumptions
# None.
