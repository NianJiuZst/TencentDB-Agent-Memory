import { createHash } from "node:crypto";
import type {
  LongMemEvalV2TrajectoryExpansionBaselineCase,
  LongMemEvalV2TrajectoryExpansionBaselineSummary,
} from "./longmemeval-v2-trajectory-expansion-baseline-runner.js";
import {
  LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL,
  LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT,
  trajectoryExpansionQuestionIdsForPhase,
  type LongMemEvalV2TrajectoryExpansionPhase,
} from "./longmemeval-v2-trajectory-expansion-protocol.js";
import type {
  LongMemEvalV2TrajectoryExpansionCase,
  LongMemEvalV2TrajectoryExpansionSummary,
  TrajectoryExpansionArmComparison,
  TrajectoryExpansionArmSummary,
} from "./longmemeval-v2-trajectory-expansion-runner.js";

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

export interface TrajectoryExpansionIndependentValidation {
  validationVersion: "lifecycle-longmemeval-v2-trajectory-expansion-independent-validation-v1.0";
  sourceProtocolVersion: string;
  phase: LongMemEvalV2TrajectoryExpansionPhase;
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

function aggregate(cases: LongMemEvalV2TrajectoryExpansionCase[]) {
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
  cases: LongMemEvalV2TrajectoryExpansionCase[];
  comparator: "base" | "d11";
  seed: number;
}): BootstrapResult | null {
  const direct = params.cases.filter((row) => row.directProxy);
  if (direct.length === 0) return null;
  const groups = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(params.seed);
  const delta = (row: LongMemEvalV2TrajectoryExpansionCase) => params.comparator === "base"
    ? row.answerAtomSupportRecallDeltaVsBase! : row.answerAtomSupportRecallDeltaVsD11!;
  const estimates: number[] = [];
  for (let sample = 0;
    sample < LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.aggregation.bootstrapSamples;
    sample += 1) {
    const drawn = groups.flatMap((group) => Array.from({ length: group.length }, () =>
      delta(group[Math.floor(random() * group.length)])));
    estimates.push(mean(drawn));
  }
  return {
    mean: mean(direct.map(delta)),
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
    questions: direct.length,
    strata: groups.length,
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function recomputeArm(params: {
  arm: "step_agnostic" | "locally_verified";
  cases: LongMemEvalV2TrajectoryExpansionCase[];
  seed: number;
}): TrajectoryExpansionArmSummary {
  const direct = params.cases.filter((row) => row.directProxy);
  const baseDeltas = direct.map((row) => row.answerAtomSupportRecallDeltaVsBase!);
  const d11Deltas = direct.map((row) => row.answerAtomSupportRecallDeltaVsD11!);
  const metrics = aggregate(params.cases);
  const baseMeanTokens = mean(params.cases.map((row) => row.baseInjectedTokens));
  const d11MeanTokens = mean(params.cases.map((row) => row.d11InjectedTokens));
  const ranks = params.cases.flatMap((row) =>
    row.externalCandidateRank === null ? [] : [row.externalCandidateRank]);
  const forcedFallbackMismatches: Record<string, number> = {};
  for (const row of params.cases) {
    for (const [key, value] of Object.entries(row.forcedFallbackMismatches)) {
      forcedFallbackMismatches[key] = (forcedFallbackMismatches[key] ?? 0) + value;
    }
  }
  const byDomain = Object.fromEntries([...new Set(params.cases.map((row) => row.domain))].sort()
    .map((domain) => {
      const rows = params.cases.filter((row) => row.domain === domain && row.directProxy);
      const allRows = params.cases.filter((row) => row.domain === domain);
      const base = mean(rows.map((row) => row.baseAnswerAtomSupportRecall!));
      const d11 = mean(rows.map((row) => row.d11AnswerAtomSupportRecall!));
      const selected = mean(rows.map((row) => row.answerAtomSupportRecall!));
      return [domain, {
        directProxyCases: rows.length,
        baseAnswerAtomSupportRecall: base,
        d11AnswerAtomSupportRecall: d11,
        answerAtomSupportRecall: selected,
        deltaVsBase: selected - base,
        deltaVsD11: selected - d11,
        meanInjectedTokens: mean(allRows.map((row) => row.injectedTokens)),
      }];
    }));
  return {
    policyId: LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.candidate.policyId,
    arm: params.arm,
    cases: params.cases.length,
    directProxyCases: direct.length,
    orderedProxyCases: direct.filter((row) => row.orderedQuestion).length,
    metrics: {
      ...metrics,
      d11UseRate: mean(params.cases.map((row) => row.d11UsedSubstitution ? 1 : 0)),
      expansionUseRate: mean(params.cases.map((row) => row.usedExpansion ? 1 : 0)),
      inheritedD11Rate: mean(params.cases.map((row) =>
        row.selectionMode === "inherited_source_evidence" ? 1 : 0)),
      selectionLatencyP50Ms: percentile(params.cases.map((row) => row.selectionLatencyMs), 0.5),
      selectionLatencyP95Ms: percentile(params.cases.map((row) => row.selectionLatencyMs), 0.95),
      meanBaseEvidenceSpans: mean(params.cases.map((row) => row.baseEvidenceSpans)),
      meanNovelExternalEvidenceSpans: mean(params.cases.map((row) =>
        row.novelExternalEvidenceSpans)),
      meanNovelExternalEvidenceCharacters: mean(params.cases.map((row) =>
        row.novelExternalEvidenceCharacters)),
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
      meanInjectedTokenFraction: baseMeanTokens > 0 ? metrics.meanInjectedTokens / baseMeanTokens - 1 : 0,
    },
    deltasVsD11: {
      answerAtomSupportRecall: mean(d11Deltas),
      meanInjectedTokens: metrics.meanInjectedTokens - d11MeanTokens,
      meanInjectedTokenFraction: d11MeanTokens > 0 ? metrics.meanInjectedTokens / d11MeanTokens - 1 : 0,
    },
    directOutcomesVsBase: outcomes(baseDeltas),
    directOutcomesVsD11: outcomes(d11Deltas),
    answerAtomSupportRecallDeltaBootstrapVsBase: bootstrap({
      cases: params.cases,
      comparator: "base",
      seed: params.seed,
    }),
    answerAtomSupportRecallDeltaBootstrapVsD11: bootstrap({
      cases: params.cases,
      comparator: "d11",
      seed: params.seed + 1,
    }),
    byDomain,
    certificateViolations: {
      baseCapsulePreservation: params.cases.reduce((sum, row) =>
        sum + row.baseCapsulePreservationViolations, 0),
      externalEvidenceCoverage: params.cases.reduce((sum, row) =>
        sum + row.externalEvidenceCoverageViolations, 0),
      externalEvidenceOrder: params.cases.reduce((sum, row) =>
        sum + row.externalEvidenceOrderViolations, 0),
      externalProvenanceCoverage: params.cases.reduce((sum, row) =>
        sum + row.externalProvenanceCoverageViolations, 0),
      unrelatedBasePreservation: params.cases.reduce((sum, row) =>
        sum + row.unrelatedBasePreservationViolations, 0),
    },
    decisionReasons: countBy(params.cases.map((row) => row.decisionReason)),
    forcedFallbackMismatches,
  };
}

function recomputeComparison(
  verified: LongMemEvalV2TrajectoryExpansionCase[],
  agnostic: LongMemEvalV2TrajectoryExpansionCase[],
): TrajectoryExpansionArmComparison {
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
  verified: TrajectoryExpansionArmSummary;
  comparison: TrajectoryExpansionArmComparison;
}) {
  const gate = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.phaseGate;
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
    answerAtomSupportRecallDeltaVsD11:
      params.verified.deltasVsD11.answerAtomSupportRecall + EPSILON
        >= gate.minAnswerAtomSupportRecallDeltaVsD11,
    improvedDirectProxyCasesVsD11:
      params.verified.directOutcomesVsD11.improved >= gate.minImprovedDirectProxyCasesVsD11,
    harmedDirectProxyCasesVsD11:
      params.verified.directOutcomesVsD11.harmed <= gate.maxHarmedDirectProxyCasesVsD11,
    bootstrapLowerVsBase:
      (params.verified.answerAtomSupportRecallDeltaBootstrapVsBase?.lower ?? -Infinity) + EPSILON
        >= gate.minBootstrapLowerVsBase,
    bootstrapLowerVsD11:
      (params.verified.answerAtomSupportRecallDeltaBootstrapVsD11?.lower ?? -Infinity) + EPSILON
        >= gate.minBootstrapLowerVsD11,
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
    perQueryTokenViolations:
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

function baselineMismatch(
  row: LongMemEvalV2TrajectoryExpansionCase,
  baseline: LongMemEvalV2TrajectoryExpansionBaselineCase | undefined,
): boolean {
  return !baseline
    || row.query !== baseline.query
    || !exactIds(row.baseCandidateIds, baseline.candidateIds)
    || !exactIds(row.baseInjectedIds, baseline.injectedIds)
    || row.baseInjectedTokens !== baseline.injectedTokens
    || row.baseAnswerAtomSupportRecall !== baseline.answerAtomSupportRecall
    || row.baseAnyAnswerAtomSupported !== baseline.anyAnswerAtomSupported
    || row.baseAllAnswerAtomsSupported !== baseline.allAnswerAtomsSupported
    || row.baseOrderedSequenceSupported !== baseline.orderedSequenceSupported;
}

function arithmeticMismatch(row: LongMemEvalV2TrajectoryExpansionCase): boolean {
  if (!row.directProxy) {
    return [row.answerAtomCount, row.supportedAtomCount, row.answerAtomSupportRecall,
      row.anyAnswerAtomSupported, row.allAnswerAtomsSupported,
      row.answerAtomSupportRecallDeltaVsBase, row.answerAtomSupportRecallDeltaVsD11]
      .some((value) => value !== null);
  }
  return row.answerAtomCount === null || row.answerAtomCount <= 0
    || row.supportedAtomCount === null || row.supportedAtomCount < 0
    || row.supportedAtomCount > row.answerAtomCount
    || Math.abs(row.answerAtomSupportRecall! - row.supportedAtomCount / row.answerAtomCount) > EPSILON
    || Math.abs(row.answerAtomSupportRecallDeltaVsBase!
      - (row.answerAtomSupportRecall! - row.baseAnswerAtomSupportRecall!)) > EPSILON
    || Math.abs(row.answerAtomSupportRecallDeltaVsD11!
      - (row.answerAtomSupportRecall! - row.d11AnswerAtomSupportRecall!)) > EPSILON
    || row.answerAtomSupportRecall! + EPSILON < row.baseAnswerAtomSupportRecall!
    || row.answerAtomSupportRecall! + EPSILON < row.d11AnswerAtomSupportRecall!;
}

function selectionStructureMismatch(row: LongMemEvalV2TrajectoryExpansionCase): boolean {
  if (row.injectedTokens > row.baseInjectedTokens
    || row.injectedIds.length > row.baseInjectedIds.length) return true;
  if (row.usedExpansion) {
    return row.selectionMode !== "trajectory_evidence_expansion"
      || !row.externalCandidateId || row.externalCandidateRank === null
      || !row.trajectoryId || row.novelExternalEvidenceSpans <= 0
      || row.externalCandidateRank < 0
      || row.externalCandidateRank >= row.baseCandidateIds.length
      || row.baseCandidateIds[row.externalCandidateRank] !== row.externalCandidateId
      || row.baseInjectedIds.includes(row.externalCandidateId)
      || !row.externalCandidateId.startsWith(`lmev2:raw:${row.trajectoryId}:`)
      || row.procedureId !== `lmev2:local-procedure:${row.trajectoryId}`;
  }
  if (row.externalCandidateId !== null || row.externalCandidateRank !== null
    || row.novelExternalEvidenceSpans !== 0) return true;
  if (row.selectionMode === "inherited_source_evidence") {
    return row.contextSha256 !== row.d11ContextSha256
      || !exactIds(row.injectedIds, row.d11InjectedIds)
      || row.injectedTokens !== row.d11InjectedTokens;
  }
  if (row.selectionMode === "baseline_noop" || row.selectionMode === "fallback_baseline") {
    return !exactIds(row.injectedIds, row.baseInjectedIds)
      || row.injectedTokens !== row.baseInjectedTokens;
  }
  return true;
}

export function validateLongMemEvalV2TrajectoryExpansionArtifacts(params: {
  phase: LongMemEvalV2TrajectoryExpansionPhase;
  baselineCasesText: string;
  baselineSummaryText: string;
  casesText: string;
  summaryText: string;
}): TrajectoryExpansionIndependentValidation {
  const baselineCasesSha = sha256(params.baselineCasesText);
  const baselineSummarySha = sha256(params.baselineSummaryText);
  const casesSha = sha256(params.casesText);
  const summarySha = sha256(params.summaryText);
  const baselineCases = params.baselineCasesText.split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as LongMemEvalV2TrajectoryExpansionBaselineCase);
  const baselineSummary = JSON.parse(
    params.baselineSummaryText,
  ) as LongMemEvalV2TrajectoryExpansionBaselineSummary;
  const cases = params.casesText.split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as LongMemEvalV2TrajectoryExpansionCase);
  const summary = JSON.parse(params.summaryText) as LongMemEvalV2TrajectoryExpansionSummary;
  const expectedIds = trajectoryExpansionQuestionIdsForPhase(params.phase).sort();
  const baselineById = new Map(baselineCases.map((row) => [row.questionId, row]));
  const protocol = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL;

  let artifactIdentity = 0;
  if (baselineSummary.casesSha256 !== baselineCasesSha
    || summary.casesSha256 !== casesSha
    || summary.baselineArtifact.casesSha256 !== baselineCasesSha
    || summary.baselineArtifact.summarySha256 !== baselineSummarySha
    || baselineSummary.protocolVersion !== protocol.protocolVersion
    || summary.protocolVersion !== protocol.protocolVersion
    || baselineSummary.phase !== params.phase
    || summary.phase !== params.phase
    || baselineSummary.preScoreCommit !== summary.preScoreCommit
    || baselineSummary.authorizationSha256 !== summary.authorizationSha256
    || baselineSummary.splitCanonicalSha256 !== LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.canonicalSha256
    || summary.splitCanonicalSha256 !== LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.canonicalSha256) {
    artifactIdentity += 1;
  }

  let coverage = 0;
  if (!exactIds(baselineCases.map((row) => row.questionId).sort(), expectedIds)
    || cases.length !== expectedIds.length * 2
    || new Set(cases.map((row) => `${row.arm}:${row.questionId}`)).size !== cases.length
    || !exactIds([...new Set(cases.map((row) => row.questionId))].sort(), expectedIds)) {
    coverage += 1;
  }

  let rowProtocol = 0;
  let baselineReplay = 0;
  let arithmetic = 0;
  let selectionStructure = 0;
  let certificate = 0;
  let forcedFallback = 0;
  for (const row of cases) {
    if (row.protocolVersion !== protocol.protocolVersion
      || row.policyId !== protocol.candidate.policyId
      || row.phase !== params.phase
      || row.mode !== "trajectory_evidence_expansion"
      || (row.arm !== "locally_verified" && row.arm !== "step_agnostic")) rowProtocol += 1;
    if (baselineMismatch(row, baselineById.get(row.questionId))) baselineReplay += 1;
    if (arithmeticMismatch(row)) arithmetic += 1;
    if (selectionStructureMismatch(row)) selectionStructure += 1;
    certificate += row.baseCapsulePreservationViolations
      + row.externalEvidenceCoverageViolations
      + row.externalEvidenceOrderViolations
      + row.externalProvenanceCoverageViolations
      + row.unrelatedBasePreservationViolations;
    forcedFallback += Object.values(row.forcedFallbackMismatches)
      .reduce((sum, value) => sum + value, 0);
  }

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
  const summaryRecomputation = JSON.stringify(recomputedArms) === JSON.stringify(summary.armSummaries)
    && JSON.stringify(recomputedComparison) === JSON.stringify(summary.localFeedbackComparison) ? 0 : 1;
  const gateRecomputation = JSON.stringify(recomputedGate) === JSON.stringify(summary.gate) ? 0 : 1;
  const mismatches = {
    artifactIdentity,
    coverage,
    rowProtocol,
    baselineReplay,
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
    allArithmeticMatches: arithmetic === 0,
    allSelectionStructuresMatch: selectionStructure === 0,
    zeroCertificateViolations: certificate === 0,
    exactForcedFallbacks: forcedFallback === 0,
    summaryRecomputedExactly: summaryRecomputation === 0,
    gateRecomputedExactly: gateRecomputation === 0,
  };
  const validationPassed = Object.values(checks).every(Boolean);
  return {
    validationVersion: "lifecycle-longmemeval-v2-trajectory-expansion-independent-validation-v1.0",
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
