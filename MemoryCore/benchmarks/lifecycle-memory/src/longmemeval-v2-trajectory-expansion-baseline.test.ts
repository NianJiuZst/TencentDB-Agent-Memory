import { describe, expect, it } from "vitest";
import {
  assertTrajectoryExpansionPhaseReadAuthorized,
  type TrajectoryExpansionPhaseAdmission,
} from "./longmemeval-v2-trajectory-expansion-baseline-runner.js";
import { LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL } from "./longmemeval-v2-trajectory-expansion-protocol.js";

function admission(completedPhase: "development" | "validation"): TrajectoryExpansionPhaseAdmission {
  return {
    admissionVersion: "lifecycle-longmemeval-v2-trajectory-expansion-admission-v1.0",
    sourceProtocolVersion: LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.protocolVersion,
    completedPhase,
    status: "phase_passed",
    decision: completedPhase === "development"
      ? "authorize_validation_read" : "authorize_test_read",
    candidatePolicyId: LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.candidate.policyId,
    validatorCommit: "06c4715",
    independentValidationSha256: "a".repeat(64),
    nextPhaseStateAtAdmission: "unread",
  };
}

describe("D12 phase read authorization", () => {
  it("keeps development open and validation/test behind phase-matched admissions", () => {
    expect(() => assertTrajectoryExpansionPhaseReadAuthorized({ phase: "development" }))
      .not.toThrow();
    expect(() => assertTrajectoryExpansionPhaseReadAuthorized({ phase: "validation" }))
      .toThrow(/development-passed/u);
    expect(() => assertTrajectoryExpansionPhaseReadAuthorized({
      phase: "validation",
      authorization: admission("development"),
    })).not.toThrow();
    expect(() => assertTrajectoryExpansionPhaseReadAuthorized({
      phase: "test",
      authorization: admission("validation"),
    })).not.toThrow();
  });

  it("rejects cross-phase and wrong-policy admissions", () => {
    expect(() => assertTrajectoryExpansionPhaseReadAuthorized({
      phase: "validation",
      authorization: admission("validation"),
    })).toThrow(/development-passed/u);
    expect(() => assertTrajectoryExpansionPhaseReadAuthorized({
      phase: "test",
      authorization: { ...admission("validation"), candidatePolicyId: "other" },
    })).toThrow(/validation-passed/u);
  });
});
