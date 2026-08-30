import { describe, expect, it } from "vitest";
import {
  classifyVersionQueryIntent,
  memoryVersionContextApplies,
  memoryVersionWriteDomainsEqual,
  selectVersionAwareCandidates,
  type MemoryVersionContext,
} from "./version-scope.js";

function context(overrides: Partial<MemoryVersionContext> = {}): MemoryVersionContext {
  return {
    schemaVersion: 1,
    repositoryId: "repo-a",
    branch: "main",
    commitSha: "11111111111111111111",
    worktreeId: "wt-main",
    taskId: "task-a",
    scopeLevel: "task",
    source: "explicit",
    ...overrides,
  };
}

function candidate(id: string, versionContext?: MemoryVersionContext) {
  return { id, content: `value-${id}`, line: `- [work_fact] value-${id}`, score: 1, versionContext };
}

describe("version-aware multi-state selection", () => {
  it("keeps simultaneously valid repository, branch, worktree, and task state while suppressing siblings", () => {
    const current = context();
    const candidates = [
      candidate("other-task", context({ taskId: "task-b" })),
      candidate("other-worktree", context({ worktreeId: "wt-other", taskId: "task-a" })),
      candidate("other-branch", context({ branch: "release", worktreeId: "wt-release" })),
      candidate("repository", context({ scopeLevel: "repository", branch: undefined, worktreeId: undefined, taskId: undefined })),
      candidate("branch", context({ scopeLevel: "branch", worktreeId: undefined, taskId: undefined })),
      candidate("worktree", context({ scopeLevel: "worktree", taskId: undefined })),
      candidate("task", current),
      candidate("legacy"),
    ];
    const result = selectVersionAwareCandidates({
      candidates,
      query: "当前应该使用哪个值？",
      current,
      enabled: true,
      resultLimit: 5,
      maxVersionStates: 6,
    });

    expect(result.candidates.map((item) => item.id)).toEqual(["task", "worktree", "branch", "repository"]);
    expect(result.suppressedCandidates).toBe(4);
    expect(result.activeStates).toBe(4);
    expect(result.candidates.every((item) => item.line.includes("active_here=yes"))).toBe(true);
  });

  it("returns labelled sibling states only for explicit compare/migrate/regression/history intent", () => {
    const current = context({ scopeLevel: "worktree", taskId: undefined });
    const result = selectVersionAwareCandidates({
      candidates: [
        candidate("release", context({ branch: "release", worktreeId: "wt-release", scopeLevel: "worktree", taskId: undefined })),
        candidate("main", current),
        candidate("other-repo", context({ repositoryId: "repo-b" })),
      ],
      query: "比较 main 和 release 分支的差异",
      current,
      enabled: true,
      resultLimit: 5,
      maxVersionStates: 5,
    });

    expect(result.status).toBe("comparison");
    expect(result.candidates.map((item) => item.id)).toEqual(["release", "main"]);
    expect(result.candidates[0].line).toContain("branch=release");
    expect(result.candidates[0].line).toContain("active_here=no");
    expect(result.candidates[1].line).toContain("active_here=yes");
  });

  it("abstains from scoped memory when repository context is unavailable", () => {
    const result = selectVersionAwareCandidates({
      candidates: [candidate("scoped", context()), candidate("legacy")],
      query: "当前值是什么？",
      enabled: true,
      resultLimit: 5,
      maxVersionStates: 5,
    });

    expect(result.status).toBe("missing_context_abstained");
    expect(result.candidates.map((item) => item.id)).toEqual(["legacy"]);
    expect(result.suppressedCandidates).toBe(1);
  });

  it("keeps write-time dedup inside one exact validity domain", () => {
    expect(memoryVersionWriteDomainsEqual(context(), context({ commitSha: "newer" }))).toBe(true);
    expect(memoryVersionWriteDomainsEqual(context(), context({ branch: "release" }))).toBe(false);
    expect(memoryVersionWriteDomainsEqual(
      context({ scopeLevel: "branch", worktreeId: "wt-a", taskId: "task-a" }),
      context({ scopeLevel: "branch", worktreeId: "wt-b", taskId: "task-b" }),
    )).toBe(true);
    expect(memoryVersionWriteDomainsEqual(
      context({ scopeLevel: "worktree", taskId: "task-a" }),
      context({ scopeLevel: "worktree", taskId: "task-b" }),
    )).toBe(true);
    expect(memoryVersionWriteDomainsEqual(undefined, undefined)).toBe(true);
    expect(memoryVersionWriteDomainsEqual(undefined, context())).toBe(false);
    expect(memoryVersionContextApplies(context({ scopeLevel: "branch", worktreeId: undefined, taskId: undefined }), context())).toBe(true);
  });

  it("classifies comparison, migration, regression, history, and ordinary current queries deterministically", () => {
    expect(classifyVersionQueryIntent("比较 main 和 release")).toBe("scope_comparison");
    expect(classifyVersionQueryIntent("如何迁移到新分支？")).toBe("migration");
    expect(classifyVersionQueryIntent("这个回归从哪个版本引入？")).toBe("regression");
    expect(classifyVersionQueryIntent("查看配置演进历史")).toBe("scope_history");
    expect(classifyVersionQueryIntent("当前测试命令是什么？")).toBe("current_scope");
    expect(classifyVersionQueryIntent("What is the current service port?")).toBe("current_scope");
    expect(classifyVersionQueryIntent("Port this service to the release branch")).toBe("migration");
  });

  it("does not mix worktree or task states into an explicit branch comparison", () => {
    const current = context({ scopeLevel: "branch", worktreeId: undefined, taskId: undefined });
    const result = selectVersionAwareCandidates({
      candidates: [
        candidate("main-task", context()),
        candidate("main", current),
        candidate("release-task", context({ branch: "release", taskId: "release-task" })),
        candidate("release", context({ branch: "release", scopeLevel: "branch", worktreeId: undefined, taskId: undefined })),
      ],
      query: "Compare the release branch with main",
      current,
      enabled: true,
      resultLimit: 6,
      maxVersionStates: 6,
    });

    expect(result.candidates.map((item) => item.id)).toEqual(["main", "release"]);
  });
});
