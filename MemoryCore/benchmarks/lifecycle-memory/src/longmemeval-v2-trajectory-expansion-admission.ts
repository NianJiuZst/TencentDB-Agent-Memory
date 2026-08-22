import { createHash } from "node:crypto";
import type { TrajectoryExpansionPhaseAdmission } from "./longmemeval-v2-trajectory-expansion-baseline-runner.js";
import { LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL } from "./longmemeval-v2-trajectory-expansion-protocol.js";
import type { LongMemEvalV2TrajectoryExpansionSummary } from "./longmemeval-v2-trajectory-expansion-runner.js";
import type { TrajectoryExpansionIndependentValidation } from "./longmemeval-v2-trajectory-expansion-validator.js";

export function buildTrajectoryExpansionPhaseAdmission(params: {
  completedPhase: "development" | "validation";
  summaryText: string;
  validationText: string;
  validatorCommit: string;
}): TrajectoryExpansionPhaseAdmission {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.validatorCommit)) {
    throw new Error("D12 admission validatorCommit must be a git SHA");
  }
  const summary = JSON.parse(params.summaryText) as LongMemEvalV2TrajectoryExpansionSummary;
  const validation = JSON.parse(
    params.validationText,
  ) as TrajectoryExpansionIndependentValidation;
  const protocol = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL;
  const summarySha256 = createHash("sha256").update(params.summaryText).digest("hex");
  const validationSha256 = createHash("sha256").update(params.validationText).digest("hex");
  if (summary.protocolVersion !== protocol.protocolVersion
    || summary.phase !== params.completedPhase
    || summary.status !== `${params.completedPhase}_passed`
    || !summary.gate.passed
    || validation.validationVersion
      !== "lifecycle-longmemeval-v2-trajectory-expansion-independent-validation-v1.0"
    || validation.sourceProtocolVersion !== protocol.protocolVersion
    || validation.phase !== params.completedPhase
    || validation.sourceStatus !== summary.status
    || !validation.sourceGatePassed
    || !validation.validationPassed
    || !validation.admissionEligible
    || validation.artifactSha256.summary !== summarySha256) {
    throw new Error(`D12 ${params.completedPhase} admission requires a consistent phase-passed validation`);
  }
  return {
    admissionVersion: "lifecycle-longmemeval-v2-trajectory-expansion-admission-v1.0",
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
