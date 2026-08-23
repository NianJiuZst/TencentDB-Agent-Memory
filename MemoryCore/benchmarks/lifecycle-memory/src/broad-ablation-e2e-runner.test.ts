import { describe, expect, it } from "vitest";
import { crossedCaseMean } from "./broad-ablation-e2e-runner.js";

describe("D16 crossed answer aggregation", () => {
  it("defines FAMA as the mean of the two crossed reader-judge cells", () => {
    expect(crossedCaseMean([
      { mpa: 0.5, faa: 1, fama: 0.5, criterionAccuracy: 0.75 },
      { mpa: 1, faa: 0.5, fama: 0.75, criterionAccuracy: 0.8 },
    ])).toEqual({
      mpa: 0.75,
      faa: 0.75,
      fama: 0.625,
      criterionAccuracy: 0.775,
    });
  });

  it("rejects partial crossed cells", () => {
    expect(() => crossedCaseMean([
      { mpa: 1, faa: 1, fama: 1, criterionAccuracy: 1 },
    ])).toThrow("expected two crossed cells");
  });
});
