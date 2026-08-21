import protocolJson from "../protocol.delete-vacancy.v1.json" with { type: "json" };
import type { LifecycleDeleteVacancyPolicy, LifecyclePolicy } from "../../../src/core/lifecycle/index.js";

interface DeleteVacancyProtocol {
  protocolVersion: string;
  seed: number;
  dataset: { name: string; revision: string; dataManifestSha256: string };
  split: {
    developmentPeriods: string[];
    heldOutProxyPeriod: string;
  };
  incumbent: LifecyclePolicy & { name: string };
  candidate: LifecycleDeleteVacancyPolicy & {
    name: string;
    candidateLimit: number;
  };
  capacity: {
    maxUnitsPerGroup: number;
    maxEventsPerGroup: number;
    maxEdgesPerGroup: number;
    maxTombstonesPerGroup: number;
  };
  evaluation: {
    uncertaintyUnit: "persona";
    bootstrapSamples: number;
  };
  proxyGate: {
    minPrimaryEvidenceFamaProxyDelta: number;
    requirePrimaryEvidenceFamaProxyCiLowerAboveZero: boolean;
    minPrimaryCurrentSessionRecallDelta: number;
    minPrimaryForgettingAbsenceDelta: number;
    maxQuarterlyCurrentStateNonForgettingHarmedCasesVsV1: number;
    maxMeanInjectedTokenIncreaseFractionVsV1: number;
    requireAtMostFiveCandidates: boolean;
    requireZeroOrdinaryFallbacks: boolean;
    requireDisabledBaseEquivalence: boolean;
    requireForcedFailureBaseFallback: boolean;
  };
}

export const DELETE_VACANCY_PROTOCOL = protocolJson as DeleteVacancyProtocol;

if (DELETE_VACANCY_PROTOCOL.protocolVersion !== "lifecycle-delete-vacancy-v1.0") {
  throw new Error("unexpected delete-vacancy protocol version");
}
if (DELETE_VACANCY_PROTOCOL.candidate.resultLimit
  !== DELETE_VACANCY_PROTOCOL.incumbent.resultLimit) {
  throw new Error("delete-vacancy must preserve the incumbent result limit");
}
if (DELETE_VACANCY_PROTOCOL.candidate.candidateLimit
  !== DELETE_VACANCY_PROTOCOL.candidate.maxCandidates) {
  throw new Error("delete-vacancy candidate capacity must equal the frozen pool size");
}
