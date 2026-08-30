import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendLifecycleFeedbackEvent,
  loadLifecycleFeedbackEvents,
  type LifecycleFeedbackEvent,
} from "./feedback-store.js";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lifecycle-feedback-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function event(eventId: string, userId: string, occurredAtMs: number): LifecycleFeedbackEvent {
  return {
    schemaVersion: 1,
    eventId,
    kind: "update",
    occurredAtMs,
    confidence: 0.95,
    source: "test",
    predecessorMemoryIds: [`${eventId}-old`],
    successorMemoryIds: [`${eventId}-new`],
    scope: { teamId: "team", userId, agentId: "agent", sessionKey: "session" },
  };
}

describe("lifecycle feedback store", () => {
  it("appends JSONL and loads only the requested scope", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({ baseDir, event: event("a", "alice", 1_700_000_000_000) });
    await appendLifecycleFeedbackEvent({ baseDir, event: event("b", "bob", 1_700_000_000_001) });

    const loaded = await loadLifecycleFeedbackEvents({
      baseDir,
      scope: { teamId: "team", userId: "alice", agentId: "agent", sessionKey: "session" },
      maxEvents: 10,
    });

    expect(loaded.events.map((item) => item.eventId)).toEqual(["a"]);
    expect(loaded.filesRead).toBe(1);
  });

  it("fails closed on a corrupt append-only shard", async () => {
    const baseDir = await tempDir();
    const dir = path.join(baseDir, "lifecycle-events");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "2026-08-30.jsonl"), "{broken\n", "utf-8");

    await expect(loadLifecycleFeedbackEvents({
      baseDir,
      scope: {},
      maxEvents: 10,
    })).rejects.toThrow("corrupt lifecycle feedback");
  });

  it("uses the same StorageAdapter path as service deployments", async () => {
    const baseDir = await tempDir();
    const storage = new StorageAdapter(new LocalStorageBackend(baseDir));
    await appendLifecycleFeedbackEvent({
      baseDir,
      storage,
      event: event("adapter", "alice", 1_700_000_000_000),
    });

    const loaded = await loadLifecycleFeedbackEvents({
      baseDir,
      storage,
      scope: { teamId: "team", userId: "alice", agentId: "agent", sessionKey: "session" },
      maxEvents: 10,
    });
    expect(loaded.events.map((item) => item.eventId)).toEqual(["adapter"]);
  });
});
