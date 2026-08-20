import { describe, expect, it, vi } from "vitest";
import { executeAdaptiveLineRecall } from "./runtime.js";
import type { AdaptiveRecallPolicy } from "./types.js";

const policy: AdaptiveRecallPolicy = {
  schemaVersion: 1,
  revision: "runtime-r1",
  createdAt: "2026-08-20T00:00:00.000Z",
  defaultProfile: "lean",
  profiles: [
    { name: "base", candidateLimit: 5, resultLimit: 5, tokenBudget: 4096, recencyWeight: 0, diversityWeight: 0 },
    { name: "lean", candidateLimit: 8, resultLimit: 2, tokenBudget: 30, recencyWeight: 0, diversityWeight: 0 },
  ],
  router: { profile: "lean" },
};

const resultFor = (limit: number) => ({
  lines: Array.from({ length: limit }, (_, index) => `memory ${index}`),
  scores: Array.from({ length: limit }, (_, index) => 1 - index / 100),
  timing: { queryMs: limit },
});

describe("executeAdaptiveLineRecall", () => {
  it("is an exact one-call pass-through while disabled", async () => {
    const search = vi.fn(async (limit: number) => resultFor(limit));
    const loader = vi.fn(async () => policy);
    const result = await executeAdaptiveLineRecall({
      enabled: false,
      query: "question",
      baselineMaxResults: 5,
      timeoutMs: 20,
      search,
      policyLoader: loader,
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(5);
    expect(loader).not.toHaveBeenCalled();
    expect(result.searchResult.lines).toEqual(resultFor(5).lines);
    expect(result.decision.mode).toBe("base");
  });

  it("uses one enlarged base query for a static promoted policy", async () => {
    const search = vi.fn(async (limit: number) => resultFor(limit));
    const result = await executeAdaptiveLineRecall({
      enabled: true,
      query: "question",
      baselineMaxResults: 5,
      timeoutMs: 20,
      search,
      policyLoader: async () => policy,
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(8);
    expect(result.searchResult.lines).toHaveLength(2);
    expect(result.decision.mode).toBe("adaptive");
  });

  it("hard-falls back to the exact base query for a corrupt policy", async () => {
    const search = vi.fn(async (limit: number) => resultFor(limit));
    const result = await executeAdaptiveLineRecall({
      enabled: true,
      query: "question",
      baselineMaxResults: 5,
      timeoutMs: 20,
      search,
      policyLoader: async () => ({ schemaVersion: 99 }),
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(5);
    expect(result.searchResult.lines).toEqual(resultFor(5).lines);
    expect(result.decision.fallback).toBe(true);
  });

  it("hard-falls back when runtime base settings differ from the evaluated baseline", async () => {
    const search = vi.fn(async (limit: number) => resultFor(limit));
    const result = await executeAdaptiveLineRecall({
      enabled: true,
      query: "question",
      baselineMaxResults: 4,
      timeoutMs: 20,
      search,
      policyLoader: async () => policy,
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(4);
    expect(result.decision.fallbackReason).toContain("differs from the policy evaluation baseline");
  });

  it("hard-falls back after an adaptive timeout", async () => {
    const search = vi.fn((limit: number) => limit === 8
      ? new Promise<ReturnType<typeof resultFor>>(() => undefined)
      : Promise.resolve(resultFor(limit)));
    const result = await executeAdaptiveLineRecall({
      enabled: true,
      query: "question",
      baselineMaxResults: 5,
      timeoutMs: 5,
      search,
      policyLoader: async () => policy,
    });

    expect(search.mock.calls.map(([limit]) => limit)).toEqual([8, 5]);
    expect(result.searchResult.lines).toEqual(resultFor(5).lines);
    expect(result.decision.fallbackReason).toContain("timed out");
  });

  it("does not let a late timed-out query overwrite fallback timing", async () => {
    let resolveAdaptive: ((value: ReturnType<typeof resultFor>) => void) | undefined;
    const search = vi.fn((limit: number) => limit === 8
      ? new Promise<ReturnType<typeof resultFor>>((resolve) => { resolveAdaptive = resolve; })
      : Promise.resolve(resultFor(limit)));
    const result = await executeAdaptiveLineRecall({
      enabled: true,
      query: "question",
      baselineMaxResults: 5,
      timeoutMs: 5,
      search,
      policyLoader: async () => policy,
    });

    resolveAdaptive?.(resultFor(8));
    await Promise.resolve();

    expect(result.searchResult.timing).toEqual({ queryMs: 5 });
    expect(result.searchResult.lines).toEqual(resultFor(5).lines);
  });
});
