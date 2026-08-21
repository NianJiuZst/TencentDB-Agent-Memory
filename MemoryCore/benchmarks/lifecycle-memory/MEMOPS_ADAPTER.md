# MemOps external lifecycle adapter

This adapter adds a second public-data source without changing the Memora schema or the lifecycle core. It targets the operation-level artifacts from [MemTensor/MemOps](https://github.com/MemTensor/MemOps), pinned to commit `312af65e2c7b6d1b70f062ffa8b4cde32aaf6f35`.

## Frozen data identity

- Relevant directories: `generated_result/2-evidence_conversation` and `generated_result/4-inject_evidence_with_distractors`.
- Aggregate manifest SHA-256: `b55278a63656421edb2080d65631ffe91ef67fabdd4fa490da6bc4002c2ee012`.
- 403 paired instances across 100 profiles.
- 2,558 structured operations and 2,006 longitudinal probes.
- Instance families: 68 Remember, 80 Forget, 77 Update, 96 Reflect, and 82 TrajectoryOps.

The manifest hashes each paired file in sorted relative-path order. `audit:lifecycle-memops-adapter` reconstructs the counts and hash, and fails if evidence and longitudinal file sets differ.

## Alignment contract

The adapter converts every injected dialogue turn to a MemoryCore L0-shaped unit with a stable `(instance, conversation, turn)` id. Gold trigger and provenance spans are aligned to those units using the provided one-based evidence `turn_index`; the quote is then checked against the mapped text. A unique user-text fallback handles older artifacts whose insertion offset is unavailable. Ambiguous or missing mappings fail closed.

The main experiment may use the structured operation trace as an oracle extraction layer only if every arm receives the same operation objects. That isolates lifecycle management from extraction quality. Reports must label this as an oracle-management experiment and must not claim that MemoryCore inferred the operations from raw dialogue.

## Scope boundary

The paper describes operation traces with scope, but the pinned public JSON has target identifiers and evidence spans rather than a separate `scope` field. The adapter therefore supports target-keyed state experiments, not repository/branch/environment scope claims. Programming-session transfer still requires an internal adapter to supply explicit repository, branch, environment, component, and task scope.

## Synthetic-data boundary

MemOps is a public, generated benchmark with verifier-approved artifacts. It is useful for operation-level diagnosis and external protocol validation, but it does not replace the non-synthetic business evidence that remains unavailable. Conclusions must be triangulated with the existing Memora experiment and, later, internal programming sessions.
