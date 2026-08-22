import { describe, expect, it } from "vitest";
import {
  evaluatePremiseEvidenceAnswerGate,
  extractLongMemEvalBoxedAnswer,
  parseLongMemEvalBinaryJudgment,
} from "./longmemeval-v2-premise-evidence-answer-runner.js";

describe("LongMemEval-V2 premise-evidence answer panel", () => {
  it("matches the official nested boxed-answer extraction", () => {
    expect(extractLongMemEvalBoxedAnswer("analysis \\boxed{no item between {A} and B}"))
      .toBe("no item between {A} and B");
    expect(extractLongMemEvalBoxedAnswer("UNKNOWN")).toBe("UNKNOWN");
  });

  it("parses strict and fenced binary judgments", () => {
    expect(parseLongMemEvalBinaryJudgment('{"label":1,"reason":"corrected"}')).toEqual({
      label: 1, reason: "corrected",
    });
    expect(parseLongMemEvalBinaryJudgment("```json\n{\"label\": 0, \"reason\": \"followed premise\"}\n```"))
      .toEqual({ label: 0, reason: "followed premise" });
  });

  it("requires an improvement with no harm", () => {
    const base = {
      actualReaderCalls: 8, actualJudgeCalls: 16, modelMismatches: 0,
      primaryImprovedReaderPairs: 1, primaryHarmedReaderPairs: 0,
      unanimousImprovedReaderPairs: 1, anyJudgeHarmedReaderPairs: 0,
      perReaderPopulationWeightedDelta: { a: 1 / 58, b: 0 },
      fullFactorialPopulationWeightedDelta: 1 / 232,
    };
    expect(evaluatePremiseEvidenceAnswerGate(base).passed).toBe(true);
    expect(evaluatePremiseEvidenceAnswerGate({
      ...base, primaryHarmedReaderPairs: 1, anyJudgeHarmedReaderPairs: 1,
    }).passed).toBe(false);
  });
});
