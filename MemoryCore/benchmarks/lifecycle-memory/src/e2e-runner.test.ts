import { describe, expect, it } from "vitest";
import { parseJudge } from "./e2e-runner.js";

describe("lifecycle E2E judge parsing", () => {
  it("conservatively scores a non-binary answer as unclear and incorrect", () => {
    const verdicts = parseJudge(JSON.stringify({
      results: [{ id: "criterion-1", answer: "maybe", confidence: 0.4 }],
    }), [{
      id: "criterion-1",
      question: "Does the response contain the active fact?",
      expectedAnswer: "yes",
      type: "memory_presence",
    }]);

    expect(verdicts).toEqual([{
      id: "criterion-1",
      answer: "unclear",
      confidence: 0.4,
      expectedAnswer: "yes",
      type: "memory_presence",
      correct: false,
    }]);
  });

  it("conservatively scores an omitted criterion as unclear and incorrect", () => {
    const verdicts = parseJudge('{"results":[]}', [{
      id: "missing",
      question: "Does the response contain the active fact?",
      expectedAnswer: "yes",
      type: "memory_presence",
    }]);
    expect(verdicts[0]).toMatchObject({ answer: "unclear", confidence: 0, correct: false });
  });

  it("maps duplicate criterion ids to unclear instead of choosing one", () => {
    const verdicts = parseJudge(JSON.stringify({
      results: [
        { id: "criterion-1", answer: "yes", confidence: 0.9 },
        { id: "criterion-1", answer: "no", confidence: 0.8 },
      ],
    }), [{
      id: "criterion-1",
      question: "Does the response contain the active fact?",
      expectedAnswer: "yes",
      type: "memory_presence",
    }]);

    expect(verdicts[0]).toMatchObject({ answer: "unclear", confidence: 0, correct: false });
  });

  it("extracts JSON after a separated reasoning block", () => {
    const verdicts = parseJudge(
      '<think>private reasoning</think>\nResult: {"results":[{"id":"criterion-1","answer":"yes","confidence":0.7}]}',
      [{
        id: "criterion-1",
        question: "Does the response contain the active fact?",
        expectedAnswer: "yes",
        type: "memory_presence",
      }],
    );

    expect(verdicts[0]).toMatchObject({ answer: "yes", confidence: 0.7, correct: true });
  });
});
