import protocolJson from "../protocol.evidence-risk-router.v1.json" with { type: "json" };

export type RiskFeatureId =
  | "redactionCount"
  | "changedCandidateCount"
  | "redactionDensity"
  | "tokenSavingsFraction";

export interface EvidenceRiskRouterProtocol {
  protocolVersion: string;
  seed: number;
  inputs: {
    contextManifest: { protocolVersion: string; sha256: string; cases: number };
    v1Evaluations: { protocolVersion: string; sha256: string; selectedArm: "v1"; selectedRows: number };
    shieldEvaluations: {
      protocolVersion: string;
      sha256: string;
      selectedArm: "shield";
      selectedRows: number;
    };
    independentValidation: { requiredStatus: "passed"; sha256: string };
  };
  actions: Array<"v1" | "shield">;
  features: {
    allowed: Array<{ id: RiskFeatureId; definition: string; thresholds: number[] }>;
    forbidden: string[];
  };
  policyClass: {
    type: string;
    comparators: Array<"gte" | "lte">;
    trueAction: "shield";
    falseAction: "v1";
    selectablePolicies: number;
    fallbackPolicy: "always-v1";
  };
  crossFitting: {
    unit: "persona";
    folds: number;
    trainingConstraintsVsV1: {
      minFamaDelta: number;
      minFaaDelta: number;
      maxMpaLoss: number;
      maxMeanInjectedTokenIncreaseFraction: number;
      requireNonnegativeFamaDirectionForEachReader: boolean;
      minShieldActionRate: number;
      maxShieldActionRate: number;
    };
    selectionTolerance: number;
  };
  aggregation: {
    uncertaintyUnit: "persona";
    bootstrapSamples: number;
  };
  gate: {
    requirePositiveCrossFittedFamaDelta: boolean;
    minCrossFittedFaaDelta: number;
    maxCrossFittedMpaLoss: number;
    maxMeanInjectedTokenIncreaseFraction: number;
    requireNonnegativeFamaDirectionForEachReader: boolean;
    minOverallShieldActionRate: number;
    requireEveryPersonaHeldOutExactlyOnce: boolean;
    requireDeterministicReplay: boolean;
  };
}

export const EVIDENCE_RISK_ROUTER_PROTOCOL = protocolJson as EvidenceRiskRouterProtocol;

if (EVIDENCE_RISK_ROUTER_PROTOCOL.protocolVersion !== "lifecycle-evidence-risk-router-v1.0") {
  throw new Error("unexpected evidence-risk router protocol version");
}
const policyCount = EVIDENCE_RISK_ROUTER_PROTOCOL.features.allowed.reduce(
  (sum, feature) => sum + feature.thresholds.length
    * EVIDENCE_RISK_ROUTER_PROTOCOL.policyClass.comparators.length,
  0,
);
if (policyCount !== EVIDENCE_RISK_ROUTER_PROTOCOL.policyClass.selectablePolicies) {
  throw new Error("evidence-risk router policy count mismatch");
}
