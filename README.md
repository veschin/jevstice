<p align="center">
  <img src="docs/banner.webp" alt="jevstice" width="100%">
</p>

# jevstice

Jevstice is an [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that lets an agent put consequential decisions to Jev (`jev-latest`) through the TypeSafe API. It checks visible actions and completion boundaries; it cannot read the agent's private reasoning. A plain question or web search does not trigger a generic classification call.

**Status:** This checkout is a replacement MVP under verification. Its ordinary-session extension entry is deliberately disabled; do not treat it as an installed release. The previous implementation is preserved at commit `4c38d74`.

## Activities

| Activity | Tool | When it helps |
| --- | --- | --- |
| Triage | `jev_triage` | Decide explicitly whether a task needs deeper development work, and name narrow topics only when it does. |
| Search relevance | `jev_search_relevance` | Select among supplied search results and their *agent-proposed* reasons, or reject all candidates. Jev provides a choice, not a prose explanation. |
| Requirements | `jev_requirements` | Check individual requirements against the owner's request and check the set's coverage in one call. |
| Plan | `jev_plan_review` | Check the actual `local://...-plan.md` artifact topic by topic before submitting it to omp's `xd://propose` plan-mode boundary: every submitted topic is judged on its own, so a verdict names the topic it concerns. |
| Consultation | `jev_consult` | Ask one evidence-backed Choice, Score or Boolean question when uncertain or facing a business decision. |
| Acceptance | `jev_acceptance` | Defend the delivered work against business needs and architecture, separately, from submitted execution and code evidence. |
| Developer review | `jev_review` | Defend a checkpoint, commit or diff as a developer. |
| Text review | `jev_text_review` | Split a text and quote back the register rule each fragment violates, so a rewrite follows the rules the owner stated rather than advice from the judge. |

The agent should submit concrete alternatives and quotes from the owner's request, artifacts or observed results. The SDK returns typed decisions, scores and probabilities, not explanatory prose. A missing key, unusable answer or answer below the approval threshold does not approve an action. The first change to the working tree waits for a triage decision on the request; a triaged simple task proceeds without the deeper stages, and the verdict covers only that request. A registered development task then uses the required visible checks before consequential changes and before completion.

Every refusal carries the class of the failure - a defect of the submitted material, or the judge failing to answer - and exactly one next action, and a gate refusal renders the call that resolves it with its arguments; the same instruction is delivered once per boundary as a session message. A submission whose material was already refused at that boundary costs no judge call, and a boundary that reaches three refusals is released as an OPEN item and reported to the owner instead of holding the work forever. When the judge cannot be reached three times in a row the boundaries pass without an answer and nothing is recorded as approved. Acceptance is judged from an execution item and a static code item per plan topic, and the course check runs on a change outside the paths the approved plan names, or on the configured count.

## Try the disabled checkout explicitly

The extension requires Bun >= 1.1, `@typesafe-ai/sdk`, and a TypeSafe API key in `TYPESAFE_API_KEY` or `JEVI_API_KEY`, or a resolver command in `TYPESAFE_API_KEY_COMMAND`. Install dependencies with `bun install` in this checkout if needed. A missing key fails closed.

```sh
# From a separate project, while testing only; explicit tools remain available.
omp --no-extensions -e /home/veschin/ai/jev/src/index.ts \
  --tools=read,write,jev_triage,jev_requirements,jev_plan_review,jev_consult,jev_search_relevance,jev_acceptance,jev_review
```

The path above is this checkout's local path; replace it with your own checkout location. The repository currently has no `omp.extensions` manifest entry, and its ordinary-session installation link remains disabled. This explicit command does not re-enable the addon for other sessions.

## Configuration

The project file `<project>/.omp/jev.config.json` overrides `~/.omp/agent/jev.config.json`. Only these keys affect the MVP:

```json
{
  "gates": { "mutation": true, "completion": true },
  "courseCheck": { "mode": "interval", "interval": 3 }
}
```

`courseCheck.mode` accepts `interval` or `completion`; the interval counts successful consequential actions. Invalid values retain the fail-closed default and report the offending file. Old configuration keys are ignored. No generic topic catalog or standalone CLI is part of this MVP.

## Development

```sh
bun test
bun run typecheck
```

Tests use an injected judge and do not call the live API. The functional requirements and their owner quotations are in [PRD.md](PRD.md). The previous product, including its measurements and older documentation, remains available in git history.

## License

[MIT](LICENSE)
