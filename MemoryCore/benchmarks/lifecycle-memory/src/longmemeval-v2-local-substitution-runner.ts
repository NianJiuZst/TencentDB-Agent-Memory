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
  assertLocalSubstitutionTestReadAuthorized,
  type LocalSubstitutionTestReadAuthorization,
} from "./longmemeval-v2-local-substitution-baseline-runner.js";
import {
  LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL,
  LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT,
  localSubstitutionQuestionIdsForPhase,
  type LongMemEvalV2LocalSubstitutionPhase,
} from "./longmemeval-v2-local-substitution-protocol.js";
import {
  buildLocalProcedureIndex,
  buildLocalProgressEvents,
  buildLocalProgressTable,
  selectLocalSubstitutionContext,
  type LocalProcedureRecord,
  type LocalProgressTable,
  type LocalSubstitutionArm,
  type LocalSubstitutionConfig,
} from "./longmemeval-v2-local-substitution.js";
import {
  scoreProcedureDirectSupport,
} from "./longmemeval-v2-procedure.js";
import {
  aggregateProcedureCases,
  mean,
  percentile,
  type ProcedureAggregateMetrics,
} from "./longmemeval-v2-procedure-baseline-runner.js";
import {
  buildLongMemEvalV2ProcedureQuestionSplit,
  longMemEvalV2ProcedureEvaluatorFamily,
  type LongMemEvalV2ProcedureEvaluatorFamily,
} from "./longmemeval-v2-procedure-split.js";
import type { RetrievedUnit } from "./types.js";

const EPSILON = 1e-12;

interface LockedBaselineCase {
  protocolVersion: string;
  mode: "base";
  phase: string;
  questionId: string;
  domain: string;
  environment: string;
  evaluatorFamily: LongMemEvalV2ProcedureEvaluatorFamily;
  directProxy: boolean;
  orderedQuestion: boolean;
  query: string;
  candidateIds: string[];
  injectedIds: string[];
  injectedTokens: number;
  tokenViolation: boolean;
  queryLatencyMs: number;
  answerAtomCount: number | null;
  supportedAtomCount: number | null;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  orderedSequenceSupported: number | null;
  fallback: false;
}

interface LockedBaseline {
  cases: LockedBaselineCase[];
  byQuestionId: Map<string, LockedBaselineCase>;
  metrics: ProcedureAggregateMetrics;
  artifacts: Array<{ casesSha256: string; summarySha256: string }>;
}

interface DirectOutcomes {
  improved: number;
  equal: number;
  harmed: number;
}

interface ArmComparison {
  changedContexts: number;
  answerAtomSupportRecallDelta: number;
  improvedDirectProxyCases: number;
  equalDirectProxyCases: number;
  harmedDirectProxyCases: number;
}

export interface LongMemEvalV2LocalSubstitutionCase {
  protocolVersion: string;
  mode: "local_substitution";
  phase: LongMemEvalV2LocalSubstitutionPhase;
  policyId: string;
  arm: LocalSubstitutionArm;
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
  contextSha256: string;
  procedureId: string | null;
  replacedRawIds: string[];
  rawIds: string[];
  safeAnchors: string[];
  injectedTokens: number;
  tokenViolation: boolean;
  rawQueryLatencyMs: number;
  procedureQueryLatencyMs: number;
  selectionLatencyMs: number;
  queryLatencyMs: number;
  usedSubstitution: boolean;
  selectionMode: "local_substitution" | "baseline_noop" | "fallback_baseline";
  decisionReason: string;
  fallback: boolean;
  fallbackReason: string | null;
  verifiedActions: number;
  totalActions: number;
  feedbackWilsonLower: number;
  anchorCoverageViolations: number;
  unrelatedBasePreservationViolations: number;
  answerAtomCount: number | null;
  supportedAtomCount: number | null;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  orderedSequenceSupported: number | null;
  answerAtomSupportRecallDelta: number | null;
  forcedFallbackMismatches: Record<string, number>;
}

export interface LocalSubstitutionArmSummary {
  policyId: string;
  arm: LocalSubstitutionArm;
  cases: number;
  directProxyCases: number;
  orderedProxyCases: number;
  metrics: ProcedureAggregateMetrics & {
    substitutionUseRate: number;
    selectionLatencyP50Ms: number;
    selectionLatencyP95Ms: number;
    meanSafeAnchors: number;
    meanVerifiedActions: number;
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
  certificateViolations: {
    anchorCoverage: number;
    unrelatedBasePreservation: number;
  };
  forcedFallbackMismatches: Record<string, number>;
}

export interface LongMemEvalV2LocalSubstitutionSummary {
  protocolVersion: string;
  mode: "local_substitution";
  phase: LongMemEvalV2LocalSubstitutionPhase;
  status: "consumed_audit_passed" | "consumed_audit_failed" | "test_passed" | "test_failed";
  preScoreCommit: string;
  authorizationSha256: string | null;
  baselineArtifacts: Array<{ casesSha256: string; summarySha256: string }>;
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
  armSummaries: LocalSubstitutionArmSummary[];
  localFeedbackComparison: ArmComparison;
  casesSha256: string;
  gate: { passed: boolean; checks: Record<string, boolean> };
  testState: "unread" | "read";
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
  result: { items: RetrievedUnit[]; injectedTokens: number },
  baseline: PackedLongTaskContext,
): boolean {
  return result.injectedTokens === baseline.injectedTokens
    && result.items.length === baseline.items.length
    && result.items.every((item, index) => item.id === baseline.items[index].id
      && item.content === baseline.items[index].content
      && item.tokenCount === baseline.items[index].tokenCount);
}

function expectedBaselineHashes(phase: LongMemEvalV2LocalSubstitutionPhase): Array<{
  cases: string;
  summary: string;
  sourcePhase: string;
  sourceProtocol: string;
}> | null {
  if (phase === "test") return null;
  const locked = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.lockedConsumedBaselines;
  return [
    {
      cases: locked.developmentCasesSha256,
      summary: locked.developmentSummarySha256,
      sourcePhase: "development",
      sourceProtocol: locked.sourceProtocolVersion,
    },
    {
      cases: locked.validationCasesSha256,
      summary: locked.validationSummarySha256,
      sourcePhase: "validation",
      sourceProtocol: locked.sourceProtocolVersion,
    },
  ];
}

async function loadLockedBaseline(params: {
  phase: LongMemEvalV2LocalSubstitutionPhase;
  casesPaths: string[];
  summaryPaths: string[];
  authorizationSha256?: string;
}): Promise<LockedBaseline> {
  if (params.casesPaths.length !== params.summaryPaths.length || params.casesPaths.length === 0) {
    throw new Error("D10 baseline artifact path count mismatch");
  }
  const expected = expectedBaselineHashes(params.phase);
  if (expected && expected.length !== params.casesPaths.length) {
    throw new Error("D10 consumed audit requires the two frozen D9 baseline phases");
  }
  if (!expected && params.casesPaths.length !== 1) {
    throw new Error("D10 test requires exactly one locked test baseline");
  }
  const cases: LockedBaselineCase[] = [];
  const artifacts: LockedBaseline["artifacts"] = [];
  for (let index = 0; index < params.casesPaths.length; index += 1) {
    const [casesText, summaryText] = await Promise.all([
      readFile(params.casesPaths[index], "utf8"),
      readFile(params.summaryPaths[index], "utf8"),
    ]);
    const casesSha256 = sha256(casesText);
    const summarySha256 = sha256(summaryText);
    const summary = JSON.parse(summaryText) as {
      protocolVersion: string;
      mode: string;
      phase: string;
      cases: number;
      casesSha256: string;
      authorizationSha256?: string;
    };
    const rows = casesText.trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as LockedBaselineCase);
    const expectedItem = expected?.[index];
    if (summary.mode !== "base"
      || summary.casesSha256 !== casesSha256
      || summary.cases !== rows.length
      || rows.some((row) => row.mode !== "base" || row.phase !== summary.phase)
      || (expectedItem && (casesSha256 !== expectedItem.cases
        || summarySha256 !== expectedItem.summary
        || summary.phase !== expectedItem.sourcePhase
        || summary.protocolVersion !== expectedItem.sourceProtocol))
      || (!expectedItem && (summary.phase !== "test"
        || summary.protocolVersion !== LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.protocolVersion
        || summary.authorizationSha256 !== params.authorizationSha256))) {
      throw new Error(`D10 locked baseline identity mismatch at artifact ${index}`);
    }
    cases.push(...rows);
    artifacts.push({ casesSha256, summarySha256 });
  }
  const ids = new Set(cases.map((row) => row.questionId));
  const expectedIds = localSubstitutionQuestionIdsForPhase(params.phase);
  if (ids.size !== cases.length || !exactIds([...ids].sort(), [...expectedIds].sort())) {
    throw new Error("D10 locked baseline question coverage mismatch");
  }
  return {
    cases,
    byQuestionId: new Map(cases.map((row) => [row.questionId, row])),
    metrics: aggregateProcedureCases(cases),
    artifacts,
  };
}

function assertFrozenSplit(questions: LongTaskQuestion[]): void {
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
  const generated = buildLongMemEvalV2ProcedureQuestionSplit({
    questions,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    questionsSha256: protocol.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT.seed,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT)) {
    throw new Error("D10 generated procedure split differs from the frozen split");
  }
}

function assertBaselineRecomputed(params: {
  locked: LockedBaselineCase;
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
    throw new Error(`D10 recomputed baseline differs for ${params.locked.questionId}`);
  }
}

function localConfig(): LocalSubstitutionConfig {
  const candidate = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.candidate;
  return {
    maxProcedureUnits: candidate.maxProcedureUnits,
    maxActionsPerProcedure: candidate.maxActionsPerProcedure,
    maxSafeAnchors: candidate.maxSafeAnchors,
    maxCapsuleCharacters: candidate.maxCapsuleCharacters,
    procedureCandidateLimit: candidate.procedureCandidateLimit,
  };
}

function forcedFallbackChecks(params: {
  baseline: PackedLongTaskContext;
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, LocalProcedureRecord>;
  feedbackTable: LocalProgressTable;
  config: LocalSubstitutionConfig;
  feedbackEvents: ReturnType<typeof buildLocalProgressEvents>;
}): Record<string, number> {
  const common = { ...params, arm: "locally_verified" as const };
  const overflow = buildLocalProgressTable({ events: params.feedbackEvents.slice(0, 2), capacity: 1 });
  const checks = {
    disabled: selectLocalSubstitutionContext({ ...common, enabled: false }),
    missingProcedureIndex: selectLocalSubstitutionContext({ ...common, procedureIndexAvailable: false }),
    missingFeedbackTable: selectLocalSubstitutionContext({ ...common, feedbackTable: undefined }),
    feedbackTableOverflow: selectLocalSubstitutionContext({ ...common, feedbackTable: overflow }),
    timeout: selectLocalSubstitutionContext({ ...common, timedOut: true }),
    corrupt: selectLocalSubstitutionContext({ ...common, forceCorrupt: true }),
    budgetOverflow: selectLocalSubstitutionContext({ ...common, forceBudgetOverflow: true }),
    anchorCertificate: selectLocalSubstitutionContext({ ...common, forceAnchorFailure: true }),
  };
  return Object.fromEntries(Object.entries(checks).map(([key, result]) => [
    key,
    exactContext(result, params.baseline) ? 0 : 1,
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

function bootstrapDelta(cases: LongMemEvalV2LocalSubstitutionCase[], seed: number): LocalSubstitutionArmSummary["answerAtomSupportRecallDeltaBootstrap"] {
  const direct = cases.filter((row) => row.directProxy);
  if (direct.length === 0) return null;
  const groups = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(seed);
  const estimates: number[] = [];
  for (let sample = 0; sample < LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const drawn = groups.flatMap((group) => Array.from({ length: group.length }, () => {
      const row = group[Math.floor(random() * group.length)];
      return row.answerAtomSupportRecallDelta!;
    }));
    estimates.push(mean(drawn));
  }
  return {
    mean: mean(direct.map((row) => row.answerAtomSupportRecallDelta!)),
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
    questions: direct.length,
    strata: groups.length,
  };
}

function outcomes(cases: LongMemEvalV2LocalSubstitutionCase[]): DirectOutcomes {
  const deltas = cases.filter((row) => row.directProxy).map((row) => row.answerAtomSupportRecallDelta!);
  return {
    improved: deltas.filter((value) => value > EPSILON).length,
    equal: deltas.filter((value) => Math.abs(value) <= EPSILON).length,
    harmed: deltas.filter((value) => value < -EPSILON).length,
  };
}

function summarizeArm(params: {
  arm: LocalSubstitutionArm;
  cases: LongMemEvalV2LocalSubstitutionCase[];
  baseline: LockedBaseline;
  seed: number;
}): LocalSubstitutionArmSummary {
  const base = aggregateProcedureCases(params.cases);
  const metrics = {
    ...base,
    substitutionUseRate: mean(params.cases.map((row) => row.usedSubstitution ? 1 : 0)),
    selectionLatencyP50Ms: percentile(params.cases.map((row) => row.selectionLatencyMs), 0.5),
    selectionLatencyP95Ms: percentile(params.cases.map((row) => row.selectionLatencyMs), 0.95),
    meanSafeAnchors: mean(params.cases.map((row) => row.safeAnchors.length)),
    meanVerifiedActions: mean(params.cases.map((row) => row.verifiedActions)),
  };
  const byDomain = Object.fromEntries([...new Set(params.cases.map((row) => row.domain))].sort()
    .map((domain) => {
      const rows = params.cases.filter((row) => row.domain === domain && row.directProxy);
      const baseline = mean(rows.map((row) => row.baseAnswerAtomSupportRecall!));
      const candidate = mean(rows.map((row) => row.answerAtomSupportRecall!));
      return [domain, {
        directProxyCases: rows.length,
        baseAnswerAtomSupportRecall: baseline,
        answerAtomSupportRecall: candidate,
        answerAtomSupportRecallDelta: candidate - baseline,
        meanInjectedTokens: mean(params.cases.filter((row) => row.domain === domain).map((row) => row.injectedTokens)),
      }];
    }));
  const forcedFallbackMismatches: Record<string, number> = {};
  for (const row of params.cases) {
    for (const [key, value] of Object.entries(row.forcedFallbackMismatches)) {
      forcedFallbackMismatches[key] = (forcedFallbackMismatches[key] ?? 0) + value;
    }
  }
  const baselineTokens = params.baseline.metrics.meanInjectedTokens;
  return {
    policyId: LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.candidate.policyId,
    arm: params.arm,
    cases: params.cases.length,
    directProxyCases: params.cases.filter((row) => row.directProxy).length,
    orderedProxyCases: params.cases.filter((row) => row.orderedQuestion).length,
    metrics,
    deltasVsBaseline: {
      answerAtomSupportRecall: metrics.answerAtomSupportRecall - params.baseline.metrics.answerAtomSupportRecall,
      anyAnswerAtomSupportedRate: metrics.anyAnswerAtomSupportedRate - params.baseline.metrics.anyAnswerAtomSupportedRate,
      allAnswerAtomsSupportedRate: metrics.allAnswerAtomsSupportedRate - params.baseline.metrics.allAnswerAtomsSupportedRate,
      orderedSequenceSupportedRate: metrics.orderedSequenceSupportedRate - params.baseline.metrics.orderedSequenceSupportedRate,
      meanInjectedTokens: metrics.meanInjectedTokens - baselineTokens,
      meanInjectedTokenFraction: baselineTokens === 0 ? 0 : (metrics.meanInjectedTokens - baselineTokens) / baselineTokens,
    },
    directProxyOutcomesVsBaseline: outcomes(params.cases),
    byDomain,
    answerAtomSupportRecallDeltaBootstrap: bootstrapDelta(params.cases, params.seed),
    certificateViolations: {
      anchorCoverage: params.cases.reduce((sum, row) => sum + row.anchorCoverageViolations, 0),
      unrelatedBasePreservation: params.cases.reduce((sum, row) => sum + row.unrelatedBasePreservationViolations, 0),
    },
    forcedFallbackMismatches,
  };
}

function compareArms(
  verified: LongMemEvalV2LocalSubstitutionCase[],
  agnostic: LongMemEvalV2LocalSubstitutionCase[],
): ArmComparison {
  const controls = new Map(agnostic.map((row) => [row.questionId, row]));
  let changedContexts = 0;
  const deltas: number[] = [];
  for (const row of verified) {
    const control = controls.get(row.questionId);
    if (!control) throw new Error(`missing D10 agnostic row ${row.questionId}`);
    if (row.contextSha256 !== control.contextSha256) changedContexts += 1;
    if (row.directProxy) deltas.push(row.answerAtomSupportRecall! - control.answerAtomSupportRecall!);
  }
  return {
    changedContexts,
    answerAtomSupportRecallDelta: mean(deltas),
    improvedDirectProxyCases: deltas.filter((value) => value > EPSILON).length,
    equalDirectProxyCases: deltas.filter((value) => Math.abs(value) <= EPSILON).length,
    harmedDirectProxyCases: deltas.filter((value) => value < -EPSILON).length,
  };
}

function evaluateGate(params: {
  phase: LongMemEvalV2LocalSubstitutionPhase;
  verified: LocalSubstitutionArmSummary;
  comparison: ArmComparison;
}): { passed: boolean; checks: Record<string, boolean> } {
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
  const gate = params.phase === "consumed_audit" ? protocol.consumedAuditGate : protocol.testGate;
  const checks = {
    answerAtomSupportRecallDeltaVsBaseline:
      params.verified.deltasVsBaseline.answerAtomSupportRecall + EPSILON >= gate.minAnswerAtomSupportRecallDeltaVsBaseline,
    answerAtomSupportRecallBootstrapLowerVsBaseline:
      (params.verified.answerAtomSupportRecallDeltaBootstrap?.lower ?? -Infinity) + EPSILON
        >= gate.minAnswerAtomSupportRecallBootstrapLowerVsBaseline,
    improvedDirectProxyCasesVsBaseline:
      params.verified.directProxyOutcomesVsBaseline.improved >= gate.minImprovedDirectProxyCasesVsBaseline,
    harmedDirectProxyCasesVsBaseline:
      params.verified.directProxyOutcomesVsBaseline.harmed <= gate.maxHarmedDirectProxyCasesVsBaseline,
    orderedSequenceSupportedRateDeltaVsBaseline:
      params.verified.deltasVsBaseline.orderedSequenceSupportedRate + EPSILON
        >= gate.minOrderedSequenceSupportedRateDeltaVsBaseline,
    changedContextsVsAgnostic:
      params.comparison.changedContexts >= gate.minChangedContextsVsAgnostic,
    answerAtomSupportRecallDeltaVsAgnostic:
      params.comparison.answerAtomSupportRecallDelta + EPSILON >= gate.minAnswerAtomSupportRecallDeltaVsAgnostic,
    harmedDirectProxyCasesVsAgnostic:
      params.comparison.harmedDirectProxyCases <= gate.maxHarmedDirectProxyCasesVsAgnostic,
    meanInjectedTokenIncreaseFraction:
      params.verified.deltasVsBaseline.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction + EPSILON,
    perQueryTokenViolations: params.verified.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    anchorCoverageViolations:
      params.verified.certificateViolations.anchorCoverage <= gate.maxAnchorCoverageViolations,
    unrelatedBasePreservationViolations:
      params.verified.certificateViolations.unrelatedBasePreservation
        <= gate.maxUnrelatedBasePreservationViolations,
    ordinaryFallbacks: params.verified.metrics.fallbacks <= gate.maxOrdinaryFallbacks,
    selectionLatencyP95Ms: params.verified.metrics.selectionLatencyP95Ms <= gate.maxP95SelectionLatencyMs,
    exactForcedFallbacks: !gate.requireExactForcedFallbacks
      || Object.values(params.verified.forcedFallbackMismatches).every((value) => value === 0),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function runLongMemEvalV2LocalSubstitution(params: {
  dataRoot: string;
  phase: LongMemEvalV2LocalSubstitutionPhase;
  baselineCasesPaths: string[];
  baselineSummaryPaths: string[];
  preScoreCommit: string;
  testReadAuthorization?: LocalSubstitutionTestReadAuthorization;
  authorizationSha256?: string;
}): Promise<{
  cases: LongMemEvalV2LocalSubstitutionCase[];
  summary: LongMemEvalV2LocalSubstitutionSummary;
}> {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.preScoreCommit)) {
    throw new Error("D10 pre-score commit must be a git SHA");
  }
  if (params.phase === "test") {
    assertLocalSubstitutionTestReadAuthorized(params.testReadAuthorization);
    if (!params.authorizationSha256 || !/^[0-9a-f]{64}$/iu.test(params.authorizationSha256)) {
      throw new Error("D10 test requires the admission artifact SHA-256");
    }
  }
  const baseline = await loadLockedBaseline({
    phase: params.phase,
    casesPaths: params.baselineCasesPaths,
    summaryPaths: params.baselineSummaryPaths,
    authorizationSha256: params.authorizationSha256,
  });
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
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
  assertFrozenSplit(questions);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const selectedQuestions = localSubstitutionQuestionIdsForPhase(params.phase).map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing D10 frozen question ${id}`);
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
  const index: LongMemEvalV2LocalSubstitutionSummary["index"] = {};
  const config = localConfig();
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
      const rawBuildLatencyMs = performance.now() - rawStartedAt;
      rawBackends.set(domain, new MemoryCoreGroupBackend(raw.units));
      const procedureStartedAt = performance.now();
      const procedures = buildLocalProcedureIndex({ trajectories: domainTrajectories, config });
      procedureBackends.set(domain, new MemoryCoreGroupBackend(procedures.indexUnits));
      for (const record of procedures.records) {
        if (procedureRecords.has(record.id)) throw new Error(`duplicate D10 procedure ${record.id}`);
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
    const orderedRecords = [...procedureRecords.values()].sort((left, right) => left.id.localeCompare(right.id));
    const events = buildLocalProgressEvents(orderedRecords);
    const feedbackTable = buildLocalProgressTable({
      events,
      capacity: protocol.localFeedback.maxEvents,
      knownActionCounts: new Map(orderedRecords.map((record) => [record.id, record.totalActions])),
    });
    if (!feedbackTable.available || feedbackTable.entries.size !== events.length) {
      throw new Error(`D10 public feedback table unavailable: ${feedbackTable.failureReason}`);
    }
    const cases: LongMemEvalV2LocalSubstitutionCase[] = [];
    for (const question of selectedQuestions) {
      const rawBackend = rawBackends.get(question.domain);
      const procedureBackend = procedureBackends.get(question.domain);
      if (!rawBackend || !procedureBackend) throw new Error(`missing D10 backend for ${question.domain}`);
      const locked = baseline.byQuestionId.get(question.id);
      if (!locked) throw new Error(`missing D10 locked baseline row ${question.id}`);
      const query = sanitizeLongTaskQuery(question.prompt);
      const rawSearch = await rawBackend.search(query, protocol.baseline.candidateLimit);
      const baseContext = packLongTaskContext({
        candidates: rawSearch.candidates,
        tokenBudget: protocol.baseline.injectionTokenBudget,
        resultLimit: protocol.baseline.resultLimit,
      });
      const baseSupport = scoreProcedureDirectSupport({ question, injected: baseContext.items });
      assertBaselineRecomputed({ locked, query, candidates: rawSearch.candidates, packed: baseContext, support: baseSupport });
      const procedureSearch = await procedureBackend.search(query, config.procedureCandidateLimit);
      const forced = forcedFallbackChecks({
        baseline: baseContext,
        procedureCandidates: procedureSearch.candidates,
        procedureRecords,
        feedbackTable,
        config,
        feedbackEvents: events,
      });
      for (const arm of ["step_agnostic", "locally_verified"] as const) {
        const selectionStartedAt = performance.now();
        const selected = selectLocalSubstitutionContext({
          baseline: baseContext,
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
          mode: "local_substitution",
          phase: params.phase,
          policyId: protocol.candidate.policyId,
          arm,
          questionId: question.id,
          domain: question.domain,
          environment: question.environment,
          evaluatorFamily: longMemEvalV2ProcedureEvaluatorFamily(question),
          directProxy: support !== null,
          orderedQuestion: support?.orderedQuestion ?? false,
          query,
          baseCandidateIds: rawSearch.candidates.map((item) => item.id),
          baseInjectedIds: baseContext.items.map((item) => item.id),
          baseInjectedTokens: baseContext.injectedTokens,
          baseAnswerAtomSupportRecall: baseSupport?.answerAtomSupportRecall ?? null,
          baseAllAnswerAtomsSupported: baseSupport?.allAnswerAtomsSupported ?? null,
          baseOrderedSequenceSupported: baseSupport?.orderedSequenceSupported ?? null,
          procedureCandidateIds: procedureSearch.candidates.map((item) => item.id),
          injectedIds: selected.items.map((item) => item.id),
          contextSha256: selected.contextSha256,
          procedureId: selected.procedureId,
          replacedRawIds: selected.replacedRawIds,
          rawIds: selected.rawIds,
          safeAnchors: selected.safeAnchors,
          injectedTokens: selected.injectedTokens,
          tokenViolation: selected.tokenViolation,
          rawQueryLatencyMs: rawSearch.latencyMs,
          procedureQueryLatencyMs: procedureSearch.latencyMs,
          selectionLatencyMs,
          queryLatencyMs: rawSearch.latencyMs + procedureSearch.latencyMs + selectionLatencyMs,
          usedSubstitution: selected.usedSubstitution,
          selectionMode: selected.mode,
          decisionReason: selected.decisionReason,
          fallback: selected.fallback,
          fallbackReason: selected.fallbackReason,
          verifiedActions: selected.verifiedActions,
          totalActions: selected.totalActions,
          feedbackWilsonLower: selected.feedbackWilsonLower,
          anchorCoverageViolations: selected.anchorCoverageViolations,
          unrelatedBasePreservationViolations: selected.unrelatedBasePreservationViolations,
          answerAtomCount: support?.answerAtoms.length ?? null,
          supportedAtomCount: support?.supportedAtomCount ?? null,
          answerAtomSupportRecall: support?.answerAtomSupportRecall ?? null,
          anyAnswerAtomSupported: support?.anyAnswerAtomSupported ?? null,
          allAnswerAtomsSupported: support?.allAnswerAtomsSupported ?? null,
          orderedSequenceSupported: support?.orderedSequenceSupported ?? null,
          answerAtomSupportRecallDelta: support && baseSupport
            ? support.answerAtomSupportRecall - baseSupport.answerAtomSupportRecall
            : null,
          forcedFallbackMismatches: arm === "locally_verified" ? forced
            : Object.fromEntries(Object.keys(forced).map((key) => [key, 0])),
        });
      }
    }
    cases.sort((left, right) => left.arm.localeCompare(right.arm)
      || left.questionId.localeCompare(right.questionId));
    const casesText = cases.map(canonicalJsonLine).join("");
    const armSummaries = (["step_agnostic", "locally_verified"] as const).map((arm, index) => summarizeArm({
      arm,
      cases: cases.filter((row) => row.arm === arm),
      baseline,
      seed: protocol.aggregation.bootstrapSeed + index,
    }));
    const verified = armSummaries.find((item) => item.arm === "locally_verified")!;
    const comparison = compareArms(
      cases.filter((row) => row.arm === "locally_verified"),
      cases.filter((row) => row.arm === "step_agnostic"),
    );
    const gate = evaluateGate({ phase: params.phase, verified, comparison });
    const status = params.phase === "consumed_audit"
      ? (gate.passed ? "consumed_audit_passed" : "consumed_audit_failed")
      : (gate.passed ? "test_passed" : "test_failed");
    return {
      cases,
      summary: {
        protocolVersion: protocol.protocolVersion,
        mode: "local_substitution",
        phase: params.phase,
        status,
        preScoreCommit: params.preScoreCommit,
        authorizationSha256: params.authorizationSha256 ?? null,
        baselineArtifacts: baseline.artifacts,
        index,
        feedback: {
          events: events.length,
          entries: feedbackTable.entries.size,
          capacity: feedbackTable.capacity,
          available: feedbackTable.available,
          failureReason: feedbackTable.failureReason,
          locallyVerifiedEvents: events.filter((event) => event.status === "verified_progress").length,
        },
        armSummaries,
        localFeedbackComparison: comparison,
        casesSha256: sha256(casesText),
        gate,
        testState: params.phase === "test" ? "read" : "unread",
      },
    };
  } finally {
    for (const backend of rawBackends.values()) backend.close();
    for (const backend of procedureBackends.values()) backend.close();
  }
}
