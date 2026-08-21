import { describe, expect, it } from "vitest";
import { contextualPolicies, contextualTargetLimit } from "./contextual-runner.js";

describe("contextual lifecycle policy", () => {
  it("adds slots only for observed redirects and respects the cap", () => {
    expect(contextualTargetLimit(5, 2, 0)).toBe(5);
    expect(contextualTargetLimit(5, 2, 1)).toBe(6);
    expect(contextualTargetLimit(5, 2, 3)).toBe(7);
  });

  it("enumerates the bounded preregistered candidate grid", () => {
    const policies = contextualPolicies();
    expect(policies).toHaveLength(36);
    expect(new Set(policies.map((policy) => JSON.stringify(policy))).size).toBe(36);
    expect(Math.max(...policies.map((policy) => policy.resultLimit))).toBe(7);
  });
});
