import { describe, expect, it } from "vitest";
import { evaluateValidStatePackingAnswerGate } from "./valid-state-packing-e2e-runner.js";

function interval(mean: number, lower = mean - 0.01) {
  return { mean, lower, upper: mean + 0.01, clusters: 10 };
}

function passingInput() {
  return {
    callCounts: { reader: 142, judge: 284, finalRows: 200 },
    comparison: {
      mpa: interval(0.01),
      faa: interval(-0.004),
      fama: interval(0.02, 0.001),
      criterionAccuracy: interval(0.005),
    },
    modelMismatches: 0,
    noopClones: 58,
    noopMismatches: 0,
    perReaderFamaDelta: { minimax: 0.01, deepseek: 0.03 },
    tokens: { v1: 121.54, candidate: 117.56 },
  };
}

describe("valid-state packing answer gate", () => {
  it("qualifies a complete, lower-cost, cross-reader improvement", () => {
    expect(evaluateValidStatePackingAnswerGate(passingInput())).toMatchObject({
      passed: true,
      failedChecks: [],
    });
  });

  it("rejects an incomplete API panel", () => {
    const input = passingInput();
    input.callCounts.reader -= 1;
    expect(evaluateValidStatePackingAnswerGate(input)).toMatchObject({
      passed: false,
      failedChecks: ["completeExecution"],
    });
  });

  it("rejects a missing exact no-op clone", () => {
    const input = passingInput();
    input.noopClones -= 1;
    expect(evaluateValidStatePackingAnswerGate(input)).toMatchObject({
      passed: false,
      failedChecks: ["exactNoopClones"],
    });
  });
});
