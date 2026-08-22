import trajectoryExpansionProtocolJson from "../protocol.longmemeval-v2-trajectory-expansion.v1.json" with { type: "json" };
import staticSplitJson from "../protocol.longmemeval-v2-static-question-split.v1.json" with { type: "json" };

export type LongMemEvalV2TrajectoryExpansionPhase = "development" | "validation" | "test";

export const LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL = trajectoryExpansionProtocolJson;
export const LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT = staticSplitJson;

if (LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.protocolVersion
    !== "lifecycle-longmemeval-v2-trajectory-expansion-v1.0"
  || LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.protocolVersion
    !== LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.split.sourceProtocolVersion
  || LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.canonicalSha256
    !== LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.split.canonicalSha256
  || !LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.selfOptimization.selectedBeforeFreshScores
  || LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.selfOptimization.parameterSearch
    !== "consumed_design_only_then_frozen") {
  throw new Error("unexpected LongMemEval-V2 trajectory-expansion protocol");
}

export function trajectoryExpansionQuestionIdsForPhase(
  phase: LongMemEvalV2TrajectoryExpansionPhase,
): string[] {
  return [...LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT[phase]];
}
