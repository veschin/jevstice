# Live Jev per-idea direction review - REWORK (2026-10-07)

Method fixed per user defect report ("ты должен был это от него услышать а не от меня"): one idea per request (10 requests, jev-1.13.0), Choice over explicit directions [deepen_as_is | generalize_into_universal_mechanism | reduce_to_preset_of_shared_engine | remove], Choice failure-reasons, Noul "current implementation already matches the best direction". Alternatives were presented to the judge (first attempt did not do this and was discarded).

## Verdict table (verbatim)

| Idea | Best direction (choice, conf) | Main concern | Impl matches best direction? (Noul) |
|---|---|---|---|
| a mutation gate | **generalize_into_universal_mechanism 0.87** | insufficient_data 0.82 | no - 0.26 |
| b fail-closed | generalize 0.76 | insufficient_data 0.83 | no - 0.26 |
| c fixed-option verdicts | generalize 0.80 | insufficient_data 0.84 | no - 0.27 |
| d bounded rework | generalize 0.93 | insufficient_data 0.86 | no - 0.26 |
| e template overrides | generalize 0.87 | insufficient_data 0.82 | no - 0.26 |
| f dogfooding | generalize 0.79 | insufficient_data 0.82 | no - 0.25 |
| g MVP narrowing | generalize 0.65 | insufficient_data 0.84 | no - 0.27 |
| h completion gate | **generalize 0.93** | insufficient_data 0.84 | no - 0.26 |
| i staleness binding | generalize 0.91 | insufficient_data 0.83 | no - 0.26 |
| j SDK transport | (no direction 0.29 - transport infra, not a process idea) | insufficient_data 0.86 | no - 0.26 |

## Reading (design input, not softened)

- 9 of 10 ideas: judge picks **generalize_into_universal_mechanism** with solid confidence - independent live confirmation of the user's universal decision-engine correction (S:U11). No idea was told to be removed or kept standalone.
- **matches = no (~0.26 for every idea)**: the judge finds the current per-stage implementation does NOT yet match the generalization - i.e. the registry refactor (control-point engine with presets) is required work, not a parent's hint.
- The `why` choice set again collapsed to insufficient_data (0.82-0.86) - the fixed failure-reason list carried no differentiated signal in either framing; recorded honestly.
- j_sdk_transport: judge could not rank a direction for transport infrastructure (0.29) - out of scope for process-control review; stays as is.

## Consequence (already ordered and in flight)

Registry refactor per parent order: control-point engine {id, trigger, context assembly, fixed questions, verdict->action mapping}; existing gates + course_check as presets; config `controlPoints` extension (on_demand only this pass, gate-triggers fail-closed rejected as roadmap); engine services (fail-closed, digest/fingerprint, bounded rework, same-session feedback) shared by all presets. Requests used this rework: 10.
