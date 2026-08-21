import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { MemoryCoreGroupBackend } from "./backend.js";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import {
  buildRawStateUnits,
  packLongTaskContext,
  sanitizeLongTaskQuery,
  scoreDirectAnswerSupport,
} from "./longmemeval-v2-baseline.js";
import type {
  LongMemEvalV2BaselineCase,
  LongMemEvalV2BaselineSummary,
} from "./longmemeval-v2-baseline-runner.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  LONGMEMEVAL_V2_TRANSITION_PROTOCOL,
  questionIdsForLongMemEvalV2Phase,
} from "./longmemeval-v2-transition-protocol.js";
import { buildTransitionUnits } from "./longmemeval-v2-transition.js";
import type { LongMemEvalV2UtilityArtifact } from "./longmemeval-v2-utility-gate-runner.js";
import {
  selectUtilityGatedContext,
  type TransitionUtilityTable,
  type UtilityGateFallbackReason,
  type UtilityGateNullReason,
} from "./longmemeval-v2-utility-gate.js";
import { LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL } from "./longmemeval-v2-utility-gate-protocol.js";

interface ForcedFallbackMismatches {
  disabled: number;
  missingTable: number;
  overflow: number;
  timeout: number;
  corrupt: number;
}

export interface LongMemEvalV2UtilityTestCase {
  protocolVersion: string;
  mode: "utility_gate";
  phase: "test";
  questionId: string;
  domain: string;
  environment: string;
  directProxy: boolean;
  query: string;
  utilityEntries: number;
  eligibleUtilityEntries: number;
  baseCandidateIds: string[];
  baseInjectedIds: string[];
  baseInjectedTokens: number;
  transitionCandidateIds: string[];
  injectedIds: string[];
  transitionIds: string[];
  rawIds: string[];
  injectedTokens: number;
  tokenViolation: boolean;
  usedAuxiliary: boolean;
  selectionMode: "utility_gated" | "baseline_noop" | "fallback_baseline";
  consideredUtilityIds: string[];
  selectedUtility: number | null;
  fallback: boolean;
  fallbackReason: UtilityGateFallbackReason | null;
  nullReason: UtilityGateNullReason | null;
  rawQueryLatencyMs: number;
  transitionQueryLatencyMs: number;
  selectionLatencyMs: number;
  totalQueryLatencyMs: number;
  answerAtomCount: number | null;
  supportedAtomCount: number | null;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  baseAnswerAtomSupportRecall: number | null;
  baseAnyAnswerAtomSupported: number | null;
  baseAllAnswerAtomsSupported: number | null;
  answerAtomSupportRecallDelta: number | null;
  forcedFallbackMismatches: ForcedFallbackMismatches;
}

export interface LongMemEvalV2UtilityTestSummary {
  protocolVersion: string;
  mode: "utility_gate";
  phase: "test";
  status: "test_passed" | "test_failed";
  candidatePreScoreCommit: string;
  sourceSha256: {
    baselineCases: string;
    baselineSummary: string;
    utilityArtifact: string;
  };
  cases: number;
  directProxyCases: number;
  utility: {
    entries: number;
    eligibleEntries: number;
    sourceQuestions: number;
    feedbackEvents: number;
  };
  metrics: {
    baseAnswerAtomSupportRecall: number;
    answerAtomSupportRecall: number;
    answerAtomSupportRecallDelta: number;
    anyAnswerAtomSupportedRateDelta: number;
    allAnswerAtomsSupportedRateDelta: number;
    meanBaseInjectedTokens: number;
    meanInjectedTokens: number;
    meanInjectedTokenFraction: number;
    acceptedChangedContexts: number;
    auxiliaryUseRate: number;
    improved: number;
    equal: number;
    harmed: number;
    tokenViolations: number;
    ordinaryFallbacks: number;
    selectionLatencyP50Ms: number;
    selectionLatencyP95Ms: number;
    totalQueryLatencyP50Ms: number;
    totalQueryLatencyP95Ms: number;
  };
  answerAtomSupportRecallDeltaBootstrap: {
    mean: number;
    lower: number;
    upper: number;
    questions: number;
    strata: number;
    samples: number;
    seed: number;
  };
  nullReasons: Record<string, number>;
  forcedFallbackMismatches: ForcedFallbackMismatches;
  byDomain: Record<string, {
    cases: number;
    directProxyCases: number;
    baseAnswerAtomSupportRecall: number;
    answerAtomSupportRecall: number;
    answerAtomSupportRecallDelta: number;
    meanInjectedTokenFraction: number;
    acceptedChangedContexts: number;
    improved: number;
    harmed: number;
  }>;
  index: Record<string, {
    trajectories: number;
    states: number;
    rawUnits: number;
    transitionUnits: number;
    rawBuildLatencyMs: number;
    transitionBuildLatencyMs: number;
  }>;
  casesSha256: string;
  gate: {
    passed: boolean;
    checks: Record<string, boolean>;
  };
  answerLevelState: "admitted" | "not_admitted";
}

const protocol = LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL;
const transitionProtocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * probability) - 1))];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(
  rows: LongMemEvalV2UtilityTestCase[],
  samples: number,
  seed: number,
): LongMemEvalV2UtilityTestSummary["answerAtomSupportRecallDeltaBootstrap"] {
  const direct = rows.filter((row) => row.directProxy);
  const strata = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    for (const stratum of strata) {
      for (let index = 0; index < stratum.length; index += 1) {
        total += stratum[Math.floor(random() * stratum.length)].answerAtomSupportRecallDelta!;
        count += 1;
      }
    }
    draws.push(total / count);
  }
  draws.sort((left, right) => left - right);
  return {
    mean: mean(direct.map((row) => row.answerAtomSupportRecallDelta!)),
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    questions: direct.length,
    strata: strata.length,
    samples,
    seed,
  };
}

function exactSelection(
  baseline: ReturnType<typeof packLongTaskContext>,
  selection: ReturnType<typeof selectUtilityGatedContext>,
): boolean {
  return sameIds(selection.items.map((item) => item.id), baseline.items.map((item) => item.id))
    && selection.injectedTokens === baseline.injectedTokens;
}

function forcedFallbackProof(params: {
  baseline: ReturnType<typeof packLongTaskContext>;
  rawCandidates: Awaited<ReturnType<MemoryCoreGroupBackend["search"]>>["candidates"];
  transitionCandidates: Awaited<ReturnType<MemoryCoreGroupBackend["search"]>>["candidates"];
  utilityTable: TransitionUtilityTable;
}): ForcedFallbackMismatches {
  const common = {
    baseline: params.baseline,
    rawCandidates: params.rawCandidates,
    transitionCandidates: params.transitionCandidates,
    utilityTable: params.utilityTable,
    tokenBudget: transitionProtocol.baseline.injectionTokenBudget,
    resultLimit: transitionProtocol.baseline.resultLimit,
    candidateLimit: protocol.runtimePolicy.transitionCandidateLimit,
    maxUtilityItems: protocol.runtimePolicy.maxUtilityItems,
  };
  const overflowTable = {
    ...params.utilityTable,
    capacity: Math.max(0, params.utilityTable.entries.length - 1),
  };
  const disabled = selectUtilityGatedContext({ ...common, enabled: false });
  const missingTable = selectUtilityGatedContext({ ...common, utilityTable: null });
  const overflow = selectUtilityGatedContext({ ...common, utilityTable: overflowTable });
  const timeout = selectUtilityGatedContext({ ...common, timedOut: true });
  const corrupt = selectUtilityGatedContext({ ...common, forceCorrupt: true });
  return {
    disabled: exactSelection(params.baseline, disabled) ? 0 : 1,
    missingTable: exactSelection(params.baseline, missingTable) ? 0 : 1,
    overflow: exactSelection(params.baseline, overflow) ? 0 : 1,
    timeout: exactSelection(params.baseline, timeout) ? 0 : 1,
    corrupt: exactSelection(params.baseline, corrupt) ? 0 : 1,
  };
}

async function loadLockedInputs(params: {
  baselineCasesPath: string;
  baselineSummaryPath: string;
  utilityPath: string;
  expected: {
    baselineCases: string;
    baselineSummary: string;
    utilityArtifact: string;
  };
}): Promise<{
  baselineCases: LongMemEvalV2BaselineCase[];
  baselineSummary: LongMemEvalV2BaselineSummary;
  utility: LongMemEvalV2UtilityArtifact;
}> {
  const [casesText, summaryText, utilityText] = await Promise.all([
    readFile(params.baselineCasesPath, "utf8"),
    readFile(params.baselineSummaryPath, "utf8"),
    readFile(params.utilityPath, "utf8"),
  ]);
  if (sha256(casesText) !== params.expected.baselineCases
    || sha256(summaryText) !== params.expected.baselineSummary
    || sha256(utilityText) !== params.expected.utilityArtifact) {
    throw new Error("D8 locked test input hash mismatch");
  }
  const baselineCases = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2BaselineCase);
  const baselineSummary = JSON.parse(summaryText) as LongMemEvalV2BaselineSummary;
  const utility = JSON.parse(utilityText) as LongMemEvalV2UtilityArtifact;
  if (baselineSummary.phase !== "test" || baselineSummary.mode !== "base"
    || baselineSummary.casesSha256 !== params.expected.baselineCases
    || baselineCases.length !== 24
    || utility.sourceProtocolVersion !== protocol.protocolVersion
    || utility.preScoreCommit !== "ab95ddec8e5fcd8c7ab6c09c38b2704b156487b5"
    || utility.table.entries.length > utility.table.capacity
    || utility.tableSha256 !== sha256(JSON.stringify(utility.table))) {
    throw new Error("D8 locked test input identity mismatch");
  }
  return { baselineCases, baselineSummary, utility };
}

function summarize(params: {
  rows: LongMemEvalV2UtilityTestCase[];
  baselineSummary: LongMemEvalV2BaselineSummary;
  utility: LongMemEvalV2UtilityArtifact;
  index: LongMemEvalV2UtilityTestSummary["index"];
  preScoreCommit: string;
  sourceSha256: LongMemEvalV2UtilityTestSummary["sourceSha256"];
  casesSha256: string;
  bootstrapSamples: number;
  bootstrapSeed: number;
}): LongMemEvalV2UtilityTestSummary {
  const rows = params.rows;
  const direct = rows.filter((row) => row.directProxy);
  const deltas = direct.map((row) => row.answerAtomSupportRecallDelta!);
  const meanTokens = mean(rows.map((row) => row.injectedTokens));
  const meanBaseTokens = mean(rows.map((row) => row.baseInjectedTokens));
  const forced = {
    disabled: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.disabled, 0),
    missingTable: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.missingTable, 0),
    overflow: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.overflow, 0),
    timeout: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.timeout, 0),
    corrupt: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.corrupt, 0),
  };
  const metrics: LongMemEvalV2UtilityTestSummary["metrics"] = {
    baseAnswerAtomSupportRecall: mean(direct.map((row) => row.baseAnswerAtomSupportRecall!)),
    answerAtomSupportRecall: mean(direct.map((row) => row.answerAtomSupportRecall!)),
    answerAtomSupportRecallDelta: mean(deltas),
    anyAnswerAtomSupportedRateDelta: mean(direct.map((row) =>
      row.anyAnswerAtomSupported! - row.baseAnyAnswerAtomSupported!
    )),
    allAnswerAtomsSupportedRateDelta: mean(direct.map((row) =>
      row.allAnswerAtomsSupported! - row.baseAllAnswerAtomsSupported!
    )),
    meanBaseInjectedTokens: meanBaseTokens,
    meanInjectedTokens: meanTokens,
    meanInjectedTokenFraction: meanTokens / meanBaseTokens - 1,
    acceptedChangedContexts: rows.filter((row) => row.usedAuxiliary).length,
    auxiliaryUseRate: mean(rows.map((row) => row.usedAuxiliary ? 1 : 0)),
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
    tokenViolations: rows.filter((row) => row.tokenViolation).length,
    ordinaryFallbacks: rows.filter((row) => row.fallback).length,
    selectionLatencyP50Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.5),
    selectionLatencyP95Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.95),
    totalQueryLatencyP50Ms: percentile(rows.map((row) => row.totalQueryLatencyMs), 0.5),
    totalQueryLatencyP95Ms: percentile(rows.map((row) => row.totalQueryLatencyMs), 0.95),
  };
  const interval = bootstrap(rows, params.bootstrapSamples, params.bootstrapSeed);
  const gate = protocol.testGate;
  const checks = {
    answerAtomSupportRecallDelta:
      metrics.answerAtomSupportRecallDelta >= gate.minAnswerAtomSupportRecallDelta,
    answerAtomSupportRecallBootstrapLower:
      interval.lower >= gate.minAnswerAtomSupportRecallBootstrapLower,
    allAnswerAtomsSupportedRateDelta:
      metrics.allAnswerAtomsSupportedRateDelta >= gate.minAllAnswerAtomsSupportedRateDelta,
    improvedDirectProxyCases: metrics.improved >= gate.minImprovedDirectProxyCases,
    harmedDirectProxyCases: metrics.harmed <= gate.maxHarmedDirectProxyCases,
    meanInjectedTokens: metrics.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
    tokenViolations: metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    ordinaryFallbacks: metrics.ordinaryFallbacks <= gate.maxOrdinaryFallbacks,
    selectionLatency: metrics.selectionLatencyP95Ms <= gate.maxP95SelectionLatencyMs,
    disabledFallback: forced.disabled === 0,
    missingTableFallback: forced.missingTable === 0,
    overflowFallback: forced.overflow === 0,
    timeoutFallback: forced.timeout === 0,
    corruptFallback: forced.corrupt === 0,
  };
  const nullReasons: Record<string, number> = {};
  for (const row of rows) {
    if (row.nullReason) nullReasons[row.nullReason] = (nullReasons[row.nullReason] ?? 0) + 1;
  }
  return {
    protocolVersion: protocol.protocolVersion,
    mode: "utility_gate",
    phase: "test",
    status: Object.values(checks).every(Boolean) ? "test_passed" : "test_failed",
    candidatePreScoreCommit: params.preScoreCommit,
    sourceSha256: params.sourceSha256,
    cases: rows.length,
    directProxyCases: direct.length,
    utility: {
      entries: params.utility.table.entries.length,
      eligibleEntries: params.utility.table.entries.filter((entry) => entry.eligible).length,
      sourceQuestions: params.utility.table.sourceQuestions,
      feedbackEvents: params.utility.table.feedbackEvents,
    },
    metrics,
    answerAtomSupportRecallDeltaBootstrap: interval,
    nullReasons,
    forcedFallbackMismatches: forced,
    byDomain: Object.fromEntries([...new Set(rows.map((row) => row.domain))].sort()
      .map((domain) => {
        const domainRows = rows.filter((row) => row.domain === domain);
        const domainDirect = domainRows.filter((row) => row.directProxy);
        const baseRecall = mean(domainDirect.map((row) => row.baseAnswerAtomSupportRecall!));
        const recall = mean(domainDirect.map((row) => row.answerAtomSupportRecall!));
        return [domain, {
          cases: domainRows.length,
          directProxyCases: domainDirect.length,
          baseAnswerAtomSupportRecall: baseRecall,
          answerAtomSupportRecall: recall,
          answerAtomSupportRecallDelta: recall - baseRecall,
          meanInjectedTokenFraction: mean(domainRows.map((row) => row.injectedTokens))
            / mean(domainRows.map((row) => row.baseInjectedTokens)) - 1,
          acceptedChangedContexts: domainRows.filter((row) => row.usedAuxiliary).length,
          improved: domainDirect.filter((row) => row.answerAtomSupportRecallDelta! > 1e-12).length,
          harmed: domainDirect.filter((row) => row.answerAtomSupportRecallDelta! < -1e-12).length,
        }];
      })),
    index: params.index,
    casesSha256: params.casesSha256,
    gate: { passed: Object.values(checks).every(Boolean), checks },
    answerLevelState: Object.values(checks).every(Boolean) ? "admitted" : "not_admitted",
  };
}

export async function runLongMemEvalV2UtilityTest(params: {
  dataRoot: string;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  utilityPath: string;
  candidatePreScoreCommit: string;
  expectedSha256: {
    baselineCases: string;
    baselineSummary: string;
    utilityArtifact: string;
  };
  bootstrapSamples: number;
  bootstrapSeed: number;
}): Promise<{
  cases: LongMemEvalV2UtilityTestCase[];
  summary: LongMemEvalV2UtilityTestSummary;
}> {
  const locked = await loadLockedInputs({
    baselineCasesPath: params.baselineCasesPath,
    baselineSummaryPath: params.baselineSummaryPath,
    utilityPath: params.utilityPath,
    expected: params.expectedSha256,
  });
  const baselineById = new Map(locked.baselineCases.map((row) => [row.questionId, row]));
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    tier: protocol.dataset.tier,
    expected: {
      questions: transitionProtocol.dataset.questions,
      haystackSize: 100,
      trajectoryRows: transitionProtocol.dataset.trajectoryRows,
      selectedTrajectories: transitionProtocol.dataset.selectedTrajectories,
      questionsSha256: transitionProtocol.dataset.questionsSha256,
      haystackSha256: transitionProtocol.dataset.haystackSha256,
      trajectoriesSha256: transitionProtocol.dataset.trajectoriesSha256,
    },
  });
  const questions = await adapter.loadQuestions();
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const selectedQuestions = questionIdsForLongMemEvalV2Phase("test").map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`D8 missing test question ${id}`);
    return question;
  });
  const trajectories = await adapter.loadTrajectories(
    [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))],
  );
  const byDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = byDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    byDomain.set(trajectory.domain, values);
  }
  const rawBackends = new Map<string, MemoryCoreGroupBackend>();
  const transitionBackends = new Map<string, MemoryCoreGroupBackend>();
  const index: LongMemEvalV2UtilityTestSummary["index"] = {};
  try {
    for (const [domain, domainTrajectories] of [...byDomain.entries()].sort()) {
      const rawStarted = performance.now();
      const raw = buildRawStateUnits({
        trajectories: domainTrajectories,
        config: {
          maxCharacters: transitionProtocol.baseline.rawChunkMaxCharacters,
          overlapCharacters: transitionProtocol.baseline.rawChunkOverlapCharacters,
          maxChunksPerState: transitionProtocol.baseline.maxRawChunksPerState,
        },
      });
      const rawBackend = new MemoryCoreGroupBackend(raw.units);
      const rawBuildLatencyMs = performance.now() - rawStarted;
      const transitionStarted = performance.now();
      const transition = buildTransitionUnits({
        trajectories: domainTrajectories,
        config: {
          maxCharacters: transitionProtocol.challenger.diffChunkMaxCharacters,
          maxChunksPerTransition: transitionProtocol.challenger.maxDiffChunksPerTransition,
          maxAuxiliaryUnits: transitionProtocol.challenger.maxAuxiliaryUnits,
        },
      });
      const transitionBackend = new MemoryCoreGroupBackend(transition.units);
      rawBackends.set(domain, rawBackend);
      transitionBackends.set(domain, transitionBackend);
      index[domain] = {
        trajectories: domainTrajectories.length,
        states: domainTrajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0),
        rawUnits: raw.units.length,
        transitionUnits: transition.units.length,
        rawBuildLatencyMs,
        transitionBuildLatencyMs: performance.now() - transitionStarted,
      };
    }
    const cases: LongMemEvalV2UtilityTestCase[] = [];
    for (const question of selectedQuestions) {
      const baselineLocked = baselineById.get(question.id);
      const rawBackend = rawBackends.get(question.domain);
      const transitionBackend = transitionBackends.get(question.domain);
      if (!baselineLocked || !rawBackend || !transitionBackend) {
        throw new Error(`D8 missing locked test input ${question.id}`);
      }
      const query = sanitizeLongTaskQuery(question.prompt);
      const rawSearch = await rawBackend.search(query, transitionProtocol.baseline.candidateLimit);
      const baseline = packLongTaskContext({
        candidates: rawSearch.candidates,
        tokenBudget: transitionProtocol.baseline.injectionTokenBudget,
        resultLimit: transitionProtocol.baseline.resultLimit,
      });
      const baseSupport = scoreDirectAnswerSupport(question, baseline.items);
      if (!sameIds(rawSearch.candidates.map((item) => item.id), baselineLocked.candidateIds)
        || !sameIds(baseline.items.map((item) => item.id), baselineLocked.injectedIds)
        || baseline.injectedTokens !== baselineLocked.injectedTokens
        || (baseSupport?.answerAtomSupportRecall ?? null) !== baselineLocked.answerAtomSupportRecall) {
        throw new Error(`D8 recomputed test baseline mismatch ${question.id}`);
      }
      let transitionCandidates: Awaited<ReturnType<MemoryCoreGroupBackend["search"]>>["candidates"] = [];
      let transitionQueryLatencyMs = 0;
      let transitionUnavailable = false;
      let transitionTimedOut = false;
      try {
        const search = await transitionBackend.search(query, protocol.runtimePolicy.transitionCandidateLimit);
        transitionCandidates = search.candidates;
        transitionQueryLatencyMs = search.latencyMs;
        transitionTimedOut = search.latencyMs > 5_000;
      } catch {
        transitionUnavailable = true;
      }
      const selectionStarted = performance.now();
      let selection = selectUtilityGatedContext({
        baseline,
        rawCandidates: rawSearch.candidates,
        transitionCandidates,
        utilityTable: transitionUnavailable ? null : locked.utility.table,
        tokenBudget: transitionProtocol.baseline.injectionTokenBudget,
        resultLimit: transitionProtocol.baseline.resultLimit,
        candidateLimit: protocol.runtimePolicy.transitionCandidateLimit,
        maxUtilityItems: protocol.runtimePolicy.maxUtilityItems,
        timedOut: transitionTimedOut,
      });
      const selectionLatencyMs = performance.now() - selectionStarted;
      if (selectionLatencyMs > protocol.runtimePolicy.selectionTimeoutMs) {
        selection = selectUtilityGatedContext({
          baseline,
          rawCandidates: rawSearch.candidates,
          transitionCandidates,
          utilityTable: locked.utility.table,
          tokenBudget: transitionProtocol.baseline.injectionTokenBudget,
          resultLimit: transitionProtocol.baseline.resultLimit,
          candidateLimit: protocol.runtimePolicy.transitionCandidateLimit,
          maxUtilityItems: protocol.runtimePolicy.maxUtilityItems,
          timedOut: true,
        });
      }
      const support = scoreDirectAnswerSupport(question, selection.items);
      cases.push({
        protocolVersion: protocol.protocolVersion,
        mode: "utility_gate",
        phase: "test",
        questionId: question.id,
        domain: question.domain,
        environment: question.environment,
        directProxy: support !== null,
        query,
        utilityEntries: locked.utility.table.entries.length,
        eligibleUtilityEntries: locked.utility.table.entries.filter((entry) => entry.eligible).length,
        baseCandidateIds: rawSearch.candidates.map((item) => item.id),
        baseInjectedIds: baseline.items.map((item) => item.id),
        baseInjectedTokens: baseline.injectedTokens,
        transitionCandidateIds: transitionCandidates.map((item) => item.id),
        injectedIds: selection.items.map((item) => item.id),
        transitionIds: selection.transitionIds,
        rawIds: selection.rawIds,
        injectedTokens: selection.injectedTokens,
        tokenViolation: selection.tokenViolation,
        usedAuxiliary: selection.usedAuxiliary,
        selectionMode: selection.mode,
        consideredUtilityIds: selection.consideredUtilityIds,
        selectedUtility: selection.selectedUtility,
        fallback: selection.fallback,
        fallbackReason: selection.fallbackReason,
        nullReason: selection.nullReason,
        rawQueryLatencyMs: rawSearch.latencyMs,
        transitionQueryLatencyMs,
        selectionLatencyMs,
        totalQueryLatencyMs: rawSearch.latencyMs + transitionQueryLatencyMs + selectionLatencyMs,
        answerAtomCount: support?.answerAtoms.length ?? null,
        supportedAtomCount: support?.supportedAtomCount ?? null,
        answerAtomSupportRecall: support?.answerAtomSupportRecall ?? null,
        anyAnswerAtomSupported: support?.anyAnswerAtomSupported ?? null,
        allAnswerAtomsSupported: support?.allAnswerAtomsSupported ?? null,
        baseAnswerAtomSupportRecall: baseSupport?.answerAtomSupportRecall ?? null,
        baseAnyAnswerAtomSupported: baseSupport?.anyAnswerAtomSupported ?? null,
        baseAllAnswerAtomsSupported: baseSupport?.allAnswerAtomsSupported ?? null,
        answerAtomSupportRecallDelta: support && baseSupport
          ? support.answerAtomSupportRecall - baseSupport.answerAtomSupportRecall
          : null,
        forcedFallbackMismatches: forcedFallbackProof({
          baseline,
          rawCandidates: rawSearch.candidates,
          transitionCandidates,
          utilityTable: locked.utility.table,
        }),
      });
    }
    cases.sort((left, right) => left.questionId.localeCompare(right.questionId));
    const casesText = cases.map((row) => `${JSON.stringify(row)}\n`).join("");
    return {
      cases,
      summary: summarize({
        rows: cases,
        baselineSummary: locked.baselineSummary,
        utility: locked.utility,
        index,
        preScoreCommit: params.candidatePreScoreCommit,
        sourceSha256: params.expectedSha256,
        casesSha256: sha256(casesText),
        bootstrapSamples: params.bootstrapSamples,
        bootstrapSeed: params.bootstrapSeed,
      }),
    };
  } finally {
    for (const backend of rawBackends.values()) backend.close();
    for (const backend of transitionBackends.values()) backend.close();
  }
}
