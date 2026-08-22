import procedureProtocolJson from "../protocol.longmemeval-v2-procedure.v1.json" with { type: "json" };
import procedureSplitJson from "../protocol.longmemeval-v2-procedure-question-split.v1.json" with { type: "json" };
import type { LongMemEvalV2ProcedurePhase } from "./longmemeval-v2-procedure-split.js";

export type { LongMemEvalV2ProcedurePhase };

export const LONGMEMEVAL_V2_PROCEDURE_PROTOCOL = procedureProtocolJson;
export const LONGMEMEVAL_V2_PROCEDURE_SPLIT = procedureSplitJson;

if (LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion
  !== "lifecycle-longmemeval-v2-procedure-v1.0"
  || LONGMEMEVAL_V2_PROCEDURE_SPLIT.protocolVersion
    !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.split.protocolVersion
  || LONGMEMEVAL_V2_PROCEDURE_SPLIT.canonicalSha256
    !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.split.canonicalSha256
  || LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.procedureMemory.policies
    !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.procedureMemory.candidateLimits.length
      * LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.procedureMemory.tokenFractions.length
      * LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.procedureMemory.maxProcedureItems.length) {
  throw new Error("unexpected LongMemEval-V2 procedure protocol");
}

export function procedureQuestionIdsForPhase(phase: LongMemEvalV2ProcedurePhase): string[] {
  return [...LONGMEMEVAL_V2_PROCEDURE_SPLIT[phase]];
}
