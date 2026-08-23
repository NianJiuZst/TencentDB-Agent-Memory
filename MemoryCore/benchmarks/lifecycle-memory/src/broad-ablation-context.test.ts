import { describe, expect, it } from "vitest";
import type { LifecycleResolver } from "../../../src/core/lifecycle/index.js";
import {
  recencyTopK,
  renderSuperseded,
  tombstoneRefill,
} from "./broad-ablation-context.js";
import type { RetrievedUnit } from "./types.js";

function unit(id: string, timestampMs: number): RetrievedUnit {
  return {
    id,
    sessionId: id,
    role: "user",
    content: id,
    timestampMs,
    sequence: timestampMs,
    score: 1,
    tokenCount: 1,
  };
}

const resolver: LifecycleResolver = {
  resolveIds: (ids) => ({
    ids: ids[0] === "old" ? ["new"] : ids[0] === "deleted" ? [] : ids,
    redirects: ids[0] === "current" ? 0 : 1,
    maxObservedHops: ids[0] === "current" ? 0 : 1,
    expansions: ids[0] === "old" ? 1 : 0,
  }),
};

describe("D16 broad answer-level contexts", () => {
  it("implements the tombstone baseline without injecting a successor", () => {
    const candidates = [unit("old", 1), unit("current", 2), unit("filler", 3)];
    expect(tombstoneRefill({ candidates, resolver, limit: 2 }).map((item) => item.id))
      .toEqual(["current", "filler"]);
  });

  it("hard-falls back to exact Base order when the resolver fails", () => {
    const damaged: LifecycleResolver = { resolveIds: () => { throw new Error("damaged"); } };
    const candidates = [unit("old", 1), unit("current", 2), unit("filler", 3)];
    expect(tombstoneRefill({ candidates, resolver: damaged, limit: 2 }).map((item) => item.id))
      .toEqual(["old", "current"]);
  });

  it("implements a deterministic recency reranker", () => {
    const candidates = [unit("a", 1), unit("b", 3), unit("c", 2)];
    expect(recencyTopK(candidates, 2).map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("labels obsolete evidence but leaves current evidence byte-identical", () => {
    const rendered = renderSuperseded({ candidates: [unit("old", 1), unit("deleted", 2), unit("current", 3)], resolver });
    expect(rendered[0].content).toContain("SUPERSEDED");
    expect(rendered[1].content).toContain("DELETED");
    expect(rendered[2]).toEqual(unit("current", 3));
  });
});
