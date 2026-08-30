import { describe, expect, it } from "vitest";
import { applyLifecyclePolicy, LifecycleLedger } from "./ledger.js";
import type { LifecyclePolicy, LifecycleResolver, LifecycleUnit } from "./types.js";

const policy: LifecyclePolicy = {
  enabled: true,
  minConfidence: 0.9,
  maxHops: 8,
  maxExpansions: 64,
  resultLimit: 2,
  timeoutMs: 10,
};

const units: LifecycleUnit[] = [
  { id: "old", content: "I like period piece films.", sequence: 10 },
  { id: "middle", content: "I no longer like period piece films; I prefer war drama.", sequence: 20 },
  { id: "latest", content: "I no longer like war drama; I prefer documentaries.", sequence: 30 },
  { id: "filler", content: "I dislike musicals.", sequence: 40 },
];

describe("LifecycleLedger", () => {
  it("follows correction edges transitively", () => {
    const ledger = new LifecycleLedger(units, [
      {
        id: "event-20",
        kind: "update",
        sequence: 20,
        confidence: 1,
        obsoleteValues: ["period piece"],
        successorUnitIds: ["middle"],
        source: "test",
      },
      {
        id: "event-30",
        kind: "update",
        sequence: 30,
        confidence: 1,
        obsoleteValues: ["war drama"],
        successorUnitIds: ["latest"],
        source: "test",
      },
    ]);
    const result = ledger.resolveIds(["old", "filler"], policy);
    expect(result.ids).toEqual(["latest", "filler"]);
    expect(result.redirects).toBe(2);
  });

  it("uses exact predecessor ids from a structured write without text matching", () => {
    const ledger = new LifecycleLedger(units, [{
      id: "event-direct",
      kind: "update",
      sequence: 20,
      confidence: 1,
      obsoleteValues: [],
      predecessorUnitIds: ["old"],
      successorUnitIds: ["middle"],
      source: "structured-test",
    }]);

    expect(ledger.resolveIds(["old", "filler"], policy).ids).toEqual(["middle", "filler"]);
  });

  it("is exactly equivalent to base when disabled", () => {
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const result = applyLifecyclePolicy({
      candidates: units,
      resolver: new LifecycleLedger(units, []),
      policy: { ...policy, enabled: false },
      materialize: (id) => byId.get(id),
    });
    expect(result.candidates.map((unit) => unit.id)).toEqual(["old", "middle"]);
    expect(result.decision.mode).toBe("base");
  });

  it("hard-falls back on damaged resolver state", () => {
    const damaged: LifecycleResolver = {
      resolveIds: () => { throw new Error("checksum mismatch"); },
    };
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const result = applyLifecyclePolicy({
      candidates: units,
      resolver: damaged,
      policy,
      materialize: (id) => byId.get(id),
    });
    expect(result.candidates.map((unit) => unit.id)).toEqual(["old", "middle"]);
    expect(result.decision).toMatchObject({ mode: "fallback", fallbackReason: "checksum mismatch" });
  });

  it("hard-falls back when the time budget is exceeded", () => {
    const ledger = new LifecycleLedger(units, [{
      id: "event-20",
      kind: "delete",
      sequence: 20,
      confidence: 1,
      obsoleteValues: ["period piece"],
      successorUnitIds: ["middle"],
      source: "test",
    }]);
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    let clock = 0;
    const result = applyLifecyclePolicy({
      candidates: units,
      resolver: ledger,
      policy: { ...policy, timeoutMs: 1 },
      materialize: (id) => byId.get(id),
      now: () => { clock += 2; return clock; },
    });
    expect(result.candidates.map((unit) => unit.id)).toEqual(["old", "middle"]);
    expect(result.decision.mode).toBe("fallback");
    expect(result.decision.fallbackReason).toContain("timed out");
  });
});
