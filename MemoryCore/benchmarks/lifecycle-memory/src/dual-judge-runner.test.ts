import { describe, expect, it } from "vitest";
import type { CriterionVerdict } from "./e2e-runner.js";
import { buildTwoJudgePanel } from "./dual-judge-runner.js";

const criteria = [
  {
    id: "present",
    question: "Is the active fact present?",
    expectedAnswer: "yes" as const,
    type: "memory_presence" as const,
  },
  {
    id: "forgotten",
    question: "Is the obsolete fact present?",
    expectedAnswer: "no" as const,
    type: "forgetting_absence" as const,
  },
];

function verdicts(answers: Array<"yes" | "no" | "unclear">): CriterionVerdict[] {
  return criteria.map((criterion, index) => ({
    id: criterion.id,
    answer: answers[index],
    confidence: 0.8,
    expectedAnswer: criterion.expectedAnswer,
    type: criterion.type,
    correct: answers[index] === criterion.expectedAnswer,
  }));
}

describe("two-judge lifecycle panel", () => {
  it("uses an equal-weight metric average without inventing a tiebreaker", () => {
    const panel = buildTwoJudgePanel(criteria, [
      verdicts(["yes", "no"]),
      verdicts(["no", "no"]),
    ]);

    expect(panel.metrics).toEqual({ mpa: 0.5, faa: 1, fama: 0.5, criterionAccuracy: 0.75 });
    expect(panel.agreementCount).toBe(1);
    expect(panel.criterionCount).toBe(2);
  });

  it("marks a disagreement unclear only in the unanimous sensitivity analysis", () => {
    const panel = buildTwoJudgePanel(criteria, [
      verdicts(["yes", "no"]),
      verdicts(["no", "no"]),
    ]);

    expect(panel.unanimousVerdicts.map((item) => item.answer)).toEqual(["unclear", "no"]);
    expect(panel.unanimousMetrics).toEqual({ mpa: 0, faa: 1, fama: 0, criterionAccuracy: 0.5 });
  });

  it("rejects a panel with the wrong number of judges", () => {
    expect(() => buildTwoJudgePanel(criteria, [verdicts(["yes", "no"])]))
      .toThrow("exactly two");
  });
});
