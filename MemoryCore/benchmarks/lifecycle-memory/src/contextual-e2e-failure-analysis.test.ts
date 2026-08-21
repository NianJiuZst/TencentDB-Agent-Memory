import { describe, expect, it } from "vitest";
import {
  containsNormalizedValue,
  summarizeForgettingTransitions,
} from "./contextual-e2e-failure-analysis.js";

describe("contextual E2E failure analysis", () => {
  it("matches obsolete values across case and punctuation differences", () => {
    expect(containsNormalizedValue("You no longer enjoy Period Pieces.", "period pieces")).toBe(true);
    expect(containsNormalizedValue("You prefer comedies.", "period pieces")).toBe(false);
  });

  it("reports directional forgetting transitions", () => {
    expect(summarizeForgettingTransitions(
      [
        { id: "a", correct: true },
        { id: "b", correct: false },
        { id: "c", correct: true },
      ],
      [
        { id: "a", correct: false },
        { id: "b", correct: true },
        { id: "c", correct: true },
      ],
    )).toEqual({
      total: 3,
      sameCorrect: 1,
      sameWrong: 0,
      incumbentCorrectChallengerWrong: 1,
      incumbentWrongChallengerCorrect: 1,
      netCorrectDelta: 0,
    });
  });
});
