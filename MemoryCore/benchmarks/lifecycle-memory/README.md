# Adaptive lifecycle memory benchmark

This benchmark evaluates a switchable lifecycle sidecar above MemoryCore L0 retrieval. It keeps the existing FTS5/vector candidate path, learns a bounded correction policy from controlled feedback, and returns the original Base prefix on disablement, timeout, corruption, or missing state.

For the compact production integration and evaluation handoff, see [`DELIVERY_CN.md`](DELIVERY_CN.md) or the [three-page PDF](../../output/pdf/tencentdb-agent-memory-lifecycle-delivery-cn.pdf). For a Chinese, decision-oriented account of the complete V1--D18 evidence, see [`REPORT_CN.md`](REPORT_CN.md). The English paper remains the theory and full experimental-process artifact. The compact machine-readable registry is [`results/direction-summary.v2.json`](results/direction-summary.v2.json).

## Outcome

**V1 is a conditional research incumbent; the larger V2 challenger is rejected.** The original 50-case Base-stale-exposed panel establishes that V1 can help when lifecycle correction is needed. D16 broadens answer evaluation to all 200 cases unused by earlier answer panels and finds a smaller, uncertain full-population effect, a confirmed positive forgetting-bearing effect, and a remembering-MPA harm signal. No simple baseline or isolated V2 factor passes the frozen promotion gate. D18 further shows that text-only correction-event detection transfers but predecessor linking does not, so V1 remains oracle-management evidence rather than an end-to-end extraction result. No result here authorizes an unconditional rollout or establishes effectiveness on real programming sessions.

| Frozen 50-case cross-model evaluation | Base | V1 | V2 | V1 vs Base [95% CI] | V2 vs V1 [95% CI] |
|---|---:|---:|---:|---:|---:|
| MPA | 0.3855 | 0.4342 | 0.4461 | +0.0487 [+0.0196, +0.0928] | +0.0119 [-0.0039, +0.0276] |
| FAA | 0.8531 | 0.9369 | 0.8961 | +0.0838 [+0.0599, +0.1067] | -0.0408 [-0.0762, -0.0064] |
| FAMA | 0.3195 | **0.4004** | 0.3961 | **+0.0809 [+0.0517, +0.1259]** | -0.0043 [-0.0206, +0.0109] |
| Mean injected tokens | 144.52 | **146.76** | 201.84 | +1.55% | +37.53% |

Both MiniMax-M3 and DeepSeek-V4-Flash act as readers and judges. The primary crossed aggregation lets DeepSeek judge MiniMax answers and MiniMax judge DeepSeek answers, excluding self-judgment. The full-factorial sensitivity result agrees with the primary ordering: V1 versus Base is +8.26 FAMA points, V2 versus Base is +7.66, and V2 versus V1 is -0.60.

The two judges agree on 96.79% of 8,532 paired criterion votes (Cohen's kappa 0.899). The run completed 300 reader calls and 600 judge calls with zero retries and zero returned-model mismatches; three of 8,532 DeepSeek verdicts were `unclear` and counted as incorrect.

The conditioned table above is not a population estimate. D16 uses the other 200 answer cases (100 reasoning, 62 remembering, 38 recommending; only six Base-stale-exposed). V1 versus Base is +1.42 FAMA points with a persona-bootstrap interval that touches zero, +2.96 points with a positive interval on 92 forgetting-bearing questions, and -1.53 MPA points with a negative interval on 62 remembering questions. D16 completes 1,894 reader and 1,894 crossed-judge calls over 13 arms; an independent validator reproduces every aggregate with zero mismatch.

## What was optimized

V1 uses fixed-budget successor redirection:

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

V2 expands the bounded search space to 36 policies over confidence, hop count, zero-to-two extra injection slots, and a query-text historical-aggregate guard. The optimizer observes 300 weekly/monthly questions (188 forgetting-bearing and 112 non-forgetting), penalizes protected-slice harm and token cost, and selects confidence 0.96, two hops, at most two extra slots, and aggregate protection.

On quarterly direct evidence, V2 improves FAMA proxy over Base by +3.13 points on 192 forgetting-bearing questions and +10.28 points on 61 stale-exposed questions. It also exceeds V1 by +0.45 and +1.00 points on those slices. However, those direct gains do not survive answer generation. A post-hoc audit finds exact obsolete values in 86 V2 contexts versus 74 V1 contexts and in 81 V2 answers versus 66 V1 answers; 96 forgetting criteria move from V1-correct to V2-wrong, while 41 move in the opposite direction. This is descriptive evidence, not a causal ablation: exact matching cannot distinguish negation, and V1/V2 differ in several parameters.

A post-hoc Safe-Hybrid diagnostic (V1 for current-state queries, Base for historical aggregates, fixed `k=5`) is intentionally not promoted either. It is byte-equivalent to V1 on the frozen answer-level sample, but across all 600 direct cases it is 0.0047 FAMA points below V1 and uses 0.36% more tokens, failing its strict no-regression/no-extra-cost gate.

## Components

- `src/core/lifecycle/`: dataset-independent bounded ledger, resolver, optimizer, promotion gate, switch, decision log, and hard fallback.
- `src/memora-events.ts`: replaceable Memora write-event adapter; it never reads evaluation labels.
- `src/adaptive-runner.ts`: V1 weekly/monthly optimization and quarterly direct evaluation.
- `src/contextual-runner.ts`: V2 bounded policy search, intent protection, direct comparison, decision logs, and stable context manifest.
- `src/contextual-e2e-runner.ts`: Base/V1/V2 two-reader, two-judge answer evaluation with crossed primary aggregation.
- `src/contextual-e2e-failure-analysis.ts`: deterministic post-hoc exposure and criterion-transition audit.
- `src/safe-hybrid-runner.ts`: explicitly post-hoc safety-contraction diagnostic.
- `src/broad-ablation-context.ts` and `src/broad-ablation-e2e-runner.ts`: D16 13-arm broad contexts, exact prompt reuse, crossed answer evaluation, and subgroup reports.
- `src/stance-proxy-runner.ts`: D17 policy-rank alignment between direct and answer metrics.
- `src/text-correction-detector.ts`: D18 bounded text-only correction cues and predecessor linker; runtime does not read Memora operation metadata.
- `protocol*.json`: immutable protocol history; semantic changes receive new versions.
- `results/direction-summary.v2.json`: compact V1/V2/D1--D18 registry; D16--D18 raw and summary artifacts are checked in below their result directories.

## Reproduction

Use [geniesinc/Memora](https://github.com/geniesinc/Memora) at revision `a6493188efc836d6511ed5e4163fe3ba87da30ff`. The adapter verifies this aggregate data-manifest SHA-256:

```text
dfc82711dd6647bcb0ba590f43a336f0dac02420e981ce957dd1fd13ae331bfc
```

From `MemoryCore`, with dependencies installed:

```bash
# V1 direct run and deterministic frozen selection; --dry-run makes no model call.
pnpm eval:lifecycle-adaptive -- \
  --data /path/to/Memora/data \
  --output benchmark-runs/lifecycle-memory/adaptive-v1

pnpm eval:lifecycle-e2e -- \
  --data /path/to/Memora/data \
  --output benchmark-runs/lifecycle-memory/e2e-adaptive-v1.1 \
  --dry-run

# V2 direct optimization/confirmation and stable candidate manifest.
pnpm eval:lifecycle-contextual -- \
  --data /path/to/Memora/data \
  --selection benchmark-runs/lifecycle-memory/e2e-adaptive-v1.1/selection.json \
  --output benchmark-runs/lifecycle-memory/contextual-v2.1

# Final answer-level run: official provider APIs only; no OpenRouter dependency.
pnpm eval:lifecycle-contextual-e2e -- \
  --data /path/to/Memora/data \
  --selection benchmark-runs/lifecycle-memory/e2e-adaptive-v1.1/selection.json \
  --contexts benchmark-runs/lifecycle-memory/contextual-v2.1/context-manifest.json \
  --output benchmark-runs/lifecycle-memory/contextual-e2e-v1

pnpm validate:lifecycle-contextual-e2e -- \
  --evaluations benchmark-runs/lifecycle-memory/contextual-e2e-v1/evaluations.jsonl \
  --summary benchmark-runs/lifecycle-memory/contextual-e2e-v1/summary.json \
  --output benchmark-runs/lifecycle-memory/contextual-e2e-v1/validation.json

pnpm analyze:lifecycle-contextual-e2e -- \
  --data /path/to/Memora/data \
  --evaluations benchmark-runs/lifecycle-memory/contextual-e2e-v1/evaluations.jsonl \
  --output benchmark-runs/lifecycle-memory/contextual-e2e-v1/failure-analysis.json

# Post-hoc diagnostic; not part of the confirmatory claim.
pnpm eval:lifecycle-safe-hybrid -- \
  --data /path/to/Memora/data \
  --selection benchmark-runs/lifecycle-memory/e2e-adaptive-v1.1/selection.json \
  --output benchmark-runs/lifecycle-memory/safe-hybrid-v3

# Recompute D16 from checked-in raw verdicts; makes no provider call.
pnpm validate:lifecycle-broad-ablation-e2e -- \
  --contexts benchmarks/lifecycle-memory/results/d16-broad-ablation/context/context-manifest.json \
  --evaluations benchmarks/lifecycle-memory/results/d16-broad-ablation/e2e/evaluations.jsonl \
  --summary benchmarks/lifecycle-memory/results/d16-broad-ablation/e2e/summary.json

# Recompute D17 policy-rank alignment; makes no provider call.
pnpm analyze:lifecycle-stance-proxy -- \
  --data /path/to/Memora/data \
  --contexts benchmarks/lifecycle-memory/results/d16-broad-ablation/context/context-manifest.json \
  --answers benchmarks/lifecycle-memory/results/d16-broad-ablation/e2e/summary.json

# Re-run D18 text-only detector/linker; makes no provider call.
pnpm eval:lifecycle-text-correction -- \
  --data /path/to/Memora/data

pnpm test:lifecycle-memory
vitest run src/core/lifecycle
```

The final answer-level command reads `MINIMAX_API_KEY` and `DEEPSEEK_API_KEY`, uses the vendors' official endpoints, and never writes credentials. Protocols pin exact model IDs, endpoints, sampling settings, hashes, metrics, aggregation, and gates before answer calls. The runner is resumable and records calls, retries, returned model IDs, latency, and usage.

## Evaluation and leakage boundary

- Public data: 600 questions, 27,614 sessions, and 10 personas across weekly, monthly, and quarterly horizons.
- V1 optimization: weekly/monthly forgetting-bearing questions; quarterly was its original held-out split.
- V2 optimization: all weekly/monthly questions. Quarterly had already been observed during V1 development, so V2 calls it a confirmation split rather than a pristine holdout.
- Protocol v2.0 fixed the grid, objective, split, uncertainty, and gates. A pre-score intent check found 30 repeated-template false negatives; v2.1 changed only those query-text patterns and reran all 600 cases. The repository protocols are predeclared artifacts, not externally timestamped preregistrations.
- Answer-level sample: the same frozen 50 quarterly, Base-stale-exposed cases (five per persona; 43 recommending and seven remembering). V2 candidate IDs differed on all 50, so all Base, V1, and V2 answers were generated afresh.
- D16 broad sample: all 200 quarterly cases not used by the two earlier answer panels. Selection is outcome-blind and not conditioned on Base stale exposure, but quarterly Memora was already visible to proxy development.
- D18: uses only ten quarterly persona histories to avoid recounting weekly/monthly prefixes. Runtime prediction is persona-disjoint and cannot read operation metadata; gold operations are attached after prediction for scoring.
- Labels score results and validate the query-intent adapter; they are not available to the runtime controller. The public classifier matches Memora's repeated templates with zero errors on 600 cases, which should not be interpreted as general-language accuracy.
- Batched criterion scoring is not directly comparable to Memora Table 3.

## Switch, promotion, and hard fallback

`applyLifecyclePolicy` returns the unmodified Base prefix when disabled. Missing ledgers, resolver exceptions, timeouts, cycles, capacity violations, and missing successor materialization return the same Base prefix with a `fallback` decision and reason. All direct protocols report zero mismatches over 600 disabled, forced-damage, and forced-timeout checks.

The admission pipeline separates proposal from deployment. Direct quality, harm, cost, equivalence, and forced-fallback checks must pass before answer evaluation. `promoteLifecyclePolicy` then requires every predeclared downstream quality, forgetting, relative-improvement, and token check to pass. V2 misses the answer-level FAA magnitude threshold and the positive V2-versus-V1 FAMA check, so the machine-readable outcome is `retain_incumbent`.

Default per-scope capacities are 10,000 units, 5,000 events, and 50,000 edges. Query traversal is additionally bounded by hop, expansion, result-count, and wall-time budgets.

## Internal programming-data adapter

To transfer the method to long programming sessions, keep `src/core/lifecycle/` and replace the public-data adapters. The internal adapter must provide:

- a monotonic event sequence and stable memory-unit IDs;
- obsolete values or identifiers from explicit correction, revert, rename, deletion, or environment-change signals;
- successor memory-unit IDs containing the corrected state or tombstone;
- calibrated confidence and signal provenance;
- query scope such as repository, branch, environment, component, and task when available.

Likely signals include “use X instead of Y,” renamed files or symbols, reverted plans, changed tests, tool-confirmed deletion, and explicit user correction. Weak linguistic cues should receive lower confidence and enter policy optimization only after adapter-specific calibration. Memora has no repository/branch/environment fields, so scope-aware coexistence remains an interface requirement, not a validated public-data claim.

## Known limitations

- Main evidence comes from personalized dialogue, not private multi-turn programming data.
- The answer-level set is conditional on stale exposure and is task-imbalanced; it is not a population estimate over all 600 questions.
- D16 reduces that selection bias but still comes from the same already-observed Memora revision; it finds heterogeneous rather than universal V1 effects.
- Neither V1 nor V2 meets every strict production-style magnitude gate; V1 is the best-tested research policy, not an unconditional deployment recommendation.
- The crossed design reduces self-judging bias but still uses a fixed two-model pool.
- The V2 direct proxy selected a policy that did not improve answer-level FAMA, demonstrating proxy-to-generation mismatch.
- Exact value matching misses paraphrases and can collide on short or reused values.
- D18 event detection is strong, but predecessor-link precision is only 20.05%; automatic graph construction is not validated.
- Branch-local and concurrently valid facts require an internal scope adapter and new evaluation data.
