import {
  materializeAuthorizedLongMemEvalV2TestBaseline,
  type LongMemEvalV2LocalSubstitutionBaselineCase,
  type LongMemEvalV2LocalSubstitutionBaselineSummary,
} from "./longmemeval-v2-local-substitution-baseline-runner.js";
import {
  LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL,
  sourceEvidenceQuestionIdsForPhase,
} from "./longmemeval-v2-source-evidence-protocol.js";
import {
  assertSourceEvidenceTestReadAuthorized,
  type SourceEvidenceTestReadAuthorization,
} from "./longmemeval-v2-source-evidence-test-lock.js";

export async function runLongMemEvalV2SourceEvidenceTestBaseline(params: {
  dataRoot: string;
  testReadAuthorization: SourceEvidenceTestReadAuthorization;
  authorizationSha256: string;
}): Promise<{
  cases: LongMemEvalV2LocalSubstitutionBaselineCase[];
  summary: LongMemEvalV2LocalSubstitutionBaselineSummary;
}> {
  assertSourceEvidenceTestReadAuthorized(params.testReadAuthorization);
  return materializeAuthorizedLongMemEvalV2TestBaseline({
    dataRoot: params.dataRoot,
    authorizationSha256: params.authorizationSha256,
    protocol: LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL,
    questionIds: sourceEvidenceQuestionIdsForPhase("test"),
    directionLabel: "D11",
  });
}
