import protocolJson from "../protocol.contextual.v2.1.json" with { type: "json" };
import { PROTOCOL } from "./protocol.js";

export interface ContextualProtocol {
  protocolVersion: string;
  supersedes: string;
  changeReason: string;
  retrievalProtocolVersion: string;
  seed: number;
  split: {
    optimizationPeriods: string[];
    confirmationPeriods: string[];
    usesConfirmationFeedback: boolean;
  };
  queryIntent: {
    classifier: string;
    protectedIntent: "historical_aggregate";
    usesTaskLabelsAtInference: boolean;
  };
  candidateGrid: {
    minConfidence: number[];
    maxHops: number[];
    maxExtraSlots: number[];
    protectHistoricalAggregate: boolean[];
    baseResultLimit: number;
    maxExpansions: number;
    timeoutMs: number;
    maxPolicies: number;
  };
  optimizer: {
    quality: string;
    harm: string;
    cost: string;
    harmPenalty: number;
    costPenalty: number;
    fallbackPenalty: number;
  };
  uncertainty: { unit: "persona"; bootstrapSamples: number };
  frozenAnswerLevelSelection: {
    protocolVersion: string;
    selectionSha256: string;
    cases: number;
    reusePriorAnswersOnlyIfCandidateIdsMatch: boolean;
  };
  confirmationGate: {
    minForgettingFamaDelta: number;
    requireForgettingFamaCiLowerAboveZero: boolean;
    requireZeroProtectedIntentMismatches: boolean;
    requireNoMoreHarmedNonForgettingCasesThanV1: boolean;
    maxMeanTokenIncreaseFraction: number;
    requireDisabledEquivalence: boolean;
    requireForcedFailureFallback: boolean;
  };
}

export const CONTEXTUAL_PROTOCOL = protocolJson as ContextualProtocol;

if (CONTEXTUAL_PROTOCOL.retrievalProtocolVersion !== PROTOCOL.protocolVersion) {
  throw new Error("contextual protocol must reference the active retrieval protocol");
}
if (CONTEXTUAL_PROTOCOL.split.usesConfirmationFeedback) {
  throw new Error("contextual protocol forbids confirmation-period feedback");
}

const policyCount = CONTEXTUAL_PROTOCOL.candidateGrid.minConfidence.length
  * CONTEXTUAL_PROTOCOL.candidateGrid.maxHops.length
  * CONTEXTUAL_PROTOCOL.candidateGrid.maxExtraSlots.length
  * CONTEXTUAL_PROTOCOL.candidateGrid.protectHistoricalAggregate.length;
if (policyCount > CONTEXTUAL_PROTOCOL.candidateGrid.maxPolicies) {
  throw new Error(`contextual policy capacity exceeded: ${policyCount}`);
}
