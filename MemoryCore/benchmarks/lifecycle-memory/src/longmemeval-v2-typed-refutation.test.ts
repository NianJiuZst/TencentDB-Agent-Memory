import { describe, expect, it } from "vitest";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import type { PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import { buildPremiseEvidenceIndex, type PremiseEvidenceConfig } from "./longmemeval-v2-premise-evidence.js";
import { selectTypedRefutationContext } from "./longmemeval-v2-typed-refutation.js";
import { evaluateTypedRefutationPolicyGate } from "./longmemeval-v2-typed-refutation-design-runner.js";

const indexConfig: PremiseEvidenceConfig = {
  maxTrajectories: 10, maxStates: 20, maxInventories: 100, maxItemsPerInventory: 8,
  maxIndexKeys: 500, maxSupportsPerKey: 10, maxCapsuleCharacters: 1_200,
  minContextOverlap: 1, minDistinctTrajectories: 1, allowedInventoryKinds: ["columns"],
};
const question: LongTaskQuestion = {
  id: "q", domain: "web", environment: "fixture", memoryAbility: "hidden",
  prompt: "In the Search Terms Report, what is between `Store` and `Results`?",
  referenceAnswer: "must-not-be-read", evaluator: "must-not-be-read", imagePath: null,
  trajectoryIds: ["t1"],
};
const trajectory: LongTaskTrajectory = {
  id: "t1", domain: "web", environment: "fixture", goal: "Inspect Search Terms Report",
  outcome: "success", startUrl: "https://example.test/search",
  states: [{
    id: "t1:0", trajectoryId: "t1", index: 0, sourceStep: 0,
    url: "https://example.test/search", thought: null, transitionAction: null,
    screenshotPath: null,
    observation: "RootWebArea 'Search Terms Report'\n\trow ''\n\t\tcolumnheader 'Store'\n\t\tcolumnheader 'Results'",
  }],
};
const baseline: PackedLongTaskContext = {
  items: [{ id: "base", sessionId: "base", role: "assistant", content: "base memory",
    timestampMs: 0, sequence: 0, score: 1, tokenCount: 20 }],
  injectedTokens: 20, tokenViolation: false,
};
const index = buildPremiseEvidenceIndex({ trajectories: [trajectory], config: indexConfig });
const d14Policy = {
  enabled: true, maxCapsuleTokens: 128, maxCandidateItems: 7,
  maxCandidateTokens: 3_200, maxSelectionLatencyMs: 25,
};
const policy = (policyId: "typed-relation-v1" | "typed-answer-mode-v1" | "typed-action-contract-v1") => ({
  policyId, enabled: true, maxCapsuleTokens: 192, maxCandidateItems: 7,
  maxCandidateTokens: 3_264, maxSelectionLatencyMs: 25,
});

describe("LongMemEval-V2 typed refutation", () => {
  it("escalates only the typed answer-control fields", () => {
    const relation = selectTypedRefutationContext({ baseline, question, index, d14Policy,
      policy: policy("typed-relation-v1") });
    const mode = selectTypedRefutationContext({ baseline, question, index, d14Policy,
      policy: policy("typed-answer-mode-v1") });
    const action = selectTypedRefutationContext({ baseline, question, index, d14Policy,
      policy: policy("typed-action-contract-v1") });
    expect(relation.typedCapsule).toContain("question_relation: REFUTES_PREMISE");
    expect(relation.typedCapsule).not.toContain("answer_mode:");
    expect(mode.typedCapsule).toContain("answer_mode: CORRECT_FALSE_PREMISE");
    expect(mode.typedCapsule).not.toContain("generation_contract:");
    expect(action.typedCapsule).toContain("generation_contract:");
    for (const result of [relation, mode, action]) {
      expect(result.items[0]).toEqual(baseline.items[0]);
      expect(result.basePrefixViolations).toBe(0);
      expect(result.capsuleCertificateViolations).toBe(0);
    }
  });

  it("hard-falls back on renderer, certificate, and token failures", () => {
    const failures = [
      selectTypedRefutationContext({ baseline, question, index, d14Policy,
        policy: policy("typed-relation-v1"), testHooks: { forceRendererFailure: true } }),
      selectTypedRefutationContext({ baseline, question, index, d14Policy,
        policy: policy("typed-relation-v1"), testHooks: { forceCertificateFailure: true } }),
      selectTypedRefutationContext({ baseline, question, index, d14Policy,
        policy: policy("typed-relation-v1"), testHooks: { countTokens: () => 193 } }),
      selectTypedRefutationContext({ baseline, question, index, d14Policy,
        policy: policy("typed-relation-v1"), testHooks: {
          now: (() => { let tick = 0; return () => (tick++ === 0 ? 0 : 26); })(),
        } }),
    ];
    for (const result of failures) {
      expect(result.mode).toBe("fallback_baseline");
      expect(result.items).toEqual(baseline.items);
    }
  });

  it("requires improvement from both readers without any judge harm", () => {
    const passing = {
      primaryImprovedReaderPairs: 2, primaryHarmedReaderPairs: 0,
      unanimousImprovedReaderPairs: 2, anyJudgeHarmedReaderPairs: 0,
      readersWithAtLeastOnePrimaryImprovement: 2, readersWithNegativeMeanDelta: 0,
      modelMismatches: 0, directCertificateViolations: 0, fallbackCount: 0,
    };
    expect(evaluateTypedRefutationPolicyGate(passing).eligible).toBe(true);
    expect(evaluateTypedRefutationPolicyGate({
      ...passing, readersWithAtLeastOnePrimaryImprovement: 1,
    }).eligible).toBe(false);
  });
});
