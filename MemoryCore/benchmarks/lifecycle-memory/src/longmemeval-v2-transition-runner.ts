import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { MemoryCoreGroupBackend } from "./backend.js";
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
  buildTransitionPolicyGrid,
  buildTransitionUnits,
  selectTransitionAugmentedContext,
  type TransitionPolicy,
} from "./longmemeval-v2-transition.js";
import {
  LONGMEMEVAL_V2_TRANSITION_PROTOCOL,
  questionIdsForLongMemEvalV2Phase,
  type LongMemEvalV2Phase,
} from "./longmemeval-v2-transition-protocol.js";

export const TRANSITION_SIDECAR_TIMEOUT_MS = 5_000;

export interface LongMemEvalV2TransitionSelectionArtifact {
  selectionVersion: "lifecycle-longmemeval-v2-transition-selection-v1.0";
  sourceProtocolVersion: string;
  status: "selected";
  phase: "development";
  preScoreCommit: string;
  selectedPolicy: TransitionPolicy;
  ranking: string[];
  developmentCasesSha256: string;
  baselineCasesSha256: string;
  baselineSummarySha256: string;
  policyGridSha256: string;
  objectiveValues: {
    answerAtomSupportRecall: number;
    allAnswerAtomsSupportedRate: number;
    anyAnswerAtomSupportedRate: number;
    meanInjectedTokens: number;
    queryLatencyP95Ms: number;
  };
}

export interface LongMemEvalV2TransitionCase {
  protocolVersion: string;
  mode: "transition_diff";
  phase: LongMemEvalV2Phase;
  policyId: string;
  questionId: string;
  domain: string;
  environment: string;
  evaluatorFamily: "phrase" | "multiple_choice";
  directProxy: boolean;
  query: string;
  baseCandidateIds: string[];
  baseInjectedIds: string[];
  baseInjectedTokens: number;
  baseAnswerAtomSupportRecall: number | null;
  baseAnyAnswerAtomSupported: number | null;
  baseAllAnswerAtomsSupported: number | null;
  transitionCandidateIds: string[];
  injectedIds: string[];
  transitionIds: string[];
  rawIds: string[];
  injectedTokens: number;
  tokenViolation: boolean;
  rawQueryLatencyMs: number;
  transitionQueryLatencyMs: number;
  totalQueryLatencyMs: number;
  usedAuxiliary: boolean;
  selectionMode: "transition_augmented" | "baseline_noop" | "fallback_baseline";
  fallback: boolean;
  fallbackReason: string | null;
  answerAtomCount: number | null;
  supportedAtomCount: number | null;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  answerAtomSupportRecallDelta: number | null;
}

export interface TransitionPolicySummary {
  policy: TransitionPolicy;
  cases: number;
  directProxyCases: number;
  metrics: {
    answerAtomSupportRecall: number;
    anyAnswerAtomSupportedRate: number;
    allAnswerAtomsSupportedRate: number;
    meanInjectedTokens: number;
    meanInjectedItems: number;
    queryLatencyP50Ms: number;
    queryLatencyP95Ms: number;
    tokenViolations: number;
    fallbacks: number;
    auxiliaryUseRate: number;
  };
  deltas: {
    answerAtomSupportRecall: number;
    anyAnswerAtomSupportedRate: number;
    allAnswerAtomsSupportedRate: number;
    meanInjectedTokens: number;
    meanInjectedTokenFraction: number;
    queryLatencyP95Ratio: number;
  };
  directProxyOutcomes: {
    improved: number;
    equal: number;
    harmed: number;
    harmedRate: number;
  };
  byDomain: Record<string, {
    directProxyCases: number;
    baseAnswerAtomSupportRecall: number;
    answerAtomSupportRecall: number;
    answerAtomSupportRecallDelta: number;
    meanInjectedTokens: number;
  }>;
  forcedFallbackMismatches: {
    disabled: number;
    missingIndex: number;
    timeout: number;
    corrupt: number;
  };
  answerAtomSupportRecallDeltaBootstrap: {
    mean: number;
    lower: number;
    upper: number;
    questions: number;
    strata: number;
  } | null;
}

export interface LongMemEvalV2TransitionSummary {
  protocolVersion: string;
  mode: "transition_diff";
  phase: LongMemEvalV2Phase;
  status: "development_selected" | "validation_passed" | "validation_failed" | "test_passed" | "test_failed";
  preScoreCommit: string;
  selectionArtifactSha256: string | null;
  baseline: {
    casesSha256: string;
    summarySha256: string;
  };
  index: Record<string, {
    trajectories: number;
    states: number;
    rawUnits: number;
    rawTruncatedStates: number;
    transitionUnits: number;
    transitions: number;
    noTextDeltaTransitions: number;
    truncatedTransitions: number;
    addedLines: number;
    removedLines: number;
    rawBuildLatencyMs: number;
    transitionBuildLatencyMs: number;
  }>;
  policySummaries: TransitionPolicySummary[];
  selectedPolicy: TransitionPolicy;
  casesSha256: string;
  gate: {
    passed: boolean;
    checks: Record<string, boolean>;
  } | null;
}

interface LockedBaseline {
  cases: LongMemEvalV2BaselineCase[];
  byQuestionId: Map<string, LongMemEvalV2BaselineCase>;
  summary: LongMemEvalV2BaselineSummary;
  casesSha256: string;
  summarySha256: string;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * probability) - 1))];
}

function evaluatorFamily(question: LongTaskQuestion): "phrase" | "multiple_choice" {
  return question.evaluator.startsWith("mc_choice_match|") ? "multiple_choice" : "phrase";
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function loadLockedBaseline(params: {
  casesPath: string;
  summaryPath: string;
  phase: LongMemEvalV2Phase;
}): Promise<LockedBaseline> {
  const [casesText, summaryText] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
  ]);
  const cases = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2BaselineCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2BaselineSummary;
  const casesSha256 = createHash("sha256").update(casesText).digest("hex");
  const summarySha256 = createHash("sha256").update(summaryText).digest("hex");
  if (summary.protocolVersion !== LONGMEMEVAL_V2_TRANSITION_PROTOCOL.protocolVersion
    || summary.phase !== params.phase
    || summary.mode !== "base"
    || summary.casesSha256 !== casesSha256
    || cases.length !== summary.cases) {
    throw new Error("LongMemEval-V2 locked baseline identity mismatch");
  }
  return {
    cases,
    byQuestionId: new Map(cases.map((item) => [item.questionId, item])),
    summary,
    casesSha256,
    summarySha256,
  };
}

function assertRecomputedBaseline(
  locked: LongMemEvalV2BaselineCase,
  recomputed: {
    candidateIds: string[];
    injectedIds: string[];
    injectedTokens: number;
    answerAtomSupportRecall: number | null;
    anyAnswerAtomSupported: number | null;
    allAnswerAtomsSupported: number | null;
  },
): void {
  if (!exactIds(locked.candidateIds, recomputed.candidateIds)
    || !exactIds(locked.injectedIds, recomputed.injectedIds)
    || locked.injectedTokens !== recomputed.injectedTokens
    || locked.answerAtomSupportRecall !== recomputed.answerAtomSupportRecall
    || locked.anyAnswerAtomSupported !== recomputed.anyAnswerAtomSupported
    || locked.allAnswerAtomsSupported !== recomputed.allAnswerAtomsSupported) {
    throw new Error(`LongMemEval-V2 recomputed baseline differs for ${locked.questionId}`);
  }
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

function stratifiedQuestionBootstrap(
  rows: LongMemEvalV2TransitionCase[],
  samples: number,
  seed: number,
): NonNullable<TransitionPolicySummary["answerAtomSupportRecallDeltaBootstrap"]> {
  const direct = rows.filter((row) => row.directProxy);
  const strata = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const observed = mean(direct.map((row) => row.answerAtomSupportRecallDelta!));
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    for (const stratum of strata) {
      for (let index = 0; index < stratum.length; index += 1) {
        const selected = stratum[Math.floor(random() * stratum.length)];
        total += selected.answerAtomSupportRecallDelta!;
        count += 1;
      }
    }
    draws.push(total / count);
  }
  draws.sort((left, right) => left - right);
  return {
    mean: observed,
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    questions: direct.length,
    strata: strata.length,
  };
}

function summarizePolicy(params: {
  policy: TransitionPolicy;
  rows: LongMemEvalV2TransitionCase[];
  lockedBaseline: LockedBaseline;
  includeBootstrap: boolean;
}): TransitionPolicySummary {
  const rows = params.rows;
  const direct = rows.filter((row) => row.directProxy);
  const baseMeanTokens = params.lockedBaseline.summary.metrics.meanInjectedTokens;
  const meanTokens = mean(rows.map((row) => row.injectedTokens));
  const p95 = percentile(rows.map((row) => row.totalQueryLatencyMs), 0.95);
  const baseP95 = params.lockedBaseline.summary.metrics.queryLatencyP95Ms;
  const directDeltas = direct.map((row) => row.answerAtomSupportRecallDelta!);
  const byDomain = Object.fromEntries([...new Set(rows.map((row) => row.domain))].sort().map((domain) => {
    const domainRows = rows.filter((row) => row.domain === domain);
    const domainDirect = domainRows.filter((row) => row.directProxy);
    const baseRecall = mean(domainDirect.map((row) => row.baseAnswerAtomSupportRecall!));
    const recall = mean(domainDirect.map((row) => row.answerAtomSupportRecall!));
    return [domain, {
      directProxyCases: domainDirect.length,
      baseAnswerAtomSupportRecall: baseRecall,
      answerAtomSupportRecall: recall,
      answerAtomSupportRecallDelta: recall - baseRecall,
      meanInjectedTokens: mean(domainRows.map((row) => row.injectedTokens)),
    }];
  }));
  return {
    policy: params.policy,
    cases: rows.length,
    directProxyCases: direct.length,
    metrics: {
      answerAtomSupportRecall: mean(direct.map((row) => row.answerAtomSupportRecall!)),
      anyAnswerAtomSupportedRate: mean(direct.map((row) => row.anyAnswerAtomSupported!)),
      allAnswerAtomsSupportedRate: mean(direct.map((row) => row.allAnswerAtomsSupported!)),
      meanInjectedTokens: meanTokens,
      meanInjectedItems: mean(rows.map((row) => row.injectedIds.length)),
      queryLatencyP50Ms: percentile(rows.map((row) => row.totalQueryLatencyMs), 0.5),
      queryLatencyP95Ms: p95,
      tokenViolations: rows.filter((row) => row.tokenViolation).length,
      fallbacks: rows.filter((row) => row.fallback).length,
      auxiliaryUseRate: mean(rows.map((row) => row.usedAuxiliary ? 1 : 0)),
    },
    deltas: {
      answerAtomSupportRecall: mean(directDeltas),
      anyAnswerAtomSupportedRate: mean(direct.map((row) =>
        row.anyAnswerAtomSupported! - row.baseAnyAnswerAtomSupported!
      )),
      allAnswerAtomsSupportedRate: mean(direct.map((row) =>
        row.allAnswerAtomsSupported! - row.baseAllAnswerAtomsSupported!
      )),
      meanInjectedTokens: meanTokens - baseMeanTokens,
      meanInjectedTokenFraction: baseMeanTokens > 0 ? meanTokens / baseMeanTokens - 1 : 0,
      queryLatencyP95Ratio: baseP95 > 0 ? p95 / baseP95 : 0,
    },
    directProxyOutcomes: {
      improved: directDeltas.filter((delta) => delta > 1e-12).length,
      equal: directDeltas.filter((delta) => Math.abs(delta) <= 1e-12).length,
      harmed: directDeltas.filter((delta) => delta < -1e-12).length,
      harmedRate: direct.length
        ? directDeltas.filter((delta) => delta < -1e-12).length / direct.length
        : 0,
    },
    byDomain,
    forcedFallbackMismatches: {
      disabled: 0,
      missingIndex: 0,
      timeout: 0,
      corrupt: 0,
    },
    answerAtomSupportRecallDeltaBootstrap: params.includeBootstrap
      ? stratifiedQuestionBootstrap(
        rows,
        LONGMEMEVAL_V2_TRANSITION_PROTOCOL.aggregation.bootstrapSamples,
        LONGMEMEVAL_V2_TRANSITION_PROTOCOL.aggregation.bootstrapSeed,
      )
      : null,
  };
}

function comparePolicySummaries(left: TransitionPolicySummary, right: TransitionPolicySummary): number {
  return right.metrics.answerAtomSupportRecall - left.metrics.answerAtomSupportRecall
    || right.metrics.allAnswerAtomsSupportedRate - left.metrics.allAnswerAtomsSupportedRate
    || right.metrics.anyAnswerAtomSupportedRate - left.metrics.anyAnswerAtomSupportedRate
    || left.metrics.meanInjectedTokens - right.metrics.meanInjectedTokens
    || left.metrics.queryLatencyP95Ms - right.metrics.queryLatencyP95Ms
    || left.policy.id.localeCompare(right.policy.id);
}

function exactFallbackProof(params: {
  baseline: ReturnType<typeof packLongTaskContext>;
  rawCandidates: Awaited<ReturnType<MemoryCoreGroupBackend["search"]>>["candidates"];
  transitionCandidates: Awaited<ReturnType<MemoryCoreGroupBackend["search"]>>["candidates"];
  policy: TransitionPolicy;
}): { disabled: number; missingIndex: number; timeout: number; corrupt: number } {
  const protocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;
  const checks = {
    disabled: { enabled: false },
    missingIndex: { auxiliaryIndexAvailable: false },
    timeout: { timedOut: true },
    corrupt: { forceCorrupt: true },
  };
  return Object.fromEntries(Object.entries(checks).map(([name, override]) => {
    const result = selectTransitionAugmentedContext({
      baseline: params.baseline,
      rawCandidates: params.rawCandidates,
      transitionCandidates: params.transitionCandidates,
      policy: params.policy,
      tokenBudget: protocol.baseline.injectionTokenBudget,
      resultLimit: protocol.baseline.resultLimit,
      ...override,
    });
    const mismatch = !exactIds(result.items.map((item) => item.id), params.baseline.items.map((item) => item.id))
      || result.injectedTokens !== params.baseline.injectedTokens;
    return [name, mismatch ? 1 : 0];
  })) as { disabled: number; missingIndex: number; timeout: number; corrupt: number };
}

function validationGate(summary: TransitionPolicySummary): { passed: boolean; checks: Record<string, boolean> } {
  const gate = LONGMEMEVAL_V2_TRANSITION_PROTOCOL.validationGate;
  const forced = summary.forcedFallbackMismatches;
  const checks = {
    answerAtomSupportRecallDelta:
      summary.deltas.answerAtomSupportRecall >= gate.minAnswerAtomSupportRecallDelta,
    allAnswerAtomsSupportedRateDelta:
      summary.deltas.allAnswerAtomsSupportedRate >= gate.minAllAnswerAtomsSupportedRateDelta,
    harmedCaseRate: summary.directProxyOutcomes.harmedRate <= gate.maxDirectProxyHarmedCaseRate,
    meanInjectedTokens:
      summary.deltas.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
    tokenViolations: summary.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    ordinaryFallbacks: summary.metrics.fallbacks <= gate.maxOrdinaryFallbacks,
    p95Latency: summary.deltas.queryLatencyP95Ratio <= gate.maxP95TotalQueryLatencyRatio,
    disabledFallback: forced.disabled === 0,
    missingIndexFallback: forced.missingIndex === 0,
    timeoutFallback: forced.timeout === 0,
    corruptFallback: forced.corrupt === 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function testGate(summary: TransitionPolicySummary): { passed: boolean; checks: Record<string, boolean> } {
  const gate = LONGMEMEVAL_V2_TRANSITION_PROTOCOL.testGate;
  const bootstrap = summary.answerAtomSupportRecallDeltaBootstrap!;
  const checks = {
    answerAtomSupportRecallDelta:
      summary.deltas.answerAtomSupportRecall >= gate.minAnswerAtomSupportRecallDelta,
    answerAtomSupportRecallBootstrapLower:
      bootstrap.lower >= gate.minAnswerAtomSupportRecallBootstrapLower,
    allAnswerAtomsSupportedRateDelta:
      summary.deltas.allAnswerAtomsSupportedRate >= gate.minAllAnswerAtomsSupportedRateDelta,
    meanInjectedTokens:
      summary.deltas.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
    tokenViolations: summary.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    ordinaryFallbacks: summary.metrics.fallbacks <= gate.maxOrdinaryFallbacks,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function runLongMemEvalV2Transition(params: {
  dataRoot: string;
  phase: LongMemEvalV2Phase;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  preScoreCommit: string;
  selectionArtifactPath?: string;
}): Promise<{
  cases: LongMemEvalV2TransitionCase[];
  summary: LongMemEvalV2TransitionSummary;
  selection: LongMemEvalV2TransitionSelectionArtifact | null;
}> {
  const protocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;
  if (!/^[0-9a-f]{7,40}$/.test(params.preScoreCommit)) {
    throw new Error(`invalid LongMemEval-V2 pre-score commit ${params.preScoreCommit}`);
  }
  const lockedBaseline = await loadLockedBaseline({
    casesPath: params.baselineCasesPath,
    summaryPath: params.baselineSummaryPath,
    phase: params.phase,
  });
  const policyGrid = buildTransitionPolicyGrid({
    candidateLimits: protocol.challenger.transitionCandidateLimits,
    tokenFractions: protocol.challenger.transitionTokenFractions,
    maxItems: protocol.challenger.maxTransitionItems,
  });
  let policies = policyGrid;
  let selectionArtifactSha256: string | null = null;
  if (params.phase !== "development") {
    if (!params.selectionArtifactPath) throw new Error(`${params.phase} requires a development selection artifact`);
    const selectionText = await readFile(params.selectionArtifactPath, "utf8");
    const selection = JSON.parse(selectionText) as LongMemEvalV2TransitionSelectionArtifact;
    selectionArtifactSha256 = createHash("sha256").update(selectionText).digest("hex");
    const selected = policyGrid.find((policy) => policy.id === selection.selectedPolicy.id);
    if (selection.selectionVersion !== "lifecycle-longmemeval-v2-transition-selection-v1.0"
      || selection.sourceProtocolVersion !== protocol.protocolVersion
      || selection.status !== "selected"
      || !selected
      || JSON.stringify(selected) !== JSON.stringify(selection.selectedPolicy)) {
      throw new Error("invalid LongMemEval-V2 development selection artifact");
    }
    policies = [selected];
  }

  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    tier: protocol.dataset.tier,
    expected: {
      questions: protocol.dataset.questions,
      trajectoryRows: protocol.dataset.trajectoryRows,
      selectedTrajectories: protocol.dataset.selectedTrajectories,
      haystackSize: 100,
      questionsSha256: protocol.dataset.questionsSha256,
      haystackSha256: protocol.dataset.haystackSha256,
      trajectoriesSha256: protocol.dataset.trajectoriesSha256,
    },
  });
  const allQuestions = await adapter.loadQuestions();
  const questionById = new Map(allQuestions.map((question) => [question.id, question]));
  const questions = questionIdsForLongMemEvalV2Phase(params.phase).map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing LongMemEval-V2 ${params.phase} question ${id}`);
    return question;
  });
  const trajectories = await adapter.loadTrajectories(
    [...new Set(questions.flatMap((question) => question.trajectoryIds))],
  );
  const byDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = byDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    byDomain.set(trajectory.domain, values);
  }
  const rawBackends = new Map<string, MemoryCoreGroupBackend>();
  const transitionBackends = new Map<string, MemoryCoreGroupBackend>();
  const index: LongMemEvalV2TransitionSummary["index"] = {};
  try {
    for (const [domain, domainTrajectories] of [...byDomain.entries()].sort()) {
      const rawStarted = performance.now();
      const raw = buildRawStateUnits({
        trajectories: domainTrajectories,
        config: {
          maxCharacters: protocol.baseline.rawChunkMaxCharacters,
          overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
          maxChunksPerState: protocol.baseline.maxRawChunksPerState,
        },
      });
      rawBackends.set(domain, new MemoryCoreGroupBackend(raw.units));
      const rawBuildLatencyMs = performance.now() - rawStarted;
      const transitionStarted = performance.now();
      const transition = buildTransitionUnits({
        trajectories: domainTrajectories,
        config: {
          maxCharacters: protocol.challenger.diffChunkMaxCharacters,
          maxChunksPerTransition: protocol.challenger.maxDiffChunksPerTransition,
          maxAuxiliaryUnits: protocol.challenger.maxAuxiliaryUnits,
        },
      });
      transitionBackends.set(domain, new MemoryCoreGroupBackend(transition.units));
      index[domain] = {
        trajectories: domainTrajectories.length,
        states: domainTrajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0),
        rawUnits: raw.units.length,
        rawTruncatedStates: raw.truncatedStates,
        transitionUnits: transition.units.length,
        transitions: transition.transitions,
        noTextDeltaTransitions: transition.transitionsWithNoTextDelta,
        truncatedTransitions: transition.truncatedTransitions,
        addedLines: transition.addedLines,
        removedLines: transition.removedLines,
        rawBuildLatencyMs,
        transitionBuildLatencyMs: performance.now() - transitionStarted,
      };
    }
    const auxiliaryUnits = Object.values(index).reduce(
      (sum, value) => sum + value.transitionUnits,
      0,
    );
    if (auxiliaryUnits > protocol.challenger.maxAuxiliaryUnits) {
      throw new Error(
        `LongMemEval-V2 auxiliary index exceeds frozen global cap: ${auxiliaryUnits}`,
      );
    }

    const cases: LongMemEvalV2TransitionCase[] = [];
    const forcedByPolicy = new Map(policies.map((policy) => [policy.id, {
      disabled: 0,
      missingIndex: 0,
      timeout: 0,
      corrupt: 0,
    }]));
    const maxTransitionCandidateLimit = Math.max(...policyGrid.map((policy) =>
      policy.transitionCandidateLimit
    ));
    for (const question of questions) {
      const rawBackend = rawBackends.get(question.domain);
      const transitionBackend = transitionBackends.get(question.domain);
      if (!rawBackend || !transitionBackend) throw new Error(`missing D7 backend for ${question.domain}`);
      const query = sanitizeLongTaskQuery(question.prompt);
      const rawSearch = await rawBackend.search(query, protocol.baseline.candidateLimit);
      const baseline = packLongTaskContext({
        candidates: rawSearch.candidates,
        tokenBudget: protocol.baseline.injectionTokenBudget,
        resultLimit: protocol.baseline.resultLimit,
      });
      const baseSupport = scoreDirectAnswerSupport(question, baseline.items);
      const locked = lockedBaseline.byQuestionId.get(question.id);
      if (!locked) throw new Error(`locked baseline missing ${question.id}`);
      assertRecomputedBaseline(locked, {
        candidateIds: rawSearch.candidates.map((item) => item.id),
        injectedIds: baseline.items.map((item) => item.id),
        injectedTokens: baseline.injectedTokens,
        answerAtomSupportRecall: baseSupport?.answerAtomSupportRecall ?? null,
        anyAnswerAtomSupported: baseSupport?.anyAnswerAtomSupported ?? null,
        allAnswerAtomsSupported: baseSupport?.allAnswerAtomsSupported ?? null,
      });
      let transitionCandidates: Awaited<ReturnType<MemoryCoreGroupBackend["search"]>>["candidates"] = [];
      let transitionQueryLatencyMs = 0;
      let transitionTimedOut = false;
      let transitionSearchFailed = false;
      try {
        const transitionSearch = await transitionBackend.search(query, maxTransitionCandidateLimit);
        transitionCandidates = transitionSearch.candidates;
        transitionQueryLatencyMs = transitionSearch.latencyMs;
        transitionTimedOut = transitionQueryLatencyMs > TRANSITION_SIDECAR_TIMEOUT_MS;
      } catch {
        transitionSearchFailed = true;
      }
      for (const policy of policies) {
        const selection = selectTransitionAugmentedContext({
          baseline,
          rawCandidates: rawSearch.candidates,
          transitionCandidates,
          policy,
          tokenBudget: protocol.baseline.injectionTokenBudget,
          resultLimit: protocol.baseline.resultLimit,
          auxiliaryIndexAvailable: !transitionSearchFailed,
          timedOut: transitionTimedOut,
        });
        const support = scoreDirectAnswerSupport(question, selection.items);
        const forced = exactFallbackProof({
          baseline,
          rawCandidates: rawSearch.candidates,
          transitionCandidates,
          policy,
        });
        const accumulated = forcedByPolicy.get(policy.id)!;
        accumulated.disabled += forced.disabled;
        accumulated.missingIndex += forced.missingIndex;
        accumulated.timeout += forced.timeout;
        accumulated.corrupt += forced.corrupt;
        cases.push({
          protocolVersion: protocol.protocolVersion,
          mode: "transition_diff",
          phase: params.phase,
          policyId: policy.id,
          questionId: question.id,
          domain: question.domain,
          environment: question.environment,
          evaluatorFamily: evaluatorFamily(question),
          directProxy: support !== null,
          query,
          baseCandidateIds: rawSearch.candidates.map((item) => item.id),
          baseInjectedIds: baseline.items.map((item) => item.id),
          baseInjectedTokens: baseline.injectedTokens,
          baseAnswerAtomSupportRecall: baseSupport?.answerAtomSupportRecall ?? null,
          baseAnyAnswerAtomSupported: baseSupport?.anyAnswerAtomSupported ?? null,
          baseAllAnswerAtomsSupported: baseSupport?.allAnswerAtomsSupported ?? null,
          transitionCandidateIds: transitionCandidates
            .slice(0, policy.transitionCandidateLimit)
            .map((item) => item.id),
          injectedIds: selection.items.map((item) => item.id),
          transitionIds: selection.transitionIds,
          rawIds: selection.rawIds,
          injectedTokens: selection.injectedTokens,
          tokenViolation: selection.tokenViolation,
          rawQueryLatencyMs: rawSearch.latencyMs,
          transitionQueryLatencyMs,
          totalQueryLatencyMs: rawSearch.latencyMs + transitionQueryLatencyMs,
          usedAuxiliary: selection.usedAuxiliary,
          selectionMode: selection.mode,
          fallback: selection.fallback,
          fallbackReason: selection.fallbackReason,
          answerAtomCount: support?.answerAtoms.length ?? null,
          supportedAtomCount: support?.supportedAtomCount ?? null,
          answerAtomSupportRecall: support?.answerAtomSupportRecall ?? null,
          anyAnswerAtomSupported: support?.anyAnswerAtomSupported ?? null,
          allAnswerAtomsSupported: support?.allAnswerAtomsSupported ?? null,
          answerAtomSupportRecallDelta: support && baseSupport
            ? support.answerAtomSupportRecall - baseSupport.answerAtomSupportRecall
            : null,
        });
      }
    }
    cases.sort((left, right) =>
      left.policyId.localeCompare(right.policyId) || left.questionId.localeCompare(right.questionId)
    );
    const casesText = cases.map((item) => `${JSON.stringify(item)}\n`).join("");
    const casesSha256 = createHash("sha256").update(casesText).digest("hex");
    const policySummaries = policies.map((policy) => {
      const summary = summarizePolicy({
        policy,
        rows: cases.filter((row) => row.policyId === policy.id),
        lockedBaseline,
        includeBootstrap: params.phase !== "development",
      });
      summary.forcedFallbackMismatches = forcedByPolicy.get(policy.id)!;
      return summary;
    }).sort(comparePolicySummaries);
    const selectedPolicy = policySummaries[0].policy;
    let gate: LongMemEvalV2TransitionSummary["gate"] = null;
    let status: LongMemEvalV2TransitionSummary["status"] = "development_selected";
    if (params.phase === "validation") {
      gate = validationGate(policySummaries[0]);
      status = gate.passed ? "validation_passed" : "validation_failed";
    } else if (params.phase === "test") {
      gate = testGate(policySummaries[0]);
      status = gate.passed ? "test_passed" : "test_failed";
    }
    const policyGridSha256 = createHash("sha256").update(JSON.stringify(policyGrid)).digest("hex");
    const selection: LongMemEvalV2TransitionSelectionArtifact | null = params.phase === "development"
      ? {
        selectionVersion: "lifecycle-longmemeval-v2-transition-selection-v1.0",
        sourceProtocolVersion: protocol.protocolVersion,
        status: "selected",
        phase: "development",
        preScoreCommit: params.preScoreCommit,
        selectedPolicy,
        ranking: policySummaries.map((summary) => summary.policy.id),
        developmentCasesSha256: casesSha256,
        baselineCasesSha256: lockedBaseline.casesSha256,
        baselineSummarySha256: lockedBaseline.summarySha256,
        policyGridSha256,
        objectiveValues: {
          answerAtomSupportRecall: policySummaries[0].metrics.answerAtomSupportRecall,
          allAnswerAtomsSupportedRate: policySummaries[0].metrics.allAnswerAtomsSupportedRate,
          anyAnswerAtomSupportedRate: policySummaries[0].metrics.anyAnswerAtomSupportedRate,
          meanInjectedTokens: policySummaries[0].metrics.meanInjectedTokens,
          queryLatencyP95Ms: policySummaries[0].metrics.queryLatencyP95Ms,
        },
      }
      : null;
    return {
      cases,
      summary: {
        protocolVersion: protocol.protocolVersion,
        mode: "transition_diff",
        phase: params.phase,
        status,
        preScoreCommit: params.preScoreCommit,
        selectionArtifactSha256,
        baseline: {
          casesSha256: lockedBaseline.casesSha256,
          summarySha256: lockedBaseline.summarySha256,
        },
        index,
        policySummaries,
        selectedPolicy,
        casesSha256,
        gate,
      },
      selection,
    };
  } finally {
    for (const backend of rawBackends.values()) backend.close();
    for (const backend of transitionBackends.values()) backend.close();
  }
}
