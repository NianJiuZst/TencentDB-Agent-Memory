import protocolJson from "../protocol.evidence-shield-e2e.v1.json" with { type: "json" };
import type { DirectJudgeSpec } from "./judge-provider.js";

export interface EvidenceShieldE2EProtocol {
  protocolVersion: string;
  candidateProtocolVersion: string;
  seed: number;
  selection: { protocolVersion: string; sha256: string; cases: number };
  contextManifest: { sha256: string; cases: number };
  reusedV1Evaluations: {
    protocolVersion: string;
    sha256: string;
    totalRows: number;
    selectedArm: "v1";
    selectedRows: number;
    validationSha256: string;
    requiredValidationStatus: "passed";
  };
  arms: Array<"v1" | "shield">;
  readers: DirectJudgeSpec[];
  judges: DirectJudgeSpec[];
  retries: number;
  aggregation: {
    primary: string;
    sensitivity: string;
    uncertaintyUnit: "persona";
    bootstrapSamples: number;
  };
  gate: {
    requirePositiveShieldVsV1FamaDelta: boolean;
    minShieldVsV1FaaDelta: number;
    maxShieldVsV1MpaLoss: number;
    maxMeanInjectedTokenIncreaseFraction: number;
    requireNonnegativeFamaDirectionForEachReader: boolean;
  };
}

export const EVIDENCE_SHIELD_E2E_PROTOCOL = protocolJson as EvidenceShieldE2EProtocol;

if (EVIDENCE_SHIELD_E2E_PROTOCOL.protocolVersion !== "lifecycle-evidence-shield-e2e-v1.0") {
  throw new Error("unexpected evidence-shield answer protocol version");
}
if (EVIDENCE_SHIELD_E2E_PROTOCOL.readers.length !== 2
  || EVIDENCE_SHIELD_E2E_PROTOCOL.judges.length !== 2) {
  throw new Error("evidence-shield answer protocol requires two readers and two judges");
}
const readerIds = EVIDENCE_SHIELD_E2E_PROTOCOL.readers.map((item) => item.id).sort();
const judgeIds = EVIDENCE_SHIELD_E2E_PROTOCOL.judges.map((item) => item.id).sort();
if (readerIds.join("\0") !== judgeIds.join("\0")) {
  throw new Error("evidence-shield crossed panel requires matching reader and judge ids");
}
