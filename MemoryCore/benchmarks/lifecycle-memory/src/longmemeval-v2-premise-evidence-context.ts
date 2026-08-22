import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import type { PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import {
  selectPremiseEvidence,
  type PremiseEvidenceDecision,
  type PremiseEvidenceIndex,
} from "./longmemeval-v2-premise-evidence.js";
import type { RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

export interface PremiseEvidenceContextPolicy {
  enabled: boolean;
  maxCapsuleTokens: number;
  maxCandidateItems: number;
  maxCandidateTokens: number;
  maxSelectionLatencyMs: number;
}

export type PremiseEvidenceContextFallbackReason =
  | "disabled"
  | "selection_error"
  | "selection_timeout"
  | "missing_source_inventory"
  | "corrupt_source_inventory"
  | "capsule_token_overflow"
  | "candidate_item_overflow"
  | "candidate_token_overflow"
  | "evidence_certificate_failure"
  | "base_prefix_failure"
  | "trajectory_overflow"
  | "state_overflow"
  | "inventory_overflow"
  | "index_key_overflow"
  | "corrupt_accessibility_tree";

export interface PremiseEvidenceContextResult extends PackedLongTaskContext {
  mode: "premise_evidence" | "baseline_noop" | "fallback_baseline";
  usedPremiseEvidence: boolean;
  decision: PremiseEvidenceDecision | null;
  capsuleTokens: number;
  contextSha256: string;
  selectionLatencyMs: number;
  sourceObservationSha256: string | null;
  fallback: boolean;
  fallbackReason: PremiseEvidenceContextFallbackReason | null;
  basePrefixViolations: number;
}

export interface PremiseEvidenceContextTestHooks {
  select?: typeof selectPremiseEvidence;
  now?: () => number;
  countTokens?: (value: string) => number;
}

function validatePolicy(policy: PremiseEvidenceContextPolicy): void {
  if (![policy.maxCapsuleTokens, policy.maxCandidateItems, policy.maxCandidateTokens]
    .every((value) => Number.isInteger(value) && value > 0)
    || !Number.isFinite(policy.maxSelectionLatencyMs) || policy.maxSelectionLatencyMs <= 0) {
    throw new Error("invalid premise-evidence context policy");
  }
}

export function premiseEvidenceContextSha256(
  items: readonly Pick<RetrievedUnit, "id" | "content" | "tokenCount">[],
): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(`${item.id}\0${item.tokenCount}\0${item.content}\n`);
  return hash.digest("hex");
}

function exactBasePrefixViolations(
  baseline: PackedLongTaskContext,
  items: readonly RetrievedUnit[],
): number {
  if (items.length !== baseline.items.length + 1) return 1;
  return baseline.items.filter((item, index) => item.id !== items[index]?.id
    || item.content !== items[index]?.content
    || item.tokenCount !== items[index]?.tokenCount).length;
}

function exactBaseline(params: {
  baseline: PackedLongTaskContext;
  decision: PremiseEvidenceDecision | null;
  selectionLatencyMs: number;
  fallbackReason: PremiseEvidenceContextFallbackReason | null;
}): PremiseEvidenceContextResult {
  return {
    ...params.baseline,
    items: [...params.baseline.items],
    mode: params.fallbackReason ? "fallback_baseline" : "baseline_noop",
    usedPremiseEvidence: false,
    decision: params.decision,
    capsuleTokens: 0,
    contextSha256: premiseEvidenceContextSha256(params.baseline.items),
    selectionLatencyMs: params.selectionLatencyMs,
    sourceObservationSha256: null,
    fallback: params.fallbackReason !== null,
    fallbackReason: params.fallbackReason,
    basePrefixViolations: 0,
  };
}

export function selectPremiseEvidenceContext(params: {
  baseline: PackedLongTaskContext;
  question: LongTaskQuestion;
  index: PremiseEvidenceIndex;
  policy: PremiseEvidenceContextPolicy;
  testHooks?: PremiseEvidenceContextTestHooks;
}): PremiseEvidenceContextResult {
  validatePolicy(params.policy);
  const now = params.testHooks?.now ?? performance.now.bind(performance);
  const countTokens = params.testHooks?.countTokens
    ?? ((value: string) => encoding.encode(value).length);
  const fallback = (
    reason: PremiseEvidenceContextFallbackReason,
    decision: PremiseEvidenceDecision | null,
    latency: number,
  ) => exactBaseline({
    baseline: params.baseline,
    decision,
    selectionLatencyMs: latency,
    fallbackReason: reason,
  });
  if (!params.policy.enabled) return fallback("disabled", null, 0);

  const startedAt = now();
  let decision: PremiseEvidenceDecision;
  try {
    decision = (params.testHooks?.select ?? selectPremiseEvidence)({
      question: params.question,
      index: params.index,
    });
  } catch {
    return fallback("selection_error", null, Math.max(0, now() - startedAt));
  }
  const selectionLatencyMs = Math.max(0, now() - startedAt);
  if (selectionLatencyMs > params.policy.maxSelectionLatencyMs) {
    return fallback("selection_timeout", decision, selectionLatencyMs);
  }
  if (decision.fallback) {
    return fallback(decision.fallbackReason ?? "corrupt_accessibility_tree", decision,
      selectionLatencyMs);
  }
  if (!decision.usedPremiseEvidence || !decision.capsule || !decision.inventoryId) {
    return exactBaseline({
      baseline: params.baseline,
      decision,
      selectionLatencyMs,
      fallbackReason: null,
    });
  }
  if (decision.certificateViolations !== 0) {
    return fallback("evidence_certificate_failure", decision, selectionLatencyMs);
  }
  const inventory = params.index.inventories.find((item) => item.id === decision.inventoryId);
  if (!inventory) return fallback("missing_source_inventory", decision, selectionLatencyMs);
  if (!/^[0-9a-f]{64}$/u.test(inventory.sourceSha256)
    || inventory.trajectoryId.length === 0 || inventory.items.length === 0) {
    return fallback("corrupt_source_inventory", decision, selectionLatencyMs);
  }
  const capsuleTokens = countTokens(decision.capsule);
  if (!Number.isInteger(capsuleTokens) || capsuleTokens <= 0
    || capsuleTokens > params.policy.maxCapsuleTokens) {
    return fallback("capsule_token_overflow", decision, selectionLatencyMs);
  }
  const capsule: RetrievedUnit = {
    id: `lmev2:premise-capsule:${createHash("sha256").update(decision.capsule)
      .digest("hex").slice(0, 24)}`,
    sessionId: inventory.trajectoryId,
    role: "assistant",
    content: decision.capsule,
    timestampMs: Date.UTC(2025, 0, 1) + inventory.stateIndex * 1_000,
    sequence: 9_000_000_000 + inventory.stateIndex,
    score: 1,
    tokenCount: capsuleTokens,
  };
  const items = [...params.baseline.items, capsule];
  if (items.length > params.policy.maxCandidateItems) {
    return fallback("candidate_item_overflow", decision, selectionLatencyMs);
  }
  const injectedTokens = params.baseline.injectedTokens + capsuleTokens;
  if (injectedTokens > params.policy.maxCandidateTokens) {
    return fallback("candidate_token_overflow", decision, selectionLatencyMs);
  }
  const basePrefixViolations = exactBasePrefixViolations(params.baseline, items);
  if (basePrefixViolations !== 0) {
    return fallback("base_prefix_failure", decision, selectionLatencyMs);
  }
  return {
    items,
    injectedTokens,
    tokenViolation: params.baseline.tokenViolation
      || capsuleTokens > params.policy.maxCapsuleTokens
      || items.length > params.policy.maxCandidateItems
      || injectedTokens > params.policy.maxCandidateTokens,
    mode: "premise_evidence",
    usedPremiseEvidence: true,
    decision,
    capsuleTokens,
    contextSha256: premiseEvidenceContextSha256(items),
    selectionLatencyMs,
    sourceObservationSha256: inventory.sourceSha256,
    fallback: false,
    fallbackReason: null,
    basePrefixViolations,
  };
}
