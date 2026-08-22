import { createHash } from "node:crypto";
import type {
  LongMemEvalV2ResidualFeedbackPatchBaselineCase,
  LongMemEvalV2ResidualFeedbackPatchBaselineSummary,
} from "./longmemeval-v2-residual-feedback-patch-baseline-runner.js";
import {
  LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL,
  LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT,
  residualFeedbackPatchQuestionIdsForPhase,
  type LongMemEvalV2ResidualFeedbackPatchPhase,
} from "./longmemeval-v2-residual-feedback-patch-protocol.js";
import type {
  LongMemEvalV2ResidualFeedbackPatchCase,
  LongMemEvalV2ResidualFeedbackPatchSummary,
  ResidualFeedbackPatchArmComparison,
  ResidualFeedbackPatchArmSummary,
} from "./longmemeval-v2-residual-feedback-patch-runner.js";

const EPSILON = 1e-12;

interface Outcomes {
  improved: number;
  equal: number;
  harmed: number;
}

interface BootstrapResult {
  mean: number;
  lower: number;
  upper: number;
  questions: number;
  strata: number;
}

export interface ResidualFeedbackPatchIndependentValidation {
  validationVersion: "lifecycle-longmemeval-v2-residual-feedback-patch-independent-validation-v1.0";
  sourceProtocolVersion: string;
  phase: LongMemEvalV2ResidualFeedbackPatchPhase;
  sourceStatus: string;
  sourceGatePassed: boolean;
  artifactSha256: {
    baselineCases: string;
    baselineSummary: string;
    cases: string;
    summary: string;
  };
  counts: {
    baselineRows: number;
    candidateRows: number;
    questions: number;
    directProxyQuestions: number;
  };
  mismatches: {
    artifactIdentity: number;
    coverage: number;
    rowProtocol: number;
    baselineReplay: number;
    baselineSummaryRecomputation: number;
    arithmetic: number;
    selectionStructure: number;
    certificate: number;
    forcedFallback: number;
    summaryRecomputation: number;
    gateRecomputation: number;
  };
  checks: {
    allArtifactIdentitiesMatch: boolean;
    exactQuestionAndArmCoverage: boolean;
    allRowsUseFrozenProtocol: boolean;
    allBaselineFieldsReplay: boolean;
    baselineSummaryRecomputedExactly: boolean;
    allArithmeticMatches: boolean;
    allSelectionStructuresMatch: boolean;
    zeroCertificateViolations: boolean;
    exactForcedFallbacks: boolean;
    summaryRecomputedExactly: boolean;
    gateRecomputedExactly: boolean;
  };
  validationPassed: boolean;
  admissionEligible: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
}

function semanticallyExact(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * probability) - 1))];
}

function outcomes(values: readonly number[]): Outcomes {
  return {
    improved: values.filter((value) => value > EPSILON).length,
    equal: values.filter((value) => Math.abs(value) <= EPSILON).length,
    harmed: values.filter((value) => value < -EPSILON).length,
  };
}

function aggregate(cases: readonly {
  directProxy: boolean;
  orderedQuestion: boolean;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  orderedSequenceSupported: number | null;
  injectedTokens: number;
  injectedIds: string[];
  queryLatencyMs: number;
  tokenViolation: boolean;
  fallback: boolean;
}[]) {
  const direct = cases.filter((row) => row.directProxy);
  const ordered = direct.filter((row) => row.orderedQuestion);
  return {
    answerAtomSupportRecall: mean(direct.map((row) => row.answerAtomSupportRecall!)),
    anyAnswerAtomSupportedRate: mean(direct.map((row) => row.anyAnswerAtomSupported!)),
    allAnswerAtomsSupportedRate: mean(direct.map((row) => row.allAnswerAtomsSupported!)),
    orderedSequenceSupportedRate: mean(ordered.map((row) => row.orderedSequenceSupported!)),
    meanInjectedTokens: mean(cases.map((row) => row.injectedTokens)),
    meanInjectedItems: mean(cases.map((row) => row.injectedIds.length)),
    queryLatencyP50Ms: percentile(cases.map((row) => row.queryLatencyMs), 0.5),
    queryLatencyP95Ms: percentile(cases.map((row) => row.queryLatencyMs), 0.95),
    tokenViolations: cases.filter((row) => row.tokenViolation).length,
    fallbacks: cases.filter((row) => row.fallback).length,
  };
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

function bootstrap(params: {
  cases: LongMemEvalV2ResidualFeedbackPatchCase[];
  seed: number;
}): BootstrapResult | null {
  const direct = params.cases.filter((row) => row.directProxy);
  if (direct.length === 0) return null;
  const groups = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(params.seed);
  const estimates: number[] = [];
  for (let sample = 0;
    sample < LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.aggregation.bootstrapSamples;
    sample += 1) {
    const drawn = groups.flatMap((group) => Array.from({ length: group.length }, () =>
      group[Math.floor(random() * group.length)].answerAtomSupportRecallDeltaVsBase!));
    estimates.push(mean(drawn));
  }
  return {
    mean: mean(direct.map((row) => row.answerAtomSupportRecallDeltaVsBase!)),
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
    questions: direct.length,
    strata: groups.length,
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function recomputeBaselineSummary(
  cases: LongMemEvalV2ResidualFeedbackPatchBaselineCase[],
): Pick<LongMemEvalV2ResidualFeedbackPatchBaselineSummary,
"cases" | "directProxyCases" | "answerOnlyCases" | "orderedProxyCases" | "metrics" | "byDomain"> {
  const direct = cases.filter((row) => row.directProxy);
  const byDomain = Object.fromEntries([...new Set(cases.map((row) => row.domain))].sort()
    .map((domain) => {
      const domainCases = cases.filter((row) => row.domain === domain);
      const domainDirect = domainCases.filter((row) => row.directProxy);
      const ordered = domainDirect.filter((row) => row.orderedQuestion);
      return [domain, {
        cases: domainCases.length,
        directProxyCases: domainDirect.length,
        answerAtomSupportRecall: mean(domainDirect.map((row) => row.answerAtomSupportRecall!)),
        orderedSequenceSupportedRate: mean(ordered.map((row) =>
          row.orderedSequenceSupported!)),
        meanInjectedTokens: mean(domainCases.map((row) => row.injectedTokens)),
      }];
    }));
  return {
    cases: cases.length,
    directProxyCases: direct.length,
    answerOnlyCases: cases.length - direct.length,
    orderedProxyCases: direct.filter((row) => row.orderedQuestion).length,
    metrics: aggregate(cases),
    byDomain,
  };
}

function recomputeArm(params: {
  arm: "step_agnostic" | "locally_verified";
  cases: LongMemEvalV2ResidualFeedbackPatchCase[];
  seed: number;
}): ResidualFeedbackPatchArmSummary {
  const direct = params.cases.filter((row) => row.directProxy);
  const baseDeltas = direct.map((row) => row.answerAtomSupportRecallDeltaVsBase!);
  const metrics = aggregate(params.cases);
  const baseMeanTokens = mean(params.cases.map((row) => row.baseInjectedTokens));
  const baseMeanItems = mean(params.cases.map((row) => row.baseInjectedIds.length));
  const ranks = params.cases.flatMap((row) =>
    row.externalCandidateRank === null ? [] : [row.externalCandidateRank]);
  const patched = params.cases.filter((row) => row.usedPatch);
  const forcedFallbackMismatches: Record<string, number> = {};
  for (const row of params.cases) {
    for (const [key, value] of Object.entries(row.forcedFallbackMismatches)) {
      forcedFallbackMismatches[key] = (forcedFallbackMismatches[key] ?? 0) + value;
    }
  }
  const byDomain = Object.fromEntries([...new Set(params.cases.map((row) => row.domain))].sort()
    .map((domain) => {
      const rows = direct.filter((row) => row.domain === domain);
      const allRows = params.cases.filter((row) => row.domain === domain);
      const base = mean(rows.map((row) => row.baseAnswerAtomSupportRecall!));
      const selected = mean(rows.map((row) => row.answerAtomSupportRecall!));
      return [domain, {
        directProxyCases: rows.length,
        baseAnswerAtomSupportRecall: base,
        answerAtomSupportRecall: selected,
        deltaVsBase: selected - base,
        meanInjectedTokens: mean(allRows.map((row) => row.injectedTokens)),
      }];
    }));
  return {
    policyId: LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.candidate.policyId,
    arm: params.arm,
    cases: params.cases.length,
    directProxyCases: direct.length,
    orderedProxyCases: direct.filter((row) => row.orderedQuestion).length,
    metrics: {
      ...metrics,
      patchUseRate: mean(params.cases.map((row) => row.usedPatch ? 1 : 0)),
      exactBaseNoopRate: mean(params.cases.map((row) =>
        !row.usedPatch && !row.fallback ? 1 : 0)),
      selectionLatencyP50Ms: percentile(params.cases.map((row) => row.selectionLatencyMs), 0.5),
      selectionLatencyP95Ms: percentile(params.cases.map((row) => row.selectionLatencyMs), 0.95),
      meanPatchTokens: mean(patched.map((row) => row.patchTokens)),
      meanPatchSpans: mean(patched.map((row) => row.patchSpans)),
      meanExternalCandidateRank: mean(ranks),
    },
    deltasVsBase: {
      answerAtomSupportRecall: mean(baseDeltas),
      anyAnswerAtomSupportedRate: metrics.anyAnswerAtomSupportedRate
        - mean(direct.map((row) => row.baseAnyAnswerAtomSupported!)),
      allAnswerAtomsSupportedRate: metrics.allAnswerAtomsSupportedRate
        - mean(direct.map((row) => row.baseAllAnswerAtomsSupported!)),
      orderedSequenceSupportedRate: metrics.orderedSequenceSupportedRate
        - mean(direct.filter((row) => row.orderedQuestion)
          .map((row) => row.baseOrderedSequenceSupported!)),
      meanInjectedTokens: metrics.meanInjectedTokens - baseMeanTokens,
      meanInjectedTokenFraction: baseMeanTokens > 0
        ? metrics.meanInjectedTokens / baseMeanTokens - 1 : 0,
      meanInjectedItems: metrics.meanInjectedItems - baseMeanItems,
    },
    directOutcomesVsBase: outcomes(baseDeltas),
    answerAtomSupportRecallDeltaBootstrapVsBase: bootstrap({
      cases: params.cases,
      seed: params.seed,
    }),
    byDomain,
    certificateViolations: {
      basePrefix: params.cases.reduce((sum, row) => sum + row.basePrefixViolations, 0),
      patchEvidenceCoverage: params.cases.reduce((sum, row) =>
        sum + row.patchEvidenceCoverageViolations, 0),
      patchEvidenceOrder: params.cases.reduce((sum, row) =>
        sum + row.patchEvidenceOrderViolations, 0),
      patchProvenance: params.cases.reduce((sum, row) =>
        sum + row.patchProvenanceViolations, 0),
    },
    decisionReasons: countBy(params.cases.map((row) => row.decisionReason)),
    forcedFallbackMismatches,
  };
}

function recomputeComparison(
  verified: LongMemEvalV2ResidualFeedbackPatchCase[],
  agnostic: LongMemEvalV2ResidualFeedbackPatchCase[],
): ResidualFeedbackPatchArmComparison {
  const controls = new Map(agnostic.map((row) => [row.questionId, row]));
  const quality: number[] = [];
  const tokens: number[] = [];
  let changedContexts = 0;
  for (const row of verified) {
    const control = controls.get(row.questionId)!;
    if (row.contextSha256 !== control.contextSha256) changedContexts += 1;
    tokens.push(row.injectedTokens - control.injectedTokens);
    if (row.directProxy) quality.push(row.answerAtomSupportRecall! - control.answerAtomSupportRecall!);
  }
  return {
    changedContexts,
    answerAtomSupportRecallDelta: mean(quality),
    meanInjectedTokenDelta: mean(tokens),
    ...outcomes(quality),
  };
}

function recomputeGate(params: {
  verified: ResidualFeedbackPatchArmSummary;
  comparison: ResidualFeedbackPatchArmComparison;
}) {
  const gate = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.phaseGate;
  const certificateViolations = Object.values(params.verified.certificateViolations)
    .reduce((sum, value) => sum + value, 0);
  const checks = {
    answerAtomSupportRecallDeltaVsBase:
      params.verified.deltasVsBase.answerAtomSupportRecall + EPSILON
        >= gate.minAnswerAtomSupportRecallDeltaVsBase,
    improvedDirectProxyCasesVsBase:
      params.verified.directOutcomesVsBase.improved >= gate.minImprovedDirectProxyCasesVsBase,
    harmedDirectProxyCasesVsBase:
      params.verified.directOutcomesVsBase.harmed <= gate.maxHarmedDirectProxyCasesVsBase,
    bootstrapLowerVsBase:
      (params.verified.answerAtomSupportRecallDeltaBootstrapVsBase?.lower ?? -Infinity) + EPSILON
        >= gate.minBootstrapLowerVsBase,
    changedContextsVsAgnostic:
      params.comparison.changedContexts >= gate.minChangedContextsVsAgnostic,
    answerAtomSupportRecallDeltaVsAgnostic:
      params.comparison.answerAtomSupportRecallDelta + EPSILON
        >= gate.minAnswerAtomSupportRecallDeltaVsAgnostic,
    harmedDirectProxyCasesVsAgnostic:
      params.comparison.harmed <= gate.maxHarmedDirectProxyCasesVsAgnostic,
    meanInjectedTokenDeltaVsAgnostic:
      params.comparison.meanInjectedTokenDelta <= gate.maxMeanInjectedTokenDeltaVsAgnostic + EPSILON,
    meanInjectedTokenIncreaseFractionVsBase:
      params.verified.deltasVsBase.meanInjectedTokenFraction
        <= gate.maxMeanInjectedTokenIncreaseFractionVsBase + EPSILON,
    maxPatchTokensPerQuery:
      params.verified.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    certificateViolations: certificateViolations <= gate.maxCertificateViolations,
    ordinaryFallbacks: params.verified.metrics.fallbacks <= gate.maxOrdinaryFallbacks,
    selectionLatencyP95Ms:
      params.verified.metrics.selectionLatencyP95Ms <= gate.maxP95SelectionLatencyMs,
    exactForcedFallbacks: !gate.requireExactForcedFallbacks
      || Object.values(params.verified.forcedFallbackMismatches).every((value) => value === 0),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function expectedStatus(phase: LongMemEvalV2ResidualFeedbackPatchPhase, passed: boolean): string {
  if (phase === "test") {
    return passed ? "test_direct_passed_pending_answer_level" : "test_direct_failed";
  }
  return `${phase}_${passed ? "passed" : "failed"}`;
}

function baselineMismatch(
  row: LongMemEvalV2ResidualFeedbackPatchCase,
  baseline: LongMemEvalV2ResidualFeedbackPatchBaselineCase | undefined,
): boolean {
  return !baseline
    || row.query !== baseline.query
    || row.domain !== baseline.domain
    || row.environment !== baseline.environment
    || row.evaluatorFamily !== baseline.evaluatorFamily
    || row.directProxy !== baseline.directProxy
    || row.orderedQuestion !== baseline.orderedQuestion
    || !exactIds(row.baseCandidateIds, baseline.candidateIds)
    || !exactIds(row.baseInjectedIds, baseline.injectedIds)
    || !exactIds(row.baseInjectedItemSha256, baseline.injectedItemSha256)
    || row.baseContextSha256 !== baseline.contextSha256
    || row.baseInjectedTokens !== baseline.injectedTokens
    || row.baseAnswerAtomSupportRecall !== baseline.answerAtomSupportRecall
    || row.baseAnyAnswerAtomSupported !== baseline.anyAnswerAtomSupported
    || row.baseAllAnswerAtomsSupported !== baseline.allAnswerAtomsSupported
    || row.baseOrderedSequenceSupported !== baseline.orderedSequenceSupported;
}

function arithmeticMismatch(row: LongMemEvalV2ResidualFeedbackPatchCase): boolean {
  if (!row.directProxy) {
    return [row.answerAtomCount, row.supportedAtomCount, row.answerAtomSupportRecall,
      row.anyAnswerAtomSupported, row.allAnswerAtomsSupported,
      row.orderedSequenceSupported, row.answerAtomSupportRecallDeltaVsBase]
      .some((value) => value !== null);
  }
  return row.answerAtomCount === null || row.answerAtomCount <= 0
    || row.supportedAtomCount === null || row.supportedAtomCount < 0
    || row.supportedAtomCount > row.answerAtomCount
    || row.answerAtomSupportRecall === null
    || row.baseAnswerAtomSupportRecall === null
    || row.answerAtomSupportRecallDeltaVsBase === null
    || Math.abs(row.answerAtomSupportRecall
      - row.supportedAtomCount / row.answerAtomCount) > EPSILON
    || row.anyAnswerAtomSupported !== (row.supportedAtomCount > 0 ? 1 : 0)
    || row.allAnswerAtomsSupported !== (row.supportedAtomCount === row.answerAtomCount ? 1 : 0)
    || (row.orderedSequenceSupported !== 0 && row.orderedSequenceSupported !== 1)
    || Math.abs(row.answerAtomSupportRecallDeltaVsBase
      - (row.answerAtomSupportRecall - row.baseAnswerAtomSupportRecall)) > EPSILON;
}

function selectionStructureMismatch(
  row: LongMemEvalV2ResidualFeedbackPatchCase,
  baseline: LongMemEvalV2ResidualFeedbackPatchBaselineCase | undefined,
): boolean {
  if (!baseline) return true;
  const protocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL;
  const expectedTokenViolation = baseline.tokenViolation
    || row.patchTokens > protocol.phaseGate.maxPatchTokensPerQuery
    || row.injectedTokens > row.baseInjectedTokens
      + protocol.phaseGate.maxPatchTokensPerQuery
    || row.appendedItems > protocol.phaseGate.maxAppendedItemsPerQuery
    || row.appendedItems < 0;
  if (row.tokenViolation !== expectedTokenViolation
    || row.appendedItems !== row.injectedIds.length - row.baseInjectedIds.length
    || row.injectedItemSha256.length !== row.injectedIds.length
    || !exactIds(row.injectedIds.slice(0, row.baseInjectedIds.length), row.baseInjectedIds)
    || !exactIds(row.injectedItemSha256.slice(0, row.baseInjectedItemSha256.length),
      row.baseInjectedItemSha256)) {
    return true;
  }
  if (row.usedPatch) {
    return row.selectionMode !== "residual_feedback_patch"
      || row.decisionReason !== "accepted"
      || row.fallback || row.fallbackReason !== null
      || row.appendedItems !== 1
      || row.injectedIds.length !== row.baseInjectedIds.length + 1
      || !row.externalCandidateId || row.externalCandidateRank === null
      || !row.trajectoryId || !row.procedureId
      || row.patchSpans <= 0 || row.patchSpans > protocol.candidate.maxPatchSpans
      || row.patchTokens <= 0 || row.patchTokens > protocol.candidate.maxPatchTokens
      || row.externalCandidateRank < 0
      || row.externalCandidateRank >= row.baseCandidateIds.length
      || row.baseCandidateIds[row.externalCandidateRank] !== row.externalCandidateId
      || row.baseInjectedIds.includes(row.externalCandidateId)
      || !row.externalCandidateId.startsWith(`lmev2:raw:${row.trajectoryId}:`)
      || row.procedureId !== `lmev2:local-procedure:${row.trajectoryId}`
      || row.injectedTokens !== row.baseInjectedTokens + row.patchTokens;
  }
  return row.appendedItems !== 0
    || row.patchSpans !== 0 || row.patchTokens !== 0 || row.queryTermsCovered !== 0
    || row.externalCandidateId !== null || row.externalCandidateRank !== null
    || row.procedureId !== null || row.trajectoryId !== null
    || !exactIds(row.injectedIds, row.baseInjectedIds)
    || !exactIds(row.injectedItemSha256, row.baseInjectedItemSha256)
    || row.contextSha256 !== row.baseContextSha256
    || row.injectedTokens !== row.baseInjectedTokens
    || (row.selectionMode !== "baseline_noop" && row.selectionMode !== "fallback_baseline")
    || (row.selectionMode === "fallback_baseline") !== row.fallback
    || (row.fallback && row.decisionReason !== "operational_fallback")
    || (!row.fallback && row.fallbackReason !== null)
    || row.answerAtomSupportRecall !== row.baseAnswerAtomSupportRecall;
}

export function validateLongMemEvalV2ResidualFeedbackPatchArtifacts(params: {
  phase: LongMemEvalV2ResidualFeedbackPatchPhase;
  baselineCasesText: string;
  baselineSummaryText: string;
  casesText: string;
  summaryText: string;
}): ResidualFeedbackPatchIndependentValidation {
  const baselineCasesSha = sha256(params.baselineCasesText);
  const baselineSummarySha = sha256(params.baselineSummaryText);
  const casesSha = sha256(params.casesText);
  const summarySha = sha256(params.summaryText);
  const baselineCases = params.baselineCasesText.split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as LongMemEvalV2ResidualFeedbackPatchBaselineCase);
  const baselineSummary = JSON.parse(
    params.baselineSummaryText,
  ) as LongMemEvalV2ResidualFeedbackPatchBaselineSummary;
  const cases = params.casesText.split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as LongMemEvalV2ResidualFeedbackPatchCase);
  const summary = JSON.parse(params.summaryText) as LongMemEvalV2ResidualFeedbackPatchSummary;
  const expectedIds = residualFeedbackPatchQuestionIdsForPhase(params.phase).sort();
  const baselineById = new Map(baselineCases.map((row) => [row.questionId, row]));
  const protocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL;

  let artifactIdentity = 0;
  if (baselineSummary.casesSha256 !== baselineCasesSha
    || summary.casesSha256 !== casesSha
    || summary.baselineArtifact.casesSha256 !== baselineCasesSha
    || summary.baselineArtifact.summarySha256 !== baselineSummarySha
    || baselineSummary.protocolVersion !== protocol.protocolVersion
    || summary.protocolVersion !== protocol.protocolVersion
    || baselineSummary.mode !== "base"
    || summary.mode !== "residual_feedback_patch"
    || baselineSummary.phase !== params.phase
    || summary.phase !== params.phase
    || baselineSummary.preScoreCommit !== summary.preScoreCommit
    || baselineSummary.authorizationSha256 !== summary.authorizationSha256
    || baselineSummary.splitCanonicalSha256
      !== LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.canonicalSha256
    || summary.splitCanonicalSha256
      !== LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.canonicalSha256
    || summary.status !== expectedStatus(params.phase, summary.gate.passed)
    || summary.answerLevelState !== (params.phase === "test" && summary.gate.passed
      ? "admitted_pending" : "not_admitted")
    || baselineSummary.laterPhaseState !== "unread"
    || summary.laterPhaseState !== "unread") {
    artifactIdentity += 1;
  }

  let coverage = 0;
  const expectedCounts = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.counts[params.phase];
  if (!exactIds(baselineCases.map((row) => row.questionId).sort(), expectedIds)
    || new Set(baselineCases.map((row) => row.questionId)).size !== baselineCases.length
    || baselineCases.filter((row) => row.directProxy).length
      !== expectedCounts.directProxyQuestions
    || baselineCases.filter((row) => !row.directProxy).length
      !== expectedCounts.answerOnlyQuestions
    || cases.length !== expectedIds.length * 2
    || new Set(cases.map((row) => `${row.arm}:${row.questionId}`)).size !== cases.length
    || !exactIds([...new Set(cases.map((row) => row.questionId))].sort(), expectedIds)
    || cases.filter((row) => row.directProxy).length
      !== expectedCounts.directProxyQuestions * 2
    || cases.some((row) => row.arm !== "locally_verified" && row.arm !== "step_agnostic")) {
    coverage += 1;
  }

  let rowProtocol = 0;
  let baselineReplay = 0;
  let arithmetic = 0;
  let selectionStructure = 0;
  let certificate = 0;
  let forcedFallback = 0;
  for (const row of cases) {
    const baseline = baselineById.get(row.questionId);
    if (row.protocolVersion !== protocol.protocolVersion
      || row.policyId !== protocol.candidate.policyId
      || row.phase !== params.phase
      || row.mode !== "residual_feedback_patch") rowProtocol += 1;
    if (baselineMismatch(row, baseline)) baselineReplay += 1;
    if (arithmeticMismatch(row)) arithmetic += 1;
    if (selectionStructureMismatch(row, baseline)) selectionStructure += 1;
    certificate += row.basePrefixViolations
      + row.patchEvidenceCoverageViolations
      + row.patchEvidenceOrderViolations
      + row.patchProvenanceViolations;
    forcedFallback += Object.values(row.forcedFallbackMismatches)
      .reduce((sum, value) => sum + value, 0);
  }

  const baselineProjection = recomputeBaselineSummary(baselineCases);
  const baselineSummaryRecomputation = semanticallyExact(baselineProjection, {
    cases: baselineSummary.cases,
    directProxyCases: baselineSummary.directProxyCases,
    answerOnlyCases: baselineSummary.answerOnlyCases,
    orderedProxyCases: baselineSummary.orderedProxyCases,
    metrics: baselineSummary.metrics,
    byDomain: baselineSummary.byDomain,
  }) ? 0 : 1;
  const agnostic = cases.filter((row) => row.arm === "step_agnostic");
  const verified = cases.filter((row) => row.arm === "locally_verified");
  const recomputedArms = [
    recomputeArm({
      arm: "step_agnostic",
      cases: agnostic,
      seed: protocol.aggregation.bootstrapSeed + 100,
    }),
    recomputeArm({
      arm: "locally_verified",
      cases: verified,
      seed: protocol.aggregation.bootstrapSeed,
    }),
  ];
  const recomputedComparison = recomputeComparison(verified, agnostic);
  const recomputedGate = recomputeGate({
    verified: recomputedArms.find((value) => value.arm === "locally_verified")!,
    comparison: recomputedComparison,
  });
  const summaryRecomputation = semanticallyExact(recomputedArms, summary.armSummaries)
    && semanticallyExact(recomputedComparison, summary.localFeedbackComparison) ? 0 : 1;
  const gateRecomputation = semanticallyExact(recomputedGate, summary.gate) ? 0 : 1;
  const mismatches = {
    artifactIdentity,
    coverage,
    rowProtocol,
    baselineReplay,
    baselineSummaryRecomputation,
    arithmetic,
    selectionStructure,
    certificate,
    forcedFallback,
    summaryRecomputation,
    gateRecomputation,
  };
  const checks = {
    allArtifactIdentitiesMatch: artifactIdentity === 0,
    exactQuestionAndArmCoverage: coverage === 0,
    allRowsUseFrozenProtocol: rowProtocol === 0,
    allBaselineFieldsReplay: baselineReplay === 0,
    baselineSummaryRecomputedExactly: baselineSummaryRecomputation === 0,
    allArithmeticMatches: arithmetic === 0,
    allSelectionStructuresMatch: selectionStructure === 0,
    zeroCertificateViolations: certificate === 0,
    exactForcedFallbacks: forcedFallback === 0,
    summaryRecomputedExactly: summaryRecomputation === 0,
    gateRecomputedExactly: gateRecomputation === 0,
  };
  const validationPassed = Object.values(checks).every(Boolean);
  return {
    validationVersion:
      "lifecycle-longmemeval-v2-residual-feedback-patch-independent-validation-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    phase: params.phase,
    sourceStatus: summary.status,
    sourceGatePassed: summary.gate.passed,
    artifactSha256: {
      baselineCases: baselineCasesSha,
      baselineSummary: baselineSummarySha,
      cases: casesSha,
      summary: summarySha,
    },
    counts: {
      baselineRows: baselineCases.length,
      candidateRows: cases.length,
      questions: expectedIds.length,
      directProxyQuestions: baselineCases.filter((row) => row.directProxy).length,
    },
    mismatches,
    checks,
    validationPassed,
    admissionEligible: validationPassed && summary.gate.passed,
  };
}
