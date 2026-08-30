import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLifecycleFeedbackEvent } from "./feedback-store.js";
import { applyPersistedLifecycle } from "./production-runtime.js";
import type { LifecyclePolicy } from "./types.js";

const tempDirs: string[] = [];
const policy: LifecyclePolicy = {
  enabled: true,
  minConfidence: 0.85,
  maxHops: 1,
  maxExpansions: 64,
  resultLimit: 2,
  timeoutMs: 10,
};

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lifecycle-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("production lifecycle runtime", () => {
  it("redirects an exact stale id and preserves Base rank order", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: "correction-1",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old"],
        successorMemoryIds: ["new"],
        scope: { userId: "alice", sessionKey: "s1" },
      },
    });
    const result = await applyPersistedLifecycle({
      candidates: [{ id: "old", content: "old value" }, { id: "filler", content: "stable value" }],
      policy,
      maxEvents: 100,
      baseDir,
      scope: { userId: "alice", sessionKey: "s1" },
      materialize: async () => [{ id: "new", content: "new value" }],
    });

    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["new", "filler"]);
    expect(result.decision).toMatchObject({ mode: "adaptive", redirects: 1 });
  });

  it("returns the exact Base prefix when a successor cannot be materialized", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: "missing-successor",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old"],
        successorMemoryIds: ["missing"],
        scope: { userId: "alice", sessionKey: "s1" },
      },
    });
    const candidates = [{ id: "old", content: "old value" }, { id: "filler", content: "stable value" }];
    const result = await applyPersistedLifecycle({
      candidates,
      policy,
      maxEvents: 100,
      baseDir,
      scope: { userId: "alice", sessionKey: "s1" },
      materialize: async () => [],
    });

    expect(result.candidates).toEqual(candidates);
    expect(result.decision.mode).toBe("fallback");
    expect(result.decision.fallbackReason).toContain("missing successor");
  });

  it("does not apply an event from another scope", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: "bob-only",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old"],
        successorMemoryIds: ["new"],
        scope: { userId: "bob", sessionKey: "s1" },
      },
    });
    const result = await applyPersistedLifecycle({
      candidates: [{ id: "old", content: "old value" }],
      policy: { ...policy, resultLimit: 1 },
      maxEvents: 100,
      baseDir,
      scope: { userId: "alice", sessionKey: "s1" },
      materialize: async () => { throw new Error("must not materialize cross-scope data"); },
    });

    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["old"]);
    expect(result.decision.redirects).toBe(0);
  });

  it("returns Base on corrupt persistent state", async () => {
    const baseDir = await tempDir();
    const dir = path.join(baseDir, "lifecycle-events");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "2026-08-30.jsonl"), "not-json\n", "utf-8");
    const candidates = [{ id: "old", content: "old value" }];
    const result = await applyPersistedLifecycle({
      candidates,
      policy: { ...policy, resultLimit: 1 },
      maxEvents: 100,
      baseDir,
      scope: {},
      materialize: async () => [],
    });

    expect(result.candidates).toEqual(candidates);
    expect(result.decision.mode).toBe("fallback");
    expect(result.decision.fallbackReason).toContain("corrupt lifecycle feedback");
  });

  it("returns the exact Base prefix when persistent resolution exceeds the sidecar deadline", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: "slow-successor",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old"],
        successorMemoryIds: ["new"],
        scope: { userId: "alice" },
      },
    });
    const candidates = [{ id: "old", content: "old value" }];
    const result = await applyPersistedLifecycle({
      candidates,
      policy: { ...policy, resultLimit: 1, timeoutMs: 5 },
      maxEvents: 100,
      baseDir,
      scope: { userId: "alice" },
      materialize: async () => new Promise((resolve) => setTimeout(() => resolve([
        { id: "new", content: "new value" },
      ]), 50)),
    });

    expect(result.candidates).toEqual(candidates);
    expect(result.decision.mode).toBe("fallback");
    expect(result.decision.fallbackReason).toContain("timed out");
  });

  it("renders a bounded old/current pair for an explicit history query", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: "dual-history",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old"],
        successorMemoryIds: ["new"],
        scope: { userId: "alice" },
      },
    });
    const result = await applyPersistedLifecycle({
      candidates: [{ id: "old", content: "old value", score: 0.9 }],
      policy: { ...policy, resultLimit: 1 },
      maxEvents: 100,
      baseDir,
      scope: { userId: "alice" },
      materialize: async () => [{ id: "new", content: "new value" }],
      dualState: {
        mode: "query_aware",
        query: "What was my previous preference?",
        render: (historical, current) => ({
          ...current,
          content: `HISTORICAL: ${historical.content}\nCURRENT: ${current.content}`,
        }),
      },
    });

    expect(result.candidates).toEqual([{
      id: "new",
      content: "HISTORICAL: old value\nCURRENT: new value",
      score: 0.9,
    }]);
    expect(result.decision).toMatchObject({
      queryIntent: "historical_state",
      dualStatePairs: 1,
      redirects: 1,
    });
  });

  it("keeps the V1 successor unchanged for a current-state query", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: "dual-current",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old"],
        successorMemoryIds: ["new"],
        scope: { userId: "alice" },
      },
    });
    const result = await applyPersistedLifecycle({
      candidates: [{ id: "old", content: "old value" }],
      policy: { ...policy, resultLimit: 1 },
      maxEvents: 100,
      baseDir,
      scope: { userId: "alice" },
      materialize: async () => [{ id: "new", content: "new value" }],
      dualState: {
        mode: "query_aware",
        query: "What is my current preference?",
        render: () => { throw new Error("must not render"); },
      },
    });

    expect(result.candidates).toEqual([{ id: "new", content: "new value" }]);
    expect(result.decision).toMatchObject({ queryIntent: "current_state", dualStatePairs: 0 });
  });

  it("never resurfaces a deleted predecessor in dual-state mode", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: "dual-delete",
        kind: "delete",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old"],
        successorMemoryIds: [],
        scope: { userId: "alice" },
      },
    });
    const result = await applyPersistedLifecycle({
      candidates: [
        { id: "old", content: "deleted value" },
        { id: "stable", content: "stable value" },
      ],
      policy,
      maxEvents: 100,
      baseDir,
      scope: { userId: "alice" },
      materialize: async () => [],
      dualState: {
        mode: "query_aware",
        query: "What was my previous preference?",
        render: () => { throw new Error("delete must not render"); },
      },
    });

    expect(result.candidates.map((candidate) => candidate.id)).not.toContain("old");
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["stable"]);
    expect(result.decision.dualStatePairs).toBe(0);
  });

  it("falls back to the resolved V1 successor when dual-state rendering fails", async () => {
    const baseDir = await tempDir();
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: "dual-render-failure",
        kind: "update",
        occurredAtMs: 1_700_000_000_000,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: ["old"],
        successorMemoryIds: ["new"],
        scope: { userId: "alice" },
      },
    });
    const result = await applyPersistedLifecycle({
      candidates: [{ id: "old", content: "old value" }],
      policy: { ...policy, resultLimit: 1 },
      maxEvents: 100,
      baseDir,
      scope: { userId: "alice" },
      materialize: async () => [{ id: "new", content: "new value" }],
      dualState: {
        mode: "query_aware",
        query: "How did my preference change?",
        render: () => { throw new Error("render failed"); },
      },
    });

    expect(result.candidates).toEqual([{ id: "new", content: "new value" }]);
    expect(result.decision).toMatchObject({
      queryIntent: "state_change",
      dualStatePairs: 0,
      dualStateFallbackReason: "render failed",
    });
  });
});
