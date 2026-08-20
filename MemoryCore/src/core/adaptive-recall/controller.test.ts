import { describe, expect, it, vi } from "vitest";
import { executeAdaptiveRecall } from "./controller.js";
import type { AdaptiveRecallPolicy, RecallCandidate, RecallProfile } from "./types.js";

const baseProfile: RecallProfile = {
  name: "base",
  candidateLimit: 15,
  resultLimit: 5,
  tokenBudget: 1024,
  recencyWeight: 0,
  diversityWeight: 0,
};

const policy: AdaptiveRecallPolicy = {
  schemaVersion: 1,
  revision: "test-r1",
  createdAt: "2026-08-20T00:00:00.000Z",
  defaultProfile: "lean",
  profiles: [
    baseProfile,
    { name: "lean", candidateLimit: 6, resultLimit: 3, tokenBudget: 128, recencyWeight: 0, diversityWeight: 0 },
  ],
  router: { profile: "lean" },
};

const baseCandidates: RecallCandidate[] = [
  { id: "base-1", content: "baseline", score: 1, tokenCount: 2 },
];

describe("executeAdaptiveRecall", () => {
  it("uses the exact baseline path when disabled", async () => {
    const baselineSearch = vi.fn(async () => baseCandidates);
    const candidateSearch = vi.fn(async () => []);
    const result = await executeAdaptiveRecall({
      enabled: false,
      query: "where is it",
      timeoutMs: 20,
      baselineProfile: baseProfile,
      baselineSearch,
      candidateSearch,
    });

    expect(result.candidates).toBe(baseCandidates);
    expect(result.decision.mode).toBe("base");
    expect(result.decision.fallback).toBe(false);
    expect(baselineSearch).toHaveBeenCalledTimes(1);
    expect(candidateSearch).not.toHaveBeenCalled();
  });

  it("falls back for a corrupt policy", async () => {
    const baselineSearch = vi.fn(async () => baseCandidates);
    const candidateSearch = vi.fn(async () => []);
    const result = await executeAdaptiveRecall({
      enabled: true,
      query: "where is it",
      timeoutMs: 20,
      baselineProfile: baseProfile,
      baselineSearch,
      candidateSearch,
      policy: { schemaVersion: 999 },
    });

    expect(result.candidates).toBe(baseCandidates);
    expect(result.decision.fallback).toBe(true);
    expect(result.decision.fallbackReason).toContain("policy-load-or-validation-failure");
    expect(candidateSearch).not.toHaveBeenCalled();
  });

  it("does not run a scout query for a static policy leaf", async () => {
    const baselineSearch = vi.fn(async () => baseCandidates);
    const candidateSearch = vi.fn(async () => [
      { id: "1", content: "selected", score: 1, tokenCount: 2 },
    ]);
    const result = await executeAdaptiveRecall({
      enabled: true,
      query: "where is it",
      timeoutMs: 20,
      baselineProfile: baseProfile,
      baselineSearch,
      candidateSearch,
      policy,
    });

    expect(result.decision.mode).toBe("adaptive");
    expect(baselineSearch).not.toHaveBeenCalled();
    expect(candidateSearch).toHaveBeenCalledTimes(1);
  });

  it("never loads the policy while disabled", async () => {
    const policyLoader = vi.fn(async () => policy);
    const result = await executeAdaptiveRecall({
      enabled: false,
      query: "where is it",
      timeoutMs: 20,
      baselineProfile: baseProfile,
      baselineSearch: vi.fn(async () => baseCandidates),
      candidateSearch: vi.fn(async () => []),
      policyLoader,
    });

    expect(result.decision.mode).toBe("base");
    expect(policyLoader).not.toHaveBeenCalled();
  });

  it("falls back when adaptive retrieval throws", async () => {
    const baselineSearch = vi.fn(async () => baseCandidates);
    const result = await executeAdaptiveRecall({
      enabled: true,
      query: "where is it",
      timeoutMs: 20,
      baselineProfile: baseProfile,
      baselineSearch,
      candidateSearch: vi.fn(async () => { throw new Error("forced"); }),
      policy,
    });

    expect(result.candidates).toBe(baseCandidates);
    expect(result.decision.fallback).toBe(true);
    expect(result.decision.fallbackReason).toContain("forced");
  });

  it("falls back on timeout", async () => {
    const baselineSearch = vi.fn(async () => baseCandidates);
    const result = await executeAdaptiveRecall({
      enabled: true,
      query: "where is it",
      timeoutMs: 5,
      baselineProfile: baseProfile,
      baselineSearch,
      candidateSearch: vi.fn(() => new Promise(() => undefined)),
      policy,
    });

    expect(result.candidates).toBe(baseCandidates);
    expect(result.decision.fallbackReason).toContain("timed out");
  });

  it("enforces the selected result and token budgets", async () => {
    const candidates: RecallCandidate[] = [
      { id: "1", content: "one", score: 1, tokenCount: 60 },
      { id: "2", content: "two", score: 0.9, tokenCount: 60 },
      { id: "3", content: "three", score: 0.8, tokenCount: 60 },
    ];
    const result = await executeAdaptiveRecall({
      enabled: true,
      query: "where is it",
      timeoutMs: 20,
      baselineProfile: baseProfile,
      baselineSearch: vi.fn(async () => baseCandidates),
      candidateSearch: vi.fn(async () => candidates),
      policy,
    });

    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["1", "2"]);
    expect(result.decision.returnedTokens).toBe(120);
    expect(result.decision.mode).toBe("adaptive");
  });
});
