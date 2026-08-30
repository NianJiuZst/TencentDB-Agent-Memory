import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import { appendLifecycleFeedbackEvent } from "../lifecycle/feedback-store.js";
import type { IMemoryStore, L1FtsResult, L1RecordRow } from "../store/types.js";
import { VectorStore } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import { performAutoRecall } from "./auto-recall.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-recall-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function searchResult(id: string, content: string, score: number): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "persona",
    priority: 80,
    scene_name: "偏好",
    score,
    timestamp_str: "2026-08-30T00:00:00.000Z",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "session-1",
    session_id: "session-1",
    team_id: "team-1",
    task_id: "task-1",
    user_id: "user-1",
    agent_id: "agent-1",
    source_message_ids: [],
    metadata_json: "{}",
  };
}

function row(id: string, content: string): L1RecordRow {
  const result = searchResult(id, content, 0);
  return {
    record_id: result.record_id,
    content: result.content,
    type: result.type,
    priority: result.priority,
    scene_name: result.scene_name,
    session_key: result.session_key,
    session_id: result.session_id,
    team_id: result.team_id,
    task_id: result.task_id,
    user_id: result.user_id,
    agent_id: result.agent_id,
    version: result.version,
    timestamp_str: result.timestamp_str,
    timestamp_start: result.timestamp_start,
    timestamp_end: result.timestamp_end,
    created_time: "2026-08-30T00:00:00.000Z",
    updated_time: "2026-08-30T00:00:00.000Z",
    source_message_ids_json: "[]",
    metadata_json: "{}",
  };
}

describe("auto recall lifecycle integration", () => {
  it("injects the materialized successor instead of a stale Base hit", async () => {
    const pluginDataDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir: pluginDataDir,
      event: {
        schemaVersion: 1,
        eventId: "preference-correction",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old-id"],
        successorMemoryIds: ["new-id"],
        scope: {
          teamId: "team-1",
          userId: "user-1",
          agentId: "agent-1",
          taskId: "task-1",
          sessionKey: "session-1",
        },
      },
    });
    const store = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => [
        searchResult("old-id", "用户喜欢旧方案", 0.9),
        { ...searchResult("stable-id", "用户一直偏好中文回答", 0.8), session_key: "session-2", session_id: "session-2" },
      ],
      queryL1Records: async ({ recordIds }: { recordIds?: string[] }) =>
        recordIds?.includes("new-id") ? [row("new-id", "用户改为喜欢新方案")] : [],
    } as unknown as IMemoryStore;
    const cfg = parseConfig({
      recall: {
        strategy: "keyword",
        maxResults: 2,
        lifecycle: { enabled: true, feedbackEnabled: false },
      },
    });

    const result = await performAutoRecall({
      userText: "用户喜欢什么方案",
      actorId: "user-1",
      sessionKey: "session-1",
      cfg,
      pluginDataDir,
      vectorStore: store,
      profileIsolation: { teamId: "team-1", agentId: "agent-1" },
    });

    expect(result?.prependContext).toContain("用户改为喜欢新方案");
    expect(result?.prependContext).not.toContain("用户喜欢旧方案");
    expect(result?.recalledL1Memories?.map((memory) => memory.id)).toEqual(["new-id", "stable-id"]);
    expect(result?.recalledL1Memories?.[0]?.score).toBe(0.9);
    expect(result?.lifecycleDecision).toMatchObject({ mode: "adaptive", redirects: 1 });
  });

  it("runs through the real SQLite L1 store used by standalone TencentDB Agent Memory", async () => {
    const pluginDataDir = await tempDir();
    const store = new VectorStore(path.join(pluginDataDir, "vectors.db"), 0);
    store.init();
    const baseRecord: Omit<MemoryRecord, "id" | "content" | "version"> = {
      type: "instruction",
      priority: 80,
      scene_name: "deployment",
      source_message_ids: [],
      metadata: {},
      timestamps: ["2026-08-30T00:00:00.000Z"],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      sessionKey: "session-1",
      sessionId: "session-1",
      taskId: "task-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
    };
    try {
      expect(store.upsertL1({ ...baseRecord, id: "sqlite-old", content: "Use the cobalt cluster for deployment.", version: 1 })).toBe(true);
      expect(store.upsertL1({ ...baseRecord, id: "sqlite-new", content: "Use the azure cluster for deployment.", version: 2 })).toBe(true);
      expect(store.queryL1Records({ recordIds: ["sqlite-new"] }).map((item) => item.record_id)).toEqual(["sqlite-new"]);
      await appendLifecycleFeedbackEvent({
        baseDir: pluginDataDir,
        event: {
          schemaVersion: 1,
          eventId: "sqlite-correction",
          kind: "update",
          occurredAtMs: 1_700_000_000_000,
          confidence: 0.95,
          source: "test",
          predecessorMemoryIds: ["sqlite-old"],
          successorMemoryIds: ["sqlite-new"],
          scope: { teamId: "team-1", userId: "user-1", agentId: "agent-1", taskId: "task-1", sessionKey: "session-1" },
        },
      });
      const cfg = parseConfig({
        recall: { strategy: "keyword", maxResults: 1, scoreThreshold: 0, lifecycle: { enabled: true } },
      });
      const result = await performAutoRecall({
        userText: "cobalt cluster",
        actorId: "user-1",
        sessionKey: "session-1",
        cfg,
        pluginDataDir,
        vectorStore: store,
        profileIsolation: { teamId: "team-1", agentId: "agent-1" },
      });

      expect(result?.prependContext).toContain("azure cluster");
      expect(result?.prependContext).not.toContain("cobalt cluster");
      expect(result?.lifecycleDecision?.redirects).toBe(1);
    } finally {
      store.close();
    }
  });

  it("preserves ids on the Tencent Cloud VectorDB native-hybrid path", async () => {
    const pluginDataDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir: pluginDataDir,
      event: {
        schemaVersion: 1,
        eventId: "tcvdb-correction",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["tcvdb-old"],
        successorMemoryIds: ["tcvdb-new"],
        scope: { teamId: "team-1", userId: "user-1", agentId: "agent-1", taskId: "task-1" },
      },
    });
    const stale = searchResult("tcvdb-old", "旧的云数据库方案", 0.91);
    const store = {
      getCapabilities: () => ({ nativeHybridSearch: true }),
      searchL1Hybrid: async () => [stale],
      queryL1Records: async () => [row("tcvdb-new", "新的云数据库方案")],
    } as unknown as IMemoryStore;
    const embeddingService = {
      embed: async () => { throw new Error("native hybrid must not call the client embedder"); },
    } as unknown as EmbeddingService;
    const cfg = parseConfig({
      recall: { strategy: "hybrid", maxResults: 1, lifecycle: { enabled: true } },
      embedding: { provider: "test", enabled: true },
    });

    const result = await performAutoRecall({
      userText: "云数据库方案",
      actorId: "user-1",
      sessionKey: "session-1",
      cfg,
      pluginDataDir,
      vectorStore: store,
      embeddingService,
      profileIsolation: { teamId: "team-1", agentId: "agent-1" },
    });

    expect(result?.recalledL1Memories?.[0]).toMatchObject({ id: "tcvdb-new", content: "新的云数据库方案", score: 0.91 });
    expect(result?.lifecycleDecision?.redirects).toBe(1);
  });
});
