import protocolJson from "../protocol.dual-state-context.v1.json" with { type: "json" };

export type DualStateArm = "v1" | "dual_all" | "dual_query_aware";
export type DualStateIntent =
  | "current_state"
  | "historical_state"
  | "state_change"
  | "historical_aggregate";

export interface DualStateContextProtocol {
  protocolVersion: string;
  researchDirection: "D19";
  seed: number;
  hypothesis: string;
  dataset: {
    name: string;
    revision: string;
    developmentPeriod: "monthly";
    validationPeriod: "weekly";
    expectedNaturalCases: number;
    expectedPersonas: number;
  };
  panels: {
    naturalSafety: Record<string, unknown>;
    temporalCapability: {
      eligibleEvent: string;
      selection: string;
      pairsPerPersona: number;
      expectedPairs: number;
      queriesPerPair: number;
      queryTypes: DualStateIntent[];
      purpose: string;
    };
  };
  arms: Array<{ id: DualStateArm; description: string }>;
  rendering: {
    logicalSlots: number;
    candidatePool: number;
    maxHistoricalStatesPerTransition: number;
    maxCurrentStatesPerTransition: number;
    updateLabel: string;
    historicalLabel: string;
    currentLabel: string;
    deleteRule: string;
    retractionRule: string;
  };
  intent: {
    dualEligible: DualStateIntent[];
    historicalAggregateRule: string;
    inferenceInputs: string;
  };
  fallback: Record<string, string>;
  claimBoundary: string;
}

export const DUAL_STATE_CONTEXT_PROTOCOL = protocolJson as DualStateContextProtocol;

const arms = DUAL_STATE_CONTEXT_PROTOCOL.arms.map((item) => item.id);
if (new Set(arms).size !== arms.length || arms.join("\0") !== "v1\0dual_all\0dual_query_aware") {
  throw new Error("D19 requires the frozen V1, dual_all and dual_query_aware arms");
}
if (DUAL_STATE_CONTEXT_PROTOCOL.panels.temporalCapability.expectedPairs
  !== DUAL_STATE_CONTEXT_PROTOCOL.dataset.expectedPersonas
    * DUAL_STATE_CONTEXT_PROTOCOL.panels.temporalCapability.pairsPerPersona) {
  throw new Error("D19 temporal pair count is inconsistent with persona allocation");
}
