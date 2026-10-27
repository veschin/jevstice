# Jev workflow

Use the matching Jev tool description as the authoritative call template. Fill only its fields; include concise, decision-relevant facts and exact source quotes when relevant.

On a project-change request, after any mandatory skill loading, the first task tool call MUST be `jev_triage`. Do not inspect project files, search the project, run shell commands, or draft an execution plan first. State only that you will triage the request before preparing the task plan. Submit the owner's request verbatim and concrete candidate topics supported by that request. Purely read-only requests do not need triage.

If triage registers a development task, present one concise, checkable list of the request's obligations and material unresolved decisions. Ask the owner to confirm or correct that list in the same message; do not merely announce a paraphrase or ask only one unrelated design question. Wait for the owner's answer before calling `jev_requirements`. Jevstice blocks direct and xd:// requirements calls until a new owner message arrives, then automatically adds that exact reply as user evidence. Do not turn unspecified details into owner requirements.

After the owner answers, call `jev_requirements` with one checkable item per confirmed obligation, exact supporting quotes from the request and the owner's clarifications, and plausible omitted needs as `candidateNeeds`. Jevstice automatically adds the latest owner reply as an exact `kind: "user"` quote. If an item is rejected or unsettled, coverage is not established, or Jev identifies an omitted need, show only those gaps to the owner and resolve them before planning. Do not silently add a need or resubmit unchanged material.

- **Plan outline:** submit one high-level step per confirmed obligation with a stable id, concise summary and exact approved requirement. Jev judges coverage separately for each approved requirement and judges each proposed step. Keep approved steps unchanged; revise only steps for requirements Jev names as uncovered or steps Jev rejects. Never add an unconfirmed obligation. Do not draft details until every confirmed requirement and proposed step passes.
- **Plan details:** submit exactly one outline step per call with its complete artifact section, changed paths and exact approved requirement. Each Jev call receives the original request, owner reply, approved requirements, complete outline, prior approved details and the current artifact section. Make each section executable: state the operation, affected paths and observable check. Rework only the rejected section; a changed approved outline invalidates all details.
- **Plan finalization:** after every outline step has an approved detail, submit the full local artifact. Jev judges each approved step separately and checks for unreviewed scope independently; revise only named failing sections. Keep accepted sections byte-for-byte present and do not add unreviewed scope.

During implementation, follow the approved plan and resolve any Jev finding with a corrective action that addresses it. Do not claim completion until business and architecture acceptance pass at the current revision and the completion check approves. A released boundary remains OPEN; release is not approval.

For `jev_consult`, ask one primary decision. Structured activities such as requirement and plan review may judge multiple separately named items in one call.

Read typed answers only by their stated meaning. A negative, unsupported, malformed, missing or below-floor answer is not approval.