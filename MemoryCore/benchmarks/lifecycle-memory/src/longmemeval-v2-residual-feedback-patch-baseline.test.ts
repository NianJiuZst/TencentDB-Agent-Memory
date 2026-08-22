import { describe, expect, it } from "vitest";
import {
  assertResidualFeedbackPatchPhaseReadAuthorized,
  type ResidualFeedbackPatchPhaseAdmission,
} from "./longmemeval-v2-residual-feedback-patch-baseline-runner.js";
import { LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL } from "./longmemeval-v2-residual-feedback-patch-protocol.js";

function admission(completedPhase: "development" | "validation"):
ResidualFeedbackPatchPhaseAdmission {
  return {
    admissionVersion: "lifecycle-longmemeval-v2-residual-feedback-patch-admission-v1.0",
    sourceProtocolVersion: LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.protocolVersion,
    completedPhase,
    status: "phase_passed",
    decision: completedPhase === "development"
      ? "authorize_validation_read" : "authorize_test_read",
    candidatePolicyId: LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.candidate.policyId,
    validatorCommit: "d3dc5d7",
    independentValidationSha256: "a".repeat(64),
    nextPhaseStateAtAdmission: "unread",
  };
}

describe("D13 phase read authorization", () => {
  it("keeps development open and validation/test behind phase-matched admissions", () => {
    expect(() => assertResidualFeedbackPatchPhaseReadAuthorized({ phase: "development" }))
      .not.toThrow();
    expect(() => assertResidualFeedbackPatchPhaseReadAuthorized({ phase: "validation" }))
      .toThrow(/development-passed/u);
    expect(() => assertResidualFeedbackPatchPhaseReadAuthorized({
      phase: "validation",
      authorization: admission("development"),
    })).not.toThrow();
    expect(() => assertResidualFeedbackPatchPhaseReadAuthorized({
      phase: "test",
      authorization: admission("validation"),
    })).not.toThrow();
  });

  it("rejects cross-phase and wrong-policy admissions", () => {
    expect(() => assertResidualFeedbackPatchPhaseReadAuthorized({
      phase: "validation",
      authorization: admission("validation"),
    })).toThrow(/development-passed/u);
    expect(() => assertResidualFeedbackPatchPhaseReadAuthorized({
      phase: "test",
      authorization: { ...admission("validation"), candidatePolicyId: "other" },
    })).toThrow(/validation-passed/u);
  });
});
