import protocolJson from "../protocol.broad-ablation-e2e.v1.json" with { type: "json" };
import type { DirectJudgeSpec } from "./judge-provider.js";
import type { BroadAblationArm } from "./broad-ablation-context-protocol.js";

export interface BroadAblationE2EProtocol {
  protocolVersion: string;
  researchDirection: "D16";
  seed: number;
  context: { protocolVersion: string; sha256: string; cases: number; uniquePromptsPerReader: number };
  arms: BroadAblationArm[];
  readers: DirectJudgeSpec[];
  judges: DirectJudgeSpec[];
  judgeAssignment: Record<string, string>;
  retries: number;
  aggregation: Record<string, string>;
  subgroups: string[];
  uncertainty: { unit: "persona"; bootstrapSamples: number; confidenceLevel: number };
  promotionGate: {
    incumbent: "v1";
    minFullPopulationFamaDelta: number;
    requireFamaCiLowerAboveZero: boolean;
    minFullPopulationFaaDelta: number;
    minFullPopulationMpaDelta: number;
    maxMeanTokenIncreaseFraction: number;
    requireZeroModelMismatches: boolean;
    requireCompleteFrozenTaskSet: boolean;
  };
  decisionRule: string;
  reuse: { rule: string; expectedReaderCalls: number; expectedJudgeCalls: number };
  claimBoundary: string;
}

export const BROAD_ABLATION_E2E_PROTOCOL = protocolJson as BroadAblationE2EProtocol;

const readerIds = BROAD_ABLATION_E2E_PROTOCOL.readers.map((item) => item.id).sort();
const judgeIds = BROAD_ABLATION_E2E_PROTOCOL.judges.map((item) => item.id).sort();
if (readerIds.join("\0") !== judgeIds.join("\0") || readerIds.length !== 2) {
  throw new Error("D16 requires the same two fixed models as readers and judges");
}
for (const readerId of readerIds) {
  const judgeId = BROAD_ABLATION_E2E_PROTOCOL.judgeAssignment[readerId];
  if (!judgeId || judgeId === readerId || !judgeIds.includes(judgeId)) {
    throw new Error(`D16 invalid crossed judge assignment for ${readerId}`);
  }
}
