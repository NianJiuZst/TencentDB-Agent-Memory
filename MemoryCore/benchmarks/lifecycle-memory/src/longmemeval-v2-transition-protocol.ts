import protocolJson from "../protocol.longmemeval-v2-transition.v1.json" with { type: "json" };
import splitJson from "../protocol.longmemeval-v2-question-split.v1.json" with { type: "json" };
import type { LongMemEvalV2Phase } from "./longmemeval-v2-split.js";

export type { LongMemEvalV2Phase };

export const LONGMEMEVAL_V2_TRANSITION_PROTOCOL = protocolJson;
export const LONGMEMEVAL_V2_QUESTION_SPLIT = splitJson;

if (LONGMEMEVAL_V2_TRANSITION_PROTOCOL.protocolVersion
  !== "lifecycle-longmemeval-v2-transition-v1.0"
  || LONGMEMEVAL_V2_QUESTION_SPLIT.protocolVersion
    !== LONGMEMEVAL_V2_TRANSITION_PROTOCOL.split.protocolVersion
  || LONGMEMEVAL_V2_QUESTION_SPLIT.canonicalSha256
    !== LONGMEMEVAL_V2_TRANSITION_PROTOCOL.split.canonicalSha256
  || LONGMEMEVAL_V2_TRANSITION_PROTOCOL.challenger.policies
    !== LONGMEMEVAL_V2_TRANSITION_PROTOCOL.challenger.transitionCandidateLimits.length
      * LONGMEMEVAL_V2_TRANSITION_PROTOCOL.challenger.transitionTokenFractions.length
      * LONGMEMEVAL_V2_TRANSITION_PROTOCOL.challenger.maxTransitionItems.length) {
  throw new Error("unexpected LongMemEval-V2 transition protocol");
}

export function questionIdsForLongMemEvalV2Phase(phase: LongMemEvalV2Phase): string[] {
  return [...LONGMEMEVAL_V2_QUESTION_SPLIT[phase]];
}
