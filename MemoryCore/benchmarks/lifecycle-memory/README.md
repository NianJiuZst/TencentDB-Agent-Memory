# Adaptive lifecycle memory benchmark

This benchmark evaluates a sidecar lifecycle controller for MemoryCore L0 retrieval. It does not replace FTS5, vector search, extraction, or the Gateway path. The controller consumes write-time correction events, builds bounded predecessor-to-successor links, and redirects stale retrieval hits to the latest correction node. A bounded optimizer selects policy parameters from controlled feedback on an optimization split.

## Outcome

The deployable controller improves held-out, stale-exposed quarterly questions, but the final composite promotion gate is not fully passed.

| Evaluation | Base FAMA | Adaptive FAMA | Paired delta | 95% persona-cluster CI | Status |
|---|---:|---:|---:|---:|---|
| Direct evidence proxy, quarterly forgetting-bearing (192) | 0.4502 | 0.4770 | +0.0268 | [+0.0147, +0.0413] | passed |
| Direct evidence proxy, quarterly stale-exposed (61) | 0.0907 | 0.1836 | +0.0929 | [+0.0585, +0.1278] | passed |
| Answer-level FAMA, dual-judge panel, frozen stale-exposed sample (50) | 0.3413 | 0.3990 | +0.0577 | [+0.0123, +0.1171] | primary metric passed |

Answer-level FAA improves by +0.0846, with a 95% CI of [+0.0641, +0.1058]. This misses the unchanged, predeclared +0.10 point threshold, so `lifecycle-adaptive-dual-judge-v2.1` retains machine-readable status `failed`. MiniMax-M3 and DeepSeek-V4-Flash agree on 97.71% of 2,844 paired criterion votes (Cohen's kappa 0.923), and both estimate a positive FAMA effect. The result should be interpreted as promising conditional evidence, not a completed claim about all conversations or real programming agents.

## Components

- `src/core/lifecycle/`: dataset-independent bounded ledger, resolver, optimizer, switch, decision log, and hard fallback, exposed as opt-in named exports from the package root.
- `src/memora-events.ts`: replaceable Memora write-event adapter. It never reads evaluation evidence.
- `src/adaptive-runner.ts`: weekly/monthly optimization and quarterly held-out direct evaluation.
- `src/e2e-runner.ts`: frozen answer-level evaluation with Base, Oracle, or adaptive comparators.
- `src/judge-provider.ts` and `src/dual-judge-runner.ts`: direct-provider MiniMax/DeepSeek judging, equal-weight panel aggregation, per-judge effects, agreement, and unanimous sensitivity analysis.
- `protocol*.json`: immutable protocol history. Every semantic change increments the protocol version.
- `results/result-card.v1.json`: compact checked-in result record. Raw case files are emitted under the chosen output directory.

## Reproduction

The frozen dataset is [geniesinc/Memora](https://github.com/geniesinc/Memora) revision `a6493188efc836d6511ed5e4163fe3ba87da30ff`. The benchmark verifies the aggregate data manifest SHA-256:

```text
dfc82711dd6647bcb0ba590f43a336f0dac02420e981ce957dd1fd13ae331bfc
```

From `MemoryCore`, with dependencies installed:

```bash
tsx benchmarks/lifecycle-memory/src/adaptive-cli.ts \
  --data /path/to/Memora/data \
  --output benchmark-runs/lifecycle-memory/adaptive-v1

tsx benchmarks/lifecycle-memory/src/e2e-cli.ts \
  --data /path/to/Memora/data \
  --output benchmark-runs/lifecycle-memory/e2e-adaptive-v1.1

tsx benchmarks/lifecycle-memory/src/dual-judge-cli.ts \
  --data /path/to/Memora/data \
  --input benchmark-runs/lifecycle-memory/e2e-adaptive-v1.1/cases.jsonl \
  --output benchmark-runs/lifecycle-memory/dual-judge-v2.1

vitest run -c benchmarks/lifecycle-memory/vitest.config.ts
vitest run src/core/lifecycle/ledger.test.ts src/core/lifecycle/optimizer.test.ts
```

The source-answer E2E command requires `OPENROUTER_API_KEY` for its frozen reader. The final judging command reads `MINIMAX_API_KEY` and `DEEPSEEK_API_KEY`, calls the vendors' official APIs directly, and never writes credentials to results. The protocol fixes exact model IDs, endpoints, sampling parameters, aggregation, thresholds, source-case hash, and selection hash before calls are made. Batched criteria make this protocol cheaper than, and not directly comparable to, Memora Table 3.

## Optimization and leakage boundary

The policy grid is fixed at two confidence thresholds and four hop limits. Weekly and monthly forgetting-bearing questions provide optimization feedback. Quarterly data is held out. The optimizer selected:

```json
{
  "enabled": true,
  "minConfidence": 0.85,
  "maxHops": 1,
  "maxExpansions": 64,
  "resultLimit": 5,
  "timeoutMs": 10
}
```

Evaluation labels are used only for scoring and for defining the stale-exposed diagnostic population. Ledger construction uses `session_type`, `operation`, `operation_details`, and shared-memory turns. The E2E selection is therefore conditional but the adaptive controller is label-free at inference.

## Switch and hard fallback

`applyLifecyclePolicy` returns the unmodified Base prefix when the policy is disabled. Missing ledgers, resolver exceptions, timeouts, cycles, capacity violations, and missing successor materialization produce the same Base result with a `fallback` decision and reason. The experiment checks all 600 questions:

- disabled equivalence mismatches: 0/600;
- forced damaged-state fallback mismatches: 0/600;
- forced timeout fallback mismatches: 0/600.

Default per-scope limits are 10,000 units, 5,000 events, and 50,000 edges. Query traversal is additionally bounded by hop, expansion, result-count, and wall-time budgets.

## Internal programming-data adapter

To transfer the method to long programming sessions, keep `src/core/lifecycle/` unchanged and replace only the event adapter. The internal adapter must emit:

- a monotonic event sequence;
- obsolete values or identifiers from explicit correction, revert, rename, or deletion signals;
- successor memory-unit IDs that contain the corrected state or tombstone;
- calibrated confidence and signal provenance.

Likely programming signals include “use X instead of Y,” renamed files or symbols, reverted plans, updated test expectations, tool-confirmed deletion, and explicit user correction. Weak linguistic cues should receive lower confidence and be admitted only if optimization feedback selects them. Assumptions that may fail internally include unavailable structured operation metadata, corrections that do not quote the old value, branch-specific truths, and concurrently valid alternatives.

## Known limitations

- Main evidence comes from public personalized dialogue, not private multi-turn programming data.
- The final E2E set is deliberately stale-exposed and contains 43 recommending versus 7 remembering questions. Panel FAMA improves by 6.67 points on recommending but only 0.19 points on remembering.
- The fixed two-judge panel is not a random sample of judge models. Its strict unanimous sensitivity estimate is +4.77 FAMA points with a 95% CI of [-0.30, +11.21], so the strongest conservative aggregation is not statistically decisive.
- Effects are heterogeneous: seven personas improve and three decline; the median persona effect is +3.40 points, while leave-one-persona-out means range from +3.23 to +6.64 points.
- Exact value matching misses paraphrased corrections and can collide on short or reused values.
- The implementation is a reviewable sidecar module and benchmark integration; wiring it into a production Gateway should occur only after internal adapter validation.
