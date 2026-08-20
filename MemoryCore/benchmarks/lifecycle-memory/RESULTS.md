# Experimental result record

## Primary finding

On 50 frozen, quarterly, stale-exposed Memora questions, the adaptive controller improves answer-level FAMA by **6.78 percentage points** with a persona-cluster 95% confidence interval of **[2.12, 12.32]**. MPA improves by 5.18 points and FAA by 7.52 points. Mean injected context increases by 2.24 tokens (1.55%).

The final machine-readable status remains `failed`: the primary FAMA magnitude and confidence checks pass, while the predeclared secondary FAA improvement threshold of 10 points is missed.

## What changed the result

An invalidation-only Oracle improved FAA but not FAMA enough. The useful mechanism was linking a retrieved stale predecessor to its later correction node. A protocol audit also found that Memora `forgetting_evidence.session_id` denotes the correction event, not the original stale assertion. Protocol v2 and later therefore label a retrieved value as stale only when its unit precedes that invalidation boundary.

The deployable adapter does not use those evaluation labels. It reconstructs correction events from released write-time operation metadata. A bounded optimizer trained on weekly/monthly feedback selected one-hop redirection at confidence 0.85; the ledger stores direct links to the latest eligible correction, so a one-hop query policy can still represent a multi-update history.

## Result hierarchy

1. **Gold transitive-chain upper bound:** +9.97 FAMA points on 40 frozen stale-exposed questions, 95% CI [1.75, 19.27].
2. **Label-free direct held-out evidence:** +9.29 proxy points on all 61 quarterly stale-exposed questions, 95% CI [5.85, 12.78].
3. **Label-free answer-level held-out evidence:** +6.78 FAMA points on 50 frozen questions, 95% CI [2.12, 12.32].
4. **All quarterly forgetting-bearing direct evidence:** +2.68 proxy points over 192 questions, 95% CI [1.47, 4.13].

The conditional effect is materially larger than the population-average proxy effect because many questions never retrieve an obsolete item.

## Rejected or incomplete evidence

- Lifecycle E2E v1 used the wrong provenance interpretation and is invalid for conclusions.
- Invalidation-only E2E removed stale nodes but did not reliably surface replacement state.
- The final three-judge replication is incomplete (22/50) due HTTP 402 and is not included in any reported metric.
- No claim is made about real long programming tasks until the internal adapter and task-level protocol are run.
