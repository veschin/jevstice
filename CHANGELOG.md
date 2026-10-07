# Changelog

## 0.1.0 - 2026-10-07

- Baseline: PRD, PLAN.md, package config, shared types contract (DecisionRequest/DecisionResult/Judge/MultiLabelJudge, TypeSafe systemone wire types, POLICY defaults).
- Live API unblocked: official key (`pass token/jev`) verified against direct TypeSafe endpoint - HTTP 200, jev-1.13.0, ~0.5s latency, usage returned. Synthetic live proof: noul, classification, topic relevance, code-review pair (approve 0.96 / revise 1.0 with task context in state), completion evidence gating (report-only -> insufficient_evidence 0.94). Intermittent transport resets observed -> client retry must cover resets.
- Slices: catalog/classification/routing (done), client+evidence+CLI (in flight), omp extension controller (in flight).
