/** Offline, real SQLite + writeMemory + performAutoRecall rank-pressure audit.
 * The source root selects an actual implementation; no policy is reimplemented here.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getEncoding } from "js-tiktoken";
import type { MemoryVersionContext } from "../../src/core/lifecycle/version-scope.js";

const { values } = parseArgs({ options: {
  "core-root": { type: "string", default: process.cwd() },
  output: { type: "string" }, arm: { type: "string", default: "optimized" },
  policy: { type: "string", default: "strict" },
} });
if (!values.output || !["strict", "global"].includes(values.policy!)) throw new Error("--output FILE --policy strict|global required");
const core = path.resolve(values["core-root"]!);
const load = (file: string) => import(pathToFileURL(path.join(core, file)).href);
const [{ parseConfig }, { VectorStore }, { writeMemory }, { performAutoRecall }] = await Promise.all([
  load("src/config.ts"), load("src/core/store/sqlite.ts"), load("src/core/record/l1-writer.ts"), load("src/core/hooks/auto-recall.ts"),
]);
const encoding = getEncoding("cl100k_base");
const sourceFiles = ["src/core/hooks/auto-recall.ts", "src/core/lifecycle/version-scope.ts", "src/core/lifecycle/git-context.ts", "src/core/lifecycle/production-runtime.ts"];
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const rows: Record<string, any>[] = [];
let writes = 0, databases = 0;
const temp = await mkdtemp(path.join(os.tmpdir(), "competition-memory-"));
const query = "Atlas compiler command";
const context = (scopeLevel: "branch" | "worktree" | "task", i: number): MemoryVersionContext => ({
  schemaVersion: 1, repositoryId: "competition-repo", scopeLevel,
  branch: scopeLevel === "branch" ? `branch-${i}` : "main", commitSha: "a".repeat(40),
  worktreeId: scopeLevel === "worktree" ? `worktree-${i}` : "shared-worktree",
  ...(scopeLevel === "task" ? { taskId: `task-${i}` } : {}), source: "explicit",
});
try {
  for (const level of ["branch", "worktree", "task"] as const) for (const k of [1, 2, 4, 8]) {
    const baseDir = path.join(temp, `${level}-${k}`); await mkdir(baseDir);
    const store = new VectorStore(path.join(baseDir, "memory.db"), 0); store.init(); databases++;
    const contexts = new Map<string, MemoryVersionContext>();
    try {
      for (let i = 0; i < 4 * k + 1; i++) {
        const id = `state-${String(i).padStart(3, "0")}`, versionContext = context(level, i);
        contexts.set(id, versionContext);
        const record = await writeMemory({
          memory: { content: `Atlas compiler command is node run variant${String(i).padStart(3, "0")}.`, type: "work_fact", priority: 80, scene_name: "build", source_message_ids: [], metadata: {} },
          decision: { record_id: id, action: "store", target_ids: [] }, baseDir,
          sessionKey: "session", sessionId: "session", teamId: "team", userId: "user", agentId: "agent", vectorStore: store,
          versionContext, lifecycleFeedbackEnabled: false,
        });
        if (!record) throw new Error("L1 write failed"); writes++;
      }
      // Observe actual FTS order; each query activates one of those stored domains.
      // This sweeps all ranks without relying on a guessed BM25 tie-break rule.
      const ranked = await store.searchL1Fts('"Atlas" OR "compiler" OR "command"', 4 * k + 1);
      if (ranked.length !== 4 * k + 1) throw new Error("incomplete SQLite fixture");
      const cfg = parseConfig({ recall: { strategy: "keyword", maxResults: k, scoreThreshold: 0, maxChars: 24000,
        lifecycle: { enabled: true, versionAwareMode: values.policy === "strict" ? "strict" : "off", autoDetectGit: false,
          versionCandidateMultiplier: 4, maxVersionStates: 8, timeoutMs: 100 } } });
      const call = (versionContext?: MemoryVersionContext) => performAutoRecall({
        userText: query, actorId: "user", sessionKey: "session", cfg, pluginDataDir: baseDir, vectorStore: store,
        profileIsolation: { teamId: "team", agentId: "agent" }, versionContext,
      });
      await call(contexts.get(ranked[0].record_id)); // one warm-up, excluded from metrics
      for (let rank = 1; rank <= ranked.length + 1; rank++) {
        const missing = rank > ranked.length;
        const target = missing ? undefined : ranked[rank - 1].record_id;
        const started = performance.now(); const result = await call(target ? contexts.get(target) : undefined);
        const elapsedMs = performance.now() - started;
        if (result?.error) throw new Error(`recall error ${JSON.stringify(result.error)}`);
        const actual: string[] = (result?.recalledL1Memories ?? []).map((m: any) => m.id);
        const expected = target ? [target] : [];
        const expectedPresent = expected.filter(id => actual.includes(id)).length;
        const prompt = { prepend: result?.prependContext ?? "", append: result?.appendSystemContext ?? "" };
        rows.push({ caseId: `${level}-k${k}-${missing ? "missing" : `rank${rank}`}`, level, k, rank: missing ? null : rank,
          slice: missing ? "missing_context" : rank > 4 * k ? "outside_pool" : rank > k ? "beyond_top_k" : "within_top_k",
          expected, actual, exact: JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
          expectedRecall: expected.length ? expectedPresent / expected.length : null,
          contaminated: actual.some(id => !expected.includes(id)), elapsedMs,
          injectedTokens: encoding.encode(prompt.prepend + prompt.append).length,
          fallback: result?.lifecycleDecision?.mode === "fallback", promptHash: sha(JSON.stringify(prompt)), prompt,
        });
      }
    } finally { store.close(); }
  }
} finally { await rm(temp, { recursive: true, force: true }); }
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * q) - 1] ?? 0;
const summarize = (rs: typeof rows) => ({ cases: rs.length, exactSelection: mean(rs.map(r => +r.exact)),
  expectedRecall: mean(rs.filter(r => r.expectedRecall !== null).map(r => r.expectedRecall)), contaminationRate: mean(rs.map(r => +r.contaminated)),
  meanTokens: mean(rs.map(r => r.injectedTokens)), meanItems: mean(rs.map(r => r.actual.length)),
  p50Ms: pct(rs.map(r => r.elapsedMs), .5), p95Ms: pct(rs.map(r => r.elapsedMs), .95), fallbackCount: rs.filter(r => r.fallback).length });
const result = { protocol: "competition-rank-pressure-v1", arm: values.arm, policy: values.policy,
  generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
  sourceCommit: execFileSync("git", ["-C", core, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceHashes: Object.fromEntries(await Promise.all(sourceFiles.map(async f => [f, sha(await readFile(path.join(core, f)))]))),
  protocolSha256: sha(await readFile(new URL("./protocol.json", import.meta.url))),
  databases, writes, measuredRecallCalls: rows.length, warmupCalls: databases,
  summary: summarize(rows), slices: Object.fromEntries(["within_top_k", "beyond_top_k", "outside_pool", "missing_context"].map(s => [s, summarize(rows.filter(r => r.slice === s))])), rows };
await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ arm: values.arm, ...result.summary, slices: result.slices }, null, 2));
