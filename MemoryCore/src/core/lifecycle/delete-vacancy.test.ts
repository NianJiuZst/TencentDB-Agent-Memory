import { describe, expect, it } from "vitest";
import {
  applyLifecycleDeleteVacancy,
  LifecycleDeleteVacancy,
  type LifecycleDeleteVacancyPolicy,
  type LifecycleDeleteVacancySource,
} from "./index.js";
import type { LifecycleEvent, LifecycleUnit } from "./types.js";

const policy: LifecycleDeleteVacancyPolicy = {
  enabled: true,
  maxCandidates: 10,
  maxExpansions: 10,
  maxHops: 1,
  minConfidence: 0.85,
  resultLimit: 2,
  timeoutMs: 10,
};

const units: LifecycleUnit[] = [
  { id: "old-delete", content: "The user likes period pieces", sequence: 1 },
  { id: "delete-turn", content: "I no longer like period pieces", sequence: 2 },
  { id: "old-update", content: "The API is named alpha", sequence: 3 },
  { id: "update-turn", content: "The API is now named beta, not alpha", sequence: 4 },
  { id: "current-one", content: "The user likes war dramas", sequence: 5 },
  { id: "current-two", content: "The user dislikes epics", sequence: 6 },
];

const events: LifecycleEvent[] = [
  {
    id: "delete",
    kind: "delete",
    sequence: 2,
    confidence: 0.99,
    obsoleteValues: ["period pieces"],
    successorUnitIds: ["delete-turn"],
    source: "test",
  },
  {
    id: "update",
    kind: "update",
    sequence: 4,
    confidence: 0.99,
    obsoleteValues: ["alpha"],
    successorUnitIds: ["update-turn"],
    source: "test",
  },
];

const byId = new Map(units.map((unit) => [unit.id, unit]));

describe("LifecycleDeleteVacancy", () => {
  it("drops deletion evidence and refills from the existing candidate pool", () => {
    const source = new LifecycleDeleteVacancy(units, events);
    const result = applyLifecycleDeleteVacancy({
      candidates: ["old-delete", "delete-turn", "current-one", "current-two"]
        .map((id) => byId.get(id)!),
      materialize: (id) => byId.get(id),
      policy,
      source,
    });
    expect(result.candidates.map((unit) => unit.id)).toEqual(["current-one", "current-two"]);
    expect(result.decision.mode).toBe("adaptive");
    expect(result.decision.deletePredecessorsSkipped).toBe(1);
    expect(result.decision.deleteTombstonesSkipped).toBe(1);
    expect(result.decision.backfilled).toBe(2);
  });

  it("retains V1 update redirection", () => {
    const source = new LifecycleDeleteVacancy(units, events);
    const result = applyLifecycleDeleteVacancy({
      candidates: ["old-update", "current-one"].map((id) => byId.get(id)!),
      materialize: (id) => byId.get(id),
      policy,
      source,
    });
    expect(result.candidates.map((unit) => unit.id)).toEqual(["update-turn", "current-one"]);
    expect(result.decision.redirects).toBe(1);
  });

  it("returns exact Base candidates when disabled or forced to fail", () => {
    const candidates = ["old-delete", "delete-turn", "current-one"].map((id) => byId.get(id)!);
    const source = new LifecycleDeleteVacancy(units, events);
    const disabled = applyLifecycleDeleteVacancy({
      candidates,
      materialize: (id) => byId.get(id),
      policy: { ...policy, enabled: false },
      source,
    });
    expect(disabled.candidates.map((unit) => unit.id)).toEqual(["old-delete", "delete-turn"]);
    const damaged: LifecycleDeleteVacancySource = {
      resolveIds: () => {
        throw new Error("forced damage");
      },
    };
    const fallback = applyLifecycleDeleteVacancy({
      candidates,
      materialize: (id) => byId.get(id),
      policy,
      source: damaged,
    });
    expect(fallback.decision.mode).toBe("fallback");
    expect(fallback.candidates.map((unit) => unit.id)).toEqual(["old-delete", "delete-turn"]);
  });
});
