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
  summarizeLongMemEvalV2LocalSubstitutionResult,
  type LongMemEvalV2LocalSubstitutionCase,
  type LongMemEvalV2LocalSubstitutionSummary,
} from "./longmemeval-v2-local-substitution-runner.js";
import { LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL } from "./longmemeval-v2-local-substitution-protocol.js";
import {
  buildLocalProcedureIndex,
  buildLocalProgressEvents,
  buildLocalProgressTable,
  selectLocalSubstitutionContext,
  type LocalProcedureRecord,
  type LocalProgressTable,
  type LocalSubstitutionArm,
} from "./longmemeval-v2-local-substitution.js";
import {
  LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL,
  LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT,
  sourceEvidenceQuestionIdsForPhase,
  type LongMemEvalV2SourceEvidencePhase,
} from "./longmemeval-v2-source-evidence-protocol.js";
import {
  selectSourceEvidenceSubstitutionContext,
  type SourceEvidenceSubstitutionConfig,
} from "./longmemeval-v2-source-evidence-substitution.js";
import {
  assertSourceEvidenceTestReadAuthorized,
  type SourceEvidenceTestReadAuthorization,
} from "./longmemeval-v2-source-evidence-test-lock.js";
import { scoreProcedureDirectSupport } from "./longmemeval-v2-procedure.js";
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

interface Outcomes {
  improved: number;
  equal: number;
  harmed: number;
}

interface ArmComparison extends Outcomes {
  changedContexts: number;
  answerAtomSupportRecallDelta: number;
  meanInjectedTokenDelta: number;
}

export interface LongMemEvalV2SourceEvidenceCase {
  protocolVersion: string;
  mode: "source_evidence_substitution";
  phase: LongMemEvalV2SourceEvidencePhase;
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
  d10ContextSha256: string;
  d10InjectedIds: string[];
  d10InjectedTokens: number;
  d10UsedSubstitution: boolean;
  d10DecisionReason: string;
  d10AnswerAtomSupportRecall: number | null;
  injectedIds: string[];
  contextSha256: string;
  procedureId: string | null;
  replacedRawIds: string[];
  rawIds: string[];
  safeAnchors: string[];
  sourceEvidenceAdapterId: string;
  sourceEvidenceSpans: Array<{
    sourceMemoryId: string;
    sourceOrdinal: number;
    sourceLine: number;
    kind: string;
    text: string;
    normalized: string;
  }>;
  sourceEvidenceCharacters: number;
  injectedTokens: number;
  tokenViolation: boolean;
  rawQueryLatencyMs: number;
  procedureQueryLatencyMs: number;
  selectionLatencyMs: number;
  queryLatencyMs: number;
  usedSubstitution: boolean;
  selectionMode: "source_evidence_substitution" | "baseline_noop" | "fallback_baseline";
  decisionReason: string;
  fallback: boolean;
  fallbackReason: string | null;
  verifiedActions: number;
  deliveredActions: number;
  totalActions: number;
  feedbackWilsonLower: number;
  anchorCoverageViolations: number;
  evidenceCoverageViolations: number;
  evidenceOrderViolations: number;
  provenanceCoverageViolations: number;
  actionCoverageViolations: number;
  unrelatedBasePreservationViolations: number;
  answerAtomCount: number | null;
  supportedAtomCount: number | null;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  orderedSequenceSupported: number | null;
  answerAtomSupportRecallDeltaVsBaseline: number | null;
  answerAtomSupportRecallDeltaVsD10: number | null;
  forcedFallbackMismatches: Record<string, number>;
}

export interface SourceEvidenceArmSummary {
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
    meanSourceEvidenceSpans: number;
    meanSourceEvidenceCharacters: number;
    meanVerifiedActions: number;
    meanDeliveredActions: number;
  };
  deltasVsBaseline: {
    answerAtomSupportRecall: number;
    anyAnswerAtomSupportedRate: number;
    allAnswerAtomsSupportedRate: number;
    orderedSequenceSupportedRate: number;
    meanInjectedTokens: number;
    meanInjectedTokenFraction: number;
  };
  directProxyOutcomesVsBaseline: Outcomes;
  comparisonVsD10: Outcomes & {
    changedContexts: number;
    answerAtomSupportRecallDelta: number;
    meanInjectedTokenDelta: number;
  };
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
    evidenceCoverage: number;
    evidenceOrder: number;
    provenanceCoverage: number;
    actionCoverage: number;
    unrelatedBasePreservation: number;
  };
  decisionReasons: Record<string, number>;
  forcedFallbackMismatches: Record<string, number>;
}

export interface LongMemEvalV2SourceEvidenceSummary {
  protocolVersion: string;
  mode: "source_evidence_substitution";
  phase: LongMemEvalV2SourceEvidencePhase;
  status: "consumed_audit_passed" | "consumed_audit_failed" | "test_passed" | "test_failed";
  preScoreCommit: string;
  authorizationSha256: string | null;
  baselineArtifacts: Array<{ casesSha256: string; summarySha256: string }>;
  d10ComparatorArtifacts: { casesSha256: string; summarySha256: string } | null;
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
  armSummaries: SourceEvidenceArmSummary[];
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

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return exactIds(left, right);
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

function expectedBaselineHashes(phase: LongMemEvalV2SourceEvidencePhase): Array<{
  cases: string;
  summary: string;
  sourcePhase: string;
  sourceProtocol: string;
}> | null {
  if (phase === "test") return null;
  const locked = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.lockedConsumedBaselines;
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
  phase: LongMemEvalV2SourceEvidencePhase;
  casesPaths: string[];
  summaryPaths: string[];
  authorizationSha256?: string;
}): Promise<LockedBaseline> {
  if (params.casesPaths.length !== params.summaryPaths.length || params.casesPaths.length === 0) {
    throw new Error("D11 baseline artifact path count mismatch");
  }
  const expected = expectedBaselineHashes(params.phase);
  if (expected && expected.length !== params.casesPaths.length) {
    throw new Error("D11 consumed audit requires the two frozen D9 baseline phases");
  }
  if (!expected && params.casesPaths.length !== 1) throw new Error("D11 test requires one authorized Base artifact");
  const cases: LockedBaselineCase[] = [];
  const artifacts: Array<{ casesSha256: string; summarySha256: string }> = [];
  for (let index = 0; index < params.casesPaths.length; index += 1) {
    const [casesText, summaryText] = await Promise.all([
      readFile(params.casesPaths[index], "utf8"),
      readFile(params.summaryPaths[index], "utf8"),
    ]);
    const casesSha256 = sha256(casesText);
    const summarySha256 = sha256(summaryText);
    const expectedItem = expected?.[index];
    const summary = JSON.parse(summaryText) as {
      protocolVersion: string;
      phase: string;
      authorizationSha256?: string;
      casesSha256: string;
    };
    const rows = casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LockedBaselineCase);
    if (summary.casesSha256 !== casesSha256
      || (expectedItem && (casesSha256 !== expectedItem.cases
        || summarySha256 !== expectedItem.summary
        || summary.phase !== expectedItem.sourcePhase
        || summary.protocolVersion !== expectedItem.sourceProtocol))
      || (!expectedItem && (summary.phase !== "test"
        || summary.protocolVersion !== LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.protocolVersion
        || summary.authorizationSha256 !== params.authorizationSha256))) {
      throw new Error(`D11 locked baseline identity mismatch at artifact ${index}`);
    }
    cases.push(...rows);
    artifacts.push({ casesSha256, summarySha256 });
  }
  const ids = new Set(cases.map((row) => row.questionId));
  const expectedIds = sourceEvidenceQuestionIdsForPhase(params.phase);
  if (ids.size !== cases.length || !exactIds([...ids].sort(), [...expectedIds].sort())) {
    throw new Error("D11 locked baseline question coverage mismatch");
  }
  return {
    cases,
    byQuestionId: new Map(cases.map((row) => [row.questionId, row])),
    metrics: aggregateProcedureCases(cases),
    artifacts,
  };
}

async function loadLockedD10Comparator(params: {
  phase: LongMemEvalV2SourceEvidencePhase;
  casesPath?: string;
  summaryPath?: string;
}): Promise<{
  byKey: Map<string, LongMemEvalV2LocalSubstitutionCase>;
  artifacts: { casesSha256: string; summarySha256: string } | null;
}> {
  if (params.phase === "test") return { byKey: new Map(), artifacts: null };
  if (!params.casesPath || !params.summaryPath) throw new Error("D11 consumed audit requires D10 comparator artifacts");
  const [casesText, summaryText] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
  ]);
  const casesSha256 = sha256(casesText);
  const summarySha256 = sha256(summaryText);
  const locked = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.lockedD10Comparator;
  if (casesSha256 !== locked.casesSha256 || summarySha256 !== locked.summarySha256) {
    throw new Error("D11 D10-comparator artifact hash mismatch");
  }
  const summary = JSON.parse(summaryText) as { protocolVersion: string; phase: string; casesSha256: string };
  if (summary.protocolVersion !== locked.protocolVersion || summary.phase !== "consumed_audit"
    || summary.casesSha256 !== casesSha256) throw new Error("D11 D10-comparator summary identity mismatch");
  const rows = casesText.split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as LongMemEvalV2LocalSubstitutionCase);
  const byKey = new Map(rows.map((row) => [`${row.arm}:${row.questionId}`, row]));
  if (byKey.size !== sourceEvidenceQuestionIdsForPhase("consumed_audit").length * 2) {
    throw new Error("D11 D10-comparator coverage mismatch");
  }
  return { byKey, artifacts: { casesSha256, summarySha256 } };
}

function assertFrozenSplit(questions: LongTaskQuestion[]): void {
  const protocol = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL;
  const generated = buildLongMemEvalV2ProcedureQuestionSplit({
    questions,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    questionsSha256: protocol.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.seed,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT)) {
    throw new Error("D11 generated procedure split differs from the frozen split");
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
    throw new Error(`D11 recomputed baseline differs for ${params.locked.questionId}`);
  }
}

function assertD10Recomputed(params: {
  locked: LongMemEvalV2LocalSubstitutionCase | undefined;
  questionId: string;
  arm: LocalSubstitutionArm;
  query: string;
  baseCandidates: RetrievedUnit[];
  base: PackedLongTaskContext;
  baseSupport: ReturnType<typeof scoreProcedureDirectSupport>;
  procedureCandidates: RetrievedUnit[];
  selected: ReturnType<typeof selectLocalSubstitutionContext>;
  support: ReturnType<typeof scoreProcedureDirectSupport>;
}): void {
  if (!params.locked) return;
  const locked = params.locked;
  if (locked.questionId !== params.questionId || locked.arm !== params.arm || locked.query !== params.query
    || !exactIds(locked.baseCandidateIds, params.baseCandidates.map((item) => item.id))
    || !exactIds(locked.baseInjectedIds, params.base.items.map((item) => item.id))
    || locked.baseInjectedTokens !== params.base.injectedTokens
    || locked.baseAnswerAtomSupportRecall !== (params.baseSupport?.answerAtomSupportRecall ?? null)
    || !exactIds(locked.procedureCandidateIds, params.procedureCandidates.map((item) => item.id))
    || !exactIds(locked.injectedIds, params.selected.items.map((item) => item.id))
    || locked.contextSha256 !== params.selected.contextSha256
    || locked.procedureId !== params.selected.procedureId
    || !exactIds(locked.replacedRawIds, params.selected.replacedRawIds)
    || !exactIds(locked.rawIds, params.selected.rawIds)
    || !exactStrings(locked.safeAnchors, params.selected.safeAnchors)
    || locked.injectedTokens !== params.selected.injectedTokens
    || locked.usedSubstitution !== params.selected.usedSubstitution
    || locked.selectionMode !== params.selected.mode
    || locked.decisionReason !== params.selected.decisionReason
    || locked.fallback !== params.selected.fallback
    || locked.fallbackReason !== params.selected.fallbackReason
    || locked.verifiedActions !== params.selected.verifiedActions
    || locked.totalActions !== params.selected.totalActions
    || Math.abs(locked.feedbackWilsonLower - params.selected.feedbackWilsonLower) > EPSILON
    || locked.anchorCoverageViolations !== params.selected.anchorCoverageViolations
    || locked.unrelatedBasePreservationViolations !== params.selected.unrelatedBasePreservationViolations
    || locked.answerAtomSupportRecall !== (params.support?.answerAtomSupportRecall ?? null)) {
    throw new Error(`D11 recomputed D10 comparator differs for ${params.arm}:${params.questionId}`);
  }
}

function config(): SourceEvidenceSubstitutionConfig {
  const candidate = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.candidate;
  return {
    maxProcedureUnits: candidate.maxProcedureUnits,
    maxActionsPerProcedure: candidate.maxActionsPerProcedure,
    maxSafeAnchors: candidate.maxSafeAnchors,
    maxCapsuleCharacters: candidate.maxCapsuleCharacters,
    procedureCandidateLimit: candidate.procedureCandidateLimit,
    sourceEvidence: {
      maxSpans: candidate.maxEvidenceSpans,
      maxSpanCharacters: candidate.maxEvidenceSpanCharacters,
      maxEvidenceCharacters: candidate.maxEvidenceCharacters,
    },
  };
}

function forcedFallbackChecks(params: {
  baseline: PackedLongTaskContext;
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, LocalProcedureRecord>;
  feedbackTable: LocalProgressTable;
  config: SourceEvidenceSubstitutionConfig;
  feedbackEvents: ReturnType<typeof buildLocalProgressEvents>;
}): Record<string, number> {
  const common = { ...params, arm: "locally_verified" as const };
  const overflow = buildLocalProgressTable({ events: params.feedbackEvents.slice(0, 2), capacity: 1 });
  const checks = {
    disabled: selectSourceEvidenceSubstitutionContext({ ...common, enabled: false }),
    missingProcedureIndex: selectSourceEvidenceSubstitutionContext({ ...common, procedureIndexAvailable: false }),
    missingFeedbackTable: selectSourceEvidenceSubstitutionContext({ ...common, feedbackTable: undefined }),
    feedbackTableOverflow: selectSourceEvidenceSubstitutionContext({ ...common, feedbackTable: overflow }),
    timeout: selectSourceEvidenceSubstitutionContext({ ...common, timedOut: true }),
    corrupt: selectSourceEvidenceSubstitutionContext({ ...common, forceCorrupt: true }),
    budgetOverflow: selectSourceEvidenceSubstitutionContext({ ...common, forceBudgetOverflow: true }),
    anchorCertificate: selectSourceEvidenceSubstitutionContext({ ...common, forceAnchorFailure: true }),
    evidenceCertificate: selectSourceEvidenceSubstitutionContext({ ...common, forceEvidenceFailure: true }),
    evidenceCorrupt: selectSourceEvidenceSubstitutionContext({ ...common, forceEvidenceCorrupt: true }),
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

function bootstrapDelta(cases: LongMemEvalV2SourceEvidenceCase[], seed: number): SourceEvidenceArmSummary["answerAtomSupportRecallDeltaBootstrap"] {
  const direct = cases.filter((row) => row.directProxy);
  if (direct.length === 0) return null;
  const groups = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(seed);
  const estimates: number[] = [];
  for (let sample = 0; sample < LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const drawn = groups.flatMap((group) => Array.from({ length: group.length }, () => {
      const row = group[Math.floor(random() * group.length)];
      return row.answerAtomSupportRecallDeltaVsBaseline!;
    }));
    estimates.push(mean(drawn));
  }
  return {
    mean: mean(direct.map((row) => row.answerAtomSupportRecallDeltaVsBaseline!)),
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
    questions: direct.length,
    strata: groups.length,
  };
}

function outcomeValues(values: number[]): Outcomes {
  return {
    improved: values.filter((value) => value > EPSILON).length,
    equal: values.filter((value) => Math.abs(value) <= EPSILON).length,
    harmed: values.filter((value) => value < -EPSILON).length,
  };
}

function summarizeArm(params: {
  arm: LocalSubstitutionArm;
  cases: LongMemEvalV2SourceEvidenceCase[];
  baseline: LockedBaseline;
  seed: number;
}): SourceEvidenceArmSummary {
  const base = aggregateProcedureCases(params.cases);
  const metrics = {
    ...base,
    substitutionUseRate: mean(params.cases.map((row) => row.usedSubstitution ? 1 : 0)),
    selectionLatencyP50Ms: percentile(params.cases.map((row) => row.selectionLatencyMs), 0.5),
    selectionLatencyP95Ms: percentile(params.cases.map((row) => row.selectionLatencyMs), 0.95),
    meanSafeAnchors: mean(params.cases.map((row) => row.safeAnchors.length)),
    meanSourceEvidenceSpans: mean(params.cases.map((row) => row.sourceEvidenceSpans.length)),
    meanSourceEvidenceCharacters: mean(params.cases.map((row) => row.sourceEvidenceCharacters)),
    meanVerifiedActions: mean(params.cases.map((row) => row.verifiedActions)),
    meanDeliveredActions: mean(params.cases.map((row) => row.deliveredActions)),
  };
  const baselineDeltas = params.cases.filter((row) => row.directProxy)
    .map((row) => row.answerAtomSupportRecallDeltaVsBaseline!);
  const d10Deltas = params.cases.filter((row) => row.directProxy)
    .map((row) => row.answerAtomSupportRecallDeltaVsD10!);
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
  const decisionReasons: Record<string, number> = {};
  for (const row of params.cases) decisionReasons[row.decisionReason] = (decisionReasons[row.decisionReason] ?? 0) + 1;
  const baselineTokens = params.baseline.metrics.meanInjectedTokens;
  return {
    policyId: LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.candidate.policyId,
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
    directProxyOutcomesVsBaseline: outcomeValues(baselineDeltas),
    comparisonVsD10: {
      changedContexts: params.cases.filter((row) => row.contextSha256 !== row.d10ContextSha256).length,
      answerAtomSupportRecallDelta: mean(d10Deltas),
      meanInjectedTokenDelta: metrics.meanInjectedTokens - mean(params.cases.map((row) => row.d10InjectedTokens)),
      ...outcomeValues(d10Deltas),
    },
    byDomain,
    answerAtomSupportRecallDeltaBootstrap: bootstrapDelta(params.cases, params.seed),
    certificateViolations: {
      anchorCoverage: params.cases.reduce((sum, row) => sum + row.anchorCoverageViolations, 0),
      evidenceCoverage: params.cases.reduce((sum, row) => sum + row.evidenceCoverageViolations, 0),
      evidenceOrder: params.cases.reduce((sum, row) => sum + row.evidenceOrderViolations, 0),
      provenanceCoverage: params.cases.reduce((sum, row) => sum + row.provenanceCoverageViolations, 0),
      actionCoverage: params.cases.reduce((sum, row) => sum + row.actionCoverageViolations, 0),
      unrelatedBasePreservation: params.cases.reduce((sum, row) => sum + row.unrelatedBasePreservationViolations, 0),
    },
    decisionReasons,
    forcedFallbackMismatches,
  };
}

function compareArms(
  verified: LongMemEvalV2SourceEvidenceCase[],
  agnostic: LongMemEvalV2SourceEvidenceCase[],
): ArmComparison {
  const controls = new Map(agnostic.map((row) => [row.questionId, row]));
  let changedContexts = 0;
  const qualityDeltas: number[] = [];
  const tokenDeltas: number[] = [];
  for (const row of verified) {
    const control = controls.get(row.questionId);
    if (!control) throw new Error(`missing D11 agnostic row ${row.questionId}`);
    if (row.contextSha256 !== control.contextSha256) changedContexts += 1;
    tokenDeltas.push(row.injectedTokens - control.injectedTokens);
    if (row.directProxy) qualityDeltas.push(row.answerAtomSupportRecall! - control.answerAtomSupportRecall!);
  }
  return {
    changedContexts,
    answerAtomSupportRecallDelta: mean(qualityDeltas),
    meanInjectedTokenDelta: mean(tokenDeltas),
    ...outcomeValues(qualityDeltas),
  };
}

function evaluateGate(params: {
  phase: LongMemEvalV2SourceEvidencePhase;
  verified: SourceEvidenceArmSummary;
  comparison: ArmComparison;
}): { passed: boolean; checks: Record<string, boolean> } {
  const protocol = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL;
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
    answerAtomSupportRecallDeltaVsD10:
      params.verified.comparisonVsD10.answerAtomSupportRecallDelta + EPSILON >= gate.minAnswerAtomSupportRecallDeltaVsD10,
    improvedDirectProxyCasesVsD10:
      params.verified.comparisonVsD10.improved >= gate.minImprovedDirectProxyCasesVsD10,
    harmedDirectProxyCasesVsD10:
      params.verified.comparisonVsD10.harmed <= gate.maxHarmedDirectProxyCasesVsD10,
    changedContextsVsAgnostic: params.comparison.changedContexts >= gate.minChangedContextsVsAgnostic,
    answerAtomSupportRecallDeltaVsAgnostic:
      params.comparison.answerAtomSupportRecallDelta + EPSILON >= gate.minAnswerAtomSupportRecallDeltaVsAgnostic,
    harmedDirectProxyCasesVsAgnostic: params.comparison.harmed <= gate.maxHarmedDirectProxyCasesVsAgnostic,
    meanInjectedTokenDeltaVsAgnostic:
      params.comparison.meanInjectedTokenDelta <= gate.maxMeanInjectedTokenDeltaVsAgnostic + EPSILON,
    meanInjectedTokenIncreaseFraction:
      params.verified.deltasVsBaseline.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction + EPSILON,
    perQueryTokenViolations: params.verified.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    anchorCoverageViolations:
      params.verified.certificateViolations.anchorCoverage <= gate.maxAnchorCoverageViolations,
    evidenceCoverageViolations:
      params.verified.certificateViolations.evidenceCoverage <= gate.maxEvidenceCoverageViolations,
    evidenceOrderViolations:
      params.verified.certificateViolations.evidenceOrder <= gate.maxEvidenceOrderViolations,
    provenanceCoverageViolations:
      params.verified.certificateViolations.provenanceCoverage <= gate.maxProvenanceCoverageViolations,
    actionCoverageViolations:
      params.verified.certificateViolations.actionCoverage <= gate.maxActionCoverageViolations,
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

export async function runLongMemEvalV2SourceEvidence(params: {
  dataRoot: string;
  phase: LongMemEvalV2SourceEvidencePhase;
  baselineCasesPaths: string[];
  baselineSummaryPaths: string[];
  d10CasesPath?: string;
  d10SummaryPath?: string;
  preScoreCommit: string;
  testReadAuthorization?: SourceEvidenceTestReadAuthorization;
  authorizationSha256?: string;
}): Promise<{
  cases: LongMemEvalV2SourceEvidenceCase[];
  summary: LongMemEvalV2SourceEvidenceSummary;
  d10Comparator: {
    cases: LongMemEvalV2LocalSubstitutionCase[];
    summary: LongMemEvalV2LocalSubstitutionSummary;
  } | null;
}> {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.preScoreCommit)) throw new Error("D11 pre-score commit must be a git SHA");
  if (params.phase === "test") {
    assertSourceEvidenceTestReadAuthorized(params.testReadAuthorization);
    if (!params.authorizationSha256 || !/^[0-9a-f]{64}$/iu.test(params.authorizationSha256)) {
      throw new Error("D11 test requires the admission artifact SHA-256");
    }
  }
  const baseline = await loadLockedBaseline({
    phase: params.phase,
    casesPaths: params.baselineCasesPaths,
    summaryPaths: params.baselineSummaryPaths,
    authorizationSha256: params.authorizationSha256,
  });
  const d10Locked = await loadLockedD10Comparator({
    phase: params.phase,
    casesPath: params.d10CasesPath,
    summaryPath: params.d10SummaryPath,
  });
  const protocol = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL;
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
  const selectedQuestions = sourceEvidenceQuestionIdsForPhase(params.phase).map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing D11 frozen question ${id}`);
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
  const index: LongMemEvalV2SourceEvidenceSummary["index"] = {};
  const activeConfig = config();
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
      const procedures = buildLocalProcedureIndex({ trajectories: domainTrajectories, config: activeConfig });
      procedureBackends.set(domain, new MemoryCoreGroupBackend(procedures.indexUnits));
      for (const record of procedures.records) {
        if (procedureRecords.has(record.id)) throw new Error(`duplicate D11 procedure ${record.id}`);
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
      throw new Error(`D11 public feedback table unavailable: ${feedbackTable.failureReason}`);
    }
    const cases: LongMemEvalV2SourceEvidenceCase[] = [];
    const d10ComparatorCases: LongMemEvalV2LocalSubstitutionCase[] = [];
    for (const question of selectedQuestions) {
      const rawBackend = rawBackends.get(question.domain);
      const procedureBackend = procedureBackends.get(question.domain);
      if (!rawBackend || !procedureBackend) throw new Error(`missing D11 backend for ${question.domain}`);
      const locked = baseline.byQuestionId.get(question.id);
      if (!locked) throw new Error(`missing D11 locked baseline row ${question.id}`);
      const query = sanitizeLongTaskQuery(question.prompt);
      const rawSearch = await rawBackend.search(query, protocol.baseline.candidateLimit);
      const baseContext = packLongTaskContext({
        candidates: rawSearch.candidates,
        tokenBudget: protocol.baseline.injectionTokenBudget,
        resultLimit: protocol.baseline.resultLimit,
      });
      const baseSupport = scoreProcedureDirectSupport({ question, injected: baseContext.items });
      assertBaselineRecomputed({ locked, query, candidates: rawSearch.candidates, packed: baseContext, support: baseSupport });
      const procedureSearch = await procedureBackend.search(query, activeConfig.procedureCandidateLimit);
      const forced = forcedFallbackChecks({
        baseline: baseContext,
        procedureCandidates: procedureSearch.candidates,
        procedureRecords,
        feedbackTable,
        config: activeConfig,
        feedbackEvents: events,
      });
      const d10Forced = params.phase === "test" ? Object.fromEntries([
        "disabled",
        "missingProcedureIndex",
        "missingFeedbackTable",
        "feedbackTableOverflow",
        "timeout",
        "corrupt",
        "budgetOverflow",
        "anchorCertificate",
      ].map((key) => [key, forced[key] ?? 1])) : null;
      for (const arm of ["step_agnostic", "locally_verified"] as const) {
        const d10SelectionStartedAt = performance.now();
        const d10Selected = selectLocalSubstitutionContext({
          baseline: baseContext,
          procedureCandidates: procedureSearch.candidates,
          procedureRecords,
          feedbackTable,
          config: activeConfig,
          arm,
        });
        const d10SelectionLatencyMs = performance.now() - d10SelectionStartedAt;
        const d10Support = scoreProcedureDirectSupport({ question, injected: d10Selected.items });
        assertD10Recomputed({
          locked: d10Locked.byKey.get(`${arm}:${question.id}`),
          questionId: question.id,
          arm,
          query,
          baseCandidates: rawSearch.candidates,
          base: baseContext,
          baseSupport,
          procedureCandidates: procedureSearch.candidates,
          selected: d10Selected,
          support: d10Support,
        });
        if (params.phase === "test") {
          const d10Fallbacks = arm === "locally_verified" ? d10Forced!
            : Object.fromEntries(Object.keys(d10Forced!).map((key) => [key, 0]));
          d10ComparatorCases.push({
            protocolVersion: LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.protocolVersion,
            mode: "local_substitution",
            phase: "test",
            policyId: LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.candidate.policyId,
            arm,
            questionId: question.id,
            domain: question.domain,
            environment: question.environment,
            evaluatorFamily: longMemEvalV2ProcedureEvaluatorFamily(question),
            directProxy: d10Support !== null,
            orderedQuestion: d10Support?.orderedQuestion ?? false,
            query,
            baseCandidateIds: rawSearch.candidates.map((item) => item.id),
            baseInjectedIds: baseContext.items.map((item) => item.id),
            baseInjectedTokens: baseContext.injectedTokens,
            baseAnswerAtomSupportRecall: baseSupport?.answerAtomSupportRecall ?? null,
            baseAllAnswerAtomsSupported: baseSupport?.allAnswerAtomsSupported ?? null,
            baseOrderedSequenceSupported: baseSupport?.orderedSequenceSupported ?? null,
            procedureCandidateIds: procedureSearch.candidates.map((item) => item.id),
            injectedIds: d10Selected.items.map((item) => item.id),
            contextSha256: d10Selected.contextSha256,
            procedureId: d10Selected.procedureId,
            replacedRawIds: d10Selected.replacedRawIds,
            rawIds: d10Selected.rawIds,
            safeAnchors: d10Selected.safeAnchors,
            injectedTokens: d10Selected.injectedTokens,
            tokenViolation: d10Selected.tokenViolation,
            rawQueryLatencyMs: rawSearch.latencyMs,
            procedureQueryLatencyMs: procedureSearch.latencyMs,
            selectionLatencyMs: d10SelectionLatencyMs,
            queryLatencyMs: rawSearch.latencyMs + procedureSearch.latencyMs + d10SelectionLatencyMs,
            usedSubstitution: d10Selected.usedSubstitution,
            selectionMode: d10Selected.mode,
            decisionReason: d10Selected.decisionReason,
            fallback: d10Selected.fallback,
            fallbackReason: d10Selected.fallbackReason,
            verifiedActions: d10Selected.verifiedActions,
            totalActions: d10Selected.totalActions,
            feedbackWilsonLower: d10Selected.feedbackWilsonLower,
            anchorCoverageViolations: d10Selected.anchorCoverageViolations,
            unrelatedBasePreservationViolations: d10Selected.unrelatedBasePreservationViolations,
            answerAtomCount: d10Support?.answerAtoms.length ?? null,
            supportedAtomCount: d10Support?.supportedAtomCount ?? null,
            answerAtomSupportRecall: d10Support?.answerAtomSupportRecall ?? null,
            anyAnswerAtomSupported: d10Support?.anyAnswerAtomSupported ?? null,
            allAnswerAtomsSupported: d10Support?.allAnswerAtomsSupported ?? null,
            orderedSequenceSupported: d10Support?.orderedSequenceSupported ?? null,
            answerAtomSupportRecallDelta: d10Support && baseSupport
              ? d10Support.answerAtomSupportRecall - baseSupport.answerAtomSupportRecall : null,
            forcedFallbackMismatches: d10Fallbacks,
          });
        }
        const selectionStartedAt = performance.now();
        const selected = selectSourceEvidenceSubstitutionContext({
          baseline: baseContext,
          procedureCandidates: procedureSearch.candidates,
          procedureRecords,
          feedbackTable,
          config: activeConfig,
          arm,
        });
        const selectionLatencyMs = performance.now() - selectionStartedAt;
        const support = scoreProcedureDirectSupport({ question, injected: selected.items });
        cases.push({
          protocolVersion: protocol.protocolVersion,
          mode: "source_evidence_substitution",
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
          d10ContextSha256: d10Selected.contextSha256,
          d10InjectedIds: d10Selected.items.map((item) => item.id),
          d10InjectedTokens: d10Selected.injectedTokens,
          d10UsedSubstitution: d10Selected.usedSubstitution,
          d10DecisionReason: d10Selected.decisionReason,
          d10AnswerAtomSupportRecall: d10Support?.answerAtomSupportRecall ?? null,
          injectedIds: selected.items.map((item) => item.id),
          contextSha256: selected.contextSha256,
          procedureId: selected.procedureId,
          replacedRawIds: selected.replacedRawIds,
          rawIds: selected.rawIds,
          safeAnchors: selected.safeAnchors,
          sourceEvidenceAdapterId: selected.sourceEvidenceAdapterId,
          sourceEvidenceSpans: selected.sourceEvidenceSpans,
          sourceEvidenceCharacters: selected.sourceEvidenceCharacters,
          injectedTokens: selected.injectedTokens,
          tokenViolation: selected.tokenViolation || selected.injectedTokens > baseContext.injectedTokens,
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
          deliveredActions: selected.deliveredActions,
          totalActions: selected.totalActions,
          feedbackWilsonLower: selected.feedbackWilsonLower,
          anchorCoverageViolations: selected.anchorCoverageViolations,
          evidenceCoverageViolations: selected.evidenceCoverageViolations,
          evidenceOrderViolations: selected.evidenceOrderViolations,
          provenanceCoverageViolations: selected.provenanceCoverageViolations,
          actionCoverageViolations: selected.actionCoverageViolations,
          unrelatedBasePreservationViolations: selected.unrelatedBasePreservationViolations,
          answerAtomCount: support?.answerAtoms.length ?? null,
          supportedAtomCount: support?.supportedAtomCount ?? null,
          answerAtomSupportRecall: support?.answerAtomSupportRecall ?? null,
          anyAnswerAtomSupported: support?.anyAnswerAtomSupported ?? null,
          allAnswerAtomsSupported: support?.allAnswerAtomsSupported ?? null,
          orderedSequenceSupported: support?.orderedSequenceSupported ?? null,
          answerAtomSupportRecallDeltaVsBaseline: support
            ? support.answerAtomSupportRecall - baseSupport!.answerAtomSupportRecall : null,
          answerAtomSupportRecallDeltaVsD10: support
            ? support.answerAtomSupportRecall - d10Support!.answerAtomSupportRecall : null,
          forcedFallbackMismatches: forced,
        });
      }
    }
    cases.sort((left, right) => left.questionId.localeCompare(right.questionId) || left.arm.localeCompare(right.arm));
    const agnosticCases = cases.filter((row) => row.arm === "step_agnostic");
    const verifiedCases = cases.filter((row) => row.arm === "locally_verified");
    const armSummaries = [
      summarizeArm({
        arm: "step_agnostic",
        cases: agnosticCases,
        baseline,
        seed: protocol.aggregation.bootstrapSeed + 1,
      }),
      summarizeArm({
        arm: "locally_verified",
        cases: verifiedCases,
        baseline,
        seed: protocol.aggregation.bootstrapSeed,
      }),
    ];
    const localFeedbackComparison = compareArms(verifiedCases, agnosticCases);
    const verifiedSummary = armSummaries.find((value) => value.arm === "locally_verified")!;
    const gate = evaluateGate({ phase: params.phase, verified: verifiedSummary, comparison: localFeedbackComparison });
    const casesText = cases.map(canonicalJsonLine).join("");
    d10ComparatorCases.sort((left, right) => left.arm.localeCompare(right.arm)
      || left.questionId.localeCompare(right.questionId));
    const feedback = {
      events: events.length,
      entries: feedbackTable.entries.size,
      capacity: feedbackTable.capacity,
      available: feedbackTable.available,
      failureReason: feedbackTable.failureReason,
      locallyVerifiedEvents: events.filter((event) => event.status === "verified_progress").length,
    };
    const d10Comparator = params.phase === "test" ? {
      cases: d10ComparatorCases,
      summary: summarizeLongMemEvalV2LocalSubstitutionResult({
        cases: d10ComparatorCases,
        phase: "test",
        preScoreCommit: params.preScoreCommit,
        authorizationSha256: params.authorizationSha256 ?? null,
        baselineMetrics: baseline.metrics,
        baselineArtifacts: baseline.artifacts,
        index,
        feedback,
      }),
    } : null;
    const d10ComparatorArtifacts = d10Comparator ? {
      casesSha256: sha256(d10Comparator.cases.map(canonicalJsonLine).join("")),
      summarySha256: sha256(`${JSON.stringify(d10Comparator.summary, null, 2)}\n`),
    } : d10Locked.artifacts;
    return {
      cases,
      d10Comparator,
      summary: {
        protocolVersion: protocol.protocolVersion,
        mode: "source_evidence_substitution",
        phase: params.phase,
        status: params.phase === "consumed_audit"
          ? gate.passed ? "consumed_audit_passed" : "consumed_audit_failed"
          : gate.passed ? "test_passed" : "test_failed",
        preScoreCommit: params.preScoreCommit,
        authorizationSha256: params.authorizationSha256 ?? null,
        baselineArtifacts: baseline.artifacts,
        d10ComparatorArtifacts,
        index,
        feedback,
        armSummaries,
        localFeedbackComparison,
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
