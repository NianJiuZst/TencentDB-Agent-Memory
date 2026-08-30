import protocolJson from "../protocol.dual-state-e2e.v1.json" with { type: "json" };
import type { DirectJudgeSpec } from "./judge-provider.js";
import type { DualStateArm } from "./dual-state-context-protocol.js";

export interface DualStateE2EProtocol {
  protocolVersion: string;
  researchDirection: "D19";
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
  };
  arms: DualStateArm[];
  readers: DirectJudgeSpec[];
  judges: DirectJudgeSpec[];
  judgeAssignment: Record<string, string>;
  retries: number;
  aggregation: Record<string, string>;
  uncertainty: { unit: "persona"; bootstrapSamples: number; confidenceLevel: number };
  gates: {
    unconditionalDual: {
      minNaturalFamaDelta: number;
      minNaturalFamaCiLower: number;
      minNaturalFaaDelta: number;
      minNaturalMpaDelta: number;
      maxNaturalTokenIncreaseFraction: number;
    };
    queryAwareValue: {
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
    };
    defaultReplacement: {
      minNaturalExplicitTemporalCases: number;
      minNaturalFamaDelta: number;
      requireNaturalFamaCiLowerAboveZero: boolean;
      explanation: string;
    };
  };
  decisionRule: string;
  reuse: { rule: string; expectedReaderCalls: number; expectedJudgeCalls: number };
  claimBoundary: string;
}

export const DUAL_STATE_E2E_PROTOCOL = protocolJson as DualStateE2EProtocol;

const readerIds = DUAL_STATE_E2E_PROTOCOL.readers.map((item) => item.id).sort();
const judgeIds = DUAL_STATE_E2E_PROTOCOL.judges.map((item) => item.id).sort();
if (readerIds.length !== 2 || readerIds.join("\0") !== judgeIds.join("\0")) {
  throw new Error("D19 requires the same two fixed models as readers and judges");
}
for (const readerId of readerIds) {
  const judgeId = DUAL_STATE_E2E_PROTOCOL.judgeAssignment[readerId];
  if (!judgeId || judgeId === readerId || !judgeIds.includes(judgeId)) {
    throw new Error(`D19 invalid crossed judge assignment for ${readerId}`);
  }
}
