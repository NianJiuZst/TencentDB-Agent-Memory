import protocolJson from "../protocol.evidence-shield.v1.1.json" with { type: "json" };
import type { LifecycleEvidenceShieldPolicy, LifecyclePolicy } from "../../../src/core/lifecycle/index.js";

interface EvidenceShieldProtocol {
  protocolVersion: string;
  seed: number;
  incumbent: LifecyclePolicy & { protocolVersion: string };
  candidate: {
    name: string;
    policy: LifecycleEvidenceShieldPolicy;
  };
  analysisSelection: {
    protocolVersion: string;
    selectionSha256: string;
    cases: number;
  };
  feasibilityGate: {
    minExactObsoleteContextAnyRateReduction: number;
    maxCurrentAtomRecallLoss: number;
    maxMeanInjectedTokenIncreaseFraction: number;
    requireCandidateIdEquivalence: boolean;
    requireZeroFallbacks: boolean;
    requireDisabledEquivalence: boolean;
    requireForcedFailureFallback: boolean;
  };
}

export const EVIDENCE_SHIELD_PROTOCOL = protocolJson as EvidenceShieldProtocol;

if (EVIDENCE_SHIELD_PROTOCOL.protocolVersion !== "lifecycle-evidence-shield-v1.1") {
  throw new Error("unexpected evidence-shield protocol version");
}
if (EVIDENCE_SHIELD_PROTOCOL.incumbent.protocolVersion !== "lifecycle-adaptive-v1.0") {
  throw new Error("evidence shield must retain the V1 retrieval policy");
}
if (EVIDENCE_SHIELD_PROTOCOL.candidate.policy.maxCandidates
  !== EVIDENCE_SHIELD_PROTOCOL.incumbent.resultLimit) {
  throw new Error("evidence shield candidate budget must equal the V1 result limit");
}
