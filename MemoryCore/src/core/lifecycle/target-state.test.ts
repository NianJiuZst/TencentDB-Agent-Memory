import { describe, expect, it } from "vitest";
import {
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
});
