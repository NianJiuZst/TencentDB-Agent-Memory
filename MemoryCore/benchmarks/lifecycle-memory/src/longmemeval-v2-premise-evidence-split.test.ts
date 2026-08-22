import { describe, expect, it } from "vitest";
import {
  buildLongMemEvalV2PremiseEvidenceSplit,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SMOKE,
  type LongMemEvalV2PremiseEvidenceQuestionMetadata,
} from "./longmemeval-v2-premise-evidence-split.js";

function question(params: Partial<LongMemEvalV2PremiseEvidenceQuestionMetadata>
  & Pick<LongMemEvalV2PremiseEvidenceQuestionMetadata, "id">): LongMemEvalV2PremiseEvidenceQuestionMetadata {
  return {
    domain: "enterprise",
    environment: "workarena",
    memoryAbility: "static-environment-abs",
    evaluator: "llm_abstention_checker|require_non_empty=true",
    imagePath: null,
    ...params,
  };
}

function fixture() {
  const smoke = LONGMEMEVAL_V2_PREMISE_EVIDENCE_SMOKE.map((item) => question({
    ...item,
    environment: item.domain === "enterprise" ? "workarena" : "webarena-reddit",
  }));
  const premise = ["static-environment-abs", "dynamic-environment-abs"].flatMap((ability) =>
    ["workarena", "webarena-reddit"].flatMap((environment) =>
      Array.from({ length: 10 }, (_, index) => question({
        id: `${ability}-${environment}-${index}`,
        domain: environment === "workarena" ? "enterprise" : "web",
        environment,
        memoryAbility: ability,
      }))));
  const controls = Array.from({ length: 9 }, (_, index) => question({
    id: `control-${index}`,
    memoryAbility: "static-environment",
    evaluator: "norm_phrase_set_match|separators=,;",
  }));
  return { smoke, premise, controls };
}

describe("LongMemEval-V2 premise-evidence split", () => {
  it("is deterministic, disjoint, metadata-only, and preserves the control phases", () => {
    const { smoke, premise, controls } = fixture();
    const params = {
      questions: [...smoke, ...premise, ...controls],
      revision: "revision",
      questionsSha256: "a".repeat(64),
      seed: "seed",
      controlSource: {
        protocolVersion: "control-v1",
        canonicalSha256: "b".repeat(64),
        development: controls.slice(0, 3).map((item) => item.id),
        validation: controls.slice(3, 6).map((item) => item.id),
        test: controls.slice(6).map((item) => item.id),
      },
    };
    const first = buildLongMemEvalV2PremiseEvidenceSplit(params);
    const second = buildLongMemEvalV2PremiseEvidenceSplit(params);
    expect(first).toEqual(second);
    expect(first.counts.development.premiseQuestions).toBe(16);
    expect(first.counts.validation.premiseQuestions).toBe(12);
    expect(first.counts.test.premiseQuestions).toBe(12);
    expect(first.controls.development).toEqual(["control-0", "control-1", "control-2"]);
    expect(new Set(Object.values(first.premise).flat()).size).toBe(40);
    expect(Object.values(first.premise).flat()).not.toEqual(
      expect.arrayContaining(smoke.map((item) => item.id)),
    );
  });

  it("rejects a control that is not an answerable static question", () => {
    const { smoke, premise, controls } = fixture();
    const badControl = question({
      id: "bad-control",
      memoryAbility: "procedure",
      evaluator: "norm_phrase_set_match|separators=,;",
    });
    expect(() => buildLongMemEvalV2PremiseEvidenceSplit({
      questions: [...smoke, ...premise, ...controls, badControl],
      revision: "revision",
      questionsSha256: "a".repeat(64),
      seed: "seed",
      controlSource: {
        protocolVersion: "control-v1",
        canonicalSha256: "b".repeat(64),
        development: [badControl.id],
        validation: [],
        test: [],
      },
    })).toThrow(/control metadata mismatch/u);
  });
});
