# Polish log (Jev-guided MVP polish, autonomous phase S:U12)

Format: iteration | hypothesis | requests | verdict | change | commit. Quality bar: >=2/3 requests drive a change.

| Iter | Hypothesis | Requests | Verdict | Change | Commit |
|---|---|---|---|---|---|
| 0 | Judge prioritizes polish targets | 1 | P3 evidence pre-check first (0.38), P2 readability second (0.62), P6 CLI formatting droppable (0.69) | queue set | - |
| 1 | Pre-judge evidence sanity (dup/short/requirement-less) saves wasted consultations | 0 (uses prioritization verdict) | live: bad-evidence course_check rejected judged:false, no judge call | controller pre-check + DecisionOutcome.warnings | yes |
| 2 | Tool result readability (summary line + action meaning) | 0 | live: summary visible in executor-visible output ("course_check: approve — continue: proceed as planned") | DecisionOutcome.summary + execute() text | yes (with 3) |
| 3 | Directive texts at gate/pre-check friction points (live-reproduced confusion: model invented "tool not exposed" after write block) | 0 | live run 1: model called jev_decision FIRST, judge demanded evidence, bounded rework escalated honestly (asked user where file is — no fake completion); run 2: clean course_check approve 0.99 with summary | description/gate/pre-check texts | yes (with 2) |
| 4 | Drift Noul phrasing A/B (P1) | 2 | B "does the current work satisfy this requirement so far" discriminates 0.95/0.10 vs A 0.94/0.48 | createCourseCheckJudge wording | yes |
| 5 | Drift visibility in summary (P8) | 1 (prioritization; judge skipped P9) | landed | summary names drifted requirement ids (fixed templates) | yes |
| 6 | Freeze or continue (P4/P10/P11 vs STOP) | 1 | STOP 0.91 | MVP frozen at this point; P4/P10/P11 recorded as candidates, not done | yes (docs) |

Totals: 6 live requests, 5 changes landed (requests/changes ~1.2). Judge redirected: dropped P9, picked P3>P2>P1 order, ordered STOP.
