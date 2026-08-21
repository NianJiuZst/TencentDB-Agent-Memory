import { describe, expect, it } from "vitest";
import {
  applyLifecycleEvidenceShield,
  LifecycleEvidenceShield,
  type LifecycleEvidenceShieldPolicy,
  type LifecycleEvidenceShieldSource,
} from "./evidence-shield.js";
import type { LifecycleEvent } from "./types.js";

const policy: LifecycleEvidenceShieldPolicy = {
  enabled: true,
  minConfidence: 0.85,
  maxCandidates: 5,
  maxRedactions: 32,
  replacement: "[superseded]",
  timeoutMs: 5,
};

const event: LifecycleEvent = {
  id: "update:1",
  kind: "update",
  sequence: 20,
  confidence: 0.99,
  obsoleteValues: ["period-piece films"],
  successorUnitIds: ["current"],
  source: "test",
};

const candidates = [
  { id: "current", content: "I no longer enjoy period piece films; I prefer documentaries." },
  { id: "other", content: "I enjoy quiet museums." },
];

describe("LifecycleEvidenceShield", () => {
  it("removes event-linked obsolete spans without changing candidate identity", () => {
    const result = applyLifecycleEvidenceShield({
      candidates,
      policy,
      source: new LifecycleEvidenceShield([event]),
    });
    expect(result.candidates.map((item) => item.id)).toEqual(["current", "other"]);
    expect(result.candidates[0].content).toBe(
      "I no longer enjoy [superseded]; I prefer documentaries.",
    );
    expect(result.candidates[1].content).toBe(candidates[1].content);
    expect(result.decision).toMatchObject({
      mode: "shielded",
      changedCandidates: 1,
      redactions: 1,
    });
  });

  it("leaves low-confidence annotations untouched", () => {
    const source = new LifecycleEvidenceShield([{ ...event, confidence: 0.8 }]);
    const result = applyLifecycleEvidenceShield({ candidates, policy, source });
    expect(result.candidates).toEqual(candidates);
    expect(result.decision).toMatchObject({ mode: "shielded", changedCandidates: 0, redactions: 0 });
  });

  it("returns the original content exactly when disabled", () => {
    const result = applyLifecycleEvidenceShield({
      candidates,
      policy: { ...policy, enabled: false },
      source: new LifecycleEvidenceShield([event]),
    });
    expect(result.candidates).toEqual(candidates);
    expect(result.decision.mode).toBe("base");
  });

  it("falls back for source damage", () => {
    const source: LifecycleEvidenceShieldSource = {
      shield: () => {
        throw new Error("forced shield damage");
      },
    };
    const result = applyLifecycleEvidenceShield({ candidates, policy, source });
    expect(result.candidates).toEqual(candidates);
    expect(result.decision).toMatchObject({ mode: "fallback", fallbackReason: "forced shield damage" });
  });

  it("falls back for timeout without leaking partial rewrites", () => {
    let clock = 0;
    const result = applyLifecycleEvidenceShield({
      candidates,
      policy: { ...policy, timeoutMs: 1 },
      source: new LifecycleEvidenceShield([event]),
      now: () => {
        clock += 2;
        return clock;
      },
    });
    expect(result.candidates).toEqual(candidates);
    expect(result.decision.mode).toBe("fallback");
    expect(result.decision.fallbackReason).toBe("evidence shield timed out");
  });
});
