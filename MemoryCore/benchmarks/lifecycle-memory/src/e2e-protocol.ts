import protocolJson from "../protocol.e2e.adaptive.v1.json" with { type: "json" };
import type { LifecyclePolicy } from "../../../src/core/lifecycle/index.js";
import { ADAPTIVE_PROTOCOL } from "./adaptive-protocol.js";
import { PROTOCOL } from "./protocol.js";

export interface LifecycleE2EProtocol {
  protocolVersion: string;
  supersedes?: string;
  changeReason?: string;
  retrievalProtocolVersion: string;
  adaptiveProtocolVersion?: string;
  seed: number;
  population: string;
  selection: {
    eligiblePeriods?: string[];
    stratifyBy: "persona";
    casesPerPersona: number;
    expectedPersonas: number;
    expectedPopulationSize: number;
    hashAlgorithm: "sha256";
    hashInput: string;
    frozenSelectionSha256: string;
    usesAnswerOrJudgeOutput: boolean;
  };
  arms: ["base", "oracle_query" | "oracle_chain" | "adaptive"];
  adaptivePolicy?: LifecyclePolicy;
  policyProvenance?: string;
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
    invalidJudgeAnswer?: string;
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

if (
  E2E_PROTOCOL.retrievalProtocolVersion !== PROTOCOL.protocolVersion
  && E2E_PROTOCOL.retrievalProtocolVersion !== PROTOCOL.supersedes
  && !PROTOCOL.compatibleRetrievalProtocols?.includes(E2E_PROTOCOL.retrievalProtocolVersion)
) {
  throw new Error("E2E protocol must reference the active retrieval protocol");
}

if (E2E_PROTOCOL.selection.usesAnswerOrJudgeOutput) {
  throw new Error("E2E sample selection must not use answer or judge output");
}

if (
  E2E_PROTOCOL.arms[1] === "adaptive"
  && E2E_PROTOCOL.adaptiveProtocolVersion !== ADAPTIVE_PROTOCOL.protocolVersion
) {
  throw new Error("adaptive E2E protocol must reference the active adaptive protocol");
}

if (!/^[a-f0-9]{64}$/.test(E2E_PROTOCOL.selection.frozenSelectionSha256)) {
  throw new Error("E2E protocol must pin a valid frozen selection SHA-256");
}
