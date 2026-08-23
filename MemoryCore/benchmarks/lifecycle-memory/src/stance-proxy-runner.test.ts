import { describe, expect, it } from "vitest";
import { classifyObsoleteStance, kendallTauB } from "./stance-proxy-runner.js";

describe("D17 stance-aware proxy", () => {
  it("gives explicit historical labels priority over lexical negation", () => {
    expect(classifyObsoleteStance("[SUPERSEDED — historical evidence only] I no longer use REST"))
      .toBe("historical");
    expect(classifyObsoleteStance("I no longer use REST")).toBe("negated");
    expect(classifyObsoleteStance("I use REST")).toBe("affirmed");
  });

  it("computes Kendall tau-b with and without ties", () => {
    expect(kendallTauB([1, 2, 3], [1, 2, 3])).toBe(1);
    expect(kendallTauB([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(kendallTauB([1, 1, 2], [1, 2, 3])).toBeCloseTo(0.8164965809);
  });
});
