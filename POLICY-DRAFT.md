# POLICY-DRAFT.md - action-gating policy, live Jev consultation (DRAFT for user approval)

Source: two live requests to official api.typesafe.ai, model jev-1.13.0, 2026-10-07 (integrator-owned calls; sanitized evidence below; 2 of <=8 budget used, ~2900 input tokens total). Context given to the judge: full omp 18.6.3 tool inventory grouped into risk classes, implemented gates, and pi-warden calibration measurements. **Draft only - controller gating NOT changed by this document.** Post-approval items listed at the end.

## Verdict table (verbatim judge answers)

| Class (tools) | Judge verdict | Confidence | Basis |
|---|---|---|---|
| A read-only: read, glob, grep, find, lsp, ast_grep | free | 0.30 (batch, low) + **Noul reads-free 0.97** | batch Q cls_A + noul_reads_free |
| B analysis/meta: todo, context_notes, recall, reflect, wait, ask | free | 0.28 (batch, low) | cls_B |
| C file mutation: edit, write, ast_edit | **plan_plus_completion_only** (edits free after approved plan; judge plan + completion) | 0.52 ⚠ needs-user-decision | pol_C (0.68 vs judge_every_edit 0.32) |
| D bash/eval shell | **plan_plus_highrisk** (free after plan, except always-judged high-risk pattern list) | 0.66 ⚠ needs-user-decision | pol_D (0.77) |
| E network reads: web_search, github, fetch | free | 0.35 (batch, low) | cls_E |
| F memory/skill mutation: memory_edit, retain, learn, manage_skill, checkpoint, rewind | free (batch, low conf - treat as undecided) | 0.30 ⚠ needs-user-decision | cls_F |
| G subagent spawn: task | **conditional_budget** (free single small spawns; judge multi-worker/expensive-model spawns) | 0.69 ⚠ borderline; Noul spawn-judge 0.83 | pol_G (0.79) |
| H session completion | **mandatory_with_evidence** | 1.00 | pol_H (1.00 probability) |
| I destructive (rm -rf, force push, schema drop) | **always_judge** (fresh decision at execution time, plan does not cover) | 0.88 | pol_I (0.92); Noul always-destructive only 0.60 ⚠ |
| Friction tolerance | score 3.46/10 (≈ "gate mutations, not everything"), conf 0.79 | friction_score | |

Noul: block unplanned mutation **0.96**; reads free **0.97**; destructive-always **0.60**; spawn-judge-conditional **0.83**.

## Mapping to current implementation

- Implemented plan gate (edit/write/bash blocked until approved plan) MATCHES the judge's C/D verdicts and friction 3.46. No change needed.
- Implemented completion gate (evidence-backed, blocking) MATCHES H (conf 1.0).
- NOT yet implemented (post-approval items, do not build without user sign-off):
  1. High-risk bash pattern list always judged (D, conf 0.66; destructive-I supports with 0.88).
  2. Spawn budget gate (G, conf 0.69).
  3. Destructive-action pattern detector (I).
  4. Memory/skill mutation policy undecided by judge (F, conf 0.30) - user decision.

## Needs-user-decision (confidence < 0.8)

- C: judge-every-edit vs plan+completion (0.52) - current implementation assumes plan+completion.
- D exact high-risk pattern list contents.
- G spawn threshold (0.69).
- F memory/skill class entirely (0.30).
- Destructive list definition (Noul 0.60 vs Choice 0.88 disagree on plan coverage).

## Sanity check vs pi-warden evidence

- Reads free / mutations gated / completion gated: consistent with pi-warden (reads never gated; intent-steer abandoned after 36/37 false steers -> supports NOT gating every edit; irreversible-hold <1% wrong above conf 0.8 -> supports always-judge destructive with confidence threshold). No contradictions found.
- Known judge caveat observed live: the 9-question identical batch collapsed to "free" at conf ~0.27-0.35 (anchoring); individual re-asks produced differentiated verdicts. pi-warden's warning about question composition is confirmed in practice.

## Raw evidence (sanitized)

Request 1 (state: inventory+gates+measurements, 14 questions): cls_A..cls_I choices as table; noul_reads_free 0.97; noul_unplanned_mutation 0.96; noul_destructive_always 0.60; noul_spawn_judge 0.83; friction_score 3.46 conf 0.79; usage input 1949 / output 447 tokens.
Request 2 (5 distinctive choice questions): pol_C plan_plus_completion_only 0.52; pol_D plan_plus_highrisk 0.66; pol_G conditional_budget 0.69; pol_H mandatory_with_evidence 1.00; pol_I always_judge 0.88; usage input 949 / output 230.
Model header: jev-1.13.0 both. No private project data in state.
