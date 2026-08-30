import protocolJson from "../protocol.version-aware-e2e.v1.json" with { type: "json" };
import type { DirectJudgeSpec } from "./judge-provider.js";
import type { VersionAwareArm } from "./version-aware-context-protocol.js";

export interface VersionAwareE2EProtocol {
  protocolVersion: string;
  seed: number;
  preScoreCommitRequired: boolean;
  context: {
    protocolVersion: string;
    sha256: string;
    cases: number;
    naturalCases: number;
    capabilityCases: number;
    scenarios: number;
    uniquePromptsPerReader: number;
    caseArmContexts: number;
  };
  arms: VersionAwareArm[];
  readers: DirectJudgeSpec[];
  judges: DirectJudgeSpec[];
  judgeAssignment: Record<string, string>;
  retries: number;
  aggregation: Record<string, string>;
  uncertainty: { unit: "scenario_or_persona"; bootstrapSamples: number; confidenceLevel: number };
  gates: {
    minVersionAwareContextExactSelection: number;
    maxVersionAwareContextContaminationRate: number;
    minCapabilityCriterionAccuracyDeltaVsGlobal: number;
    minCapabilityCriterionAccuracyDeltaVsOldCurrentDual: number;
    requireCapabilityCiLowerAboveZero: boolean;
    minCurrentSliceCriterionAccuracyDelta: number;
    minCrossStateSliceCriterionAccuracyDelta: number;
    minMissingScopeCriterionAccuracyDelta: number;
    minNaturalFamaDelta: number;
    maxCombinedTokenIncreaseFraction: number;
    requireNonnegativeCapabilityDirectionForBothReaders: boolean;
    requireCompleteFrozenTaskSet: boolean;
    requireZeroModelMismatches: boolean;
    requireZeroSelfJudgments: boolean;
    requirePassedProductionContext: boolean;
  };
  decisionRule: string;
  reuse: { rule: string; expectedReaderCalls: number; expectedJudgeCalls: number };
  claimBoundary: string;
}

export const VERSION_AWARE_E2E_PROTOCOL = protocolJson as VersionAwareE2EProtocol;

const readerIds = VERSION_AWARE_E2E_PROTOCOL.readers.map((item) => item.id).sort();
const judgeIds = VERSION_AWARE_E2E_PROTOCOL.judges.map((item) => item.id).sort();
if (readerIds.length !== 2 || readerIds.join("\0") !== judgeIds.join("\0")) {
  throw new Error("version-aware evaluation requires the same two fixed models as readers and judges");
}
for (const readerId of readerIds) {
  const judgeId = VERSION_AWARE_E2E_PROTOCOL.judgeAssignment[readerId];
  if (!judgeId || judgeId === readerId || !judgeIds.includes(judgeId)) {
    throw new Error(`invalid version-aware crossed judge assignment for ${readerId}`);
  }
}
