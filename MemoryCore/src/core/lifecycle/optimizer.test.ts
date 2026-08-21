import { describe, expect, it } from "vitest";
import { optimizeLifecyclePolicy } from "./optimizer.js";
import type { LifecyclePolicy } from "./types.js";

const base: Omit<LifecyclePolicy, "maxHops"> = {
  enabled: true,
  minConfidence: 0.9,
  maxExpansions: 64,
  resultLimit: 5,
  timeoutMs: 10,
};

describe("optimizeLifecyclePolicy", () => {
  it("selects policy from bounded feedback without touching held-out data", async () => {
    const policies = [1, 2, 4].map((maxHops) => ({ ...base, maxHops }));
    const result = await optimizeLifecyclePolicy({
      policies,
      evaluate: (policy) => ({
        quality: policy.maxHops === 2 ? 0.7 : 0.6,
        meanCost: policy.maxHops,
        fallbackRate: 0,
      }),
      weights: { costPenalty: 0.01, fallbackPenalty: 1 },
      maxPolicies: 8,
    });
    expect(result.selected.maxHops).toBe(2);
    expect(result.trials).toHaveLength(3);
  });

  it("can select an extended policy using an explicit protected-slice harm penalty", async () => {
    const policies = [
      { ...base, maxHops: 1, protectHistory: false },
      { ...base, maxHops: 1, protectHistory: true },
    ];
    const result = await optimizeLifecyclePolicy({
      policies,
      evaluate: (policy) => ({
        quality: 0.7,
        meanCost: 0.1,
        fallbackRate: 0,
        harm: policy.protectHistory ? 0 : 0.05,
      }),
      weights: { costPenalty: 0.01, fallbackPenalty: 1, harmPenalty: 1 },
    });

    expect(result.selected.protectHistory).toBe(true);
    expect(result.trials[0].feedback.harm).toBe(0);
  });
});
