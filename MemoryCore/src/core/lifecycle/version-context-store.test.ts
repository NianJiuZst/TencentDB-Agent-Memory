import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionVersionContext, persistSessionVersionContext } from "./version-context-store.js";
import type { MemoryVersionContext } from "./version-scope.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

function taskContext(taskId: string): MemoryVersionContext {
  return {
    schemaVersion: 1,
    repositoryId: "repo-a",
    branch: "main",
    commitSha: "abc123",
    worktreeId: "wt-a",
    taskId,
    scopeLevel: "task",
    source: "explicit",
  };
}

describe("session version context persistence", () => {
  it("keeps parallel tasks separate even when they share a session", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "version-context-store-"));
    cleanup.push(baseDir);
    await persistSessionVersionContext({
      baseDir,
      sessionKey: "shared-session",
      sessionId: "shared-id",
      taskId: "task-a",
      context: taskContext("task-a"),
    });
    await persistSessionVersionContext({
      baseDir,
      sessionKey: "shared-session",
      sessionId: "shared-id",
      taskId: "task-b",
      context: taskContext("task-b"),
    });

    await expect(loadSessionVersionContext({
      baseDir,
      sessionKey: "shared-session",
      sessionId: "shared-id",
      taskId: "task-a",
    })).resolves.toMatchObject({ taskId: "task-a" });
    await expect(loadSessionVersionContext({
      baseDir,
      sessionKey: "shared-session",
      sessionId: "shared-id",
      taskId: "task-b",
    })).resolves.toMatchObject({ taskId: "task-b" });
  });
});
