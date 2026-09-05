import { describe, expect, it } from "vitest";
import { memoryVersionContextApplies, memoryVersionWriteDomainsEqual, normalizeMemoryVersionContext, selectVersionAwareCandidates, type MemoryVersionContext } from "./version-scope.js";

const ctx = (branch: string, extra: Partial<MemoryVersionContext> = {}): MemoryVersionContext => ({
  schemaVersion: 1, repositoryId: "repo", scopeLevel: "branch", branch, ...extra,
});
const item = (id: string, versionContext: MemoryVersionContext) => ({ id, content: id, line: id, versionContext });

describe("version validity boundary regressions", () => {
  it("recognizes branch names followed by sentence punctuation without matching ref prefixes", () => {
    const result = selectVersionAwareCandidates({
      candidates: [item("main", ctx("main")), item("main.old", ctx("main.old")), item("release", ctx("release"))],
      current: ctx("main"), query: "Migrate from release to main. What changes?", enabled: true, resultLimit: 4, maxVersionStates: 4,
    });
    expect(result.candidates.map(c => c.id)).toEqual(["main", "release"]);
  });
  it("answers an explicitly current task question without an ancestor default", () => {
    const task = ctx("main", { scopeLevel: "task", worktreeId: "wt", taskId: "a" });
    const result = selectVersionAwareCandidates({
      candidates: [item("default", ctx("main")), item("task", task)], current: task,
      query: "For the current parallel task alpha, what is the compiler?", enabled: true, resultLimit: 4, maxVersionStates: 4,
    });
    expect(result.candidates.map(c => c.id)).toEqual(["task"]);
  });
  it("requires the complete branch/worktree/task coordinate for task-scoped facts", () => {
    expect(normalizeMemoryVersionContext(ctx("main", { scopeLevel: "task", taskId: "a" }))).toBeUndefined();
  });
  it("does not deduplicate detached HEAD facts across commits", () => {
    expect(memoryVersionWriteDomainsEqual(ctx("HEAD", { commitSha: "aaa" }), ctx("HEAD", { commitSha: "bbb" }))).toBe(false);
  });
  it("requires a commit witness for detached HEAD validity", () => {
    expect(normalizeMemoryVersionContext(ctx("HEAD"))).toBeUndefined();
    expect(memoryVersionContextApplies(ctx("HEAD"), ctx("HEAD"))).toBe(false);
  });
  it("does not treat main as a substring of domain when selecting named branches", () => {
    const result = selectVersionAwareCandidates({
      candidates: [item("main", ctx("main")), item("domain", ctx("domain")), item("release", ctx("release"))],
      current: ctx("domain"), query: "Compare domain with release", enabled: true, resultLimit: 3, maxVersionStates: 3,
    });
    expect(result.candidates.map(c => c.id)).toEqual(["domain", "release"]);
  });
  it("limits an explicitly named branch history to that branch", () => {
    const result = selectVersionAwareCandidates({
      candidates: [item("main", ctx("main")), item("release", ctx("release"))],
      current: ctx("main"), query: "Show history of release", enabled: true, resultLimit: 4, maxVersionStates: 4,
    });
    expect(result.candidates.map(c => c.id)).toEqual(["release"]);
  });
});
