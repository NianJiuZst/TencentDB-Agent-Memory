import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runMemOpsTargetState,
  selectMemOpsTargetStatePolicy,
} from "./memops-target-state-runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function metrics(stateFama: number, injectedTokens = 100) {
  return {
    currentStateRecall: stateFama,
    staleAbsence: 1,
    staleAnyAbsence: 1,
    stateFama,
    goldProvenanceRecall: stateFama,
    injectedItems: 5,
    injectedTokens,
  };
}

function syntheticRows(bestPolicy?: string): any[] {
  const ids = [
    "budget-0p75-state-1", "budget-0p75-state-2", "budget-0p75-state-3",
    "budget-0p9-state-1", "budget-0p9-state-2", "budget-0p9-state-3",
    "budget-1-state-1", "budget-1-state-2", "budget-1-state-3",
  ];
  return [
    {
      caseId: "case-1",
      profileId: "A01",
      operationFamily: "Update",
      view: "current",
      arm: "v1",
      metrics: metrics(0.5),
      decision: { mode: "adaptive", sidecarLatencyMs: 0 },
    },
    ...ids.map((id) => ({
      caseId: "case-1",
      profileId: "A01",
      operationFamily: "Update",
      view: "current",
      arm: "target_state",
      policyId: id,
      metrics: metrics(id === bestPolicy ? 0.7 : 0.5, 75),
      decision: { mode: "adaptive", sidecarLatencyMs: 0 },
    })),
  ];
}

describe("MemOps target-state runner", () => {
  it("selects the highest-utility policy from the frozen grid", () => {
    expect(selectMemOpsTargetStatePolicy(syntheticRows("budget-1-state-3"))[0].policy.id)
      .toBe("budget-1-state-3");
  });

  it("uses the frozen cost/complexity tie break when utilities match", () => {
    expect(selectMemOpsTargetStatePolicy(syntheticRows())[0].policy.id)
      .toBe("budget-0p75-state-1");
  });

  it("does not read test data when validation failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memops-test-lock-"));
    roots.push(root);
    const validation = path.join(root, "validation.json");
    await writeFile(validation, JSON.stringify({ status: "failed" }));
    await expect(runMemOpsTargetState({
      dataRoot: path.join(root, "missing-data"),
      split: path.join(root, "missing-split.json"),
      phase: "test",
      outputDir: path.join(root, "output"),
      validationSummary: validation,
    })).rejects.toThrow(/locked until validation passes/);
  });
});
