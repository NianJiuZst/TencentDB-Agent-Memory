import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  LongMemEvalV2TrajectoryExpansionBaselineCase,
  LongMemEvalV2TrajectoryExpansionBaselineSummary,
} from "./longmemeval-v2-trajectory-expansion-baseline-runner.js";
import {
  LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL,
  LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT,
} from "./longmemeval-v2-trajectory-expansion-protocol.js";
import {
  compareTrajectoryExpansionArms,
  evaluateTrajectoryExpansionGate,
  summarizeTrajectoryExpansionArm,
  type LongMemEvalV2TrajectoryExpansionCase,
  type LongMemEvalV2TrajectoryExpansionSummary,
} from "./longmemeval-v2-trajectory-expansion-runner.js";
import { validateLongMemEvalV2TrajectoryExpansionArtifacts } from "./longmemeval-v2-trajectory-expansion-validator.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function jsonLines(values: unknown[]): string {
  return values.map((value) => `${JSON.stringify(value)}\n`).join("");
}

function fixture() {
  const protocol = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL;
  const questionIds = [...LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.development];
  const directIds = new Set(questionIds.slice(0, 60));
  const baselineCases: LongMemEvalV2TrajectoryExpansionBaselineCase[] = questionIds.map((id) => {
    const direct = directIds.has(id);
    const improved = id === questionIds[0];
    return {
      protocolVersion: protocol.protocolVersion,
      mode: "base",
      phase: "development",
      questionId: id,
      domain: Number.parseInt(id.slice(0, 1), 16) % 2 === 0 ? "enterprise" : "web",
      environment: "environment",
      evaluatorFamily: direct ? "direct_phrase" : "multiple_choice",
      directProxy: direct,
      orderedQuestion: false,
      query: `query ${id}`,
      candidateIds: [`base-${id}`, "lmev2:raw:trajectory:0:0"],
      injectedIds: [`base-${id}`],
      injectedTokens: 100,
      tokenViolation: false,
      queryLatencyMs: 1,
      answerAtomCount: direct ? 1 : null,
      supportedAtomCount: direct ? (improved ? 0 : 1) : null,
      answerAtomSupportRecall: direct ? (improved ? 0 : 1) : null,
      anyAnswerAtomSupported: direct ? (improved ? 0 : 1) : null,
      allAnswerAtomsSupported: direct ? (improved ? 0 : 1) : null,
      orderedSequenceSupported: direct ? (improved ? 0 : 1) : null,
      fallback: false,
    };
  });
  const baselineCasesText = jsonLines(baselineCases);
  const baselineSummary: LongMemEvalV2TrajectoryExpansionBaselineSummary = {
    protocolVersion: protocol.protocolVersion,
    mode: "base",
    phase: "development",
    status: "completed",
    preScoreCommit: "06c4715",
    authorizationSha256: null,
    dataset: { name: "LongMemEval-V2", revision: "revision", tier: "small", manifestSha256: "manifest" },
    splitCanonicalSha256: LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.canonicalSha256,
    cases: baselineCases.length,
    directProxyCases: 60,
    answerOnlyCases: 6,
    orderedProxyCases: 0,
    metrics: {
      answerAtomSupportRecall: 59 / 60,
      anyAnswerAtomSupportedRate: 59 / 60,
      allAnswerAtomsSupportedRate: 59 / 60,
      orderedSequenceSupportedRate: 0,
      meanInjectedTokens: 100,
      meanInjectedItems: 1,
      queryLatencyP50Ms: 1,
      queryLatencyP95Ms: 1,
      tokenViolations: 0,
      fallbacks: 0,
    },
    byDomain: {},
    index: {},
    casesSha256: sha256(baselineCasesText),
    laterPhaseState: "unread",
  };
  const baselineSummaryText = `${JSON.stringify(baselineSummary, null, 2)}\n`;
  const candidateCases: LongMemEvalV2TrajectoryExpansionCase[] = [];
  for (const baseline of baselineCases) {
    for (const arm of ["step_agnostic", "locally_verified"] as const) {
      const direct = baseline.directProxy;
      const selected = direct ? 1 : null;
      candidateCases.push({
        protocolVersion: protocol.protocolVersion,
        mode: "trajectory_evidence_expansion",
        phase: "development",
        policyId: protocol.candidate.policyId,
        arm,
        questionId: baseline.questionId,
        domain: baseline.domain,
        environment: baseline.environment,
        evaluatorFamily: baseline.evaluatorFamily,
        directProxy: direct,
        orderedQuestion: false,
        query: baseline.query,
        baseCandidateIds: baseline.candidateIds,
        baseInjectedIds: baseline.injectedIds,
        baseInjectedTokens: baseline.injectedTokens,
        baseAnswerAtomSupportRecall: baseline.answerAtomSupportRecall,
        baseAnyAnswerAtomSupported: baseline.anyAnswerAtomSupported,
        baseAllAnswerAtomsSupported: baseline.allAnswerAtomsSupported,
        baseOrderedSequenceSupported: baseline.orderedSequenceSupported,
        procedureCandidateIds: ["lmev2:local-procedure:trajectory"],
        d11InjectedIds: [`d11-${baseline.questionId}`],
        d11ContextSha256: `d11-${baseline.questionId}`,
        d11ProcedureId: "lmev2:local-procedure:trajectory",
        d11InjectedTokens: 80,
        d11UsedSubstitution: true,
        d11DecisionReason: "accepted",
        d11AnswerAtomSupportRecall: baseline.answerAtomSupportRecall,
        injectedIds: [`selected-${baseline.questionId}`],
        contextSha256: `${arm}-${baseline.questionId}`,
        procedureId: "lmev2:local-procedure:trajectory",
        trajectoryId: "trajectory",
        replacedRawIds: baseline.injectedIds,
        externalCandidateId: "lmev2:raw:trajectory:0:0",
        externalCandidateRank: 1,
        baseEvidenceSpans: 1,
        novelExternalEvidenceSpans: 1,
        novelExternalEvidenceCharacters: 10,
        injectedTokens: arm === "locally_verified" ? 90 : 95,
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
        answerAtomCount: direct ? 1 : null,
        supportedAtomCount: selected,
        answerAtomSupportRecall: selected,
        anyAnswerAtomSupported: selected,
        allAnswerAtomsSupported: selected,
        orderedSequenceSupported: selected,
        answerAtomSupportRecallDeltaVsBase: direct
          ? selected! - baseline.answerAtomSupportRecall! : null,
        answerAtomSupportRecallDeltaVsD11: direct
          ? selected! - baseline.answerAtomSupportRecall! : null,
        forcedFallbackMismatches: Object.fromEntries([
          "disabled", "missingProcedureIndex", "missingFeedbackTable", "feedbackTableOverflow",
          "timeout", "corrupt", "budgetOverflow", "missingRawCandidatePool",
          "externalCorrupt", "externalCertificate",
        ].map((key) => [key, 0])),
      });
    }
  }
  candidateCases.sort((left, right) => left.arm.localeCompare(right.arm)
    || left.questionId.localeCompare(right.questionId));
  const agnostic = candidateCases.filter((row) => row.arm === "step_agnostic");
  const verified = candidateCases.filter((row) => row.arm === "locally_verified");
  const armSummaries = [
    summarizeTrajectoryExpansionArm({
      arm: "step_agnostic",
      cases: agnostic,
      seed: protocol.aggregation.bootstrapSeed + 100,
    }),
    summarizeTrajectoryExpansionArm({
      arm: "locally_verified",
      cases: verified,
      seed: protocol.aggregation.bootstrapSeed,
    }),
  ];
  const comparison = compareTrajectoryExpansionArms(verified, agnostic);
  const gate = evaluateTrajectoryExpansionGate({
    verified: armSummaries.find((summary) => summary.arm === "locally_verified")!,
    comparison,
  });
  const casesText = jsonLines(candidateCases);
  const summary: LongMemEvalV2TrajectoryExpansionSummary = {
    protocolVersion: protocol.protocolVersion,
    mode: "trajectory_evidence_expansion",
    phase: "development",
    status: "development_passed",
    preScoreCommit: baselineSummary.preScoreCommit,
    authorizationSha256: null,
    baselineArtifact: {
      casesSha256: sha256(baselineCasesText),
      summarySha256: sha256(baselineSummaryText),
    },
    splitCanonicalSha256: LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.canonicalSha256,
    index: {},
    feedback: { events: 1, entries: 1, capacity: 5200, available: true, failureReason: null, locallyVerifiedEvents: 1 },
    armSummaries,
    localFeedbackComparison: comparison,
    casesSha256: sha256(casesText),
    gate,
    laterPhaseState: "unread",
  };
  return {
    baselineCasesText,
    baselineSummaryText,
    casesText,
    summaryText: `${JSON.stringify(summary, null, 2)}\n`,
  };
}

describe("D12 independent artifact validator", () => {
  it("recomputes the frozen summaries and gate without runner aggregation calls", () => {
    const value = fixture();
    const validation = validateLongMemEvalV2TrajectoryExpansionArtifacts({
      phase: "development",
      ...value,
    });
    expect(validation.validationPassed).toBe(true);
    expect(validation.admissionEligible).toBe(true);
    expect(Object.values(validation.mismatches).every((count) => count === 0)).toBe(true);
  });

  it("detects a row-level token-certificate mutation", () => {
    const value = fixture();
    const rows = value.casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    rows[0].injectedTokens = 101;
    const validation = validateLongMemEvalV2TrajectoryExpansionArtifacts({
      phase: "development",
      ...value,
      casesText: jsonLines(rows),
    });
    expect(validation.validationPassed).toBe(false);
    expect(validation.mismatches.selectionStructure).toBeGreaterThan(0);
  });

  it("treats a correctly calculated negative outcome as evidence, not arithmetic corruption", () => {
    const value = fixture();
    const rows = value.casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const row = rows.find((candidate) => candidate.directProxy
      && candidate.baseAnswerAtomSupportRecall === 1);
    row.supportedAtomCount = 0;
    row.answerAtomSupportRecall = 0;
    row.anyAnswerAtomSupported = 0;
    row.allAnswerAtomsSupported = 0;
    row.orderedSequenceSupported = 0;
    row.answerAtomSupportRecallDeltaVsBase = -1;
    row.answerAtomSupportRecallDeltaVsD11 = -1;
    const validation = validateLongMemEvalV2TrajectoryExpansionArtifacts({
      phase: "development",
      ...value,
      casesText: jsonLines(rows),
    });
    expect(validation.mismatches.arithmetic).toBe(0);
  });

  it("compares unordered summary maps by content", () => {
    const value = fixture();
    const summary = JSON.parse(value.summaryText);
    for (const arm of summary.armSummaries) {
      arm.decisionReasons = Object.fromEntries(
        Object.entries(arm.decisionReasons).reverse(),
      );
    }
    const validation = validateLongMemEvalV2TrajectoryExpansionArtifacts({
      phase: "development",
      ...value,
      summaryText: `${JSON.stringify(summary, null, 2)}\n`,
    });
    expect(validation.validationPassed).toBe(true);
    expect(validation.mismatches.summaryRecomputation).toBe(0);
  });
});
