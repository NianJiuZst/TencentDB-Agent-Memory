import { describe, expect, it } from "vitest";
import d12SplitJson from "../protocol.longmemeval-v2-static-question-split.v1.json" with { type: "json" };
import { buildLongMemEvalV2ResidualPatchSplit } from "./longmemeval-v2-residual-patch-split.js";

function question(id: string, domain: string, evaluator: string) {
  return {
    id,
    domain,
    environment: "environment",
    memoryAbility: "static-environment",
    evaluator,
    imagePath: null,
  };
}

describe("D13 residual-patch split", () => {
  it("partitions exactly the frozen D12-unread population", () => {
    const unread = [...d12SplitJson.validation, ...d12SplitJson.test];
    const questions = unread.map((id, index) => question(
      id,
      index % 2 === 0 ? "enterprise" : "web",
      index % 5 === 0 ? "mc_choice_match|x" : "norm_phrase_set_match",
    ));
    const split = buildLongMemEvalV2ResidualPatchSplit({
      questions,
      revision: "revision",
      questionsSha256: "questions",
      seed: "seed",
    });
    const assigned = [...split.development, ...split.validation, ...split.test];
    expect(new Set(assigned)).toEqual(new Set(unread));
    expect(assigned).toHaveLength(unread.length);
    expect(assigned.some((id) => d12SplitJson.development.includes(id))).toBe(false);
    expect(split.canonicalSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is deterministic for the same seed", () => {
    const unread = [...d12SplitJson.validation, ...d12SplitJson.test];
    const questions = unread.map((id, index) => question(
      id,
      index % 2 === 0 ? "enterprise" : "web",
      index % 5 === 0 ? "mc_choice_match|x" : "norm_phrase_set_match",
    ));
    const params = { questions, revision: "revision", questionsSha256: "questions", seed: "seed" };
    expect(buildLongMemEvalV2ResidualPatchSplit(params)).toEqual(
      buildLongMemEvalV2ResidualPatchSplit(params),
    );
  });
});
