<p align="center">
  <img src="docs/banner.webp" alt="jevstice" width="100%">
</p>

# jevstice

Jevstice is an [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that makes Jev (`jev-latest`, TypeSafe API) review an executor's decisions at enforceable tool boundaries. The owner supplies an objective; the executor derives requirements and implementation choices and defends them to Jev without a mandatory owner-confirmation round.

The extension cannot observe private reasoning or control effects outside OMP's tool hooks. Normally, before a consequential invocation executes, Jev receives its actual arguments and approved scope. Explicit owner permission or exhausted attempts permit continuation without claiming judge approval.

## Activities

| Activity | Tool | When it helps |
| --- | --- | --- |
| Triage | `jev_triage` | Decide explicitly whether a task needs deeper development work, and name narrow topics only when it does. |
| Search relevance | `jev_search_relevance` | Select among supplied search results and their *agent-proposed* reasons, or reject all candidates. Jev provides a choice, not a prose explanation. |
| Requirements | `jev_requirements` | Check individual requirements against the owner's request and check the set's coverage in one call. |
| Plan | `jev_plan_review` | Approve an outline, review each detail once, then check the assembled artifact for contradictions and new scope. |
| Consultation | `jev_consult` | Ask one evidence-backed Choice, Score or Boolean question when uncertain or facing a business decision. |
| Acceptance | `jev_acceptance` | Defend the delivered work against business needs and architecture, separately, from submitted execution and code evidence. |
| Developer review | `jev_review` | Defend a checkpoint, commit or diff as a developer. |
| Re-aim | `jev_reaim` | Register an actual owner change of direction and invalidate the previous task's approvals. |
| Text review | `jev_text_review` | Split a text and quote back the register rule each fragment violates, so a rewrite follows the rules the owner stated rather than advice from the judge. |

The SDK returns typed choices, scores and probabilities, not explanatory prose. Detail review returns a specific defect category only when Jev selects it confidently; uncertainty is not presented as a proven defect. Passing decisions remain valid while rejected steps are corrected. Final assembly does not rejudge the executability of accepted steps.

Development proceeds through triage, requirements, outline, step details, final plan, implementation and separate business/architecture acceptances. The approved artifact is bound to exact bytes and rechecked before changes. Native `xd://propose` uses the same approval and preserves the requirement/plan context across its session handoff.

Read-only tools and conservatively recognized inspection commands need no action judgment. Unknown tools, executable code, delegation, mutating devices and shell syntax with uncertain effects are consequential. Quiet or simple requests skip development planning, but do not authorize arbitrary writes: consequential invocations still require Jev authorization against the owner's request.

An action check inspects the complete invocation before execution; oversized payloads must be split, never silently truncated. Configured course checks inspect observed actions against the whole plan, not against every topic simultaneously. Failed executions also invalidate prior acceptance because a failing command can already have changed files.

Repeated refused material costs no new judge call. Three refused submissions, three blocked calls at one boundary, or three availability failures permit continuation of the current request with findings OPEN. Three blocked stops permit the following stop. The owner can release the current request immediately with `/jev-continue` or a standalone message such as `аппрув`, `одобряю продолжение`, or `approve continuation`. This covers inspection, file changes, plan proposals, automatic action checks and completion together, so a second gate cannot immediately trap the same request. A changed request or re-aim does not inherit permission; no plan or acceptance verdict is manufactured.

This protects visible boundaries, not the truth of executor-supplied evidence. Acceptance requires execution and code evidence, but the extension is not an OS sandbox and cannot guarantee that a probabilistic judge detects every deceptive submission.

## Load explicitly

The extension requires Bun >= 1.1, `@typesafe-ai/sdk`, and a TypeSafe API key in `TYPESAFE_API_KEY` or `JEVI_API_KEY`, or a resolver command in `TYPESAFE_API_KEY_COMMAND`. Install dependencies with `bun install` in this checkout if needed. A missing key fails closed.

```sh
# From a separate project:
omp --no-extensions -e /path/to/jevstice/src/index.ts
```

The package declares `src/index.ts` as its OMP extension entry. Whether an ordinary session loads it depends on the owner's installation and launch options; the command above explicitly loads this checkout without changing those settings.

## Configuration

The project file `<project>/.omp/jev.config.json` overrides `~/.omp/agent/jev.config.json`:

```json
{
  "gates": { "mutation": true, "completion": true },
  "courseCheck": { "mode": "completion", "interval": 3 }
}
```

`courseCheck.mode` accepts `interval` or `completion` (the default). This controls post-execution course checks. Invalid section types or values retain defaults and report the file and key; unknown keys are ignored. The owner can disable gates globally, or permit continuation only for the current request without changing configuration.

## Development

```sh
bun test
bun run typecheck
```

Tests use injected judges and never call the live API. [tools/README.md](tools/README.md) documents real-Jev and actual-OMP smoke commands and their evidence output. [PRD.md](PRD.md) records the current requirements and their sources. Historical releases remain in git history.

## License

[MIT](LICENSE)
