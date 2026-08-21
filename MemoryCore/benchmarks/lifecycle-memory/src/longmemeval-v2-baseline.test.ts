import { describe, expect, it } from "vitest";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import {
  answerAtomsForQuestion,
  buildRawStateUnits,
  chunkLongTaskText,
  packLongTaskContext,
  sanitizeLongTaskQuery,
  scoreDirectAnswerSupport,
} from "./longmemeval-v2-baseline.js";

const config = { maxCharacters: 10, overlapCharacters: 2, maxChunksPerState: 3 };

describe("LongMemEval-V2 raw-state baseline", () => {
  it("builds bounded overlapping chunks with stable ids", () => {
    expect(chunkLongTaskText("abcdefghijklmnopqrstuvwxyz", config)).toEqual([
      "abcdefghij",
      "ijklmnopqr",
      "qrstuvwxyz",
    ]);
    const trajectory: LongTaskTrajectory = {
      id: "t1",
      domain: "web",
      environment: "fixture",
      goal: "Inspect settings",
      outcome: "success",
      startUrl: "https://example.test",
      states: [{
        id: "t1:0",
        trajectoryId: "t1",
        index: 0,
        sourceStep: 0,
        url: "https://example.test",
        observation: "abcdefghijklmnopqrstuvwxyz012345",
        thought: null,
        transitionAction: null,
        screenshotPath: null,
      }],
    };
    const index = buildRawStateUnits({ trajectories: [trajectory], config });
    expect(index.units.map((unit) => unit.id)).toEqual([
      "lmev2:raw:t1:0:0",
      "lmev2:raw:t1:0:1",
      "lmev2:raw:t1:0:2",
    ]);
    expect(index.truncatedStates).toBe(1);
  });

  it("packs ranked candidates without exceeding item or token budgets", () => {
    const candidate = (id: string, tokenCount: number) => ({
      id,
      sessionId: "s",
      role: "assistant" as const,
      content: id,
      timestampMs: 0,
      sequence: 0,
      score: 1,
      tokenCount,
    });
    const packed = packLongTaskContext({
      candidates: [candidate("too-large", 11), candidate("a", 4), candidate("b", 5), candidate("c", 1)],
      tokenBudget: 10,
      resultLimit: 2,
    });
    expect(packed.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(packed.injectedTokens).toBe(9);
    expect(packed.tokenViolation).toBe(false);
  });

  it("scores official phrase separators after normalization and ignores MC labels", () => {
    const question: LongTaskQuestion = {
      id: "q1",
      domain: "web",
      environment: "fixture",
      memoryAbility: "dynamic-environment",
      prompt: "What changed?\n\nMark your final answer in \\boxed{}.",
      referenceAnswer: "Incident-Mobile; My Open Incidents",
      evaluator: "norm_phrase_set_match_ordered|lower=true|normalize_hyphen=true|strip_punct=true|separators=;|require_non_empty=true",
      imagePath: null,
      trajectoryIds: ["t1"],
    };
    expect(sanitizeLongTaskQuery(question.prompt)).toBe("What changed?");
    expect(answerAtomsForQuestion(question)).toEqual(["incident mobile", "my open incidents"]);
    expect(scoreDirectAnswerSupport(question, [{ content: "Options: Incident Mobile and something else" }])).toMatchObject({
      supportedAtomCount: 1,
      answerAtomSupportRecall: 0.5,
      anyAnswerAtomSupported: 1,
      allAnswerAtomsSupported: 0,
    });
    expect(answerAtomsForQuestion({ ...question, evaluator: "mc_choice_match|require_non_empty=true" })).toBeNull();
  });
});
