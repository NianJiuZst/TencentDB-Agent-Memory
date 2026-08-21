import protocolJson from "../protocol.memops-target-state.v1.json" with { type: "json" };
import selectionJson from "../protocol.memops-target-state-selection.v1.json" with { type: "json" };
import validationJson from "../protocol.memops-target-state-validation.v1.json" with { type: "json" };

export type MemOpsTargetStatePhase = "development" | "validation" | "test";

interface MemOpsTargetStateProtocol {
  protocolVersion: string;
  dataset: {
    name: "MemOps";
    revision: string;
    manifestSha256: string;
    instances: number;
    profiles: number;
    operations: number;
    longitudinalProbes: number;
  };
  split: {
    protocolVersion: string;
    fileSha256: string;
    canonicalSha256: string;
    developmentPrimaryCases: number;
    validationPrimaryCases: number;
    testPrimaryCases: number;
  };
  retrieval: {
    candidateLimit: number;
    resultLimit: number;
  };
  arms: {
    v1: {
      minConfidence: number;
      maxHops: number;
      maxExpansions: number;
      resultLimit: number;
      timeoutMs: number;
    };
    targetState: {
      minConfidence: number;
      maxCandidates: number;
      maxExpansions: number;
      maxTargets: number;
      resultLimit: number;
      timeoutMs: number;
    };
  };
  policyGrid: {
    budgetFractions: number[];
    maxStateUnits: number[];
    policies: number;
  };
  aggregation: {
    primaryProbeType: string;
    secondaryProbeTypes: string[];
    historyModeProbeTypes: string[];
    uncertaintyUnit: "profile";
    bootstrapSamples: number;
    bootstrapSeed: number;
  };
  validationGate: {
    minStateFamaDelta: number;
    minStateFamaBootstrapLower: number;
    minCurrentStateRecallDelta: number;
    minStaleAbsenceDelta: number;
    maxPrimaryHarmedCaseRate: number;
    minPerOperationFamilyStateFamaDelta: number;
    maxMeanInjectedTokenIncreaseFraction: number;
    maxPerQueryTokenViolations: number;
    maxOrdinaryFallbacks: number;
    maxP95SidecarLatencyMs: number;
    requireExactDisabledFallback: boolean;
    requireExactMissingSourceFallback: boolean;
    requireExactTimeoutFallback: boolean;
    requireExactHistoryModeV1: boolean;
  };
  testGate: {
    requireValidationPassBeforeRead: boolean;
    minStateFamaDelta: number;
    minStateFamaBootstrapLower: number;
    minCurrentStateRecallDelta: number;
    minStaleAbsenceDelta: number;
    maxMeanInjectedTokenIncreaseFraction: number;
    maxPerQueryTokenViolations: number;
    maxOrdinaryFallbacks: number;
  };
}

export const MEMOPS_TARGET_STATE_PROTOCOL = protocolJson as MemOpsTargetStateProtocol;
export const MEMOPS_TARGET_STATE_SELECTION = selectionJson;
export const MEMOPS_TARGET_STATE_VALIDATION = validationJson;

if (MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion !== "lifecycle-memops-target-state-v1.0") {
  throw new Error("unexpected MemOps target-state protocol version");
}
if (MEMOPS_TARGET_STATE_SELECTION.selectionProtocolVersion
  !== "lifecycle-memops-target-state-selection-v1.0"
  || MEMOPS_TARGET_STATE_SELECTION.sourceProtocolVersion
    !== MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion) {
  throw new Error("unexpected MemOps target-state selection protocol version");
}
if (MEMOPS_TARGET_STATE_VALIDATION.validationProtocolVersion
  !== "lifecycle-memops-target-state-validation-v1.0"
  || MEMOPS_TARGET_STATE_VALIDATION.sourceProtocolVersion
    !== MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion
  || MEMOPS_TARGET_STATE_VALIDATION.status !== "passed"
  || MEMOPS_TARGET_STATE_VALIDATION.developmentSelectionSha256
    !== MEMOPS_TARGET_STATE_SELECTION.developmentSelectionSha256
  || MEMOPS_TARGET_STATE_VALIDATION.selectedPolicy.id
    !== MEMOPS_TARGET_STATE_SELECTION.selectedPolicy.id) {
  throw new Error("unexpected MemOps target-state validation lock");
}
const gridSize = MEMOPS_TARGET_STATE_PROTOCOL.policyGrid.budgetFractions.length
  * MEMOPS_TARGET_STATE_PROTOCOL.policyGrid.maxStateUnits.length;
if (gridSize !== MEMOPS_TARGET_STATE_PROTOCOL.policyGrid.policies) {
  throw new Error("MemOps target-state policy grid size mismatch");
}
if (MEMOPS_TARGET_STATE_PROTOCOL.retrieval.resultLimit
  !== MEMOPS_TARGET_STATE_PROTOCOL.arms.v1.resultLimit
  || MEMOPS_TARGET_STATE_PROTOCOL.retrieval.resultLimit
    !== MEMOPS_TARGET_STATE_PROTOCOL.arms.targetState.resultLimit) {
  throw new Error("MemOps target-state result limits differ across arms");
}
