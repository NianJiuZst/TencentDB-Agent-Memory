import { createHash } from "node:crypto";
import type { ResidualFeedbackPatchPhaseAdmission } from "./longmemeval-v2-residual-feedback-patch-baseline-runner.js";
import { LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL } from "./longmemeval-v2-residual-feedback-patch-protocol.js";
import type { LongMemEvalV2ResidualFeedbackPatchSummary } from "./longmemeval-v2-residual-feedback-patch-runner.js";
import type { ResidualFeedbackPatchIndependentValidation } from "./longmemeval-v2-residual-feedback-patch-validator.js";

export function buildResidualFeedbackPatchPhaseAdmission(params: {
  completedPhase: "development" | "validation";
  summaryText: string;
  validationText: string;
  validatorCommit: string;
}): ResidualFeedbackPatchPhaseAdmission {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.validatorCommit)) {
    throw new Error("D13 admission validatorCommit must be a git SHA");
  }
  const summary = JSON.parse(params.summaryText) as LongMemEvalV2ResidualFeedbackPatchSummary;
  const validation = JSON.parse(
    params.validationText,
  ) as ResidualFeedbackPatchIndependentValidation;
  const protocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL;
  const summarySha256 = createHash("sha256").update(params.summaryText).digest("hex");
  const validationSha256 = createHash("sha256").update(params.validationText).digest("hex");
  if (summary.protocolVersion !== protocol.protocolVersion
    || summary.phase !== params.completedPhase
    || summary.status !== `${params.completedPhase}_passed`
    || !summary.gate.passed
    || summary.answerLevelState !== "not_admitted"
    || validation.validationVersion
      !== "lifecycle-longmemeval-v2-residual-feedback-patch-independent-validation-v1.0"
    || validation.sourceProtocolVersion !== protocol.protocolVersion
    || validation.phase !== params.completedPhase
    || validation.sourceStatus !== summary.status
    || !validation.sourceGatePassed
    || !validation.validationPassed
    || !validation.admissionEligible
    || validation.artifactSha256.summary !== summarySha256) {
    throw new Error(
      `D13 ${params.completedPhase} admission requires a consistent phase-passed validation`,
    );
  }
  return {
    admissionVersion: "lifecycle-longmemeval-v2-residual-feedback-patch-admission-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    completedPhase: params.completedPhase,
    status: "phase_passed",
    decision: params.completedPhase === "development"
      ? "authorize_validation_read" : "authorize_test_read",
    candidatePolicyId: protocol.candidate.policyId,
    validatorCommit: params.validatorCommit,
    independentValidationSha256: validationSha256,
    nextPhaseStateAtAdmission: "unread",
  };
}
