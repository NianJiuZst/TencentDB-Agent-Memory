import { describe, expect, it } from "vitest";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import type { PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import {
  selectPremiseEvidenceContext,
  type PremiseEvidenceContextPolicy,
} from "./longmemeval-v2-premise-evidence-context.js";
import {
  buildPremiseEvidenceIndex,
  type PremiseEvidenceConfig,
} from "./longmemeval-v2-premise-evidence.js";

const indexConfig: PremiseEvidenceConfig = {
  maxTrajectories: 10,
  maxStates: 20,
  maxInventories: 100,
  maxItemsPerInventory: 8,
  maxIndexKeys: 500,
  maxSupportsPerKey: 10,
  maxCapsuleCharacters: 1_200,
  minContextOverlap: 1,
  minDistinctTrajectories: 1,
  allowedInventoryKinds: ["columns"],
};

const policy: PremiseEvidenceContextPolicy = {
  enabled: true,
  maxCapsuleTokens: 128,
  maxCandidateItems: 7,
  maxCandidateTokens: 3_200,
  maxSelectionLatencyMs: 25,
};

const baseline: PackedLongTaskContext = {
  items: [{
    id: "base", sessionId: "base", role: "assistant", content: "base memory",
    timestampMs: 0, sequence: 0, score: 1, tokenCount: 20,
  }],
  injectedTokens: 20,
  tokenViolation: false,
};

function fixture(): { question: LongTaskQuestion; trajectory: LongTaskTrajectory } {
  return {
    question: {
      id: "q", domain: "web", environment: "fixture", memoryAbility: "hidden-at-runtime",
      prompt: "In the Search Terms Report, what is between `Store` and `Results`?",
      referenceAnswer: "must-not-be-read", evaluator: "must-not-be-read", imagePath: null,
      trajectoryIds: ["t1"],
    },
    trajectory: {
      id: "t1", domain: "web", environment: "fixture", goal: "Inspect Search Terms Report",
      outcome: "success", startUrl: "https://example.test/search",
      states: [{
        id: "t1:0", trajectoryId: "t1", index: 0, sourceStep: 0,
        url: "https://example.test/search", thought: null, transitionAction: null,
        screenshotPath: null,
        observation: [
          "RootWebArea 'Search Terms Report'",
          "\trow ''",
          "\t\tcolumnheader 'Store'",
          "\t\tcolumnheader 'Results'",
        ].join("\n"),
      }],
    },
  };
}

function selected(options: Partial<PremiseEvidenceContextPolicy> = {}, hooks = {}) {
  const value = fixture();
  const index = buildPremiseEvidenceIndex({ trajectories: [value.trajectory], config: indexConfig });
  return selectPremiseEvidenceContext({
    baseline,
    question: value.question,
    index,
    policy: { ...policy, ...options },
    testHooks: hooks,
  });
}

describe("LongMemEval-V2 premise-evidence context", () => {
  it("appends a bounded capsule after an exact Base prefix", () => {
    const result = selected();
    expect(result.mode).toBe("premise_evidence");
    expect(result.items[0]).toEqual(baseline.items[0]);
    expect(result.items).toHaveLength(2);
    expect(result.capsuleTokens).toBeGreaterThan(0);
    expect(result.sourceObservationSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.basePrefixViolations).toBe(0);
  });

  it("returns exact Base when disabled", () => {
    const result = selected({ enabled: false });
    expect(result.mode).toBe("fallback_baseline");
    expect(result.fallbackReason).toBe("disabled");
    expect(result.items).toEqual(baseline.items);
  });

  it("hard-falls back for timeout, selection error, and token overflow", () => {
    let tick = 0;
    const timeout = selected({}, { now: () => (tick++ === 0 ? 0 : 30) });
    const error = selected({}, { select: () => { throw new Error("forced"); } });
    const overflow = selected({}, { countTokens: () => 129 });
    expect(timeout.fallbackReason).toBe("selection_timeout");
    expect(error.fallbackReason).toBe("selection_error");
    expect(overflow.fallbackReason).toBe("capsule_token_overflow");
    for (const result of [timeout, error, overflow]) expect(result.items).toEqual(baseline.items);
  });

  it("hard-falls back for item and total-token overflow", () => {
    const itemOverflow = selected({ maxCandidateItems: 1 });
    const tokenOverflow = selected({ maxCandidateTokens: 20 });
    expect(itemOverflow.fallbackReason).toBe("candidate_item_overflow");
    expect(tokenOverflow.fallbackReason).toBe("candidate_token_overflow");
    expect(itemOverflow.items).toEqual(baseline.items);
    expect(tokenOverflow.items).toEqual(baseline.items);
  });
});
