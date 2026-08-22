import { describe, expect, it } from "vitest";
import {
  buildLongMemEvalV2ProcedureQuestionSplit,
  type LongMemEvalV2ProcedureQuestionMetadata,
} from "./longmemeval-v2-procedure-split.js";

const evaluatorByFamily = {
  abstention: "llm_abstention_checker|require_non_empty=true",
  multiple_choice: "mc_choice_match|require_non_empty=true",
  ordered_phrase: "norm_phrase_set_match_ordered|lower=true",
  phrase: "norm_phrase_set_match|lower=true",
} as const;

function rows(params: {
  domain: string;
  type: "procedure" | "procedure-abs";
  family: keyof typeof evaluatorByFamily;
  count: number;
}): LongMemEvalV2ProcedureQuestionMetadata[] {
  return Array.from({ length: params.count }, (_, index) => ({
    id: `${params.domain}-${params.type}-${params.family}-${index}`,
    domain: params.domain,
    environment: `${params.domain}-environment`,
    memoryAbility: params.type,
    evaluator: evaluatorByFamily[params.family],
    imagePath: null,
  }));
}

function fixture(): LongMemEvalV2ProcedureQuestionMetadata[] {
  return [
    ...rows({ domain: "enterprise", type: "procedure", family: "multiple_choice", count: 24 }),
    ...rows({ domain: "enterprise", type: "procedure", family: "ordered_phrase", count: 3 }),
    ...rows({ domain: "enterprise", type: "procedure", family: "phrase", count: 5 }),
    ...rows({ domain: "enterprise", type: "procedure-abs", family: "abstention", count: 12 }),
    ...rows({ domain: "web", type: "procedure", family: "multiple_choice", count: 11 }),
    ...rows({ domain: "web", type: "procedure", family: "ordered_phrase", count: 12 }),
    ...rows({ domain: "web", type: "procedure", family: "phrase", count: 19 }),
    ...rows({ domain: "web", type: "procedure-abs", family: "abstention", count: 20 }),
    {
      id: "excluded-dynamic",
      domain: "web",
      environment: "web-environment",
      memoryAbility: "dynamic-environment",
      evaluator: evaluatorByFamily.phrase,
      imagePath: null,
    },
  ];
}

describe("LongMemEval-V2 procedure question split", () => {
  it("creates a deterministic, disjoint 51/25/30 split with every stratum represented", () => {
    const split = buildLongMemEvalV2ProcedureQuestionSplit({
      questions: fixture(),
      revision: "revision",
      questionsSha256: "questions-sha",
      seed: "seed",
    });
    expect(split.counts.development.questions).toBe(51);
    expect(split.counts.validation.questions).toBe(25);
    expect(split.counts.test.questions).toBe(30);
    expect(split.counts.development.procedureQuestions).toBe(35);
    expect(split.counts.validation.procedureQuestions).toBe(17);
    expect(split.counts.test.procedureQuestions).toBe(22);
    expect(split.counts.development.abstentionQuestions).toBe(16);
    expect(split.counts.validation.abstentionQuestions).toBe(8);
    expect(split.counts.test.abstentionQuestions).toBe(8);
    const all = [...split.development, ...split.validation, ...split.test];
    expect(all).toHaveLength(106);
    expect(new Set(all).size).toBe(106);
    expect(all).not.toContain("excluded-dynamic");
    for (const phase of ["development", "validation", "test"] as const) {
      expect(Object.values(split.counts[phase].byEvaluatorFamily).every((count) => count > 0))
        .toBe(true);
    }
  });

  it("is invariant to input order and rejects a mismatched abstention evaluator", () => {
    const questions = fixture();
    const first = buildLongMemEvalV2ProcedureQuestionSplit({
      questions,
      revision: "revision",
      questionsSha256: "questions-sha",
      seed: "seed",
    });
    const second = buildLongMemEvalV2ProcedureQuestionSplit({
      questions: [...questions].reverse(),
      revision: "revision",
      questionsSha256: "questions-sha",
      seed: "seed",
    });
    expect(second).toEqual(first);
    expect(() => buildLongMemEvalV2ProcedureQuestionSplit({
      questions: [{ ...questions[0], memoryAbility: "procedure-abs" }],
      revision: "revision",
      questionsSha256: "questions-sha",
      seed: "seed",
    })).toThrow(/must use the abstention evaluator/);
  });
});
