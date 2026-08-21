import { describe, expect, it } from "vitest";
import {
  enumerateRiskPolicies,
  fitCrossFittedRouter,
  routeRiskCase,
  type RiskRouterCase,
} from "./evidence-risk-router-runner.js";

function metrics(fama: number, faa = 0.8) {
  return { mpa: 0.4, faa, fama, criterionAccuracy: fama + 0.2 };
}

function syntheticCase(persona: string, index: number, redactions: number): RiskRouterCase {
  const v1 = metrics(0.3);
  const shield = redactions ? metrics(0.4, 0.9) : v1;
  return {
    caseId: `${persona}:${index}`,
    persona,
    features: {
      redactionCount: redactions,
      changedCandidateCount: redactions,
      redactionDensity: redactions / 5,
      tokenSavingsFraction: 0.1,
    },
    tokens: { v1: 100, shield: 90 },
    primary: { v1, shield },
    readerMetrics: {
      readerA: { v1, shield },
      readerB: { v1, shield },
    },
  };
}

describe("evidence-risk router", () => {
  it("enumerates only the frozen 32-policy class", () => {
    const policies = enumerateRiskPolicies();
    expect(policies).toHaveLength(32);
    expect(new Set(policies.map((policy) => policy.id)).size).toBe(32);
  });

  it("cross-fits without exposing the held-out persona", () => {
    const cases = Array.from({ length: 10 }, (_, index) => `persona-${index}`).flatMap(
      (persona) => [syntheticCase(persona, 0, 0), syntheticCase(persona, 1, 2)],
    );
    const folds = fitCrossFittedRouter(cases);
    expect(folds).toHaveLength(10);
    expect(folds.every((fold) => !fold.trainingPersonas.includes(fold.heldOutPersona))).toBe(true);
    expect(folds.every((fold) => fold.selectedPolicyId !== "always-v1")).toBe(true);
    expect(folds.flatMap((fold) => Object.values(fold.heldOutActions))).toContain("shield");
  });

  it("falls back to V1 when a feature is non-finite", () => {
    const item = syntheticCase("persona", 0, 1);
    item.features.redactionCount = Number.NaN;
    const policy = enumerateRiskPolicies().find((candidate) =>
      candidate.feature === "redactionCount" && candidate.comparator === "gte"
    )!;
    expect(routeRiskCase(item, policy)).toBe("v1");
  });
});
