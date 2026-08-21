import { describe, expect, it } from "vitest";
import { crossModelMean } from "./contextual-e2e-runner.js";

describe("contextual E2E crossed aggregation", () => {
  it("uses only the other model's judgment for each reader", () => {
    const metrics = (fama: number) => ({ mpa: fama, faa: 1, fama, criterionAccuracy: fama });
    const result = crossModelMean([
      { readerId: "a", judgeId: "a", metrics: metrics(0) },
      { readerId: "a", judgeId: "b", metrics: metrics(0.6) },
      { readerId: "b", judgeId: "a", metrics: metrics(0.8) },
      { readerId: "b", judgeId: "b", metrics: metrics(0) },
    ]);

    expect(result.fama).toBeCloseTo(0.7);
    expect(result.mpa).toBeCloseTo(0.7);
  });

  it("rejects an incomplete crossed matrix", () => {
    expect(() => crossModelMean([
      {
        readerId: "a",
        judgeId: "b",
        metrics: { mpa: 1, faa: 1, fama: 1, criterionAccuracy: 1 },
      },
    ])).toThrow("one non-self judge per reader");
  });
});
