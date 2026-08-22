import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import type { PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import {
  selectPremiseEvidenceContext,
  type PremiseEvidenceContextPolicy,
} from "./longmemeval-v2-premise-evidence-context.js";
import type { PremiseEvidenceIndex } from "./longmemeval-v2-premise-evidence.js";
import type { TypedRefutationPolicyId } from "./longmemeval-v2-typed-refutation-protocol.js";
import type { RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

export interface TypedRefutationContextPolicy {
  policyId: TypedRefutationPolicyId;
  enabled: boolean;
  maxCapsuleTokens: number;
  maxCandidateItems: number;
  maxCandidateTokens: number;
  maxSelectionLatencyMs: number;
}

export interface TypedRefutationResult extends PackedLongTaskContext {
  mode: "typed_refutation" | "baseline_noop" | "fallback_baseline";
  policyId: TypedRefutationPolicyId;
  usedTypedRefutation: boolean;
  typedCapsule: string | null;
  typedCapsuleTokens: number;
  contextSha256: string;
  selectionLatencyMs: number;
  fallback: boolean;
  fallbackReason: string | null;
  basePrefixViolations: number;
  capsuleCertificateViolations: number;
  sourceObservationSha256: string | null;
}

function contextSha256(items: readonly Pick<RetrievedUnit, "id" | "content" | "tokenCount">[]): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(`${item.id}\0${item.tokenCount}\0${item.content}\n`);
  return hash.digest("hex");
}

function exactBaseline(params: {
  baseline: PackedLongTaskContext;
  policyId: TypedRefutationPolicyId;
  selectionLatencyMs: number;
  fallbackReason: string | null;
}): TypedRefutationResult {
  return {
    ...params.baseline,
    items: [...params.baseline.items],
    mode: params.fallbackReason ? "fallback_baseline" : "baseline_noop",
    policyId: params.policyId,
    usedTypedRefutation: false,
    typedCapsule: null,
    typedCapsuleTokens: 0,
    contextSha256: contextSha256(params.baseline.items),
    selectionLatencyMs: params.selectionLatencyMs,
    fallback: params.fallbackReason !== null,
    fallbackReason: params.fallbackReason,
    basePrefixViolations: 0,
    capsuleCertificateViolations: 0,
    sourceObservationSha256: null,
  };
}

function observationLine(capsule: string): string | null {
  return capsule.split("\n").find((line) => line.startsWith("Observed ordered ")) ?? null;
}

function correctedConclusion(operator: string, anchors: readonly string[]): string {
  if (operator === "between_adjacent" && anchors.length === 2) {
    return `There is no item between "${anchors[0]}" and "${anchors[1]}"; they are adjacent.`;
  }
  if (operator === "boundary_after" && anchors.length === 1) {
    return `There is no item after "${anchors[0]}"; it is the final item in the recorded structure.`;
  }
  if (operator === "boundary_before" && anchors.length === 1) {
    return `There is no item before "${anchors[0]}"; it is the first item in the recorded structure.`;
  }
  throw new Error("unsupported typed-refutation relation");
}

export function renderTypedRefutationCapsule(params: {
  policyId: TypedRefutationPolicyId;
  sourceObservationSha256: string;
  sourceMemoryId: string;
  sourceLines: number[];
  operator: string;
  anchors: string[];
  originalCapsule: string;
}): string {
  if (!/^[0-9a-f]{64}$/u.test(params.sourceObservationSha256)
    || !params.sourceMemoryId || params.sourceLines.length === 0) {
    throw new Error("invalid typed-refutation provenance");
  }
  const observed = observationLine(params.originalCapsule);
  if (!observed) throw new Error("missing typed-refutation structural observation");
  const lines = [
    "[verified-memory-decision v=1]",
    `source: ${params.sourceMemoryId} lines=${params.sourceLines.join(",")} observation_sha256=${params.sourceObservationSha256.slice(0, 16)}`,
    "question_relation: REFUTES_PREMISE",
    "evidence_sufficiency: SUFFICIENT_FOR_CORRECTION",
    `observed_structure: ${observed}`,
    `corrected_conclusion: ${correctedConclusion(params.operator, params.anchors)}`,
  ];
  if (params.policyId !== "typed-relation-v1") {
    lines.push("answer_mode: CORRECT_FALSE_PREMISE");
  }
  if (params.policyId === "typed-action-contract-v1") {
    lines.push("generation_contract: Use the corrected conclusion as the final boxed answer. Because the refutation evidence is sufficient, do not output UNKNOWN.");
  }
  lines.push("[/verified-memory-decision]");
  return lines.join("\n");
}

function certificateViolations(params: {
  capsule: string;
  policyId: TypedRefutationPolicyId;
  anchors: readonly string[];
  sourceObservationSha256: string;
}): number {
  let violations = 0;
  for (const anchor of params.anchors) violations += Number(!params.capsule.includes(`"${anchor}"`));
  violations += Number(!params.capsule.includes("question_relation: REFUTES_PREMISE"));
  violations += Number(!params.capsule.includes("evidence_sufficiency: SUFFICIENT_FOR_CORRECTION"));
  violations += Number(!params.capsule.includes(params.sourceObservationSha256.slice(0, 16)));
  violations += Number(!params.capsule.includes("corrected_conclusion:"));
  if (params.policyId !== "typed-relation-v1") {
    violations += Number(!params.capsule.includes("answer_mode: CORRECT_FALSE_PREMISE"));
  }
  if (params.policyId === "typed-action-contract-v1") {
    violations += Number(!params.capsule.includes("generation_contract:"));
  }
  return violations;
}

export function selectTypedRefutationContext(params: {
  baseline: PackedLongTaskContext;
  question: LongTaskQuestion;
  index: PremiseEvidenceIndex;
  d14Policy: PremiseEvidenceContextPolicy;
  policy: TypedRefutationContextPolicy;
  testHooks?: {
    countTokens?: (value: string) => number;
    now?: () => number;
    forceRendererFailure?: boolean;
    forceCertificateFailure?: boolean;
  };
}): TypedRefutationResult {
  const now = params.testHooks?.now ?? performance.now.bind(performance);
  const startedAt = now();
  const elapsed = () => Math.max(0, now() - startedAt);
  const fallback = (reason: string, latency = elapsed()) => exactBaseline({
    baseline: params.baseline,
    policyId: params.policy.policyId,
    selectionLatencyMs: latency,
    fallbackReason: reason,
  });
  if (!params.policy.enabled) return fallback("disabled", 0);
  const selected = selectPremiseEvidenceContext({
    baseline: params.baseline,
    question: params.question,
    index: params.index,
    policy: params.d14Policy,
  });
  if (selected.fallback) return fallback(selected.fallbackReason ?? "d14_selection_failure");
  if (!selected.usedPremiseEvidence) {
    const selectionLatencyMs = elapsed();
    if (selectionLatencyMs > params.policy.maxSelectionLatencyMs) {
      return fallback("selection_timeout", selectionLatencyMs);
    }
    return exactBaseline({
      baseline: params.baseline,
      policyId: params.policy.policyId,
      selectionLatencyMs,
      fallbackReason: null,
    });
  }
  if (params.testHooks?.forceRendererFailure) return fallback("renderer_failure");
  const decision = selected.decision;
  if (!decision?.capsule || !decision.operator || !decision.sourceMemoryId
    || !selected.sourceObservationSha256) {
    return fallback("corrupt_d14_decision");
  }
  let capsule: string;
  try {
    capsule = renderTypedRefutationCapsule({
      policyId: params.policy.policyId,
      sourceObservationSha256: selected.sourceObservationSha256,
      sourceMemoryId: decision.sourceMemoryId,
      sourceLines: decision.sourceLines,
      operator: decision.operator,
      anchors: decision.anchors,
      originalCapsule: decision.capsule,
    });
  } catch {
    return fallback("renderer_failure");
  }
  const violations = certificateViolations({
    capsule,
    policyId: params.policy.policyId,
    anchors: decision.anchors,
    sourceObservationSha256: selected.sourceObservationSha256,
  }) + Number(params.testHooks?.forceCertificateFailure ?? false);
  if (violations > 0) return fallback("typed_capsule_certificate_failure");
  const countTokens = params.testHooks?.countTokens ?? ((value: string) => encoding.encode(value).length);
  const typedCapsuleTokens = countTokens(capsule);
  if (!Number.isInteger(typedCapsuleTokens) || typedCapsuleTokens <= 0
    || typedCapsuleTokens > params.policy.maxCapsuleTokens) {
    return fallback("typed_capsule_token_overflow");
  }
  const source = selected.items.at(-1)!;
  const item: RetrievedUnit = {
    ...source,
    id: `lmev2:typed-refutation:${params.policy.policyId}:${createHash("sha256")
      .update(capsule).digest("hex").slice(0, 24)}`,
    content: capsule,
    tokenCount: typedCapsuleTokens,
  };
  const items = [...params.baseline.items, item];
  const injectedTokens = params.baseline.injectedTokens + typedCapsuleTokens;
  if (items.length > params.policy.maxCandidateItems) {
    return fallback("candidate_item_overflow");
  }
  if (injectedTokens > params.policy.maxCandidateTokens) {
    return fallback("candidate_token_overflow");
  }
  const basePrefixViolations = params.baseline.items.filter((base, index) =>
    base.id !== items[index]?.id || base.content !== items[index]?.content
      || base.tokenCount !== items[index]?.tokenCount).length;
  if (basePrefixViolations > 0) return fallback("base_prefix_failure");
  const selectionLatencyMs = elapsed();
  if (selectionLatencyMs > params.policy.maxSelectionLatencyMs) {
    return fallback("selection_timeout", selectionLatencyMs);
  }
  return {
    items,
    injectedTokens,
    tokenViolation: params.baseline.tokenViolation || typedCapsuleTokens > params.policy.maxCapsuleTokens
      || items.length > params.policy.maxCandidateItems
      || injectedTokens > params.policy.maxCandidateTokens,
    mode: "typed_refutation",
    policyId: params.policy.policyId,
    usedTypedRefutation: true,
    typedCapsule: capsule,
    typedCapsuleTokens,
    contextSha256: contextSha256(items),
    selectionLatencyMs,
    fallback: false,
    fallbackReason: null,
    basePrefixViolations,
    capsuleCertificateViolations: violations,
    sourceObservationSha256: selected.sourceObservationSha256,
  };
}
