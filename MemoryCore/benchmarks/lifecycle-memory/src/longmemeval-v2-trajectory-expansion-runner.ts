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
  buildLocalProcedureIndex,
  buildLocalProgressEvents,
  buildLocalProgressTable,
  type LocalProcedureRecord,
  type LocalProgressTable,
  type LocalSubstitutionArm,
} from "./longmemeval-v2-local-substitution.js";
import { scoreProcedureDirectSupport } from "./longmemeval-v2-procedure.js";
import {
  aggregateProcedureCases,
  mean,
  percentile,
  type ProcedureAggregateMetrics,
} from "./longmemeval-v2-procedure-baseline-runner.js";
import { selectSourceEvidenceSubstitutionContext } from "./longmemeval-v2-source-evidence-substitution.js";
import {
  buildLongMemEvalV2StaticQuestionSplit,
  longMemEvalV2StaticEvaluatorFamily,
  type LongMemEvalV2StaticEvaluatorFamily,
} from "./longmemeval-v2-static-split.js";
import {
  assertTrajectoryExpansionPhaseReadAuthorized,
  type LongMemEvalV2TrajectoryExpansionBaselineCase,
  type LongMemEvalV2TrajectoryExpansionBaselineSummary,
  type TrajectoryExpansionPhaseAdmission,
} from "./longmemeval-v2-trajectory-expansion-baseline-runner.js";
import {
  LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL,
  LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT,
  trajectoryExpansionQuestionIdsForPhase,
  type LongMemEvalV2TrajectoryExpansionPhase,
} from "./longmemeval-v2-trajectory-expansion-protocol.js";
import {
  selectTrajectoryEvidenceExpansionContext,
  type TrajectoryEvidenceExpansionConfig,
} from "./longmemeval-v2-trajectory-expansion.js";
import type { RetrievedUnit } from "./types.js";

const EPSILON = 1e-12;

interface Outcomes {
  improved: number;
  equal: number;
  harmed: number;
}

export interface LongMemEvalV2TrajectoryExpansionCase {
  protocolVersion: string;
  mode: "trajectory_evidence_expansion";
  phase: LongMemEvalV2TrajectoryExpansionPhase;
  policyId: string;
  arm: LocalSubstitutionArm;
  questionId: string;
  domain: string;
  environment: string;
  evaluatorFamily: LongMemEvalV2StaticEvaluatorFamily;
  directProxy: boolean;
  orderedQuestion: boolean;
  query: string;
  baseCandidateIds: string[];
  baseInjectedIds: string[];
  baseInjectedTokens: number;
  baseAnswerAtomSupportRecall: number | null;
  baseAnyAnswerAtomSupported: number | null;
  baseAllAnswerAtomsSupported: number | null;
  baseOrderedSequenceSupported: number | null;
  procedureCandidateIds: string[];
  d11InjectedIds: string[];
  d11ContextSha256: string;
  d11ProcedureId: string | null;
  d11InjectedTokens: number;
  d11UsedSubstitution: boolean;
  d11DecisionReason: string;
  d11AnswerAtomSupportRecall: number | null;
  injectedIds: string[];
  contextSha256: string;
  procedureId: string | null;
  trajectoryId: string | null;
  replacedRawIds: string[];
  externalCandidateId: string | null;
  externalCandidateRank: number | null;
  baseEvidenceSpans: number;
  novelExternalEvidenceSpans: number;
  novelExternalEvidenceCharacters: number;
  injectedTokens: number;
  tokenViolation: boolean;
  rawQueryLatencyMs: number;
  procedureQueryLatencyMs: number;
  selectionLatencyMs: number;
  queryLatencyMs: number;
  usedExpansion: boolean;
  selectionMode: string;
  decisionReason: string;
  fallback: boolean;
  fallbackReason: string | null;
  baseCapsulePreservationViolations: number;
  externalEvidenceCoverageViolations: number;
  externalEvidenceOrderViolations: number;
  externalProvenanceCoverageViolations: number;
  unrelatedBasePreservationViolations: number;
  answerAtomCount: number | null;
  supportedAtomCount: number | null;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  orderedSequenceSupported: number | null;
  answerAtomSupportRecallDeltaVsBase: number | null;
  answerAtomSupportRecallDeltaVsD11: number | null;
  forcedFallbackMismatches: Record<string, number>;
}

export interface TrajectoryExpansionArmSummary {
  policyId: string;
  arm: LocalSubstitutionArm;
  cases: number;
  directProxyCases: number;
  orderedProxyCases: number;
  metrics: ProcedureAggregateMetrics & {
    d11UseRate: number;
    expansionUseRate: number;
    inheritedD11Rate: number;
    selectionLatencyP50Ms: number;
    selectionLatencyP95Ms: number;
    meanBaseEvidenceSpans: number;
    meanNovelExternalEvidenceSpans: number;
    meanNovelExternalEvidenceCharacters: number;
    meanExternalCandidateRank: number;
  };
  deltasVsBase: {
    answerAtomSupportRecall: number;
    anyAnswerAtomSupportedRate: number;
    allAnswerAtomsSupportedRate: number;
    orderedSequenceSupportedRate: number;
    meanInjectedTokens: number;
    meanInjectedTokenFraction: number;
  };
  deltasVsD11: {
    answerAtomSupportRecall: number;
    meanInjectedTokens: number;
    meanInjectedTokenFraction: number;
  };
  directOutcomesVsBase: Outcomes;
  directOutcomesVsD11: Outcomes;
  answerAtomSupportRecallDeltaBootstrapVsBase: BootstrapResult | null;
  answerAtomSupportRecallDeltaBootstrapVsD11: BootstrapResult | null;
  byDomain: Record<string, {
    directProxyCases: number;
    baseAnswerAtomSupportRecall: number;
    d11AnswerAtomSupportRecall: number;
    answerAtomSupportRecall: number;
    deltaVsBase: number;
    deltaVsD11: number;
    meanInjectedTokens: number;
  }>;
  certificateViolations: {
    baseCapsulePreservation: number;
    externalEvidenceCoverage: number;
    externalEvidenceOrder: number;
    externalProvenanceCoverage: number;
    unrelatedBasePreservation: number;
  };
  decisionReasons: Record<string, number>;
  forcedFallbackMismatches: Record<string, number>;
}

interface BootstrapResult {
  mean: number;
  lower: number;
  upper: number;
  questions: number;
  strata: number;
}

export interface TrajectoryExpansionArmComparison extends Outcomes {
  changedContexts: number;
  answerAtomSupportRecallDelta: number;
  meanInjectedTokenDelta: number;
}

export interface LongMemEvalV2TrajectoryExpansionSummary {
  protocolVersion: string;
  mode: "trajectory_evidence_expansion";
  phase: LongMemEvalV2TrajectoryExpansionPhase;
  status: "development_passed" | "development_failed" | "validation_passed"
    | "validation_failed" | "test_passed" | "test_failed";
  preScoreCommit: string;
  authorizationSha256: string | null;
  baselineArtifact: { casesSha256: string; summarySha256: string };
  splitCanonicalSha256: string;
  index: Record<string, {
    trajectories: number;
    states: number;
    rawUnits: number;
    rawTruncatedStates: number;
    procedureUnits: number;
    actions: number;
    locallyVerifiedActions: number;
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
    locallyVerifiedEvents: number;
  };
  armSummaries: TrajectoryExpansionArmSummary[];
  localFeedbackComparison: TrajectoryExpansionArmComparison;
  casesSha256: string;
  gate: { passed: boolean; checks: Record<string, boolean> };
  laterPhaseState: "unread";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactContext(
  selected: { items: RetrievedUnit[]; injectedTokens: number },
  baseline: PackedLongTaskContext,
): boolean {
  return selected.injectedTokens === baseline.injectedTokens
    && selected.items.length === baseline.items.length
    && selected.items.every((item, index) => item.id === baseline.items[index].id
      && item.content === baseline.items[index].content
      && item.tokenCount === baseline.items[index].tokenCount);
}

function activeConfig(): TrajectoryEvidenceExpansionConfig {
  const candidate = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.candidate;
  return {
    maxProcedureUnits: candidate.maxProcedureUnits,
    maxActionsPerProcedure: candidate.maxActionsPerProcedure,
    maxSafeAnchors: candidate.maxSafeAnchors,
    maxCapsuleCharacters: candidate.maxD11CapsuleCharacters,
    procedureCandidateLimit: candidate.procedureCandidateLimit,
    sourceEvidence: {
      maxSpans: candidate.maxBaseEvidenceSpans,
      maxSpanCharacters: candidate.maxBaseEvidenceSpanCharacters,
      maxEvidenceCharacters: candidate.maxBaseEvidenceCharacters,
    },
    rawCandidateLimit: candidate.rawCandidateLimit,
    maxExternalCandidates: 1,
    externalCandidatePolicy: "max_novel_spans",
    maxExpansionCapsuleCharacters: candidate.maxExpansionCapsuleCharacters,
    externalEvidence: {
      maxSpans: candidate.maxExternalEvidenceSpans,
      maxSpanCharacters: candidate.maxExternalEvidenceSpanCharacters,
      maxEvidenceCharacters: candidate.maxExternalEvidenceCharacters,
    },
  };
}

async function loadLockedBaseline(params: {
  casesPath: string;
  summaryPath: string;
  phase: LongMemEvalV2TrajectoryExpansionPhase;
  preScoreCommit: string;
  authorizationSha256?: string;
}): Promise<{
  cases: LongMemEvalV2TrajectoryExpansionBaselineCase[];
  byQuestionId: Map<string, LongMemEvalV2TrajectoryExpansionBaselineCase>;
  summary: LongMemEvalV2TrajectoryExpansionBaselineSummary;
  artifact: { casesSha256: string; summarySha256: string };
}> {
  const [casesText, summaryText] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
  ]);
  const casesSha256 = sha256(casesText);
  const summarySha256 = sha256(summaryText);
  const summary = JSON.parse(summaryText) as LongMemEvalV2TrajectoryExpansionBaselineSummary;
  const cases = casesText.split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as LongMemEvalV2TrajectoryExpansionBaselineCase);
  const expectedIds = trajectoryExpansionQuestionIdsForPhase(params.phase).sort();
  if (summary.protocolVersion !== LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.protocolVersion
    || summary.mode !== "base"
    || summary.phase !== params.phase
    || summary.status !== "completed"
    || summary.preScoreCommit !== params.preScoreCommit
    || summary.authorizationSha256 !== (params.authorizationSha256 ?? null)
    || summary.splitCanonicalSha256 !== LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.canonicalSha256
    || summary.casesSha256 !== casesSha256
    || cases.length !== summary.cases
    || new Set(cases.map((row) => row.questionId)).size !== cases.length
    || !exactIds(cases.map((row) => row.questionId).sort(), expectedIds)) {
    throw new Error("D12 locked Base artifact identity mismatch");
  }
  return {
    cases,
    byQuestionId: new Map(cases.map((row) => [row.questionId, row])),
    summary,
    artifact: { casesSha256, summarySha256 },
  };
}

function assertFrozenStaticSplit(questions: LongTaskQuestion[]): void {
  const protocol = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL;
  const generated = buildLongMemEvalV2StaticQuestionSplit({
    questions,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    questionsSha256: protocol.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.seed,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT)) {
    throw new Error("D12 generated static split differs from the frozen split");
  }
}

function assertBaselineRecomputed(params: {
  locked: LongMemEvalV2TrajectoryExpansionBaselineCase;
  query: string;
  candidates: RetrievedUnit[];
  packed: PackedLongTaskContext;
  support: ReturnType<typeof scoreProcedureDirectSupport>;
}): void {
  const support = params.support;
  if (params.locked.query !== params.query
    || !exactIds(params.locked.candidateIds, params.candidates.map((item) => item.id))
    || !exactIds(params.locked.injectedIds, params.packed.items.map((item) => item.id))
    || params.locked.injectedTokens !== params.packed.injectedTokens
    || params.locked.tokenViolation !== params.packed.tokenViolation
    || params.locked.answerAtomCount !== (support?.answerAtoms.length ?? null)
    || params.locked.supportedAtomCount !== (support?.supportedAtomCount ?? null)
    || params.locked.answerAtomSupportRecall !== (support?.answerAtomSupportRecall ?? null)
    || params.locked.anyAnswerAtomSupported !== (support?.anyAnswerAtomSupported ?? null)
    || params.locked.allAnswerAtomsSupported !== (support?.allAnswerAtomsSupported ?? null)
    || params.locked.orderedSequenceSupported !== (support?.orderedSequenceSupported ?? null)) {
    throw new Error(`D12 recomputed Base differs for ${params.locked.questionId}`);
  }
}

function forcedFallbackChecks(params: {
  baseline: PackedLongTaskContext;
  rawCandidates: RetrievedUnit[];
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, LocalProcedureRecord>;
  feedbackTable: LocalProgressTable;
  config: TrajectoryEvidenceExpansionConfig;
  feedbackEvents: ReturnType<typeof buildLocalProgressEvents>;
}): Record<string, number> {
  const common = { ...params, arm: "locally_verified" as const };
  const overflow = buildLocalProgressTable({ events: params.feedbackEvents.slice(0, 2), capacity: 1 });
  const checks = {
    disabled: selectTrajectoryEvidenceExpansionContext({ ...common, enabled: false }),
    missingProcedureIndex: selectTrajectoryEvidenceExpansionContext({
      ...common,
      procedureIndexAvailable: false,
    }),
    missingFeedbackTable: selectTrajectoryEvidenceExpansionContext({
      ...common,
      feedbackTable: undefined,
    }),
    feedbackTableOverflow: selectTrajectoryEvidenceExpansionContext({
      ...common,
      feedbackTable: overflow,
    }),
    timeout: selectTrajectoryEvidenceExpansionContext({ ...common, timedOut: true }),
    corrupt: selectTrajectoryEvidenceExpansionContext({ ...common, forceCorrupt: true }),
    budgetOverflow: selectTrajectoryEvidenceExpansionContext({
      ...common,
      forceBudgetOverflow: true,
    }),
    missingRawCandidatePool: selectTrajectoryEvidenceExpansionContext({
      ...common,
      rawCandidatePoolAvailable: false,
    }),
    externalCorrupt: selectTrajectoryEvidenceExpansionContext({
      ...common,
      forceExternalCorrupt: true,
    }),
    externalCertificate: selectTrajectoryEvidenceExpansionContext({
      ...common,
      forceExternalCoverageFailure: true,
    }),
  };
  return Object.fromEntries(Object.entries(checks).map(([key, selected]) => [
    key,
    exactContext(selected, params.baseline) ? 0 : 1,
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

function bootstrapDelta(params: {
  cases: LongMemEvalV2TrajectoryExpansionCase[];
  comparator: "base" | "d11";
  seed: number;
}): BootstrapResult | null {
  const direct = params.cases.filter((row) => row.directProxy);
  if (direct.length === 0) return null;
  const groups = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(params.seed);
  const estimates: number[] = [];
  const delta = (row: LongMemEvalV2TrajectoryExpansionCase) => params.comparator === "base"
    ? row.answerAtomSupportRecallDeltaVsBase! : row.answerAtomSupportRecallDeltaVsD11!;
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

function outcomes(values: readonly number[]): Outcomes {
  return {
    improved: values.filter((value) => value > EPSILON).length,
    equal: values.filter((value) => Math.abs(value) <= EPSILON).length,
    harmed: values.filter((value) => value < -EPSILON).length,
  };
}

export function summarizeTrajectoryExpansionArm(params: {
  arm: LocalSubstitutionArm;
  cases: LongMemEvalV2TrajectoryExpansionCase[];
  seed: number;
}): TrajectoryExpansionArmSummary {
  const direct = params.cases.filter((row) => row.directProxy);
  const baseDeltas = direct.map((row) => row.answerAtomSupportRecallDeltaVsBase!);
  const d11Deltas = direct.map((row) => row.answerAtomSupportRecallDeltaVsD11!);
  const baseMetrics = aggregateProcedureCases(params.cases);
  const baseMeanTokens = mean(params.cases.map((row) => row.baseInjectedTokens));
  const d11MeanTokens = mean(params.cases.map((row) => row.d11InjectedTokens));
  const selectedRanks = params.cases.flatMap((row) =>
    row.externalCandidateRank === null ? [] : [row.externalCandidateRank]);
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
  const decisionReasons: Record<string, number> = {};
  const forcedFallbackMismatches: Record<string, number> = {};
  for (const row of params.cases) {
    decisionReasons[row.decisionReason] = (decisionReasons[row.decisionReason] ?? 0) + 1;
    for (const [key, value] of Object.entries(row.forcedFallbackMismatches)) {
      forcedFallbackMismatches[key] = (forcedFallbackMismatches[key] ?? 0) + value;
    }
  }
  return {
    policyId: LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.candidate.policyId,
    arm: params.arm,
    cases: params.cases.length,
    directProxyCases: direct.length,
    orderedProxyCases: direct.filter((row) => row.orderedQuestion).length,
    metrics: {
      ...baseMetrics,
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
      meanExternalCandidateRank: mean(selectedRanks),
    },
    deltasVsBase: {
      answerAtomSupportRecall: mean(baseDeltas),
      anyAnswerAtomSupportedRate: baseMetrics.anyAnswerAtomSupportedRate
        - mean(direct.map((row) => row.baseAnyAnswerAtomSupported!)),
      allAnswerAtomsSupportedRate: baseMetrics.allAnswerAtomsSupportedRate
        - mean(direct.map((row) => row.baseAllAnswerAtomsSupported!)),
      orderedSequenceSupportedRate: baseMetrics.orderedSequenceSupportedRate
        - mean(direct.filter((row) => row.orderedQuestion)
          .map((row) => row.baseOrderedSequenceSupported!)),
      meanInjectedTokens: baseMetrics.meanInjectedTokens - baseMeanTokens,
      meanInjectedTokenFraction: baseMeanTokens > 0
        ? baseMetrics.meanInjectedTokens / baseMeanTokens - 1 : 0,
    },
    deltasVsD11: {
      answerAtomSupportRecall: mean(d11Deltas),
      meanInjectedTokens: baseMetrics.meanInjectedTokens - d11MeanTokens,
      meanInjectedTokenFraction: d11MeanTokens > 0
        ? baseMetrics.meanInjectedTokens / d11MeanTokens - 1 : 0,
    },
    directOutcomesVsBase: outcomes(baseDeltas),
    directOutcomesVsD11: outcomes(d11Deltas),
    answerAtomSupportRecallDeltaBootstrapVsBase: bootstrapDelta({
      cases: params.cases,
      comparator: "base",
      seed: params.seed,
    }),
    answerAtomSupportRecallDeltaBootstrapVsD11: bootstrapDelta({
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
    decisionReasons,
    forcedFallbackMismatches,
  };
}

export function compareTrajectoryExpansionArms(
  verified: LongMemEvalV2TrajectoryExpansionCase[],
  agnostic: LongMemEvalV2TrajectoryExpansionCase[],
): TrajectoryExpansionArmComparison {
  const controls = new Map(agnostic.map((row) => [row.questionId, row]));
  let changedContexts = 0;
  const qualityDeltas: number[] = [];
  const tokenDeltas: number[] = [];
  for (const row of verified) {
    const control = controls.get(row.questionId);
    if (!control) throw new Error(`missing D12 agnostic row ${row.questionId}`);
    if (row.contextSha256 !== control.contextSha256) changedContexts += 1;
    tokenDeltas.push(row.injectedTokens - control.injectedTokens);
    if (row.directProxy) {
      qualityDeltas.push(row.answerAtomSupportRecall! - control.answerAtomSupportRecall!);
    }
  }
  return {
    changedContexts,
    answerAtomSupportRecallDelta: mean(qualityDeltas),
    meanInjectedTokenDelta: mean(tokenDeltas),
    ...outcomes(qualityDeltas),
  };
}

export function evaluateTrajectoryExpansionGate(params: {
  verified: TrajectoryExpansionArmSummary;
  comparison: TrajectoryExpansionArmComparison;
}): { passed: boolean; checks: Record<string, boolean> } {
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

function statusFor(
  phase: LongMemEvalV2TrajectoryExpansionPhase,
  passed: boolean,
): LongMemEvalV2TrajectoryExpansionSummary["status"] {
  return `${phase}_${passed ? "passed" : "failed"}` as LongMemEvalV2TrajectoryExpansionSummary["status"];
}

export async function runLongMemEvalV2TrajectoryExpansion(params: {
  dataRoot: string;
  phase: LongMemEvalV2TrajectoryExpansionPhase;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  preScoreCommit: string;
  authorization?: TrajectoryExpansionPhaseAdmission;
  authorizationSha256?: string;
}): Promise<{
  cases: LongMemEvalV2TrajectoryExpansionCase[];
  summary: LongMemEvalV2TrajectoryExpansionSummary;
}> {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.preScoreCommit)) {
    throw new Error("D12 preScoreCommit must be a git SHA");
  }
  assertTrajectoryExpansionPhaseReadAuthorized(params);
  if (params.phase !== "development"
    && (!params.authorizationSha256 || !/^[0-9a-f]{64}$/iu.test(params.authorizationSha256))) {
    throw new Error(`D12 ${params.phase} requires the admission artifact SHA-256`);
  }
  const baseline = await loadLockedBaseline({
    casesPath: params.baselineCasesPath,
    summaryPath: params.baselineSummaryPath,
    phase: params.phase,
    preScoreCommit: params.preScoreCommit,
    authorizationSha256: params.authorizationSha256,
  });
  const protocol = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL;
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
  assertFrozenStaticSplit(questions);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const selectedQuestions = trajectoryExpansionQuestionIdsForPhase(params.phase).map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing D12 frozen static question ${id}`);
    return question;
  });
  const trajectoryIds = [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))];
  const trajectories = await adapter.loadTrajectories(trajectoryIds);
  const byDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = byDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    byDomain.set(trajectory.domain, values);
  }
  const rawBackends = new Map<string, MemoryCoreGroupBackend>();
  const procedureBackends = new Map<string, MemoryCoreGroupBackend>();
  const procedureRecords = new Map<string, LocalProcedureRecord>();
  const index: LongMemEvalV2TrajectoryExpansionSummary["index"] = {};
  const config = activeConfig();
  try {
    for (const [domain, domainTrajectories] of [...byDomain.entries()].sort()) {
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
      const procedures = buildLocalProcedureIndex({ trajectories: domainTrajectories, config });
      procedureBackends.set(domain, new MemoryCoreGroupBackend(procedures.indexUnits));
      for (const record of procedures.records) {
        if (procedureRecords.has(record.id)) throw new Error(`duplicate D12 procedure ${record.id}`);
        procedureRecords.set(record.id, record);
      }
      index[domain] = {
        trajectories: domainTrajectories.length,
        states: domainTrajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0),
        rawUnits: raw.units.length,
        rawTruncatedStates: raw.truncatedStates,
        procedureUnits: procedures.records.length,
        actions: procedures.actions,
        locallyVerifiedActions: procedures.locallyVerifiedActions,
        maskedTargets: procedures.maskedTargets,
        truncatedProcedures: procedures.truncatedProcedures,
        rawBuildLatencyMs,
        procedureBuildLatencyMs: performance.now() - procedureStartedAt,
      };
    }
    const records = [...procedureRecords.values()].sort((left, right) =>
      left.id.localeCompare(right.id));
    const events = buildLocalProgressEvents(records);
    const feedbackTable = buildLocalProgressTable({
      events,
      capacity: protocol.localFeedback.maxEvents,
      knownActionCounts: new Map(records.map((record) => [record.id, record.totalActions])),
    });
    if (!feedbackTable.available || feedbackTable.entries.size !== events.length) {
      throw new Error(`D12 feedback unavailable: ${feedbackTable.failureReason}`);
    }
    const cases: LongMemEvalV2TrajectoryExpansionCase[] = [];
    for (const question of selectedQuestions) {
      const rawBackend = rawBackends.get(question.domain);
      const procedureBackend = procedureBackends.get(question.domain);
      if (!rawBackend || !procedureBackend) throw new Error(`missing D12 backend ${question.domain}`);
      const locked = baseline.byQuestionId.get(question.id);
      if (!locked) throw new Error(`missing D12 locked Base row ${question.id}`);
      const query = sanitizeLongTaskQuery(question.prompt);
      const rawSearch = await rawBackend.search(query, protocol.baseline.candidateLimit);
      const baseContext = packLongTaskContext({
        candidates: rawSearch.candidates,
        tokenBudget: protocol.baseline.injectionTokenBudget,
        resultLimit: protocol.baseline.resultLimit,
      });
      const baseSupport = scoreProcedureDirectSupport({ question, injected: baseContext.items });
      assertBaselineRecomputed({
        locked,
        query,
        candidates: rawSearch.candidates,
        packed: baseContext,
        support: baseSupport,
      });
      const procedureSearch = await procedureBackend.search(query, config.procedureCandidateLimit);
      const forced = forcedFallbackChecks({
        baseline: baseContext,
        rawCandidates: rawSearch.candidates,
        procedureCandidates: procedureSearch.candidates,
        procedureRecords,
        feedbackTable,
        config,
        feedbackEvents: events,
      });
      for (const arm of ["step_agnostic", "locally_verified"] as const) {
        const d11 = selectSourceEvidenceSubstitutionContext({
          baseline: baseContext,
          procedureCandidates: procedureSearch.candidates,
          procedureRecords,
          feedbackTable,
          config,
          arm,
        });
        const d11Support = scoreProcedureDirectSupport({ question, injected: d11.items });
        const selectionStartedAt = performance.now();
        const selected = selectTrajectoryEvidenceExpansionContext({
          baseline: baseContext,
          rawCandidates: rawSearch.candidates,
          procedureCandidates: procedureSearch.candidates,
          procedureRecords,
          feedbackTable,
          config,
          arm,
        });
        const selectionLatencyMs = performance.now() - selectionStartedAt;
        const support = scoreProcedureDirectSupport({ question, injected: selected.items });
        cases.push({
          protocolVersion: protocol.protocolVersion,
          mode: "trajectory_evidence_expansion",
          phase: params.phase,
          policyId: protocol.candidate.policyId,
          arm,
          questionId: question.id,
          domain: question.domain,
          environment: question.environment,
          evaluatorFamily: longMemEvalV2StaticEvaluatorFamily(question),
          directProxy: support !== null,
          orderedQuestion: support?.orderedQuestion ?? false,
          query,
          baseCandidateIds: rawSearch.candidates.map((item) => item.id),
          baseInjectedIds: baseContext.items.map((item) => item.id),
          baseInjectedTokens: baseContext.injectedTokens,
          baseAnswerAtomSupportRecall: baseSupport?.answerAtomSupportRecall ?? null,
          baseAnyAnswerAtomSupported: baseSupport?.anyAnswerAtomSupported ?? null,
          baseAllAnswerAtomsSupported: baseSupport?.allAnswerAtomsSupported ?? null,
          baseOrderedSequenceSupported: baseSupport?.orderedSequenceSupported ?? null,
          procedureCandidateIds: procedureSearch.candidates.map((item) => item.id),
          d11InjectedIds: d11.items.map((item) => item.id),
          d11ContextSha256: d11.contextSha256,
          d11ProcedureId: d11.procedureId,
          d11InjectedTokens: d11.injectedTokens,
          d11UsedSubstitution: d11.usedSubstitution,
          d11DecisionReason: d11.decisionReason,
          d11AnswerAtomSupportRecall: d11Support?.answerAtomSupportRecall ?? null,
          injectedIds: selected.items.map((item) => item.id),
          contextSha256: selected.contextSha256,
          procedureId: selected.procedureId,
          trajectoryId: selected.trajectoryId,
          replacedRawIds: selected.replacedRawIds,
          externalCandidateId: selected.externalCandidateId,
          externalCandidateRank: selected.externalCandidateRank,
          baseEvidenceSpans: selected.baseEvidenceSpans.length,
          novelExternalEvidenceSpans: selected.novelExternalEvidenceSpans.length,
          novelExternalEvidenceCharacters: selected.novelExternalEvidenceCharacters,
          injectedTokens: selected.injectedTokens,
          tokenViolation: selected.tokenViolation
            || selected.injectedTokens > baseContext.injectedTokens,
          rawQueryLatencyMs: rawSearch.latencyMs,
          procedureQueryLatencyMs: procedureSearch.latencyMs,
          selectionLatencyMs,
          queryLatencyMs: rawSearch.latencyMs + procedureSearch.latencyMs + selectionLatencyMs,
          usedExpansion: selected.usedExpansion,
          selectionMode: selected.mode,
          decisionReason: selected.decisionReason,
          fallback: selected.fallback,
          fallbackReason: selected.fallbackReason,
          baseCapsulePreservationViolations: selected.baseCapsulePreservationViolations,
          externalEvidenceCoverageViolations: selected.externalEvidenceCoverageViolations,
          externalEvidenceOrderViolations: selected.externalEvidenceOrderViolations,
          externalProvenanceCoverageViolations: selected.externalProvenanceCoverageViolations,
          unrelatedBasePreservationViolations: selected.unrelatedBasePreservationViolations,
          answerAtomCount: support?.answerAtoms.length ?? null,
          supportedAtomCount: support?.supportedAtomCount ?? null,
          answerAtomSupportRecall: support?.answerAtomSupportRecall ?? null,
          anyAnswerAtomSupported: support?.anyAnswerAtomSupported ?? null,
          allAnswerAtomsSupported: support?.allAnswerAtomsSupported ?? null,
          orderedSequenceSupported: support?.orderedSequenceSupported ?? null,
          answerAtomSupportRecallDeltaVsBase: support
            ? support.answerAtomSupportRecall - baseSupport!.answerAtomSupportRecall : null,
          answerAtomSupportRecallDeltaVsD11: support
            ? support.answerAtomSupportRecall - d11Support!.answerAtomSupportRecall : null,
          forcedFallbackMismatches: arm === "locally_verified" ? forced
            : Object.fromEntries(Object.keys(forced).map((key) => [key, 0])),
        });
      }
    }
    cases.sort((left, right) => left.arm.localeCompare(right.arm)
      || left.questionId.localeCompare(right.questionId));
    const agnosticCases = cases.filter((row) => row.arm === "step_agnostic");
    const verifiedCases = cases.filter((row) => row.arm === "locally_verified");
    const armSummaries = [
      summarizeTrajectoryExpansionArm({
        arm: "step_agnostic",
        cases: agnosticCases,
        seed: protocol.aggregation.bootstrapSeed + 100,
      }),
      summarizeTrajectoryExpansionArm({
        arm: "locally_verified",
        cases: verifiedCases,
        seed: protocol.aggregation.bootstrapSeed,
      }),
    ];
    const comparison = compareTrajectoryExpansionArms(verifiedCases, agnosticCases);
    const verified = armSummaries.find((summary) => summary.arm === "locally_verified")!;
    const gate = evaluateTrajectoryExpansionGate({ verified, comparison });
    const casesText = cases.map(canonicalJsonLine).join("");
    return {
      cases,
      summary: {
        protocolVersion: protocol.protocolVersion,
        mode: "trajectory_evidence_expansion",
        phase: params.phase,
        status: statusFor(params.phase, gate.passed),
        preScoreCommit: params.preScoreCommit,
        authorizationSha256: params.authorizationSha256 ?? null,
        baselineArtifact: baseline.artifact,
        splitCanonicalSha256: LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_SPLIT.canonicalSha256,
        index,
        feedback: {
          events: events.length,
          entries: feedbackTable.entries.size,
          capacity: feedbackTable.capacity,
          available: feedbackTable.available,
          failureReason: feedbackTable.failureReason,
          locallyVerifiedEvents: events.filter((event) =>
            event.status === "verified_progress").length,
        },
        armSummaries,
        localFeedbackComparison: comparison,
        casesSha256: sha256(casesText),
        gate,
        laterPhaseState: "unread",
      },
    };
  } finally {
    for (const backend of rawBackends.values()) backend.close();
    for (const backend of procedureBackends.values()) backend.close();
  }
}
