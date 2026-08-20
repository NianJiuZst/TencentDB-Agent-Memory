# EASI-Mem: research and design note

## Executive conclusion

This implementation focuses on directions A, C, and F of the challenge:

1. direct, provenance-aligned evaluation of retrieved/injected memory;
2. bounded optimization of candidate-pool size and returned Top-k;
3. adaptive injection budgets with promotion gates and hard fallback.

It deliberately does not retrain extraction models or replace MemoryCore's
FTS5/vector engines. The outcome is mixed and informative. A reviewed policy
passes the developmental LongMemEval protocol, but fails a checksum-frozen
LoCoMo transfer. A leave-one-conversation-out optimizer rejects every harmful
candidate and returns the base path. Therefore the supported claim is:

> Evidence-aligned feedback can cheaply optimize a bounded memory policy on a
> target distribution, while confidence gates can prevent unsafe evolution;
> the learned policy itself is not shown to transfer universally.

## Problem definition

Let a query at turn `t` have an annotated evidence set `G_t` and let the memory
system inject a set of provenance-bearing units `I_t(theta)` under policy
`theta`. End-to-end task success combines retrieval, reader/model ability,
prompting, tool execution, and decoding. EASI-Mem instead measures the memory
boundary directly:

- whether any/all gold sessions occur in `I_t`;
- macro recall over gold sessions and turns;
- evidence ranking quality (NDCG);
- injected items/tokens and retrieval latency.

The optimization problem is constrained rather than scalar-only:

```
maximize   mean evidence recall + lambda * normalized token saving
subject to recall confidence lower bound >= -epsilon
           any/all recall point guards >= -epsilon
           token saving >= tau and its confidence interval excludes zero
           finite reviewed action space and complexity caps
```

For v1.4, `epsilon=0.01`, `tau=0.10`, `lambda=0.03`, and bootstrap samples are
5,000.

## Related work and gap

Hierarchical and virtual memory systems such as
[MemGPT](https://arxiv.org/abs/2310.08560), temporal graph systems such as
[Zep/Graphiti](https://arxiv.org/abs/2501.13956), and structured
retain/recall/reflect systems such as
[Hindsight](https://arxiv.org/abs/2512.12818) make memory a first-class agent
component. [Memory-R1](https://arxiv.org/abs/2508.19828) learns memory
operations with reinforcement learning. Recent self-evolution work is even
closer: [EvolveMem](https://arxiv.org/abs/2605.13941) exposes retrieval
configuration as an optimization space with rollback, and
[SelfMem](https://arxiv.org/abs/2607.03726) lets an agent refine memory
strategies from feedback.

The gap addressed here is narrower and systems-oriented:

- those systems are not drop-in safety sidepaths for MemoryCore;
- end-to-end QA scores do not isolate whether injected memory contained the
  needed evidence;
- policy evolution is easy to overfit to one benchmark or average message
  granularity;
- many reports do not require byte-identical base behavior when adaptation is
  off or broken.

[LongMemEval](https://arxiv.org/abs/2410.10813) provides session and turn-level
answer annotations over long multi-session histories.
[LoCoMo](https://aclanthology.org/2024.acl-long.747/) provides dialogue IDs as
evidence for QA over ten long conversations. EASI-Mem uses both as method
validation, not as proof about production programming agents.

## Architecture

### Data plane

The benchmark adapter produces a common `EvalCase`. The backend inserts all
conversation turns through MemoryCore's real `VectorStore` L0 schema and calls
the real `executeConversationSearch` FTS5 path. The maximum candidate pool is
30. No synthetic retriever or evaluator-only index is substituted.

The current public experiment intentionally uses L0 turns. L1 extraction would
introduce a model, prompt, and asynchronous-pipeline confound. The production
patch nevertheless persists `source_message_ids` through SQLite and TCVDB L1
stores, readers, FTS hydration, and memory-search responses so the same direct
alignment can later score L1 entries.

### Policy plane

A policy is a versioned JSON object containing:

- at most eight named profiles;
- candidate limit <= 50 and result limit <= 12;
- token budget <= 4,096;
- recency weight <= 0.10 and diversity weight <= 0.25;
- optional base-token ratio in [0.10, 1.00];
- router depth <= 5.

The runtime router can inspect query length/cues, document count, and bounded
Top-5 score/source/token statistics. Its type does not accept answer, category,
split, or gold evidence. v1.4 ultimately promotes a global leaf, so production
performs one candidate query rather than an unnecessary scout query.

### Runtime sidepath

`recall.adaptive.enabled=false` preserves the previous auto-recall call graph.
When enabled, MemoryCore:

1. reads and validates the policy under a per-stage timeout;
2. verifies that the runtime Top-k base matches the baseline evaluated by the
   policy;
3. asks the existing search function for the bounded candidate limit;
4. applies bounded recency/diversity reranking and exact token packing;
5. applies pre-existing character budgets as an additional guard;
6. logs a structured decision.

Any exception, timeout, corrupt JSON, invalid limit, missing policy, or baseline
mismatch triggers one call to the original base query. The failed adaptive
query is never treated as an empty successful result.

## Evaluation protocol

### Gold alignment

LongMemEval `has_answer=true` turns define gold turn IDs and
`answer_session_ids` define gold sessions. LoCoMo `evidence` dialogue IDs map
to both turns and containing sessions. LoCoMo image-bearing turns append the
dataset-provided caption and image-search query to the textual memory; this is
declared because some annotated facts are otherwise absent from text.

Category-5 LoCoMo questions are adversarial: their topical dialogue IDs are not
treated as positive answer evidence. They and the four questions with no
evidence become negative-load probes.

### Splitting and uncertainty

LongMemEval uses deterministic category-stratified SHA-256 ordering. All arms
share exactly the same 280/92/98 cases, and comparisons use paired bootstrap.
Earlier v1.0-v1.3 iterations exposed aggregate held-out results, so v1.4's
LongMemEval held-out numbers are explicitly developmental.

The LoCoMo policy file is checksum-frozen before retrieval. Since 1,986
questions share only ten conversations, confidence intervals resample whole
conversation clusters. A secondary calibration experiment is labeled
exploratory because it was designed after observing transfer failure; each
held-out conversation nevertheless uses labels from the other nine only.

### Cost-aware profiles

The base arm returns Top-5 without an adaptive token cap. The fixed control
requests 30, returns at most 10, and caps at 896 tokens. Relative profiles use:

```
effective_budget = min(1024, floor(ratio * tokens(base Top-5)))
```

for ratios 0.70, 0.75, 0.80, 0.85, 0.90, and 0.95. This definition was frozen
before LoCoMo retrieval to avoid an absolute budget tied to LongMemEval's much
longer turns.

## Results

### LongMemEval developmental result

The development split selects `relative-75`. On the 98-case held-out split:

| Metric | Base | Relative-75 | Difference |
|---|---:|---:|---:|
| Macro session recall | 0.82398 | 0.85000 | +0.02602 |
| Any-session recall | 0.91837 | 0.94898 | +0.03061 |
| All-session recall | 0.73469 | 0.77551 | +0.04082 |
| Macro turn recall | 0.69898 | 0.71769 | +0.01871 |
| Mean injected tokens | 1018.77 | 712.17 | -30.09% |
| Query latency p50 (ms) | 0.662 | 1.326 | +0.664 |
| Query latency p95 (ms) | 1.648 | 2.348 | +0.700 |

The macro-session-recall delta has a paired 95% interval of
[-0.00510, 0.06071]. The mean token delta is -306.59 with interval
[-346.28, -271.77]. Joint utility is +0.03505 with interval
[0.00431, 0.07048]. All v1.4 promotion checks pass.

### LoCoMo frozen transfer failure

On 1,536 evidence questions from ten conversations:

| Metric | Base | Frozen Relative-75 | Difference |
|---|---:|---:|---:|
| Macro session recall | 0.74031 | 0.69516 | -0.04516 |
| Any-session recall | 0.81185 | 0.76302 | -0.04883 |
| All-session recall | 0.68424 | 0.64323 | -0.04102 |
| Macro turn recall | 0.42438 | 0.37116 | -0.05323 |
| Mean injected tokens | 168.71 | 122.20 | -27.56% |
| Mean injected items | 5.00 | 4.21 | -0.79 |

The conversation-cluster 95% interval for macro-session-recall delta is
[-0.05612, -0.03354]; utility is also negative with interval
[-0.04725, -0.02585]. This is a clear rejected transfer.

The likely mechanism is granularity shift. A base LoCoMo query injects only
168.7 tokens on average, versus 1018.8 on LongMemEval. A 75% cap therefore
often removes an entire short evidence turn; the optimized LoCoMo arm returns
4.21 items rather than five. The fixed-896 arm demonstrates the opposite end
of the Pareto frontier: it improves LoCoMo macro session recall to 0.82966 but
doubles tokens to 336.83.

### Safe rejection

Leave-one-conversation-out calibration found no profile that met all training
gates for any fold, so it selected `base` in 10/10 folds. Held-out behavior is
exactly equal to base. This is not an optimization win; it is evidence that a
guarded optimizer can refuse a harmful update.

### Abstention / negative-load limitation

LongMemEval's selected arm injects 5.93 items on 30 abstention questions versus
5.00 for base. On 450 LoCoMo negative-load probes, frozen Relative-75 injects
4.19 items/125.58 tokens versus 5.00 items/173.14 tokens for base. Neither is a
sufficiency or abstention solution: the system still lacks a calibrated
"inject nothing" gate.

## Negative iterations

The following results remain part of the audit trail:

- v1.0 query-only routing reduced recall too much;
- v1.1 scout-feature routing still failed utility confidence;
- v1.2 safely collapsed to the static fallback and produced no cost gain;
- v1.3 fixed-896 improved LongMemEval recall by 5.61 pp and reduced tokens by
  14.11%, while naive recency reranking sharply harmed results;
- v1.4 made token cost relative to base, passed development gates, but did not
  transfer to LoCoMo.

This history is why protocol versions and baseline reruns are mandatory.

## Migration to internal programming conversations

Only the adapter and label provider should change. The main policy, scorer,
promotion, report, and runtime modules remain shared. Recommended internal
evidence units are immutable source IDs for user requirements, tool outputs,
patch hunks, commits, test failures, or accepted decisions.

The public protocol's unordered-set recall is insufficient for programming
tasks that require ordered evidence chains. A programming protocol should add:

- causal/order-sensitive evidence recall;
- supersession labels for renamed APIs and reverted decisions;
- negative cost for injecting stale or contradicted evidence;
- task-level grouping to avoid treating adjacent turns as independent;
- optional downstream controlled trials after direct evidence gates pass.

No internal data, benchmark harness, or private model is assumed by this PR.

## Limitations and claim boundary

- Public dialogue validates mechanics, not real long programming performance.
- L0 FTS5 isolates retrieval/injection; it does not evaluate L1 extraction
  quality or vector/hybrid search.
- Message-level evidence recall is cheaper and lower variance than QA, but is
  only a necessary condition for answer correctness.
- The tokenizer is `cl100k_base`, a reproducible proxy rather than every target
  model's exact tokenizer.
- LoCoMo has only ten independent conversation clusters.
- LongMemEval v1.4 is developmentally contaminated by earlier aggregate
  inspection and is not presented as pristine confirmation.
- The 250 ms sidepath timeout cannot cancel a base retriever that lacks an
  abort interface; it guarantees returned-path fallback, not cancellation of
  already-running work.
