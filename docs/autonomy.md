# Autonomous Jev-driven development

This reference describes an optional module that is activated explicitly and is not part of the ordinary addon. The package manifest loads only `src/index.ts`; an ordinary session registers the ordinary controller, ignores stray `JEVSTICE_AUTONOMY_*` locators and imports nothing under `autonomy/`. The module has one activation path: `bun run autonomy` starts `autonomy/driver.ts`, which launches the supervised child with `autonomy/index.ts` as its explicit extension entry. The Linux, cgroup, systemd, SQLite and supervisor prerequisites below belong to that module alone.

Implementation: the opt-in coordinator, private SQLite ledger, whole-executor scope containment and Bun supervisor are present. The module's files are `autonomy/index.ts` (strict-only entry, loaded by the supervisor rather than the manifest), `autonomy/runtime.ts` (coordinator, workflow and `jev_autonomy`), `autonomy/store.ts` (private SQLite authority), `autonomy/scope.ts` (Linux scope containment) and `autonomy/driver.ts` (supervisor CLI). Full acceptance remains open: post-compaction completion and inherited-effect reconciliation stayed unapproved in real trials. A complete simple objective passed, but those two nonterminal outcomes are not successful completion. Ordinary sessions retain the normal-mode continuation rules in the README. FR-57 through FR-66 in [PRD.md](../PRD.md) define the strict contract and remaining verification.

## 1. Introduction and goals

The owner supplies an objective once. The executor develops the solution, while Jev decides every important choice exposed at the execution boundaries. Development continues without requiring the owner to approve requirements, plans, repairs or subsequent sessions. The owner can still stop or redirect the work. These goals come from PRD sources S33-S35 and S40-S41.

"100%" means that no important visible decision executes without a usable, current Jev verdict. It does not mean perfect judgment, access to private reasoning, unlimited spending, or progress while the judge, executor or storage is unavailable. Continuous operation means automatic progress, recovery and scheduled retry when prerequisites permit it; otherwise the run preserves its state and waits.

## 2. Constraints and invariants

- Autonomous enforcement is an explicit opt-in through the module's own CLI and entry; the package manifest never loads it. Normal mode retains its existing bounded continuation and owner-override behavior.
- In autonomous mode, refusal limits, judge outages, `/jev-continue` and approval-like text cannot substitute for Jev approval. The owner may explicitly stop autonomy and return to normal mode, but that transition does not retroactively approve work.
- Requirements, plans, implementation choices, consequential invocations, recovery strategies, developmental session transitions and completion require decisions. Previously exempt publication, including a push, is consequential in this mode. Read-only evidence gathering and execution of an already approved deterministic transition do not create a new business decision. Safety cancellation is owner-authorized and never waits for Jev.
- Unknown effects remain consequential. Every actual payload must fit the inspected bounds; references and truncated code cannot stand in for executed bytes.
- Jev receives explicit context on every call. A digest identifies context but does not communicate its contents.
- Only one executor may own a run or overlapping canonical writable project roots. No side effect starts before its approved intent is committed durably.
- A restart preserves records, not automatic permission to trust changed files or old execution acceptance.
- Execution outside the bound strict context is refused, including delegation whose child effects cannot receive equivalent authorization. Inherited environment text, a child session or a fork does not independently grant ownership.
- No new workflow framework, broker or database package is required. Bun is already the runtime; `bun:sqlite` is built in. [B1]

## 3. Context and scope

The module coordinates one owner-authorized objective within its canonical writable project roots. It uses the existing judge adapter and typed activities; it does not turn Jev into a command generator. The executor supplies evidence, alternatives and proposed invocations. Jev returns typed decisions, not invented explanatory prose.

The extension enforces tool boundaries inside OMP. A small Bun supervisor owns process lifetime and session rotation through OMP RPC. A preconfigured process manager is required if the supervisor itself must restart after exit or machine reboot. Installing that service is a deployment action, not an implicit consequence of enabling the extension.

This design does not provide distributed workers, an OS sandbox, authenticated evidence, arbitrary remote storage, or exactly-once external effects. Those guarantees do not follow from a local judge gate or a database transaction.

## 4. Solution strategy

Keep normal-mode policy intact and add a strict autonomous policy around the existing boundaries. Use one local SQLite ledger as the authority for autonomous runs; preserve OMP custom entries as references into that ledger. Keep continuation inside live sessions separate from process supervision.

The installed host documents native custom-entry reconstruction, but its extension API returns `void` from `appendEntry`. The installed implementation can suppress append failures, does not fsync completed entries, and does not expose a durable-write acknowledgment to extensions. Native journal entries alone therefore cannot prove that an autonomous intent was committed before execution. [H1, H2, O1]

This explicitly refines pending FR-41 for autonomous runs: the native journal identifies a run and its checkpoint, while committed autonomous state comes from the run ledger. Normal-mode native restoration remains a separate pending requirement. A journal projection cannot create or restore an approval absent from the ledger.

## 5. Building block view

| Block | Responsibility |
| --- | --- |
| Existing controller and activities | Preserve current tools; bind autonomous judgments and invocations to the active run, task, revision and policy. |
| Autonomous coordinator | Select the unmet stage, request executor proposals, assemble explicit judge context, enforce strict policy and choose the next transition only from approved outcomes. |
| Run ledger | Commit state, decisions, artifact bytes, invocation intents/results, retry deadlines and executor ownership atomically. |
| Existing OMP host | Execute tools, emit results, compact context and carry extension-origin messages during a live session. |
| Bun supervisor | Launch and observe the bound child, recover interrupted runs, request approved lifecycle transitions and relaunch after process loss. |

The implementation reuses `judge.ts`, activity validation, artifact hashing and the host adapter. The supervisor exposes only its fixed lifecycle CLI and a restricted OMP RPC channel; it is not a generic RPC or shell proxy.

## 6. Runtime view

### Development and continuation

1. The supervisor validates the configured authorization envelope, storage and host capabilities, then commits a run with its objective and policy. It binds the child to the run identifier and executor epoch outside prompt text.
2. At session startup, the extension loads that committed record and verifies the main-session/run/ownership binding. It registers the per-request autonomous context channel, commits a pending wake identifier and deadline, then requests an internal custom wake for the next unmet stage. A child cannot acquire ownership merely by inheriting the launch environment.
3. The executor proposes requirements, a plan, an action or a recovery choice through the existing typed activities. The coordinator includes the actual relevant context and asks Jev.
4. A current usable verdict is committed with its exact input digest and dependencies. Before a consequential invocation, the complete payload is checked again against current state and committed as an execution intent.
5. OMP executes the invocation. Observed results, failed executions and file changes advance or invalidate the appropriate revision-bound evidence. A failure does not prove that no effect occurred.
6. At a stop boundary, missing evidence directs observation; an established defect directs repair; completed stages advance through the approved workflow. Completion requires fresh business and architecture acceptance and a completion verdict. External delivery additionally requires the applicable current artifact review.

The coordinator derives instructions from typed outcomes and unmet obligations. It cannot manufacture Jev explanations, select a different goal, or treat repeated rejection as approval. A stalled executor may propose a materially different evidence or repair strategy; Jev must approve it before consequential execution.

### Waiting and termination

A retryable transport failure schedules a persisted retry with backoff. An identical substantive refusal is not resent until its material changes. Exhausted progress or resource limits preserve a waiting state and its reason; they do not release a boundary. The run terminates only as completed, cancelled, or an explicitly judged infeasible outcome, rather than declaring unfinished work complete. A requested wake is not a started turn: commit its run, epoch, main-session generation, identifier, pending status and deadline before calling the host. Confirm it from the matching `agent_start` or `turn_start`; when events carry no wake identifier, require exactly one pending wake in that bound idle session. A missed deadline persists a waiting reason and triggers host-activity reconciliation, not blind repeat. An unsolicited or late event cannot acknowledge another wake.

A timeout cannot authorize a second wake in the same session generation until the previous request is proven unable to start. If its status stays uncertain, keep waiting or fence the old session before an approved generation change. A new generation prevents a late old start event from confirming a newer wake.

A stop received through the supervisor's operator-control channel immediately closes admission, cancels queued wakeups and requests abort of active work, without waiting for Jev. Commit cancellation before acknowledging it as durable; restart then preserves that state. If the commit fails, still abort and suppress automatic relaunch, report the storage failure and do not claim durable cancellation. Existing effects are still reconciled; stopping does not imply rollback or successful completion.

### Recovery and session rotation

Before compaction, rotation or teardown, commit the checkpoint and exact artifact bytes. After startup, verify the database, project root, schema/policy compatibility, selected session branch, stored blob hashes and current file manifest. Preserve unaffected requirements and plan details; invalidate dependent decisions when their inputs changed. Prior execution acceptance and completion require fresh observation after restart.

An invocation intent without a recorded result is **unknown**, not failed or unexecuted. Observe the working tree and, where applicable, the external provider. Jev chooses among supported recovery alternatives using that evidence. Retry an external effect only when its provider idempotency contract or observed state proves the retry safe. If the effect cannot be reconciled, preserve the blocked run; do not repeat it blindly.

Lease expiry is only a failure detector. It does not fence an already running process or remote effect. Before takeover, the supervisor must establish that the prior child cannot start further actions and reconcile outstanding effects. Every later commit and admission checks the new epoch; stale answers and old workers cannot authorize new work. Ownership admission also atomically rejects a second active run with the same or overlapping canonical writable project roots. Separate run identifiers are not isolation; disjoint worktrees can run independently only within their own authorized roots, with shared external effects still subject to reconciliation.

## 7. Deployment view

Use one user-local database for the module, defaulting to `~/.omp/agent/jevstice/autonomy.sqlite`, with restrictive permissions and explicit project-root bindings. Keep it off network filesystems and out of executor-managed project artifacts. The store uses `journal_mode=DELETE` and `synchronous=EXTRA` and verifies their effective values. SQLite's documented guarantees still depend on functioning OS, filesystem and hardware synchronization. [Q1, Q2]

SQLite owns recovery of its rollback journal. Do not delete journal files or copy a live database as though its main file were a complete backup. Use a consistent SQLite backup or a fully closed store. Fail closed on storage errors, unsupported schema, missing/corrupt required blobs or incompatible host capabilities.

The supervisor launches OMP in RPC mode with the checkout explicitly loaded and a committed run/epoch binding. Only a fixed read-only and lifecycle command subset is exposed. Developmental lifecycle commands carry a committed Jev decision; safety abort and stop do not. Raw RPC `bash`, arbitrary host-tool installation and unreviewed control commands are not forwarding routes. This driver does not assume that a deferring ACP bridge starts agent-initiated turns. The supervisor observes committed wake acknowledgments and RPC/process liveness rather than treating a void API return as successful scheduling. [H8]

Credentials remain in the existing resolver/environment path. Never serialize resolved keys or full secret-bearing environment/configuration objects into the ledger, native journal or continuation messages. The owner supplies credentials and the initial authorization envelope through deployment configuration; Jev cannot grant authority to spend money or perform external actions the owner has not authorized.

### Running the supervisor

These requirements belong only to the optional module. The strict supervisor requires Linux `/proc`, cgroup v2, `systemd-run`, a reachable systemd user manager and a `systemctl` that can kill an entire scope. An unavailable mechanism refuses the run; process-group signalling alone is not a containment fallback. An ordinary session never loads this Linux/SQLite runtime and needs neither the supervision scope nor the private ledger.

Activation is explicit and has no environment trigger: `bun run autonomy` starts `autonomy/driver.ts`, which validates the envelope and launches OMP with `autonomy/index.ts` as the extension entry. An inherited `JEVSTICE_AUTONOMY_STORE`/`JEVSTICE_AUTONOMY_RUN` pair in an ordinary session activates nothing, grants no ownership and loads no module file.

The owner supplies an objective text file and a JSON policy with existing canonical `roots`, effect classes (`project`, optionally `publication`) and positive integer limits: `maxJudgeCalls`, `maxExecutorCalls`, `maxRuntimeMs`, `maxContextBytes`, `maxArtifactBytes`. The objective, policy and ledger belong outside the writable project roots. The README gives a complete policy example.

```sh
bun run autonomy start --objective /srv/jev-control/objective.txt --policy /srv/jev-control/policy.json
bun run autonomy status
bun run autonomy resume --run RUN_ID
bun run autonomy stop --run RUN_ID --reason "operator stop"
```

`--store` selects the private database; `start` and `resume` also accept `--omp` and `--model`. The supervisor runs in the invoking process. A separate operator command or an attached controlling terminal can stop it; executor output is not an operator channel. A preconfigured process manager is needed to relaunch the supervisor after its own death. Stop does not roll back effects and does not claim an unknown effect succeeded.

The call limits count attempts and provider requests, not approvals or completed tasks. A transport failure consumes a judge attempt and schedules backoff while the initial envelope still permits another attempt; exhausted limits remain durable waits. Changing the policy file cannot expand an existing run's committed envelope.

## 8. Crosscutting concepts

### State and artifact ownership

Use a stable run identifier independent of OMP session identifiers. A minimal schema has `runs` for the current checkpoint/ownership and canonical writable roots, `events` for decisions and invocation lifecycle records, and `blobs` for immutable content addressed by SHA-256. One transaction commits a state transition, its events and any new required blobs. The same authority serializes conflicting root-ownership admission across runs. The checkpoint is a projection of those same committed events, not a second authority.

Persist the original objective and authoritative corrections; task version; requirements and dependencies; approved plan sections and exact bytes; policy version; work revision and relevant file hashes; open findings; refusal classes and retry deadlines; selected judge input and typed outcome; current session/branch references; pending invocation payload and status; observed verification evidence; and cancellation/completion state. Artifact identity is the hash of exact bytes, not a session-local name or a summary.

Checkpointing compares tracked live bytes before replacing their recorded digests. A changed dependency advances the work revision and invalidates acceptance and completion; a changed plan also loses its plan approval. Planned files produced through a native Bash invocation enter the same manifest as direct writes. Recorded absence remains a dependency, so later appearance cannot silently inherit old evidence. A judgment compares live dependency observations before and after the network call. Reconciliation may judge an already-changed unknown effect, but its selected observations must remain unchanged during that judgment.

Automatic acceptance supplements the recent-action window with hash-checked current project bytes from the existing immutable artifact store. Runtime-owned quotes carry actual bootstrap/wake observations, workflow checkpoint metadata and native tool-result counts. The counts describe the observed native stream, not OS-wide absence of activity, and workflow events do not replace project implementation or verification evidence.

A new session or an unobserved dependency change clears old execution observations. Acceptance requires fresh execution in the current binding; current code bytes alone cannot satisfy it. A refused wait retains only the old action digest for comparison, not execution authority, so clearing a stale action window cannot itself wake or approve unchanged refused material. A genuinely new observed result can change that material without a project mutation.

A native custom entry carries the run identifier, committed sequence and checkpoint digest. Missing or stale native references can be repaired from the ledger; they cannot overwrite newer committed state. A fork does not inherit execution ownership. Attaching another session requires a checked, committed ownership transition. Compaction summaries are executor context aids, not approval records. [H3, O1]

### Judge context and stale results

Each judge request includes the owner objective and relevant corrections, the served obligation, applicable approved plan sections, observed evidence with provenance, current open findings, the alternatives or complete invocation, and the run/task/revision/policy binding. Persist that exact selected input with the result.

After the network round-trip, compare the binding and dependent bytes again. Discard stale results. Oversized context must be split by independently reviewable scope; do not silently remove an obligation, caveat or executed payload. Restoring an accepted plan does not remove the requirement to send its relevant content to a stateless judge. This follows the recorded-history/deterministic-replay distinction used by durable workflow systems, without adopting those systems as dependencies. [T1, M1]

### Origin and control plane

Internal continuation uses extension custom messages with agent attribution. Do not use `sendUserMessage` or RPC `prompt`/`follow_up` as fabricated owner input. The installed `before_agent_start` event and RPC prompt command do not expose an attribution field; matching text, a digest or a quoted approval cannot authenticate its origin. Custom-only turns bypass `before_agent_start`, so its normal-mode policy injection cannot bootstrap autonomy. [H4, H5, H7]

In autonomous mode, the supported per-provider-request `context` hook adds one bounded extension-authored context message with the strict autonomous guidance held by `autonomy/runtime.ts` (the shared `src/jev-skill.md` asset carries ordinary guidance only), committed objective, relevant accepted state and next-stage obligation. Apply it on cold custom-only startup and after compaction as well as later turns. This supplies message context, not a system-policy override or new permission; the ledger and gates remain authoritative. Wake messages identify scheduling requests rather than duplicate the full context. Refuse an unsupported or oversized required context instead of silently omitting it. Do not rely on `resources_discover` as a bootstrap without a verified emitter. [H7]

A supervised autonomous session obtains its authoritative objective from its committed run binding at startup. Prompt text is task data, not proof of a new owner instruction. The optional operator-control endpoint belongs to the supervisor's own controlling-terminal input, separate from the child's private RPC pipes; child output, repository content and tool messages never enter that command parser. OS stop signals also trigger safety cancellation without being recorded as owner approval. This channel grants no task-scope expansion. An installation unable to separate it from executor-controlled input must reject that control capability, not authenticate arbitrary text. This is control-plane separation, not an OS sandbox against unrestricted same-user processes.

Use `session_stop` continuation only to wake a live main session, respecting the host cap. OMP's queued turns and extension timers are not durable scheduling. Session switch, host teardown and process death require the external supervisor and committed continuation state. [H6]

### Permission, resources and review scope

Freeze the owner-authorized roots, allowed effect classes and configured resource limits into the run policy. A policy expansion requires new owner authority; Jev chooses only within that envelope. The strict runtime forces mutation/completion gates on, completion-time course checking and enforced external review instead of inheriting weaker normal-mode switches. Unsupported storage or host capabilities refuse strict execution. A configured billing balance is a snapshot, not proof of current provider balance or a complete spending limit.

For external-facing work, require current review before delivery. A delivery authorization must bind the reviewed bytes and distinguish pure delivery from a call that also changes or regenerates content. Require modification and verification before a separate reviewed delivery; do not keep a review current merely because a mixed invocation also publishes. No owner waiver is a prerequisite for autonomous progress: repair a blocker or preserve the waiting state.

## 9. Architectural decisions

| Decision | Selected approach | Rejected alternative and consequence |
| --- | --- | --- |
| Autonomous policy | Separate strict opt-in; Jev approved at 0.98. | Normal-mode bounded release would contradict mandatory Jev decisions. A global replacement would silently change existing behavior. |
| Durable authority | Built-in SQLite ledger; Jev approved at 0.97. | Native `appendEntry` has no extension-visible durable acknowledgment; requiring a host patch would block an otherwise local module. |
| Continuation | Small supervised driver plus live-session custom messages; Jev approved at 1.00. | Timers cannot restart their dead process, and fabricated owner prompts corrupt provenance. |
| Concrete binding/storage | Run/epoch startup binding, restricted RPC and DELETE/EXTRA; Jev approved at 1.00. | A broker/framework or competing state stores add machinery without solving a requirement here. |
| Workspace ownership | Fence overlapping canonical writable roots across active runs; Jev approved at 0.98. | Per-run ownership alone admits two independently approved executors against the same old workspace state. |
| Cold-turn context | Per-provider-request autonomous context message, not a presumed prompt hook; Jev approved at 1.00. | Custom-only turns do not emit `before_agent_start`, so that hook cannot supply cold-start guidance. |
| Wake lifecycle | Commit pending wake and reconcile a matching start event or missed deadline; Jev approved at 1.00. | `sendMessage` returning void does not confirm a turn started or a wake persisted. |
| Owner cancellation | Separate operator channel and immediate safety abort outside the Jev gate; Jev approved at 1.00. | Requiring a judge verdict before stopping would continue work during a judge outage. |
| Execution context | Refuse unbound delegation; Jev approved at 1.00. | A parent instruction or inherited environment does not authorize unseen child effects. |

These design consultations establish the selected mechanisms; they are separate from implementation acceptance. Normal-mode permission after an unresolved decision does not constitute autonomy approval, and strict runs have no such escape.

## 10. Quality requirements and acceptance scenarios

The rows below define the acceptance scenarios. `tests/autonomy.test.ts`, `tests/autonomyStore.test.ts`, `tests/autonomyScope.test.ts` and `tests/autonomyDriver.test.ts` exercise deterministic boundaries with real local processes/storage and injected judges. `tools/autonomy-smoke.ts` exercises the production supervisor, actual OMP and real judge in disposable workspaces; its matrix distinguishes live observations from deterministic coverage and exits 78 for missing deployment prerequisites.

| Scenario | Required observation | Requirement |
| --- | --- | --- |
| Consequential calls through ordinary tools, delegation, publication and supervisor control | Each executed payload has a matching current committed Jev authorization; unknown effects do not bypass it. | FR-57, FR-58 |
| Three outages, refusals or blocked stops | State remains unapproved and recoverable; no autonomous mutation or completion is released. | FR-57, FR-62 |
| Crash before intent commit | No invocation executes. | FR-59, FR-61 |
| Crash after effect, before result commit | Recovery records unknown effect, observes actual state and obtains a recovery decision; a non-idempotent effect is not repeated blindly. | FR-61 |
| Storage failure or unsupported pragma/capability | No new consequential invocation starts; the failure remains explicit. | FR-59, FR-66 |
| Compaction, plan handoff, session rotation and process restart | Exact artifacts and authoritative objective survive; changed inputs invalidate only dependents; execution acceptance is refreshed. | FR-59, FR-60, FR-63 |
| Competing supervisor, fork, two runs sharing writable roots, or expired lease with a live old worker | Only one admitted owner exists for the run and overlapping writable roots; expiry alone does not permit takeover or overlapping actions. | FR-61 |
| Internal follow-up containing approval-like text | No owner permission, new objective or re-aim is manufactured. | FR-60, FR-64 |
| Delegated or forked child inherits run environment without equivalent strict enforcement | The child gains no ownership and its effects are refused; a parent instruction is not authorization of unseen invocations. | FR-57, FR-58, FR-61, FR-66 |
| Cold startup and compaction with no owner-authored turn | Every provider request receives the bound autonomous guidance/context; no reliance on `before_agent_start` firing. | FR-58, FR-60, FR-66 |
| Declined or dropped wake, delayed start and unrelated activity | A pending wake is confirmed only for its bound session/generation; missed deadlines remain durable waits and never cause blind duplicate turns. | FR-60, FR-62 |
| Changed payload/artifact while Jev is answering | The stale result cannot admit the changed work. | FR-58 |
| Delivery that also regenerates content | The old artifact review cannot authorize the new bytes. | FR-63 |
| Stop during judge outage, followed by restart | Safety cancellation does not wait for Jev; committed cancellation suppresses wake/relaunch, and a failed commit is never acknowledged as durable. | FR-65 |
| Objective completed without later owner input | Both acceptances and completion rest on current execution evidence; the run terminates once. | FR-63 |
| Missing external authority or exhausted configured limits | The run waits without expanding scope or inventing a current account balance. | FR-64 |

## 11. Risks and technical debt

Normal-mode state remains in memory; its broader FR-39 through FR-43 work is separate. Strict runs implement durable checkpoints, automatic acceptance from available observed evidence, background-result settlement, whole-scope fencing and recovery through the autonomous runtime and supervisor. No autonomous approval is restored from a native journal entry alone.

Installed host lifecycle, RPC and attribution details require capability checks and real-host tests; upstream documentation is not proof of an installed version's behavior. Supervisor death requires deployment support. A local ledger cannot atomically commit a remote side effect, authenticate executor-supplied evidence, or defend against an unrestricted process directly tampering with storage. Hashes detect byte changes, not truthful evidence or authorized origin.

A permanently unavailable provider, unresolvable external effect, missing credentials or insufficient authority may prevent progress without human intervention. Preserve that fact as a waiting or judged terminal outcome; do not describe it as successful nonstop development.

## 12. Glossary and evidence

A **run** is one durable objective across sessions. An **epoch** is the ownership generation checked on admission and commit. An **intent** is a committed authorization to attempt one exact invocation; it is not evidence of execution. A **projection** is reconstructible state or a reference derived from the authoritative ledger.

### Primary references

- **O1:** [OMP extension state patterns](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extensions.md), "Session and state patterns": `appendEntry` plus reconstruction from `getBranch()`.
- **B1:** [Bun SQLite](https://bun.com/docs/runtime/sqlite): built-in `bun:sqlite`, synchronous API and transactions.
- **Q1:** [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html), introduction and hardware assumptions: all-or-nothing transactions and the storage assumptions behind them.
- **Q2:** [SQLite synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous), EXTRA: directory synchronization after unlinking the rollback journal in DELETE mode.
- **T1:** [Temporal workflow execution](https://docs.temporal.io/workflow-execution), replay: generated commands are checked against recorded event history.
- **M1:** [Microsoft Durable Task constraints](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-code-constraints): event sourcing and deterministic orchestrator replay.

### Installed-host observations

The following paths refer to the installed OMP package's `src/` inspected on 2026-10-30, not a promise about every OMP version.

- **H1:** `extensibility/extensions/types.ts`, `ExtensionAPI.appendEntry`: the method returns `void`, not a durable-write acknowledgment.
- **H2:** `session/session-manager.ts`, `SessionManager` durability contract and `#appendToCurrentSessionFile`: completed entries reach the OS synchronously without fsync, append failures can remain non-throwing, and deferred backends need later confirmation. `session/session-storage.ts`, writer/flush contracts, documents flush without fsync.
- **H3:** `session/session-manager.ts`, `branch`, `branchWithSummary` and `discardEntryDurably`; `session/artifacts.ts`, artifact allocation: tree branches need durable leaf markers and artifact names are session-scoped. Jevstice's `src/state.ts` and `src/controller.ts` already compute/recheck SHA-256.
- **H4:** `extensibility/extensions/types.ts`, `BeforeAgentStartEvent` and `ExtensionAPI.sendMessage`: the event lacks attribution; custom messages support `nextTurn` and `triggerTurn`. The host's custom-message path defaults to agent attribution. The current `BeforeAgentStartEventResult.systemPrompt` is the supported policy result, not `systemPromptAppend`.
- **H5:** `modes/rpc/rpc-types.ts`, `RpcCommand`: prompt commands lack attribution; raw bash and lifecycle commands exist. This is a control-plane surface the supervisor must restrict.
- **H6:** `session/agent-session.ts`, `#emitSessionStopEvent` and session-transition queue handling; `extensibility/extensions/runner.ts`, timer teardown: switches drop queues, stop continuation is cap-limited and in-process, and teardown clears extension timers.
- **H7:** `extensibility/extensions/types.ts`, `ContextEventResult` and the `context` handler; provider `transformContext` dispatch: a per-request message context is supported. Custom-only `#promptAgentInitiatedMessage` calls do not prepare an ordinary user prompt and therefore bypass `before_agent_start`.
- **H8:** `session/agent-session.ts`, `#dispatchCustomMessage` and `#promptAgentInitiatedMessage`; `modes/runtime-init.ts`, extension action binding: idle RPC startup can schedule a custom turn, but `sendMessage` discards its internal start result. Deferred clients and declined startup do not provide a durable wake acknowledgment.
