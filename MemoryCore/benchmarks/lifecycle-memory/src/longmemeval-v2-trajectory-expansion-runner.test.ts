import { describe, expect, it } from "vitest";
import {
  compareTrajectoryExpansionArms,
  evaluateTrajectoryExpansionGate,
  summarizeTrajectoryExpansionArm,
  type LongMemEvalV2TrajectoryExpansionCase,
} from "./longmemeval-v2-trajectory-expansion-runner.js";

function row(params: {
  id: string;
  domain: string;
  arm: "locally_verified" | "step_agnostic";
  base: number;
  d11: number;
  selected: number;
  tokens: number;
  context: string;
}): LongMemEvalV2TrajectoryExpansionCase {
  return {
    protocolVersion: "lifecycle-longmemeval-v2-trajectory-expansion-v1.0",
    mode: "trajectory_evidence_expansion",
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
    d11InjectedIds: ["d11"],
    d11ContextSha256: "d11",
    d11ProcedureId: "procedure",
    d11InjectedTokens: 80,
    d11UsedSubstitution: true,
    d11DecisionReason: "accepted",
    d11AnswerAtomSupportRecall: params.d11,
    injectedIds: ["selected"],
    contextSha256: params.context,
    procedureId: "procedure",
    trajectoryId: "trajectory",
    replacedRawIds: ["base"],
    externalCandidateId: "external",
    externalCandidateRank: 2,
    baseEvidenceSpans: 2,
    novelExternalEvidenceSpans: 1,
    novelExternalEvidenceCharacters: 20,
    injectedTokens: params.tokens,
    tokenViolation: false,
    rawQueryLatencyMs: 1,
    procedureQueryLatencyMs: 1,
    selectionLatencyMs: 1,
    queryLatencyMs: 3,
    usedExpansion: true,
    selectionMode: "trajectory_evidence_expansion",
    decisionReason: "accepted",
    fallback: false,
    fallbackReason: null,
    baseCapsulePreservationViolations: 0,
    externalEvidenceCoverageViolations: 0,
    externalEvidenceOrderViolations: 0,
    externalProvenanceCoverageViolations: 0,
    unrelatedBasePreservationViolations: 0,
    answerAtomCount: 1,
    supportedAtomCount: params.selected,
    answerAtomSupportRecall: params.selected,
    anyAnswerAtomSupported: params.selected > 0 ? 1 : 0,
    allAnswerAtomsSupported: params.selected === 1 ? 1 : 0,
    orderedSequenceSupported: params.selected === 1 ? 1 : 0,
    answerAtomSupportRecallDeltaVsBase: params.selected - params.base,
    answerAtomSupportRecallDeltaVsD11: params.selected - params.d11,
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
      externalCertificate: 0,
    },
  };
}

describe("D12 frozen phase gate", () => {
  it("admits a zero-harm external gain with cheaper, changed local-feedback contexts", () => {
    const verified = [
      row({ id: "a", domain: "enterprise", arm: "locally_verified", base: 0, d11: 0, selected: 1, tokens: 90, context: "local-a" }),
      row({ id: "b", domain: "web", arm: "locally_verified", base: 1, d11: 1, selected: 1, tokens: 90, context: "local-b" }),
    ];
    const agnostic = [
      row({ id: "a", domain: "enterprise", arm: "step_agnostic", base: 0, d11: 0, selected: 1, tokens: 95, context: "agnostic-a" }),
      row({ id: "b", domain: "web", arm: "step_agnostic", base: 1, d11: 1, selected: 1, tokens: 95, context: "agnostic-b" }),
    ];
    const summary = summarizeTrajectoryExpansionArm({
      arm: "locally_verified",
      cases: verified,
      seed: 1,
    });
    const comparison = compareTrajectoryExpansionArms(verified, agnostic);
    const gate = evaluateTrajectoryExpansionGate({ verified: summary, comparison });
    expect(gate.passed).toBe(true);
    expect(summary.directOutcomesVsD11).toEqual({ improved: 1, equal: 1, harmed: 0 });
  });

  it("rejects a safe compression when no case improves beyond D11", () => {
    const verified = [
      row({ id: "a", domain: "enterprise", arm: "locally_verified", base: 0, d11: 0, selected: 0, tokens: 80, context: "local-a" }),
      row({ id: "b", domain: "web", arm: "locally_verified", base: 1, d11: 1, selected: 1, tokens: 80, context: "local-b" }),
    ];
    const agnostic = verified.map((value) => ({
      ...value,
      arm: "step_agnostic" as const,
      contextSha256: `${value.contextSha256}-agnostic`,
      injectedTokens: 90,
    }));
    const summary = summarizeTrajectoryExpansionArm({
      arm: "locally_verified",
      cases: verified,
      seed: 1,
    });
    const gate = evaluateTrajectoryExpansionGate({
      verified: summary,
      comparison: compareTrajectoryExpansionArms(verified, agnostic),
    });
    expect(gate.passed).toBe(false);
    expect(gate.checks.improvedDirectProxyCasesVsD11).toBe(false);
  });
});
