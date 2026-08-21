import { describe, expect, it } from "vitest";
import type { LongTaskState, LongTaskTrajectory } from "./long-task-adapter.js";
import { packLongTaskContext } from "./longmemeval-v2-baseline.js";
import {
  annotateTransitionAction,
  buildTransitionPolicyGrid,
  buildTransitionUnits,
  diffLongTaskStates,
  normalizeAxTreeLine,
  selectTransitionAugmentedContext,
} from "./longmemeval-v2-transition.js";
import type { RetrievedUnit } from "./types.js";

function state(index: number, observation: string, action: string | null = null): LongTaskState {
  return {
    id: `t1:${index}`,
    trajectoryId: "t1",
    index,
    sourceStep: index,
    url: `https://example.test/${index}`,
    observation,
    thought: null,
    transitionAction: action,
    screenshotPath: null,
  };
}

function candidate(id: string, content: string, tokenCount: number): RetrievedUnit {
  return {
    id,
    sessionId: "t1",
    role: "assistant",
    content,
    timestampMs: 0,
    sequence: 0,
    score: 1,
    tokenCount,
  };
}

describe("LongMemEval-V2 transition organization", () => {
  it("removes volatile AX node numbers while preserving visible state changes", () => {
    expect(normalizeAxTreeLine("  [a37] button 'Save', visible  ")).toBe("[a#] button 'Save', visible");
    const delta = diffLongTaskStates(
      state(0, "[12] button 'Save'\n[13] checkbox 'Active' checked='false'"),
      state(1, "[82] button 'Save'\n[83] checkbox 'Active' checked='true'"),
    );
    expect(delta).toEqual({
      added: ["[#] checkbox 'Active' checked='true'"],
      removed: ["[#] checkbox 'Active' checked='false'"],
    });
  });

  it("annotates destination-state actions with the pre-state target label", () => {
    const pre = state(0, "[12] button 'Save', clickable\n[13] textbox 'Name'");
    expect(annotateTransitionAction("click('12')", pre)).toBe("click('12') | target: button 'Save', clickable");
  });

  it("builds bounded pre/action/post units without using labels", () => {
    const trajectory: LongTaskTrajectory = {
      id: "t1",
      domain: "web",
      environment: "fixture",
      goal: "Enable the feature",
      outcome: "success",
      startUrl: "https://example.test/0",
      states: [
        state(0, "[12] checkbox 'Feature' checked='false'"),
        state(1, "[42] checkbox 'Feature' checked='true'", "click('12')"),
      ],
    };
    const result = buildTransitionUnits({
      trajectories: [trajectory],
      config: { maxCharacters: 60, maxChunksPerTransition: 2, maxAuxiliaryUnits: 2 },
    });
    expect(result.transitions).toBe(1);
    expect(result.units).toHaveLength(2);
    expect(result.units[0].id).toBe("lmev2:transition:t1:0:1:0");
    expect(result.units.map((unit) => unit.content).join("\n")).toContain("checked='true'");
    expect(result.units.map((unit) => unit.content).join("\n")).toContain("checked='false'");
  });

  it("samples both ends when a transition delta exceeds its unit cap", () => {
    const trajectory: LongTaskTrajectory = {
      id: "t1",
      domain: "web",
      environment: "fixture",
      goal: "Inspect a long page",
      outcome: "success",
      startUrl: "https://example.test/0",
      states: [
        state(0, "unchanged"),
        state(1, `${"A".repeat(40)}\n${"B".repeat(40)}\nTAIL_MARKER`, "scroll(0, 500)"),
      ],
    };
    const result = buildTransitionUnits({
      trajectories: [trajectory],
      config: { maxCharacters: 20, maxChunksPerTransition: 2, maxAuxiliaryUnits: 2 },
    });
    expect(result.truncatedTransitions).toBe(1);
    expect(result.units[0].content).toContain("ADDED:");
    expect(result.units[1].content).toContain("TAIL_MARKER");
  });

  it("enumerates the frozen Cartesian policy grid", () => {
    const grid = buildTransitionPolicyGrid({
      candidateLimits: [10, 20],
      tokenFractions: [0.25, 0.5, 0.75],
      maxItems: [1, 2, 4],
    });
    expect(grid).toHaveLength(18);
    expect(grid[0].id).toBe("tc10-tf25-mi1");
  });

  it("uses a shared token budget and hard-falls back exactly", () => {
    const rawCandidates = [
      candidate("lmev2:raw:t1:0:0", "raw a", 60),
      candidate("lmev2:raw:t1:0:1", "raw b", 30),
    ];
    const baseline = packLongTaskContext({ candidates: rawCandidates, tokenBudget: 100, resultLimit: 3 });
    const transitionCandidates = [candidate("lmev2:transition:t1:0:1:0", "change", 25)];
    const policy = {
      id: "tc10-tf25-mi1",
      transitionCandidateLimit: 10,
      transitionTokenFraction: 0.25,
      maxTransitionItems: 1,
    };
    const selected = selectTransitionAugmentedContext({
      baseline,
      rawCandidates,
      transitionCandidates,
      policy,
      tokenBudget: 100,
      resultLimit: 3,
    });
    expect(selected.transitionIds).toEqual(["lmev2:transition:t1:0:1:0"]);
    expect(selected.rawIds).toEqual(["lmev2:raw:t1:0:0"]);
    expect(selected.injectedTokens).toBe(85);
    for (const overrides of [
      { enabled: false },
      { auxiliaryIndexAvailable: false },
      { timedOut: true },
      { forceCorrupt: true },
    ]) {
      const fallback = selectTransitionAugmentedContext({
        baseline,
        rawCandidates,
        transitionCandidates,
        policy,
        tokenBudget: 100,
        resultLimit: 3,
        ...overrides,
      });
      expect(fallback.items.map((item) => item.id)).toEqual(baseline.items.map((item) => item.id));
      expect(fallback.injectedTokens).toBe(baseline.injectedTokens);
      expect(fallback.fallback).toBe(true);
    }
  });
});
