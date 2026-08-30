import { createHash } from "node:crypto";
import path from "node:path";
import type { StorageAdapter } from "../storage/adapter.js";
import { normalizeMemoryVersionContext, type MemoryVersionContext } from "./version-scope.js";

const VERSION_CONTEXT_DIR = "lifecycle/version-contexts/";

function contextKey(sessionKey: string, sessionId?: string, taskId?: string): string {
  const digest = createHash("sha256")
    .update(sessionKey)
    .update("\0")
    .update(sessionId ?? "")
    .update("\0")
    .update(taskId ?? "")
    .digest("hex");
  return `${VERSION_CONTEXT_DIR}${digest}.json`;
}

interface StoredVersionContext {
  schemaVersion: 1;
  updatedAtMs: number;
  context: MemoryVersionContext;
}

export async function persistSessionVersionContext(params: {
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  context: MemoryVersionContext;
  storage?: StorageAdapter;
  now?: () => number;
}): Promise<void> {
  const context = normalizeMemoryVersionContext(params.context);
  if (!context) throw new Error("invalid session memory version context");
  const payload: StoredVersionContext = {
    schemaVersion: 1,
    updatedAtMs: (params.now ?? Date.now)(),
    context,
  };
  const key = contextKey(params.sessionKey, params.sessionId, params.taskId ?? context.taskId);
  if (params.storage) {
    await params.storage.writeFile(key, `${JSON.stringify(payload)}\n`);
    return;
  }
  const fs = await import("node:fs/promises");
  const target = path.join(params.baseDir, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function loadSessionVersionContext(params: {
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  storage?: StorageAdapter;
}): Promise<MemoryVersionContext | undefined> {
  const key = contextKey(params.sessionKey, params.sessionId, params.taskId);
  let raw: string | null;
  if (params.storage) {
    raw = await params.storage.readFile(key);
  } else {
    const fs = await import("node:fs/promises");
    try {
      raw = await fs.readFile(path.join(params.baseDir, key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredVersionContext>;
    if (parsed.schemaVersion !== 1) return undefined;
    return normalizeMemoryVersionContext(parsed.context);
  } catch {
    return undefined;
  }
}
