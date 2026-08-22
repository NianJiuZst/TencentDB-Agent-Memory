import { describe, expect, it } from "vitest";
import {
  compareResidualFeedbackPatchArms,
  evaluateResidualFeedbackPatchGate,
  summarizeResidualFeedbackPatchArm,
  type LongMemEvalV2ResidualFeedbackPatchCase,
} from "./longmemeval-v2-residual-feedback-patch-runner.js";

function row(params: {
  id: string;
  domain: string;
  arm: "locally_verified" | "step_agnostic";
  base: number;
  selected: number;
  tokens: number;
  context: string;
}): LongMemEvalV2ResidualFeedbackPatchCase {
  const usedPatch = params.tokens > 100;
  return {
    protocolVersion: "lifecycle-longmemeval-v2-residual-feedback-patch-v1.0",
    mode: "residual_feedback_patch",
    phase: "development",
    policyId: "policy",
    arm: params.arm,
    questionId: params.id,
    domain: params.domain,
    environment: "environment",
    evaluatorFamily: "direct_phrase",
    directProxy: true,
    orderedQuestion: false,
    query: "query",
    baseCandidateIds: ["candidate"],
    baseInjectedIds: ["base"],
    baseInjectedTokens: 100,
    baseAnswerAtomSupportRecall: params.base,
    baseAnyAnswerAtomSupported: params.base > 0 ? 1 : 0,
    baseAllAnswerAtomsSupported: params.base === 1 ? 1 : 0,
    baseOrderedSequenceSupported: params.base === 1 ? 1 : 0,
    procedureCandidateIds: ["procedure"],
    baseInjectedItemSha256: ["base-hash"],
    baseContextSha256: "base-context",
    injectedIds: usedPatch ? ["base", "patch"] : ["base"],
    injectedItemSha256: usedPatch ? ["base-hash", "patch-hash"] : ["base-hash"],
    contextSha256: params.context,
    procedureId: usedPatch ? "procedure" : null,
    trajectoryId: usedPatch ? "trajectory" : null,
    externalCandidateId: usedPatch ? "external" : null,
    externalCandidateRank: usedPatch ? 2 : null,
    patchSpans: usedPatch ? 1 : 0,
    patchTokens: params.tokens - 100,
    queryTermsCovered: usedPatch ? 1 : 0,
    injectedTokens: params.tokens,
    appendedItems: usedPatch ? 1 : 0,
    tokenViolation: false,
    rawQueryLatencyMs: 1,
    procedureQueryLatencyMs: 1,
    selectionLatencyMs: 1,
    queryLatencyMs: 3,
    usedPatch,
    selectionMode: usedPatch ? "residual_feedback_patch" : "baseline_noop",
    decisionReason: usedPatch ? "accepted" : "route_decline",
    fallback: false,
    fallbackReason: null,
    basePrefixViolations: 0,
    patchEvidenceCoverageViolations: 0,
    patchEvidenceOrderViolations: 0,
    patchProvenanceViolations: 0,
    answerAtomCount: 1,
    supportedAtomCount: params.selected,
    answerAtomSupportRecall: params.selected,
    anyAnswerAtomSupported: params.selected > 0 ? 1 : 0,
    allAnswerAtomsSupported: params.selected === 1 ? 1 : 0,
    orderedSequenceSupported: params.selected === 1 ? 1 : 0,
    answerAtomSupportRecallDeltaVsBase: params.selected - params.base,
    forcedFallbackMismatches: {
      disabled: 0,
      missingProcedureIndex: 0,
      missingFeedbackTable: 0,
      feedbackTableOverflow: 0,
      timeout: 0,
      corrupt: 0,
      budgetOverflow: 0,
      missingRawCandidatePool: 0,
      externalCorrupt: 0,
      patchCertificate: 0,
    },
  };
}

describe("D13 frozen direct phase gate", () => {
  it("admits a bounded zero-harm gain with cheaper changed feedback contexts", () => {
    const verified = [
      row({ id: "a", domain: "enterprise", arm: "locally_verified", base: 0, selected: 1, tokens: 101, context: "local-a" }),
      row({ id: "b", domain: "web", arm: "locally_verified", base: 1, selected: 1, tokens: 101, context: "local-b" }),
    ];
    const agnostic = [
      row({ id: "a", domain: "enterprise", arm: "step_agnostic", base: 0, selected: 1, tokens: 102, context: "agnostic-a" }),
      row({ id: "b", domain: "web", arm: "step_agnostic", base: 1, selected: 1, tokens: 102, context: "agnostic-b" }),
    ];
    const summary = summarizeResidualFeedbackPatchArm({
      arm: "locally_verified",
      cases: verified,
      seed: 1,
    });
    const comparison = compareResidualFeedbackPatchArms(verified, agnostic);
    const gate = evaluateResidualFeedbackPatchGate({ verified: summary, comparison });
    expect(gate.passed).toBe(true);
    expect(summary.directOutcomesVsBase).toEqual({ improved: 1, equal: 1, harmed: 0 });
  });

  it("rejects safe extra context when no direct case improves", () => {
    const verified = [
      row({ id: "a", domain: "enterprise", arm: "locally_verified", base: 0, selected: 0, tokens: 101, context: "local-a" }),
      row({ id: "b", domain: "web", arm: "locally_verified", base: 1, selected: 1, tokens: 101, context: "local-b" }),
    ];
    const agnostic = verified.map((value) => ({
      ...value,
      arm: "step_agnostic" as const,
      contextSha256: `${value.contextSha256}-agnostic`,
      injectedTokens: 102,
    }));
    const summary = summarizeResidualFeedbackPatchArm({
      arm: "locally_verified",
      cases: verified,
      seed: 1,
    });
    const gate = evaluateResidualFeedbackPatchGate({
      verified: summary,
      comparison: compareResidualFeedbackPatchArms(verified, agnostic),
    });
    expect(gate.passed).toBe(false);
    expect(gate.checks.improvedDirectProxyCasesVsBase).toBe(false);
  });
});
