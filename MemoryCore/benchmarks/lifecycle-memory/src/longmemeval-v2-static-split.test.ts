import { describe, expect, it } from "vitest";
import {
  buildLongMemEvalV2StaticQuestionSplit,
  type LongMemEvalV2StaticQuestionMetadata,
} from "./longmemeval-v2-static-split.js";

function rows(params: {
  domain: string;
  environment: string;
  family: "direct_phrase" | "multiple_choice";
  count: number;
}): LongMemEvalV2StaticQuestionMetadata[] {
  return Array.from({ length: params.count }, (_, index) => ({
    id: `${params.domain}-${params.environment}-${params.family}-${index}`,
    domain: params.domain,
    environment: params.environment,
    memoryAbility: "static-environment",
    evaluator: params.family === "direct_phrase"
      ? "norm_phrase_set_match|lower=true"
      : "mc_choice_match|require_non_empty=true",
    imagePath: null,
  }));
}

function fixture(): LongMemEvalV2StaticQuestionMetadata[] {
  return [
    ...rows({ domain: "enterprise", environment: "workarena", family: "direct_phrase", count: 74 }),
    ...rows({ domain: "web", environment: "webarena", family: "direct_phrase", count: 47 }),
    ...rows({ domain: "web", environment: "webarena", family: "multiple_choice", count: 13 }),
    {
      id: "excluded-dynamic",
      domain: "web",
      environment: "webarena",
      memoryAbility: "dynamic-environment",
      evaluator: "norm_phrase_set_match|lower=true",
      imagePath: null,
    },
  ];
}

describe("LongMemEval-V2 static-environment question split", () => {
  it("creates a deterministic, disjoint 66/32/36 split before outcome access", () => {
    const split = buildLongMemEvalV2StaticQuestionSplit({
      questions: fixture(),
      revision: "revision",
      questionsSha256: "questions-sha",
      seed: "seed",
    });
    expect(split.counts.development.questions).toBe(66);
    expect(split.counts.validation.questions).toBe(32);
    expect(split.counts.test.questions).toBe(36);
    expect(split.counts.development.directProxyQuestions).toBe(60);
    expect(split.counts.validation.directProxyQuestions).toBe(29);
    expect(split.counts.test.directProxyQuestions).toBe(32);
    expect(split.counts.development.answerOnlyQuestions).toBe(6);
    expect(split.counts.validation.answerOnlyQuestions).toBe(3);
    expect(split.counts.test.answerOnlyQuestions).toBe(4);
    const all = [...split.development, ...split.validation, ...split.test];
    expect(all).toHaveLength(134);
    expect(new Set(all).size).toBe(134);
    expect(all).not.toContain("excluded-dynamic");
  });

  it("is invariant to input order and accepts both static multiple-choice evaluators", () => {
    const questions = fixture();
    questions[121] = { ...questions[121], evaluator: "mc_choice_set_match|lower=true" };
    const first = buildLongMemEvalV2StaticQuestionSplit({
      questions,
      revision: "revision",
      questionsSha256: "questions-sha",
      seed: "seed",
    });
    const second = buildLongMemEvalV2StaticQuestionSplit({
      questions: [...questions].reverse(),
      revision: "revision",
      questionsSha256: "questions-sha",
      seed: "seed",
    });
    expect(second).toEqual(first);
  });
});
