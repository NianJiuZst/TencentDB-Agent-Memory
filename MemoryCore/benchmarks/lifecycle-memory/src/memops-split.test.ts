import { describe, expect, it } from "vitest";
import { buildMemOpsProfileSplit } from "./memops-split.js";

describe("MemOps profile split", () => {
  it("is deterministic, disjoint, and profile-grouped", () => {
    const instanceIds = Array.from({ length: 100 }, (_, index) => {
      const profile = `A${String(index).padStart(2, "0")}`;
      return [`${profile}_remember`, `${profile}_update`];
    }).flat();
    const first = buildMemOpsProfileSplit({ instanceIds, seed: 7 });
    const second = buildMemOpsProfileSplit({ instanceIds, seed: 7 });
    expect(first).toEqual(second);
    expect(first.development).toHaveLength(60);
    expect(first.validation).toHaveLength(20);
    expect(first.test).toHaveLength(20);
    expect(new Set([...first.development, ...first.validation, ...first.test]).size).toBe(100);
    expect(first.counts.development.instances).toBe(120);
  });
});
