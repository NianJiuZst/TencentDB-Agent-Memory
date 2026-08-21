# Experimental result record

## Primary finding

On 50 frozen, quarterly, stale-exposed Memora questions, an equal-weight MiniMax-M3 and DeepSeek-V4-Flash judge panel estimates that the adaptive controller improves answer-level FAMA by **5.77 percentage points** with a persona-cluster 95% confidence interval of **[1.23, 11.71]**. MPA improves by 3.20 points and FAA by 8.46 points. Mean injected context increases by 2.24 tokens (1.55%).

The final machine-readable status remains `failed`: the primary FAMA magnitude and confidence checks pass, both judges estimate a positive FAMA effect, but the unchanged secondary FAA improvement threshold of 10 points is missed.

The judges agree on 97.71% of 2,844 paired criterion votes (Cohen's kappa 0.923). MiniMax-M3 estimates +5.13 FAMA points, 95% CI [-0.16, 11.53]; DeepSeek-V4-Flash estimates +6.40 points, 95% CI [2.03, 12.06]. Under a stricter unanimous-vote sensitivity analysis, the gain is +4.77 points with a CI of [-0.30, 11.21], which is not statistically decisive.

## What changed the result

An invalidation-only Oracle improved FAA but not FAMA enough. The useful mechanism was linking a retrieved stale predecessor to its later correction node. A protocol audit also found that Memora `forgetting_evidence.session_id` denotes the correction event, not the original stale assertion. Protocol v2 and later therefore label a retrieved value as stale only when its unit precedes that invalidation boundary.

The deployable adapter does not use those evaluation labels. It reconstructs correction events from released write-time operation metadata. A bounded optimizer trained on weekly/monthly feedback selected one-hop redirection at confidence 0.85; the ledger stores direct links to the latest eligible correction, so a one-hop query policy can still represent a multi-update history.

## Result hierarchy

1. **Gold transitive-chain upper bound:** +9.97 FAMA points on 40 frozen stale-exposed questions, 95% CI [1.75, 19.27].
2. **Label-free direct held-out evidence:** +9.29 proxy points on all 61 quarterly stale-exposed questions, 95% CI [5.85, 12.78].
3. **Dual-judge answer-level held-out evidence:** +5.77 FAMA points on 50 frozen questions, 95% CI [1.23, 11.71].
4. **All quarterly forgetting-bearing direct evidence:** +2.68 proxy points over 192 questions, 95% CI [1.47, 4.13].

The conditional effect is materially larger than the population-average proxy effect because many questions never retrieve an obsolete item.

The answer-level effect is not uniform. Recommending questions (43/50) improve by 6.67 FAMA points, whereas remembering questions (7/50) improve by only 0.19 points. Seven persona clusters improve and three decline; the median persona effect is +3.40 points. The positive aggregate therefore supports a targeted stale-exposed recommendation mechanism, not a universal long-dialogue improvement claim.

## Rejected or incomplete evidence

- Lifecycle E2E v1 used the wrong provenance interpretation and is invalid for conclusions.
- Invalidation-only E2E removed stale nodes but did not reliably surface replacement state.
- The legacy OpenRouter judge experiment is superseded; none of its partial verdicts are used by the dual-judge result.
- No claim is made about real long programming tasks until the internal adapter and task-level protocol are run.
