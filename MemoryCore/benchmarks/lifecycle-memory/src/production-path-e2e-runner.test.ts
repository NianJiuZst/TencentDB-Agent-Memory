import { describe, expect, it } from "vitest";
import {
  aggregateArm,
  crossedMean,
  personaBootstrap,
  type ProductionPathPanelCase,
} from "./production-path-e2e-runner.js";

function metrics(value: number) {
  return { mpa: value, faa: value, fama: value, criterionAccuracy: value };
}

function panelCase(persona: string, baseline: number, final: number): ProductionPathPanelCase {
  const arm = (value: number) => ({
    metrics: metrics(value),
    cells: { a: metrics(value), b: metrics(value) },
    contextHash: String(value),
    recalledMemoryIds: [],
    injectedTokens: value * 100,
    pairCount: value,
  });
  return {
    caseId: `${persona}:${baseline}:${final}`,
    panel: "temporal_capability",
    persona,
    task: "temporal_history",
    queryIntent: "historical_state",
    arms: {
      current_only: arm(baseline),
      query_aware_dual: arm(final),
    },
  };
}

describe("production-path answer aggregation", () => {
  it("averages the two crossed reader cells", () => {
    expect(crossedMean([metrics(0), metrics(1)])).toEqual(metrics(0.5));
  });

  it("computes paired final-minus-baseline deltas with persona clusters", () => {
    const cases = [panelCase("a", 0.2, 0.8), panelCase("b", 0.4, 0.6)];
    const interval = personaBootstrap({ cases, metric: "criterionAccuracy", seed: 7 });
    expect(interval.mean).toBeCloseTo(0.4, 12);
    expect(interval.clusters).toBe(2);
    expect(interval.lower).toBeLessThanOrEqual(interval.mean);
    expect(interval.upper).toBeGreaterThanOrEqual(interval.mean);
    expect(aggregateArm(cases, "query_aware_dual").criterionAccuracy).toBeCloseTo(0.7, 12);
  });
});
