import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getEncoding } from "js-tiktoken";
import {
  applyLifecyclePolicy,
  LifecycleLedger,
  optimizeLifecyclePolicy,
  type LifecycleDecisionLog,
  type LifecyclePolicy,
  type LifecycleResolver,
} from "../../../src/core/lifecycle/index.js";
import { loadMemora } from "./adapter.js";
import { ADAPTIVE_PROTOCOL } from "./adaptive-protocol.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import { aggregate, pairedPersonaBootstrap, scoreRetrieved } from "./metrics.js";
import { extractMemoraLifecycleEvents } from "./memora-events.js";
import { PROTOCOL } from "./protocol.js";
import type {
  CaseMetrics,
  DatasetDescription,
  LifecycleEvalQuestion,
  RetrievedUnit,
} from "./types.js";

const runFile = promisify(execFile);
const encoding = getEncoding("cl100k_base");

interface PreparedCase {
  question: LifecycleEvalQuestion;
  candidates: RetrievedUnit[];
  queryLatencyMs: number;
  resolver?: LifecycleLedger;
  materialize: (id: string) => RetrievedUnit | undefined;
  ledgerError?: string;
}

interface AdaptiveCaseResult {
  caseId: string;
  groupId: string;
  persona: string;
  period: string;
  task: string;
  forgettingBearing: boolean;
  staleExposed: boolean;
  arm: "base" | "adaptive";
  candidateIds: string[];
  sourceSessionIds: string[];
  queryLatencyMs: number;
  metrics: CaseMetrics;
  decision?: LifecycleDecisionLog;
}

interface PreparedData {
  dataset: DatasetDescription;
  cases: PreparedCase[];
  ledgerStats: Array<{
    groupId: string;
    events: number;
    sourceCounts: Record<string, number>;
    ledger?: LifecycleLedger["stats"];
    error?: string;
  }>;
}

export interface AdaptiveRunOptions {
  dataRoot: string;
  outputDir: string;
  skipHashVerification?: boolean;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function baseResult(prepared: PreparedCase): AdaptiveCaseResult {
  const candidates = prepared.candidates.slice(0, PROTOCOL.retrieval.resultLimit);
  return {
    caseId: prepared.question.id,
    groupId: prepared.question.groupId,
    persona: prepared.question.persona,
    period: prepared.question.period,
    task: prepared.question.task,
    forgettingBearing: prepared.question.obsoleteAtoms.length > 0,
    staleExposed: scoreRetrieved(prepared.question, candidates).obsoleteAny === 1,
    arm: "base",
    candidateIds: candidates.map((candidate) => candidate.id),
    sourceSessionIds: candidates.map((candidate) => candidate.sessionId),
    queryLatencyMs: prepared.queryLatencyMs,
    metrics: scoreRetrieved(prepared.question, candidates),
  };
}

function adaptiveResult(prepared: PreparedCase, policy: LifecyclePolicy): AdaptiveCaseResult {
  const applied = applyLifecyclePolicy({
    candidates: prepared.candidates,
    resolver: prepared.resolver,
    policy,
    materialize: prepared.materialize,
  });
  return {
    caseId: prepared.question.id,
    groupId: prepared.question.groupId,
    persona: prepared.question.persona,
    period: prepared.question.period,
    task: prepared.question.task,
    forgettingBearing: prepared.question.obsoleteAtoms.length > 0,
    staleExposed: scoreRetrieved(
      prepared.question,
      prepared.candidates.slice(0, PROTOCOL.retrieval.resultLimit),
    ).obsoleteAny === 1,
    arm: "adaptive",
    candidateIds: applied.candidates.map((candidate) => candidate.id),
    sourceSessionIds: applied.candidates.map((candidate) => candidate.sessionId),
    queryLatencyMs: prepared.queryLatencyMs + applied.decision.elapsedMs,
    metrics: scoreRetrieved(prepared.question, applied.candidates),
    decision: applied.decision,
  };
}

async function prepare(options: AdaptiveRunOptions): Promise<PreparedData> {
  const loaded = await loadMemora(options.dataRoot, !options.skipHashVerification);
  const cases: PreparedCase[] = [];
  const ledgerStats: PreparedData["ledgerStats"] = [];
  for (let index = 0; index < loaded.groups.length; index += 1) {
    const group = loaded.groups[index];
    const extracted = extractMemoraLifecycleEvents(group.sessions, group.units);
    let resolver: LifecycleLedger | undefined;
    let ledgerError: string | undefined;
    try {
      resolver = new LifecycleLedger(
        group.units.map((unit) => ({ id: unit.id, content: unit.content, sequence: unit.sequence })),
        extracted.events,
        {
          maxUnits: ADAPTIVE_PROTOCOL.capacity.maxUnitsPerGroup,
          maxEvents: ADAPTIVE_PROTOCOL.capacity.maxEventsPerGroup,
          maxEdges: ADAPTIVE_PROTOCOL.capacity.maxEdgesPerGroup,
        },
      );
    } catch (error) {
      ledgerError = error instanceof Error ? error.message : String(error);
    }
    ledgerStats.push({
      groupId: group.id,
      events: extracted.events.length,
      sourceCounts: extracted.sourceCounts,
      ...(resolver ? { ledger: resolver.stats } : {}),
      ...(ledgerError ? { error: ledgerError } : {}),
    });

    const materializedById = new Map<string, RetrievedUnit>();
    for (const unit of group.units) {
      materializedById.set(unit.id, {
        ...unit,
        score: 0,
        tokenCount: encoding.encode(unit.content).length,
      });
    }
    const backend = new MemoryCoreGroupBackend(group.units);
    try {
      for (const question of group.questions) {
        const search = await backend.search(question.query, PROTOCOL.retrieval.candidateLimit);
        for (const candidate of search.candidates) materializedById.set(candidate.id, candidate);
        cases.push({
          question,
          candidates: search.candidates,
          queryLatencyMs: search.latencyMs,
          resolver,
          materialize: (id) => materializedById.get(id),
          ledgerError,
        });
      }
    } finally {
      backend.close();
    }
    process.stdout.write(`prepared ${index + 1}/${loaded.groups.length} groups (${group.id})\n`);
  }
  return { dataset: loaded.description, cases, ledgerStats };
}

function policies(): LifecyclePolicy[] {
  return ADAPTIVE_PROTOCOL.policyGrid.minConfidence.flatMap((minConfidence) =>
    ADAPTIVE_PROTOCOL.policyGrid.maxHops.map((maxHops) => ({
      enabled: true,
      minConfidence,
      maxHops,
      maxExpansions: ADAPTIVE_PROTOCOL.policyGrid.maxExpansions,
      resultLimit: ADAPTIVE_PROTOCOL.policyGrid.resultLimit,
      timeoutMs: ADAPTIVE_PROTOCOL.policyGrid.timeoutMs,
    }))
  );
}

function comparison(adaptive: AdaptiveCaseResult[], base: AdaptiveCaseResult[], seedOffset: number) {
  return {
    evidenceFamaProxy: pairedPersonaBootstrap(
      adaptive,
      base,
      (left, right) => left.metrics.evidenceFamaProxy - right.metrics.evidenceFamaProxy,
      ADAPTIVE_PROTOCOL.uncertainty.bootstrapSamples,
      ADAPTIVE_PROTOCOL.seed + seedOffset,
    ),
    forgettingAbsence: pairedPersonaBootstrap(
      adaptive,
      base,
      (left, right) => left.metrics.forgettingAbsence - right.metrics.forgettingAbsence,
      ADAPTIVE_PROTOCOL.uncertainty.bootstrapSamples,
      ADAPTIVE_PROTOCOL.seed + seedOffset + 1,
    ),
    currentSessionRecall: pairedPersonaBootstrap(
      adaptive,
      base,
      (left, right) => left.metrics.currentSessionRecall - right.metrics.currentSessionRecall,
      ADAPTIVE_PROTOCOL.uncertainty.bootstrapSamples,
      ADAPTIVE_PROTOCOL.seed + seedOffset + 2,
    ),
  };
}

function subsetReport(
  adaptive: AdaptiveCaseResult[],
  base: AdaptiveCaseResult[],
  predicate: (result: AdaptiveCaseResult) => boolean,
  seedOffset: number,
) {
  const selectedBase = base.filter(predicate);
  const ids = new Set(selectedBase.map((result) => result.caseId));
  const selectedAdaptive = adaptive.filter((result) => ids.has(result.caseId));
  return {
    base: aggregate(selectedBase),
    adaptive: aggregate(selectedAdaptive),
    comparisonVsBase: comparison(selectedAdaptive, selectedBase, seedOffset),
  };
}

function fallbackChecks(prepared: PreparedCase[], selected: LifecyclePolicy) {
  const disabled = { ...selected, enabled: false };
  let disabledMismatches = 0;
  let damagedMismatches = 0;
  let timeoutMismatches = 0;
  const damaged: LifecycleResolver = { resolveIds: () => { throw new Error("forced checksum mismatch"); } };
  for (const entry of prepared) {
    const expected = entry.candidates.slice(0, selected.resultLimit).map((candidate) => candidate.id).join("\0");
    const disabledResult = applyLifecyclePolicy({
      candidates: entry.candidates,
      resolver: entry.resolver,
      policy: disabled,
      materialize: entry.materialize,
    });
    if (disabledResult.candidates.map((candidate) => candidate.id).join("\0") !== expected) disabledMismatches += 1;

    const damagedResult = applyLifecyclePolicy({
      candidates: entry.candidates,
      resolver: damaged,
      policy: selected,
      materialize: entry.materialize,
    });
    if (damagedResult.candidates.map((candidate) => candidate.id).join("\0") !== expected) damagedMismatches += 1;

    let clock = 0;
    const timeoutResult = applyLifecyclePolicy({
      candidates: entry.candidates,
      resolver: entry.resolver,
      policy: { ...selected, timeoutMs: 1 },
      materialize: entry.materialize,
      now: () => { clock += 2; return clock; },
    });
    if (timeoutResult.candidates.map((candidate) => candidate.id).join("\0") !== expected) timeoutMismatches += 1;
  }
  return {
    cases: prepared.length,
    disabledMismatches,
    damagedMismatches,
    timeoutMismatches,
    passed: disabledMismatches + damagedMismatches + timeoutMismatches === 0,
  };
}

async function sourceRevision(): Promise<{ head: string; branch: string; base: string }> {
  const cwd = path.resolve(import.meta.dirname, "../../..");
  const [head, branch, base] = await Promise.all([
    runFile("git", ["rev-parse", "HEAD"], { cwd }),
    runFile("git", ["branch", "--show-current"], { cwd }),
    runFile("git", ["merge-base", "HEAD", "upstream/feat/server_team"], { cwd }),
  ]);
  return { head: head.stdout.trim(), branch: branch.stdout.trim(), base: base.stdout.trim() };
}

export async function runAdaptive(options: AdaptiveRunOptions): Promise<Record<string, unknown>> {
  const prepared = await prepare(options);
  const optimizationCases = prepared.cases.filter((entry) =>
    ADAPTIVE_PROTOCOL.split.optimizationPeriods.includes(entry.question.period)
    && entry.question.obsoleteAtoms.length > 0
  );
  const optimizationBase = optimizationCases.map(baseResult);
  const optimized = await optimizeLifecyclePolicy({
    policies: policies(),
    evaluate: (policy) => {
      const results = optimizationCases.map((entry) => adaptiveResult(entry, policy));
      return {
        quality: mean(results.map((result) => result.metrics.evidenceFamaProxy)),
        meanCost: mean(results.map((result) => result.metrics.injectedTokens)) / 1000,
        fallbackRate: mean(results.map((result) => result.decision?.mode === "fallback" ? 1 : 0)),
      };
    },
    weights: {
      costPenalty: ADAPTIVE_PROTOCOL.optimizer.costPenalty,
      fallbackPenalty: ADAPTIVE_PROTOCOL.optimizer.fallbackPenalty,
    },
    maxPolicies: ADAPTIVE_PROTOCOL.policyGrid.maxPolicies,
  });

  const base = prepared.cases.map(baseResult);
  const adaptive = prepared.cases.map((entry) => adaptiveResult(entry, optimized.selected));
  const heldOutPeriods = new Set(ADAPTIVE_PROTOCOL.split.heldOutPeriods);
  const heldOut = (result: AdaptiveCaseResult) => heldOutPeriods.has(result.period);
  const forgetting = (result: AdaptiveCaseResult) => heldOut(result) && result.forgettingBearing;
  const staleExposed = (result: AdaptiveCaseResult) => forgetting(result) && result.staleExposed;
  const reports = {
    all: subsetReport(adaptive, base, () => true, 0),
    optimizationForgettingBearing: subsetReport(
      adaptive,
      base,
      (result) => ADAPTIVE_PROTOCOL.split.optimizationPeriods.includes(result.period) && result.forgettingBearing,
      100,
    ),
    heldOutAll: subsetReport(adaptive, base, heldOut, 200),
    heldOutForgettingBearing: subsetReport(adaptive, base, forgetting, 300),
    heldOutStaleExposed: subsetReport(adaptive, base, staleExposed, 400),
  };
  const fallback = fallbackChecks(prepared.cases, optimized.selected);
  const heldOutDirect = reports.heldOutStaleExposed.comparisonVsBase.evidenceFamaProxy;
  const checks = {
    evidenceFamaDelta: heldOutDirect.mean >= ADAPTIVE_PROTOCOL.directGate.minEvidenceFamaDelta,
    evidenceFamaCi: !ADAPTIVE_PROTOCOL.directGate.requireCiLowerAboveZero || heldOutDirect.lower > 0,
    disabledEquivalence: !ADAPTIVE_PROTOCOL.directGate.requireDisabledEquivalence
      || fallback.disabledMismatches === 0,
    forcedFailureFallback: !ADAPTIVE_PROTOCOL.directGate.requireForcedFailureFallback
      || (fallback.damagedMismatches === 0 && fallback.timeoutMismatches === 0),
  };
  const decisionSummary = {
    fallbackRate: mean(adaptive.map((result) => result.decision?.mode === "fallback" ? 1 : 0)),
    redirectRate: mean(adaptive.map((result) => (result.decision?.redirects ?? 0) > 0 ? 1 : 0)),
    meanRedirects: mean(adaptive.map((result) => result.decision?.redirects ?? 0)),
    maxObservedHops: Math.max(...adaptive.map((result) => result.decision?.maxObservedHops ?? 0)),
    meanDecisionLatencyMs: mean(adaptive.map((result) => result.decision?.elapsedMs ?? 0)),
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: ADAPTIVE_PROTOCOL,
    generatedAt: new Date().toISOString(),
    source: await sourceRevision(),
    dataset: prepared.dataset,
    optimization: {
      cases: optimizationCases.length,
      baseQuality: mean(optimizationBase.map((result) => result.metrics.evidenceFamaProxy)),
      selectedPolicy: optimized.selected,
      trials: optimized.trials,
    },
    ledger: {
      groups: prepared.ledgerStats,
      totals: {
        events: prepared.ledgerStats.reduce((sum, item) => sum + item.events, 0),
        edges: prepared.ledgerStats.reduce((sum, item) => sum + (item.ledger?.edges ?? 0), 0),
        invalidatedUnits: prepared.ledgerStats.reduce((sum, item) => sum + (item.ledger?.invalidatedUnits ?? 0), 0),
        failedGroups: prepared.ledgerStats.filter((item) => item.error).length,
      },
    },
    reports,
    decisions: decisionSummary,
    fallbackValidation: fallback,
    directGate: { passed: Object.values(checks).every(Boolean), checks },
    caveats: [
      "The optimizer sees only weekly/monthly evaluation feedback; quarterly is held out.",
      "The Memora adapter uses released write-time operation metadata, not evaluation evidence.",
      "Direct evidence metrics are not official answer-level FAMA and are followed by a frozen E2E test.",
    ],
  };

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(options.outputDir, "cases.jsonl"),
    `${[...base, ...adaptive].map((result) => JSON.stringify(result)).join("\n")}\n`,
    "utf8",
  );
  return report;
}
