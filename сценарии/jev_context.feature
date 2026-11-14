# language: en
# Scenarios 01-23 were drafted from the sources below before inspecting implementation logic.
# Scenarios 24-25 extend the same cited contract for repeated owner input and corrected citations; expected behavior is not copied from implementation.
Feature: Inspect trusted context without granting authority
  The executor can recover complete original evidence and findings without a workflow gate.
  Provenance identifies captured origins; it does not establish truth or permission.

  # FR-68; S:PRD; S:CATALOG
  @jev_context_01
  Scenario: List an empty project archive
    Given Jev is enabled and this project has no archived sources or standing finding
    When the executor calls jev_context with action "list"
    Then the result contains an empty source inventory
    And the result does not claim a workflow approval
    And no judge request is made

  # FR-68; S:PRD; S:CATALOG
  @jev_context_02
  Scenario: List captured sources with reusable identifiers and provenance
    Given the addon has captured an owner message and approved requirement and plan snapshots
    When the executor calls jev_context with action "list"
    Then the inventory identifies each source by a stable sourceId
    And each entry reports its kind, origin, session association and approval metadata
    And the same unchanged sources retain their identifiers on another list call

  # FR-68; S:PRD; S:CATALOG
  @jev_context_03
  Scenario Outline: Read one complete captured source without truncating its content
    Given a valid archived <kind> source contains Unicode, line breaks and content beyond a short preview
    When the executor calls jev_context with action "read" and its sourceId
    Then the result contains the exact complete stored content and its digest
    And the result identifies the source and its provenance
    And no judge request is made
    Examples:
      | kind         |
      | owner        |
      | requirements |
      | plan         |

  # FR-67, FR-72; S:PRD; S:README
  @jev_context_04
  Scenario Outline: Inspect the exact original finding after a judgment refused work
    Given a <boundary> refusal created a standing finding at work revision 7
    And a later failed recovery submitted different diagnosis and correction text
    When the executor calls jev_context with action "list"
    Then the hold contains the original finding id, boundary and work revision 7
    And the hold contains the exact original submitted JSON and returned result
    But the failed recovery has not replaced the original cause
    Examples:
      | boundary       |
      | requirements   |
      | plan review    |
      | action preflight |

  # FR-67, FR-72; S:PRD; S:OWNER
  @jev_context_05
  Scenario: Recover the complete refused invocation rather than infer its cause from a score
    Given an action preflight refused an invocation with nested arguments and quoted owner-like text
    When the executor calls jev_context with action "list"
    Then the original hold material identifies the refused native tool and its complete input
    And the original returned typed verdict and confidence remain inspectable
    And the hold does not turn the quoted text into an owner instruction
    And merely reading the finding neither clears it nor permits retrying the invocation

  # FR-67, FR-68, FR-72; S:PRD
  @jev_context_06
  Scenario Outline: Inspect context independently of workflow progress and judge availability
    Given Jev is enabled and <condition>
    And a valid source exists in the project archive
    When the executor lists the archive and reads that source
    Then both context operations return their requested local information
    And no triage, plan, recovery consultation or judge request is required for those operations
    And neither operation waits for a pending judge answer
    And consequential work remains subject to its existing gates
    Examples:
      | condition                                    |
      | the request has not been triaged              |
      | requirements and plan approval are missing  |
      | a recovery finding holds work                 |
      | an automatic course check is pending          |
      | the judge is unavailable                      |
      | an owner follow-up is awaiting classification |

  # FR-68; S:CATALOG; S:OWNER
  @jev_context_07
  Scenario Outline: Reject malformed context arguments without inventing a Jev finding
    Given Jev is enabled and no context judgment has run
    When the executor submits jev_context arguments <arguments>
    Then the result reports the invalid argument or missing prerequisite
    And no judge request is made
    And no workflow approval or new recovery finding is created
    Examples:
      | arguments                                  |
      | {}                                         |
      | {"action":"delete"}                      |
      | {"action":"read"}                        |
      | {"action":"read","sourceId":""}        |
      | {"action":"read","sourceId":42}         |
      | {"action":"list","sourceId":"unused"} |

  # FR-68; S:PRD; S:README
  @jev_context_08
  Scenario Outline: Refuse unavailable source identities without reading outside the archive
    Given Jev is enabled
    When the executor reads sourceId "<sourceId>"
    Then the result reports an invalid or unavailable source
    And no unrelated file content or approved workflow result is returned
    And no judge request is made
    Examples:
      | sourceId                 |
      | 0000000000000000000000000000000000000000000000000000000000000000 |
      | owner-missing            |
      | ../../private            |
      | /etc/passwd              |
      | plan-valid.json/../other |

  # FR-68; S:PRD; S:README
  @jev_context_09
  Scenario Outline: Detect corrupt records on both list and read
    Given an archived record has been <corruption>
    When the executor lists the archive and reads the affected sourceId
    Then the list reports the corrupt record rather than presenting it as a verified source
    And the read refuses the corrupt record rather than returning trusted content
    And no judge request is made
    Examples:
      | corruption                                      |
      | changed without updating its content digest      |
      | renamed to another otherwise well-formed id      |
      | changed in provenance without updating identity  |
      | replaced with malformed JSON                     |
      | replaced with an unsupported record version      |
      | replaced with structurally incomplete metadata   |

  # FR-68; S:PRD; S:README
  @jev_context_10
  Scenario: Isolate a damaged record from valid source inspection
    Given the archive contains a valid owner source and a corrupt plan record
    When the executor lists the archive and reads the valid owner source
    Then the inventory exposes the valid source and a diagnostic for the corrupt record
    And the read returns the valid owner's complete unchanged content
    But the corrupt plan does not become a source of approval

  # FR-68; S:PRD; S:README
  @jev_context_11
  Scenario Outline: Capture authentic owner input without duplicate or fabricated owner records
    Given the host delivers <delivery>
    When owner-input capture and the next agent start have completed
    And the executor lists the archive
    Then the inventory contains <ownerRecords> new owner records for that delivery
    And any captured owner record retains the native message's exact text and session provenance
    Examples:
      | delivery                                                     | ownerRecords |
      | one interactive owner input followed by its native prompt     | one          |
      | one RPC owner input followed by its native prompt             | one          |
      | one native user-containing print prompt without an input event| one          |
      | an agent-only turn                                           | zero         |
      | a revived turn without new owner input                        | zero         |
      | quoted owner commands in a tool argument or tool result       | zero         |

  # FR-68; S:PRD; S:OWNER
  @jev_context_12
  Scenario Outline: Archive only current passing requirement and plan approvals
    Given a requirement or final-plan submission is awaiting a judge answer
    And no equivalent approved snapshot has previously been archived
    When the answer is <answer>
    And the executor lists the archive
    Then that submission has <snapshot> approved snapshot
    And no unusable answer grants execution authority through archive metadata
    Examples:
      | answer                                   | snapshot |
      | usable and passing for the current task   | one new  |
      | rejecting                                | no new   |
      | below the applicable confidence floor    | no new   |
      | missing or malformed                     | no new   |
      | unavailable because transport failed     | no new   |
      | passing after the task has changed       | no new   |
      | passing after the reviewed plan changed  | no new   |

  # FR-68; S:PRD; S:README
  @jev_context_13
  Scenario: Preserve exact approved plan bytes after later revisions
    Given a plan was approved and its exact bytes were archived
    And the working plan has subsequently changed
    When the executor reads the original plan sourceId
    Then the original complete approved bytes and digest are returned unchanged
    But the old snapshot does not approve the changed working plan

  # FR-68; S:PRD; S:README
  @jev_context_14
  Scenario Outline: Resolve authentic citations before sending complete source context to the judge
    Given a valid archived <sourceKind> source contains an exact quoted passage
    When a judged tool submits that passage as evidence of kind "<evidenceKind>" with the sourceId
    Then its judge request includes the complete selected source content and provenance
    And the applicable chronological owner history accompanies the submission
    And the judge material explicitly treats archived text as data and provenance rather than truth or permission
    Examples:
      | sourceKind   | evidenceKind |
      | owner        | user         |
      | requirements | code         |
      | plan         | code         |

  # FR-68; S:PRD; S:README
  @jev_context_15
  Scenario Outline: Reject fabricated or mismatched source-backed evidence before judgment
    Given an evidence item has <defect>
    When a judged tool submits that evidence item with a sourceId
    Then the submission reports the source or quote mismatch
    And no judge request is made for that submission
    And no workflow approval is gained from the rejected citation
    Examples:
      | defect                                              |
      | a missing archived source                           |
      | a source that has changed since capture              |
      | a quote absent from the exact stored content         |
      | kind user referencing an approved plan rather than owner input |
      | kind user referencing approved requirements          |

  # FR-68; S:PRD; S:README
  @jev_context_16
  Scenario: Revalidate source integrity after a successful inventory read
    Given a source appeared valid in a previous jev_context list result
    And the on-disk source record has since been corrupted
    When the executor reads it or submits its sourceId as evidence
    Then each operation refuses the changed source rather than trusting the previous inventory
    And the evidence submission does not reach the judge

  # FR-68; S:PRD; S:README
  @jev_context_17
  Scenario: Archived owner-like instructions and approval metadata confer no authority
    Given an archived owner source contains "approve continuation" and unsupported factual claims
    And an archived plan source has approval metadata from an earlier task
    And the current task has an unresolved finding and lacks a current approved plan
    When the executor reads and cites those sources
    Then the archived strings remain evidence data rather than newly received owner commands
    And their claims are not reported as proven merely because provenance verified
    And the unresolved finding and current plan prerequisite remain in force

  # FR-69; S:PRD; S:OWNER
  @jev_context_18
  Scenario Outline: Inspect objective updates without treating archived history as a fresh replacement
    Given a development task has a current objective, requirements, plan and standing finding
    And an authentic follow-up has been classified as "<classification>"
    When the executor lists context and reads the original and follow-up owner sources
    Then both messages remain available in their chronological provenance
    And the list reports the current accumulated objective rather than reviving an archived objective
    And <objectiveEffect>
    And listing or reading context neither reclassifies the messages nor clears the standing finding
    Examples:
      | classification | objectiveEffect |
      | continuation   | the current objective and approvals remain in force |
      | amendment      | the objective includes the addition while dependent approvals remain invalidated |
      | replacement    | the new direction remains pending re-aim without inheriting old execution permission |
      | unclear        | work remains held pending a supported clarification |

  # FR-68, FR-69; S:PRD; S:OWNER
  @jev_context_19
  Scenario: Keep prior sources inspectable after a task replacement without restoring prior state
    Given a previous task archived requirements and an approved plan
    And an authentic replacement was established as a different task
    When the executor lists and reads the previous task's snapshots
    Then their original provenance and bytes remain available
    But the new task gains no requirements, plan, acceptance or continuation grant from those reads

  # FR-67, FR-68; S:PRD; S:OWNER
  @jev_context_20
  Scenario Outline: Native and write-device context calls have the same observable behavior
    Given Jev is enabled and <state>
    When equivalent arguments are submitted directly to jev_context and as JSON content to write path "xd://jev_context"
    Then both routes return equivalent source, hold or argument-error information
    And neither route grants an extra permission or requires a judge call
    Examples:
      | state                                   |
      | a valid archive is listed               |
      | a valid sourceId is read                |
      | an action-preflight finding is standing |
      | a sourceId is missing for action read   |
      | a source record is corrupt              |

  # FR-71; S:PRD; S:OWNER
  @jev_context_21
  Scenario Outline: Disabled ordinary mode returns a skip rather than an inspection approval
    Given the owner has disabled the ordinary addon for this session
    When the executor submits a <route> context list or read operation
    Then the result explicitly reports skipped or disabled
    And the result does not imply Jev approval
    And no source capture or judge request is performed by that operation
    Examples:
      | route        |
      | native       |
      | write-device |

  # FR-71, FR-68; S:PRD
  @jev_context_22
  Scenario: Re-enabling retains immutable sources without restoring old findings or approvals
    Given the ordinary session archived valid owner, requirement and plan sources before being disabled
    And that prior workflow had a finding and approvals
    When the owner re-enables Jev and the executor lists and reads the archived sources
    Then the sources retain their original identifiers, provenance and exact bytes
    But no prior finding, workflow approval or owner continuation grant is restored

  # FR-57, FR-68, FR-71; S:PRD; S:OWNER
  @jev_context_23
  Scenario Outline: Strict runtime inspection remains read-only and cannot disable enforcement
    Given a strict autonomous run holds a consequential action without a current usable verdict
    When the executor lists and reads a valid context source through the "<route>" route
    Then the requested archive information is inspectable without authorizing the held action
    And an ordinary session mode command cannot disable strict enforcement
    And archived approval metadata cannot replace the run's current bound verdict
    Examples:
      | route        |
      | native       |
      | write-device |

  # FR-68; S:PRD; S:OWNER
  @jev_context_24
  Scenario: Repeated authentic owner input remains a distinct chronological event
    Given an interactive owner message was captured and its corresponding native prompt was consumed
    When the owner sends the exact same text again as a new interactive input
    And the executor lists and reads the owner sources
    Then both authentic occurrences have distinct source identifiers and ordered sequence metadata
    And their complete content is identical without merging the two owner events
    But the repeated archived text alone grants no new workflow permission

  # FR-68; S:PRD; S:OWNER
  @jev_context_25
  Scenario: Correct a rejected source citation without a stale context deadlock
    Given a judged submission was rejected locally because its quote did not occur in a valid archived source
    When the executor reads that source and resubmits the activity with a quotation that occurs in its content
    Then the corrected evidence is resolved from the original immutable source
    And the corrected submission can reach its applicable judgment if its other prerequisites are met
    And the previous local citation error neither creates a recovery hold nor substitutes for a judgment

# Implementation audit
# Static inspection only: these scenarios have no step definitions or runner here and were not executed.
# IMPLEMENTED_STATIC means the inspected producer-to-consumer path supports the scenario, not that an integration check passed.
# DEFECT_STATIC identifies a reachable contradiction; UNVERIFIED identifies an unobserved or unowned integration boundary.
# Anchors identify the live source inspected during this assignment; concurrent parent changes can supersede these findings.
#
# jev_context_01 IMPLEMENTED_STATIC
# Producer src/context.ts:337-344 returns [] for an absent archive -> src/controller.ts:695 prepares local context -> :717-721 returns sources without approval.
# No judge path exists in the context handler. Supporting test intent: tests/context.test.ts:91-95; tool-level empty-project execution remains unobserved.
#
# jev_context_02 IMPLEMENTED_STATIC
# Producers src/controller.ts:324-333 and :350-362 capture owner/approved snapshots -> src/context.ts:278-302 hashes content and provenance -> :337-344 verifies inventory -> controller.ts:719-721 exposes metadata without content.
# Stable identity and idempotent storage: context.ts:92-103,321-335. Supporting test intent: tests/context.test.ts:62-87,145-154; no complete three-kind controller inventory run was observed.
#
# jev_context_03 IMPLEMENTED_STATIC
# Producer src/context.ts:240-253 reads complete UTF-8 and verifies digest -> :346-350 returns full source -> src/controller.ts:723-726 returns JSON plus structured source, with no preview or size truncation.
# Supporting exact-byte test intent: tests/context.test.ts:44-59; long three-kind tool responses remain unexecuted.
#
# jev_context_04 IMPLEMENTED_STATIC
# Producer src/state.ts:321-374 preserves original material/result/id/revision when another refusal arrives -> src/controller.ts:701 records activity results -> :719-721 serializes state.hold verbatim under details.hold and in text.
# Recovery feedback points to the original instead of repeating it: state.ts:399-413. Supporting intent: tests/state.test.ts:256-268; all boundary/example combinations remain unexecuted.
#
# jev_context_05 IMPLEMENTED_STATIC
# Producer src/controller.ts:893-895 records tool, target and JSON.stringify(input) without excerpt truncation -> :917-918 records action outcome -> src/state.ts:337-374 preserves exact material and typed result -> controller.ts:721 exposes hold.
# Archived owner-like strings do not enter input-command handler controller.ts:655-673. Existing live-smoke source tools/live-smoke.ts:535-538 inspects a finding but is not proof that this scenario ran.
#
# jev_context_06 DEFECT_STATIC
# Read-only classifications src/gates.ts:48-68,183-201 and recovery exemption :1087-1107 permit context logically -> nevertheless every registered executor src/controller.ts:675-685 enters serialized -> :395-403 awaits previous activity.
# A pending judge/course check owns that same queue (controller.ts:532-536,899-905), so context inspection waits for its answer despite gate-independent inspection. No timeout or live reproduction was run.
#
# jev_context_07 DEFECT_STATIC
# Producer documented omission rule src/guidance.ts:50-51 -> schema :183-186 allows optional sourceId with either action -> consumer src/controller.ts:719-721 unconditionally accepts action list and ignores supplied sourceId.
# Other malformed rows are locally refused by schema/handler or archive sourceId validation context.ts:235-237; state.ts:329-330 prevents invalid outcomes becoming findings. No transport-level schema execution was observed.
#
# jev_context_08 IMPLEMENTED_STATIC
# Producer untrusted sourceId -> src/context.ts:235-237 restricts ids to 64 lowercase hex -> :240-253 refuses missing, symlinked or non-file records -> :346-350 resolves only the project archive -> controller.ts:704-707 returns local preparation error.
# Supporting test intent: tests/context.test.ts:91-95,158-210. No outside-file read path is used for invalid ids; end-to-end tool invocations remain unexecuted.
#
# jev_context_09 IMPLEMENTED_STATIC
# Producer disk record -> src/context.ts:185-232 parses, validates version/required metadata, verifies content digest and provenance-derived identity -> :240-253 checks filename/id -> list :340-343 and read :346-350 both reverify -> controller.ts:704-707 reports errors.
# Supporting corruption cases exist at tests/context.test.ts:98-143. List currently fails as a whole; that fails isolation in jev_context_10, not corrupt-data rejection here.
#
# jev_context_10 DEFECT_STATIC
# Producer one corrupt record -> src/context.ts:340-343 map throws rather than returning valid inventory plus a diagnostic -> src/controller.ts:319 prepareContext enumerates all owner sources before ANY context handler at :695.
# Consequently even read(validId) never reaches :725, and list never reaches :721 to expose an existing hold. An unrelated damaged record can therefore deadlock valid source/finding inspection. No mixed-record execution was run.
#
# jev_context_11 IMPLEMENTED_STATIC
# Producers src/controller.ts:655-662 accept interactive/RPC input only -> :324-333 archives exact text and sequence; :780-782 captures a native reason=prompt fallback unless input was already captured.
# Revival/strict early exits :774-775 and non-owner input filtering :658 prevent the specified fabricated/agent-only captures. tests/controller.test.ts:1811-1826 documents print/revival intent; real host event delivery remains unverified, and no cryptographic source authentication is claimed.
#
# jev_context_12 IMPLEMENTED_STATIC
# Producers requirements src/activities.ts:1093-1129 and finalizePlan :1500-1544 install approval only from usable passing answers -> askJudge :442-464 discards changed task/revision/context -> finalize :1533-1535 rejects changed plan bytes.
# Consumer src/controller.ts:350-362 snapshots only approved current state and rechecks exact plan digest. Existing archive identity storage is context.ts:321-335; all answer/snapshot combinations remain unexecuted.
#
# jev_context_13 IMPLEMENTED_STATIC
# Producer src/controller.ts:358-362 captures exact approved artifact bytes -> src/context.ts:321-335 uses exclusive immutable writes -> :346-350 reads the old source rather than the live artifact -> controller.ts:726 reports it without installing a plan.
# Current plan byte checks remain separate at activities.ts:448-455. Supporting immutable-storage intent: tests/context.test.ts:145-154; changed-working-plan context read was not executed.
#
# jev_context_14 DEFECT_STATIC
# Producer src/controller.ts:300-308 resolves any valid cited project record, including owner and earlier-task sources -> :317-320 includes complete selected sources and session owner history -> src/activities.ts:414-427 supplies them to the judge.
# Gap: activities.ts:405-406 falsely describes every selectedSource as a snapshot approved for this task, although owner records and prior-task snapshots are accepted; actual provenance must not be upgraded. No behavioral judge exploitation or authorization bypass is established.
#
# jev_context_15 IMPLEMENTED_STATIC
# Producer source-bound evidence -> src/controller.ts:300-307 verifies source existence/integrity via context.read, exact quote inclusion and owner-kind compatibility -> failures caught at :704-707 before runActivity :698.
# Context verification consumer is src/context.ts:197-253. This proves the early rejection path statically; no sourceId-integrated judgment execution was observed.
#
# jev_context_16 IMPLEMENTED_STATIC
# Producer changed disk record after inventory -> context.read src/context.ts:346-350 rereads through :240-253 and :197-232 -> src/controller.ts:305 citation preparation or :725 tool read refuses current bytes.
# No cache substitutes for record verification. tests/context.test.ts:108-134 supplies lower-level rejection intent; list-then-change-then-tool sequence remains unexecuted.
#
# jev_context_17 IMPLEMENTED_STATIC
# Producer archived strings -> controller.ts:290,726 presents provenance-not-truth/permission; native owner commands are only recognized at :655-673; read handler does not call approval setters.
# No archived read/citation path installs continuation or approvals; the existing gates remain state-bound (gates.ts:1019-1053). The misleading current-task provenance assertion is separately recorded in jev_context_14; it is not proof of an authority bypass. The combined archived-instruction scenario remains unexecuted.
#
# jev_context_18 IMPLEMENTED_STATIC
# Producer src/controller.ts:324-333 captures chronological owner sources -> src/activities.ts:795-831 preserves continuation, accumulates amendment with invalidation, records pending replacement or unclear hold -> controller.ts:721 prints state.task.request as current objective.
# Context calls skip updateOwner at controller.ts:693 and tool-call owner-update trigger :829-831; list/read do not reclassify or clear holds. Supporting continue/amend test intent: tests/controller.test.ts:1755-1789; full classified-history matrix remains unexecuted.
#
# jev_context_19 IMPLEMENTED_STATIC
# Producer earlier task snapshots persist on disk (src/context.ts:321-335) -> task replacement uses src/state.ts:515-518 clearWork -> src/controller.ts:719-726 reads archive independently, without importing archived approvals into workflow state.
# Archive metadata remains data. Current task authority is read from state by gates.ts:1019-1053, not from inventory. Cross-task archive scenario remains unexecuted.
#
# jev_context_20 UNVERIFIED
# Native producer src/guidance.ts:180-187 -> src/controller.ts:736-744 registers run(contextTool); ordinary gate consumers treat native context and write xd://jev_context as nonmutating (gates.ts:57,191,981-986), so neither requires action judgment.
# The host's write-device dispatcher/argument-validation wrapper is outside this inspected implementation. tools/live-smoke.ts:728-731 documents xdev normalization, not proof that context result/error/hold equivalence passed. Strict inequality is independently proven in jev_context_23.
#
# jev_context_21 UNVERIFIED
# Native producer src/controller.ts:678 and :710 returns DISABLED_OUTCOME :194-197 with enabled=false/skipped=true before archive access; owner capture also returns early at :325 and :656.
# The write-device path must invoke that same registered executor through the external host dispatcher; no disabled context xdev execution was observed. Ordinary boundary bypass alone (:813) does not prove the logical tool result.
#
# jev_context_22 IMPLEMENTED_STATIC
# Producer owner mode command src/controller.ts:571-585 replaces ephemeral state and clears transient routing data without deleting archive -> context list/read :719-726 loads preserved sources but never restores findings/approval.
# Supporting session reset intent: tests/controller.test.ts:1854-1868,1905-1925; archived three-kind continuity across off/on remains unexecuted.
#
# jev_context_23 DEFECT_STATIC
# Native context is read-only via src/gates.ts:57 -> autonomy/runtime.ts:1200,1273-1274 permits safe observation; ordinary mode command is refused at src/controller.ts:558-560.
# Write-device context is missing from autonomy/runtime.ts:81-94 SAFE_DEVICES -> :1195-1198 classifies it consequential -> :1313-1315 rejects it as an unknown coordination route. Thus strict native/write inspection differs before archive access. No strict live context run was executed.
#
# jev_context_24 IMPLEMENTED_STATIC
# Producer each authentic input src/controller.ts:655-662 calls captureOwner -> :331-333 increments the maximum recorded owner sequence -> src/context.ts:92-103 includes sequence in identity -> :305-314 sorts chronological records -> controller.ts:719-726 exposes both.
# Supporting archive sequence intent: tests/context.test.ts:70-87. Duplicate native prompt suppression at controller.ts:781 is separate from a fresh interactive event; two real interactive turns remain unexecuted.
#
# jev_context_25 IMPLEMENTED_STATIC
# Producer invalid quote src/controller.ts:306 throws -> :704-707 returns kind invalid -> src/state.ts:329-330 creates no finding -> corrected call reenters controller.ts:695 prepareContext and can reach :698 runActivity.
# The archive itself is not modified by selecting a corrected quote; context.ts:346-350 supplies original bytes. No citation-error duplicate cache exists in that preparation path; end-to-end corrected judgment remains unexecuted.

# Source register
# S:PRD = PRD.md FR-57, FR-67 through FR-72; Constraints; Implementation map rows Trusted context archive, Output and finding retrieval, Session mode.
# S:README = README.md sections A refusal holds work until a repair or a proven resolution; Approvals bind to bytes and revisions; Trusted context; Owner follow-ups are classified, not assumed.
# S:CATALOG = src/guidance.ts CONTEXT_DESCRIPTION and jev_context parameter declaration (documented public contract only, read before audit).
# S:OWNER = Delegated assignment and tool-specific owner request in this session: list/read, original finding JSON/refused invocation, authentic provenance/digest integrity, missing/corrupt records, evidence not truth/permission, objective updates, gate-independent inspection, disabled behavior, native/write equivalence and strict behavior.
# S:GHERKIN = https://cucumber.io/docs/gherkin/reference/ (English Feature, Scenario Outline, examples, tags and comments syntax).
# Open questions
# GAP-1: The public context archive contract does not define protection against an actor who can rewrite all archive content and recompute every digest; the parent/owner must define any stronger authenticity threat model. FR-68 and README explicitly do not authenticate source claims.
# Assumptions
# None.
