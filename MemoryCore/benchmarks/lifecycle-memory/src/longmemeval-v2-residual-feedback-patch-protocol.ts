import residualPatchProtocolJson from "../protocol.longmemeval-v2-residual-feedback-patch.v1.json" with { type: "json" };
import residualPatchSplitJson from "../protocol.longmemeval-v2-residual-patch-split.v1.json" with { type: "json" };

export type LongMemEvalV2ResidualFeedbackPatchPhase = "development" | "validation" | "test";

export const LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL = residualPatchProtocolJson;
export const LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT = residualPatchSplitJson;

if (LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.protocolVersion
    !== "lifecycle-longmemeval-v2-residual-feedback-patch-v1.0"
  || LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.protocolVersion
    !== LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.split.sourceProtocolVersion
  || LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.canonicalSha256
    !== LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.split.canonicalSha256
  || !LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.selfOptimization.selectedBeforeFreshScores
  || LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.selfOptimization.parameterSearch
    !== "consumed_d12_development_only_then_frozen") {
  throw new Error("unexpected LongMemEval-V2 residual-feedback-patch protocol");
}

export function residualFeedbackPatchQuestionIdsForPhase(
  phase: LongMemEvalV2ResidualFeedbackPatchPhase,
): string[] {
  return [...LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT[phase]];
}
