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
});
