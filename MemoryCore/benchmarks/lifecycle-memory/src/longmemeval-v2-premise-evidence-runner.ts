import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import controlSourceJson from "../protocol.longmemeval-v2-residual-patch-split.v1.json" with { type: "json" };
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  assertPremiseEvidencePhaseReadAuthorized,
  type LongMemEvalV2PremiseEvidenceBaselineCase,
  type LongMemEvalV2PremiseEvidenceBaselineSummary,
  type PremiseEvidenceReadAdmission,
} from "./longmemeval-v2-premise-evidence-baseline-runner.js";
import {
  premiseEvidenceContextSha256,
  selectPremiseEvidenceContext,
  type PremiseEvidenceContextPolicy,
  type PremiseEvidenceContextResult,
} from "./longmemeval-v2-premise-evidence-context.js";
import { premiseEvidenceReferenceConclusionAgreement } from "./longmemeval-v2-premise-evidence-design.js";
import {
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT,
  premiseEvidenceQuestionIdsForPhase,
  type LongMemEvalV2PremiseEvidenceLabel,
  type LongMemEvalV2PremiseEvidencePhase,
} from "./longmemeval-v2-premise-evidence-protocol.js";
import { buildLongMemEvalV2PremiseEvidenceSplit } from "./longmemeval-v2-premise-evidence-split.js";
import {
  buildPremiseEvidenceIndex,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  selectPremiseEvidence,
  type PremiseEvidenceConfig,
  type PremiseEvidenceIndex,
  type PremiseEvidenceInventoryKind,
} from "./longmemeval-v2-premise-evidence.js";
import { mean, percentile } from "./longmemeval-v2-procedure-baseline-runner.js";
import type { RetrievedUnit } from "./types.js";

export interface LongMemEvalV2PremiseEvidenceCase {
  protocolVersion: string;
  mode: "premise_evidence";
  phase: LongMemEvalV2PremiseEvidencePhase;
  policyId: string;
  label: LongMemEvalV2PremiseEvidenceLabel;
  questionId: string;
  questionSha256: string;
  domain: string;
  environment: string;
  memoryAbility: string;
  evaluator: string;
  baseInjectedIds: string[];
  baseInjectedItemSha256: string[];
  baseContextSha256: string;
  baseInjectedTokens: number;
  injected: RetrievedUnit[];
  injectedIds: string[];
  injectedItemSha256: string[];
  contextSha256: string;
  injectedTokens: number;
  tokenDeltaVsBase: number;
  contextChanged: boolean;
  usedPremiseEvidence: boolean;
  selectionMode: PremiseEvidenceContextResult["mode"];
  decisionReason: string;
  operator: string | null;
  anchors: string[];
  inventoryId: string | null;
  supportingInventoryIds: string[];
  sourceTrajectoryId: string | null;
  sourceStateIndex: number | null;
  sourceObservationSha256: string | null;
  sourceLines: number[];
  contextOverlap: number;
  distinctTrajectorySupport: number;
  capsule: string | null;
  capsuleSha256: string | null;
  capsuleCharacters: number;
  capsuleTokens: number;
  referenceConclusionAgreement: boolean | null;
  selectionLatencyMs: number;
  fallback: boolean;
  fallbackReason: string | null;
  basePrefixViolations: number;
  certificateViolations: number;
  tokenViolation: boolean;
}

export interface PremiseEvidenceDirectMetrics {
  premiseQuestions: number;
  controlQuestions: number;
  premiseChallenges: number;
  validPremiseChallenges: number;
  invalidPremiseChallenges: number;
  controlChallenges: number;
  premiseRecall: number;
  controlSpecificity: number;
  challengePrecision: number;
  changedContexts: number;
  exactBaseNoops: number;
  exactBaseNoopRate: number;
  meanBaseInjectedTokens: number;
  meanInjectedTokens: number;
  meanInjectedTokenDelta: number;
  meanInjectedTokenIncreaseFraction: number;
  meanTriggeredCapsuleTokens: number;
  selectionLatencyP50Ms: number;
  selectionLatencyP95Ms: number;
  fallbacks: number;
  basePrefixViolations: number;
  certificateViolations: number;
  tokenViolations: number;
}

export interface LongMemEvalV2PremiseEvidenceSummary {
  protocolVersion: string;
  mode: "premise_evidence";
  phase: LongMemEvalV2PremiseEvidencePhase;
  status: "development_direct_passed" | "development_direct_failed"
    | "validation_direct_passed" | "validation_direct_failed"
    | "test_direct_passed" | "test_direct_failed";
  preScoreCommit: string;
  authorizationSha256: string | null;
  baselineArtifact: { casesSha256: string; summarySha256: string };
  splitCanonicalSha256: string;
  cases: number;
  index: {
    buildLatencyMs: number;
    trajectories: number;
    states: number;
    inventories: number;
    adjacencyKeys: number;
    terminalAfterKeys: number;
    terminalBeforeKeys: number;
    skippedOversizedInventories: number;
    supersededInventories: number;
    available: boolean;
    failureReason: string | null;
    scopeAdapterId: string;
  };
  metrics: PremiseEvidenceDirectMetrics;
  decisionReasons: Record<string, number>;
  forcedFallbackMismatches: Record<string, number>;
  casesSha256: string;
  gate: { passed: boolean; checks: Record<string, boolean>; failedChecks: string[] };
  answerLevelState: "not_admitted" | "admitted_pending";
  laterPhaseState: "unread";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function itemSha256(item: Pick<RetrievedUnit, "id" | "content" | "tokenCount">): string {
  return sha256(`${item.id}\0${item.tokenCount}\0${item.content}`);
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertFrozenSplit(questions: LongTaskQuestion[]): void {
  const protocol = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL;
  const generated = buildLongMemEvalV2PremiseEvidenceSplit({
    questions,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    questionsSha256: protocol.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.seed,
    controlSource: controlSourceJson,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT)) {
    throw new Error("D14 generated premise-evidence split differs from the frozen split");
  }
}

function activeIndexConfig(): PremiseEvidenceConfig {
  const candidate = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.candidate;
  return {
    maxTrajectories: candidate.maxTrajectories,
    maxStates: candidate.maxStates,
    maxInventories: candidate.maxInventories,
    maxItemsPerInventory: candidate.maxItemsPerInventory,
    maxIndexKeys: candidate.maxIndexKeys,
    maxSupportsPerKey: candidate.maxSupportsPerKey,
    maxCapsuleCharacters: candidate.maxCapsuleCharacters,
    minContextOverlap: candidate.minContextOverlap,
    minDistinctTrajectories: candidate.minDistinctTrajectories,
    allowedInventoryKinds: [...candidate.allowedInventoryKinds] as PremiseEvidenceInventoryKind[],
  };
}

function activeContextPolicy(): PremiseEvidenceContextPolicy {
  const candidate = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.candidate;
  return {
    enabled: true,
    maxCapsuleTokens: candidate.maxCapsuleTokens,
    maxCandidateItems: candidate.maxCandidateItems,
    maxCandidateTokens: candidate.maxCandidateTokens,
    maxSelectionLatencyMs: candidate.maxSelectionLatencyMs,
  };
}

async function loadLockedBaseline(params: {
  casesPath: string;
  summaryPath: string;
  phase: LongMemEvalV2PremiseEvidencePhase;
  preScoreCommit: string;
  authorizationSha256?: string;
}): Promise<{
  cases: LongMemEvalV2PremiseEvidenceBaselineCase[];
  byQuestionId: Map<string, LongMemEvalV2PremiseEvidenceBaselineCase>;
  summary: LongMemEvalV2PremiseEvidenceBaselineSummary;
  artifact: { casesSha256: string; summarySha256: string };
}> {
  const [casesText, summaryText] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
  ]);
  const casesSha256 = sha256(casesText);
  const summarySha256 = sha256(summaryText);
  const cases = casesText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceBaselineCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2PremiseEvidenceBaselineSummary;
  const expected = premiseEvidenceQuestionIdsForPhase(params.phase);
  if (summary.protocolVersion !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.protocolVersion
    || summary.mode !== "base" || summary.phase !== params.phase || summary.status !== "completed"
    || summary.preScoreCommit !== params.preScoreCommit
    || summary.authorizationSha256 !== (params.authorizationSha256 ?? null)
    || summary.splitCanonicalSha256 !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.canonicalSha256
    || summary.casesSha256 !== casesSha256 || summary.cases !== cases.length
    || new Set(cases.map((item) => item.questionId)).size !== cases.length
    || !exactIds(cases.map((item) => item.questionId).sort(), expected.map((item) => item.id).sort())
    || cases.some((item) => item.contextSha256 !== premiseEvidenceContextSha256(item.injected)
      || !exactIds(item.injectedIds, item.injected.map((unit) => unit.id))
      || !exactIds(item.injectedItemSha256, item.injected.map(itemSha256)))) {
    throw new Error("D14 locked Base artifact identity mismatch");
  }
  return {
    cases,
    byQuestionId: new Map(cases.map((item) => [item.questionId, item])),
    summary,
    artifact: { casesSha256, summarySha256 },
  };
}

function aggregate(cases: LongMemEvalV2PremiseEvidenceCase[]): PremiseEvidenceDirectMetrics {
  const premise = cases.filter((item) => item.label === "premise");
  const controls = cases.filter((item) => item.label === "control");
  const challengedPremise = premise.filter((item) => item.usedPremiseEvidence);
  const valid = challengedPremise.filter((item) => item.referenceConclusionAgreement === true);
  const invalid = challengedPremise.length - valid.length;
  const controlChallenges = controls.filter((item) => item.usedPremiseEvidence).length;
  const totalChallenges = challengedPremise.length + controlChallenges;
  const ordinaryNoops = cases.filter((item) => !item.usedPremiseEvidence && !item.fallback);
  const exactBaseNoops = ordinaryNoops.filter((item) =>
    item.contextSha256 === item.baseContextSha256).length;
  const baseMean = mean(cases.map((item) => item.baseInjectedTokens));
  const candidateMean = mean(cases.map((item) => item.injectedTokens));
  return {
    premiseQuestions: premise.length,
    controlQuestions: controls.length,
    premiseChallenges: challengedPremise.length,
    validPremiseChallenges: valid.length,
    invalidPremiseChallenges: invalid,
    controlChallenges,
    premiseRecall: premise.length === 0 ? 0 : valid.length / premise.length,
    controlSpecificity: controls.length === 0 ? 0 : 1 - controlChallenges / controls.length,
    challengePrecision: totalChallenges === 0 ? 0 : valid.length / totalChallenges,
    changedContexts: cases.filter((item) => item.contextChanged).length,
    exactBaseNoops,
    exactBaseNoopRate: ordinaryNoops.length === 0 ? 1 : exactBaseNoops / ordinaryNoops.length,
    meanBaseInjectedTokens: baseMean,
    meanInjectedTokens: candidateMean,
    meanInjectedTokenDelta: candidateMean - baseMean,
    meanInjectedTokenIncreaseFraction: baseMean === 0 ? 0 : (candidateMean - baseMean) / baseMean,
    meanTriggeredCapsuleTokens: mean(cases.filter((item) => item.usedPremiseEvidence)
      .map((item) => item.capsuleTokens)),
    selectionLatencyP50Ms: percentile(cases.map((item) => item.selectionLatencyMs), 0.5),
    selectionLatencyP95Ms: percentile(cases.map((item) => item.selectionLatencyMs), 0.95),
    fallbacks: cases.filter((item) => item.fallback).length,
    basePrefixViolations: cases.reduce((sum, item) => sum + item.basePrefixViolations, 0),
    certificateViolations: cases.reduce((sum, item) => sum + item.certificateViolations, 0),
    tokenViolations: cases.filter((item) => item.tokenViolation).length,
  };
}

export function evaluatePremiseEvidenceDirectGate(params: {
  metrics: PremiseEvidenceDirectMetrics;
  indexBuildLatencyMs: number;
  forcedFallbackMismatches: Record<string, number>;
}): { passed: boolean; checks: Record<string, boolean>; failedChecks: string[] } {
  const gate = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.directPhaseGate;
  const checks = {
    validChallenges: params.metrics.validPremiseChallenges >= gate.minValidPremiseChallenges,
    noInvalidChallenges: params.metrics.invalidPremiseChallenges <= gate.maxInvalidPremiseChallenges,
    noControlChallenges: params.metrics.controlChallenges <= gate.maxControlChallenges,
    noFallbacks: params.metrics.fallbacks <= gate.maxFallbacks,
    certificates: params.metrics.certificateViolations <= gate.maxCertificateViolations,
    basePrefix: params.metrics.basePrefixViolations <= gate.maxBasePrefixViolations,
    tokenBudget: params.metrics.tokenViolations <= gate.maxTokenViolations,
    meanTokenCost: params.metrics.meanInjectedTokenIncreaseFraction
      <= gate.maxMeanInjectedTokenIncreaseFraction,
    selectionLatency: params.metrics.selectionLatencyP95Ms <= gate.maxP95SelectionLatencyMs,
    indexLatency: params.indexBuildLatencyMs <= gate.maxIndexBuildLatencyMs,
    exactOrdinaryNoops: !gate.requireExactOrdinaryNoops
      || params.metrics.exactBaseNoopRate === 1,
    exactForcedFallbacks: !gate.requireExactForcedFallbacks
      || Object.values(params.forcedFallbackMismatches).every((value) => value === 0),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

function forcedFallbackAudit(params: {
  baseline: LongMemEvalV2PremiseEvidenceBaselineCase;
  question: LongTaskQuestion;
  index: PremiseEvidenceIndex;
}): Record<string, number> {
  const baseline = {
    items: params.baseline.injected,
    injectedTokens: params.baseline.injectedTokens,
    tokenViolation: params.baseline.tokenViolation,
  };
  const policy = activeContextPolicy();
  const mismatch = (result: PremiseEvidenceContextResult) => Number(
    result.contextSha256 !== params.baseline.contextSha256
      || !exactIds(result.items.map((item) => item.id), params.baseline.injectedIds)
      || result.items.some((item, index) => item.content !== params.baseline.injected[index]?.content
        || item.tokenCount !== params.baseline.injected[index]?.tokenCount),
  );
  const run = (overrides: {
    index?: PremiseEvidenceIndex;
    policy?: PremiseEvidenceContextPolicy;
    testHooks?: Parameters<typeof selectPremiseEvidenceContext>[0]["testHooks"];
  }) => selectPremiseEvidenceContext({
    baseline,
    question: params.question,
    index: overrides.index ?? params.index,
    policy: overrides.policy ?? policy,
    testHooks: overrides.testHooks,
  });
  let tick = 0;
  const realDecision = selectPremiseEvidence({ question: params.question, index: params.index });
  const missingInventory = {
    ...params.index,
    inventories: params.index.inventories.filter((item) => item.id !== realDecision.inventoryId),
  };
  const corruptInventory = {
    ...params.index,
    inventories: params.index.inventories.map((item) => item.id === realDecision.inventoryId
      ? { ...item, sourceSha256: "corrupt" } : item),
  };
  const checks = {
    disabled: run({ policy: { ...policy, enabled: false } }),
    index_failure: run({ index: { ...params.index, available: false, failureReason: "index_key_overflow" } }),
    selection_error: run({ testHooks: { select: () => { throw new Error("forced"); } } }),
    timeout: run({ testHooks: { now: () => (tick++ === 0 ? 0 : policy.maxSelectionLatencyMs + 1) } }),
    capsule_token_overflow: run({ testHooks: { countTokens: () => policy.maxCapsuleTokens + 1 } }),
    item_overflow: run({ policy: { ...policy, maxCandidateItems: baseline.items.length } }),
    token_overflow: run({ policy: { ...policy, maxCandidateTokens: baseline.injectedTokens } }),
    missing_source_inventory: run({ index: missingInventory }),
    corrupt_source_inventory: run({ index: corruptInventory }),
    certificate_failure: run({ testHooks: { select: () => ({
      ...realDecision,
      certificateViolations: 1,
    }) } }),
  };
  return Object.fromEntries(Object.entries(checks).map(([name, result]) => [name, mismatch(result)]));
}

export async function runLongMemEvalV2PremiseEvidence(params: {
  dataRoot: string;
  phase: LongMemEvalV2PremiseEvidencePhase;
  preScoreCommit: string;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  authorization?: PremiseEvidenceReadAdmission;
  authorizationSha256?: string;
}): Promise<{
  cases: LongMemEvalV2PremiseEvidenceCase[];
  summary: LongMemEvalV2PremiseEvidenceSummary;
}> {
  if (!/^[0-9a-f]{7,40}$/u.test(params.preScoreCommit)) {
    throw new Error("D14 candidate preScoreCommit must be a git SHA");
  }
  assertPremiseEvidencePhaseReadAuthorized(params);
  const protocol = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL;
  const locked = await loadLockedBaseline({
    casesPath: params.baselineCasesPath,
    summaryPath: params.baselineSummaryPath,
    phase: params.phase,
    preScoreCommit: params.preScoreCommit,
    authorizationSha256: params.authorizationSha256,
  });
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
  const byQuestionId = new Map(questions.map((question) => [question.id, question]));
  const selected = premiseEvidenceQuestionIdsForPhase(params.phase).map(({ id, label }) => {
    const question = byQuestionId.get(id);
    const baseline = locked.byQuestionId.get(id);
    if (!question || !baseline || baseline.label !== label
      || baseline.questionSha256 !== sha256(question.prompt)) {
      throw new Error(`D14 frozen question or Base mismatch ${id}`);
    }
    return { question, baseline, label };
  });
  const trajectories = await adapter.loadTrajectories([...new Set(selected.flatMap(({ question }) =>
    question.trajectoryIds))]);
  const indexStartedAt = performance.now();
  const index = buildPremiseEvidenceIndex({
    trajectories,
    config: activeIndexConfig(),
    scopeAdapter: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  });
  const indexBuildLatencyMs = performance.now() - indexStartedAt;
  const contextPolicy = activeContextPolicy();
  const cases = selected.map(({ question, baseline, label }): LongMemEvalV2PremiseEvidenceCase => {
    const result = selectPremiseEvidenceContext({
      baseline: {
        items: baseline.injected,
        injectedTokens: baseline.injectedTokens,
        tokenViolation: baseline.tokenViolation,
      },
      question,
      index,
      policy: contextPolicy,
    });
    const decision = result.decision;
    const inventory = decision?.inventoryId
      ? index.inventories.find((item) => item.id === decision.inventoryId) : null;
    return {
      protocolVersion: protocol.protocolVersion,
      mode: "premise_evidence",
      phase: params.phase,
      policyId: protocol.candidate.policyId,
      label,
      questionId: question.id,
      questionSha256: sha256(question.prompt),
      domain: question.domain,
      environment: question.environment,
      memoryAbility: question.memoryAbility,
      evaluator: question.evaluator,
      baseInjectedIds: baseline.injectedIds,
      baseInjectedItemSha256: baseline.injectedItemSha256,
      baseContextSha256: baseline.contextSha256,
      baseInjectedTokens: baseline.injectedTokens,
      injected: result.items,
      injectedIds: result.items.map((item) => item.id),
      injectedItemSha256: result.items.map(itemSha256),
      contextSha256: result.contextSha256,
      injectedTokens: result.injectedTokens,
      tokenDeltaVsBase: result.injectedTokens - baseline.injectedTokens,
      contextChanged: result.contextSha256 !== baseline.contextSha256,
      usedPremiseEvidence: result.usedPremiseEvidence,
      selectionMode: result.mode,
      decisionReason: decision?.decisionReason ?? result.fallbackReason ?? "unknown",
      operator: decision?.operator ?? null,
      anchors: decision?.anchors ?? [],
      inventoryId: decision?.inventoryId ?? null,
      supportingInventoryIds: decision?.supportingInventoryIds ?? [],
      sourceTrajectoryId: inventory?.trajectoryId ?? null,
      sourceStateIndex: inventory?.stateIndex ?? null,
      sourceObservationSha256: result.sourceObservationSha256,
      sourceLines: decision?.sourceLines ?? [],
      contextOverlap: decision?.contextOverlap ?? 0,
      distinctTrajectorySupport: decision?.distinctTrajectorySupport ?? 0,
      capsule: decision?.capsule ?? null,
      capsuleSha256: decision?.capsule ? sha256(decision.capsule) : null,
      capsuleCharacters: decision?.capsule?.length ?? 0,
      capsuleTokens: result.capsuleTokens,
      referenceConclusionAgreement: label === "premise" && decision
        ? premiseEvidenceReferenceConclusionAgreement(question, decision) : null,
      selectionLatencyMs: result.selectionLatencyMs,
      fallback: result.fallback,
      fallbackReason: result.fallbackReason,
      basePrefixViolations: result.basePrefixViolations,
      certificateViolations: decision?.certificateViolations ?? 0,
      tokenViolation: result.tokenViolation,
    };
  }).sort((left, right) => left.questionId.localeCompare(right.questionId));
  const changed = cases.find((item) => item.usedPremiseEvidence);
  if (!changed) throw new Error("D14 direct audit requires at least one selected witness");
  const auditQuestion = byQuestionId.get(changed.questionId)!;
  const auditBaseline = locked.byQuestionId.get(changed.questionId)!;
  const forcedFallbackMismatches = forcedFallbackAudit({
    baseline: auditBaseline,
    question: auditQuestion,
    index,
  });
  const metrics = aggregate(cases);
  const gate = evaluatePremiseEvidenceDirectGate({
    metrics,
    indexBuildLatencyMs,
    forcedFallbackMismatches,
  });
  const casesText = cases.map(canonicalJsonLine).join("");
  const phasePrefix = params.phase === "development" ? "development"
    : params.phase === "validation" ? "validation" : "test";
  const decisionReasons = Object.fromEntries([...new Set(cases.map((item) => item.decisionReason))]
    .sort().map((reason) => [reason, cases.filter((item) => item.decisionReason === reason).length]));
  return {
    cases,
    summary: {
      protocolVersion: protocol.protocolVersion,
      mode: "premise_evidence",
      phase: params.phase,
      status: `${phasePrefix}_direct_${gate.passed ? "passed" : "failed"}` as LongMemEvalV2PremiseEvidenceSummary["status"],
      preScoreCommit: params.preScoreCommit,
      authorizationSha256: params.authorizationSha256 ?? null,
      baselineArtifact: locked.artifact,
      splitCanonicalSha256: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.canonicalSha256,
      cases: cases.length,
      index: {
        buildLatencyMs: indexBuildLatencyMs,
        trajectories: index.trajectories,
        states: index.states,
        inventories: index.inventories.length,
        adjacencyKeys: index.adjacency.size,
        terminalAfterKeys: index.terminalAfter.size,
        terminalBeforeKeys: index.terminalBefore.size,
        skippedOversizedInventories: index.skippedOversizedInventories,
        supersededInventories: index.supersededInventories,
        available: index.available,
        failureReason: index.failureReason,
        scopeAdapterId: index.scopeAdapterId,
      },
      metrics,
      decisionReasons,
      forcedFallbackMismatches,
      casesSha256: sha256(casesText),
      gate,
      answerLevelState: gate.passed ? "admitted_pending" : "not_admitted",
      laterPhaseState: "unread",
    },
  };
}
