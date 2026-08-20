import protocolJson from "../protocol.adaptive.v1.json" with { type: "json" };
import { PROTOCOL } from "./protocol.js";

export interface AdaptiveProtocol {
  protocolVersion: string;
  retrievalProtocolVersion: string;
  seed: number;
  split: {
    optimizationPeriods: string[];
    heldOutPeriods: string[];
    usesHeldOutFeedback: boolean;
  };
  signals: {
    source: string;
    usesEvaluationEvidence: boolean;
    confidenceLevels: Record<string, number>;
  };
  policyGrid: {
    minConfidence: number[];
    maxHops: number[];
    maxExpansions: number;
    resultLimit: number;
    timeoutMs: number;
    maxPolicies: number;
  };
  optimizer: {
    objective: string;
    costPenalty: number;
    fallbackPenalty: number;
  };
  capacity: {
    maxUnitsPerGroup: number;
    maxEventsPerGroup: number;
    maxEdgesPerGroup: number;
  };
  uncertainty: {
    unit: "persona";
    bootstrapSamples: number;
  };
  directGate: {
    subset: "held-out stale-exposed";
    minEvidenceFamaDelta: number;
    requireCiLowerAboveZero: boolean;
    requireDisabledEquivalence: boolean;
    requireForcedFailureFallback: boolean;
  };
}

export const ADAPTIVE_PROTOCOL = protocolJson as AdaptiveProtocol;

if (ADAPTIVE_PROTOCOL.retrievalProtocolVersion !== PROTOCOL.protocolVersion) {
  throw new Error("adaptive protocol must reference the active retrieval protocol");
}
if (ADAPTIVE_PROTOCOL.split.usesHeldOutFeedback || ADAPTIVE_PROTOCOL.signals.usesEvaluationEvidence) {
  throw new Error("adaptive protocol forbids held-out or gold-evidence leakage");
}
