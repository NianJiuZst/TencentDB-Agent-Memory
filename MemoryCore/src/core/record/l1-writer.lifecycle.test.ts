import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLifecycleFeedbackEvents } from "../lifecycle/feedback-store.js";
import type { IMemoryStore, L1RecordRow } from "../store/types.js";
import { writeMemory } from "./l1-writer.js";
import { MEMORY_VERSION_CONTEXT_METADATA_KEY, type MemoryVersionContext } from "../lifecycle/version-scope.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "l1-writer-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function oldRow(): L1RecordRow {
  return {
    record_id: "old-id",
    content: "用户喜欢旧方案",
    type: "persona",
    priority: 80,
    scene_name: "偏好",
    session_key: "session-previous",
    session_id: "session-previous",
    team_id: "team-1",
    task_id: "task-1",
    user_id: "user-1",
    agent_id: "agent-1",
    version: 1,
    timestamp_str: "2026-08-29T00:00:00.000Z",
    timestamp_start: "",
    timestamp_end: "",
    created_time: "2026-08-29T00:00:00.000Z",
    updated_time: "2026-08-29T00:00:00.000Z",
    source_message_ids_json: "[]",
    metadata_json: "{}",
  };
}

describe("L1 writer lifecycle feedback", () => {
  it("releases a scoped edge only after the successor upsert succeeds", async () => {
    const baseDir = await tempDir();
    const queryL1Records = vi.fn(async () => [oldRow()]);
    const upsertL1 = vi.fn(async () => true);
    const deleteL1Batch = vi.fn(async () => true);
    const store = { queryL1Records, upsertL1, deleteL1Batch } as unknown as IMemoryStore;

    const written = await writeMemory({
      memory: {
        content: "用户改为喜欢新方案",
        type: "persona",
        priority: 90,
        source_message_ids: ["message-2"],
        metadata: {},
        scene_name: "偏好",
      },
      decision: {
        record_id: "new-id",
        action: "update",
        target_ids: ["old-id"],
        merged_content: "用户改为喜欢新方案",
      },
      baseDir,
      sessionKey: "session-1",
      sessionId: "session-1",
      taskId: "task-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      vectorStore: store,
      lifecycleFeedbackEnabled: true,
    });

    expect(written?.id).toBe("new-id");
    expect(upsertL1).toHaveBeenCalledOnce();
    expect(queryL1Records).toHaveBeenCalledWith({
      recordIds: ["old-id"],
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: "task-1",
    });
    const loaded = await loadLifecycleFeedbackEvents({
      baseDir,
      scope: { teamId: "team-1", userId: "user-1", agentId: "agent-1", taskId: "task-1", sessionKey: "session-1" },
      maxEvents: 10,
    });
    expect(loaded.events).toHaveLength(1);
    expect(loaded.events[0]).toMatchObject({
      source: "l1-dedup-update",
      confidence: 0.95,
      predecessorMemoryIds: ["old-id"],
      successorMemoryIds: ["new-id"],
    });
  });

  it("does not release an edge when the successor upsert fails", async () => {
    const baseDir = await tempDir();
    const store = {
      queryL1Records: async () => [oldRow()],
      upsertL1: async () => false,
      deleteL1Batch: async () => true,
    } as unknown as IMemoryStore;

    await writeMemory({
      memory: { content: "新值", type: "persona", priority: 80, source_message_ids: [], metadata: {}, scene_name: "偏好" },
      decision: { record_id: "new-id", action: "update", target_ids: ["old-id"] },
      baseDir,
      sessionKey: "session-1",
      sessionId: "session-1",
      taskId: "task-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      vectorStore: store,
      lifecycleFeedbackEnabled: true,
    });

    const loaded = await loadLifecycleFeedbackEvents({ baseDir, scope: {}, maxEvents: 10 });
    expect(loaded.events).toEqual([]);
  });

  it("stores a sibling branch state without deleting or linking the other branch", async () => {
    const baseDir = await tempDir();
    const mainContext: MemoryVersionContext = {
      schemaVersion: 1,
      repositoryId: "repo-a",
      branch: "main",
      commitSha: "main-sha",
      worktreeId: "wt-main",
      scopeLevel: "worktree",
      source: "explicit",
    };
    const releaseContext: MemoryVersionContext = {
      ...mainContext,
      branch: "release",
      commitSha: "release-sha",
      worktreeId: "wt-release",
    };
    const row = oldRow();
    row.metadata_json = JSON.stringify({ [MEMORY_VERSION_CONTEXT_METADATA_KEY]: mainContext });
    const deleteL1Batch = vi.fn(async () => true);
    const upsertL1 = vi.fn(async () => true);
    const store = {
      queryL1Records: async () => [row],
      deleteL1Batch,
      upsertL1,
    } as unknown as IMemoryStore;

    const written = await writeMemory({
      memory: { content: "release uses port 8443", type: "work_fact", priority: 80, source_message_ids: [], metadata: {}, scene_name: "build" },
      decision: { record_id: "release-id", action: "update", target_ids: ["old-id"] },
      baseDir,
      sessionKey: "session-release",
      sessionId: "session-release",
      taskId: "task-release",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      vectorStore: store,
      lifecycleFeedbackEnabled: true,
      versionContext: releaseContext,
    });

    expect(deleteL1Batch).not.toHaveBeenCalled();
    expect(upsertL1).toHaveBeenCalledOnce();
    expect(written?.metadata).toMatchObject({ [MEMORY_VERSION_CONTEXT_METADATA_KEY]: releaseContext });
    const loaded = await loadLifecycleFeedbackEvents({
      baseDir,
      scope: {
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        repositoryId: releaseContext.repositoryId,
        branch: releaseContext.branch,
        worktreeId: releaseContext.worktreeId,
        versionScopeLevel: releaseContext.scopeLevel,
      },
      maxEvents: 10,
    });
    expect(loaded.events).toEqual([]);
  });

  it("updates the same version domain across sessions without crossing tenant identity", async () => {
    const baseDir = await tempDir();
    const branchContext: MemoryVersionContext = {
      schemaVersion: 1,
      repositoryId: "repo-a",
      branch: "main",
      commitSha: "new-sha",
      scopeLevel: "branch",
      source: "explicit",
    };
    const row = oldRow();
    row.task_id = "previous-task";
    row.metadata_json = JSON.stringify({
      [MEMORY_VERSION_CONTEXT_METADATA_KEY]: { ...branchContext, commitSha: "old-sha" },
    });
    const queryL1Records = vi.fn(async () => [row]);
    const deleteL1Batch = vi.fn(async () => true);
    const store = {
      queryL1Records,
      deleteL1Batch,
      upsertL1: async () => true,
    } as unknown as IMemoryStore;

    await writeMemory({
      memory: { content: "main uses port 9443", type: "work_fact", priority: 80, source_message_ids: [], metadata: {}, scene_name: "build" },
      decision: { record_id: "main-new", action: "update", target_ids: ["old-id"] },
      baseDir,
      sessionKey: "session-new",
      sessionId: "session-new",
      taskId: "new-task",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      vectorStore: store,
      lifecycleFeedbackEnabled: true,
      versionContext: branchContext,
    });

    expect(queryL1Records).toHaveBeenCalledWith({
      recordIds: ["old-id"],
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: undefined,
    });
    expect(deleteL1Batch).toHaveBeenCalledWith(["old-id"], {
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
    });
  });
});
