import type { ExperimentProtocol } from "./types.js";

export const PROTOCOL: ExperimentProtocol = {
  protocolVersion: "easi-mem-long-dialogue-v1.4.0",
  seed: 20260823,
  split: { train: 0.6, dev: 0.2, test: 0.2 },
  maxCandidates: 30,
  bootstrapSamples: 5000,
  baselineProfile: {
    name: "base",
    candidateLimit: 5,
    resultLimit: 5,
    tokenBudget: 4096,
    recencyWeight: 0,
    diversityWeight: 0,
  },
  profiles: [
    {
      name: "base",
      candidateLimit: 5,
      resultLimit: 5,
      tokenBudget: 4096,
      recencyWeight: 0,
      diversityWeight: 0,
    },
    {
      name: "fixed-896",
      candidateLimit: 30,
      resultLimit: 10,
      tokenBudget: 896,
      recencyWeight: 0,
      diversityWeight: 0.12,
    },
    ...[0.70, 0.75, 0.80, 0.85, 0.90, 0.95].map((baselineTokenRatio) => ({
      name: `relative-${Math.round(baselineTokenRatio * 100)}`,
      candidateLimit: 30,
      resultLimit: 10,
      tokenBudget: 1024,
      baselineTokenRatio,
      recencyWeight: 0,
      diversityWeight: 0.12,
    })),
  ],
  routerGrid: [
    { maxDepth: 3, minLeaf: 10, minConfidence: 0.9 },
    { maxDepth: 4, minLeaf: 10, minConfidence: 0.9 },
    { maxDepth: 4, minLeaf: 15, minConfidence: 0.95 },
    { maxDepth: 5, minLeaf: 10, minConfidence: 0.95 },
    { maxDepth: 5, minLeaf: 15, minConfidence: 0.98 },
  ],
  promotion: {
    maxMacroRecallRegression: 0.01,
    minTokenReduction: 0.1,
    minUtilityCiLowerBound: 0,
    tokenPenalty: 0.03,
  },
};
