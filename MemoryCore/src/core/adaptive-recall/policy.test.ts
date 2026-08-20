import { describe, expect, it } from "vitest";
import { extractQueryFeatures } from "./features.js";
import { validateAdaptiveRecallPolicy } from "./policy.js";
import { rerankCandidates } from "./rerank.js";
import { packCandidates } from "./rerank.js";
import type { AdaptiveRecallPolicy, RecallProfile } from "./types.js";

const profile: RecallProfile = {
  name: "temporal",
  candidateLimit: 5,
  resultLimit: 3,
  tokenBudget: 512,
  recencyWeight: 0.1,
  diversityWeight: 0,
};

const validPolicy: AdaptiveRecallPolicy = {
  schemaVersion: 1,
  revision: "r1",
  createdAt: "2026-08-20T00:00:00.000Z",
  defaultProfile: "temporal",
  profiles: [profile],
  router: {
    feature: "temporalCueCount",
    threshold: 0,
    left: { profile: "temporal" },
    right: { profile: "temporal" },
  },
};

describe("adaptive recall policy", () => {
  it("extracts runtime features without accepting labels", () => {
    const features = extractQueryFeatures("How many weeks after 2024 did it change?", 80, [
      { id: "a", content: "first", score: 1, sourceId: "s1", tokenCount: 10 },
      { id: "b", content: "second", score: 0.5, sourceId: "s2", tokenCount: 20 },
    ]);
    expect(features.temporalCueCount).toBeGreaterThan(0);
    expect(features.updateCueCount).toBeGreaterThan(0);
    expect(features.digitCount).toBe(4);
    expect(features.documentCount).toBe(80);
    expect(features.topScoreGap).toBe(0.5);
    expect(features.uniqueSourceRatio5).toBe(1);
    expect(Object.keys(features)).not.toContain("questionType");
  });

  it("rejects policies outside hard limits", () => {
    const unsafe = structuredClone(validPolicy);
    unsafe.profiles[0].tokenBudget = 100_000;
    expect(() => validateAdaptiveRecallPolicy(unsafe)).toThrow(/tokenBudget/);
  });

  it("rejects an unsafe base-relative budget", () => {
    const unsafe = structuredClone(validPolicy);
    unsafe.profiles[0].baselineTokenRatio = 1.1;
    expect(() => validateAdaptiveRecallPolicy(unsafe)).toThrow(/baselineTokenRatio/);
  });

  it("caps injection relative to the exact base Top-k load", () => {
    const relative = { ...profile, tokenBudget: 100, baselineTokenRatio: 0.75 };
    const packed = packCandidates([
      { id: "a", content: "a", score: 1, tokenCount: 20 },
      { id: "b", content: "b", score: 0.9, tokenCount: 20 },
      { id: "c", content: "c", score: 0.8, tokenCount: 20 },
    ], relative, undefined, [
      { id: "base-a", content: "base a", score: 1, tokenCount: 40 },
      { id: "base-b", content: "base b", score: 0.9, tokenCount: 40 },
    ]);
    expect(packed.budget).toBe(60);
    expect(packed.tokens).toBe(60);
  });

  it("keeps recency influence bounded by relevance rank", () => {
    const ranked = rerankCandidates([
      { id: "relevant-old", content: "alpha", score: 1, timestampMs: 0 },
      { id: "less-relevant-new", content: "beta", score: 0.5, timestampMs: 100 },
    ], profile);
    expect(ranked[0].id).toBe("relevant-old");
  });
});
