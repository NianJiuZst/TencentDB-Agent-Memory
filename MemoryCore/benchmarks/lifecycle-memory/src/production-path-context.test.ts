import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeProductionRecall } from "./production-path-context.js";
import type { LifecycleEvalQuestion, RetrievedUnit } from "./types.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "production-path-context-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function question(query: string, task: string): LifecycleEvalQuestion {
  return {
    id: `question:${task}`,
    groupId: "weekly:test-user",
    persona: "test-user",
    period: "weekly",
    task,
    query,
    questionDate: "2026-08-30",
    currentSessionIds: ["2"],
    obsoleteSessionIds: ["1"],
    currentAtoms: [],
    obsoleteAtoms: [],
    evaluationQuestions: [],
    memoryPresenceQuestions: 0,
    forgettingAbsenceQuestions: 0,
  };
}

function unit(id: string, content: string, sequence: number): RetrievedUnit {
  return {
    id,
    sessionId: String(sequence),
    role: "user",
    content,
    timestampMs: 1_700_000_000_000 + sequence,
    sequence,
    score: 1,
    tokenCount: 5,
  };
}

describe("production-path context generation", () => {
  it("uses performAutoRecall to inject labelled old/current states for history queries", async () => {
    const pluginDataDir = await tempDir();
    const historical = unit("old", "Previous editor preference: Vim.", 1);
    const current = unit("new", "Current editor preference: VS Code.", 2);
    const history = question("What was my previous editor preference?", "temporal_history");
    await executeProductionRecall({
      question: history,
      persona: "test-user",
      taskId: "history-task",
      arm: "current_only",
      baseCandidates: [historical],
      successor: current,
      update: { predecessorId: "old", successorId: "new", occurredAtMs: current.timestampMs },
      pluginDataDir,
      lifecycleTimeoutMs: 5_000,
    });
    const final = await executeProductionRecall({
      question: history,
      persona: "test-user",
      taskId: "history-task",
      arm: "query_aware_dual",
      baseCandidates: [historical],
      successor: current,
      pluginDataDir,
      lifecycleTimeoutMs: 5_000,
    });

    expect(final.entry.prependContext).toContain("HISTORICAL / SUPERSEDED: Previous editor preference: Vim.");
    expect(final.entry.prependContext).toContain("CURRENT / ACTIVE: Current editor preference: VS Code.");
    expect(final.entry.pairCount).toBe(1);
    expect(final.entry.lifecycleMode).toBe("adaptive");
  });

  it("produces byte-identical reader messages for current questions", async () => {
    const pluginDataDir = await tempDir();
    const historical = unit("old", "Previous editor preference: Vim.", 1);
    const current = unit("new", "Current editor preference: VS Code.", 2);
    const currentQuestion = question("What is my current editor preference?", "temporal_current");
    const baseline = await executeProductionRecall({
      question: currentQuestion,
      persona: "test-user",
      taskId: "current-task",
      arm: "current_only",
      baseCandidates: [historical],
      successor: current,
      update: { predecessorId: "old", successorId: "new", occurredAtMs: current.timestampMs },
      pluginDataDir,
      lifecycleTimeoutMs: 5_000,
    });
    const final = await executeProductionRecall({
      question: currentQuestion,
      persona: "test-user",
      taskId: "current-task",
      arm: "query_aware_dual",
      baseCandidates: [historical],
      successor: current,
      pluginDataDir,
      lifecycleTimeoutMs: 5_000,
    });

    expect(final.entry.messages).toEqual(baseline.entry.messages);
    expect(final.entry.hash).toBe(baseline.entry.hash);
    expect(final.entry.pairCount).toBe(0);
  });
});
