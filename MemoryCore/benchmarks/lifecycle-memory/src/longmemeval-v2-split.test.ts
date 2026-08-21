import { describe, expect, it } from "vitest";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { buildLongMemEvalV2QuestionSplit } from "./longmemeval-v2-split.js";

function question(index: number, domain: string, evaluator: string): LongTaskQuestion {
  return {
    id: `q${String(index).padStart(3, "0")}`,
    domain,
    environment: "fixture",
    memoryAbility: "dynamic-environment",
    prompt: `Question ${index}`,
    referenceAnswer: `Answer ${index}`,
    evaluator,
    imagePath: null,
    trajectoryIds: [domain],
  };
}

describe("LongMemEval-V2 question split", () => {
  it("is deterministic, disjoint, and stratified without reading outcomes", () => {
    const questions = [
      ...Array.from({ length: 20 }, (_, index) => question(index, "enterprise", "norm_phrase_set_match|x")),
      ...Array.from({ length: 12 }, (_, index) => question(index + 20, "web", "mc_choice_match|x")),
    ];
    const first = buildLongMemEvalV2QuestionSplit({ questions, seed: 7 });
    const second = buildLongMemEvalV2QuestionSplit({ questions, seed: 7 });
    expect(first).toEqual(second);
    expect(first.counts.development.questions).toBe(16);
    expect(first.counts.validation.questions).toBe(8);
    expect(first.counts.test.questions).toBe(8);
    expect(new Set([...first.development, ...first.validation, ...first.test]).size).toBe(32);
    expect(first.counts.development.byEvaluatorFamily).toEqual({ phrase: 10, multiple_choice: 6 });
  });

  it("excludes abstention, static, and image-bearing questions", () => {
    const eligible = question(0, "web", "norm_phrase_set_match|x");
    const abstention = { ...question(1, "web", "norm_phrase_set_match|x"), memoryAbility: "dynamic-environment-abs" };
    const image = { ...question(2, "web", "norm_phrase_set_match|x"), imagePath: "q2.png" };
    const split = buildLongMemEvalV2QuestionSplit({ questions: [eligible, abstention, image], seed: 7 });
    expect([...split.development, ...split.validation, ...split.test]).toEqual(["q000"]);
  });
});
