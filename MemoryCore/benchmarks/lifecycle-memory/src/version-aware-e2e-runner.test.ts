import { describe, expect, it } from "vitest";
import {
  aggregateArm,
  clusteredBootstrap,
  crossedMean,
  type VersionAwarePanelCase,
} from "./version-aware-e2e-runner.js";

function metrics(value: number) {
  return { mpa: value, faa: 1, fama: value, criterionAccuracy: value };
}

function panelCase(groupId: string, globalValue: number, dualValue: number, candidateValue: number): VersionAwarePanelCase {
  const arm = (value: number, exactSelection: number) => ({
    metrics: metrics(value),
    cells: { "minimax-m3": metrics(value), "deepseek-v4-flash": metrics(value) },
    contextMetrics: { exactSelection, expectedStateRecall: exactSelection, contaminationRate: 1 - exactSelection },
    contextHash: `${groupId}-${value}`,
    recalledMemoryIds: exactSelection ? ["expected"] : ["foreign"],
    injectedTokens: 100,
    recallMs: 1,
  });
  return {
    caseId: `${groupId}-case`,
    panel: "version_capability",
    slice: "branch_current",
    groupId,
    persona: groupId,
    task: "branch_current",
    expectedMemoryIds: ["expected"],
    arms: {
      global_latest: arm(globalValue, 0),
      old_current_dual: arm(dualValue, 0),
      version_aware_multistate: arm(candidateValue, 1),
    },
  };
}

describe("version-aware E2E aggregation", () => {
  it("averages exactly two crossed reader/judge cells", () => {
    expect(crossedMean([metrics(0.4), metrics(0.8)])).toEqual({
      mpa: 0.6000000000000001,
      faa: 1,
      fama: 0.6000000000000001,
      criterionAccuracy: 0.6000000000000001,
    });
  });

  it("reports answer and context metrics independently", () => {
    const cases = [panelCase("a", 0.4, 0.5, 0.8), panelCase("b", 0.6, 0.7, 1)];
    const aggregate = aggregateArm(cases, "version_aware_multistate");
    expect(aggregate.criterionAccuracy).toBeCloseTo(0.9, 12);
    expect(aggregate.exactSelectionAccuracy).toBe(1);
    expect(aggregate.contaminationRate).toBe(0);
  });

  it("uses paired scenario clusters for uncertainty", () => {
    const cases = [panelCase("a", 0.4, 0.5, 0.8), panelCase("b", 0.6, 0.7, 1)];
    const interval = clusteredBootstrap({
      cases,
      left: "version_aware_multistate",
      right: "global_latest",
      metric: "criterionAccuracy",
      seed: 7,
    });
    expect(interval.mean).toBeCloseTo(0.4, 12);
    expect(interval.clusters).toBe(2);
    expect(interval.lower).toBeGreaterThan(0);
  });
});
