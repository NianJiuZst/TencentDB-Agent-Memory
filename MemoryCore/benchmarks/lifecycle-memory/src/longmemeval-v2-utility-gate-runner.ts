import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import {
  buildRawStateUnits,
  scoreDirectAnswerSupport,
  type PackedLongTaskContext,
} from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type { LongMemEvalV2TransitionCase } from "./longmemeval-v2-transition-runner.js";
import {
  LONGMEMEVAL_V2_TRANSITION_PROTOCOL,
  questionIdsForLongMemEvalV2Phase,
} from "./longmemeval-v2-transition-protocol.js";
import { buildTransitionUnits } from "./longmemeval-v2-transition.js";
import {
  learnTransitionUtility,
  selectUtilityGatedContext,
  type TransitionFeedback,
  type TransitionUtilityTable,
  type UtilityGateFallbackReason,
  type UtilityGateNullReason,
} from "./longmemeval-v2-utility-gate.js";
import { LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL } from "./longmemeval-v2-utility-gate-protocol.js";
import type { MemoryUnit, RetrievedUnit } from "./types.js";

type SourcePhase = "development" | "validation";
type AuditMode = "leave_one_question_out" | "deployment_full_feedback";

interface ForcedFallbackMismatches {
  disabled: number;
  missingTable: number;
  overflow: number;
  timeout: number;
  corrupt: number;
}

export interface LongMemEvalV2UtilityGateCase {
  protocolVersion: string;
  mode: "utility_gate";
  auditMode: AuditMode;
  sourcePhase: SourcePhase;
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
  selectionLatencyMs: number;
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

export interface UtilityGateAuditSummary {
  auditMode: AuditMode;
  cases: number;
  directProxyCases: number;
  metrics: {
    answerAtomSupportRecall: number;
    answerAtomSupportRecallDelta: number;
    anyAnswerAtomSupportedRate: number;
    anyAnswerAtomSupportedRateDelta: number;
    allAnswerAtomsSupportedRate: number;
    allAnswerAtomsSupportedRateDelta: number;
    meanInjectedTokens: number;
    meanBaseInjectedTokens: number;
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
  };
  nullReasons: Record<string, number>;
  forcedFallbackMismatches: ForcedFallbackMismatches;
  byDomain: Record<string, {
    cases: number;
    directProxyCases: number;
    answerAtomSupportRecallDelta: number;
    meanInjectedTokenFraction: number;
    acceptedChangedContexts: number;
    improved: number;
    harmed: number;
  }>;
}

export interface LongMemEvalV2UtilityArtifact {
  utilityVersion: "lifecycle-longmemeval-v2-transition-utility-v1.0";
  sourceProtocolVersion: string;
  preScoreCommit: string;
  behaviorPolicy: string;
  sourceSha256: {
    developmentCases: string;
    validationCases: string;
  };
  feedback: {
    eligibleQuestions: number;
    events: number;
    rewardPositive: number;
    rewardZero: number;
    rewardNegative: number;
  };
  table: TransitionUtilityTable;
  eligibleMemoryIds: string[];
  tableSha256: string;
}

export interface LongMemEvalV2UtilityGateSummary {
  protocolVersion: string;
  mode: "utility_gate";
  status: "mechanism_passed_pending_independent_validation" | "mechanism_failed";
  preScoreCommit: string;
  sourceSha256: {
    developmentCases: string;
    validationCases: string;
  };
  utilityArtifactSha256: string;
  casesSha256: string;
  sourceQuestions: number;
  directFeedbackQuestions: number;
  audit: Record<AuditMode, UtilityGateAuditSummary>;
  mechanismGate: {
    passed: boolean;
    checks: Record<string, boolean>;
  };
  testState: "unread";
  limitations: string[];
}

const protocol = LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL;
const transitionProtocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;
const encoding = getEncoding("cl100k_base");

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

function retrieved(unit: MemoryUnit, cache: Map<string, RetrievedUnit>): RetrievedUnit {
  const cached = cache.get(unit.id);
  if (cached) return cached;
  const value: RetrievedUnit = {
    ...unit,
    score: 0,
    tokenCount: encoding.encode(unit.content).length,
  };
  cache.set(unit.id, value);
  return value;
}

function resolveIds(
  ids: string[],
  units: Map<string, MemoryUnit>,
  cache: Map<string, RetrievedUnit>,
): RetrievedUnit[] {
  return ids.map((id) => {
    const unit = units.get(id);
    if (!unit) throw new Error(`D8 cannot materialize ${id}`);
    return retrieved(unit, cache);
  });
}

function exactSelection(
  baseline: PackedLongTaskContext,
  selected: ReturnType<typeof selectUtilityGatedContext>,
): boolean {
  return sameIds(selected.items.map((item) => item.id), baseline.items.map((item) => item.id))
    && selected.injectedTokens === baseline.injectedTokens;
}

function forcedFallbackProof(params: {
  baseline: PackedLongTaskContext;
  rawCandidates: RetrievedUnit[];
  transitionCandidates: RetrievedUnit[];
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
  const selections = {
    disabled: selectUtilityGatedContext({ ...common, enabled: false }),
    missingTable: selectUtilityGatedContext({ ...common, utilityTable: null }),
    overflow: selectUtilityGatedContext({ ...common, utilityTable: overflowTable }),
    timeout: selectUtilityGatedContext({ ...common, timedOut: true }),
    corrupt: selectUtilityGatedContext({ ...common, forceCorrupt: true }),
  };
  return {
    disabled: exactSelection(params.baseline, selections.disabled) ? 0 : 1,
    missingTable: exactSelection(params.baseline, selections.missingTable) ? 0 : 1,
    overflow: exactSelection(params.baseline, selections.overflow) ? 0 : 1,
    timeout: exactSelection(params.baseline, selections.timeout) ? 0 : 1,
    corrupt: exactSelection(params.baseline, selections.corrupt) ? 0 : 1,
  };
}

async function loadBehaviorRows(params: {
  developmentCasesPath: string;
  validationCasesPath: string;
}): Promise<{
  rows: LongMemEvalV2TransitionCase[];
  developmentCasesSha256: string;
  validationCasesSha256: string;
}> {
  const [developmentText, validationText] = await Promise.all([
    readFile(params.developmentCasesPath, "utf8"),
    readFile(params.validationCasesPath, "utf8"),
  ]);
  const developmentCasesSha256 = sha256(developmentText);
  const validationCasesSha256 = sha256(validationText);
  if (developmentCasesSha256 !== protocol.feedback.developmentCasesSha256
    || validationCasesSha256 !== protocol.feedback.validationCasesSha256) {
    throw new Error("D8 consumed-feedback source hash mismatch");
  }
  const parse = (text: string) => text.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2TransitionCase)
    .filter((row) => row.policyId === protocol.feedback.behaviorPolicy);
  const development = parse(developmentText);
  const validation = parse(validationText);
  const expectedDevelopment = [...questionIdsForLongMemEvalV2Phase("development")].sort();
  const expectedValidation = [...questionIdsForLongMemEvalV2Phase("validation")].sort();
  if (!sameIds(development.map((row) => row.questionId).sort(), expectedDevelopment)
    || !sameIds(validation.map((row) => row.questionId).sort(), expectedValidation)
    || development.some((row) => row.phase !== "development")
    || validation.some((row) => row.phase !== "validation")) {
    throw new Error("D8 behavior-policy row identity mismatch");
  }
  return {
    rows: [...development, ...validation],
    developmentCasesSha256,
    validationCasesSha256,
  };
}

function feedbackFrom(rows: LongMemEvalV2TransitionCase[]): TransitionFeedback[] {
  return rows.filter((row) => row.directProxy && row.answerAtomSupportRecallDelta !== null)
    .map((row) => ({
      questionId: row.questionId,
      transitionIds: [...row.transitionIds],
      reward: row.answerAtomSupportRecallDelta!,
    }));
}

function utilityArtifact(params: {
  feedback: TransitionFeedback[];
  table: TransitionUtilityTable;
  preScoreCommit: string;
  developmentCasesSha256: string;
  validationCasesSha256: string;
}): LongMemEvalV2UtilityArtifact {
  const tableSha256 = sha256(JSON.stringify(params.table));
  return {
    utilityVersion: "lifecycle-longmemeval-v2-transition-utility-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    preScoreCommit: params.preScoreCommit,
    behaviorPolicy: protocol.feedback.behaviorPolicy,
    sourceSha256: {
      developmentCases: params.developmentCasesSha256,
      validationCases: params.validationCasesSha256,
    },
    feedback: {
      eligibleQuestions: params.feedback.length,
      events: params.table.feedbackEvents,
      rewardPositive: params.feedback.filter((row) => row.reward > 0).length,
      rewardZero: params.feedback.filter((row) => row.reward === 0).length,
      rewardNegative: params.feedback.filter((row) => row.reward < 0).length,
    },
    table: params.table,
    eligibleMemoryIds: params.table.entries.filter((entry) => entry.eligible)
      .map((entry) => entry.memoryId),
    tableSha256,
  };
}

function aggregateForced(rows: LongMemEvalV2UtilityGateCase[]): ForcedFallbackMismatches {
  return {
    disabled: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.disabled, 0),
    missingTable: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.missingTable, 0),
    overflow: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.overflow, 0),
    timeout: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.timeout, 0),
    corrupt: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.corrupt, 0),
  };
}

function summarize(
  auditMode: AuditMode,
  rows: LongMemEvalV2UtilityGateCase[],
): UtilityGateAuditSummary {
  const direct = rows.filter((row) => row.directProxy);
  const directDeltas = direct.map((row) => row.answerAtomSupportRecallDelta!);
  const candidateTokens = mean(rows.map((row) => row.injectedTokens));
  const baseTokens = mean(rows.map((row) => row.baseInjectedTokens));
  const summaryFor = (domainRows: LongMemEvalV2UtilityGateCase[]) => {
    const domainDirect = domainRows.filter((row) => row.directProxy);
    return {
      cases: domainRows.length,
      directProxyCases: domainDirect.length,
      answerAtomSupportRecallDelta: mean(domainDirect.map((row) => row.answerAtomSupportRecallDelta!)),
      meanInjectedTokenFraction: mean(domainRows.map((row) => row.injectedTokens))
        / mean(domainRows.map((row) => row.baseInjectedTokens)) - 1,
      acceptedChangedContexts: domainRows.filter((row) => row.usedAuxiliary).length,
      improved: domainDirect.filter((row) => row.answerAtomSupportRecallDelta! > 1e-12).length,
      harmed: domainDirect.filter((row) => row.answerAtomSupportRecallDelta! < -1e-12).length,
    };
  };
  const nullReasons: Record<string, number> = {};
  for (const row of rows) {
    if (row.nullReason) nullReasons[row.nullReason] = (nullReasons[row.nullReason] ?? 0) + 1;
  }
  return {
    auditMode,
    cases: rows.length,
    directProxyCases: direct.length,
    metrics: {
      answerAtomSupportRecall: mean(direct.map((row) => row.answerAtomSupportRecall!)),
      answerAtomSupportRecallDelta: mean(directDeltas),
      anyAnswerAtomSupportedRate: mean(direct.map((row) => row.anyAnswerAtomSupported!)),
      anyAnswerAtomSupportedRateDelta: mean(direct.map((row) =>
        row.anyAnswerAtomSupported! - row.baseAnyAnswerAtomSupported!
      )),
      allAnswerAtomsSupportedRate: mean(direct.map((row) => row.allAnswerAtomsSupported!)),
      allAnswerAtomsSupportedRateDelta: mean(direct.map((row) =>
        row.allAnswerAtomsSupported! - row.baseAllAnswerAtomsSupported!
      )),
      meanInjectedTokens: candidateTokens,
      meanBaseInjectedTokens: baseTokens,
      meanInjectedTokenFraction: candidateTokens / baseTokens - 1,
      acceptedChangedContexts: rows.filter((row) => row.usedAuxiliary).length,
      auxiliaryUseRate: mean(rows.map((row) => row.usedAuxiliary ? 1 : 0)),
      improved: directDeltas.filter((value) => value > 1e-12).length,
      equal: directDeltas.filter((value) => Math.abs(value) <= 1e-12).length,
      harmed: directDeltas.filter((value) => value < -1e-12).length,
      tokenViolations: rows.filter((row) => row.tokenViolation).length,
      ordinaryFallbacks: rows.filter((row) => row.fallback).length,
      selectionLatencyP50Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.5),
      selectionLatencyP95Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.95),
    },
    nullReasons,
    forcedFallbackMismatches: aggregateForced(rows),
    byDomain: Object.fromEntries([...new Set(rows.map((row) => row.domain))].sort()
      .map((domain) => [domain, summaryFor(rows.filter((row) => row.domain === domain))])),
  };
}

function mechanismGate(params: {
  summary: UtilityGateAuditSummary;
  utilityTable: TransitionUtilityTable;
}): { passed: boolean; checks: Record<string, boolean> } {
  const gate = protocol.consumedDataAudit.admission;
  const forced = params.summary.forcedFallbackMismatches;
  const checks = {
    acceptedChangedContexts:
      params.summary.metrics.acceptedChangedContexts >= gate.minAcceptedChangedContexts,
    answerAtomSupportRecallDelta:
      params.summary.metrics.answerAtomSupportRecallDelta >= gate.minAnswerAtomSupportRecallDelta,
    allAnswerAtomsSupportedRateDelta:
      params.summary.metrics.allAnswerAtomsSupportedRateDelta >= gate.minAllAnswerAtomsSupportedRateDelta,
    harmedDirectProxyCases: params.summary.metrics.harmed <= gate.maxHarmedDirectProxyCases,
    meanInjectedTokens:
      params.summary.metrics.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
    tokenViolations: params.summary.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    ordinaryFallbacks: params.summary.metrics.ordinaryFallbacks <= gate.maxOrdinaryFallbacks,
    selectionLatency:
      params.summary.metrics.selectionLatencyP95Ms <= gate.maxP95SelectionLatencyMs,
    disabledFallback: forced.disabled === 0,
    missingTableFallback: forced.missingTable === 0,
    overflowFallback: forced.overflow === 0,
    timeoutFallback: forced.timeout === 0,
    corruptFallback: forced.corrupt === 0,
    utilityCapacity: params.utilityTable.entries.length <= params.utilityTable.capacity,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function runLongMemEvalV2UtilityGateConsumedAudit(params: {
  dataRoot: string;
  developmentCasesPath: string;
  validationCasesPath: string;
  preScoreCommit: string;
}): Promise<{
  cases: LongMemEvalV2UtilityGateCase[];
  summary: LongMemEvalV2UtilityGateSummary;
  utility: LongMemEvalV2UtilityArtifact;
}> {
  const source = await loadBehaviorRows(params);
  const feedback = feedbackFrom(source.rows);
  const fullTable = learnTransitionUtility({
    feedback,
    capacity: protocol.feedback.capacity,
  });
  const utility = utilityArtifact({
    feedback,
    table: fullTable,
    preScoreCommit: params.preScoreCommit,
    developmentCasesSha256: source.developmentCasesSha256,
    validationCasesSha256: source.validationCasesSha256,
  });
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
  const selectedQuestions = source.rows.map((row) => questionById.get(row.questionId)!);
  const trajectories = await adapter.loadTrajectories(
    [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))],
  );
  const trajectoriesByDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = trajectoriesByDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    trajectoriesByDomain.set(trajectory.domain, values);
  }
  const rawUnits = new Map<string, MemoryUnit>();
  const transitionUnits = new Map<string, MemoryUnit>();
  for (const domainTrajectories of trajectoriesByDomain.values()) {
    for (const unit of buildRawStateUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: transitionProtocol.baseline.rawChunkMaxCharacters,
        overlapCharacters: transitionProtocol.baseline.rawChunkOverlapCharacters,
        maxChunksPerState: transitionProtocol.baseline.maxRawChunksPerState,
      },
    }).units) rawUnits.set(unit.id, unit);
    for (const unit of buildTransitionUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: transitionProtocol.challenger.diffChunkMaxCharacters,
        maxChunksPerTransition: transitionProtocol.challenger.maxDiffChunksPerTransition,
        maxAuxiliaryUnits: transitionProtocol.challenger.maxAuxiliaryUnits,
      },
    }).units) transitionUnits.set(unit.id, unit);
  }
  const cache = new Map<string, RetrievedUnit>();
  const cases: LongMemEvalV2UtilityGateCase[] = [];
  for (const sourceRow of source.rows) {
    const question = questionById.get(sourceRow.questionId);
    if (!question) throw new Error(`D8 missing question ${sourceRow.questionId}`);
    const rawCandidates = resolveIds(sourceRow.baseCandidateIds, rawUnits, cache);
    const baselineItems = resolveIds(sourceRow.baseInjectedIds, rawUnits, cache);
    const baseline: PackedLongTaskContext = {
      items: baselineItems,
      injectedTokens: baselineItems.reduce((sum, item) => sum + item.tokenCount, 0),
      tokenViolation: false,
    };
    if (baseline.injectedTokens !== sourceRow.baseInjectedTokens) {
      throw new Error(`D8 baseline token mismatch ${sourceRow.questionId}`);
    }
    const transitionCandidates = resolveIds(
      sourceRow.transitionCandidateIds,
      transitionUnits,
      cache,
    );
    const baseSupport = scoreDirectAnswerSupport(question, baseline.items);
    if ((baseSupport?.answerAtomSupportRecall ?? null) !== sourceRow.baseAnswerAtomSupportRecall) {
      throw new Error(`D8 baseline support mismatch ${sourceRow.questionId}`);
    }
    for (const auditMode of [
      "leave_one_question_out",
      "deployment_full_feedback",
    ] as const) {
      const table = auditMode === "deployment_full_feedback"
        ? fullTable
        : learnTransitionUtility({
          feedback: feedback.filter((row) => row.questionId !== sourceRow.questionId),
          capacity: protocol.feedback.capacity,
        });
      const started = performance.now();
      let selection = selectUtilityGatedContext({
        baseline,
        rawCandidates,
        transitionCandidates,
        utilityTable: table,
        tokenBudget: transitionProtocol.baseline.injectionTokenBudget,
        resultLimit: transitionProtocol.baseline.resultLimit,
        candidateLimit: protocol.runtimePolicy.transitionCandidateLimit,
        maxUtilityItems: protocol.runtimePolicy.maxUtilityItems,
      });
      const selectionLatencyMs = performance.now() - started;
      if (selectionLatencyMs > protocol.runtimePolicy.selectionTimeoutMs) {
        selection = selectUtilityGatedContext({
          baseline,
          rawCandidates,
          transitionCandidates,
          utilityTable: table,
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
        auditMode,
        sourcePhase: sourceRow.phase as SourcePhase,
        questionId: sourceRow.questionId,
        domain: sourceRow.domain,
        environment: sourceRow.environment,
        directProxy: support !== null,
        query: sourceRow.query,
        utilityEntries: table.entries.length,
        eligibleUtilityEntries: table.entries.filter((entry) => entry.eligible).length,
        baseCandidateIds: [...sourceRow.baseCandidateIds],
        baseInjectedIds: [...sourceRow.baseInjectedIds],
        baseInjectedTokens: sourceRow.baseInjectedTokens,
        transitionCandidateIds: [...sourceRow.transitionCandidateIds],
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
        selectionLatencyMs,
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
          rawCandidates,
          transitionCandidates,
          utilityTable: table,
        }),
      });
    }
  }
  cases.sort((left, right) =>
    left.auditMode.localeCompare(right.auditMode)
      || left.sourcePhase.localeCompare(right.sourcePhase)
      || left.questionId.localeCompare(right.questionId)
  );
  const casesText = cases.map((row) => `${JSON.stringify(row)}\n`).join("");
  const audit = {
    leave_one_question_out: summarize(
      "leave_one_question_out",
      cases.filter((row) => row.auditMode === "leave_one_question_out"),
    ),
    deployment_full_feedback: summarize(
      "deployment_full_feedback",
      cases.filter((row) => row.auditMode === "deployment_full_feedback"),
    ),
  };
  const gate = mechanismGate({ summary: audit.leave_one_question_out, utilityTable: fullTable });
  const utilityText = `${JSON.stringify(utility, null, 2)}\n`;
  return {
    cases,
    utility,
    summary: {
      protocolVersion: protocol.protocolVersion,
      mode: "utility_gate",
      status: gate.passed
        ? "mechanism_passed_pending_independent_validation"
        : "mechanism_failed",
      preScoreCommit: params.preScoreCommit,
      sourceSha256: {
        developmentCases: source.developmentCasesSha256,
        validationCases: source.validationCasesSha256,
      },
      utilityArtifactSha256: sha256(utilityText),
      casesSha256: sha256(casesText),
      sourceQuestions: source.rows.length,
      directFeedbackQuestions: feedback.length,
      audit,
      mechanismGate: gate,
      testState: "unread",
      limitations: [
        "All 62 consumed questions influenced D8 design or utility learning; their audit metrics are mechanism evidence, not confirmation.",
        "Leave-one-question-out prevents direct self-credit but questions share two domain haystacks, so it is not an independent environment split.",
        "Answer-atom occurrence is a direct support proxy, not gold retrieval recall or answer accuracy.",
        "The exact-memory utility table tests within-environment reuse; internal transfer requires stable memory ids and a high-confidence FeedbackEvent adapter.",
      ],
    },
  };
}
