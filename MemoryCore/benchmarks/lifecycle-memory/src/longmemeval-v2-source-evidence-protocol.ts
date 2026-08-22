import sourceEvidenceProtocolJson from "../protocol.longmemeval-v2-source-evidence-substitution.v1.json" with { type: "json" };
import procedureSplitJson from "../protocol.longmemeval-v2-procedure-question-split.v1.json" with { type: "json" };

export type LongMemEvalV2SourceEvidencePhase = "consumed_audit" | "test";

export const LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL = sourceEvidenceProtocolJson;
export const LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT = procedureSplitJson;

if (LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.protocolVersion
    !== "lifecycle-longmemeval-v2-source-evidence-substitution-v1.0"
  || LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.protocolVersion
    !== LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.split.sourceProtocolVersion
  || LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.canonicalSha256
    !== LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.split.canonicalSha256
  || LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.selfOptimization.parameterSearch
    !== "none_after_protocol_freeze") {
  throw new Error("unexpected LongMemEval-V2 source-evidence protocol");
}

export function sourceEvidenceQuestionIdsForPhase(
  phase: LongMemEvalV2SourceEvidencePhase,
): string[] {
  if (phase === "test") return [...LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.test];
  return [
    ...LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.development,
    ...LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.validation,
  ].sort();
}
