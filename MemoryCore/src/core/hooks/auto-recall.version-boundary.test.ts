import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import { withMemoryVersionContext, type MemoryVersionContext } from "../lifecycle/version-scope.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { StoragePaths } from "../storage/types.js";
import { performAutoRecall } from "./auto-recall.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const context: MemoryVersionContext = { schemaVersion: 1, repositoryId: "repo", branch: "release", scopeLevel: "branch" };
function hit(id: string, branch: string, team = "team"): L1FtsResult {
  return {
    record_id: id, content: `Atlas compiler ${id}`, type: "work_fact", priority: 80, scene_name: "build", score: 1,
    timestamp_str: "2026-09-05T00:00:00Z", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "session", session_id: "session", team_id: team, user_id: "user", agent_id: "agent", task_id: "",
    source_message_ids: [], metadata_json: JSON.stringify(withMemoryVersionContext({}, { ...context, branch })),
  };
}
async function recall(rows: L1FtsResult[], options: { failStorage?: boolean; strict?: boolean } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "version-boundary-")); dirs.push(dir);
  if (options.failStorage) {
    await mkdir(path.join(dir, StoragePaths.lifecycleEventsDir), { recursive: true });
    await writeFile(path.join(dir, StoragePaths.lifecycleEventsDir, "broken.jsonl"), "{broken-json\n");
  }
  return performAutoRecall({
    userText: "Atlas compiler", pluginDataDir: dir, actorId: "user", sessionKey: "session",
    profileIsolation: { teamId: "team", agentId: "agent" }, versionContext: context,
    cfg: parseConfig({ recall: { strategy: "keyword", maxResults: 2, scoreThreshold: 0,
      lifecycle: { enabled: true, versionAwareMode: options.strict === false ? "off" : "strict", autoDetectGit: false, versionCandidateMultiplier: 4 } } }),
    vectorStore: { isFtsAvailable: () => true, searchL1Fts: async (_q: string, limit: number) => rows.slice(0, limit), queryL1Records: async () => [] } as unknown as IMemoryStore,
  });
}
describe("version filtering across the production candidate pool", () => {
  it("quarantines malformed scoped metadata instead of promoting it to legacy", async () => {
    const malformed = { ...hit("broken", "main"), metadata_json: JSON.stringify({ memory_version_context: { schemaVersion: 1, repositoryId: "repo", scopeLevel: "task", taskId: "incomplete" } }) };
    const result = await recall([malformed, hit("correct", "release")]);
    expect(result?.recalledL1Memories?.map(m => m.id)).toEqual(["correct"]);
    const alone = await recall([malformed]);
    expect(alone?.recalledL1Memories ?? []).toEqual([]);
    expect(alone?.lifecycleDecision?.versionSuppressedCandidates).toBe(1);
  });
  it.each([3, 4, 8])("retains the current branch at rank %i beyond Top-2", async rank => {
    const rows = Array.from({ length: 8 }, (_, i) => hit(`id-${i + 1}`, i + 1 === rank ? "release" : "main"));
    const result = await recall(rows);
    expect(result?.recalledL1Memories?.map(m => m.id)).toEqual([`id-${rank}`]);
  });
  it("still enforces version validity when identity scopes disable correction replay", async () => {
    const result = await recall([hit("foreign", "main", "other-team"), hit("correct", "release")]);
    expect(result?.recalledL1Memories?.map(m => m.id)).toEqual(["correct"]);
    expect(result?.lifecycleDecision?.mode).toBe("fallback");
  });
  it("filters the complete original pool after correction storage failure", async () => {
    const result = await recall([hit("old1", "main"), hit("old2", "main"), hit("correct", "release")], { failStorage: true });
    expect(result?.recalledL1Memories?.map(m => m.id)).toEqual(["correct"]);
    expect(result?.lifecycleDecision?.mode).toBe("fallback");
  });
  it("preserves the original unfiltered prefix when strict mode is disabled", async () => {
    const result = await recall([hit("first", "main"), hit("second", "main"), hit("third", "release")], { strict: false });
    expect(result?.recalledL1Memories?.map(m => m.id)).toEqual(["first", "second"]);
  });
});
