import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeMemorySearch } from "../tools/memory-search.js";
import { VectorStore } from "../store/sqlite.js";
import { queryMemoryRecords } from "./l1-reader.js";
import type { MemoryRecord } from "./l1-writer.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});
describe("L1 provenance persistence", () => {
  it("round-trips source message ids through SQLite query and FTS retrieval", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "memorycore-provenance-"));
    cleanupPaths.push(directory);
    const store = new VectorStore(path.join(directory, "vectors.db"), 0);
    store.init();

    const record: MemoryRecord = {
      id: "memory-with-provenance",
      content: "The deployment target is the cobalt cluster.",
      type: "instruction",
      priority: 80,
      scene_name: "deployment",
      source_message_ids: ["session-1-turn-3", "session-1-turn-5"],
      metadata: {},
      timestamps: ["2026-08-20T00:00:00.000Z"],
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      version: 1,
      sessionKey: "session-key",
      sessionId: "session-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
    };

    expect(store.upsertL1(record, undefined)).toBe(true);

    const queried = await queryMemoryRecords(store, { sessionId: "session-1" });
    expect(queried).toHaveLength(1);
    expect(queried[0].source_message_ids).toEqual(record.source_message_ids);

    const searched = await executeMemorySearch({
      query: "cobalt cluster",
      limit: 5,
      vectorStore: store,
    });
    expect(searched.results).toHaveLength(1);
    expect(searched.results[0].source_message_ids).toEqual(record.source_message_ids);

    store.close();
  });
});
