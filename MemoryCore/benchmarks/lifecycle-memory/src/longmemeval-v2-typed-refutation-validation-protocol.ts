import typedRefutationValidationProtocolJson
  from "../protocol.longmemeval-v2-typed-refutation-validation.v1.json" with { type: "json" };

export const LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL
  = typedRefutationValidationProtocolJson;

if (LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion
    !== "lifecycle-longmemeval-v2-typed-refutation-validation-v1.0"
  || LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.sourceSelection.selectedPolicyId
    !== "typed-action-contract-v1"
  || LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.dataBoundary.validationTotalQuestions
    !== 43
  || LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.arms.length !== 2) {
  throw new Error("unexpected LongMemEval-V2 typed-refutation validation protocol");
}

export interface TypedRefutationValidationReadAdmission {
  admissionVersion: "lifecycle-longmemeval-v2-typed-refutation-read-admission-v1.0";
  sourceProtocolVersion: "lifecycle-longmemeval-v2-typed-refutation-validation-v1.0";
  completedPhase: "development";
  status: "renderer_selected";
  decision: "authorize_validation_read";
  candidatePolicyId: "typed-action-contract-v1";
  validatorCommit: string;
  selectionSummarySha256: string;
  selectionContextsSha256: string;
  selectionEvaluationsSha256: string;
  readinessAuditSha256: string;
  splitCanonicalSha256: string;
  validationStateAtAdmission: "unread";
  testStateAtAdmission: "unread";
}

export function isTypedRefutationValidationReadAdmission(
  value: unknown,
): value is TypedRefutationValidationReadAdmission {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TypedRefutationValidationReadAdmission>;
  const protocol = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL;
  return item.admissionVersion
      === "lifecycle-longmemeval-v2-typed-refutation-read-admission-v1.0"
    && item.sourceProtocolVersion === protocol.protocolVersion
    && item.completedPhase === "development"
    && item.status === "renderer_selected"
    && item.decision === "authorize_validation_read"
    && item.candidatePolicyId === protocol.sourceSelection.selectedPolicyId
    && typeof item.validatorCommit === "string"
    && /^[0-9a-f]{7,40}$/u.test(item.validatorCommit)
    && item.selectionSummarySha256 === protocol.sourceSelection.summarySha256
    && item.selectionContextsSha256 === protocol.sourceSelection.contextsSha256
    && item.selectionEvaluationsSha256 === protocol.sourceSelection.evaluationsSha256
    && typeof item.readinessAuditSha256 === "string"
    && /^[0-9a-f]{64}$/u.test(item.readinessAuditSha256)
    && item.splitCanonicalSha256 === protocol.dataBoundary.splitCanonicalSha256
    && item.validationStateAtAdmission === "unread"
    && item.testStateAtAdmission === "unread";
}
