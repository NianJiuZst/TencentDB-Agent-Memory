import { describe, expect, it } from "vitest";
import { evaluateTypedRefutationAnswerGate }
  from "./longmemeval-v2-typed-refutation-answer-runner.js";
import { assertPremiseEvidencePhaseReadAuthorized }
  from "./longmemeval-v2-premise-evidence-baseline-runner.js";
import {
  evaluateTypedRefutationValidationDirectGate,
  type TypedRefutationValidationDirectMetrics,
} from "./longmemeval-v2-typed-refutation-validation-runner.js";
import {
  isTypedRefutationValidationReadAdmission,
  LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL,
} from "./longmemeval-v2-typed-refutation-validation-protocol.js";

function metrics(): TypedRefutationValidationDirectMetrics {
  return {
    premiseQuestions: 23,
    controlQuestions: 20,
    premiseChallenges: 2,
    validPremiseChallenges: 2,
    invalidPremiseChallenges: 0,
    controlChallenges: 0,
    challengePrecision: 1,
    premiseRecall: 2 / 23,
    controlSpecificity: 1,
    changedContexts: 2,
    exactBaseNoops: 41,
    exactBaseNoopRate: 1,
    meanBaseInjectedTokens: 2800,
    meanInjectedTokens: 2807,
    meanInjectedTokenDelta: 7,
    meanInjectedTokenIncreaseFraction: 0.0025,
    meanTriggeredCapsuleTokens: 151,
    selectionLatencyP50Ms: 1,
    selectionLatencyP95Ms: 2,
    fallbacks: 0,
    basePrefixViolations: 0,
    capsuleCertificateViolations: 0,
    tokenViolations: 0,
  };
}

describe("D15 frozen validation protocol", () => {
  it("accepts only the committed, checksummed validation admission shape", () => {
    const protocol = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL;
    const admission = {
      admissionVersion: "lifecycle-longmemeval-v2-typed-refutation-read-admission-v1.0",
      sourceProtocolVersion: protocol.protocolVersion,
      completedPhase: "development",
      status: "renderer_selected",
      decision: "authorize_validation_read",
      candidatePolicyId: "typed-action-contract-v1",
      validatorCommit: "1234567",
      selectionSummarySha256: protocol.sourceSelection.summarySha256,
      selectionContextsSha256: protocol.sourceSelection.contextsSha256,
      selectionEvaluationsSha256: protocol.sourceSelection.evaluationsSha256,
      readinessAuditSha256: "a".repeat(64),
      splitCanonicalSha256: protocol.dataBoundary.splitCanonicalSha256,
      validationStateAtAdmission: "unread",
      testStateAtAdmission: "unread",
    } as const;
    expect(isTypedRefutationValidationReadAdmission(admission)).toBe(true);
    expect(() => assertPremiseEvidencePhaseReadAuthorized({
      phase: "validation",
      authorization: admission,
    })).not.toThrow();
    expect(isTypedRefutationValidationReadAdmission({ ...admission,
      candidatePolicyId: "typed-answer-mode-v1" })).toBe(false);
    expect(isTypedRefutationValidationReadAdmission({ ...admission,
      readinessAuditSha256: "missing" })).toBe(false);
  });

  it("admits a precise, cheap direct replication and rejects one control trigger", () => {
    const passed = evaluateTypedRefutationValidationDirectGate({
      metrics: metrics(),
      indexBuildLatencyMs: 100,
      forcedFallbackMismatches: { disabled: 0, timeout: 0 },
    });
    expect(passed.passed).toBe(true);
    const failed = evaluateTypedRefutationValidationDirectGate({
      metrics: { ...metrics(), controlChallenges: 1, challengePrecision: 2 / 3 },
      indexBuildLatencyMs: 100,
      forcedFallbackMismatches: { disabled: 0, timeout: 0 },
    });
    expect(failed.passed).toBe(false);
    expect(failed.failedChecks).toContain("noControlChallenges");
  });

  it("requires replicated gains from both reader families with no judge-observed harm", () => {
    const passed = evaluateTypedRefutationAnswerGate({
      changedQuestions: 2,
      changedReaderPairs: 4,
      actualReaderCalls: 8,
      expectedReaderCalls: 8,
      actualJudgeCalls: 16,
      expectedJudgeCalls: 16,
      primaryImprovedReaderPairs: 3,
      primaryHarmedReaderPairs: 0,
      unanimousImprovedReaderPairs: 3,
      anyJudgeHarmedReaderPairs: 0,
      readersWithAtLeastOnePrimaryImprovement: 2,
      readersWithNegativeMeanDelta: 0,
      primaryPopulationWeightedDelta: 3 / 86,
      fullFactorialPopulationWeightedDelta: 6 / 172,
      modelMismatches: 0,
      exactUnchangedContexts: true,
    });
    expect(passed.passed).toBe(true);
    const failed = evaluateTypedRefutationAnswerGate({
      changedQuestions: 2,
      changedReaderPairs: 4,
      actualReaderCalls: 8,
      expectedReaderCalls: 8,
      actualJudgeCalls: 16,
      expectedJudgeCalls: 16,
      primaryImprovedReaderPairs: 3,
      primaryHarmedReaderPairs: 1,
      unanimousImprovedReaderPairs: 3,
      anyJudgeHarmedReaderPairs: 1,
      readersWithAtLeastOnePrimaryImprovement: 2,
      readersWithNegativeMeanDelta: 0,
      primaryPopulationWeightedDelta: 2 / 86,
      fullFactorialPopulationWeightedDelta: 4 / 172,
      modelMismatches: 0,
      exactUnchangedContexts: true,
    });
    expect(failed.passed).toBe(false);
    expect(failed.failedChecks).toEqual(expect.arrayContaining(["noPrimaryHarm", "noAnyJudgeHarm"]));
  });
});
