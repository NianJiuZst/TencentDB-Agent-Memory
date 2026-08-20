import protocolJson from "../protocol.e2e.v2.json" with { type: "json" };
import { PROTOCOL } from "./protocol.js";

export interface LifecycleE2EProtocol {
  protocolVersion: string;
  supersedes?: string;
  changeReason?: string;
  retrievalProtocolVersion: string;
  seed: number;
  population: string;
  selection: {
    stratifyBy: "persona";
    casesPerPersona: number;
    expectedPersonas: number;
    expectedPopulationSize: number;
    hashAlgorithm: "sha256";
    hashInput: string;
    frozenSelectionSha256: string;
    usesAnswerOrJudgeOutput: boolean;
  };
  arms: ["base", "oracle_query"];
  models: {
    provider: "openrouter";
    reader: string;
    readerTemperature: number;
    readerMaxTokens: number;
    judge: string;
    judgeTemperature: number;
    judgeMaxTokens: number;
    retries: number;
  };
  evaluation: {
    criteriaSource: string;
    judgeMode: string;
    metrics: string[];
    officialTable3Comparable: boolean;
  };
  uncertainty: {
    unit: "persona";
    bootstrapSamples: number;
  };
  headroomGate: {
    minFamaDelta: number;
    minFaaDelta: number;
    requireFamaCiLowerAboveZero: boolean;
  };
}

export const E2E_PROTOCOL = protocolJson as LifecycleE2EProtocol;

if (E2E_PROTOCOL.retrievalProtocolVersion !== PROTOCOL.protocolVersion) {
  throw new Error("E2E protocol must reference the active retrieval protocol");
}

if (E2E_PROTOCOL.selection.usesAnswerOrJudgeOutput) {
  throw new Error("E2E sample selection must not use answer or judge output");
}

if (!/^[a-f0-9]{64}$/.test(E2E_PROTOCOL.selection.frozenSelectionSha256)) {
  throw new Error("E2E protocol must pin a valid frozen selection SHA-256");
}
