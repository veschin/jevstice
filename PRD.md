# Jevstice MVP - Product Requirements

## Purpose and scope

Jev supports the omp executor's consequential decisions throughout a task, rather than merely preventing file writes. The extension can enforce consultations at visible tool and completion boundaries; it cannot observe private model reasoning. The MVP implements the distinct activities below with minimal code and no automatic generic catalog call on each user prompt. [S10, S11, S13, S14, S15]

The executor is the omp agent doing the work. Jev is the judge reached through the TypeSafe API. A simple task does not inherit development gates merely because it has a user prompt. [S2, S13]

## Functional requirements

Each requirement specifies one independently observable behavior. The owner-request coverage was checked with Jev in separate preparation and execution batches; the planning-understanding clause was additionally checked as an independent claim. [J1, J2, J3]

### Triage and preparation

- **FR-01 - Narrow topics.** WHEN a task requires specialized expertise, triage SHALL identify task-specific topics. [S1; J1:1]
- **FR-02 - Simple-task decision.** WHEN a task is simple, triage SHALL explicitly say that deeper development activities are unnecessary. [S2; J1:2]
- **FR-03 - Search relevance.** WHEN the executor submits web-search candidates, Jev SHALL be available to select relevant results and explain the selection. [S2, S3; J1:3]
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

## Constraints

- A simple web search must not incur automatic generic classification or the development acceptance gates; the executor may still invoke FR-03. [S2, S13, S14]
- No extension claim may imply that private model thoughts are observable; enforcement applies to visible actions and completion. [S13]
- A required consultation that fails, abstains, or has no usable answer must not count as approval. This retains the repository's fail-closed policy. [S16]
- Calls should occur at purposeful activity boundaries, not as repeated generic feedback. The owner has not prescribed a numeric call budget. [S14]
- This MVP favors the smallest code and tool surface that implements FR-01 through FR-19. [S15]

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
- **J1:** Jev `requirements_formalization` preparation batch: nine items were not identified as untraceable; its tenth, planning understanding, was rejected and independently checked as J3.
- **J2:** Jev `requirements_formalization` execution batch: 9/9 traceable, 6/6 sources covered.
- **J3:** Jev `claim_check` of the two planning clauses against S4: 2/2 supported.

## Open questions and assumptions

No unresolved owner decision is required to specify the MVP. Host plan-mode hooks and TypeSafe primitive signatures require repository and SDK verification during implementation; this document does not assume particular APIs.
