import { describe, expect, it } from "vitest";
import type { LifecycleResolver } from "../../../src/core/lifecycle/index.js";
import type { PreparedCase } from "./adaptive-runner.js";
import { safeHybridCase, SAFE_HYBRID_POLICY } from "./safe-hybrid-runner.js";
import type { LifecycleEvalQuestion, RetrievedUnit } from "./types.js";

function prepared(query: string): PreparedCase {
  const units: RetrievedUnit[] = ["old", "two", "three", "four", "five", "new"].map((id, index) => ({
    id,
    sessionId: String(index),
    role: "user",
    content: id,
    timestampMs: index,
    sequence: index,
    score: 1 - index / 10,
    tokenCount: 1,
  }));
  const question: LifecycleEvalQuestion = {
    id: `case:${query}`,
    groupId: "group",
    persona: "persona",
    period: "quarterly",
    task: "remembering",
    query,
    questionDate: "2026-08-21",
    currentSessionIds: ["5"],
    obsoleteSessionIds: ["0"],
    currentAtoms: [],
    obsoleteAtoms: [],
    evaluationQuestions: [],
    memoryPresenceQuestions: 0,
    forgettingAbsenceQuestions: 0,
  };
  const resolver: LifecycleResolver = {
    resolveIds: (ids) => ({
      ids: ids.map((id) => id === "old" ? "new" : id).slice(0, 5),
      redirects: 1,
      maxObservedHops: 1,
      expansions: 1,
    }),
  };
  return {
    question,
    candidates: units.slice(0, 5),
    queryLatencyMs: 1,
    resolver,
    materialize: (id) => units.find((unit) => unit.id === id),
  };
}

describe("safe-hybrid lifecycle routing", () => {
  it("keeps Base candidates for a historical aggregate query", () => {
    const result = safeHybridCase({ prepared: prepared("How much have I spent this month?") });
    expect(result.queryIntent).toBe("historical_aggregate");
    expect(result.candidateIds).toEqual(["old", "two", "three", "four", "five"]);
    expect(result.decision?.mode).toBe("base");
  });

  it("uses the fixed-budget V1 redirect for a current-state query", () => {
    const result = safeHybridCase({ prepared: prepared("What music do I like now?") });
    expect(result.queryIntent).toBe("current_state");
    expect(result.candidateIds).toEqual(["new", "two", "three", "four", "five"]);
    expect(result.candidateIds).toHaveLength(SAFE_HYBRID_POLICY.resultLimit);
    expect(result.decision?.mode).toBe("adaptive");
  });
});
