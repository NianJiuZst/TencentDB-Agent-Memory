import { describe, expect, it } from "vitest";
import {
  applyLifecycleValidStatePacking,
  LifecycleDeleteVacancy,
  LifecycleLedger,
  type LifecycleDeleteVacancyPolicy,
  type LifecycleDeleteVacancySource,
  type LifecycleEvent,
  type LifecyclePolicy,
  type LifecycleUnit,
  type LifecycleValidStatePackingPolicy,
} from "./index.js";

type TokenUnit = LifecycleUnit & { tokenCount: number };

const units: TokenUnit[] = [
  { id: "old", content: "likes period pieces", sequence: 1, tokenCount: 20 },
  { id: "tombstone", content: "no longer likes period pieces", sequence: 2, tokenCount: 40 },
  { id: "current-a", content: "likes war dramas", sequence: 3, tokenCount: 25 },
  { id: "current-b", content: "dislikes epics", sequence: 4, tokenCount: 30 },
  { id: "current-c", content: "likes thrillers", sequence: 5, tokenCount: 20 },
];

const events: LifecycleEvent[] = [{
  id: "delete",
  kind: "delete",
  sequence: 2,
  confidence: 0.99,
  obsoleteValues: ["period pieces"],
  successorUnitIds: ["tombstone"],
  source: "test",
}];

const incumbentPolicy: LifecyclePolicy = {
  enabled: true,
  minConfidence: 0.85,
  maxHops: 1,
  maxExpansions: 10,
  resultLimit: 2,
  timeoutMs: 10,
};

const validityPolicy: LifecycleDeleteVacancyPolicy = {
  enabled: true,
  minConfidence: 0.85,
  maxCandidates: 10,
  maxHops: 1,
  maxExpansions: 10,
  resultLimit: 5,
  timeoutMs: 10,
};

const packingPolicy: LifecycleValidStatePackingPolicy = {
  enabled: true,
  budgetFraction: 1,
  maxCandidates: 10,
  maxItems: 2,
  resultLimit: 2,
  timeoutMs: 10,
};

const byId = new Map(units.map((unit) => [unit.id, unit]));
const candidates = units;

function apply(
  policy = packingPolicy,
  validitySource: LifecycleDeleteVacancySource = new LifecycleDeleteVacancy(units, events),
) {
  return applyLifecycleValidStatePacking({
    candidates,
    incumbentResolver: new LifecycleLedger(units, events),
    incumbentPolicy,
    validitySource,
    validityPolicy,
    policy,
    materialize: (id) => byId.get(id),
  });
}

describe("valid-state packing", () => {
  it("packs valid candidates under the per-query V1 token budget", () => {
    const result = apply();
    expect(result.decision.mode).toBe("adaptive");
    expect(result.decision.v1Tokens).toBe(65);
    expect(result.candidates.map((item) => item.id)).toEqual(["current-a", "current-b"]);
    expect(result.decision.outputTokens).toBeLessThanOrEqual(result.decision.v1Tokens);
  });

  it("learned budget fractions can reduce the packed item count without truncation", () => {
    const result = apply({ ...packingPolicy, budgetFraction: 0.75 });
    expect(result.candidates.map((item) => item.id)).toEqual(["current-a", "current-c"]);
    expect(result.decision.outputTokens).toBe(45);
    expect(result.decision.tokenBudget).toBe(48);
  });

  it("returns exact Base candidates when disabled or a dependency fails", () => {
    const disabled = apply({ ...packingPolicy, enabled: false });
    expect(disabled.candidates.map((item) => item.id)).toEqual(["old", "tombstone"]);
    const damaged = apply(packingPolicy, {
      resolveIds: () => {
        throw new Error("forced damage");
      },
    });
    expect(damaged.decision.mode).toBe("fallback");
    expect(damaged.candidates.map((item) => item.id)).toEqual(["old", "tombstone"]);
  });
});
