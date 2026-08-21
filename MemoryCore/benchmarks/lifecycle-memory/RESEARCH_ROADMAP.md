# Lifecycle Memory Research Roadmap

This file is the persistent direction registry for iterative work above the fixed-budget V1 incumbent. A candidate is not promoted because it improves a retrieval proxy. Each direction must preserve the Base fallback, receive a versioned protocol before its scores are computed, and pass an answer-level gate before new-data confirmation.

## Current incumbent

`lifecycle-adaptive-v1.0`: correction-linked successor redirection with `minConfidence=0.85`, one hop, `k=5`, bounded expansion, and whole-call Base fallback. It remains the research incumbent because the broader contextual V2 improved the direct proxy but lost answer-level forgetting safety.

## Direction registry

| ID | Direction | Single changed dimension | Evidence source | Status | Promotion boundary |
|---|---|---|---|---|---|
| D1 | Correction-aware evidence shield | Injection rendering after V1 | Write-time `obsoleteValues`; query-time deterministic masking | Active | Frozen 50 are development-only; new public data required |
| D2 | Query-adaptive abstention/budget | Whether and how much memory to inject | Query features plus downstream utility | Queued | Must beat V1 under fixed or lower token cost |
| D3 | Net-value lifecycle curation | Bounded retention/expiry priority | Utility, harm, bytes, provenance | Queued | Must report false-forgetting cost |
| D4 | Query-time evidence distillation | Selection/rewriting within the V1 candidate set | Small local/open model with validity gates | Queued | Must hard-fallback on parse, timeout, or low confidence |
| D5 | Scope-aware coexistence | Branch/environment validity rather than global invalidation | Adapter-provided repository/branch/task scope | Queued | Requires a programming-session adapter or scoped public proxy |

## Why D1 is first

The V2 failure analysis found more exact obsolete-value exposure in both contexts and answers. D1 changes neither retrieval identity nor budget; it tests whether correction statements themselves leak superseded surface forms. This makes the result easier to attribute than another joint Top-k, hop, and threshold search.

The design is informed by query-time evidence distillation in [DeferMem](https://arxiv.org/abs/2605.22411), adaptive memory allocation in [ElasticMem](https://arxiv.org/abs/2605.30690), and on-demand abstaining memory generation in [Mem-pi](https://arxiv.org/abs/2605.21463). D1 deliberately starts with a deterministic renderer rather than reinforcement learning so that it is cheap, reviewable, and provider-independent.

## Iteration rule

1. Freeze the candidate construction and gates before computing its scores.
2. Run deterministic feasibility and exact fallback checks.
3. If the feasibility gate fails, record the negative result and move to the next direction.
4. If it passes, run an answer-level development panel with the existing two-model crossed protocol.
5. Do not reuse the analyzed 50 cases for a new confirmatory claim; require an untouched public split or an internal programming-session adapter.
6. Update the paper with both positive and negative directions, including cost, uncertainty, and causal limits.
