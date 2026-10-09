# Jevstice MVP - Product Requirements

## Purpose and scope

Jev supports the omp executor's consequential decisions throughout a task, rather than merely preventing file writes. The extension can enforce consultations at visible tool and completion boundaries; it cannot observe private model reasoning. The MVP implements the distinct activities below with minimal code and no automatic generic catalog call on each user prompt. [S10, S11, S13, S14, S15]

The executor is the omp agent doing the work. Jev is the judge reached through the TypeSafe API. A simple task does not inherit development gates merely because it has a user prompt. [S2, S13]

## Functional requirements

Each requirement specifies one independently observable behavior. The owner-request coverage was checked with Jev in separate preparation and execution batches; the planning-understanding clause was additionally checked as an independent claim. [J1, J2, J3]

Each entry that carried a `review required` mark was put to its own Jev review, and the mark was removed only by a recorded verdict at or above the approval floor (`POLICY.minConfidenceToApprove` 0.6 for a choice, 0.8 for a probability). The verdicts are recorded below.

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
- **FR-05 - Understanding check.** DURING planning, the executor SHALL submit each proposed requirement to Jev for a check against the original request. [S4; J3:2]
- **FR-06 - Complete requirement set.** BEFORE a requirement list becomes the task PRD, the executor SHALL establish that its self-contained items collectively cover the owner's request. [S5; J1:6]
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
- **FR-18 - Important-decision boundary.** WHEN an important decision requires Jev and the executor reaches an enforceable visible boundary without submitting it, the extension SHALL block that boundary. [S11, S13; J2:8]
- **FR-19 - Business decision.** WHEN the executor faces a consequential business decision, it SHALL consult Jev with the task context. [S12; J2:9]

### Refusal handling and judge availability

- **FR-20 - Refusal names the class and the next action.** WHEN a judge answer is unusable or below the approval floor, the extension SHALL return, with the verdict, the class of the refusal - a defect of the submitted material, or the judge failing to answer - and exactly one next action for the executor. [S17]
- **FR-21 - Work without the judge.** WHEN judge calls fail for availability (a transport failure, an authentication failure, or a missing key) `POLICY.maxJudgeFailures` times in a row, the extension SHALL notify the owner once and SHALL pass the mutation and completion boundaries without a judge answer, recording no approval; a usable answer from any later call resets the count and restores the boundaries, and a malformed or below-floor answer counts as neither. [S18, S21]
- **FR-22 - Reconsider instead of repeating.** WHILE a boundary holds, the extension SHALL record the digest of the material each refusal judged with its verdict; a resubmission whose digest was already refused at that boundary SHALL be refused without a judge call, naming the attempts so far and the next change of approach. [S19]
- **FR-23 - Emergency release with an open item.** WHEN the refusal bound of FR-22 is exhausted at a boundary that holds consequential changes, the extension SHALL release that boundary for the current request, record the refusal as an OPEN item carrying the boundary, the attempt count and the refused digests, and notify the owner; the release approves nothing. [S20, S21]

### Review rework

- **FR-24 - Plan review by topics.** WHEN a plan is reviewed, the executor SHALL submit the plan's topics - per topic its id, the section of the artifact that governs it, the paths it changes and the requirement it serves; the review SHALL refuse a topic whose quoted section does not appear in the artifact bytes it read, SHALL put one question per topic in one batched call, and SHALL record an approval only when every topic reaches the floor; a refused topic SHALL be named with its own next action. [S22]
- **FR-25 - Course check triggers.** The extension SHALL ask the judge about the course of the work when an observable trigger fires - a successful consequential action whose target lies outside every path the approved plan's topics name, or the configured number of actions since the last check, whichever comes first; the check SHALL submit the plan topics, the paths actually changed and the triggering action results, so that an off-course answer names the action that left the plan, and no check runs without an approved plan. [S23]
- **FR-26 - Acceptance judged from evidence.** WHEN code is accepted, the extension SHALL refuse the submission before any judge call unless its evidence carries at least one execution item (a command and its output) and at least one static code item (a diagnostic, a diff or a size measurement); the judge SHALL answer per plan topic whether that evidence shows the topic met, naming the evidence it rests on. [S24]
- **FR-27 - Text review tool.** The extension SHALL offer a tool that takes a text and the register rules it must satisfy, splits the text into bounded fragments and puts every submitted rule to the judge once per fragment; for each fragment a rule fails on, the tool SHALL return that rule line as the executor submitted it, writing no prose of its own. [S25]
- **FR-28 - The boundary teaches its own next step.** WHEN a boundary refuses a consequential change, the extension SHALL return the one next call as a copy-ready call with its arguments, SHALL deliver the same instruction once per boundary as a session message so it reaches the executor's context and not only its tool error, SHALL count the consequential calls it refuses while that boundary stands, and at `POLICY.maxIgnoredBoundaryCalls` SHALL notify the owner that the executor is not following the boundary, naming the calls it attempted. [S26]

- **FR-29 - Owner re-aim.** WHEN the owner interjects a new direction into a running session, the extension SHALL offer registering that interjection as the course - one judged question over the owner's words alone - and on approval SHALL re-aim the registered task without rebuilding walls: the released boundaries stay released, the plan boundary is released by the owner's order, the records of the old course are dropped, and nothing the old course refused is approved. [S27]

## Constraints

- A simple web search must not incur automatic generic classification or the development acceptance gates; the executor may still invoke FR-03. [S2, S13, S14]
- No extension claim may imply that private model thoughts are observable; enforcement applies to visible actions and completion. [S13]
- A required consultation that fails, abstains, or has no usable answer must not count as approval. This retains the repository's fail-closed policy. [S16]
- Calls should occur at purposeful activity boundaries, not as repeated generic feedback. The owner has not prescribed a numeric call budget. [S14]
- This MVP favors the smallest code and tool surface that implements FR-01 through FR-28. [S15]

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
- **J1:** Jev `requirements_formalization` preparation batch: nine items were not identified as untraceable; its tenth, planning understanding, was rejected and independently checked as J3.
- **J2:** Jev `requirements_formalization` execution batch: 9/9 traceable, 6/6 sources covered.
- **J3:** Jev `claim_check` of the two planning clauses against S4: 2/2 supported.

## Open questions and assumptions

No unresolved owner decision is required to specify the MVP. Host plan-mode hooks and TypeSafe primitive signatures require repository and SDK verification during implementation; this document does not assume particular APIs.
