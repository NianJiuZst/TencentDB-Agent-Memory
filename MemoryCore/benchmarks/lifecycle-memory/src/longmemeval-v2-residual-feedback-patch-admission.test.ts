import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildResidualFeedbackPatchPhaseAdmission } from "./longmemeval-v2-residual-feedback-patch-admission.js";
import { LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL } from "./longmemeval-v2-residual-feedback-patch-protocol.js";

function fixture() {
  const protocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL;
  const summaryText = `${JSON.stringify({
    protocolVersion: protocol.protocolVersion,
    phase: "development",
    status: "development_passed",
    gate: { passed: true, checks: {} },
    answerLevelState: "not_admitted",
  }, null, 2)}\n`;
  const validation = {
    validationVersion:
      "lifecycle-longmemeval-v2-residual-feedback-patch-independent-validation-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    phase: "development",
    sourceStatus: "development_passed",
    sourceGatePassed: true,
    artifactSha256: { summary: createHash("sha256").update(summaryText).digest("hex") },
    validationPassed: true,
    admissionEligible: true,
  };
  return { summaryText, validationText: `${JSON.stringify(validation, null, 2)}\n` };
}

describe("D13 phase admission", () => {
  it("authorizes only a hash-matched independently validated phase pass", () => {
    const value = fixture();
    const admission = buildResidualFeedbackPatchPhaseAdmission({
      completedPhase: "development",
      ...value,
      validatorCommit: "d3dc5d7",
    });
    expect(admission.decision).toBe("authorize_validation_read");
    expect(admission.nextPhaseStateAtAdmission).toBe("unread");
  });

  it("rejects a failed or hash-mismatched validator artifact", () => {
    const value = fixture();
    const parsed = JSON.parse(value.validationText);
    parsed.admissionEligible = false;
    expect(() => buildResidualFeedbackPatchPhaseAdmission({
      completedPhase: "development",
      summaryText: value.summaryText,
      validationText: `${JSON.stringify(parsed, null, 2)}\n`,
      validatorCommit: "d3dc5d7",
    })).toThrow(/phase-passed validation/u);
  });
});
