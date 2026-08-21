import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMemOpsDominance } from "./memops-dominance-runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MemOps dominance runner", () => {
  it("rejects source artifacts before reading public data when a hash differs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memops-dominance-lock-"));
    roots.push(root);
    const source = path.join(root, "cases.jsonl");
    await writeFile(source, "{}\n", "utf8");
    await expect(runMemOpsDominance({
      dataRoot: path.join(root, "missing-data"),
      sourceResultCard: source,
      developmentCases: source,
      validationCases: source,
      testCases: source,
      outputDir: path.join(root, "output"),
    })).rejects.toThrow(/source result card hash mismatch/);
  });
});
