import protocolJson from "../protocol.v2.json" with { type: "json" };

export interface LifecycleProtocol {
  protocolVersion: string;
  supersedes?: string;
  changeReason?: string;
  seed: number;
  dataset: {
    name: string;
    repository: string;
    revision: string;
    dataManifestSha256: string;
    periods: string[];
    expectedPersonas: number;
    expectedQuestionFiles: number;
    expectedSessionFiles: number;
    sessionSequenceInvariant?: string;
  };
  labelAlignment?: {
    current: string;
    obsolete: string;
    correctionEventIsObsolete: boolean;
  };
  retrieval: {
    backend: string;
    candidateLimit: number;
    resultLimit: number;
    indexOnlySharedMemoryTurns: boolean;
  };
  uncertainty: {
    unit: "persona";
    bootstrapSamples: number;
  };
  headroomGate: {
    subset: "forgetting-bearing";
    minBaseObsoleteAnyRate: number;
    minEvidenceFamaDelta: number;
    minForgettingAbsenceDelta: number;
    requireEvidenceFamaCiLowerAboveZero: boolean;
  };
}

export const PROTOCOL = protocolJson as LifecycleProtocol;

if (PROTOCOL.retrieval.candidateLimit < PROTOCOL.retrieval.resultLimit) {
  throw new Error("candidateLimit must be at least resultLimit");
}

if (PROTOCOL.uncertainty.bootstrapSamples < 1000) {
  throw new Error("bootstrapSamples must be at least 1000");
}
