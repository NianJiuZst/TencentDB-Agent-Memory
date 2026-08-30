# Final production-path result

## Decision

Adopt query-aware dual-state recall for explicit historical-state and state-change questions. Preserve current-only output for ordinary, current-state, and historical-aggregate questions. Never expose predecessors from delete or retraction events.

## Frozen evaluation

- Pre-score revision: `59129af4baa2bcaf62586928c489b9ff7b39eeb8`.
- Dataset: Memora revision `a6493188efc836d6511ed5e4163fe3ba87da30ff`, ten personas.
- Natural panel: 150 complete weekly questions.
- Controlled temporal panel: 20 structured preference updates, each asked as current, history, and change; 60 questions.
- Arms: current-only production recall and query-aware dual-state production recall.
- Production context generation: 420 `performAutoRecall` executions; 250 unique exact reader prompts after byte-identical reuse.
- Answer evaluation: 500 reader calls and 500 crossed-model judge calls.

## Primary results

| Panel | n | Current-only | Query-aware dual | Paired delta [95% persona-cluster interval] |
|---|---:|---:|---:|---:|
| Natural FAMA | 150 | 0.2872 | 0.2872 | 0 [0, 0] |
| Current-state criterion accuracy | 20 | 1.0000 | 1.0000 | 0 [0, 0] |
| Historical-state criterion accuracy | 20 | 0.5000 | 0.9875 | +0.4875 [+0.4625, +0.5000] |
| State-change criterion accuracy | 20 | 0.6667 | 1.0000 | +0.3333 [+0.3333, +0.3333] |
| All temporal criterion accuracy | 60 | 0.7222 | 0.9958 | +0.2736 [+0.2653, +0.2778] |

Temporal FAMA improved from 0.5000 to 0.9917. Forty temporal cases improved, twenty were equal, and none were harmed. Reader-specific temporal criterion-accuracy directions were +0.2778 and +0.2694. Mean injected tokens across all 210 cases increased from 549.20 to 552.19, a 0.54% increase. Every frozen value, non-inferiority, cost, context, and operational-integrity gate passed.

## Integrity

- Production recall errors: 0.
- Lifecycle fallbacks: 0.
- Unexpected pair counts: 0.
- Non-eligible prompt mismatches: 0.
- Reader retries: 0; judge retries: 3.
- Reader or judge model mismatches: 0.
- Self-judgments: 0.
- One unclear verdict was counted incorrect.
- Independent validator rescored all 500 raw verdict records and reproduced every report, interval, gate, and hash with zero mismatches.
- MemoryCore tests passed 80/80; lifecycle benchmark tests passed 159/159; focused TypeScript checking and the plugin build passed.
- Context manifest SHA-256: `0c940cc4a0ce6fe39213389193421bf477876ab0886d27de16b73c0d460d6a13`.
- Raw evaluation SHA-256: `9700a555d355a8900973c6e6412612fc43a9074dd61b0bef890f088c2d229fe7`.

## Claim boundary

The exact production configuration, persisted-feedback load, scope filtering, successor materialization, temporal routing, budgeting, and final prompt construction were executed. Candidate ranking was frozen behind a deterministic `IMemoryStore` contract adapter, so this run does not measure live SQLite, TCVDB, or COS network behavior. Structured update edges were trusted inputs. The result is not evidence for unrestricted old-memory exposure, automatic predecessor-link correctness, natural temporal-query prevalence, human calibration, or real long-running programming-task impact.
