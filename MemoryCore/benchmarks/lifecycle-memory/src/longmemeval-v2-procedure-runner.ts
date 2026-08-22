import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import {
  buildRawStateUnits,
  packLongTaskContext,
  sanitizeLongTaskQuery,
  type PackedLongTaskContext,
} from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  aggregateProcedureCases,
  mean,
  percentile,
  type LongMemEvalV2ProcedureBaselineCase,
  type LongMemEvalV2ProcedureBaselineSummary,
  type ProcedureAggregateMetrics,
  type ProcedureTestReadAuthorization,
} from "./longmemeval-v2-procedure-baseline-runner.js";
import {
  LONGMEMEVAL_V2_PROCEDURE_PROTOCOL,
  LONGMEMEVAL_V2_PROCEDURE_SPLIT,
  procedureQuestionIdsForPhase,
  type LongMemEvalV2ProcedurePhase,
} from "./longmemeval-v2-procedure-protocol.js";
import {
  buildProcedureFeedbackTable,
  buildProcedureIndex,
  buildProcedureOutcomeEvents,
  buildProcedurePolicyGrid,
  scoreProcedureDirectSupport,
  selectProcedureContext,
  type ProcedureFeedbackTable,
  type ProcedurePolicy,
  type ProcedureRecord,
  type ProcedureSelectionArm,
} from "./longmemeval-v2-procedure.js";
import {
  buildLongMemEvalV2ProcedureQuestionSplit,
  longMemEvalV2ProcedureEvaluatorFamily,
  type LongMemEvalV2ProcedureEvaluatorFamily,
} from "./longmemeval-v2-procedure-split.js";
import type { RetrievedUnit } from "./types.js";

export interface LongMemEvalV2ProcedureSelectionArtifact {
  selectionVersion: "lifecycle-longmemeval-v2-procedure-selection-v1.0";
  sourceProtocolVersion: string;
  status: "selected";
  phase: "development";
  preScoreCommit: string;
  selectedPolicy: ProcedurePolicy;
  ranking: string[];
  developmentCasesSha256: string;
  baselineCasesSha256: string;
  baselineSummarySha256: string;
  policyGridSha256: string;
  objectiveValues: {
    answerAtomSupportRecall: number;
    orderedSequenceSupportedRate: number;
    allAnswerAtomsSupportedRate: number;
    improvedDirectProxyCasesVsOutcomeAgnostic: number;
    meanInjectedTokens: number;
    selectionLatencyP95Ms: number;
  };
}

export interface LongMemEvalV2ProcedureAdmissionArtifact extends ProcedureTestReadAuthorization {
  selectedPolicy: ProcedurePolicy;
  validationCasesSha256: string;
  selectionArtifactSha256: string;
  gateChecks: Record<string, boolean>;
}

export interface LongMemEvalV2ProcedureCase {
  protocolVersion: string;
  mode: "procedure_memory";
  phase: LongMemEvalV2ProcedurePhase;
  policyId: string;
  arm: ProcedureSelectionArm;
  questionId: string;
  domain: string;
  environment: string;
  evaluatorFamily: LongMemEvalV2ProcedureEvaluatorFamily;
  directProxy: boolean;
  orderedQuestion: boolean;
  query: string;
  baseCandidateIds: string[];
  baseInjectedIds: string[];
  baseInjectedTokens: number;
  baseAnswerAtomSupportRecall: number | null;
  baseAllAnswerAtomsSupported: number | null;
  baseOrderedSequenceSupported: number | null;
  procedureCandidateIds: string[];
  injectedIds: string[];
  procedureIds: string[];
  rawIds: string[];
  injectedTokens: number;
  tokenViolation: boolean;
  rawQueryLatencyMs: number;
  procedureQueryLatencyMs: number;
  selectionLatencyMs: number;
  queryLatencyMs: number;
  usedProcedure: boolean;
  selectionMode: "procedure_augmented" | "baseline_noop" | "fallback_baseline";
  decisionReason: string;
  fallback: boolean;
  fallbackReason: string | null;
  answerAtomCount: number | null;
  supportedAtomCount: number | null;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  orderedSequenceSupported: number | null;
  answerAtomSupportRecallDelta: number | null;
  forcedFallbackMismatches: Record<string, number>;
}

interface DirectOutcomes {
  improved: number;
  equal: number;
  harmed: number;
}

interface ProcedureFeedbackComparison {
  changedContexts: number;
  answerAtomSupportRecallDelta: number;
  improvedDirectProxyCases: number;
  equalDirectProxyCases: number;
  harmedDirectProxyCases: number;
}

export interface ProcedureArmSummary {
  policy: ProcedurePolicy;
  arm: ProcedureSelectionArm;
  cases: number;
  directProxyCases: number;
  orderedProxyCases: number;
  metrics: ProcedureAggregateMetrics & {
    procedureUseRate: number;
    selectionLatencyP50Ms: number;
    selectionLatencyP95Ms: number;
  };
  deltasVsBaseline: {
    answerAtomSupportRecall: number;
    anyAnswerAtomSupportedRate: number;
    allAnswerAtomsSupportedRate: number;
    orderedSequenceSupportedRate: number;
    meanInjectedTokens: number;
    meanInjectedTokenFraction: number;
  };
  directProxyOutcomesVsBaseline: DirectOutcomes;
  byDomain: Record<string, {
    directProxyCases: number;
    baseAnswerAtomSupportRecall: number;
    answerAtomSupportRecall: number;
    answerAtomSupportRecallDelta: number;
    meanInjectedTokens: number;
  }>;
  answerAtomSupportRecallDeltaBootstrap: {
    mean: number;
    lower: number;
    upper: number;
    questions: number;
    strata: number;
  } | null;
  forcedFallbackMismatches: Record<string, number>;
}

export interface LongMemEvalV2ProcedureSummary {
  protocolVersion: string;
  mode: "procedure_memory";
  phase: LongMemEvalV2ProcedurePhase;
  status: "development_selected" | "validation_passed" | "validation_failed" | "test_passed" | "test_failed";
  preScoreCommit: string;
  selectionArtifactSha256: string | null;
  baseline: { casesSha256: string; summarySha256: string };
  index: Record<string, {
    trajectories: number;
    states: number;
    rawUnits: number;
    rawTruncatedStates: number;
    procedureUnits: number;
    successfulProcedures: number;
    failedProcedures: number;
    actions: number;
    maskedTargets: number;
    truncatedProcedures: number;
    rawBuildLatencyMs: number;
    procedureBuildLatencyMs: number;
  }>;
  feedback: {
    events: number;
    entries: number;
    capacity: number;
    available: boolean;
    failureReason: string | null;
  };
  armSummaries: ProcedureArmSummary[];
  feedbackComparisons: Record<string, ProcedureFeedbackComparison>;
  selectedPolicy: ProcedurePolicy;
  casesSha256: string;
  gate: { passed: boolean; checks: Record<string, boolean> } | null;
}

interface LockedBaseline {
  cases: LongMemEvalV2ProcedureBaselineCase[];
  byQuestionId: Map<string, LongMemEvalV2ProcedureBaselineCase>;
  summary: LongMemEvalV2ProcedureBaselineSummary;
  casesSha256: string;
  summarySha256: string;
}

interface LoadedSelection {
  artifact: LongMemEvalV2ProcedureSelectionArtifact;
  sha256: string;
}

function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function loadLockedBaseline(params: {
  casesPath: string;
  summaryPath: string;
  phase: LongMemEvalV2ProcedurePhase;
}): Promise<LockedBaseline> {
  const [casesText, summaryText] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
  ]);
  const cases = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2ProcedureBaselineCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2ProcedureBaselineSummary;
  const casesSha256 = createHash("sha256").update(casesText).digest("hex");
  const summarySha256 = createHash("sha256").update(summaryText).digest("hex");
  if (summary.protocolVersion !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion
    || summary.phase !== params.phase
    || summary.mode !== "base"
    || summary.casesSha256 !== casesSha256
    || cases.length !== summary.cases
    || cases.some((item) => item.phase !== params.phase || item.mode !== "base")) {
    throw new Error("D9 locked baseline identity mismatch");
  }
  return { cases, byQuestionId: new Map(cases.map((item) => [item.questionId, item])), summary, casesSha256, summarySha256 };
}

async function loadSelection(path: string): Promise<LoadedSelection> {
  const text = await readFile(path, "utf8");
  const artifact = JSON.parse(text) as LongMemEvalV2ProcedureSelectionArtifact;
  if (artifact.selectionVersion !== "lifecycle-longmemeval-v2-procedure-selection-v1.0"
    || artifact.sourceProtocolVersion !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion
    || artifact.status !== "selected"
    || artifact.phase !== "development") {
    throw new Error("D9 selection artifact identity mismatch");
  }
  return { artifact, sha256: createHash("sha256").update(text).digest("hex") };
}

function assertFrozenProcedureSplit(questions: LongTaskQuestion[]): void {
  const generated = buildLongMemEvalV2ProcedureQuestionSplit({
    questions,
    revision: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.benchmarkRepositoryRevision,
    questionsSha256: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_PROCEDURE_SPLIT.seed,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_PROCEDURE_SPLIT)) {
    throw new Error("D9 generated procedure split differs from the frozen split");
  }
}

function assertBaselineRecomputed(params: {
  locked: LongMemEvalV2ProcedureBaselineCase;
  query: string;
  candidates: RetrievedUnit[];
  packed: PackedLongTaskContext;
  support: ReturnType<typeof scoreProcedureDirectSupport>;
}): void {
  if (params.locked.query !== params.query
    || !exactIds(params.locked.candidateIds, params.candidates.map((item) => item.id))
    || !exactIds(params.locked.injectedIds, params.packed.items.map((item) => item.id))
    || params.locked.injectedTokens !== params.packed.injectedTokens
    || params.locked.answerAtomSupportRecall !== (params.support?.answerAtomSupportRecall ?? null)
    || params.locked.allAnswerAtomsSupported !== (params.support?.allAnswerAtomsSupported ?? null)
    || params.locked.orderedSequenceSupported !== (params.support?.orderedSequenceSupported ?? null)) {
    throw new Error(`D9 recomputed baseline differs for ${params.locked.questionId}`);
  }
}

function exactContext(result: { items: RetrievedUnit[]; injectedTokens: number }, baseline: PackedLongTaskContext): boolean {
  return result.injectedTokens === baseline.injectedTokens
    && result.items.length === baseline.items.length
    && result.items.every((item, index) => item.id === baseline.items[index].id
      && item.content === baseline.items[index].content
      && item.tokenCount === baseline.items[index].tokenCount);
}

function forcedFallbackChecks(params: {
  baseline: PackedLongTaskContext;
  rawCandidates: RetrievedUnit[];
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, ProcedureRecord>;
  feedbackTable: ProcedureFeedbackTable;
  policy: ProcedurePolicy;
  tokenBudget: number;
  resultLimit: number;
}): Record<string, number> {
  const common = {
    ...params,
    arm: "outcome_gated" as const,
  };
  const overflow = buildProcedureFeedbackTable({ events: [
    { procedureId: "lmev2:procedure:overflow-a", outcome: "success", confidence: 1, provenance: "forced", observedAtMs: 1 },
    { procedureId: "lmev2:procedure:overflow-b", outcome: "success", confidence: 1, provenance: "forced", observedAtMs: 2 },
  ], capacity: 1 });
  const checks = {
    disabled: selectProcedureContext({ ...common, enabled: false }),
    missingProcedureIndex: selectProcedureContext({ ...common, procedureIndexAvailable: false }),
    missingFeedbackTable: selectProcedureContext({ ...common, feedbackTable: undefined }),
    feedbackTableOverflow: selectProcedureContext({ ...common, feedbackTable: overflow }),
    timeout: selectProcedureContext({ ...common, timedOut: true }),
    corrupt: selectProcedureContext({ ...common, forceCorrupt: true }),
    budgetOverflow: selectProcedureContext({ ...common, forceBudgetOverflow: true }),
  };
  return Object.fromEntries(Object.entries(checks).map(([key, result]) => [
    key,
    result.fallback && exactContext(result, params.baseline) ? 0 : 1,
  ]));
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

function quantile(values: number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function bootstrapDelta(cases: LongMemEvalV2ProcedureCase[], seed: number): ProcedureArmSummary["answerAtomSupportRecallDeltaBootstrap"] {
  const rows = cases.filter((item) => item.directProxy).map((item) => ({
    domain: item.domain,
    delta: item.answerAtomSupportRecallDelta!,
  }));
  if (rows.length === 0) return null;
  const groups = [...new Set(rows.map((item) => item.domain))].sort()
    .map((domain) => rows.filter((item) => item.domain === domain));
  const random = mulberry32(seed);
  const estimates: number[] = [];
  for (let sample = 0; sample < LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const drawn = groups.flatMap((group) => Array.from({ length: group.length }, () =>
      group[Math.floor(random() * group.length)].delta));
    estimates.push(mean(drawn));
  }
  return {
    mean: mean(rows.map((item) => item.delta)),
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
    questions: rows.length,
    strata: groups.length,
  };
}

function outcomes(cases: LongMemEvalV2ProcedureCase[]): DirectOutcomes {
  const deltas = cases.filter((item) => item.directProxy).map((item) => item.answerAtomSupportRecallDelta!);
  return {
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
  };
}

function summarizeArm(params: {
  policy: ProcedurePolicy;
  arm: ProcedureSelectionArm;
  cases: LongMemEvalV2ProcedureCase[];
  baseline: LongMemEvalV2ProcedureBaselineSummary;
  seed: number;
}): ProcedureArmSummary {
  const metricsBase = aggregateProcedureCases(params.cases);
  const metrics = {
    ...metricsBase,
    procedureUseRate: mean(params.cases.map((item) => item.usedProcedure ? 1 : 0)),
    selectionLatencyP50Ms: percentile(params.cases.map((item) => item.selectionLatencyMs), 0.5),
    selectionLatencyP95Ms: percentile(params.cases.map((item) => item.selectionLatencyMs), 0.95),
  };
  const directOutcomes = outcomes(params.cases);
  const byDomain = Object.fromEntries([...new Set(params.cases.map((item) => item.domain))].sort().map((domain) => {
    const domainCases = params.cases.filter((item) => item.domain === domain && item.directProxy);
    const base = mean(domainCases.map((item) => item.baseAnswerAtomSupportRecall!));
    const candidate = mean(domainCases.map((item) => item.answerAtomSupportRecall!));
    return [domain, {
      directProxyCases: domainCases.length,
      baseAnswerAtomSupportRecall: base,
      answerAtomSupportRecall: candidate,
      answerAtomSupportRecallDelta: candidate - base,
      meanInjectedTokens: mean(params.cases.filter((item) => item.domain === domain).map((item) => item.injectedTokens)),
    }];
  }));
  const forcedFallbackMismatches: Record<string, number> = {};
  for (const item of params.cases) {
    for (const [key, value] of Object.entries(item.forcedFallbackMismatches)) {
      forcedFallbackMismatches[key] = (forcedFallbackMismatches[key] ?? 0) + value;
    }
  }
  const baselineTokens = params.baseline.metrics.meanInjectedTokens;
  return {
    policy: params.policy,
    arm: params.arm,
    cases: params.cases.length,
    directProxyCases: params.cases.filter((item) => item.directProxy).length,
    orderedProxyCases: params.cases.filter((item) => item.orderedQuestion).length,
    metrics,
    deltasVsBaseline: {
      answerAtomSupportRecall: metrics.answerAtomSupportRecall - params.baseline.metrics.answerAtomSupportRecall,
      anyAnswerAtomSupportedRate: metrics.anyAnswerAtomSupportedRate - params.baseline.metrics.anyAnswerAtomSupportedRate,
      allAnswerAtomsSupportedRate: metrics.allAnswerAtomsSupportedRate - params.baseline.metrics.allAnswerAtomsSupportedRate,
      orderedSequenceSupportedRate: metrics.orderedSequenceSupportedRate - params.baseline.metrics.orderedSequenceSupportedRate,
      meanInjectedTokens: metrics.meanInjectedTokens - baselineTokens,
      meanInjectedTokenFraction: baselineTokens === 0 ? 0 : (metrics.meanInjectedTokens - baselineTokens) / baselineTokens,
    },
    directProxyOutcomesVsBaseline: directOutcomes,
    byDomain,
    answerAtomSupportRecallDeltaBootstrap: bootstrapDelta(params.cases, params.seed),
    forcedFallbackMismatches,
  };
}

function compareFeedbackArms(gated: LongMemEvalV2ProcedureCase[], agnostic: LongMemEvalV2ProcedureCase[]): ProcedureFeedbackComparison {
  const agnosticByQuestion = new Map(agnostic.map((item) => [item.questionId, item]));
  let changedContexts = 0;
  const deltas: number[] = [];
  for (const candidate of gated) {
    const control = agnosticByQuestion.get(candidate.questionId);
    if (!control) throw new Error(`missing D9 outcome-agnostic case ${candidate.questionId}`);
    if (!exactIds(candidate.injectedIds, control.injectedIds)) changedContexts += 1;
    if (candidate.directProxy) deltas.push(candidate.answerAtomSupportRecall! - control.answerAtomSupportRecall!);
  }
  return {
    changedContexts,
    answerAtomSupportRecallDelta: mean(deltas),
    improvedDirectProxyCases: deltas.filter((value) => value > 1e-12).length,
    equalDirectProxyCases: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmedDirectProxyCases: deltas.filter((value) => value < -1e-12).length,
  };
}

function policyGrid(): ProcedurePolicy[] {
  const config = LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.procedureMemory;
  return buildProcedurePolicyGrid({
    candidateLimits: config.candidateLimits,
    tokenFractions: config.tokenFractions,
    maxItems: config.maxProcedureItems,
  });
}

function policyRanking(
  summaries: ProcedureArmSummary[],
  comparisons: Record<string, ProcedureFeedbackComparison>,
): ProcedureArmSummary[] {
  return summaries.filter((item) => item.arm === "outcome_gated").sort((left, right) =>
    right.metrics.answerAtomSupportRecall - left.metrics.answerAtomSupportRecall
    || right.metrics.orderedSequenceSupportedRate - left.metrics.orderedSequenceSupportedRate
    || right.metrics.allAnswerAtomsSupportedRate - left.metrics.allAnswerAtomsSupportedRate
    || comparisons[right.policy.id].improvedDirectProxyCases - comparisons[left.policy.id].improvedDirectProxyCases
    || left.metrics.meanInjectedTokens - right.metrics.meanInjectedTokens
    || left.metrics.selectionLatencyP95Ms - right.metrics.selectionLatencyP95Ms
    || left.policy.id.localeCompare(right.policy.id));
}

function evaluateGate(params: {
  phase: "validation" | "test";
  selected: ProcedureArmSummary;
  feedback: ProcedureFeedbackComparison;
}): { passed: boolean; checks: Record<string, boolean> } {
  const gate = LONGMEMEVAL_V2_PROCEDURE_PROTOCOL[
    params.phase === "validation" ? "validationGate" : "testGate"
  ];
  const bootstrapLower = params.selected.answerAtomSupportRecallDeltaBootstrap?.lower ?? Number.NEGATIVE_INFINITY;
  const checks = {
    minAnswerAtomSupportRecallDeltaVsBaseline:
      params.selected.deltasVsBaseline.answerAtomSupportRecall >= gate.minAnswerAtomSupportRecallDeltaVsBaseline,
    minAnswerAtomSupportRecallBootstrapLowerVsBaseline:
      bootstrapLower >= gate.minAnswerAtomSupportRecallBootstrapLowerVsBaseline,
    minImprovedDirectProxyCasesVsBaseline:
      params.selected.directProxyOutcomesVsBaseline.improved >= gate.minImprovedDirectProxyCasesVsBaseline,
    maxHarmedDirectProxyCasesVsBaseline:
      params.selected.directProxyOutcomesVsBaseline.harmed <= gate.maxHarmedDirectProxyCasesVsBaseline,
    minOrderedSequenceSupportedRateDeltaVsBaseline:
      params.selected.deltasVsBaseline.orderedSequenceSupportedRate >= gate.minOrderedSequenceSupportedRateDeltaVsBaseline,
    minChangedContextsVsOutcomeAgnostic:
      params.feedback.changedContexts >= gate.minChangedContextsVsOutcomeAgnostic,
    minImprovedDirectProxyCasesVsOutcomeAgnostic:
      params.feedback.improvedDirectProxyCases >= gate.minImprovedDirectProxyCasesVsOutcomeAgnostic,
    maxHarmedDirectProxyCasesVsOutcomeAgnostic:
      params.feedback.harmedDirectProxyCases <= gate.maxHarmedDirectProxyCasesVsOutcomeAgnostic,
    minAnswerAtomSupportRecallDeltaVsOutcomeAgnostic:
      params.feedback.answerAtomSupportRecallDelta >= gate.minAnswerAtomSupportRecallDeltaVsOutcomeAgnostic,
    maxMeanInjectedTokenIncreaseFraction:
      params.selected.deltasVsBaseline.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
    maxPerQueryTokenViolations:
      params.selected.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    maxOrdinaryFallbacks: params.selected.metrics.fallbacks <= gate.maxOrdinaryFallbacks,
    maxP95SelectionLatencyMs:
      params.selected.metrics.selectionLatencyP95Ms <= gate.maxP95SelectionLatencyMs,
    requireExactForcedFallbacks: !gate.requireExactForcedFallbacks
      || Object.values(params.selected.forcedFallbackMismatches).every((value) => value === 0),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function runLongMemEvalV2Procedure(params: {
  dataRoot: string;
  phase: LongMemEvalV2ProcedurePhase;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  preScoreCommit: string;
  selectionArtifactPath?: string;
  testReadAuthorization?: LongMemEvalV2ProcedureAdmissionArtifact;
}): Promise<{
  cases: LongMemEvalV2ProcedureCase[];
  summary: LongMemEvalV2ProcedureSummary;
  selectionArtifact: LongMemEvalV2ProcedureSelectionArtifact | null;
}> {
  if (!/^[0-9a-f]{7,40}$/i.test(params.preScoreCommit)) throw new Error("invalid D9 pre-score commit");
  const protocol = LONGMEMEVAL_V2_PROCEDURE_PROTOCOL;
  const lockedBaseline = await loadLockedBaseline({
    casesPath: params.baselineCasesPath,
    summaryPath: params.baselineSummaryPath,
    phase: params.phase,
  });
  const loadedSelection = params.phase === "development" ? null
    : params.selectionArtifactPath ? await loadSelection(params.selectionArtifactPath)
      : (() => { throw new Error(`${params.phase} requires the locked D9 selection artifact`); })();
  if (params.phase === "test") {
    const authorization = params.testReadAuthorization;
    if (!authorization
      || authorization.admissionVersion !== "lifecycle-longmemeval-v2-procedure-admission-v1.0"
      || authorization.protocolVersion !== protocol.protocolVersion
      || authorization.sourceProtocolVersion !== protocol.protocolVersion
      || authorization.status !== "validation_passed"
      || authorization.decision !== "authorize_locked_test_read"
      || authorization.testStateAtAdmission !== "unread"
      || !/^[0-9a-f]{7,40}$/i.test(authorization.validatorCommit)
      || !/^[0-9a-f]{64}$/i.test(authorization.independentValidationSha256)
      || authorization.selectedPolicyId !== loadedSelection!.artifact.selectedPolicy.id) {
      throw new Error("D9 test candidate requires the matching validation-passed admission artifact");
    }
  }
  const policies = params.phase === "development"
    ? policyGrid()
    : [loadedSelection!.artifact.selectedPolicy];
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    tier: protocol.dataset.tier,
    expected: {
      questionsSha256: protocol.dataset.questionsSha256,
      haystackSha256: protocol.dataset.haystackSha256,
      trajectoriesSha256: protocol.dataset.trajectoriesSha256,
      questions: protocol.dataset.questions,
      trajectoryRows: protocol.dataset.trajectoryRows,
      haystackSize: 100,
      selectedTrajectories: protocol.dataset.selectedTrajectories,
    },
  });
  const questions = await adapter.loadQuestions();
  assertFrozenProcedureSplit(questions);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const selectedQuestions = procedureQuestionIdsForPhase(params.phase).map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing D9 frozen question ${id}`);
    return question;
  });
  const trajectoryIds = [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))];
  const trajectories = await adapter.loadTrajectories(trajectoryIds);
  const trajectoriesByDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = trajectoriesByDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    trajectoriesByDomain.set(trajectory.domain, values);
  }
  const rawBackends = new Map<string, MemoryCoreGroupBackend>();
  const procedureBackends = new Map<string, MemoryCoreGroupBackend>();
  const procedureRecords = new Map<string, ProcedureRecord>();
  const index: LongMemEvalV2ProcedureSummary["index"] = {};
  try {
    for (const [domain, domainTrajectories] of [...trajectoriesByDomain.entries()].sort()) {
      const rawStartedAt = performance.now();
      const raw = buildRawStateUnits({
        trajectories: domainTrajectories,
        config: {
          maxCharacters: protocol.baseline.rawChunkMaxCharacters,
          overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
          maxChunksPerState: protocol.baseline.maxRawChunksPerState,
        },
      });
      rawBackends.set(domain, new MemoryCoreGroupBackend(raw.units));
      const rawBuildLatencyMs = performance.now() - rawStartedAt;
      const procedureStartedAt = performance.now();
      const procedures = buildProcedureIndex({
        trajectories: domainTrajectories,
        config: {
          maxProcedureUnits: protocol.procedureMemory.maxProcedureUnits,
          maxActionsPerProcedure: protocol.procedureMemory.maxActionsPerProcedure,
          maxDeliveryCharacters: protocol.procedureMemory.maxDeliveryCharacters,
        },
      });
      procedureBackends.set(domain, new MemoryCoreGroupBackend(procedures.indexUnits));
      for (const record of procedures.records) {
        if (procedureRecords.has(record.id)) throw new Error(`duplicate D9 procedure ${record.id}`);
        procedureRecords.set(record.id, record);
      }
      index[domain] = {
        trajectories: domainTrajectories.length,
        states: domainTrajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0),
        rawUnits: raw.units.length,
        rawTruncatedStates: raw.truncatedStates,
        procedureUnits: procedures.records.length,
        successfulProcedures: procedures.successTrajectories,
        failedProcedures: procedures.failureTrajectories,
        actions: procedures.actions,
        maskedTargets: procedures.maskedTargets,
        truncatedProcedures: procedures.truncatedProcedures,
        rawBuildLatencyMs,
        procedureBuildLatencyMs: performance.now() - procedureStartedAt,
      };
    }
    const events = buildProcedureOutcomeEvents([...procedureRecords.values()].sort((left, right) => left.id.localeCompare(right.id)));
    const feedbackTable = buildProcedureFeedbackTable({
      events,
      capacity: protocol.feedbackSidecar.capacity,
      knownProcedureIds: new Set(procedureRecords.keys()),
    });
    if (!feedbackTable.available || feedbackTable.entries.size !== procedureRecords.size) {
      throw new Error(`D9 public feedback table unavailable: ${feedbackTable.failureReason}`);
    }
    const cases: LongMemEvalV2ProcedureCase[] = [];
    for (const question of selectedQuestions) {
      const rawBackend = rawBackends.get(question.domain);
      const procedureBackend = procedureBackends.get(question.domain);
      if (!rawBackend || !procedureBackend) throw new Error(`missing D9 backend for ${question.domain}`);
      const locked = lockedBaseline.byQuestionId.get(question.id);
      if (!locked) throw new Error(`missing D9 locked baseline case ${question.id}`);
      const query = sanitizeLongTaskQuery(question.prompt);
      const rawSearch = await rawBackend.search(query, protocol.baseline.candidateLimit);
      const baseline = packLongTaskContext({
        candidates: rawSearch.candidates,
        tokenBudget: protocol.baseline.injectionTokenBudget,
        resultLimit: protocol.baseline.resultLimit,
      });
      const baseSupport = scoreProcedureDirectSupport({ question, injected: baseline.items });
      assertBaselineRecomputed({ locked, query, candidates: rawSearch.candidates, packed: baseline, support: baseSupport });
      const procedureSearch = await procedureBackend.search(
        query,
        Math.max(...protocol.procedureMemory.candidateLimits),
      );
      for (const policy of policies) {
        const forced = forcedFallbackChecks({
          baseline,
          rawCandidates: rawSearch.candidates,
          procedureCandidates: procedureSearch.candidates,
          procedureRecords,
          feedbackTable,
          policy,
          tokenBudget: protocol.baseline.injectionTokenBudget,
          resultLimit: protocol.baseline.resultLimit,
        });
        for (const arm of ["outcome_agnostic", "outcome_gated"] as const) {
          const selectionStartedAt = performance.now();
          const selected = selectProcedureContext({
            baseline,
            rawCandidates: rawSearch.candidates,
            procedureCandidates: procedureSearch.candidates,
            procedureRecords,
            feedbackTable,
            policy,
            arm,
            tokenBudget: protocol.baseline.injectionTokenBudget,
            resultLimit: protocol.baseline.resultLimit,
          });
          const selectionLatencyMs = performance.now() - selectionStartedAt;
          const support = scoreProcedureDirectSupport({ question, injected: selected.items });
          cases.push({
            protocolVersion: protocol.protocolVersion,
            mode: "procedure_memory",
            phase: params.phase,
            policyId: policy.id,
            arm,
            questionId: question.id,
            domain: question.domain,
            environment: question.environment,
            evaluatorFamily: longMemEvalV2ProcedureEvaluatorFamily(question),
            directProxy: support !== null,
            orderedQuestion: support?.orderedQuestion ?? false,
            query,
            baseCandidateIds: rawSearch.candidates.map((item) => item.id),
            baseInjectedIds: baseline.items.map((item) => item.id),
            baseInjectedTokens: baseline.injectedTokens,
            baseAnswerAtomSupportRecall: baseSupport?.answerAtomSupportRecall ?? null,
            baseAllAnswerAtomsSupported: baseSupport?.allAnswerAtomsSupported ?? null,
            baseOrderedSequenceSupported: baseSupport?.orderedSequenceSupported ?? null,
            procedureCandidateIds: procedureSearch.candidates.map((item) => item.id),
            injectedIds: selected.items.map((item) => item.id),
            procedureIds: selected.procedureIds,
            rawIds: selected.rawIds,
            injectedTokens: selected.injectedTokens,
            tokenViolation: selected.tokenViolation,
            rawQueryLatencyMs: rawSearch.latencyMs,
            procedureQueryLatencyMs: procedureSearch.latencyMs,
            selectionLatencyMs,
            queryLatencyMs: rawSearch.latencyMs + procedureSearch.latencyMs + selectionLatencyMs,
            usedProcedure: selected.usedProcedure,
            selectionMode: selected.mode,
            decisionReason: selected.decisionReason,
            fallback: selected.fallback,
            fallbackReason: selected.fallbackReason,
            answerAtomCount: support?.answerAtoms.length ?? null,
            supportedAtomCount: support?.supportedAtomCount ?? null,
            answerAtomSupportRecall: support?.answerAtomSupportRecall ?? null,
            anyAnswerAtomSupported: support?.anyAnswerAtomSupported ?? null,
            allAnswerAtomsSupported: support?.allAnswerAtomsSupported ?? null,
            orderedSequenceSupported: support?.orderedSequenceSupported ?? null,
            answerAtomSupportRecallDelta: support && baseSupport
              ? support.answerAtomSupportRecall - baseSupport.answerAtomSupportRecall
              : null,
            forcedFallbackMismatches: arm === "outcome_gated" ? forced
              : Object.fromEntries(Object.keys(forced).map((key) => [key, 0])),
          });
        }
      }
    }
    cases.sort((left, right) => left.policyId.localeCompare(right.policyId)
      || left.arm.localeCompare(right.arm)
      || left.questionId.localeCompare(right.questionId));
    const casesText = cases.map(canonicalJsonLine).join("");
    const armSummaries = policies.flatMap((policy, policyIndex) =>
      (["outcome_agnostic", "outcome_gated"] as const).map((arm, armIndex) => summarizeArm({
        policy,
        arm,
        cases: cases.filter((item) => item.policyId === policy.id && item.arm === arm),
        baseline: lockedBaseline.summary,
        seed: protocol.aggregation.bootstrapSeed + policyIndex * 2 + armIndex,
      })));
    const feedbackComparisons = Object.fromEntries(policies.map((policy) => [policy.id, compareFeedbackArms(
      cases.filter((item) => item.policyId === policy.id && item.arm === "outcome_gated"),
      cases.filter((item) => item.policyId === policy.id && item.arm === "outcome_agnostic"),
    )]));
    const ranking = policyRanking(armSummaries, feedbackComparisons);
    const selectedSummary = params.phase === "development"
      ? ranking[0]
      : armSummaries.find((item) => item.arm === "outcome_gated")!;
    const selectedPolicy = selectedSummary.policy;
    const gate = params.phase === "development" ? null : evaluateGate({
      phase: params.phase,
      selected: selectedSummary,
      feedback: feedbackComparisons[selectedPolicy.id],
    });
    const status = params.phase === "development" ? "development_selected"
      : params.phase === "validation" ? (gate!.passed ? "validation_passed" : "validation_failed")
        : (gate!.passed ? "test_passed" : "test_failed");
    const selectionArtifact: LongMemEvalV2ProcedureSelectionArtifact | null = params.phase === "development" ? {
      selectionVersion: "lifecycle-longmemeval-v2-procedure-selection-v1.0",
      sourceProtocolVersion: protocol.protocolVersion,
      status: "selected",
      phase: "development",
      preScoreCommit: params.preScoreCommit,
      selectedPolicy,
      ranking: ranking.map((item) => item.policy.id),
      developmentCasesSha256: createHash("sha256").update(casesText).digest("hex"),
      baselineCasesSha256: lockedBaseline.casesSha256,
      baselineSummarySha256: lockedBaseline.summarySha256,
      policyGridSha256: createHash("sha256").update(JSON.stringify(policyGrid())).digest("hex"),
      objectiveValues: {
        answerAtomSupportRecall: selectedSummary.metrics.answerAtomSupportRecall,
        orderedSequenceSupportedRate: selectedSummary.metrics.orderedSequenceSupportedRate,
        allAnswerAtomsSupportedRate: selectedSummary.metrics.allAnswerAtomsSupportedRate,
        improvedDirectProxyCasesVsOutcomeAgnostic:
          feedbackComparisons[selectedPolicy.id].improvedDirectProxyCases,
        meanInjectedTokens: selectedSummary.metrics.meanInjectedTokens,
        selectionLatencyP95Ms: selectedSummary.metrics.selectionLatencyP95Ms,
      },
    } : null;
    return {
      cases,
      selectionArtifact,
      summary: {
        protocolVersion: protocol.protocolVersion,
        mode: "procedure_memory",
        phase: params.phase,
        status,
        preScoreCommit: params.preScoreCommit,
        selectionArtifactSha256: loadedSelection?.sha256 ?? null,
        baseline: { casesSha256: lockedBaseline.casesSha256, summarySha256: lockedBaseline.summarySha256 },
        index,
        feedback: {
          events: events.length,
          entries: feedbackTable.entries.size,
          capacity: feedbackTable.capacity,
          available: feedbackTable.available,
          failureReason: feedbackTable.failureReason,
        },
        armSummaries,
        feedbackComparisons,
        selectedPolicy,
        casesSha256: createHash("sha256").update(casesText).digest("hex"),
        gate,
      },
    };
  } finally {
    for (const backend of rawBackends.values()) backend.close();
    for (const backend of procedureBackends.values()) backend.close();
  }
}
