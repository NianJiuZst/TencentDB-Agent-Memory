import premiseEvidenceProtocolJson from "../protocol.longmemeval-v2-premise-evidence.v1.json" with { type: "json" };
import premiseEvidenceSplitJson from "../protocol.longmemeval-v2-premise-evidence-split.v1.json" with { type: "json" };

export type LongMemEvalV2PremiseEvidencePhase = "development" | "validation" | "test";
export type LongMemEvalV2PremiseEvidenceLabel = "premise" | "control";

export const LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL = premiseEvidenceProtocolJson;
export const LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT = premiseEvidenceSplitJson;

if (LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.protocolVersion
    !== "lifecycle-longmemeval-v2-premise-evidence-v1.0"
  || LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.protocolVersion
    !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.split.protocolVersion
  || LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.canonicalSha256
    !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.split.canonicalSha256
  || LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.design.selectedPolicyId
    !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.candidate.policyId
  || !LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.design.selectedBeforeAnswerCalls
  || !LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.selfOptimization.selectedBeforeAnswerScores) {
  throw new Error("unexpected LongMemEval-V2 premise-evidence protocol");
}

export function premiseEvidenceQuestionIdsForPhase(
  phase: LongMemEvalV2PremiseEvidencePhase,
): Array<{ id: string; label: LongMemEvalV2PremiseEvidenceLabel }> {
  return [
    ...LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.premise[phase]
      .map((id) => ({ id, label: "premise" as const })),
    ...LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.controls[phase]
      .map((id) => ({ id, label: "control" as const })),
  ].sort((left, right) => left.id.localeCompare(right.id));
}
