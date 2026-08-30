import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { MemoryVersionContext, MemoryVersionScopeLevel } from "./version-scope.js";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 2_000;
const cache = new Map<string, { expiresAt: number; value?: MemoryVersionContext }>();

function opaqueId(namespace: string, value: string): string {
  return `${namespace}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/i, "");
  const scp = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, "")}`;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return trimmed.replace(/\/+/g, "/");
  }
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

/** Detect a privacy-preserving Git/worktree execution scope for production recall and capture. */
export async function detectGitMemoryVersionContext(params: {
  workspaceDir: string;
  taskId?: string;
  scopeLevel?: MemoryVersionScopeLevel;
  timeoutMs?: number;
  now?: () => number;
}): Promise<MemoryVersionContext | undefined> {
  const now = params.now ?? Date.now;
  const scopeLevel = params.scopeLevel ?? (params.taskId ? "task" : "worktree");
  const key = JSON.stringify([params.workspaceDir, params.taskId ?? "", scopeLevel]);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) return cached.value;

  const timeoutMs = params.timeoutMs ?? 250;
  try {
    const inside = await git(params.workspaceDir, ["rev-parse", "--is-inside-work-tree"], timeoutMs);
    if (inside !== "true") throw new Error("not a git worktree");
    const [topLevelRaw, commonDirRaw, branchRaw, commitSha, remoteRaw] = await Promise.all([
      git(params.workspaceDir, ["rev-parse", "--show-toplevel"], timeoutMs),
      git(params.workspaceDir, ["rev-parse", "--git-common-dir"], timeoutMs),
      git(params.workspaceDir, ["branch", "--show-current"], timeoutMs),
      git(params.workspaceDir, ["rev-parse", "HEAD"], timeoutMs),
      git(params.workspaceDir, ["config", "--get", "remote.origin.url"], timeoutMs).catch(() => ""),
    ]);
    const topLevel = await realpath(topLevelRaw);
    const commonDir = commonDirRaw.startsWith("/")
      ? await realpath(commonDirRaw)
      : await realpath(`${params.workspaceDir}/${commonDirRaw}`);
    const branch = branchRaw || `detached@${commitSha.slice(0, 12)}`;
    const repositorySeed = remoteRaw ? `remote:${normalizeRemote(remoteRaw)}` : `common-dir:${commonDir}`;
    const value: MemoryVersionContext = {
      schemaVersion: 1,
      repositoryId: opaqueId("repo", repositorySeed),
      branch,
      commitSha,
      worktreeId: opaqueId("wt", topLevel),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      scopeLevel,
      source: "git",
    };
    cache.set(key, { expiresAt: now() + CACHE_TTL_MS, value });
    return value;
  } catch {
    cache.set(key, { expiresAt: now() + CACHE_TTL_MS, value: undefined });
    return undefined;
  }
}

export function clearGitMemoryVersionContextCache(): void {
  cache.clear();
}
