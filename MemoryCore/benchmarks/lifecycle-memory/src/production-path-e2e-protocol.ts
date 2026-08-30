import protocolJson from "../protocol.production-path-e2e.v1.json" with { type: "json" };
import type { DirectJudgeSpec } from "./judge-provider.js";
import type { ProductionPathArm } from "./production-path-context-protocol.js";

export interface ProductionPathE2EProtocol {
  protocolVersion: string;
  seed: number;
  preScoreCommitRequired: boolean;
  context: {
    protocolVersion: string;
    sha256: string;
    cases: number;
    naturalCases: number;
    temporalCases: number;
    temporalPairs: number;
    uniquePromptsPerReader: number;
    caseArmContexts: number;
  };
  arms: ProductionPathArm[];
  readers: DirectJudgeSpec[];
  judges: DirectJudgeSpec[];
  judgeAssignment: Record<string, string>;
  retries: number;
  aggregation: Record<string, string>;
  uncertainty: { unit: "persona"; bootstrapSamples: number; confidenceLevel: number };
  gates: {
    minTemporalCriterionAccuracyDelta: number;
    requireTemporalCriterionAccuracyCiLowerAboveZero: boolean;
    minHistoryCriterionAccuracyDelta: number;
    minChangeCriterionAccuracyDelta: number;
    minCurrentCriterionAccuracyDelta: number;
    minNaturalFamaDelta: number;
    maxCombinedTokenIncreaseFraction: number;
    requireNonnegativeTemporalDirectionForBothReaders: boolean;
    requireCompleteFrozenTaskSet: boolean;
    requireZeroModelMismatches: boolean;
    requireZeroSelfJudgments: boolean;
    requirePassedProductionContext: boolean;
  };
  decisionRule: string;
  reuse: { rule: string; expectedReaderCalls: number; expectedJudgeCalls: number };
  claimBoundary: string;
}

export const PRODUCTION_PATH_E2E_PROTOCOL = protocolJson as ProductionPathE2EProtocol;

const readerIds = PRODUCTION_PATH_E2E_PROTOCOL.readers.map((item) => item.id).sort();
const judgeIds = PRODUCTION_PATH_E2E_PROTOCOL.judges.map((item) => item.id).sort();
if (readerIds.length !== 2 || readerIds.join("\0") !== judgeIds.join("\0")) {
  throw new Error("production-path evaluation requires the same two fixed models as readers and judges");
}
for (const readerId of readerIds) {
  const judgeId = PRODUCTION_PATH_E2E_PROTOCOL.judgeAssignment[readerId];
  if (!judgeId || judgeId === readerId || !judgeIds.includes(judgeId)) {
    throw new Error(`invalid crossed judge assignment for ${readerId}`);
  }
}
