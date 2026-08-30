import path from "node:path";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import {
  memoryVersionContextApplies,
  normalizeMemoryVersionContext,
  type MemoryVersionScopeLevel,
} from "./version-scope.js";

export interface LifecycleFeedbackScope {
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  sessionKey?: string;
  /** Opaque repository identity shared by all worktrees of one clone. */
  repositoryId?: string;
  branch?: string;
  commitSha?: string;
  /** Opaque identity of the concrete Git worktree. */
  worktreeId?: string;
  versionScopeLevel?: MemoryVersionScopeLevel;
}

export interface LifecycleFeedbackEvent {
  schemaVersion: 1;
  eventId: string;
  kind: "update" | "delete";
  occurredAtMs: number;
  /** Policy trust weight. This is deliberately not described as a calibrated probability. */
  confidence: number;
  source: "l1-dedup-update" | "l1-dedup-merge" | "explicit-correction" | "test";
  predecessorMemoryIds: string[];
  successorMemoryIds: string[];
  scope: LifecycleFeedbackScope;
}

export interface LifecycleFeedbackLoadResult {
  events: LifecycleFeedbackEvent[];
  filesRead: number;
}

function shardDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`invalid lifecycle feedback ${field}`);
  }
  return [...new Set(value)];
}

export function parseLifecycleFeedbackEvent(value: unknown): LifecycleFeedbackEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid lifecycle feedback event");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("unsupported lifecycle feedback schema");
  if (typeof raw.eventId !== "string" || raw.eventId.length === 0) throw new Error("invalid lifecycle feedback eventId");
  if (raw.kind !== "update" && raw.kind !== "delete") throw new Error("invalid lifecycle feedback kind");
  if (!Number.isFinite(raw.occurredAtMs) || Number(raw.occurredAtMs) <= 0) {
    throw new Error("invalid lifecycle feedback occurredAtMs");
  }
  if (!Number.isFinite(raw.confidence) || Number(raw.confidence) < 0 || Number(raw.confidence) > 1) {
    throw new Error("invalid lifecycle feedback confidence");
  }
  const sources = new Set(["l1-dedup-update", "l1-dedup-merge", "explicit-correction", "test"]);
  if (typeof raw.source !== "string" || !sources.has(raw.source)) throw new Error("invalid lifecycle feedback source");
  const scopeRaw = raw.scope;
  if (!scopeRaw || typeof scopeRaw !== "object" || Array.isArray(scopeRaw)) {
    throw new Error("invalid lifecycle feedback scope");
  }
  const scopeObject = scopeRaw as Record<string, unknown>;
  const scope: LifecycleFeedbackScope = {};
  for (const key of [
    "teamId",
    "userId",
    "agentId",
    "taskId",
    "sessionKey",
    "repositoryId",
    "branch",
    "commitSha",
    "worktreeId",
  ] as const) {
    const item = scopeObject[key];
    if (item !== undefined) {
      if (typeof item !== "string" || item.length === 0) throw new Error(`invalid lifecycle feedback scope.${key}`);
      scope[key] = item;
    }
  }
  const rawScopeLevel = scopeObject.versionScopeLevel;
  if (rawScopeLevel !== undefined) {
    if (!["repository", "branch", "worktree", "task"].includes(String(rawScopeLevel))) {
      throw new Error("invalid lifecycle feedback scope.versionScopeLevel");
    }
    scope.versionScopeLevel = rawScopeLevel as MemoryVersionScopeLevel;
  }
  const predecessorMemoryIds = assertStringArray(raw.predecessorMemoryIds, "predecessorMemoryIds");
  const successorMemoryIds = assertStringArray(raw.successorMemoryIds, "successorMemoryIds");
  if (predecessorMemoryIds.length === 0) throw new Error("lifecycle feedback requires a predecessor");
  if (raw.kind === "update" && successorMemoryIds.length === 0) {
    throw new Error("lifecycle update feedback requires a successor");
  }
  return {
    schemaVersion: 1,
    eventId: raw.eventId,
    kind: raw.kind,
    occurredAtMs: Number(raw.occurredAtMs),
    confidence: Number(raw.confidence),
    source: raw.source as LifecycleFeedbackEvent["source"],
    predecessorMemoryIds,
    successorMemoryIds,
    scope,
  };
}

export function lifecycleFeedbackMatchesScope(
  eventScope: LifecycleFeedbackScope,
  recallScope: LifecycleFeedbackScope,
): boolean {
  // L1 recall is intentionally cross-session. sessionKey remains audit evidence
  // on the event but is not a release boundary; team/user/agent/task are.
  for (const key of ["teamId", "userId", "agentId"] as const) {
    if (eventScope[key] !== undefined && eventScope[key] !== recallScope[key]) return false;
  }
  // taskId is enforced when the recall call knows it. Without task context,
  // the cross-session L1 boundary remains team/user/agent.
  if (
    (eventScope.repositoryId === undefined || eventScope.versionScopeLevel === "task") &&
    recallScope.taskId !== undefined &&
    eventScope.taskId !== undefined &&
    eventScope.taskId !== recallScope.taskId
  ) {
    return false;
  }
  // Version-scoped events never cross repository/branch/worktree/task validity
  // boundaries. Legacy events without repositoryId retain the previous
  // team/user/agent/task behavior for backwards compatibility.
  if (eventScope.repositoryId !== undefined) {
    const eventContext = normalizeMemoryVersionContext({
      schemaVersion: 1,
      repositoryId: eventScope.repositoryId,
      branch: eventScope.branch,
      commitSha: eventScope.commitSha,
      worktreeId: eventScope.worktreeId,
      taskId: eventScope.taskId,
      scopeLevel: eventScope.versionScopeLevel ?? "branch",
      source: "explicit",
    });
    const recallContext = normalizeMemoryVersionContext({
      schemaVersion: 1,
      repositoryId: recallScope.repositoryId,
      branch: recallScope.branch,
      commitSha: recallScope.commitSha,
      worktreeId: recallScope.worktreeId,
      taskId: recallScope.taskId,
      scopeLevel: recallScope.versionScopeLevel ?? (recallScope.taskId ? "task" : "worktree"),
      source: "explicit",
    });
    if (!eventContext || !recallContext || !memoryVersionContextApplies(eventContext, recallContext)) return false;
  }
  return true;
}

export async function appendLifecycleFeedbackEvent(params: {
  event: LifecycleFeedbackEvent;
  baseDir: string;
  storage?: StorageAdapter;
}): Promise<void> {
  const event = parseLifecycleFeedbackEvent(params.event);
  const key = StoragePaths.lifecycleEvents(shardDate(event.occurredAtMs));
  const line = `${JSON.stringify(event)}\n`;
  if (params.storage) {
    await params.storage.appendFile(key, line);
    return;
  }
  const fs = await import("node:fs/promises");
  const targetDir = path.join(params.baseDir, StoragePaths.lifecycleEventsDir);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.appendFile(path.join(params.baseDir, key), line, "utf-8");
}

async function listFeedbackKeys(baseDir: string, storage?: StorageAdapter): Promise<string[]> {
  if (storage) {
    const entries = await storage.readdir(StoragePaths.lifecycleEventsDir, ".jsonl");
    return entries.filter((entry) => !entry.isDirectory).map((entry) => entry.key).sort().reverse();
  }
  const fs = await import("node:fs/promises");
  try {
    const names = await fs.readdir(path.join(baseDir, StoragePaths.lifecycleEventsDir));
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .reverse()
      .map((name) => `${StoragePaths.lifecycleEventsDir}${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readFeedbackKey(baseDir: string, key: string, storage?: StorageAdapter): Promise<string> {
  if (storage) return (await storage.readFile(key)) ?? "";
  const fs = await import("node:fs/promises");
  return fs.readFile(path.join(baseDir, key), "utf-8");
}

export async function loadLifecycleFeedbackEvents(params: {
  baseDir: string;
  storage?: StorageAdapter;
  scope: LifecycleFeedbackScope;
  maxEvents: number;
}): Promise<LifecycleFeedbackLoadResult> {
  if (!Number.isInteger(params.maxEvents) || params.maxEvents <= 0) {
    throw new Error("lifecycle maxEvents must be a positive integer");
  }
  const keys = await listFeedbackKeys(params.baseDir, params.storage);
  const events: LifecycleFeedbackEvent[] = [];
  let filesRead = 0;
  for (const key of keys) {
    const raw = await readFeedbackKey(params.baseDir, key, params.storage);
    filesRead += 1;
    const lines = raw.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index].trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`corrupt lifecycle feedback ${key}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const event = parseLifecycleFeedbackEvent(parsed);
      if (!lifecycleFeedbackMatchesScope(event.scope, params.scope)) continue;
      events.push(event);
      if (events.length >= params.maxEvents) break;
    }
    if (events.length >= params.maxEvents) break;
  }
  events.sort((left, right) => left.occurredAtMs - right.occurredAtMs || left.eventId.localeCompare(right.eventId));
  return { events, filesRead };
}
