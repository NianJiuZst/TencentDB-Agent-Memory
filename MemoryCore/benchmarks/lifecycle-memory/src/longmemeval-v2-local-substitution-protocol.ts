import localSubstitutionProtocolJson from "../protocol.longmemeval-v2-local-substitution.v1.json" with { type: "json" };
import procedureSplitJson from "../protocol.longmemeval-v2-procedure-question-split.v1.json" with { type: "json" };

export type LongMemEvalV2LocalSubstitutionPhase = "consumed_audit" | "test";

export const LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL = localSubstitutionProtocolJson;
export const LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT = procedureSplitJson;

if (LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.protocolVersion
    !== "lifecycle-longmemeval-v2-local-substitution-v1.0"
  || LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT.protocolVersion
    !== LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.split.sourceProtocolVersion
  || LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT.canonicalSha256
    !== LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.split.canonicalSha256
  || LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.selfOptimization.parameterSearch !== "none") {
  throw new Error("unexpected LongMemEval-V2 local-substitution protocol");
}

export function localSubstitutionQuestionIdsForPhase(
  phase: LongMemEvalV2LocalSubstitutionPhase,
): string[] {
  if (phase === "test") return [...LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT.test];
  return [
    ...LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT.development,
    ...LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT.validation,
  ].sort();
}
