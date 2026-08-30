import { describe, expect, it } from "vitest";
import { LifecycleLedger, type LifecyclePolicy } from "../../../src/core/lifecycle/index.js";
import type { PreparedCase } from "./adaptive-runner.js";
import {
  classifyDualStateIntent,
  dualStateCandidates,
  renderDualStateTransition,
  shouldReturnDualState,
} from "./dual-state.js";
import type { RetrievedUnit } from "./types.js";

const policy: LifecyclePolicy = {
  enabled: true,
  minConfidence: 0.85,
  maxHops: 1,
  maxExpansions: 64,
  resultLimit: 5,
  timeoutMs: 10,
};

function unit(id: string, content: string, sequence: number): RetrievedUnit {
  return {
    id,
    sessionId: String(sequence),
    role: "user",
    content,
    timestampMs: sequence,
    sequence,
    score: 1,
    tokenCount: 4,
  };
}

function prepared(resolver: LifecycleLedger): PreparedCase {
  const units = [
    unit("old", "Likes the Swiss Alps.", 1),
    unit("filler", "Likes documentaries.", 2),
    unit("new", "Likes the French Riviera.", 3),
  ];
  return {
    question: {
      id: "q",
      groupId: "weekly:test",
      persona: "test",
      period: "weekly",
      task: "remembering",
      query: "What is the current travel preference?",
      questionDate: "2026-08-30",
      currentSessionIds: [],
      obsoleteSessionIds: [],
      currentAtoms: [],
      obsoleteAtoms: [],
      evaluationQuestions: [],
      memoryPresenceQuestions: 0,
      forgettingAbsenceQuestions: 0,
    },
    candidates: [units[0], units[1], units[2]],
    queryLatencyMs: 0,
    resolver,
    materialize: (id) => units.find((item) => item.id === id),
  };
}

describe("query-aware dual-state rendering", () => {
  it("classifies explicit temporal intents without treating aggregates as dual-state", () => {
    expect(classifyDualStateIntent("What was my previous travel preference before it changed?"))
      .toBe("historical_state");
    expect(classifyDualStateIntent("How did my travel preference change from old to current?"))
      .toBe("state_change");
    expect(classifyDualStateIntent("What is my total food spending this week?"))
      .toBe("historical_aggregate");
    expect(shouldReturnDualState("state_change")).toBe(true);
    expect(shouldReturnDualState("historical_aggregate")).toBe(false);
  });

  it("renders a labelled historical/current block in one logical slot", () => {
    const rendered = renderDualStateTransition(
      unit("old", "Likes the Swiss Alps.", 1),
      unit("new", "Likes the French Riviera.", 2),
    );
    expect(rendered.content).toContain("HISTORICAL / SUPERSEDED: Likes the Swiss Alps.");
    expect(rendered.content).toContain("CURRENT / ACTIVE: Likes the French Riviera.");
    expect(rendered.id).toMatch(/^dual-state:/);
  });

  it("keeps the V1 current candidate and augments only confirmed updates", () => {
    const resolver = new LifecycleLedger(
      [
        { id: "old", content: "Likes the Swiss Alps.", sequence: 1 },
        { id: "filler", content: "Likes documentaries.", sequence: 2 },
        { id: "new", content: "Likes the French Riviera.", sequence: 3 },
      ],
      [{
        id: "update",
        kind: "update",
        sequence: 3,
        confidence: 0.99,
        obsoleteValues: [],
        predecessorUnitIds: ["old"],
        successorUnitIds: ["new"],
        source: "test",
      }],
    );
    expect(resolver.resolveIds(["old", "filler"], policy).ids).toEqual(["new", "filler"]);
    const result = dualStateCandidates({ prepared: prepared(resolver) });
    expect(result.pairCount).toBe(1);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].content).toContain("Swiss Alps");
    expect(result.candidates[0].content).toContain("French Riviera");
  });

  it("never resurfaces a deleted predecessor", () => {
    const resolver = new LifecycleLedger(
      [
        { id: "old", content: "Likes the Swiss Alps.", sequence: 1 },
        { id: "filler", content: "Likes documentaries.", sequence: 2 },
        { id: "new", content: "Likes the French Riviera.", sequence: 3 },
      ],
      [{
        id: "delete",
        kind: "delete",
        sequence: 3,
        confidence: 0.99,
        obsoleteValues: [],
        predecessorUnitIds: ["old"],
        successorUnitIds: [],
        source: "test",
      }],
    );
    const result = dualStateCandidates({ prepared: prepared(resolver) });
    expect(result.pairCount).toBe(0);
    expect(result.candidates.some((item) => item.content.includes("Swiss Alps"))).toBe(false);
  });
});
