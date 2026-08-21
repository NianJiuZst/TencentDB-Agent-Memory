# Experimental result record

## Decision

Retain the fixed-budget V1 correction-linked policy as the research incumbent. Reject the contextual V2 challenger and the post-hoc Safe-Hybrid as default replacements. V1 is the strongest tested candidate for an internal programming-data pilot behind the existing switch and hard fallback, but it has not met every strict production-promotion threshold.

The decisive experiment uses 50 frozen, quarterly, Base-stale-exposed Memora questions. MiniMax-M3 and DeepSeek-V4-Flash each generate Base, V1, and V2 answers; each answer is judged by both models. The primary crossed estimate excludes self-judgment by pairing each reader with the other judge.

## Primary cross-reader result

| Metric | Base | V1 | V2 | V1 − Base [95% CI] | V2 − Base [95% CI] | V2 − V1 [95% CI] |
|---|---:|---:|---:|---:|---:|---:|
| MPA | 0.3855 | 0.4342 | 0.4461 | +0.0487 [+0.0196, +0.0928] | +0.0606 [+0.0216, +0.1090] | +0.0119 [-0.0039, +0.0276] |
| FAA | 0.8531 | 0.9369 | 0.8961 | +0.0838 [+0.0599, +0.1067] | +0.0431 [+0.0029, +0.0848] | **−0.0408 [−0.0762, −0.0064]** |
| FAMA | 0.3195 | **0.4004** | 0.3961 | **+0.0809 [+0.0517, +0.1259]** | +0.0766 [+0.0441, +0.1141] | −0.0043 [−0.0206, +0.0109] |
| Criterion accuracy | 0.7040 | **0.7606** | 0.7382 | +0.0566 [+0.0385, +0.0758] | +0.0342 [+0.0118, +0.0604] | **−0.0224 [−0.0424, −0.0042]** |

V1 improves FAMA in all 10 persona clusters. Its median persona effect is +5.91 points, and every leave-one-persona-out mean remains positive (+6.07 to +8.63 points). V2 improves over Base in nine personas but beats V1 in only three.

The full-factorial sensitivity analysis, which averages all four reader/judge cells including self-judgment, preserves the ordering: V1 versus Base is +8.26 FAMA points, V2 versus Base is +7.66, and V2 versus V1 is −0.60.

## Operational integrity

- Frozen cases: 50; arms: Base, V1, V2; readers: 2.
- Reader-arm evaluations: 300/300 unique and complete.
- Reader calls: 300; judge calls: 600.
- Reader retries: 0; judge retries: 0.
- Returned reader-model mismatches: 0; returned judge-model mismatches: 0.
- Judge agreement: 8,258/8,532 criterion votes, or 96.79%; Cohen's kappa 0.899.
- Non-binary/unclear verdicts: 3/8,532, all counted as incorrect.
- Mean injected tokens: Base 144.52, V1 146.76 (+1.55%), V2 201.84 (+39.66% versus Base; +37.53% versus V1).

An independent parser recomputed every criterion score, per-answer metric, crossed arm mean, and summary value from the 300 raw records with zero mismatches. A separate 20,000-sample persona bootstrap using another seed gives V1-versus-Base FAMA CI [5.19, 12.53], V2-versus-Base [4.46, 11.47], V2-versus-V1 [−2.01, 1.04], and V2-versus-V1 FAA [−7.57, −0.73] points.

## Why V2 was proposed

The V1 controller redirects stale Top-5 candidates through high-confidence correction links while preserving a fixed five-item budget. A direct audit found one genuine V1 weakness: applying “latest wins” to historical aggregate questions can rewrite evidence needed for questions such as totals or week comparisons.

V2 therefore tested a bounded 36-policy space:

- confidence in {0.85, 0.91, 0.96};
- hops in {1, 2};
- extra slots in {0, 1, 2};
- historical-aggregate protection on/off;
- maximum 64 expansions, 10 ms, and seven returned items.

The optimizer uses weekly/monthly direct feedback, rewards FAMA proxy on 188 forgetting-bearing questions, and penalizes positive loss on 112 non-forgetting questions, token cost, and fallback. It selected confidence 0.96, two hops, two extra slots, and aggregate protection.

## Direct V2 result

The direct retrieval protocol passes every predeclared V2 confirmation check:

| Quarterly slice | n | Base | V1 | V2 | V2 − Base [95% CI] | V2 − V1 [95% CI] |
|---|---:|---:|---:|---:|---:|---:|
| All | 300 | 0.4229 | 0.4395 | 0.4446 | +0.0217 [+0.0115, +0.0325] | +0.0052 [+0.0015, +0.0095] |
| Forgetting-bearing | 192 | 0.4502 | 0.4770 | 0.4815 | +0.0313 [+0.0154, +0.0487] | +0.0045 [+0.0009, +0.0087] |
| Base-stale-exposed | 61 | 0.0907 | 0.1836 | 0.1935 | +0.1028 [+0.0616, +0.1441] | +0.0100 [+0.0026, +0.0188] |

On the 100 quarterly reasoning questions, the guard is byte-equivalent to Base and eliminates V1's small direct recall loss. The query-text classifier has 0 false positives and 0 false negatives against Memora task labels over 600 questions, but this reflects a small repeated template family rather than general-language accuracy.

These results made V2 a reasonable challenger but not a safe promotion. The downstream answer experiment fails two fixed checks: V2-versus-Base FAA is +4.31 rather than the required +10 points, and V2-versus-V1 FAMA is negative rather than positive. `promoteLifecyclePolicy` therefore emits `retain_incumbent` and records both failed checks.

## Failure analysis

V2 increases MPA slightly over V1 but lowers FAA. A post-hoc exact-value audit over the 100 paired reader answers makes the exposure pattern measurable:

- At least one normalized obsolete value occurs in 86 V2 contexts versus 74 V1 contexts.
- The corresponding answer rates are 81/100 for V2 and 66/100 for V1.
- V2 answers average 126.73 completion tokens versus 111.99 for V1.
- Across 1,866 paired forgetting-criterion comparisons, 96 move from correct under V1 to wrong under V2, while 41 move in the other direction, for a net loss of 55 correct decisions.

Case inspection includes correction statements and removed to-do items repeated in negated or historical form. This is consistent with greater exposure, but it is not a causal explanation: exact matching misses paraphrases and cannot distinguish negation, the criteria within an answer are correlated, and the audit was defined after seeing the outcome.

The evidence does **not** isolate extra slots as the sole cause: V2 also changes confidence, hop limits, and aggregate protection. The correct conclusion is that the selected V2 policy as a whole overfits the direct proxy. A future candidate should keep V1's fixed budget, isolate one policy dimension at a time, and require answer-level safety feedback before promotion.

## Safe-Hybrid diagnostic

After observing the V2 failure, a clearly labeled post-hoc contraction kept V1 for current-state queries, used Base for historical aggregates, and fixed `k=5`. It produced zero routing mismatches, was byte-identical to V1 on all 50 frozen answer-level cases, and passed disabled/damaged/timeout fallback checks. It nevertheless failed its own strict diagnostic gate across all 600 direct cases:

- FAMA proxy: 0.419076 versus V1 0.419123 (−0.0047 points; 95% CI −0.0290 to +0.0196 points).
- Mean injected tokens: 126.43 versus V1 125.98 (+0.36%).

Because it was designed after the V2 result and did not dominate V1, it is not presented as confirmatory evidence or the new default.

## Earlier result retained for provenance

The earlier fixed GPT-4o-mini-reader, two-judge evaluation estimated V1-versus-Base FAMA at +5.77 points (95% CI +1.23 to +11.71) and FAA at +8.46 points. It remains a valid secondary run, but the new cross-reader experiment is the primary result because it regenerates answers with the user-selected current models and avoids an OpenRouter dependency.

The earlier V1 composite gate also remained failed because its +8.46 FAA point estimate missed the unchanged +10-point threshold. Thus “V1 is best tested” does not mean “all deployment gates passed.”

## Transfer boundary

Memora validates correction chains, stale exposure, query protection, budget accounting, and fallback on public long dialogue. It does not contain repository, branch, environment, component, or task-scope labels. Programming-data transfer should keep the core ledger and promotion gate while replacing the event, query-intent, and scope adapters. No claim is made about real long programming tasks until that adapter and task-level protocol are run.
