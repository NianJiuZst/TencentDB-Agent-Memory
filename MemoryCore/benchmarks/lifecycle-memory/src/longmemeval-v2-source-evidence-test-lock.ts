import { LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL } from "./longmemeval-v2-source-evidence-protocol.js";

export interface SourceEvidenceTestReadAuthorization {
  admissionVersion: "lifecycle-longmemeval-v2-source-evidence-admission-v1.0";
  sourceProtocolVersion: string;
  status: "consumed_audit_passed";
  decision: "authorize_locked_test_read";
  candidatePolicyId: string;
  validatorCommit: string;
  independentValidationSha256: string;
  testStateAtAdmission: "unread";
}

export function assertSourceEvidenceTestReadAuthorized(
  authorization: SourceEvidenceTestReadAuthorization | undefined,
): void {
  const protocol = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL;
  if (!authorization
    || authorization.admissionVersion !== "lifecycle-longmemeval-v2-source-evidence-admission-v1.0"
    || authorization.sourceProtocolVersion !== protocol.protocolVersion
    || authorization.status !== "consumed_audit_passed"
    || authorization.decision !== "authorize_locked_test_read"
    || authorization.candidatePolicyId !== protocol.candidate.policyId
    || !/^[0-9a-f]{7,40}$/iu.test(authorization.validatorCommit)
    || !/^[0-9a-f]{64}$/iu.test(authorization.independentValidationSha256)
    || authorization.testStateAtAdmission !== "unread") {
    throw new Error("D11 test read requires a committed consumed-audit-passed authorization artifact");
  }
}
