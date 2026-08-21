# LongMemEval-V2 long-task adapter

This adapter adds a fresh public evidence source for the correction-linked lifecycle-memory study. It implements the dataset-neutral `LongTaskDatasetAdapter` boundary, so retrieval policies consume normalized questions, trajectories, observations, and transitions rather than LongMemEval-V2 JSON fields.

## Frozen public snapshot

- Official benchmark repository: `xiaowu0162/LongMemEval-V2`, pinned at commit `2cc8c540bdb87fe6761629b585e727e1c4704520`.
- Tier: `small` (100 trajectories per question).
- `questions.jsonl`: SHA-256 `0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7`.
- `haystacks/lme_v2_small.json`: SHA-256 `9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593`.
- `trajectories.jsonl`: SHA-256 `363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6`.
- Canonical three-file manifest SHA-256: `70a2be47e7117ef8f2ee77aa499c6126358b5f9ffa28a848b5c565a4ec8fc99a`.

`audit:lifecycle-longmemeval-v2` streams the 1.1 GB trajectory file instead of loading it as one string. It parses only the 200 trajectories selected by the small-tier haystacks while still hashing and counting all 1,870 rows.

## Audit result

The snapshot contains 451 questions, of which 422 are text-only. The 29 image-bearing questions are all `errors-gotchas` and are outside the first text-only experiment. The two domain-shared small haystacks select 100 enterprise and 100 web trajectories. They contain 5,095 states and 145,272,488 accessibility-tree characters, so full-state prompt injection is not a viable baseline.

Question-type counts are 86 dynamic state, 41 dynamic abstention, 134 static state, 55 static abstention, 74 procedure, 32 procedure abstention, and 29 image-based errors/gotchas.

## Transition alignment

The public schema prose describes `action` as an action taken from a state, but both the records and the official AgentRunbook implementation attach an executed action to the destination state. For example, state 1 contains the action that transforms state 0 into state 1. The adapter makes this explicit as `transitionAction` on the destination state and rejects any non-null initial-state action.

This matters for programming transfer: an internal adapter should normalize a tool call and its before/after repository, test, or environment state to the same `(pre-state, transition action, post-state)` contract.

## Portability and scope

An internal programming-session adapter only needs to implement `loadQuestions`, `loadTrajectories`, and `describe`. Optimization code must not depend on URLs, accessibility-tree syntax, screenshot paths, or public evaluator strings. It may depend on the normalized observation and transition contract.

LongMemEval-V2 supplies answer labels but no public gold trajectory or state attribution for each question. Any direct retrieval metric must therefore be labeled as an answer-support proxy rather than gold evidence recall. Answer-level evaluation remains a separate gate.
