# language: en
Feature: Diagnose decisions and recover exactly the finding that held work
  Diagnostic judgments inform a decision without approving project effects.
  Recovery permits substantive correction without stale deadlock or unsafe bypass.

  Background:
    Given the ordinary addon is enabled for the current owner request
    And judge answers are bound to the current task and work revision

  # FR-C01: WHEN consulting a decision THE SYSTEM SHALL return its submitted diagnostic shape. [S:PRD FR-08, FR-13; S:contract]
  @jev_consult_01
  Scenario Outline: Obtain one diagnostic judgment without granting execution authority
    Given a valid "<mode>" consultation with question, context and "<definition>"
    When the judge returns a usable "<answer>" meeting its approval floor
    Then the consultation returns that diagnostic answer and the submitted decision meaning
    And no native action, acceptance, completion or hold resolution is approved
    Examples:
      | mode    | definition                                  | answer                         |
      | choice  | two distinct labeled alternatives           | selected submitted label       |
      | score   | two ordered rubric steps                    | score on the submitted rubric  |
      | boolean | distinct trueMeaning and falseMeaning        | yes probability                |

  # FR-C02: IF diagnostic arguments are malformed THE SYSTEM SHALL refuse locally without a finding. [S:PRD FR-20, FR-67; S:contract]
  @jev_consult_02
  Scenario Outline: Correct malformed diagnostic input without spending a judgment
    Given a diagnostic consultation containing "<invalid>"
    When jev_consult receives the submission
    Then it names the invalid argument without calling the judge
    And no new finding or approval is created
    Examples:
      | invalid                                      |
      | an unsupported mode                          |
      | a missing or blank question                  |
      | a missing or blank context                   |
      | choice with fewer than two alternatives      |
      | choice with duplicate labels                 |
      | choice with an empty alternative meaning     |
      | score with fewer than two rubric steps       |
      | boolean without trueMeaning or falseMeaning  |
      | a recovery object on a diagnostic mode       |

  # FR-C03: WHILE a finding stands THE SYSTEM SHALL permit diagnostics without clearing that finding. [S:PRD FR-67; S:manual]
  @jev_consult_03
  Scenario Outline: Diagnose while a workflow finding remains open
    Given a standing developer-review finding with its original submission and result
    When a valid "<mode>" diagnostic receives a usable answer
    Then the answer is available to guide correction
    And the original finding remains unchanged and visible in jev_context
    And an unrelated consequential native action remains held
    Examples:
      | mode    |
      | choice  |
      | score   |
      | boolean |

  # FR-C04: IF judgment is unusable THE SYSTEM SHALL distinguish uncertainty from a proven defect. [S:PRD FR-20, FR-21; S:policy; S:manual]
  @jev_consult_04
  Scenario Outline: Diagnostic uncertainty and service failure never manufacture approval
    Given a valid diagnostic consultation
    When the judge returns "<result>"
    Then the result is reported as "<classification>" rather than an established implementation defect
    And no action, finding resolution or acceptance is approved
    Examples:
      | result                                | classification       |
      | a below-floor choice confidence       | uncertainty          |
      | a below-floor score confidence        | uncertainty          |
      | a boolean yes probability of 0.5       | uncertainty          |
      | a missing answer                      | unavailable judgment |
      | an unexpected answer name or type      | unavailable judgment |
      | an out-of-range or nonfinite number    | unavailable judgment |
      | a transport failure                   | unavailable judgment |

  # FR-C05: WHEN unrelated diagnostic questions are asked THE SYSTEM SHALL preserve independent refusal records. [S:PRD FR-22]
  @jev_consult_05
  Scenario: An unrelated diagnostic cannot erase an earlier duplicate refusal
    Given diagnostic question A was refused on material A
    When a different valid question B obtains its own usable answer
    And unchanged question A with material A is submitted again
    Then question B is judged independently
    And the repeated question A receives its prior refusal without another judge call
    And neither answer grants project execution authority

  # FR-C06: IF recovery arguments are malformed THE SYSTEM SHALL refuse locally without replacing the cause. [S:PRD FR-67; S:contract]
  @jev_consult_06
  Scenario Outline: Recovery requires the exact phase-specific shape
    Given an existing finding with its original material and result
    When recovery is submitted with "<invalid>"
    Then the invalid field or prerequisite is named without calling the judge
    And the original finding remains unchanged
    Examples:
      | invalid                                          |
      | a missing recovery object                        |
      | a missing findingId                              |
      | an unknown phase                                 |
      | a blank diagnosis                                |
      | a blank correction                               |
      | no evidence                                      |
      | repair without nextAction                        |
      | repair naming a jev_ tool                         |
      | repair with a missing complete input object      |
      | resolve with nextAction                          |

  # FR-C07: WHEN recovery names a finding THE SYSTEM SHALL bind it to the current exact finding. [S:PRD FR-67]
  @jev_consult_07
  Scenario Outline: Recovery cannot operate on an absent or different finding
    Given "<finding state>"
    When a well-formed recovery names finding A
    Then recovery is refused before judgment with the missing or mismatched finding identified
    And no action capability or finding resolution is granted
    Examples:
      | finding state                       |
      | there is no standing finding        |
      | the standing finding has id B       |
      | finding A belongs to a replaced task|

  # FR-C08: WHEN judging recovery THE SYSTEM SHALL supply observed context and its canonical question. [S:PRD FR-67; S:contract]
  @jev_consult_08
  Scenario Outline: Judge one canonical recovery decision from the held cause
    Given a standing finding and current approved requirements, plan and native observations
    And valid "<phase>" recovery includes diagnostic question text and caller-selected trueMeaning
    When recovery is submitted
    Then the judge receives exactly one canonical boolean named "<canonical>"
    And the judge receives the exact held boundary, original material, result and current workflow observations
    And the caller's question and boolean meanings cannot replace that decision
    And no private reasoning is requested
    Examples:
      | phase   | canonical     |
      | repair  | repair_action |
      | resolve | resolves_hold |

  # FR-C09: WHEN repair passes THE SYSTEM SHALL authorize only its exact single native invocation. [S:PRD FR-67, FR-38]
  @jev_consult_09
  Scenario: Repair admits one matching action while retaining an executed-defect finding
    Given an established defect finding caused by an already executed action
    And the current requirements and exact plan permit the proposed correction
    When repair_action approves the complete native edit payload at probability 0.7
    Then the exact same edit payload may be admitted once without a second action judgment
    And the finding is not described as fixed or resolved
    And every other consequential invocation remains held pending observed resolution

  # FR-C10: IF the proposed invocation differs THE SYSTEM SHALL deny the changed payload without spending exact permission. [S:PRD FR-67, FR-38]
  @jev_consult_10
  Scenario Outline: A repair capability cannot authorize a nearby payload
    Given repair approved native edit with its complete input object for the standing finding
    When the next native invocation changes "<change>"
    Then that invocation is held without executing the changed payload
    And the original exact capability cannot approve the changed invocation
    Examples:
      | change                           |
      | the native tool name             |
      | the target path                  |
      | the replacement text             |
      | an additional input field        |
      | a nested input value             |

  # FR-C11: AFTER one admission THE SYSTEM SHALL refuse reuse of a repair capability. [S:PRD FR-67]
  @jev_consult_11
  Scenario Outline: A repair permission is spent even when execution does not succeed
    Given a repair-approved exact invocation was admitted once
    And that execution "<outcome>"
    When the identical native invocation is requested again without a new usable authorization
    Then the spent repair cannot authorize the second execution
    And the current action and workflow gates determine the next permitted step
    Examples:
      | outcome                  |
      | completed successfully   |
      | returned an error        |
      | has an unknown outcome   |

  # FR-C12: WHEN an unexecuted action-preflight replacement is admitted THE SYSTEM SHALL retire that preflight cause. [S:PRD FR-67; S:manual]
  @jev_consult_12
  Scenario: Repair an action that was refused before execution
    Given the standing finding is an action-preflight refusal and the refused action never executed
    When a repair approves and admits the exact corrected native invocation
    Then that action-preflight finding is retired at admission
    And no implementation fix, acceptance or completion is inferred from admission alone
    And subsequent actions require their own current authorization

  # FR-C13: IF workflow prerequisites are missing THE SYSTEM SHALL retain underlying gates despite repair. [S:PRD FR-67; S:contract]
  @jev_consult_13
  Scenario Outline: Repair does not replace prerequisite or publication authority
    Given repair approved one exact consequential action
    And "<gate>" is not satisfied
    When that native action reaches its execution boundary
    Then the unmet gate holds the action despite the repair approval
    And the result names the missing prerequisite rather than approval
    Examples:
      | gate                                    |
      | current approved requirements           |
      | exact current approved plan             |
      | required enforced external-text review  |
      | strict durable invocation authority     |

  # FR-C14: WHEN resolve passes THE SYSTEM SHALL clear only the named finding from observed proof. [S:PRD FR-67]
  @jev_consult_14
  Scenario: Observed resolution clears a finding but does not approve an action
    Given the named finding has a supported diagnosis and observed correction
    And the executor submits quoted execution or source proof of that correction
    When resolves_hold approves at probability 0.7
    Then only the named standing finding is resolved
    And no next native invocation, acceptance or completion is preapproved
    And a later native invocation receives its own current action judgment

  # FR-C15: AFTER resolution THE SYSTEM SHALL permit fresh judgment of the boundary it resolved. [S:owner; S:PRD FR-22, FR-67]
  @jev_consult_15
  Scenario: A resolved action refusal cannot deadlock identical re-evaluation
    Given a native invocation was refused and cached as the cause of finding A
    And supported resolve cleared finding A at the unchanged work revision
    When the exact originally refused native invocation is submitted again
    Then it reaches a fresh current action judgment rather than the stale refusal cache
    And execution occurs only if that new judgment and all underlying gates approve

  # FR-C16: WHEN resolving one boundary THE SYSTEM SHALL preserve unrelated refusal records. [S:PRD FR-22, FR-67]
  @jev_consult_16
  Scenario: Resolving an action does not erase unrelated decision history
    Given diagnostic question B has a cached refusal unrelated to finding A
    When supported resolve clears finding A
    And unchanged diagnostic question B is resubmitted
    Then B receives its prior refusal without a new judge call
    And resolving A supplies no approval or retry permission to B

  # FR-C17: IF recovery does not approve THE SYSTEM SHALL preserve the exact original cause. [S:PRD FR-20, FR-21, FR-67; S:policy]
  @jev_consult_17
  Scenario Outline: Recovery uncertainty and outages leave the original finding intact
    Given finding A retains its original boundary, revision, submission and judge result
    When "<phase>" recovery receives "<result>"
    Then no recovery capability or resolution is granted
    And the result distinguishes uncertainty from unavailable judgment without inventing a defect
    And jev_context still exposes the exact original finding A rather than the failed recovery
    Examples:
      | phase   | result                              |
      | repair  | a below-floor repair_action answer   |
      | resolve | a below-floor resolves_hold answer  |
      | repair  | missing or malformed answers         |
      | resolve | transport failure                    |
      | resolve | an unexpected additional answer      |

  # FR-C18: WHILE recovery evidence is unchanged THE SYSTEM SHALL avoid duplicate judgment regardless of prose. [S:PRD FR-22, FR-67]
  @jev_consult_18
  Scenario Outline: Rephrasing is not substantive recovery
    Given a recovery was refused for the current finding, phase, exact action and bindings
    When the executor resubmits with "<variation>" but no new observation or source
    Then the existing refusal is returned without another judge call
    And the finding and all applicable gates remain in force
    Examples:
      | variation                           |
      | a different diagnostic question     |
      | a rephrased diagnosis               |
      | a rephrased correction              |
      | reordered evidence                  |
      | duplicate evidence items            |

  # FR-C19: WHEN material substantively changes THE SYSTEM SHALL allow recovery until supported correction passes. [S:owner; S:PRD FR-22, FR-23, FR-67, FR-72]
  @jev_consult_19
  Scenario Outline: Corrected material can be judged after repeated recovery refusals
    Given recovery at this finding has been refused more than three times
    When a valid recovery supplies "<change>"
    Then the materially new recovery reaches the judge at the unchanged approval floor
    And a usable approving answer enables only the promised phase-specific next step
    And attempt counts neither deny substantive recovery nor grant execution by themselves
    Examples:
      | change                                |
      | new observed execution evidence       |
      | a corrected selected trusted source   |
      | a new authentic owner clarification   |
      | a current materially changed revision |

  # FR-C20: WHEN recovery phase or action changes THE SYSTEM SHALL judge the newly bound proposal without reusing prior approval. [S:PRD FR-22, FR-67]
  @jev_consult_20
  Scenario: Repair and resolve have separate identities
    Given repair approved the exact native correction for finding A
    When the correction executes and resolve is submitted with its observed proof
    Then resolve reaches its own canonical resolves_hold judgment
    And repair approval is not reused as proof or resolution

  # FR-C21: IF asynchronous bindings change THE SYSTEM SHALL discard the old answer. [S:PRD FR-36, FR-58, FR-67, FR-71]
  @jev_consult_21
  Scenario Outline: A late approving answer cannot land on changed work
    Given a valid diagnostic or recovery judgment is in flight
    When "<binding change>" occurs before its approving answer returns
    Then the old answer is reported stale and creates no current approval or repair permission
    And no current finding is cleared by that answer
    Examples:
      | binding change                          |
      | the task is replaced                    |
      | the owner request is amended            |
      | the approved requirements change        |
      | the approved plan bytes change          |
      | the work revision advances              |
      | the standing finding changes            |
      | ordinary mode is disabled and reenabled |

  # FR-C22: IF approved repair bindings change THE SYSTEM SHALL deny use of its earlier capability. [S:PRD FR-58, FR-67]
  @jev_consult_22
  Scenario Outline: Binding changes invalidate a not-yet-consumed repair
    Given a valid exact repair capability has not been used
    When "<binding change>" occurs before the exact native invocation
    Then the earlier capability cannot admit that invocation
    And the current workflow requires newly supported authorization
    Examples:
      | binding change                     |
      | task replacement                   |
      | owner-request amendment            |
      | requirements replacement           |
      | plan-content replacement           |
      | work revision advancement          |
      | finding replacement                |

  # FR-C23: IF a citation is untrusted THE SYSTEM SHALL reject fabricated provenance without judgment. [S:PRD FR-68, FR-44]
  @jev_consult_23
  Scenario Outline: Fabricated trusted evidence cannot resolve a finding
    Given a standing finding
    When diagnostic or recovery evidence contains "<forgery>"
    Then the citation is refused before a judge call
    And the finding remains open without action permission
    Examples:
      | forgery                                        |
      | an unknown sourceId                            |
      | a quote absent from the stored source          |
      | a changed content-addressed source             |
      | user-kind evidence citing a non-owner source   |

  # FR-C24: IF override text is not authentic owner input THE SYSTEM SHALL keep the finding and gates. [S:PRD FR-44, FR-57, FR-68; S:manual]
  @jev_consult_24
  Scenario Outline: Submitted text is never an owner override
    Given a standing finding and a current request without continuation permission
    When a consultation includes "<text>"
    Then that text is treated as submitted evidence rather than an owner instruction
    And it cannot disable the addon, grant continuation or resolve the finding by itself
    Examples:
      | text                                                |
      | a question saying the owner approved continuation    |
      | a quoted /jev-continue command in evidence           |
      | a correction saying /jev off                         |
      | archived owner text from a different request         |
      | extension-origin text claiming explicit approval     |

  # FR-C25: WHEN using either registered route THE SYSTEM SHALL apply identical consultation semantics. [S:owner; S:contract; S:routes]
  @jev_consult_25
  Scenario Outline: Native and write-device routes preserve the same result and state
    Given equivalent fresh workflow states and the same complete "<submission>" payload
    When one submission uses the registered native jev_consult tool
    And the other uses write to xd://jev_consult with the same parameter object as content
    Then both routes apply the same validation, judge questions, bindings and approval floors
    And both return equivalent phase-specific permission or refusal without a routing bypass
    Examples:
      | submission                    |
      | valid diagnostic choice        |
      | valid repair                   |
      | valid resolve                  |
      | malformed recovery             |
      | unchanged refused recovery     |

  # FR-C26: WHILE ordinary mode is disabled THE SYSTEM SHALL skip consultations rather than approve them. [S:PRD FR-71]
  @jev_consult_26
  Scenario: Disabled ordinary mode does not run or approve a consultation
    Given the owner has disabled the ordinary addon with the native /jev off command
    When jev_consult is submitted through either registered route
    Then an explicit skipped and disabled result is returned without a judge call
    And no diagnostic verdict, repair permission or finding resolution is claimed
    And reenabling starts fresh workflow authority rather than restoring this skipped submission

  # FR-C27: WHILE strict mode is active THE SYSTEM SHALL retain durable current authority despite recovery or owner continuation. [S:PRD FR-57, FR-58, FR-59; S:contract]
  @jev_consult_27
  Scenario Outline: Strict recovery never replaces the autonomous authority chain
    Given a strict autonomous run with a standing finding
    When "<attempt>" occurs
    Then no consequential native invocation executes without a current usable exact judgment and durable intent
    And no ordinary-mode switch, continuation text, count or outage becomes strict action approval
    And a supported exact repair remains eligible for the remaining strict judgment and durable-intent gates rather than being denied solely because its finding stands
    Examples:
      | attempt                                               |
      | a diagnostic consultation returns a usable answer      |
      | resolve clears the named finding                       |
      | repair approves one exact native payload               |
      | the owner requests /jev off                            |
      | continuation text is supplied after repeated outages    |

  # FR-C28: WHEN a boolean settles no THE SYSTEM SHALL return a usable negative diagnostic without treating it as execution approval. [S:PRD FR-08, FR-20, FR-67; S:contract]
  @jev_consult_28
  Scenario: A reliable negative diagnostic is not an unavailable judgment
    Given a valid boolean diagnostic with distinct trueMeaning and falseMeaning
    When the judge returns a yes probability of 0.1
    Then the result reports a usable no decision with the submitted probability
    And it grants no action permission and clears no standing finding

  # FR-C29: WHEN exact repaired invocations overlap THE SYSTEM SHALL consume repair authority atomically at one admission. [S:PRD FR-67, FR-38]
  @jev_consult_29
  Scenario: Concurrent copies cannot spend the same repair authorization twice
    Given a single repair capability authorizes an exact replacement for an unexecuted action-preflight finding
    When two copies of that native invocation overlap before either finishes admission
    Then at most one copy executes under that repair capability
    And another copy requires its own fresh usable action judgment
    And retirement of the preflight finding does not turn an already-started duplicate admission into approval

# Implementation audit
# Scope: static inspection after writing scenarios; the parent concurrently edits production files. Anchors identify the inspected bytes, not a frozen release. No scenario runner or step definitions exist; no scenario, test, build, formatter or live judge call was executed here. IMPLEMENTED_STATIC is not execution proof. [S:owner; S:gherkin]
# jev_consult_01 IMPLEMENTED_STATIC: src/guidance.ts:153-178 -> src/controller.ts:728-735 -> src/activities.ts:594-656 -> src/judge.ts:262-293 -> src/types.ts:19,29. Choice returns meaning; score returns nearest rubric meaning; boolean returns probability/verdict. Only recovery branches create permits or clear holds (activities.ts:574-577). Execution proof absent. [S:code]
# jev_consult_02 IMPLEMENTED_STATIC: src/controller.ts:698-706 -> src/activities.ts:516-524,594-617 -> shared readAlternatives:280-297 -> refused:194-199 -> src/state.ts:327-330. Local invalid outcomes are not findings. Schema and backend validations must still be exercised through the real host. [S:code]
# jev_consult_03 IMPLEMENTED_STATIC: src/gates.ts:1086-1107 admits diagnostic consultation -> src/controller.ts:690-701 -> src/activities.ts:625-655 returns diagnostics without clearResolvedHold -> src/gates.ts:1037-1045 holds unrelated mutations. Source-only tests/activities.test.ts:730-758 cover a boolean case; no observed run or complete mode matrix. [S:code; S:tests]
# jev_consult_04 IMPLEMENTED_STATIC: src/judge.ts:154-196 rejects answer-set/type/label/numeric defects -> src/activities.ts:622-655 applies unchanged floors and LOW_SCORE_RECOVERY:215-216 -> src/controller.ts:701 records failed outcomes. No path here turns a low diagnostic into project approval. Real transport and malformed-answer matrix unexecuted. [S:code]
# jev_consult_05 DEFECT_STATIC: src/activities.ts:620 uses default identity from submitToJudge:492-495, including material.heldFinding:425. On the first below-floor A, recordRefusal:630/641/650 precedes src/controller.ts:701 -> src/state.ts:367-374 creating the hold. Identical A now hashes a different heldFinding, so submissionLedger:646 misses the first refusal and buys another call. A usable B does not restore the original digest. Independent per-question boundaries exist at activities.ts:619, but do not prevent this controller-created context drift. No host regression was executed. [S:code]
# jev_consult_06 IMPLEMENTED_STATIC: src/activities.ts:523-544 validates evidence, finding id, phase, diagnosis/correction and native nextAction object before submitToJudge:565; resolve refuses nextAction:543. src/controller.ts:705-706 -> src/state.ts:330 leaves original findings unchanged on invalid input. Complete real-host malformed-input matrix unexecuted. [S:code]
# jev_consult_07 IMPLEMENTED_STATIC: src/activities.ts:526-535 requires a current finding id and refuses pending replacement recovery -> src/state.ts:479-487 drops old findings on task registration/replacement -> src/activities.ts:574-577 is unreachable after a mismatch. No observed replaced-task race exercise. [S:code]
# jev_consult_08 IMPLEMENTED_STATIC: src/activities.ts:547-567 constructs exactly one repair_action/resolves_hold with fixed meanings and instructions -> material:414-428 supplies heldFinding, requirements and recentActions -> askJudge:448-455 adds full approved artifact bytes before transport. Caller question and meanings are not copied into recovery questions; no request for private reasoning. External judge interpretation is unverified. [S:code]
# jev_consult_09 IMPLEMENTED_STATIC: src/activities.ts:572-575 produces a bound repair -> src/state.ts:423-436 matches exact tool/input and workflow -> src/gates.ts:1038,1100 opens only the matching call -> src/activities.ts:2598-2606 avoids a second ordinary action judgment -> src/controller.ts:947-953 consumes permission and retains non-action findings. tests/controller.test.ts:2028-2066 supplies source-only supporting assertions, not observed proof. [S:code; S:tests]
# jev_consult_10 IMPLEMENTED_STATIC: src/activities.ts:545-546 snapshots nextAction -> src/state.ts:432-435 uses isDeepStrictEqual and exact tool -> src/gates.ts:1100-1107,1037-1045 holds mismatches. Capability is deleted only at controller.ts:947-949 after successful gates, not upon a changed-payload refusal. Source-only path change test: tests/controller.test.ts:2019-2022; other nested/extra-field cases unexecuted. [S:code; S:tests]
# jev_consult_11 IMPLEMENTED_STATIC: src/controller.ts:947-949 deletes the capability at admission before a tool result exists -> a later action reaches src/activities.ts:2598-2600 with no permit and current gates or normal judge. tests/controller.test.ts:2023-2025 covers a successful-result replay in source; failed/unknown result and concurrent admission schedules have no execution proof here. [S:code; S:tests]
# jev_consult_12 IMPLEMENTED_STATIC: src/activities.ts:2670-2675 records unexecuted action-preflight boundary action:<revision> -> src/controller.ts:950-952 retires only an action/action:* hold upon matching repair admission -> src/state.ts:440-454 clears the named hold without acceptance mutation. tests/controller.test.ts:1995-2025 is source-only support. [S:code; S:tests]
# jev_consult_13 UNVERIFIED: Ordinary negative-gate paths are statically present: src/controller.ts:841-890 applies prerequisite/artifact gates -> src/activities.ts:2581-2588 checks current plan/strict identity; 2601 excludes strict and enforced external scope from the ordinary repair fast-path -> external checks:2620-2648,2688-2708. However citing controller.ts:958 -> strict admit as an exercised recovery consumer was unsound: controller.ts:814 calls autonomy.beforeTool first, and autonomy/runtime.ts:1331-1333 unconditionally denies a standing hold before shared permittedRepair can apply. admit repeats beforeTool at runtime.ts:1755-1758. Thus the strict row's denial is fail-closed, but does not prove the intended remaining authority gate was reached; strict positive recovery is a separate DEFECT_STATIC in jev_consult_27. No prerequisite/external/strict matrix was executed. [S:code]
# jev_consult_14 IMPLEMENTED_STATIC: src/activities.ts:543,547-577 rejects nextAction and clears only approved named finding -> src/state.ts:440-454 clears hold/repair but creates no action or acceptance verdict -> src/controller.ts:877-918 and src/activities.ts:2651-2664 require subsequent invocation judgment. Judge assessment of proof remains external and unobserved. [S:code]
# jev_consult_15 IMPLEMENTED_STATIC: src/activities.ts:2593,2670-2675 records both action refusal ledger and hold at action:<revision> -> consult resolve:577 -> src/state.ts:440-446 marks only matching-boundary ledger entries resolved -> submissionLedger:646 excludes those from duplicate matches -> src/controller.ts:902,917 permits only a fresh approving actionCheck. tests/controller.test.ts:1930-1964 now contains both fresh approving and fresh refusing assertions, but was not run by this worker. Historical incident is not evidence of a remaining defect on this path. [S:code; S:tests]
# jev_consult_16 DEFECT_STATIC: src/state.ts:444-446 correctly preserves unrelated ledger entries; however src/activities.ts:425,492-494,620 hashes the complete heldFinding into diagnostic B's identity. A B refusal obtained while unrelated A stands is keyed with heldFinding A; after resolve removes A at state.ts:452, unchanged B has a different digest and reaches another judge call. Thus retained ledger storage alone does not establish the promised unrelated-cache behavior. No runtime reproduction here. [S:code]
# jev_consult_17 IMPLEMENTED_STATIC: src/judge.ts:154-196 rejects malformed/extra responses -> src/activities.ts:569-590 creates no permit/clear below floor or on unavailable transport -> src/controller.ts:701 -> src/state.ts:354-365 preserves the existing original cause. Below-floor recovery carries refusal/unclear in details rather than a fabricated code defect. Outage and each malformed-answer path remain unexecuted. [S:code]
# jev_consult_18 IMPLEMENTED_STATIC: src/activities.ts:558-563 explicitly keys recovery by phase, binding, nextAction, sorted selected source ids and deduplicated sorted evidence, excluding diagnosis/correction/question -> submitToJudge:494-503 returns cached refusal. Source-only supporting loop tests/activities.test.ts:783-816; evidence permutation/duplication cases have no observed execution here. [S:code; S:tests]
# jev_consult_19 IMPLEMENTED_STATIC: src/activities.ts:558-567 changes identity with new observations, selected sources or repairBinding -> submitToJudge:494-508 checks repeat only, not an exhausted count -> src/state.ts:624-648 retains diagnostic counts -> activities.ts:572 reads the unchanged 0.7 floor. tests/activities.test.ts:819-850 supports substantive new-evidence retries after three refusals in source only. This ordinary-mode scenario does not claim that a strict run's immutable resource ceiling is absent. [S:code; S:tests]
# jev_consult_20 IMPLEMENTED_STATIC: src/activities.ts:547-563 includes phase and exact action separately in identity -> repair writes state.repair:574-575, resolve invokes clearResolvedHold:576-577; src/controller.ts:980 onward records observed native results separately. tests/controller.test.ts:2028-2066 supports the phase sequence in source. No observed execution. [S:code; S:tests]
# jev_consult_21 DEFECT_STATIC: src/activities.ts:442-463 snapshots logical bindings and discards changed logical context, but returns kind unusable; consult:569/622 converts that into unusable(problem) with default unavailable at 218-225 -> src/controller.ts:701 -> src/state.ts:331-335 skips only kind stale and can manufacture an unavailable finding for a discarded diagnostic. Separately, ordinary askJudge:448-455 reads plan artifact only before transport and does not reread its bytes after the answer; an on-disk plan-only change can still resolve the old hold or issue a repair permit at 574-577. Later native admission checks artifact bytes at controller.ts:943, but that does not undo the false consultation result/hold clearing. Strict judge wrapper rereads at autonomy/runtime.ts:1669-1678. Mode replacement does have an independent current-state guard at controller.ts:699,710-711. No race executed. [S:code]
# jev_consult_22 IMPLEMENTED_STATIC: src/activities.ts:575 stores repairBinding -> src/state.ts:423-435 compares current request/task/requirements/plan/revision/finding/actions before any use -> src/gates.ts:1038,1100 refuses mismatch. Actual plan-byte changes are additionally checked by controller.ts:888-890,943-946 even without a digest update in state. All mutation schedules unexecuted. [S:code]
# jev_consult_23 IMPLEMENTED_STATIC: src/controller.ts:291-310 resolves sourceId and exact quote/owner-kind before runActivity:698 -> src/context.ts:208-231 verifies source content digest and metadata identity -> controller.ts:705-706 emits invalid input -> src/state.ts:330 preserves hold. No judge called after preparation throws; real file-tamper/source matrix unexecuted. [S:code]
# jev_consult_24 IMPLEMENTED_STATIC: src/activities.ts:85-86,405-427 marks all submitted and archived material as data -> recovery canonical instructions:552-555 do not grant owner override -> src/controller.ts:655-666 accepts continuation only from interactive/RPC input and standalone approval regex -> src/state.ts:253-261 binds continuation to request/task and forbids strict override. No adversarial real-model prompt-injection execution here. [S:code]
# jev_consult_25 UNVERIFIED: src/guidance.ts:153-178 declares native schema and catalog route -> src/controller.ts:675-714,728-739 registers a shared activity wrapper; tool_call logical-route decoding at 827-831 and gates.ts:1087-1107 preserve consultation availability for direct calls. src/activities.ts:516 onward supplies shared backend semantics once invoked. Actual write xd:// device dispatch is host-owned and not implemented by this repository; source-only gate admission is not proof of payload decoding, schema equivalence, errors or single execution across both routes. Requires real-host paired submissions. [S:code; S:routes]
# jev_consult_26 IMPLEMENTED_STATIC: src/controller.ts:194-198 defines skipped/disabled outcome -> native command:571-579 replaces state and toggles mode -> activity wrapper:678,710 bypasses judge -> hook:813 returns before boundaries -> current:273,699-711 rejects old-state results. Reenable copies only usage/stats:572-575, not permits/approvals. Real write-device disabled-route execution remains the route gap in jev_consult_25. [S:code]
# jev_consult_27 DEFECT_STATIC: src/activities.ts:574-575 can produce an exact bound repair while the finding remains open -> src/controller.ts:814 calls strict beforeTool before shared repair gates -> autonomy/runtime.ts:1331-1333 denies every standing hold without checking permittedRepair. Therefore an exact approved strict repair cannot reach the remaining action judgment, within_authority or durable-intent admission. Even if the first check were passed, strict admit repeats beforeTool at runtime.ts:1755-1758; both consumers matter. Later durable checks at runtime.ts:1765-1856 exist but are unreachable for this held-repair path and cannot prove its implementation. Safety controls are present at controller.ts:558-560 and state.ts:253-261 (no strict off/continuation bypass); resolve clearing a finding is not itself action authorization. The defect is blocked supported repair, not unsafe execution or an absent durable authority chain. No strict live-host execution was observed. [S:code]
# jev_consult_28 IMPLEMENTED_STATIC: src/judge.ts:163-166 normalizes yes probability -> src/activities.ts:648-655 accepts either reliable polarity and returns no at 0.1; only recovery branch:574-577 creates execution authority or clears a finding. No runtime execution here. [S:code]

# jev_consult_29 DEFECT_STATIC: src/controller.ts:899-904 serializes actionCheck only, not complete admission; src/activities.ts:2598-2606 can return the same repair-derived approval for two calls while state.repair still exists. Both admissions may then overlap at controller.ts:943 awaiting planBindingVerdict. First call consumes permit and retires the action-preflight hold at 947-952; second call's final mutationGate:945 now sees no hold, and permittedRepair:947 returning undefined is not checked against outcome.details.repairFindingId from its earlier approval. The second copy can reach ordinary admission with no fresh action judgment. Non-action findings remain held and do not have this particular schedule. This is a source-derived interleaving, not a reproduced execution; a concurrent host regression is required. [S:code]

# Source register
# [S:owner] Delegated owner assignment: jev_consult scenarios first, then live static audit; substantive correction until pass; exact single-use native action; fresh judgment after resolution; unrelated caches; route equivalence; strict consumers.
# [S:PRD] PRD.md FR-08, FR-13, FR-20..23, FR-36, FR-38, FR-44, FR-57..59, FR-67..72.
# [S:contract] src/guidance.ts:20-21,56-77,153-178,390-445; documented jev_consult description, schema and recovery examples.
# [S:manual] src/jev-skill.md:38-61; judgment classes and two-phase recovery rules.
# [S:policy] AGENTS.md:43,98; canonical fail-closed invariant and documented floors: boolean 0.7, choice/score 0.6.
# [S:routes] AGENTS.md:45; canonical registered write-device route.
# [S:gherkin] https://cucumber.io/docs/gherkin/reference/; one Feature, English steps, Scenario Outline, Examples, tags and comments.
# [S:code] Live static source inspected after normative scenario creation: src/activities.ts, src/controller.ts, src/state.ts, src/gates.ts, src/judge.ts, src/types.ts, src/context.ts, autonomy/runtime.ts; line anchors are listed per audit entry.
# [S:tests] Existing tests/activities.test.ts and tests/controller.test.ts source assertions inspected only; no passing result asserted.
# Open questions
# GAP-01: Main/integration verifier must supply real-host execution proof, including native/write-device equivalence, asynchronous binding races and strict durable repair consumption; this worker was instructed not to run checks. [S:owner]
# GAP-02: Main owns production correction and verification of diagnostic-cache context drift, stale-consultation/plan-byte races and concurrent repair consumption identified above; findings remain open until corrected and observed. [S:code]
# Assumptions
# None.
