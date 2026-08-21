import { describe, expect, it } from "vitest";
import {
  applyLifecycleDominanceGuard,
  applyLifecycleTargetState,
  LifecycleTargetState,
  type LifecycleTargetStateOperation,
  type LifecycleTargetStatePolicy,
} from "./target-state.js";

const units = ["old", "current", "tentative", "deleted", "unrelated", "refill"]
  .map((id, index) => ({ id, sequence: index + 1 }));
const operations: LifecycleTargetStateOperation[] = [
  {
    id: "remember-title",
    targetId: "title",
    kind: "remember",
    validity: "confirmed",
    confidence: 1,
    sequence: 1,
    sourceUnitIds: ["old"],
    successorUnitIds: ["old"],
  },
  {
    id: "update-title",
    targetId: "title",
    kind: "update",
    validity: "confirmed",
    confidence: 0.9,
    sequence: 2,
    sourceUnitIds: ["current"],
    successorUnitIds: ["current"],
  },
  {
    id: "tentative-title",
    targetId: "title",
    kind: "update",
    validity: "tentative",
    confidence: 1,
    sequence: 3,
    sourceUnitIds: ["tentative"],
    successorUnitIds: ["tentative"],
  },
  {
    id: "delete-contact",
    targetId: "contact",
    kind: "delete",
    validity: "confirmed",
    confidence: 1,
    sequence: 4,
    sourceUnitIds: ["deleted"],
    successorUnitIds: [],
  },
];
const policy: LifecycleTargetStatePolicy = {
  enabled: true,
  maxCandidates: 10,
  maxExpansions: 10,
  maxStateUnits: 1,
  maxTargets: 10,
  minConfidence: 0.85,
  resultLimit: 3,
  timeoutMs: 10,
};

describe("target-keyed lifecycle state", () => {
  it("projects old and tentative versions, removes deleted targets, and backfills", () => {
    const source = new LifecycleTargetState(units, operations);
    const result = applyLifecycleTargetState({
      candidates: ["tentative", "old", "deleted", "unrelated", "refill"].map((id) => ({ id })),
      materialize: (id) => ({ id }),
      policy,
      source,
    });
    expect(result.candidates.map((item) => item.id)).toEqual(["current", "unrelated", "refill"]);
    expect(result.decision).toMatchObject({
      mode: "adaptive",
      projectedTargets: 2,
      inactiveCandidatesSkipped: 1,
      backfilled: 2,
    });
  });

  it("uses the latest confirmed operation above the confidence threshold", () => {
    const source = new LifecycleTargetState(units, operations);
    const result = source.resolveIds(["tentative"], { ...policy, minConfidence: 0.95 });
    expect(result.ids).toEqual(["old"]);
  });

  it("returns the exact Base prefix when disabled or forced to fail", () => {
    const candidates = ["tentative", "old", "deleted", "unrelated"].map((id) => ({ id }));
    const source = new LifecycleTargetState(units, operations);
    const disabled = applyLifecycleTargetState({
      candidates,
      materialize: (id) => ({ id }),
      policy: { ...policy, enabled: false },
      source,
    });
    const timeout = applyLifecycleTargetState({
      candidates,
      materialize: (id) => ({ id }),
      policy,
      source,
      now: (() => {
        let current = 0;
        return () => (current += 20);
      })(),
    });
    expect(disabled.candidates).toEqual(candidates.slice(0, 3));
    expect(disabled.decision.mode).toBe("base");
    expect(timeout.candidates).toEqual(candidates.slice(0, 3));
    expect(timeout.decision.mode).toBe("fallback");
  });

  it("falls back when a projected unit cannot be materialized", () => {
    const candidates = ["old", "unrelated", "refill"].map((id) => ({ id }));
    const result = applyLifecycleTargetState({
      candidates,
      materialize: (id) => id === "current" ? undefined : { id },
      policy,
      source: new LifecycleTargetState(units, operations),
    });
    expect(result.candidates).toEqual(candidates);
    expect(result.decision).toMatchObject({
      mode: "fallback",
      fallbackReason: "target-state unit current cannot be materialized",
    });
  });

  it("classifies current, stale, and graph-unknown context units", () => {
    const source = new LifecycleTargetState(units, operations);
    expect(source.classifyIds(["old", "current", "tentative", "deleted", "unrelated"], policy))
      .toMatchObject({
        currentIds: ["current"],
        staleIds: ["old", "tentative", "deleted"],
        unknownIds: ["unrelated"],
        targets: 2,
      });
  });

  it("accepts only a cost-bounded replacement that preserves current and unknown units", () => {
    const source = new LifecycleTargetState(units, operations);
    const candidate = (id: string) => ({ id, tokens: 1 });
    const accepted = applyLifecycleDominanceGuard({
      incumbent: ["old", "unrelated"].map(candidate),
      challenger: ["current", "unrelated"].map(candidate),
      cost: (item) => item.tokens,
      inspector: source,
      policy,
    });
    expect(accepted.candidates.map((item) => item.id)).toEqual(["current", "unrelated"]);
    expect(accepted.decision).toMatchObject({
      mode: "challenger",
      checks: {
        budgetRespected: true,
        currentRetained: true,
        staleNotIncreased: true,
        unknownRetained: true,
      },
    });

    const droppedCurrent = applyLifecycleDominanceGuard({
      incumbent: ["current", "unrelated"].map(candidate),
      challenger: ["unrelated", "refill"].map(candidate),
      cost: (item) => item.tokens,
      inspector: source,
      policy,
    });
    expect(droppedCurrent.candidates.map((item) => item.id)).toEqual(["current", "unrelated"]);
    expect(droppedCurrent.decision.rejectionReasons).toContain("currentRetained");

    const droppedUnknown = applyLifecycleDominanceGuard({
      incumbent: ["old", "unrelated"].map(candidate),
      challenger: ["current", "refill"].map(candidate),
      cost: (item) => item.tokens,
      inspector: source,
      policy,
    });
    expect(droppedUnknown.candidates.map((item) => item.id)).toEqual(["old", "unrelated"]);
    expect(droppedUnknown.decision.rejectionReasons).toContain("unknownRetained");
  });

  it("rejects added stale state and token-budget expansion", () => {
    const source = new LifecycleTargetState(units, operations);
    const staleAdded = applyLifecycleDominanceGuard({
      incumbent: [
        { id: "unrelated", tokens: 1 },
        { id: "refill", tokens: 1 },
      ],
      challenger: [
        { id: "unrelated", tokens: 1 },
        { id: "refill", tokens: 1 },
        { id: "old", tokens: 0 },
      ],
      cost: (item) => item.tokens,
      inspector: source,
      policy,
    });
    expect(staleAdded.decision.rejectionReasons).toEqual(["staleNotIncreased"]);

    const overBudget = applyLifecycleDominanceGuard({
      incumbent: [
        { id: "old", tokens: 1 },
        { id: "unrelated", tokens: 1 },
      ],
      challenger: [
        { id: "current", tokens: 2 },
        { id: "unrelated", tokens: 1 },
      ],
      cost: (item) => item.tokens,
      inspector: source,
      policy,
    });
    expect(overBudget.decision.rejectionReasons).toEqual(["budgetRespected"]);
  });

  it("returns exact incumbent context when the dominance guard is disabled or fails", () => {
    const incumbent = ["current", "unrelated"].map((id) => ({ id, tokens: 1 }));
    const challenger = ["old", "refill"].map((id) => ({ id, tokens: 1 }));
    const disabled = applyLifecycleDominanceGuard({
      incumbent,
      challenger,
      cost: (item) => item.tokens,
      inspector: new LifecycleTargetState(units, operations),
      policy: { ...policy, enabled: false },
    });
    const missing = applyLifecycleDominanceGuard({
      incumbent,
      challenger,
      cost: (item) => item.tokens,
      policy,
    });
    const timeout = applyLifecycleDominanceGuard({
      incumbent,
      challenger,
      cost: (item) => item.tokens,
      inspector: new LifecycleTargetState(units, operations),
      now: (() => {
        let current = 0;
        return () => (current += 20);
      })(),
      policy,
    });
    expect(disabled.candidates).toEqual(incumbent);
    expect(disabled.decision.mode).toBe("incumbent");
    expect(missing.candidates).toEqual(incumbent);
    expect(missing.decision.mode).toBe("fallback");
    expect(timeout.candidates).toEqual(incumbent);
    expect(timeout.decision.mode).toBe("fallback");
  });
});
