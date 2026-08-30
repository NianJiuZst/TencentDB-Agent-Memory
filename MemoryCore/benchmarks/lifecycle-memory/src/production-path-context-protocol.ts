import protocolJson from "../protocol.production-path-context.v1.json" with { type: "json" };

export type ProductionPathArm = "current_only" | "query_aware_dual";
export type ProductionPathIntent =
  | "current_state"
  | "historical_state"
  | "state_change"
  | "historical_aggregate";

export interface ProductionPathContextProtocol {
  protocolVersion: string;
  seed: number;
  hypothesis: string;
  input: {
    dataset: string;
    revision: string;
    frozenCaseManifestSha256: string;
    naturalCases: number;
    temporalPairs: number;
    temporalCases: number;
    personas: number;
  };
  productionPath: {
    entrypoint: string;
    configParser: string;
    feedbackWriter: string;
    runtime: string;
    retrievalStrategy: "keyword";
    retrievalInput: string;
    lifecycle: {
      enabled: boolean;
      minConfidence: number;
      maxHops: number;
      maxExpansions: number;
      timeoutMs: number;
      maxEvents: number;
    };
  };
  arms: Array<{
    id: ProductionPathArm;
    dualStateMode: "off" | "query_aware";
    description: string;
  }>;
  panels: Record<string, string>;
  prompt: Record<string, string>;
  gates: {
    expectedCases: number;
    expectedNaturalCases: number;
    expectedTemporalCases: number;
    expectedCurrentCases: number;
    expectedHistoricalCases: number;
    expectedChangeCases: number;
    requireZeroRecallErrors: boolean;
    requireZeroLifecycleFallbacks: boolean;
    requireZeroUnexpectedPairCounts: boolean;
    requireByteIdenticalNonEligiblePrompts: boolean;
  };
  claimBoundary: string;
}

export const PRODUCTION_PATH_CONTEXT_PROTOCOL = protocolJson as ProductionPathContextProtocol;

const armIds = PRODUCTION_PATH_CONTEXT_PROTOCOL.arms.map((item) => item.id);
if (armIds.join("\0") !== "current_only\0query_aware_dual" || new Set(armIds).size !== 2) {
  throw new Error("production path evaluation requires current_only and query_aware_dual arms");
}
