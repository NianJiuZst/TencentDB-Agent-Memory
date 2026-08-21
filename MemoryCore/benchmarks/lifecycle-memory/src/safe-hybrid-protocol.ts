import protocolJson from "../protocol.safe-hybrid.v3.json" with { type: "json" };

export interface SafeHybridProtocol {
  protocolVersion: string;
  parentProtocols: string[];
  developmentStatus: string;
  seed: number;
  policy: {
    enabled: boolean;
    minConfidence: number;
    maxHops: number;
    maxExpansions: number;
    resultLimit: number;
    timeoutMs: number;
    baseResultLimit: number;
    maxExtraSlots: number;
    protectHistoricalAggregate: boolean;
  };
  routing: {
    historicalAggregate: string;
    allOtherQueries: string;
    usesTaskLabelsAtInference: boolean;
    maxInjectedItems: number;
  };
  evaluation: {
    periods: string[];
    usesEvaluationFeedbackForPolicyFit: boolean;
    uncertainty: { unit: "persona"; bootstrapSamples: number };
  };
  frozenAnswerLevelSelection: {
    protocolVersion: string;
    selectionSha256: string;
    cases: number;
    reusePriorAnswersOnlyIfCandidateIdsMatchV1: boolean;
  };
  gate: {
    requireHistoricalAggregateExactBase: boolean;
    requireOtherQueriesExactV1: boolean;
    requireFrozenSelectionExactV1: boolean;
    requireAllQuestionFamaNotBelowV1: boolean;
    maxMeanTokenIncreaseOverV1Fraction: number;
    requireDisabledEquivalence: boolean;
    requireForcedFailureFallback: boolean;
  };
}

export const SAFE_HYBRID_PROTOCOL = protocolJson as SafeHybridProtocol;

if (SAFE_HYBRID_PROTOCOL.evaluation.usesEvaluationFeedbackForPolicyFit) {
  throw new Error("safe-hybrid diagnostic must not fit the policy on evaluation scores");
}
if (SAFE_HYBRID_PROTOCOL.policy.maxExtraSlots !== 0) {
  throw new Error("safe-hybrid policy must keep a fixed injection budget");
}
if (SAFE_HYBRID_PROTOCOL.policy.resultLimit !== SAFE_HYBRID_PROTOCOL.routing.maxInjectedItems) {
  throw new Error("safe-hybrid result limit must match the declared capacity");
}
