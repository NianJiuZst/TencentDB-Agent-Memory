# Experimental result record

## Decision

Retain `lifecycle-adaptive-v1.0` as a **conditional research incumbent**, not an unconditional default. The earlier 50-case stale-exposed panel proves that the mechanism can help when Base actually surfaces invalid memory. The newer D16 census over all 200 previously unused answer cases shows that the average full-population effect is smaller and uncertain, while effects differ materially by task. No simple baseline, isolated V2 factor, combined V2 policy, or new proxy cleared its frozen promotion gate.

D11 is retained separately as an efficiency finding: it reduced injected tokens by 20.84% on an untouched LongMemEval-V2 test while direct answer-atom support stayed equal. It did not run answer generation and therefore does not establish answer-level noninferiority.

D18 rejects an end-to-end claim. Text-only correction-event detection transfers, but automatic predecessor linking is not reliable enough. V1 therefore remains evidence about **management given a correction graph**, not a solved correction-extraction system.

## What Base, V1, V2 and D-numbers mean

- **Base**: unchanged MemoryCore L0 retrieval and injection path.
- **V1**: redirect an obsolete Base candidate through one released high-confidence correction edge; keep `k=5`, a 64-expansion/10 ms bound, and exact Base fallback.
- **V2**: proxy-selected combination of confidence 0.96, two hops, up to two redirect-conditioned extra slots, and historical-aggregate protection.
- **D1--D18**: numbered research hypotheses tested after V1. A D-number is an experiment direction, not a later product version. Rejection is retained as a result rather than silently removed.

## D16 broad answer experiment

### Population and integrity

- 200 quarterly Memora questions unused by either prior 50-case answer panel.
- Ten personas; 100 reasoning, 62 remembering, 38 recommending; 92 forgetting-bearing.
- Only six Base-stale-exposed cases, so selection is not conditioned on visible Base failure.
- Thirteen arms and 2,600 frozen case--arm contexts.
- 947 unique prompts per reader after byte-identical reuse; 1,894 reader and 1,894 crossed-judge calls.
- Reader/judge retries 0; model mismatches 0; self-judgments 0; two unclear verdicts counted incorrect.
- Independent reconstruction rescored all 1,894 raw verdicts and reproduced 13 arm aggregates and 12 V1 comparisons with zero mismatch.
- Total D16 API tokens: 2,805,144.

### Full-population arm result

| Arm | MPA | FAA | FAMA | FAMA vs V1 [95% persona CI] | Mean tokens | Decision |
|---|---:|---:|---:|---:|---:|---|
| Base | 0.1500 | 0.9780 | 0.1428 | -0.0142 [-0.0308, +0.00005] | 134.19 | Baseline |
| **V1** | 0.1620 | **0.9881** | 0.1570 | -- | 133.16 | Conditional incumbent |
| Tombstone refill | 0.1601 | 0.9838 | 0.1533 | -0.0037 [-0.0149, +0.0070] | 133.39 | Reject |
| Latest-write-wins | 0.1598 | 0.9880 | 0.1543 | -0.0027 [-0.0094, +0.0039] | 135.03 | Reject |
| Recency Top-5 | 0.1453 | 0.9821 | 0.1393 | -0.0176 [-0.0403, +0.0057] | 118.97 | Reject |
| Explicit superseded rendering | 0.1559 | 0.9849 | 0.1497 | -0.0073 [-0.0230, +0.0080] | 146.99 | Reject |
| V1 + two hops | 0.1588 | 0.9879 | 0.1536 | -0.0034 [-0.0086, 0] | 134.42 | Reject |
| V1 + one extra slot | 0.1670 | 0.9862 | 0.1609 | +0.0039 [-0.0068, +0.0144] | 148.66 | Reject cost/uncertainty |
| V1 + two extra slots | **0.1740** | 0.9831 | **0.1663** | +0.0093 [-0.0027, +0.0227] | 160.04 | Reject cost/uncertainty |
| V1 confidence 0.91 | 0.1616 | 0.9889 | 0.1565 | -0.0004 [-0.0013, 0] | 133.23 | Reject |
| V1 confidence 0.96 | 0.1656 | 0.9881 | 0.1600 | +0.0030 [-0.0010, +0.0083] | 133.56 | Near miss, not promoted |
| V1 + aggregate protection | 0.1595 | 0.9881 | 0.1545 | -0.0025 [-0.0100, +0.0050] | 134.14 | Reject |
| V2 combined | 0.1680 | 0.9831 | 0.1591 | +0.0021 [-0.0073, +0.0108] | 147.99 | Reject |

No challenger passes all frozen effect-size, confidence, FAA/MPA, cost, and integrity checks.

### V1 versus Base: heterogeneous effect

| Slice | n | FAMA delta [95% CI] | MPA delta [95% CI] | Interpretation |
|---|---:|---:|---:|---|
| Full population | 200 | +0.0142 [-0.00005, +0.0308] | +0.0120 [-0.0031, +0.0285] | Positive direction, not confirmed as universal |
| Forgetting-bearing | 92 | **+0.0296 [+0.0074, +0.0549]** | **+0.0262 [+0.0044, +0.0517]** | Confirmed positive slice |
| Base-stale-exposed | 6 | +0.3919 [+0.2897, +0.4694] | +0.3111 [+0.1400, +0.4286] | Very large conditional effect; only five clusters |
| Recommending | 38 | **+0.0768 [+0.0203, +0.1395]** | +0.0751 | Strong positive task slice |
| Remembering | 62 | -0.0095 [-0.0247, +0.0029] | **-0.0153 [-0.0319, -0.0029]** | MPA harm signal |
| Reasoning | 100 | +0.0050 [-0.0100, +0.0200] | -- | No confirmed effect |

The earlier 50-case panel contained 43 recommending and seven remembering questions and required Base stale exposure. Its +8.09 FAMA-point result remains correct for that conditional population but overstates general full-traffic benefit.

## Earlier conditioned answer panel

| Metric | Base | V1 | V2 | V1 - Base [95% CI] | V2 - V1 [95% CI] |
|---|---:|---:|---:|---:|---:|
| MPA | 0.3855 | 0.4342 | 0.4461 | +0.0487 [+0.0196, +0.0928] | +0.0119 [-0.0039, +0.0276] |
| FAA | 0.8531 | **0.9369** | 0.8961 | +0.0838 [+0.0599, +0.1067] | **-0.0408 [-0.0762, -0.0064]** |
| FAMA | 0.3195 | **0.4004** | 0.3961 | **+0.0809 [+0.0517, +0.1259]** | -0.0043 [-0.0206, +0.0109] |
| Mean tokens | 144.52 | 146.76 | 201.84 | +1.55% | +37.53% |

This panel establishes mechanism efficacy under stale exposure and the V2 proxy-to-answer reversal. It is not a population estimate.

## D17 proxy alignment

The stance-aware proxy discounts obsolete mentions marked as negated or historical. Across all 13 D16 policies, Kendall tau-b with answer FAMA moves from 0.5290 to 0.5385, an improvement of only 0.0094 versus the frozen +0.10 requirement. Pairwise sign agreement against V1 remains 8/12. D17 is rejected.

## D18 text-only correction construction

The runtime detector reads only shared dialogue text and at most 512 prior units; released operations are attached afterward for scoring. Quarterly persona histories are split 4/3/3 for development/validation/test.

| Test metric (5,954 sessions) | Remove/delete literal | Cue-only | Linked high-confidence |
|---|---:|---:|---:|
| Event precision | 1.0000 | 0.9781 | **0.9789** |
| Event recall | 0.1562 | 0.8029 | **0.7964** |
| Event F1 | 0.2702 | 0.8819 | **0.8783** |
| Kind accuracy | 1.0000 | 0.8228 | **0.8234** |
| Predecessor-link precision | -- | -- | **0.2005** |
| Predecessor-link recall | -- | -- | 0.1618 |
| True-positive sessions with any correct link | -- | -- | 0.4538 |
| Detector p95 | -- | -- | 5.51 ms |

Event precision/recall and latency pass, but link precision, any-correct-link rate, and kind accuracy fail. The next target is scoped entity/state resolution with abstention, not merely adding more English cues.

## D11 efficiency result

On a checksum-frozen 30-question LongMemEval-V2 test, D11 performs 19 evidence-preserving substitutions and reduces mean injected tokens from 2,796.8 to 2,213.9 (-20.84%). The 12 direct-support questions are all equal to Base (0 improved / 12 equal / 0 harmed), and every token, provenance, capacity, disablement, damage, timeout and corruption certificate passes. Because the frozen objective required quality improvement and no answer model was called, D11 is a secondary efficiency/Pareto result only.

## Final evidence boundary

Supported:

- correction-linked management can help when stale memory is present;
- effect is heterogeneous, so selective deployment needs fresh confirmation;
- retrieval proxies cannot safely promote answer policies alone;
- evidence-preserving compression can reduce measured injection cost;
- exact fallback and bounded sidecars are implementable;
- event detection is easier than reliable predecessor linking.

Not supported:

- unconditional V1 deployment over all long-dialogue traffic;
- real multi-round programming-task effectiveness;
- end-to-end automatic correction linking;
- D11 answer-level noninferiority;
- human correctness from two-model agreement;
- treating Base fallback as semantic safety.
