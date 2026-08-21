# Lifecycle Memory Research Roadmap

This file is the persistent direction registry for iterative work above the fixed-budget V1 incumbent. A candidate is not promoted because it improves a retrieval proxy. Each direction must preserve the Base fallback, receive a versioned protocol before its scores are computed, and pass an answer-level gate before new-data confirmation.

## Current incumbent

`lifecycle-adaptive-v1.0`: correction-linked successor redirection with `minConfidence=0.85`, one hop, `k=5`, bounded expansion, and whole-call Base fallback. It remains the research incumbent because the broader contextual V2 improved the direct proxy but lost answer-level forgetting safety.

## Direction registry

| ID | Direction | Single changed dimension | Evidence source | Status | Promotion boundary |
|---|---|---|---|---|---|
| D1 | Correction-aware evidence shield | Injection rendering after V1 | Write-time `obsoleteValues`; query-time deterministic masking | Rejected at answer gate | Stopped: MPA non-inferiority and reader-stability gates failed |
| D2 | Query-conditioned evidence-risk routing | Choose V1 or shield rendering per query | Bounded sidecar features plus downstream utility | Rejected at cross-fitted gate | Stopped: MPA non-inferiority and reader-stability gates failed |
| D3 | Delete-aware vacancy refill | Whether deletion successors consume Top-k slots | Typed lifecycle event kind plus the existing Base candidate pool | Rejected at proxy gate | Positive recall signal, but magnitude and token gates failed |
| D4 | Feedback-optimized valid-state packing | Token fraction and item cap after validity filtering | Development-period proxy feedback; per-query V1 token budget | Active | Must improve held-out proxy without exceeding V1 tokens |
| D5 | Scope-aware coexistence | Branch/environment validity rather than global invalidation | Adapter-provided repository/branch/task scope | Queued | Requires a programming-session adapter or scoped public proxy |

## Why D1 is first

The V2 failure analysis found more exact obsolete-value exposure in both contexts and answers. D1 changes neither retrieval identity nor budget; it tests whether correction statements themselves leak superseded surface forms. This makes the result easier to attribute than another joint Top-k, hop, and threshold search.

The design is informed by query-time evidence distillation in [DeferMem](https://arxiv.org/abs/2605.22411), adaptive memory allocation in [ElasticMem](https://arxiv.org/abs/2605.30690), and on-demand abstaining memory generation in [Mem-pi](https://arxiv.org/abs/2605.21463). D1 deliberately starts with a deterministic renderer rather than reinforcement learning so that it is cheap, reviewable, and provider-independent.

D1-v1.0 reduced exact obsolete-value context exposure from 74% to 12% with no measured current-atom recall loss, but it increased mean injected tokens by 2.70% and four of 50 cases exceeded its 5 ms budget. The predeclared gate rejected it before answer generation. D1-v1.1 keeps every quality gate fixed, replaces obsolete spans with the compact pronoun `it`, and uses a 10 ms shield budget matching the incumbent lifecycle budget.

D1-v1.1 reduced exposure to 10% and token cost by 3.04% with no current-atom loss, but one call took 10.48 ms and failed the zero-fallback gate. D1-v1.2 is the final retry in this direction: it preserves V1.1 semantics and gates while moving regex compilation from query time to bounded sidecar construction. A V1.2 feasibility failure ends D1.

D1-v1.2 passed the full feasibility gate: exact obsolete-value context exposure fell from 74% to 8%, current-atom recall was unchanged, mean injected tokens fell by 3.27%, candidate identity remained exact, and all ordinary, disabled, damaged, and forced-timeout checks returned without mismatch. This result only advances D1 to answer-development testing.

The answer-development protocol is frozen as `lifecycle-evidence-shield-e2e-v1.0`. It reuses the independently validated V1 cells, generates only the shield arm with the same MiniMax-M3/DeepSeek-V4-Flash crossed panel, and requires positive FAMA, at least +1 point FAA, no more than 1 point MPA loss, no token increase, and nonnegative FAMA direction for both readers.

D1 failed that answer gate. Independent recomputation found that exact obsolete-value answer exposure fell from 66% to 19% and forgetting-absence judgments gained 77 net correct criteria, but memory-presence judgments lost 13 net correct criteria. Relative to V1, shield MPA fell by 2.02 points (alternate persona-bootstrap 95% interval -4.17 to -0.13), while FAMA gained only 0.81 points with an interval crossing zero; the DeepSeek-reader FAMA direction was also negative. D1 is therefore a useful negative result, not the new incumbent.

## Why D2 follows D1

D1 demonstrates heterogeneous treatment effects: shielding removes harmful obsolete mentions but sometimes destroys the entity anchors needed to recover valid facts. D2 treats V1 and shield as two bounded actions and learns a conservative query-conditioned routing rule from downstream feedback. The first experiment is offline and cross-fitted by persona: every held-out persona is routed by a rule selected without that persona's outcomes. It remains development evidence because both action outcomes come from the already analyzed 50-case panel.

The frozen D2-v1.0 policy class contains exactly 32 deterministic decision stumps over four bounded features: redaction count, changed-candidate count, redaction density, and token savings. Persona identity, benchmark task labels, gold criteria, model identity, and answer text are forbidden features. For every held-out persona, a rule is selected on the other nine personas under stricter training safety constraints; if no rule is eligible, the fold uses unchanged V1. This cross-fitting reduces direct memorization but does not turn the reused panel into confirmation data.

D2-v1.0 failed. It routed 18 of 50 cases through shield, improved FAA by 2.83 points, reduced tokens by 0.30%, and limited MPA loss to 1.15 points, but still missed the frozen 1-point non-inferiority bound and retained a negative DeepSeek-reader FAMA direction. The result suggests that surface-change and token features do not identify semantic-anchor loss reliably enough.

## Why D3 follows D2

The failure is upstream of rendering: many high-ranked stale hits are redirected to deletion utterances, so tombstones consume the fixed five-slot injection budget while current active facts remain lower in the existing 30-item Base pool. D3 keeps update redirection but lets high-confidence deletion events vacate their slots and deterministically backfills from the same Base candidate pool. It does not enlarge Top-k, rewrite FTS5/vector retrieval, or synthesize current facts. This directly tests whether validity filtering can recover recall without reintroducing stale values.

This choice follows the retain-versus-supersede boundary reported by MemStrata: lossy merging can destroy static recall, while unfiltered retention leaks stale facts. It also responds to STALE's distinction between retrieving an update and acting on the represented state. D3 remains a bounded sidecar with exact Base fallback.

The frozen D3-v1.0 protocol makes no fitted choices: `minConfidence=0.85`, one hop, the existing 30-item candidate pool, and final `k=5` all remain fixed. The primary proxy subset is quarterly current-state, forgetting-bearing questions; historical/reasoning and non-forgetting slices are reported separately. Qualification requires at least +2 points evidence-FAMA proxy with a persona-bootstrap lower bound above zero, no recall or forgetting loss, no token increase, no non-forgetting harm, and exact fallback behavior.

D3-v1.0 failed two gates. On 192 quarterly current-state forgetting-bearing questions, evidence-FAMA proxy and current-session recall improved by 1.40 points with a persona-bootstrap interval of +0.63 to +2.28 and zero harmed cases, but the gain missed the frozen +2-point minimum. Mean injected tokens increased by 2.89% because lower-ranked refill items were longer. All 600 normal calls and disabled/damaged/timeout checks completed without fallback mismatches.

## Why D4 follows D3

D3 shows that a valid-only candidate stream has useful signal, but fixed item count is not a cost guarantee. D4 separates validity from packing: it first produces a bounded ordered stream of valid candidates, then learns one of nine predeclared `(token fraction, max items)` policies using weekly/monthly feedback only. Each query's hard budget is a fraction of the tokens used by its actual V1 context, so no chosen policy can buy quality by spending more context. Quarterly remains the policy-blind proxy period.

## Iteration rule

1. Freeze the candidate construction and gates before computing its scores.
2. Run deterministic feasibility and exact fallback checks.
3. If the feasibility gate fails, record the negative result and move to the next direction.
4. If it passes, run an answer-level development panel with the existing two-model crossed protocol.
5. Do not reuse the analyzed 50 cases for a new confirmatory claim; require an untouched public split or an internal programming-session adapter.
6. Update the paper with both positive and negative directions, including cost, uncertainty, and causal limits.
