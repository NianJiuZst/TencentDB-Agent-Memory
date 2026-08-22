import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import candidateLockJson from "../protocol.longmemeval-v2-utility-test-candidate-lock.v1.json" with { type: "json" };
import type { LongTaskTrajectory } from "./long-task-adapter.js";
import { buildRawStateUnits } from "./longmemeval-v2-baseline.js";
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
import type {
  LongMemEvalV2UtilityArtifact,
} from "./longmemeval-v2-utility-gate-runner.js";
import {
  independentlyScoreLongMemEvalV2Support,
  independentlySelectLongMemEvalV2UtilityContext,
  type IndependentUtilityUnit,
} from "./longmemeval-v2-utility-gate-validator.js";
import { LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL } from "./longmemeval-v2-utility-gate-protocol.js";
import type {
  LongMemEvalV2UtilityTestCase,
  LongMemEvalV2UtilityTestSummary,
} from "./longmemeval-v2-utility-test-runner.js";
import type { MemoryUnit } from "./types.js";

export interface LongMemEvalV2UtilityTestValidation {
  validationVersion: "lifecycle-longmemeval-v2-utility-test-validation-v1.0";
  sourceProtocolVersion: string;
  status: "passed" | "failed";
  evaluationStatus: "test_passed" | "test_failed";
  rows: number;
  directProxyRows: number;
  mismatches: Record<string, number>;
  sourceSha256: {
    cases: string;
    summary: string;
    baselineCases: string;
    baselineSummary: string;
    utility: string;
  };
  answerLevelState: "admitted" | "not_admitted";
  limitations: string[];
}

const protocol = LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL;
const transitionProtocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;
const encoding = getEncoding("cl100k_base");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function increment(mismatches: Record<string, number>, key: string): void {
  mismatches[key] = (mismatches[key] ?? 0) + 1;
}

function close(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-12;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * probability) - 1))];
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

function bootstrap(rows: LongMemEvalV2UtilityTestCase[]) {
  const direct = rows.filter((row) => row.directProxy);
  const strata = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(candidateLockJson.aggregation.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < candidateLockJson.aggregation.samples; sample += 1) {
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
    samples: candidateLockJson.aggregation.samples,
    seed: candidateLockJson.aggregation.seed,
  };
}

function compareNumberRecord(
  mismatches: Record<string, number>,
  key: string,
  actual: Record<string, number>,
  expected: Record<string, number>,
): void {
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])];
  if (keys.some((field) => !close(actual[field] ?? null, expected[field] ?? null))) {
    increment(mismatches, key);
  }
}

export async function validateLongMemEvalV2UtilityTest(params: {
  dataRoot: string;
  casesPath: string;
  summaryPath: string;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  utilityPath: string;
}): Promise<LongMemEvalV2UtilityTestValidation> {
  const [casesText, summaryText, baselineCasesText, baselineSummaryText, utilityText] =
    await Promise.all([
      readFile(params.casesPath, "utf8"),
      readFile(params.summaryPath, "utf8"),
      readFile(params.baselineCasesPath, "utf8"),
      readFile(params.baselineSummaryPath, "utf8"),
      readFile(params.utilityPath, "utf8"),
    ]);
  const cases = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2UtilityTestCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2UtilityTestSummary;
  const baselineCases = baselineCasesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2BaselineCase);
  const baselineSummary = JSON.parse(baselineSummaryText) as LongMemEvalV2BaselineSummary;
  const utility = JSON.parse(utilityText) as LongMemEvalV2UtilityArtifact;
  const baselineById = new Map(baselineCases.map((row) => [row.questionId, row]));
  const mismatches: Record<string, number> = {};
  const casesDigest = sha256(casesText);
  const summaryDigest = sha256(summaryText);
  const baselineCasesDigest = sha256(baselineCasesText);
  const baselineSummaryDigest = sha256(baselineSummaryText);
  const utilityDigest = sha256(utilityText);
  if (baselineCasesDigest !== candidateLockJson.baselineSha256.cases
    || baselineSummaryDigest !== candidateLockJson.baselineSha256.summary
    || utilityDigest !== candidateLockJson.utilityArtifactSha256
    || baselineSummary.casesSha256 !== baselineCasesDigest
    || utility.tableSha256 !== sha256(JSON.stringify(utility.table))) {
    increment(mismatches, "locked_source_hash_or_identity");
  }

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
  const expectedQuestionIds = questionIdsForLongMemEvalV2Phase("test");
  const selectedQuestions = expectedQuestionIds.map((id) => questionById.get(id)!);
  const trajectories = await adapter.loadTrajectories(
    [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))],
  );
  const byDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = byDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    byDomain.set(trajectory.domain, values);
  }
  const rawUnits = new Map<string, IndependentUtilityUnit>();
  const transitionUnits = new Map<string, IndependentUtilityUnit>();
  const index: Record<string, {
    trajectories: number;
    states: number;
    rawUnits: number;
    transitionUnits: number;
  }> = {};
  const addUnits = (target: Map<string, IndependentUtilityUnit>, units: MemoryUnit[]) => {
    for (const unit of units) target.set(unit.id, { ...unit, tokenCount: encoding.encode(unit.content).length });
  };
  for (const [domain, domainTrajectories] of [...byDomain.entries()].sort()) {
    const raw = buildRawStateUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: transitionProtocol.baseline.rawChunkMaxCharacters,
        overlapCharacters: transitionProtocol.baseline.rawChunkOverlapCharacters,
        maxChunksPerState: transitionProtocol.baseline.maxRawChunksPerState,
      },
    });
    const transition = buildTransitionUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: transitionProtocol.challenger.diffChunkMaxCharacters,
        maxChunksPerTransition: transitionProtocol.challenger.maxDiffChunksPerTransition,
        maxAuxiliaryUnits: transitionProtocol.challenger.maxAuxiliaryUnits,
      },
    });
    addUnits(rawUnits, raw.units);
    addUnits(transitionUnits, transition.units);
    index[domain] = {
      trajectories: domainTrajectories.length,
      states: domainTrajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0),
      rawUnits: raw.units.length,
      transitionUnits: transition.units.length,
    };
  }

  if (cases.length !== expectedQuestionIds.length
    || !sameIds(cases.map((row) => row.questionId).sort(), [...expectedQuestionIds].sort())
    || new Set(cases.map((row) => row.questionId)).size !== cases.length) {
    increment(mismatches, "case_question_ids");
  }
  for (const row of cases) {
    const question = questionById.get(row.questionId);
    const baseline = baselineById.get(row.questionId);
    if (!question || !baseline) {
      increment(mismatches, "unknown_case");
      continue;
    }
    if (row.protocolVersion !== protocol.protocolVersion
      || row.mode !== "utility_gate"
      || row.phase !== "test"
      || row.domain !== question.domain
      || row.environment !== question.environment
      || !sameIds(row.baseCandidateIds, baseline.candidateIds)
      || !sameIds(row.baseInjectedIds, baseline.injectedIds)
      || row.baseInjectedTokens !== baseline.injectedTokens
      || !close(row.totalQueryLatencyMs,
        row.rawQueryLatencyMs + row.transitionQueryLatencyMs + row.selectionLatencyMs)) {
      increment(mismatches, "case_identity_baseline_or_latency");
    }
    if (row.transitionCandidateIds.some((id) => !transitionUnits.has(id))) {
      increment(mismatches, "unknown_transition_candidate");
      continue;
    }
    const selected = independentlySelectLongMemEvalV2UtilityContext({
      row,
      table: utility.table,
      rawUnits,
      transitionUnits,
    });
    if (!sameIds(row.injectedIds, selected.injectedIds)
      || !sameIds(row.transitionIds, selected.transitionIds)
      || !sameIds(row.rawIds, selected.rawIds)
      || row.injectedTokens !== selected.injectedTokens
      || row.usedAuxiliary !== selected.usedAuxiliary
      || row.selectionMode !== selected.selectionMode
      || !sameIds(row.consideredUtilityIds, selected.consideredUtilityIds)
      || !close(row.selectedUtility, selected.selectedUtility)
      || row.nullReason !== selected.nullReason
      || row.fallback
      || row.fallbackReason !== null
      || row.tokenViolation
      || row.injectedTokens > row.baseInjectedTokens) {
      increment(mismatches, "independent_selection_or_cost");
    }
    if (row.utilityEntries !== utility.table.entries.length
      || row.eligibleUtilityEntries !== utility.table.entries.filter((entry) => entry.eligible).length
      || Object.values(row.forcedFallbackMismatches).some((value) => value !== 0)) {
      increment(mismatches, "utility_or_fallback_projection");
    }
    const selectedUnits = row.injectedIds.map((id) => transitionUnits.get(id) ?? rawUnits.get(id));
    const baseUnits = row.baseInjectedIds.map((id) => rawUnits.get(id));
    if (selectedUnits.some((unit) => !unit) || baseUnits.some((unit) => !unit)) {
      increment(mismatches, "unknown_injected_unit");
      continue;
    }
    const support = independentlyScoreLongMemEvalV2Support(
      question,
      selectedUnits.map((unit) => unit!.content),
    );
    const baseSupport = independentlyScoreLongMemEvalV2Support(
      question,
      baseUnits.map((unit) => unit!.content),
    );
    if ((support !== null) !== row.directProxy) increment(mismatches, "direct_proxy_flag");
    if (!support || !baseSupport) {
      if ([row.answerAtomCount, row.supportedAtomCount, row.answerAtomSupportRecall,
        row.anyAnswerAtomSupported, row.allAnswerAtomsSupported,
        row.answerAtomSupportRecallDelta].some((value) => value !== null)) {
        increment(mismatches, "multiple_choice_metrics");
      }
    } else if (support.atomCount !== row.answerAtomCount
      || support.supportedCount !== row.supportedAtomCount
      || !close(support.recall, row.answerAtomSupportRecall)
      || support.any !== row.anyAnswerAtomSupported
      || support.all !== row.allAnswerAtomsSupported
      || !close(baseSupport.recall, row.baseAnswerAtomSupportRecall)
      || baseSupport.any !== row.baseAnyAnswerAtomSupported
      || baseSupport.all !== row.baseAllAnswerAtomsSupported
      || !close(support.recall - baseSupport.recall, row.answerAtomSupportRecallDelta)) {
      increment(mismatches, "direct_support_metrics");
    }
  }

  const direct = cases.filter((row) => row.directProxy);
  const deltas = direct.map((row) => row.answerAtomSupportRecallDelta!);
  const candidateTokens = mean(cases.map((row) => row.injectedTokens));
  const baseTokens = mean(cases.map((row) => row.baseInjectedTokens));
  const expectedMetrics = {
    baseAnswerAtomSupportRecall: mean(direct.map((row) => row.baseAnswerAtomSupportRecall!)),
    answerAtomSupportRecall: mean(direct.map((row) => row.answerAtomSupportRecall!)),
    answerAtomSupportRecallDelta: mean(deltas),
    anyAnswerAtomSupportedRateDelta: mean(direct.map((row) =>
      row.anyAnswerAtomSupported! - row.baseAnyAnswerAtomSupported!
    )),
    allAnswerAtomsSupportedRateDelta: mean(direct.map((row) =>
      row.allAnswerAtomsSupported! - row.baseAllAnswerAtomsSupported!
    )),
    meanBaseInjectedTokens: baseTokens,
    meanInjectedTokens: candidateTokens,
    meanInjectedTokenFraction: candidateTokens / baseTokens - 1,
    acceptedChangedContexts: cases.filter((row) => row.usedAuxiliary).length,
    auxiliaryUseRate: mean(cases.map((row) => row.usedAuxiliary ? 1 : 0)),
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
    tokenViolations: cases.filter((row) => row.tokenViolation).length,
    ordinaryFallbacks: cases.filter((row) => row.fallback).length,
    selectionLatencyP50Ms: percentile(cases.map((row) => row.selectionLatencyMs), 0.5),
    selectionLatencyP95Ms: percentile(cases.map((row) => row.selectionLatencyMs), 0.95),
    totalQueryLatencyP50Ms: percentile(cases.map((row) => row.totalQueryLatencyMs), 0.5),
    totalQueryLatencyP95Ms: percentile(cases.map((row) => row.totalQueryLatencyMs), 0.95),
  };
  compareNumberRecord(mismatches, "summary_metrics", summary.metrics, expectedMetrics);
  const expectedBootstrap = bootstrap(cases);
  compareNumberRecord(
    mismatches,
    "summary_bootstrap",
    summary.answerAtomSupportRecallDeltaBootstrap,
    expectedBootstrap,
  );
  const nullReasons: Record<string, number> = {};
  for (const row of cases) {
    if (row.nullReason) nullReasons[row.nullReason] = (nullReasons[row.nullReason] ?? 0) + 1;
  }
  compareNumberRecord(mismatches, "summary_null_reasons", summary.nullReasons, nullReasons);
  const forced = {
    disabled: cases.reduce((sum, row) => sum + row.forcedFallbackMismatches.disabled, 0),
    missingTable: cases.reduce((sum, row) => sum + row.forcedFallbackMismatches.missingTable, 0),
    overflow: cases.reduce((sum, row) => sum + row.forcedFallbackMismatches.overflow, 0),
    timeout: cases.reduce((sum, row) => sum + row.forcedFallbackMismatches.timeout, 0),
    corrupt: cases.reduce((sum, row) => sum + row.forcedFallbackMismatches.corrupt, 0),
  };
  compareNumberRecord(
    mismatches,
    "summary_forced_fallbacks",
    { ...summary.forcedFallbackMismatches },
    forced,
  );
  for (const domain of Object.keys(index)) {
    const actualIndex = summary.index[domain];
    if (!actualIndex
      || actualIndex.trajectories !== index[domain].trajectories
      || actualIndex.states !== index[domain].states
      || actualIndex.rawUnits !== index[domain].rawUnits
      || actualIndex.transitionUnits !== index[domain].transitionUnits) {
      increment(mismatches, "summary_index_structure");
    }
    const domainRows = cases.filter((row) => row.domain === domain);
    const domainDirect = domainRows.filter((row) => row.directProxy);
    const baseRecall = mean(domainDirect.map((row) => row.baseAnswerAtomSupportRecall!));
    const recall = mean(domainDirect.map((row) => row.answerAtomSupportRecall!));
    const expectedDomain = {
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
    };
    if (!summary.byDomain[domain]) increment(mismatches, "summary_domain_identity");
    else compareNumberRecord(
      mismatches,
      "summary_domain_metrics",
      summary.byDomain[domain],
      expectedDomain,
    );
  }
  const gate = protocol.testGate;
  const expectedChecks = {
    answerAtomSupportRecallDelta:
      expectedMetrics.answerAtomSupportRecallDelta >= gate.minAnswerAtomSupportRecallDelta,
    answerAtomSupportRecallBootstrapLower:
      expectedBootstrap.lower >= gate.minAnswerAtomSupportRecallBootstrapLower,
    allAnswerAtomsSupportedRateDelta:
      expectedMetrics.allAnswerAtomsSupportedRateDelta >= gate.minAllAnswerAtomsSupportedRateDelta,
    improvedDirectProxyCases: expectedMetrics.improved >= gate.minImprovedDirectProxyCases,
    harmedDirectProxyCases: expectedMetrics.harmed <= gate.maxHarmedDirectProxyCases,
    meanInjectedTokens: expectedMetrics.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
    tokenViolations: expectedMetrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    ordinaryFallbacks: expectedMetrics.ordinaryFallbacks <= gate.maxOrdinaryFallbacks,
    selectionLatency: expectedMetrics.selectionLatencyP95Ms <= gate.maxP95SelectionLatencyMs,
    disabledFallback: forced.disabled === 0,
    missingTableFallback: forced.missingTable === 0,
    overflowFallback: forced.overflow === 0,
    timeoutFallback: forced.timeout === 0,
    corruptFallback: forced.corrupt === 0,
  };
  const expectedPassed = Object.values(expectedChecks).every(Boolean);
  if (summary.protocolVersion !== protocol.protocolVersion
    || summary.mode !== "utility_gate"
    || summary.phase !== "test"
    || summary.status !== (expectedPassed ? "test_passed" : "test_failed")
    || summary.candidatePreScoreCommit !== candidateLockJson.candidatePreScoreCommit
    || summary.sourceSha256.baselineCases !== baselineCasesDigest
    || summary.sourceSha256.baselineSummary !== baselineSummaryDigest
    || summary.sourceSha256.utilityArtifact !== utilityDigest
    || summary.cases !== cases.length
    || summary.directProxyCases !== direct.length
    || summary.casesSha256 !== casesDigest
    || JSON.stringify(summary.gate) !== JSON.stringify({ passed: expectedPassed, checks: expectedChecks })
    || summary.answerLevelState !== (expectedPassed ? "admitted" : "not_admitted")
    || summary.utility.entries !== utility.table.entries.length
    || summary.utility.eligibleEntries !== utility.table.entries.filter((entry) => entry.eligible).length
    || summary.utility.sourceQuestions !== utility.table.sourceQuestions
    || summary.utility.feedbackEvents !== utility.table.feedbackEvents) {
    increment(mismatches, "summary_identity_gate_or_hash");
  }
  return {
    validationVersion: "lifecycle-longmemeval-v2-utility-test-validation-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    status: Object.keys(mismatches).length === 0 ? "passed" : "failed",
    evaluationStatus: summary.status,
    rows: cases.length,
    directProxyRows: direct.length,
    mismatches,
    sourceSha256: {
      cases: casesDigest,
      summary: summaryDigest,
      baselineCases: baselineCasesDigest,
      baselineSummary: baselineSummaryDigest,
      utility: utilityDigest,
    },
    answerLevelState: summary.answerLevelState,
    limitations: [
      "The validator independently rebuilds public units and recomputes utility selection, cost certificates, direct support, aggregates, bootstrap, and the frozen test gate.",
      "It does not rerun MemoryCore FTS5; candidate ordering remains covered by the locked baseline identity check and production test run.",
      "The direct metric is answer-atom occurrence rather than task success or answer accuracy.",
    ],
  };
}
