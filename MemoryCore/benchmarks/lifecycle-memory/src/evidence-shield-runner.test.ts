import { describe, expect, it } from "vitest";
import { summarizeEvidenceShieldCases } from "./evidence-shield-runner.js";

function item(overrides: Record<string, unknown> = {}) {
  return {
    caseId: "case",
    groupId: "group",
    persona: "persona",
    v1CandidateIds: ["a"],
    shieldCandidateIds: ["a"],
    changedCandidates: 1,
    redactions: 1,
    decisionMode: "shielded" as const,
    v1ExactObsoleteContextAny: 1,
    shieldExactObsoleteContextAny: 0,
    v1CurrentAtomRecall: 1,
    shieldCurrentAtomRecall: 1,
    v1InjectedTokens: 10,
    shieldInjectedTokens: 9,
    ...overrides,
  };
}

describe("evidence shield feasibility summary", () => {
  it("advances a lower-exposure fixed-identity candidate", () => {
    const result = summarizeEvidenceShieldCases({
      cases: [item(), item({ caseId: "case-2", v1ExactObsoleteContextAny: 0 })],
      fallback: { disabledMismatches: 0, damagedMismatches: 0, timeoutMismatches: 0 },
    });
    expect(result.summary).toMatchObject({
      candidateIdMismatches: 0,
      exactObsoleteContextAnyRateReduction: 0.5,
      currentAtomRecallLoss: 0,
    });
    expect(result.summary.meanInjectedTokenIncreaseFraction).toBeCloseTo(-0.1);
    expect(result.gate.passed).toBe(true);
  });

  it("rejects exposure-neutral or harmful candidates", () => {
    const result = summarizeEvidenceShieldCases({
      cases: [item({
        shieldExactObsoleteContextAny: 1,
        shieldCurrentAtomRecall: 0.5,
        shieldInjectedTokens: 11,
      })],
      fallback: { disabledMismatches: 0, damagedMismatches: 0, timeoutMismatches: 0 },
    });
    expect(result.gate.passed).toBe(false);
    expect(result.gate.failedChecks).toEqual([
      "exactObsoleteContextAnyRateReduction",
      "currentAtomRecall",
      "tokenBudget",
    ]);
  });
});
