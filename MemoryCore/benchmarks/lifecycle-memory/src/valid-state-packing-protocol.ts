import protocolJson from "../protocol.valid-state-packing.v1.json" with { type: "json" };
import type { LifecyclePolicy } from "../../../src/core/lifecycle/index.js";

interface ValidStatePackingProtocol {
  protocolVersion: string;
  seed: number;
  dataset: { name: string; revision: string; dataManifestSha256: string };
  split: { optimizationPeriods: string[]; heldOutProxyPeriod: string };
  incumbent: LifecyclePolicy & { name: string };
  validityStream: {
    candidateLimit: number;
    validityPoolLimit: number;
    minConfidence: number;
    maxHops: number;
    maxExpansions: number;
    timeoutMs: number;
    maxCandidates: number;
  };
  policyGrid: {
    budgetFractionOfPerQueryV1Tokens: number[];
    maxItems: number[];
    maxPolicies: number;
  };
  optimizer: {
    harmPenalty: number;
    costPenalty: number;
    fallbackPenalty: number;
  };
  capacity: {
    maxUnitsPerGroup: number;
    maxEventsPerGroup: number;
    maxEdgesPerGroup: number;
    maxTombstonesPerGroup: number;
  };
  evaluation: { uncertaintyUnit: "persona"; bootstrapSamples: number };
  proxyGate: {
    requirePositivePrimaryEvidenceFamaProxyDelta: boolean;
    requirePrimaryEvidenceFamaProxyCiLowerAboveZero: boolean;
    minPrimaryCurrentSessionRecallDelta: number;
    minPrimaryForgettingAbsenceDelta: number;
    maxQuarterlyCurrentStateNonForgettingHarmedCasesVsV1: number;
    maxMeanInjectedTokenIncreaseFractionVsV1: number;
    requireAtMostFiveCandidates: boolean;
    requireZeroOrdinaryFallbacks: boolean;
    requireDisabledBaseEquivalence: boolean;
    requireForcedFailureBaseFallback: boolean;
  };
}

export const VALID_STATE_PACKING_PROTOCOL = protocolJson as ValidStatePackingProtocol;

if (VALID_STATE_PACKING_PROTOCOL.protocolVersion !== "lifecycle-valid-state-packing-v1.0") {
  throw new Error("unexpected valid-state packing protocol version");
}
const policies = VALID_STATE_PACKING_PROTOCOL.policyGrid.budgetFractionOfPerQueryV1Tokens.length
  * VALID_STATE_PACKING_PROTOCOL.policyGrid.maxItems.length;
if (policies !== VALID_STATE_PACKING_PROTOCOL.policyGrid.maxPolicies) {
  throw new Error("valid-state packing policy count mismatch");
}
