export const MEMORY_VERSION_CONTEXT_METADATA_KEY = "memory_version_context";

export type MemoryVersionScopeLevel = "repository" | "branch" | "worktree" | "task";
export type MemoryVersionContextSource = "git" | "explicit" | "imported";

/**
 * Version-aware validity coordinates stored with an L1 memory.
 *
 * Paths and remote URLs are deliberately not persisted. repositoryId and
 * worktreeId are opaque hashes produced by the Git detector (or stable ids
 * supplied by the host).
 */
export interface MemoryVersionContext {
  schemaVersion: 1;
  repositoryId: string;
  branch?: string;
  commitSha?: string;
  worktreeId?: string;
  taskId?: string;
  scopeLevel: MemoryVersionScopeLevel;
  source?: MemoryVersionContextSource;
}

export type VersionQueryIntent =
  | "current_scope"
  | "scope_comparison"
  | "migration"
  | "regression"
  | "scope_history";

export type VersionScopeStatus =
  | "disabled"
  | "active"
  | "comparison"
  | "missing_context_abstained";

export interface VersionAwareCandidate {
  id: string;
  content: string;
  line: string;
  score?: number;
  versionContext?: MemoryVersionContext;
  /** A present but malformed scope is quarantined, never treated as legacy. */
  versionContextInvalid?: boolean;
}

export interface VersionAwareSelection<T extends VersionAwareCandidate> {
  candidates: T[];
  intent: VersionQueryIntent;
  status: VersionScopeStatus;
  inputCandidates: number;
  scopedCandidates: number;
  legacyCandidates: number;
  suppressedCandidates: number;
  labeledStates: number;
  activeStates: number;
}

const SCOPE_LEVELS = new Set<MemoryVersionScopeLevel>([
  "repository",
  "branch",
  "worktree",
  "task",
]);

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeMemoryVersionContext(value: unknown): MemoryVersionContext | undefined {
  const raw = readObject(value);
  if (!raw || raw.schemaVersion !== 1) return undefined;
  const repositoryId = clean(raw.repositoryId);
  const scopeLevel = clean(raw.scopeLevel) as MemoryVersionScopeLevel | undefined;
  if (!repositoryId || !scopeLevel || !SCOPE_LEVELS.has(scopeLevel)) return undefined;

  const branch = clean(raw.branch);
  const commitSha = clean(raw.commitSha);
  const worktreeId = clean(raw.worktreeId);
  const taskId = clean(raw.taskId);
  const sourceRaw = clean(raw.source);
  const source = sourceRaw === "git" || sourceRaw === "explicit" || sourceRaw === "imported"
    ? sourceRaw
    : undefined;

  if (scopeLevel === "branch" && !branch) return undefined;
  if (scopeLevel === "worktree" && (!branch || !worktreeId)) return undefined;
  if (scopeLevel === "task" && (!branch || !worktreeId || !taskId)) return undefined;
  if (scopeLevel !== "repository" && (branch === "HEAD" || branch?.startsWith("detached@")) && !commitSha) return undefined;

  return {
    schemaVersion: 1,
    repositoryId,
    scopeLevel,
    ...(branch ? { branch } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(source ? { source } : {}),
  };
}

export function parseMemoryVersionContextFromMetadata(metadata: unknown): MemoryVersionContext | undefined {
  const raw = readObject(metadata);
  return normalizeMemoryVersionContext(raw?.[MEMORY_VERSION_CONTEXT_METADATA_KEY]);
}

export function memoryVersionMetadataIsInvalid(metadata: unknown): boolean {
  const raw = readObject(metadata);
  return !!raw && Object.hasOwn(raw, MEMORY_VERSION_CONTEXT_METADATA_KEY)
    && !normalizeMemoryVersionContext(raw[MEMORY_VERSION_CONTEXT_METADATA_KEY]);
}

export function withMemoryVersionContext(
  metadata: unknown,
  context: MemoryVersionContext | undefined,
): Record<string, unknown> {
  const object = readObject(metadata);
  const base = object ? { ...object } : {};
  const normalized = normalizeMemoryVersionContext(context);
  if (normalized) base[MEMORY_VERSION_CONTEXT_METADATA_KEY] = normalized;
  return base;
}

export function memoryVersionScopeKey(context: MemoryVersionContext | undefined): string {
  if (!context) return "legacy";
  // Detached states are immutable snapshots. The display branch (including
  // a shortened detached@ prefix) is not a sufficient write-domain key.
  const branchIdentity = detachedBranch(context)
    ? [context.branch ?? "", context.commitSha ?? ""]
    : context.branch ?? "";
  switch (context.scopeLevel) {
    case "repository":
      return JSON.stringify([context.repositoryId, "repository"]);
    case "branch":
      return JSON.stringify([context.repositoryId, "branch", branchIdentity]);
    case "worktree":
      return JSON.stringify([
        context.repositoryId,
        "worktree",
        branchIdentity,
        context.worktreeId ?? "",
      ]);
    case "task":
      return JSON.stringify([
        context.repositoryId,
        "task",
        branchIdentity,
        context.worktreeId ?? "",
        context.taskId ?? "",
      ]);
  }
}

/** Write-time dedup is exact-domain only; a branch fact may not replace a sibling branch fact. */
export function memoryVersionWriteDomainsEqual(
  left: MemoryVersionContext | undefined,
  right: MemoryVersionContext | undefined,
): boolean {
  return memoryVersionScopeKey(left) === memoryVersionScopeKey(right);
}

function detachedBranch(context: MemoryVersionContext): boolean {
  return context.branch === "HEAD" || context.branch?.startsWith("detached@") === true;
}

/** Whether a stored state is valid for the current execution scope. */
export function memoryVersionContextApplies(
  stored: MemoryVersionContext,
  current: MemoryVersionContext,
): boolean {
  if (stored.repositoryId !== current.repositoryId) return false;
  if (stored.scopeLevel === "repository") return true;
  if (stored.branch !== current.branch) return false;
  if (detachedBranch(stored) && (!stored.commitSha || stored.commitSha !== current.commitSha)) return false;
  if (stored.scopeLevel === "branch") return true;
  if (stored.worktreeId !== current.worktreeId) return false;
  if (stored.scopeLevel === "worktree") return true;
  return stored.taskId === current.taskId;
}

export function memoryVersionSpecificity(context: MemoryVersionContext): number {
  switch (context.scopeLevel) {
    case "task": return 4;
    case "worktree": return 3;
    case "branch": return 2;
    case "repository": return 1;
  }
}

export function classifyVersionQueryIntent(query: string): VersionQueryIntent {
  const normalized = query.toLowerCase();
  if (/\b(migrat(?:e|ion|ing)|upgrade path|porting|port\s+(?:(?:this|the)\s+)?\w+(?:\s+\w+)?\s+to)\b|迁移|升级路径|移植/u.test(normalized)) {
    return "migration";
  }
  if (/\b(regression|regressed|bisect|root cause across)\b|回归|退化|回退原因|定位引入/u.test(normalized)) {
    return "regression";
  }
  if (/\b(history|historical|evolution|timeline)\b|历史|演进|时间线/u.test(normalized)) {
    return "scope_history";
  }
  if (/\b(compare|comparison|difference|different|versus|vs\.?|between branches|between versions)\b|对比|比较|差异|区别|两个分支|不同版本/u.test(normalized)) {
    return "scope_comparison";
  }
  return "current_scope";
}

export function versionIntentAllowsMultipleStates(intent: VersionQueryIntent): boolean {
  return intent !== "current_scope";
}

function short(value: string | undefined, max = 18): string {
  if (!value) return "-";
  return value.length > max ? value.slice(0, max) : value;
}

export function formatMemoryVersionLabel(
  context: MemoryVersionContext,
  current: MemoryVersionContext | undefined,
  multiState: boolean,
): string {
  const active = current ? memoryVersionContextApplies(context, current) : false;
  const fields = [
    `branch=${short(context.branch)}`,
    `commit=${short(context.commitSha, 10)}`,
    `worktree=${short(context.worktreeId, 10)}`,
    `task=${short(context.taskId, 12)}`,
    `scope=${context.scopeLevel}`,
  ];
  return `[${multiState ? "VERSION STATE" : "ACTIVE SCOPE"}; ${fields.join("; ")}; active_here=${active ? "yes" : "no"}]`;
}

function labelCandidate<T extends VersionAwareCandidate>(
  candidate: T,
  current: MemoryVersionContext | undefined,
  multiState: boolean,
): T {
  if (!candidate.versionContext) {
    const prefix = "[LEGACY UNSCOPED]";
    return {
      ...candidate,
      content: `${prefix} ${candidate.content}`,
      line: `- [legacy-unscoped] ${candidate.content}`,
    };
  }
  const label = formatMemoryVersionLabel(candidate.versionContext, current, multiState);
  return {
    ...candidate,
    content: `${label} ${candidate.content}`,
    line: `- [version-state] ${label} ${candidate.content}`,
  };
}

/**
 * Select the valid state for ordinary execution and bounded, labelled states
 * for explicit comparison/migration/regression/history queries.
 */
export function selectVersionAwareCandidates<T extends VersionAwareCandidate>(params: {
  candidates: T[];
  query: string;
  current?: MemoryVersionContext;
  enabled: boolean;
  resultLimit: number;
  maxVersionStates: number;
}): VersionAwareSelection<T> {
  const intent = classifyVersionQueryIntent(params.query);
  const scoped = params.candidates.filter((candidate) => candidate.versionContext && !candidate.versionContextInvalid);
  const legacy = params.candidates.filter((candidate) => !candidate.versionContext && !candidate.versionContextInvalid);
  if (!params.enabled) {
    return {
      candidates: params.candidates,
      intent,
      status: "disabled",
      inputCandidates: params.candidates.length,
      scopedCandidates: scoped.length,
      legacyCandidates: legacy.length,
      suppressedCandidates: 0,
      labeledStates: 0,
      activeStates: 0,
    };
  }

  if (!params.current) {
    const kept = legacy.slice(0, params.resultLimit);
    return {
      candidates: kept,
      intent,
      status: "missing_context_abstained",
      inputCandidates: params.candidates.length,
      scopedCandidates: scoped.length,
      legacyCandidates: legacy.length,
      suppressedCandidates: params.candidates.length - kept.length,
      labeledStates: 0,
      activeStates: 0,
    };
  }

  if (versionIntentAllowsMultipleStates(intent)) {
    const sameRepository = scoped
      .filter((candidate) => candidate.versionContext!.repositoryId === params.current!.repositoryId);
    const queryLower = params.query.toLowerCase();
    const explicitlyNamed = sameRepository.filter((candidate) => {
      const branch = candidate.versionContext?.branch?.toLowerCase();
      if (!branch) return false;
      const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match a ref token, not a substring of another ref or an ordinary word.
      return new RegExp(`(^|[^a-z0-9_./-])${escaped}(?=$|[^a-z0-9_./-]|[.](?=\\s|$))`, "u").test(queryLower);
    });
    const namedBranches = new Set(explicitlyNamed.map((candidate) => candidate.versionContext!.branch));
    const namedBranchStates = explicitlyNamed.filter(
      (candidate) => candidate.versionContext?.scopeLevel === "branch",
    );
    const namedBranchStateNames = new Set(
      namedBranchStates.map((candidate) => candidate.versionContext!.branch),
    );
    // A branch name is inherited by worktree/task scopes. When two branch
    // names are explicit and both have branch-scoped states, comparing those
    // branches must not accidentally pull every task living on either branch.
    const comparisonPool = intent === "scope_history" && namedBranches.size > 0
      ? explicitlyNamed
      : namedBranches.size >= 2 && namedBranchStateNames.size >= 2
      ? namedBranchStates
      : namedBranches.size >= 2
        ? explicitlyNamed
        : sameRepository;
    // First reserve one slot per validity domain so a highly ranked branch
    // cannot crowd every sibling state out of an explicit comparison.
    const firstByScope: T[] = [];
    const overflow: T[] = [];
    const seenScopes = new Set<string>();
    for (const candidate of comparisonPool) {
      const key = memoryVersionScopeKey(candidate.versionContext);
      if (seenScopes.has(key)) overflow.push(candidate);
      else {
        seenScopes.add(key);
        firstByScope.push(candidate);
      }
    }
    const diverseStates = [...firstByScope, ...overflow].slice(0, params.maxVersionStates);
    const remaining = Math.max(0, params.resultLimit - diverseStates.length);
    const selectedRaw = [...diverseStates, ...legacy.slice(0, remaining)].slice(0, params.resultLimit);
    const selected = selectedRaw.map((candidate) => labelCandidate(candidate, params.current, true));
    return {
      candidates: selected,
      intent,
      status: "comparison",
      inputCandidates: params.candidates.length,
      scopedCandidates: scoped.length,
      legacyCandidates: legacy.length,
      suppressedCandidates: params.candidates.length - selected.length,
      labeledStates: selectedRaw.filter((candidate) => candidate.versionContext).length,
      activeStates: selectedRaw.filter((candidate) => candidate.versionContext && memoryVersionContextApplies(candidate.versionContext, params.current!)).length,
    };
  }

  const rank = new Map(params.candidates.map((candidate, index) => [candidate.id, index]));
  const compatible = scoped
    .filter((candidate) => memoryVersionContextApplies(candidate.versionContext!, params.current!))
    .sort((left, right) => {
      const specificity = memoryVersionSpecificity(right.versionContext!) - memoryVersionSpecificity(left.versionContext!);
      return specificity || (rank.get(left.id)! - rank.get(right.id)!);
    });
  // Legacy memories remain readable only when no scoped state was found for
  // this retrieval pool; this prevents an unlabelled old fact competing with
  // an exact branch/worktree/task state.
  // Explicit questions about this task/worktree should not inject ancestor
  // defaults alongside that level's answer. Generic queries still retain
  // compatible facts from every level (they may concern different subjects).
  const requestedLevel = /\b(?:current\s+(?:parallel\s+)?task|this\s+task)\b|当前(?:并行)?任务|本次任务/u.test(params.query.toLowerCase())
    ? "task"
    : /\b(?:current\s+(?:detached\s+)?worktree|this\s+worktree)\b|当前工作树|当前工作区/u.test(params.query.toLowerCase())
      ? "worktree" : undefined;
  const levelMatches = requestedLevel ? compatible.filter(candidate => candidate.versionContext?.scopeLevel === requestedLevel) : [];
  const selectedRaw = (levelMatches.length > 0 ? levelMatches : compatible.length > 0 ? compatible : legacy).slice(0, params.resultLimit);
  const selected = compatible.length > 0
    ? selectedRaw.map((candidate) => labelCandidate(candidate, params.current, false))
    : selectedRaw;
  return {
    candidates: selected,
    intent,
    status: "active",
    inputCandidates: params.candidates.length,
    scopedCandidates: scoped.length,
    legacyCandidates: legacy.length,
    suppressedCandidates: params.candidates.length - selected.length,
    labeledStates: compatible.length > 0 ? selected.length : 0,
    activeStates: compatible.slice(0, params.resultLimit).length,
  };
}
