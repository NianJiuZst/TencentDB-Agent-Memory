# EASI-Mem benchmark harness

EASI-Mem is an evidence-aligned, bounded policy-evolution sidepath for
MemoryCore. It asks a narrower question than end-to-end QA: **did the injected
memory contain the annotated evidence, and at what token and latency cost?**

The harness does not replace MemoryCore's FTS5, vector, or hybrid retrievers.
It indexes public conversation turns through the real SQLite-backed MemoryCore
L0 path, requests a bounded candidate pool, evaluates reviewed injection
profiles, and emits a versioned policy only after safety gates pass.

## Reproducibility contract

Primary development data:

- LongMemEval-S-cleaned, 500 cases.
- Hugging Face revision:
  `98d7416c24c778c2fee6e6f3006e7a073259d48f`.
- SHA-256:
  `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Protocol seed: `20260823`.
- Category-stratified split: 280 train, 92 development, 98 held-out,
  plus 30 abstention probes.

External stress-test data:

- Official LoCoMo-10, 1,986 QA records in 10 conversations.
- SHA-256:
  `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
- 1,536 category 1-4 questions with explicit evidence are scored.
- 446 adversarial category-5 questions and four questions without evidence are
  retained as negative-load probes.
- Uncertainty is estimated by resampling whole conversations, not individual
  questions.

LoCoMo is licensed CC BY-NC 4.0 by its authors. The dataset is downloaded by
the evaluator and is not vendored in this repository.

## Run

```bash
cd MemoryCore
pnpm install --ignore-scripts

pnpm eval:easi-mem -- \
  --dataset /absolute/path/longmemeval_s_cleaned.json \
  --output benchmark-runs/easi-mem/v1.4-full

pnpm eval:easi-mem:locomo -- \
  --dataset /absolute/path/locomo10.json \
  --policy benchmarks/easi-mem/results/v1.4/policy.json \
  --output benchmark-runs/easi-mem/locomo-v1.4
```

Every run writes:

- `report.json`: protocol, checksums, split sizes, aggregate metrics,
  confidence intervals, and explicit pass/fail checks;
- `policy.json`: bounded, validated production policy (development run only);
- `cases.jsonl`: paired case-level decisions and metrics.

Raw runs are intentionally ignored. The compact, reviewed receipts under
`results/v1.4/` are tracked. The tracked policy preserves the exact bytes used
by the checksum-enforcing LoCoMo replication command.

## Adapter boundary

`ConversationDatasetAdapter` normalizes a source into `EvalCase`:

- stable case and dependency-group identifiers;
- query and optional answer (the runtime router never receives the answer);
- ordered user/assistant turns with stable turn and session identifiers;
- gold evidence turn identifiers and gold evidence session identifiers;
- category and negative-load flag.

The scorer, policy search, promotion gate, report writer, and runtime controller
do not depend on either public dataset's native schema. To connect internal
multi-turn programming sessions, implement the same adapter and map, for
example:

- conversation or task ID -> `groupId`;
- source message, tool result, patch, or commit ID -> evidence turn ID;
- coding request -> query;
- explicit correction, accepted patch, or controlled evaluator label ->
  evidence alignment;
- stale or contradicted memory -> negative label or lifecycle probe.

Programming data will invalidate at least three public-data assumptions: a
single answer may depend on tool state rather than text alone, evidence may be
an ordered chain rather than an unordered set, and later corrections can
invalidate earlier evidence. Those belong in a new protocol version, not in
dataset-specific branches in the core runner.

## Metrics

For each non-negative case, the harness reports:

- any/all/macro evidence-session recall;
- any/all/macro evidence-turn recall;
- session NDCG;
- injected item and exact `cl100k_base` token counts;
- evidence-aligned token rate;
- backend query latency p50/p95.

The primary effect metric is macro evidence-session recall. It is paired with
injected tokens; a policy is not promoted merely for returning more memory.
Paired bootstrap is used on LongMemEval. LoCoMo uses conversation-cluster
bootstrap because its 1,986 questions share only ten underlying histories.

The direct metric removes answer-model and judge variance, but it does **not**
prove that a downstream model used the evidence correctly. In particular,
message-level evidence cannot certify that an aggressively truncated fragment
retains the answer-bearing span, so EASI-Mem never awards recall to synthetic
fragments that lack an explicit provenance unit.

## Bounded evolution

The v1.4 action set contains eight reviewed profiles:

- the exact Top-5 base path;
- a Top-30/Top-10 control with a fixed 896-token cap;
- six Top-30/Top-10 profiles whose effective budget is
  `min(1024, ratio * base_top5_tokens)`, for ratios 0.70 through 0.95.

The optimizer may select a global profile or a shallow, confidence-gated tree
over runtime-only query/scout features. It cannot inspect question type, answer,
split, or gold labels at runtime. Profiles, candidate limits, output limits,
budgets, reranking weights, and tree depth have hard caps.

Promotion requires all of the following under a fixed protocol:

- the lower 95% bound of macro-session-recall delta is no worse than -1 pp;
- any- and all-session recall are each within -1 pp;
- at least 10% mean token reduction;
- the token-delta 95% interval is entirely below zero;
- the joint recall/cost utility 95% interval is above zero.

If no candidate qualifies, the optimizer emits/selects the base profile.

## Results and interpretation

LongMemEval v1.4 selected `relative-75`. On the 98-case held-out split it
changed macro evidence-session recall from 0.82398 to 0.85000 and mean injected
tokens from 1018.77 to 712.17 (30.09% reduction). The recall-delta 95% interval
was [-0.00510, 0.06071], and the utility interval was [0.00431, 0.07048]. This
passes the predeclared gate, but is treated as **developmental evidence** because
earlier protocol versions had already exposed aggregate LongMemEval test
results.

The checksum-frozen policy did not transfer safely to LoCoMo. Across 1,536
evidence questions, macro session recall fell from 0.74031 to 0.69516 while
tokens fell 27.56%; the conversation-cluster interval for recall delta was
[-0.05612, -0.03354]. The result is a deliberate reported failure, not a new
baseline tuned after seeing LoCoMo.

An exploratory leave-one-conversation-out calibration selected the exact base
profile for all 10/10 held-out conversations because no candidate passed the
training-side gates on the other nine. It prevented the harmful update but made
no improvement. This is the central safety result: a distribution shift can
make an apparently efficient policy harmful, and a guarded optimizer must be
able to reject evolution.

## Production switch and fallback

Example configuration:

```json
{
  "recall": {
    "maxResults": 5,
    "adaptive": {
      "enabled": true,
      "policyPath": "policies/easi-mem-v1.4.json",
      "timeoutMs": 250
    }
  }
}
```

When disabled, the original `searchMemories` call graph is retained. When
enabled, the sidepath validates the policy and its evaluated base profile,
requests candidates from the existing retriever, performs bounded reranking and
packing, and logs the policy revision, profile, candidate/result limits,
effective token budget, returned items/tokens, latency, and fallback reason.

Missing, malformed, oversized, incompatible, timed-out, or failed policies
hard-fallback to one exact call with the original `maxResults`. The base
retriever is never deleted or replaced.

## Protocol history

- v1.0: query-only contextual router; failed.
- v1.1: added Top-5 scout features; failed.
- v1.2: conservative router selected the static safe arm; no gain.
- v1.3: separated global from contextual promotion; fixed 896-token global arm
  passed on LongMemEval, contextual routing was rejected.
- v1.4: replaced corpus-sensitive absolute tuning with a predeclared
  base-relative grid, strengthened confidence gates, froze the resulting policy,
  and added the LoCoMo external stress test.

Any future metric, label, split, or profile-space change must increment the
protocol version and rerun every baseline.
