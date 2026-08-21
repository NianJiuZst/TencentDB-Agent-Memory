import protocolJson from "../protocol.valid-state-packing-e2e.v1.json" with { type: "json" };
import type { DirectJudgeSpec } from "./judge-provider.js";

interface ValidStatePackingE2EProtocol {
  protocolVersion: string;
  candidateProtocolVersion: string;
  selectionProtocolVersion: string;
  seed: number;
  dataset: { name: string; revision: string; dataManifestSha256: string };
  inputs: {
    selection: { sha256: string; cases: number; personas: number; overlapWithPriorPanel: number };
    contextManifest: {
      sha256: string;
      changedCases: number;
      unchangedCases: number;
      v1MeanInjectedTokens: number;
      candidateMeanInjectedTokens: number;
    };
    proxyRun: {
      casesSha256: string;
      summarySha256: string;
      validationSha256: string;
      requiredStatus: "passed";
    };
    excludedPriorSelectionSha256: string;
  };
  arms: Array<"v1" | "valid_state_packing">;
  readers: DirectJudgeSpec[];
  judges: DirectJudgeSpec[];
  execution: {
    retries: number;
    maxConcurrency: number;
    expectedReaderCalls: number;
    expectedJudgeCalls: number;
    expectedArmRows: number;
  };
  aggregation: {
    bootstrapSamples: number;
    uncertaintyUnit: "persona";
  };
  answerGate: {
    requirePositiveFamaDelta: boolean;
    minFamaPersonaBootstrapLower: number;
    requirePositiveMpaDelta: boolean;
    minFaaDelta: number;
    requireNonnegativeCriterionAccuracyDelta: boolean;
    requireNonnegativeFamaDirectionForEachReader: boolean;
    maxMeanInjectedTokenIncreaseFraction: number;
    requireExactNoopClones: boolean;
    requireZeroModelMismatches: boolean;
  };
}

export const VALID_STATE_PACKING_E2E_PROTOCOL = protocolJson as ValidStatePackingE2EProtocol;

if (VALID_STATE_PACKING_E2E_PROTOCOL.protocolVersion
  !== "lifecycle-valid-state-packing-e2e-v1.0") {
  throw new Error("unexpected valid-state packing answer protocol version");
}
if (VALID_STATE_PACKING_E2E_PROTOCOL.readers.length !== 2
  || VALID_STATE_PACKING_E2E_PROTOCOL.judges.length !== 2) {
  throw new Error("valid-state packing answer protocol requires two readers and two judges");
}
const readers = VALID_STATE_PACKING_E2E_PROTOCOL.readers.map((item) => item.id).sort();
const judges = VALID_STATE_PACKING_E2E_PROTOCOL.judges.map((item) => item.id).sort();
if (readers.join("\0") !== judges.join("\0")) {
  throw new Error("valid-state packing crossed panel requires matching reader and judge ids");
}
