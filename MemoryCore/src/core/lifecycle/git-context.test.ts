import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearGitMemoryVersionContextCache, detectGitMemoryVersionContext } from "./git-context.js";

const cleanup: string[] = [];

afterEach(async () => {
  clearGitMemoryVersionContextCache();
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

describe("Git memory version context", () => {
  it("shares repository identity but separates branches and worktrees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-version-git-"));
    cleanup.push(root);
    const primary = path.join(root, "primary");
    const release = path.join(root, "release");
    await mkdir(primary);
    git(primary, "init", "-b", "main");
    git(primary, "config", "user.email", "test@example.com");
    git(primary, "config", "user.name", "Version Test");
    await writeFile(path.join(primary, "state.txt"), "main\n", "utf8");
    git(primary, "add", "state.txt");
    git(primary, "commit", "-m", "seed");
    git(primary, "branch", "release");
    git(primary, "worktree", "add", release, "release");

    const mainContext = await detectGitMemoryVersionContext({ workspaceDir: primary });
    const releaseContext = await detectGitMemoryVersionContext({ workspaceDir: release });
    const taskContext = await detectGitMemoryVersionContext({ workspaceDir: primary, taskId: "parallel-a" });

    expect(mainContext?.repositoryId).toBe(releaseContext?.repositoryId);
    expect(mainContext?.branch).toBe("main");
    expect(releaseContext?.branch).toBe("release");
    expect(mainContext?.worktreeId).not.toBe(releaseContext?.worktreeId);
    expect(mainContext?.scopeLevel).toBe("worktree");
    expect(taskContext).toMatchObject({ taskId: "parallel-a", scopeLevel: "task" });
    expect(JSON.stringify(mainContext)).not.toContain(primary);
    expect(JSON.stringify(releaseContext)).not.toContain(release);
    // Same workspace, same task, within the old two-second cache window.
    git(primary, "switch", "-c", "hotfix");
    const switched = await detectGitMemoryVersionContext({ workspaceDir: primary });
    expect(switched?.branch).toBe("hotfix");
    git(primary, "commit", "--allow-empty", "-m", "advance HEAD");
    const advanced = await detectGitMemoryVersionContext({ workspaceDir: primary });
    expect(advanced?.commitSha).not.toBe(switched?.commitSha);
    // Mutating a returned snapshot cannot poison later detections.
    advanced!.branch = "poisoned";
    expect((await detectGitMemoryVersionContext({ workspaceDir: primary }))?.branch).toBe("hotfix");
  });
});
