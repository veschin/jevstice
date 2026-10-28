# Jevstice - Product Requirements

## Purpose and scope

Jev guides an OMP executor from the owner's high-level objective through requirements, planning, execution and acceptance. The extension enforces decisions at visible tool boundaries rather than relying on voluntary consultation. It reuses the TypeSafe typed-decision API and cannot observe private reasoning or act as an OS sandbox. [S34-S36]

The executor is the omp agent doing the work. Jev is the judge reached through the TypeSafe API. A simple task does not inherit development gates merely because it has a user prompt. [S2, S13]

## Functional requirements

Each requirement specifies one independently observable behavior. The owner-request coverage was checked with Jev in separate preparation and execution batches; the planning-understanding clause was additionally checked as an independent claim. [J1, J2, J3]

Each entry that carried a `review required` mark was put to its own Jev review, and the mark was removed only by a recorded verdict at or above the approval floor (`POLICY.minConfidenceToApprove` 0.6 for a choice, 0.8 for a probability). The verdicts are recorded below.

The current autonomous-execution mandate [S34-S36] supersedes the former mandatory owner-confirmation and emergency-release behavior. Historical verdicts below describe the earlier requirements; they are not fresh validation of the revised policy.

### Review record

| Entry | Verdict | Entry | Verdict |
| --- | --- | --- | --- |
| FR-20 | established, 0.86 (interpretative readings: the need requires the class of the refusal and the next action) | FR-24 | established, 0.73 for the topic list the executor submits; the variant that parses a topic block out of the artifact was rejected at 0.20 and 0.46 and is not implemented |
| FR-21 | established, 0.69 | FR-25 | established, 0.92 |
| FR-22 | established, 0.89 | FR-26 | established, 0.62 |
| FR-23 | established, 0.92 | FR-27 | established, 0.79 and 0.79 |
| FR-28 | established, 0.70 and 0.67 (new owner requirement, S26) | | |

### Triage and preparation

- **FR-01 - Narrow topics.** WHEN a task requires specialized expertise, triage SHALL identify task-specific topics. [S1; J1:1]
- **FR-02 - Simple-task decision.** WHEN a task is simple, triage SHALL explicitly say that deeper development activities are unnecessary. [S2; J1:2]
- **FR-03 - Search relevance.** WHEN the executor submits web-search candidates with evidence and a proposed reason for each, Jev SHALL select a relevant candidate-and-reason pair. [S2, S3; J1:3]
- **FR-04 - Requirement decomposition.** DURING planning, the executor SHALL break the owner's request into individual concrete requirements. [S4; J1:4]
- **FR-05 - Understanding check.** DURING planning, Jev SHALL check each proposed requirement against the original objective and actual owner corrections; necessary implementation choices MAY be inferred by the executor and judged without a second owner message. [S4, S34]
- **FR-06 - Complete requirement set.** BEFORE planning, Jev SHALL establish that the proposed delivery covers the objective without contradictions or unrelated goals; suspected omissions SHALL be settled rather than silently treating uncertain answers as absence. [S5, S34]
- **FR-07 - Native plan mode.** WHILE omp's plan mode is active, the extension SHALL connect plan review to the actual host plan-mode boundary. [S6; J1:7]
- **FR-08 - Flexible consultation.** WHEN consulting Jev on its own question, the executor SHALL be able to choose Choice, Score, or Boolean. [S6; J1:8]
- **FR-09 - Consultation guidance.** The extension SHALL teach the executor how to use the flexible Jev consultation to obtain useful decisions. [S6; J1:9]
- **FR-10 - No per-prompt catalog.** The extension SHALL NOT automatically classify tasks and select generic topics on every user prompt. [S13; J1:10]

### Execution and review

- **FR-11 - Interval course check.** WHEN the configured number of visible implementation actions is reached, the extension SHALL request a course check with Jev. [S7; J2:1]
- **FR-12 - Completion-only course check.** WHEN configured for completion-only checking, the extension SHALL defer course checks until implementation ends. [S7; J2:2]
- **FR-13 - Uncertainty consultation.** WHEN uncertain during implementation, the executor SHALL be able to initiate a Jev consultation without waiting for a scheduled check. [S7; J2:3]
- **FR-14 - Business acceptance.** AT acceptance, the executor SHALL defend its work before Jev against the owner's business needs. [S8; J2:4]
- **FR-15 - Architecture acceptance.** AT acceptance, the executor SHALL defend its work before Jev from the architecture perspective. [S8; J2:5]
- **FR-16 - Developer review.** WHEN reviewing a checkpoint, commit, or diff, the executor SHALL defend the changed work before Jev as a developer. [S9; J2:6]
- **FR-17 - Completion decision.** BEFORE a developed task is reported complete, Jev SHALL check whether the work follows the owner's requirements. [S10; J2:7]
- **FR-18 - Important-decision boundary.** WHEN an important decision requires Jev and the executor reaches an enforceable visible boundary without submitting it, the extension SHALL block that boundary; an unknown `xd://` device SHALL be treated as consequential unless explicitly listed as read-only or a Jev route. [S11, S13; J2:8]
- **FR-19 - Business decision.** WHEN the executor faces a consequential business decision, it SHALL consult Jev with the task context. [S12; J2:9]

### Refusal handling and judge availability

- **FR-20 - Truthful refusal.** A refusal SHALL distinguish invalid input, unavailable judgment, established defects and uncertainty. Recovery guidance SHALL preserve accepted decisions and SHALL NOT invent a defect from a low probability. [S17, S35]
- **FR-21 - Judge availability.** After three consecutive availability failures, the extension SHALL notify the owner and permit continuation of the current request. Unavailable judgments SHALL remain unapproved and disclosed as OPEN.
- **FR-22 - Reconsider instead of repeating.** Refused material and its question set SHALL be recorded per task and decision. An identical resubmission SHALL cost no judge call; unrelated later decisions SHALL NOT erase an earlier refusal budget. [S19, S35]
- **FR-23 - Bounded enforcement.** After three refused submissions or three blocked calls at a boundary, the extension SHALL retain the unresolved decision as OPEN and permit continuation of the current request across inspection, plan, mutation, invocation and completion boundaries. Three blocked stops SHALL permit the following stop. Permission SHALL NOT manufacture Jev approval.

### Review rework

- **FR-24 - Staged plan review.** Jev SHALL review a high-level outline, then one detail per call. A detail SHALL name one complete artifact section, resolved from the artifact itself by a unique heading or exact full text; a substring, ambiguous heading or section changed during judgment SHALL be refused. Finalization SHALL compute the additional material as the artifact minus the approved sections, SHALL refuse overlapping approved sections, and SHALL bind the approval to the exact artifact bytes and task. [S22, S31-S36]
- **FR-37 - Partial plan approvals.** Passing steps SHALL remain approved while rejected steps are revised. A changed detail loses its own approval; a changed outline invalidates its dependent details; a section no longer present verbatim in the artifact SHALL be re-reviewed. Outline, detail and assembly refusal budgets SHALL remain separate; exhausted enforcement SHALL follow FR-23. Any plan revision SHALL invalidate acceptance and completion verdicts recorded for the previous plan.
- **FR-25 - Course checks.** Configured post-execution checks SHALL judge each recent action against the whole approved task. Serving one requirement SHALL NOT require serving every topic. Failed consequential executions SHALL also advance the revision. A successful course check SHALL NOT clear an unrelated developer finding. [S23, S35]
- **FR-26 - Acceptance judged from evidence.** WHEN code is accepted, the extension SHALL refuse the submission before any judge call unless its evidence carries at least one execution item (a command and its output) and at least one static code item (a diagnostic, a diff or a size measurement); the judge SHALL answer per plan topic whether that evidence shows the topic met, naming the evidence it rests on. [S24]
- **FR-27 - Text review tool.** The extension SHALL offer a tool that takes a text and the register rules it must satisfy, splits the text into bounded fragments and puts every submitted rule to the judge once per fragment; for each fragment a rule fails on, the tool SHALL return that rule line as the executor submitted it, writing no prose of its own. [S25]
- **FR-28 - The boundary teaches its own next step.** A refused call SHALL name the missing decision and the owner continuation command. The controller SHALL count blocked calls, notify the owner at the limit, and permit continuation with the finding OPEN rather than indefinitely repeating the gate.

- **FR-29 - Owner re-aim.** A re-aim SHALL quote an actual current owner message, replace the task and invalidate its old requirements, plan and acceptances. It SHALL NOT reuse old exhaustion state or grant execution without a new approved plan. A new direction SHALL NOT silently inherit old permission. [S27, S34-S35]

### Entry and what counts as consequential

- **FR-30 - Request weight read for free.** WHEN a request arrives, the extension SHALL read its text once, locally and before any judge call, and SHALL let it enter the judged workflow only if it names a change to the project or the reading does not recognise it; a request that asks to publish, inspect or verify work that already exists SHALL NOT enter it, and the reading SHALL decide entry only - it SHALL NOT take down the walls of a development task already registered, and the judge, not the reading, SHALL decide how deep an entered request goes. [S28]
- **FR-31 - Capability boundary.** Fully recognized read-only commands MAY pass without a work revision. Unknown executables, quoted executable syntax, substitutions, redirections, write options, opaque code, delegation and mutating devices SHALL remain consequential. Direct tool and device routes SHALL receive equivalent enforcement. [S29, S35]

- **FR-32 - Triage before project inspection.** WHEN a request enters the judged workflow, the executor SHALL call `jev_triage` before inspecting project files, searching the project, or drafting a plan; until triage settles the request, the extension SHALL hold project reads and searches, consequential shell calls, requirement submission and local plan-artifact writes, while allowing required skill reads and task tracking. [S30]

- **FR-33 - Autonomous requirements.** The executor SHALL derive checkable obligations and necessary implementation choices from the owner's objective and submit them to Jev without requiring owner confirmation. [S34]
- **FR-34 - Requirements gate.** Plan-artifact writes and plan review SHALL remain held until coverage reaches 0.6, every requirement reaches its support floor and candidate omissions are settled. Changes to requirements SHALL invalidate dependent approvals. [S31, S34-S35]
- **FR-35 - No mandatory owner loop.** A later owner message SHALL NOT be a prerequisite for requirements or planning. Actual owner corrections SHALL retain authority through the re-aim boundary. [S34]
- **FR-36 - Context continuity.** Requirements and staged/final plan approvals SHALL remain task-bound and survive a native plan handoff only when the artifact digest matches. Pending calls and stale judgment results SHALL NOT approve a different task or revision. [S33-S35]

- **FR-38 - Invocation authorization.** Before a consequential invocation executes, the host SHALL submit its complete payload for Jev authorization unless current-request continuation permission applies under FR-23 or FR-44. Oversized payloads SHALL be refused rather than truncated. Without that permission, quiet/simple requests SHALL authorize only the requested inspection, verification or publication.

- **FR-44 - Owner continuation.** An explicit owner approval through `/jev-continue` or a recognized standalone owner approval message SHALL immediately permit continuation of the current request across all addon gates. Tool arguments, quoted text and extension-originated input SHALL NOT count as owner approval. Changed requests and re-aims SHALL NOT inherit permission. Unresolved findings and refused verdicts SHALL remain recorded without claiming Jev acceptance. Owner source: "всегда должна быть возможность после моего аппрува как юзера, или после превышения всех попыток продолжать работу".


### Session UX improvements (owner-approved, 2026-10-27)

- [ ] **FR-39 - Automatic acceptance.** At completion, the controller SHALL collect observed code and execution evidence, submit missing business and architecture acceptance automatically, and return the unmet obligations without requiring manual acceptance calls.
- [ ] **FR-40 - Owner interruption.** A question or stop instruction from the owner SHALL permit a conversational response without accepting or discarding unfinished work. Consequential actions SHALL remain blocked until the owner resumes or changes direction.
- [ ] **FR-41 - Durable continuation.** Resuming an OMP session SHALL restore its task and accepted decisions from the native session journal. Changed files or plan sections SHALL invalidate only affected plan details; prior completion and execution acceptance SHALL require fresh verification after restart.
- [ ] **FR-42 - Local requirement changes.** A judged owner correction SHALL retain unaffected requirements, outline steps and plan details. Dependent decisions SHALL be reviewed again, and execution SHALL wait for a newly bound complete plan.
- [ ] **FR-43 - Evidence-first recovery.** Missing or unsuitable evidence SHALL return the unmet requirement and its approved verification section, directing the executor to observe that behavior before changing implementation. Only an established defect SHALL direct implementation repair.

These requirements supplement FR-14/15/26 and supersede the full-discard behavior in FR-29/36/37 where an unaffected decision is explicitly retained. Initial status: all five are not implemented; completion requires observed behavioral checks.

## Constraints

- A simple web search must not incur automatic generic classification or the development acceptance gates; the executor may still invoke FR-03. [S2, S13, S14]
- A request that only publishes, inspects or verifies existing work must not cost a judge call or a boundary; the reading that decides this is local and happens before any call. [S28]
- No extension claim may imply that private model thoughts are observable; enforcement applies to visible actions and completion. [S13]
- A required consultation that fails, abstains, or has no usable answer must not count as approval. This retains the repository's fail-closed policy. [S16]
- Calls should occur at purposeful activity boundaries, not as repeated generic feedback. The owner has not prescribed a numeric call budget. [S14]
- This MVP favors the smallest code and tool surface that implements FR-01 through FR-36. [S15]

## Source register

- **S1:** Owner, current conversation: "триаж задачи. если задача требует этого подбор узконаправленных топиков, например (высокая доступность, отказоустойчивость, ui)".
- **S2:** Owner: "если задача простая или не требует такого погружения, триаж должен сказать явно. например поиск в вебе не требует. но там jev может помочь с выборкой результатов".
- **S3:** Owner's comics-search example: "могла результаты поиска показать jev и посоветоваться что релевантно и почему".
- **S4:** Owner: "планирование задачи. разбивка моих требований на конкретные и проверка каждого через jev на понимание моделью относительно оригинального запроса".
- **S5:** Owner: "каждое самодостаточное и в сумме дают итоговое PRD".
- **S6:** Owner: "сделай пару ручек для конкретных вещей типа план мода (настоящая интеграция в план мод), триажа и так далее. и сделай гибкую ручку когда модель сама определяет тип запроса (чойс, скор, булин) и сама обращается к jev (тут суть научить модель общаться с ним и получать пользу)".
- **S7:** Owner: "имплементация задачи с постоянной сверкой курса, раз в N действий или только по завершении. модель должна советоваться когда она не уверена".
- **S8:** Owner: "приемка задачи. модель пытается защитить свою работу перед jev как бизнесово так и архитектурно".
- **S9:** Owner: "ревью чекпоинта/коммита/диффа где модель также защищается но уже как разработчик".
- **S10:** Owner: "модель только через него решала правильно ли она работает не отошла ли она от требований и что делать".
- **S11:** Owner: "я думаю аддон должен блокировать ллм пока она не будет пропускать важные решения через jev".
- **S12:** Owner: "инструмент форсит модель советоваться с jev чтобы он принимал бизнес решения из контекста или лучшие возможные".
- **S13:** Owner approved removing automatic per-request classification/topic selection and stated that the addon can check only visible actions and completion, not private reasoning (current conversation).
- **S14:** Owner: "переделай флоу так чтобы за минимум вызовов у нас было максимум пользы от jev".
- **S15:** Owner: "минимум кода".
- **S16:** Repository `POLICY` in the archived implementation (`src/types.ts` at commit `4c38d74`): judge errors and uncertain verdicts never approve.
- **S17:** Owner, current conversation: "аддон должен давать понять модели что делать с отказом. что это не временная ошибка".
- **S18:** Owner: "если jev недоступен по сети множество раз. надо уведомить пользователя и работать без него вообще".
- **S19:** Owner: "если он доступен но гейтит, надо обдумать качественно и принять меры, а не долбиться в стену".
- **S20:** Owner: "если он гейтит и руинит разработку, модель застряла, то либо модели кардинально надо пересмотреть все, либо остановить сессию как емердженси случай".
- **S21:** Owner, on the submitted edit list (item numbers as given): "2. да 3. да ... 10. запиши" - the judge-unavailable gate step, the attempt and transport limits, and this PRD record.
- **S22:** Owner: "преработка плана чтобы оценка шла по топикам и исключался вопрос дедлока".
- **S23:** Owner: "сверка курса сейчас похожа на фикцию и слишком часто делается, нужны правила когда спрашивать судью о курсе".
- **S24:** Owner: "приемка кода мне не нравится, тоже на фикцию похожа"; earlier in the same conversation: "надо кормить его описанием того что код делает + lsp + какие то статические вещи, может замер код смелла какой то".
- **S25:** Owner: "у джева был инструмент который укажет конкретные проблемы в тексте ... чтобы jev лучший шаблон прописал. целимся в формальную речь без жаргона и максимальную краткость без потери смысла".
- **S26:** Owner, current conversation: "модель не слушается jev, как ты сейчас не понимаешь что тебе делать. исправь это тоже. это одно из требований, адаптация модели к джеву".

- **S27:** Owner, current conversation: "разреши мне вмешаться явно в сесиию и выставлять курс".
- **S28:** Owner, current conversation: "давай улучшим extensions/jevstice чтобы он на всякие мелочи типа «коммить и пуш» не триггерился вообще, также не тригерился на планирование и другие бесполезные штуки".
- **S29:** Owner, the same request, whose instance names the class FR-31 covers: a commit or a push must not trigger the extension at all, and FR-30 alone would still hold one whenever the prompt carries a change word ("закоммить и запушь исправления") or the reading does not recognise it.
- **S30:** Owner, current conversation: "ожидается что модель со мной окнет все пункты сама в ходе триажа."
- **S31:** Owner, current conversation: "давай порог по плану понизим до 0.6".
- **S32:** Owner, current conversation: "разбей планирование на шаги с частичным аппрувом и все получится".
- **S33:** Owner, current conversation: "ты же знаешь что jev не видит и не помнит ничего? нужно явно давать контекст ему причем выбирать что туда пойдет".
- **S34:** Owner: "цель аддона даже самой глупой llm дать возможность делегировать решения в jev. и чтобы jev вел ее по задаче или задачам"; "я как пользователь даю крайне верхнеуровневое решение и больше ничего. а все остальное сделает llm и аддон".
- **S35:** Owner: "ты предполагаешь что модель не будет игнорировать инструмент и будет советоваться но это крайне оптимистично"; "модель глупа она генерирует текст и старается обойти стены вместо решения".
- **S36:** Owner: "не только плана а всего аддона"; "даю тебе добро на мажорные правки"; "не изобретай велосипед. посмотри то что есть и как это можно улучшить".
- **J1:** Jev `requirements_formalization` preparation batch: nine items were not identified as untraceable; its tenth, planning understanding, was rejected and independently checked as J3.
- **J2:** Jev `requirements_formalization` execution batch: 9/9 traceable, 6/6 sources covered.
- **J3:** Jev `claim_check` of the two planning clauses against S4: 2/2 supported.

## Open questions and assumptions

No unresolved owner decision is required to specify the MVP. Host plan-mode hooks and TypeSafe primitive signatures require repository and SDK verification during implementation; this document does not assume particular APIs.
