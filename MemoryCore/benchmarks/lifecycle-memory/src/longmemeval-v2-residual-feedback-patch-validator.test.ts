import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  LongMemEvalV2ResidualFeedbackPatchBaselineCase,
  LongMemEvalV2ResidualFeedbackPatchBaselineSummary,
} from "./longmemeval-v2-residual-feedback-patch-baseline-runner.js";
import {
  LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL,
  LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT,
} from "./longmemeval-v2-residual-feedback-patch-protocol.js";
import {
  compareResidualFeedbackPatchArms,
  evaluateResidualFeedbackPatchGate,
  summarizeResidualFeedbackPatchArm,
  type LongMemEvalV2ResidualFeedbackPatchCase,
  type LongMemEvalV2ResidualFeedbackPatchSummary,
} from "./longmemeval-v2-residual-feedback-patch-runner.js";
import { validateLongMemEvalV2ResidualFeedbackPatchArtifacts } from "./longmemeval-v2-residual-feedback-patch-validator.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function jsonLines(values: unknown[]): string {
  return values.map((value) => `${JSON.stringify(value)}\n`).join("");
}

function fixture() {
  const protocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL;
  const questionIds = [...LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.development];
  const directCount = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.counts.development
    .directProxyQuestions;
  const directIds = new Set(questionIds.slice(0, directCount));
  const baselineCases: LongMemEvalV2ResidualFeedbackPatchBaselineCase[] = questionIds.map(
    (id, index) => {
      const direct = directIds.has(id);
      const missingSupport = direct && index === 0;
      return {
        protocolVersion: protocol.protocolVersion,
        mode: "base",
        phase: "development",
        questionId: id,
        domain: "enterprise",
        environment: "environment",
        evaluatorFamily: direct ? "direct_phrase" : "multiple_choice",
        directProxy: direct,
        orderedQuestion: false,
        query: `query ${id}`,
        candidateIds: [`base-${id}`, "lmev2:raw:trajectory:0:0"],
        injectedIds: [`base-${id}`],
        injectedItemSha256: [`base-hash-${id}`],
        contextSha256: `base-context-${id}`,
        injectedTokens: 100,
        tokenViolation: false,
        queryLatencyMs: 1,
        answerAtomCount: direct ? 1 : null,
        supportedAtomCount: direct ? (missingSupport ? 0 : 1) : null,
        answerAtomSupportRecall: direct ? (missingSupport ? 0 : 1) : null,
        anyAnswerAtomSupported: direct ? (missingSupport ? 0 : 1) : null,
        allAnswerAtomsSupported: direct ? (missingSupport ? 0 : 1) : null,
        orderedSequenceSupported: direct ? (missingSupport ? 0 : 1) : null,
        fallback: false,
      };
    },
  );
  const baselineCasesText = jsonLines(baselineCases);
  const baseRecall = (directCount - 1) / directCount;
  const baselineSummary: LongMemEvalV2ResidualFeedbackPatchBaselineSummary = {
    protocolVersion: protocol.protocolVersion,
    mode: "base",
    phase: "development",
    status: "completed",
    preScoreCommit: "d3dc5d7",
    authorizationSha256: null,
    dataset: {
      name: "LongMemEval-V2",
      revision: "revision",
      tier: "small",
      manifestSha256: "manifest",
    },
    splitCanonicalSha256: LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.canonicalSha256,
    cases: baselineCases.length,
    directProxyCases: directCount,
    answerOnlyCases: baselineCases.length - directCount,
    orderedProxyCases: 0,
    metrics: {
      answerAtomSupportRecall: baseRecall,
      anyAnswerAtomSupportedRate: baseRecall,
      allAnswerAtomsSupportedRate: baseRecall,
      orderedSequenceSupportedRate: 0,
      meanInjectedTokens: 100,
      meanInjectedItems: 1,
      queryLatencyP50Ms: 1,
      queryLatencyP95Ms: 1,
      tokenViolations: 0,
      fallbacks: 0,
    },
    byDomain: {
      enterprise: {
        cases: baselineCases.length,
        directProxyCases: directCount,
        answerAtomSupportRecall: baseRecall,
        orderedSequenceSupportedRate: 0,
        meanInjectedTokens: 100,
      },
    },
    index: {},
    casesSha256: sha256(baselineCasesText),
    laterPhaseState: "unread",
  };
  const baselineSummaryText = `${JSON.stringify(baselineSummary, null, 2)}\n`;
  const candidateCases: LongMemEvalV2ResidualFeedbackPatchCase[] = [];
  for (const baseline of baselineCases) {
    for (const arm of ["step_agnostic", "locally_verified"] as const) {
      const direct = baseline.directProxy;
      const patchTokens = arm === "locally_verified" ? 1 : 2;
      const selected = direct ? 1 : null;
      candidateCases.push({
        protocolVersion: protocol.protocolVersion,
        mode: "residual_feedback_patch",
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
        baseInjectedItemSha256: baseline.injectedItemSha256,
        baseContextSha256: baseline.contextSha256,
        injectedIds: [...baseline.injectedIds, `patch-${arm}-${baseline.questionId}`],
        injectedItemSha256: [
          ...baseline.injectedItemSha256,
          `patch-hash-${arm}-${baseline.questionId}`,
        ],
        contextSha256: `${arm}-${baseline.questionId}`,
        procedureId: "lmev2:local-procedure:trajectory",
        trajectoryId: "trajectory",
        externalCandidateId: "lmev2:raw:trajectory:0:0",
        externalCandidateRank: 1,
        patchSpans: 1,
        patchTokens,
        queryTermsCovered: 1,
        injectedTokens: baseline.injectedTokens + patchTokens,
        appendedItems: 1,
        tokenViolation: false,
        rawQueryLatencyMs: 1,
        procedureQueryLatencyMs: 1,
        selectionLatencyMs: 1,
        queryLatencyMs: 3,
        usedPatch: true,
        selectionMode: "residual_feedback_patch",
        decisionReason: "accepted",
        fallback: false,
        fallbackReason: null,
        basePrefixViolations: 0,
        patchEvidenceCoverageViolations: 0,
        patchEvidenceOrderViolations: 0,
        patchProvenanceViolations: 0,
        answerAtomCount: direct ? 1 : null,
        supportedAtomCount: selected,
        answerAtomSupportRecall: selected,
        anyAnswerAtomSupported: selected,
        allAnswerAtomsSupported: selected,
        orderedSequenceSupported: selected,
        answerAtomSupportRecallDeltaVsBase: direct
          ? selected! - baseline.answerAtomSupportRecall! : null,
        forcedFallbackMismatches: Object.fromEntries([
          "disabled", "missingProcedureIndex", "missingFeedbackTable", "feedbackTableOverflow",
          "timeout", "corrupt", "budgetOverflow", "missingRawCandidatePool",
          "externalCorrupt", "patchCertificate",
        ].map((key) => [key, 0])),
      });
    }
  }
  candidateCases.sort((left, right) => left.arm.localeCompare(right.arm)
    || left.questionId.localeCompare(right.questionId));
  const agnostic = candidateCases.filter((row) => row.arm === "step_agnostic");
  const verified = candidateCases.filter((row) => row.arm === "locally_verified");
  const armSummaries = [
    summarizeResidualFeedbackPatchArm({
      arm: "step_agnostic",
      cases: agnostic,
      seed: protocol.aggregation.bootstrapSeed + 100,
    }),
    summarizeResidualFeedbackPatchArm({
      arm: "locally_verified",
      cases: verified,
      seed: protocol.aggregation.bootstrapSeed,
    }),
  ];
  const comparison = compareResidualFeedbackPatchArms(verified, agnostic);
  const gate = evaluateResidualFeedbackPatchGate({
    verified: armSummaries.find((summary) => summary.arm === "locally_verified")!,
    comparison,
  });
  const casesText = jsonLines(candidateCases);
  const summary: LongMemEvalV2ResidualFeedbackPatchSummary = {
    protocolVersion: protocol.protocolVersion,
    mode: "residual_feedback_patch",
    phase: "development",
    status: "development_passed",
    preScoreCommit: baselineSummary.preScoreCommit,
    authorizationSha256: null,
    baselineArtifact: {
      casesSha256: sha256(baselineCasesText),
      summarySha256: sha256(baselineSummaryText),
    },
    splitCanonicalSha256: LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.canonicalSha256,
    index: {},
    feedback: {
      events: 1,
      entries: 1,
      capacity: 5200,
      available: true,
      failureReason: null,
      locallyVerifiedEvents: 1,
    },
    armSummaries,
    localFeedbackComparison: comparison,
    casesSha256: sha256(casesText),
    gate,
    answerLevelState: "not_admitted",
    laterPhaseState: "unread",
  };
  return {
    baselineCasesText,
    baselineSummaryText,
    casesText,
    summaryText: `${JSON.stringify(summary, null, 2)}\n`,
  };
}

describe("D13 independent artifact validator", () => {
  it("recomputes summaries and the direct gate independently", () => {
    const result = validateLongMemEvalV2ResidualFeedbackPatchArtifacts({
      phase: "development",
      ...fixture(),
    });
    expect(result.validationPassed).toBe(true);
    expect(result.admissionEligible).toBe(true);
    expect(Object.values(result.mismatches)).toEqual(Array(11).fill(0));
  });

  it("detects a candidate that no longer has exact Base as its prefix", () => {
    const value = fixture();
    const rows = value.casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    rows[0].injectedIds.reverse();
    const result = validateLongMemEvalV2ResidualFeedbackPatchArtifacts({
      phase: "development",
      ...value,
      casesText: jsonLines(rows),
    });
    expect(result.validationPassed).toBe(false);
    expect(result.mismatches.selectionStructure).toBeGreaterThan(0);
  });

  it("detects same-id Base content drift through per-item digests", () => {
    const value = fixture();
    const rows = value.casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    rows[0].injectedItemSha256[0] = "f".repeat(64);
    const result = validateLongMemEvalV2ResidualFeedbackPatchArtifacts({
      phase: "development",
      ...value,
      casesText: jsonLines(rows),
    });
    expect(result.validationPassed).toBe(false);
    expect(result.mismatches.selectionStructure).toBeGreaterThan(0);
  });

  it("treats a correctly represented negative delta as evidence, not arithmetic corruption", () => {
    const value = fixture();
    const rows = value.casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const target = rows.find((row) => row.directProxy && row.baseAnswerAtomSupportRecall === 1);
    target.supportedAtomCount = 0;
    target.answerAtomSupportRecall = 0;
    target.anyAnswerAtomSupported = 0;
    target.allAnswerAtomsSupported = 0;
    target.orderedSequenceSupported = 0;
    target.answerAtomSupportRecallDeltaVsBase = -1;
    const result = validateLongMemEvalV2ResidualFeedbackPatchArtifacts({
      phase: "development",
      ...value,
      casesText: jsonLines(rows),
    });
    expect(result.mismatches.arithmetic).toBe(0);
    expect(result.mismatches.summaryRecomputation).toBeGreaterThan(0);
  });
});
