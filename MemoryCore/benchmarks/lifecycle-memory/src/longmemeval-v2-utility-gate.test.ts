import { describe, expect, it } from "vitest";
import type { PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import {
  learnTransitionUtility,
  selectUtilityGatedContext,
  type TransitionUtilityTable,
} from "./longmemeval-v2-utility-gate.js";
import type { RetrievedUnit } from "./types.js";

function item(id: string, tokenCount: number): RetrievedUnit {
  return {
    id,
    sessionId: "session",
    role: "assistant",
    content: `content for ${id}`,
    timestampMs: 0,
    sequence: 0,
    score: 1,
    tokenCount,
  };
}

const rawA = item("lmev2:raw:trajectory-a:1:0", 40);
const rawB = item("lmev2:raw:trajectory-a:2:0", 40);
const baseline: PackedLongTaskContext = {
  items: [rawA, rawB],
  injectedTokens: 80,
  tokenViolation: false,
};

describe("LongMemEval-V2 utility gate", () => {
  it("learns bounded per-memory utility and rejects any observed harm", () => {
    const table = learnTransitionUtility({
      capacity: 4,
      feedback: [
        { questionId: "q1", transitionIds: ["lmev2:transition:a:1:2:0"], reward: 1 },
        { questionId: "q2", transitionIds: ["lmev2:transition:a:1:2:0"], reward: 0 },
        { questionId: "q3", transitionIds: ["lmev2:transition:b:1:2:0"], reward: 1 },
        { questionId: "q4", transitionIds: ["lmev2:transition:b:1:2:0"], reward: -0.5 },
      ],
    });
    expect(table.sourceQuestions).toBe(4);
    expect(table.feedbackEvents).toBe(4);
    expect(table.entries).toEqual([
      expect.objectContaining({ memoryId: "lmev2:transition:a:1:2:0", meanUtility: 0.5, eligible: true }),
      expect.objectContaining({ memoryId: "lmev2:transition:b:1:2:0", meanUtility: 0.25, eligible: false }),
    ]);
  });

  it("chooses a coherent positive-utility transition under the baseline token cost", () => {
    const coherent = item("lmev2:transition:trajectory-a:2:3:0", 25);
    const incoherent = item("lmev2:transition:trajectory-b:2:3:0", 20);
    const table: TransitionUtilityTable = {
      capacity: 4,
      sourceQuestions: 2,
      feedbackEvents: 2,
      entries: [
        {
          memoryId: incoherent.id,
          visits: 1,
          rewardSum: 1,
          meanUtility: 1,
          minReward: 1,
          negativeVisits: 0,
          eligible: true,
        },
        {
          memoryId: coherent.id,
          visits: 1,
          rewardSum: 0.5,
          meanUtility: 0.5,
          minReward: 0.5,
          negativeVisits: 0,
          eligible: true,
        },
      ],
    };
    const selected = selectUtilityGatedContext({
      baseline,
      rawCandidates: [rawA, rawB],
      transitionCandidates: [incoherent, coherent],
      utilityTable: table,
      tokenBudget: 100,
      resultLimit: 3,
      candidateLimit: 20,
      maxUtilityItems: 1,
    });
    expect(selected.mode).toBe("utility_gated");
    expect(selected.transitionIds).toEqual([coherent.id]);
    expect(selected.injectedTokens).toBe(65);
    expect(selected.consideredUtilityIds).toEqual([coherent.id]);
  });

  it("takes the null action when no coherent candidate beats baseline cost", () => {
    const expensive = item("lmev2:transition:trajectory-a:2:3:0", 75);
    const table = learnTransitionUtility({
      capacity: 4,
      feedback: [{ questionId: "q1", transitionIds: [expensive.id], reward: 1 }],
    });
    const selected = selectUtilityGatedContext({
      baseline,
      rawCandidates: [rawA, rawB],
      transitionCandidates: [expensive],
      utilityTable: table,
      tokenBudget: 120,
      resultLimit: 3,
      candidateLimit: 20,
      maxUtilityItems: 1,
    });
    expect(selected.mode).toBe("baseline_noop");
    expect(selected.nullReason).toBe("no_cost_certified_candidate");
    expect(selected.items.map((value) => value.id)).toEqual(baseline.items.map((value) => value.id));
  });

  it.each([
    ["disabled", { enabled: false }],
    ["missing_utility_table", { utilityTable: null }],
    ["sidecar_timeout", { timedOut: true }],
    ["corrupt_utility_or_transition", { forceCorrupt: true }],
  ])("returns exact baseline on forced %s failure", (reason, override) => {
    const transition = item("lmev2:transition:trajectory-a:2:3:0", 20);
    const table = learnTransitionUtility({
      capacity: 4,
      feedback: [{ questionId: "q1", transitionIds: [transition.id], reward: 1 }],
    });
    const selected = selectUtilityGatedContext({
      baseline,
      rawCandidates: [rawA, rawB],
      transitionCandidates: [transition],
      utilityTable: table,
      tokenBudget: 100,
      resultLimit: 3,
      candidateLimit: 20,
      maxUtilityItems: 1,
      ...override,
    });
    expect(selected.fallbackReason).toBe(reason);
    expect(selected.items).toEqual(baseline.items);
    expect(selected.injectedTokens).toBe(baseline.injectedTokens);
  });
});
