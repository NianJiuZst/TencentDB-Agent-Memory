import { describe, expect, it } from "vitest";
import { promoteLifecyclePolicy } from "./promotion.js";
import type { LifecyclePolicy } from "./types.js";

const incumbent: LifecyclePolicy = {
  enabled: true,
  minConfidence: 0.85,
  maxHops: 1,
  maxExpansions: 64,
  resultLimit: 5,
  timeoutMs: 10,
};

const challenger: LifecyclePolicy = {
  ...incumbent,
  minConfidence: 0.96,
  maxHops: 2,
  resultLimit: 7,
};

describe("promoteLifecyclePolicy", () => {
  it("promotes a challenger only when every gate passes", () => {
    const result = promoteLifecyclePolicy({
      incumbent,
      challenger,
      checks: [
        { name: "quality", passed: true, observed: 0.08, threshold: ">= 0.05" },
        { name: "cost", passed: true, observed: 0.37, threshold: "<= 0.50" },
      ],
    });
    expect(result.outcome).toBe("promote_challenger");
    expect(result.selected).toBe(challenger);
    expect(result.failedChecks).toEqual([]);
  });

  it("retains the incumbent when a downstream safety gate fails", () => {
    const result = promoteLifecyclePolicy({
      incumbent,
      challenger,
      checks: [
        { name: "answer_fama", passed: false, observed: -0.0043, threshold: "> 0" },
        { name: "answer_faa", passed: false, observed: 0.043, threshold: ">= 0.10" },
        { name: "fallback", passed: true },
      ],
    });
    expect(result.outcome).toBe("retain_incumbent");
    expect(result.selected).toBe(incumbent);
    expect(result.failedChecks).toEqual(["answer_fama", "answer_faa"]);
  });

  it("rejects an empty or ambiguous gate definition", () => {
    expect(() => promoteLifecyclePolicy({ incumbent, challenger, checks: [] })).toThrow(/at least one/);
    expect(() => promoteLifecyclePolicy({
      incumbent,
      challenger,
      checks: [{ name: "quality", passed: true }, { name: "quality", passed: true }],
    })).toThrow(/duplicate/);
  });
});
