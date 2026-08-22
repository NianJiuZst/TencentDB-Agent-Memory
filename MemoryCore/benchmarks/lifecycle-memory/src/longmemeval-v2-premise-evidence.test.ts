import { describe, expect, it } from "vitest";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import {
  buildPremiseEvidenceIndex,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  selectPremiseEvidence,
  type PremiseEvidenceConfig,
} from "./longmemeval-v2-premise-evidence.js";

const config: PremiseEvidenceConfig = {
  maxTrajectories: 10,
  maxStates: 20,
  maxInventories: 100,
  maxItemsPerInventory: 16,
  maxIndexKeys: 500,
  maxSupportsPerKey: 10,
  maxCapsuleCharacters: 2_000,
  minContextOverlap: 1,
  minDistinctTrajectories: 1,
  allowedInventoryKinds: ["tabs", "list", "columns", "fields", "actions"],
};

function trajectory(id: string, observation: string, goal = "Inspect the theme detail page"): LongTaskTrajectory {
  return {
    id,
    domain: "web",
    environment: "fixture",
    goal,
    outcome: "success",
    startUrl: "https://example.test/admin/theme",
    states: [{
      id: `${id}:0`, trajectoryId: id, index: 0, sourceStep: 0,
      url: "https://example.test/admin/theme/1", observation, thought: null,
      transitionAction: null, screenshotPath: null,
    }],
  };
}

function question(prompt: string): LongTaskQuestion {
  return {
    id: "q", domain: "web", environment: "fixture", memoryAbility: "hidden-at-runtime",
    prompt, referenceAnswer: "must-not-be-read", evaluator: "must-not-be-read", imagePath: null,
    trajectoryIds: ["t1"],
  };
}

describe("LongMemEval-V2 premise evidence", () => {
  it("certifies adjacent anchors without reading labels", () => {
    const index = buildPremiseEvidenceIndex({
      trajectories: [trajectory("t1", [
        "RootWebArea 'Search Terms / Magento Admin'",
        "\trow ''",
        "\t\tcolumnheader 'Store'",
        "\t\tcolumnheader 'Results'",
      ].join("\n"), "Inspect the Search Terms Report grid")],
      config,
    });
    const decision = selectPremiseEvidence({
      question: question("In the Search Terms Report, what is between `Store` and `Results`?"),
      index,
    });
    expect(decision.mode).toBe("premise_evidence");
    expect(decision.operator).toBe("between_adjacent");
    expect(decision.capsule).toContain("are adjacent");
    expect(decision.capsule).not.toContain("must-not-be-read");
    expect(decision.certificateViolations).toBe(0);
  });

  it("does not challenge a valid between question", () => {
    const index = buildPremiseEvidenceIndex({
      trajectories: [trajectory("t1", [
        "RootWebArea 'Search Terms / Magento Admin'",
        "\trow ''",
        "\t\tcolumnheader 'Store'",
        "\t\tcolumnheader 'Searches'",
        "\t\tcolumnheader 'Results'",
      ].join("\n"), "Inspect the Search Terms Report grid")],
      config,
    });
    const decision = selectPremiseEvidence({
      question: question("In the Search Terms Report, what is between `Store` and `Results`?"),
      index,
    });
    expect(decision.mode).toBe("baseline_noop");
    expect(decision.decisionReason).toBe("no_structural_witness");
  });

  it("certifies terminal list and tab items", () => {
    const index = buildPremiseEvidenceIndex({
      trajectories: [
        trajectory("t1", [
          "RootWebArea 'Cyberpunk forum'",
          "\tSection ''",
          "\t\theading 'Toolbox'",
          "\t\tlist ''",
          "\t\t\tlistitem ''",
          "\t\t\t\tlink 'Appearance'",
          "\t\t\tlistitem ''",
          "\t\t\t\tlink 'Trash'",
        ].join("\n"), "Moderate a forum with the Toolbox"),
        trajectory("t2", [
          "RootWebArea 'Theme: Magento Blank'",
          "\ttablist ''",
          "\t\ttab 'General'",
        ].join("\n"), "Preview the Magento Blank theme"),
      ],
      config,
    });
    const trash = selectPremiseEvidence({
      question: question("On a forum page, which Toolbox link appears below \"Trash\"?"), index,
    });
    const general = selectPremiseEvidence({
      question: question("On the theme detail page, what tab is below \"General\"?"), index,
    });
    expect(trash.mode).toBe("premise_evidence");
    expect(trash.capsule).toContain("ends at \"Trash\"");
    expect(general.mode).toBe("premise_evidence");
    expect(general.capsule).toContain("ends at \"General\"");
  });

  it("hard-falls back when bounded indexing fails", () => {
    const index = buildPremiseEvidenceIndex({
      trajectories: [trajectory("t1", "RootWebArea 'Theme'\n\ttablist ''\n\t\ttab 'General'")],
      config: { ...config, maxTrajectories: 1, maxStates: 1, maxInventories: 1 },
    });
    const decision = selectPremiseEvidence({
      question: question("What tab is below \"General\"?"),
      index: { ...index, available: false, failureReason: "inventory_overflow" },
    });
    expect(decision.mode).toBe("fallback_baseline");
    expect(decision.fallback).toBe(true);
  });

  it("uses an adapter to reconcile benchmark question and trajectory environments", () => {
    const value = trajectory("t1", [
      "RootWebArea 'Search Terms / Magento Admin'",
      "\trow ''",
      "\t\tcolumnheader 'Store'",
      "\t\tcolumnheader 'Results'",
    ].join("\n"), "Inspect the Search Terms Report grid");
    value.environment = "webarena";
    value.states[0].url = "http://localhost:9083/admin/reports/search/";
    const index = buildPremiseEvidenceIndex({
      trajectories: [value],
      config,
      scopeAdapter: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
    });
    const scopedQuestion = {
      ...question("In the Search Terms Report, what is between `Store` and `Results`?"),
      environment: "webarena-cms",
    };
    expect(selectPremiseEvidence({ question: scopedQuestion, index }).usedPremiseEvidence).toBe(true);
    expect(index.scopeAdapterId).toBe("longmemeval-v2-url-scope-v1");
  });
});
