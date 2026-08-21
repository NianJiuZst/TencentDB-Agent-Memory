import { describe, expect, it } from "vitest";
import { evaluateShieldAnswerGate } from "./evidence-shield-e2e-runner.js";

function interval(mean: number) {
  return { mean, lower: mean - 0.01, upper: mean + 0.01, clusters: 10 };
}

describe("evidence shield answer gate", () => {
  it("qualifies a lower-cost, forgetting-improving candidate", () => {
    const result = evaluateShieldAnswerGate({
      shieldVsV1: {
        mpa: interval(-0.005),
        faa: interval(0.03),
        fama: interval(0.02),
        criterionAccuracy: interval(0.01),
      },
      v1MeanInjectedTokens: 146,
      shieldMeanInjectedTokens: 140,
      perReaderFamaDelta: { minimax: 0.01, deepseek: 0.03 },
    });
    expect(result.passed).toBe(true);
  });

  it("rejects an aggregate gain that harms one reader", () => {
    const result = evaluateShieldAnswerGate({
      shieldVsV1: {
        mpa: interval(0),
        faa: interval(0.02),
        fama: interval(0.01),
        criterionAccuracy: interval(0.01),
      },
      v1MeanInjectedTokens: 146,
      shieldMeanInjectedTokens: 140,
      perReaderFamaDelta: { minimax: -0.001, deepseek: 0.021 },
    });
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(["perReaderFamaDirection"]);
  });
});
