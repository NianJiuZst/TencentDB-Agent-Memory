import protocolJson from "../protocol.contextual-e2e.v1.json" with { type: "json" };
import type { DirectJudgeSpec } from "./judge-provider.js";

export interface ContextualE2EProtocol {
  protocolVersion: string;
  contextualProtocolVersion: string;
  seed: number;
  selection: { protocolVersion: string; sha256: string; cases: number };
  contextManifest: { sha256: string; cases: number };
  arms: Array<"base" | "v1" | "contextual">;
  readers: DirectJudgeSpec[];
  judges: DirectJudgeSpec[];
  retries: number;
  aggregation: { primary: string; sensitivity: string; agreement: string };
  uncertainty: { unit: "persona"; bootstrapSamples: number };
  gate: {
    minContextualVsBaseFamaDelta: number;
    minContextualVsBaseFaaDelta: number;
    requireContextualVsBaseFamaCiLowerAboveZero: boolean;
    requirePositiveContextualVsV1FamaDelta: boolean;
    maxContextualInjectedTokenIncreaseFraction: number;
  };
}

export const CONTEXTUAL_E2E_PROTOCOL = protocolJson as ContextualE2EProtocol;

if (CONTEXTUAL_E2E_PROTOCOL.readers.length !== 2 || CONTEXTUAL_E2E_PROTOCOL.judges.length !== 2) {
  throw new Error("contextual E2E requires exactly two readers and two judges");
}
const readerIds = [...CONTEXTUAL_E2E_PROTOCOL.readers.map((item) => item.id)].sort();
const judgeIds = [...CONTEXTUAL_E2E_PROTOCOL.judges.map((item) => item.id)].sort();
if (readerIds.join("\0") !== judgeIds.join("\0")) {
  throw new Error("cross-model evaluation requires matching reader and judge model ids");
}
