import utilityProtocolJson from "../protocol.longmemeval-v2-utility-gate.v1.json" with { type: "json" };
import transitionProtocolJson from "../protocol.longmemeval-v2-transition.v1.json" with { type: "json" };

export const LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL = utilityProtocolJson;

if (LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL.protocolVersion
    !== "lifecycle-longmemeval-v2-utility-gate-v1.0"
  || LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL.dataset.manifestSha256
    !== transitionProtocolJson.dataset.manifestSha256
  || LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL.dataset.splitCanonicalSha256
    !== transitionProtocolJson.split.canonicalSha256
  || LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL.feedback.capacity <= 0
  || LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL.runtimePolicy.maxUtilityItems !== 1) {
  throw new Error("unexpected LongMemEval-V2 utility-gate protocol");
}
