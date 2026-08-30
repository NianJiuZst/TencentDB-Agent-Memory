import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { appendLifecycleFeedbackEvent } from "../../../src/core/lifecycle/feedback-store.js";
import { applyPersistedLifecycle } from "../../../src/core/lifecycle/production-runtime.js";
import type { LifecycleDecisionLog, LifecyclePolicy } from "../../../src/core/lifecycle/types.js";

type CaseKind = "redirect" | "no_event" | "low_confidence" | "cross_scope" | "missing_successor" | "corrupt_state";
interface Fixture { schemaVersion: 1; name: string; description: string; cases: Array<{ id: string; kind: CaseKind }> }

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const benchmarkDir = path.resolve(scriptDir, "..");
const fixturePath = path.join(benchmarkDir, "fixtures/runtime-integration.v1.json");
const outputArgIndex = process.argv.indexOf("--output");
const outputPath = outputArgIndex >= 0 && process.argv[outputArgIndex + 1]
  ? path.resolve(process.cwd(), process.argv[outputArgIndex + 1])
  : path.join(benchmarkDir, "results/runtime-integration/result-card.v1.json");
const repetitions = 25;
const policy: LifecyclePolicy = {
  enabled: true,
  minConfidence: 0.85,
  maxHops: 1,
  maxExpansions: 64,
  resultLimit: 2,
  timeoutMs: 10,
};

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const fixtureRaw = await readFile(fixturePath, "utf-8");
const fixture = JSON.parse(fixtureRaw) as Fixture;
if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.cases)) throw new Error("invalid runtime integration fixture");

const root = await mkdtemp(path.join(os.tmpdir(), "lifecycle-runtime-eval-"));
const rows: Array<{
  id: string;
  kind: CaseKind;
  outputIds: string[];
  expectedIds: string[];
  mode: LifecycleDecisionLog["mode"];
  redirects: number;
  exact: boolean;
}> = [];
const lifecycleLatencies: number[] = [];
const baseLatencies: number[] = [];

try {
  for (const testCase of fixture.cases) {
    const baseDir = path.join(root, testCase.id);
    await mkdir(baseDir, { recursive: true });
    const oldId = `${testCase.id}-old`;
    const stableId = `${testCase.id}-stable`;
    const newId = `${testCase.id}-new`;
    const eventScope = { teamId: "team-1", userId: "alice", agentId: "agent-1", sessionKey: "session-1" };
    const recallScope = testCase.kind === "cross_scope"
      ? { ...eventScope, userId: "bob" }
      : eventScope;
    if (testCase.kind === "corrupt_state") {
      const dir = path.join(baseDir, "lifecycle-events");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "2026-08-30.jsonl"), "corrupt\n", "utf-8");
    } else if (testCase.kind !== "no_event") {
      await appendLifecycleFeedbackEvent({
        baseDir,
        event: {
          schemaVersion: 1,
          eventId: `${testCase.id}-event`,
          kind: "update",
          occurredAtMs: 1_700_000_000_000,
          confidence: testCase.kind === "low_confidence" ? 0.8 : 0.95,
          source: "test",
          predecessorMemoryIds: [oldId],
          successorMemoryIds: [newId],
          scope: eventScope,
        },
      });
    }
    const candidates = [
      { id: oldId, content: `stale ${testCase.id}`, score: 0.9 },
      { id: stableId, content: `stable ${testCase.id}`, score: 0.8 },
    ];
    const expectedIds = testCase.kind === "redirect" ? [newId, stableId] : [oldId, stableId];
    let firstDecision: LifecycleDecisionLog | undefined;
    let firstOutput: string[] | undefined;
    for (let run = 0; run < repetitions; run++) {
      const baseStarted = performance.now();
      await applyPersistedLifecycle({
        candidates,
        policy: { ...policy, enabled: false },
        maxEvents: 100,
        baseDir,
        scope: recallScope,
        materialize: async () => [],
      });
      baseLatencies.push(performance.now() - baseStarted);

      const lifecycleStarted = performance.now();
      const result = await applyPersistedLifecycle({
        candidates,
        policy,
        maxEvents: 100,
        baseDir,
        scope: recallScope,
        materialize: async (ids) => testCase.kind === "missing_successor"
          ? []
          : ids.includes(newId)
            ? [{ id: newId, content: `current ${testCase.id}`, score: 0 }]
            : [],
      });
      lifecycleLatencies.push(performance.now() - lifecycleStarted);
      if (run === 0) {
        firstDecision = result.decision;
        firstOutput = result.candidates.map((candidate) => candidate.id);
      }
    }
    const outputIds = firstOutput ?? [];
    rows.push({
      id: testCase.id,
      kind: testCase.kind,
      outputIds,
      expectedIds,
      mode: firstDecision?.mode ?? "fallback",
      redirects: firstDecision?.redirects ?? 0,
      exact: JSON.stringify(outputIds) === JSON.stringify(expectedIds),
    });
  }

  const redirectRows = rows.filter((row) => row.kind === "redirect");
  const protectedRows = rows.filter((row) => ["no_event", "low_confidence", "cross_scope"].includes(row.kind));
  const fallbackRows = rows.filter((row) => ["missing_successor", "corrupt_state"].includes(row.kind));
  const crossScopeRows = rows.filter((row) => row.kind === "cross_scope");
  const p95LifecycleMs = percentile(lifecycleLatencies, 0.95);
  const p95BaseMs = percentile(baseLatencies, 0.95);
  const resultCard = {
    schemaVersion: 1,
    dataset: {
      name: fixture.name,
      cases: fixture.cases.length,
      repetitions,
      sha256: crypto.createHash("sha256").update(fixtureRaw).digest("hex"),
      boundary: fixture.description,
    },
    policy,
    metrics: {
      exact_case_rate: rows.filter((row) => row.exact).length / rows.length,
      stale_exposure_rate: redirectRows.filter((row) => row.outputIds.includes(`${row.id}-old`)).length / redirectRows.length,
      successor_recall_rate: redirectRows.filter((row) => row.outputIds.includes(`${row.id}-new`)).length / redirectRows.length,
      protected_false_redirect_rate: protectedRows.filter((row) => row.redirects > 0).length / protectedRows.length,
      cross_scope_leakage_rate: crossScopeRows.filter((row) => row.outputIds.includes(`${row.id}-new`)).length / crossScopeRows.length,
      exact_fallback_equivalence_rate: fallbackRows.filter((row) => row.exact && row.mode === "fallback").length / fallbackRows.length,
      p50_lifecycle_ms: percentile(lifecycleLatencies, 0.5),
      p95_lifecycle_ms: p95LifecycleMs,
      p95_base_ms: p95BaseMs,
      p95_overhead_ms: Math.max(0, p95LifecycleMs - p95BaseMs),
    },
    gates: {
      exact_cases: rows.every((row) => row.exact),
      stale_exposure_zero: redirectRows.every((row) => !row.outputIds.includes(`${row.id}-old`)),
      successor_recall_complete: redirectRows.every((row) => row.outputIds.includes(`${row.id}-new`)),
      protected_false_redirect_zero: protectedRows.every((row) => row.redirects === 0),
      cross_scope_leakage_zero: crossScopeRows.every((row) => !row.outputIds.includes(`${row.id}-new`)),
      fallback_exact: fallbackRows.every((row) => row.exact && row.mode === "fallback"),
      p95_overhead_within_10ms: Math.max(0, p95LifecycleMs - p95BaseMs) <= 10,
    },
    rows,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(resultCard, null, 2)}\n`, "utf-8");
  process.stdout.write(`${JSON.stringify(resultCard, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
