import protocolJson from "../protocol.memops-dominance.v1.json" with { type: "json" };
import { MEMOPS_TARGET_STATE_PROTOCOL } from "./memops-target-state-protocol.js";

export type MemOpsDominanceSourcePhase = "development" | "validation" | "test";

export const MEMOPS_DOMINANCE_PROTOCOL = protocolJson;

if (MEMOPS_DOMINANCE_PROTOCOL.protocolVersion !== "lifecycle-memops-dominance-v1.0"
  || MEMOPS_DOMINANCE_PROTOCOL.inputs.sourceProtocolVersion
    !== MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion
  || MEMOPS_DOMINANCE_PROTOCOL.inputs.expectedPrimaryCases.all
    !== MEMOPS_DOMINANCE_PROTOCOL.inputs.expectedPrimaryCases.development
      + MEMOPS_DOMINANCE_PROTOCOL.inputs.expectedPrimaryCases.validation
      + MEMOPS_DOMINANCE_PROTOCOL.inputs.expectedPrimaryCases.test) {
  throw new Error("unexpected MemOps dominance protocol");
}
