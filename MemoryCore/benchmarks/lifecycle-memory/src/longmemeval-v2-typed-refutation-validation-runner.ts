import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type {
  LongMemEvalV2PremiseEvidenceBaselineCase,
  LongMemEvalV2PremiseEvidenceBaselineSummary,
} from "./longmemeval-v2-premise-evidence-baseline-runner.js";
import { premiseEvidenceContextSha256 } from "./longmemeval-v2-premise-evidence-context.js";
import {
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL,
  premiseEvidenceQuestionIdsForPhase,
} from "./longmemeval-v2-premise-evidence-protocol.js";
import type {
  LongMemEvalV2PremiseEvidenceCase,
  LongMemEvalV2PremiseEvidenceSummary,
} from "./longmemeval-v2-premise-evidence-runner.js";
import type { LongMemEvalV2PremiseEvidenceIndependentValidation }
  from "./longmemeval-v2-premise-evidence-validator.js";
import {
  buildPremiseEvidenceIndex,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  type PremiseEvidenceConfig,
  type PremiseEvidenceInventoryKind,
} from "./longmemeval-v2-premise-evidence.js";
import { mean, percentile } from "./longmemeval-v2-procedure-baseline-runner.js";
import {
  isTypedRefutationValidationReadAdmission,
  LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL,
  type TypedRefutationValidationReadAdmission,
} from "./longmemeval-v2-typed-refutation-validation-protocol.js";
import {
  selectTypedRefutationContext,
  type TypedRefutationContextPolicy,
  type TypedRefutationResult,
} from "./longmemeval-v2-typed-refutation.js";
import type { RetrievedUnit } from "./types.js";

export interface TypedRefutationValidationCase {
  protocolVersion: string;
  mode: "typed_refutation_validation";
  phase: "validation";
  policyId: "typed-action-contract-v1";
  label: "premise" | "control";
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
  d14ContextSha256: string;
  d14UsedPremiseEvidence: boolean;
  d14ReferenceConclusionAgreement: boolean | null;
  d14Operator: string | null;
  d14Anchors: string[];
  d14InventoryId: string | null;
  d14SourceTrajectoryId: string | null;
  d14SourceStateIndex: number | null;
  d14SourceLines: number[];
  injected: RetrievedUnit[];
  injectedIds: string[];
  injectedItemSha256: string[];
  contextSha256: string;
  injectedTokens: number;
  tokenDeltaVsBase: number;
  contextChanged: boolean;
  usedTypedRefutation: boolean;
  typedCapsule: string | null;
  typedCapsuleSha256: string | null;
  typedCapsuleTokens: number;
  sourceObservationSha256: string | null;
  selectionLatencyMs: number;
  fallback: boolean;
  fallbackReason: string | null;
  basePrefixViolations: number;
  capsuleCertificateViolations: number;
  tokenViolation: boolean;
}

export interface TypedRefutationValidationDirectMetrics {
  premiseQuestions: number;
  controlQuestions: number;
  premiseChallenges: number;
  validPremiseChallenges: number;
  invalidPremiseChallenges: number;
  controlChallenges: number;
  challengePrecision: number;
  premiseRecall: number;
  controlSpecificity: number;
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
  capsuleCertificateViolations: number;
  tokenViolations: number;
}

export interface TypedRefutationValidationSummary {
  protocolVersion: string;
  mode: "typed_refutation_validation";
  phase: "validation";
  status: "validation_direct_passed" | "validation_direct_failed";
  decision: "admit_validation_answer_panel" | "reject_D15_and_keep_test_unread";
  preScoreCommit: string;
  authorizationSha256: string;
  inputSha256: {
    baselineCases: string;
    baselineSummary: string;
    d14CandidateCases: string;
    d14CandidateSummary: string;
    d14IndependentValidation: string;
  };
  splitCanonicalSha256: string;
  cases: number;
  index: {
    buildLatencyMs: number;
    trajectories: number;
    states: number;
    inventories: number;
    available: boolean;
    failureReason: string | null;
    scopeAdapterId: string;
  };
  metrics: TypedRefutationValidationDirectMetrics;
  forcedFallbackMismatches: Record<string, number>;
  casesSha256: string;
  gate: { passed: boolean; checks: Record<string, boolean>; failedChecks: string[] };
  answerLevelState: "admitted_pending" | "not_admitted";
  testState: "unread";
  claimBoundary: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function itemSha256(item: Pick<RetrievedUnit, "id" | "content" | "tokenCount">): string {
  return sha256(`${item.id}\0${item.tokenCount}\0${item.content}`);
}

function exactIds<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function activeD14IndexConfig(): PremiseEvidenceConfig {
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

function activeD14ContextPolicy() {
  const candidate = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.candidate;
  return {
    enabled: true,
    maxCapsuleTokens: candidate.maxCapsuleTokens,
    maxCandidateItems: candidate.maxCandidateItems,
    maxCandidateTokens: candidate.maxCandidateTokens,
    maxSelectionLatencyMs: candidate.maxSelectionLatencyMs,
  };
}

function activeTypedPolicy(): TypedRefutationContextPolicy {
  const candidate = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.candidate;
  return {
    policyId: "typed-action-contract-v1",
    enabled: true,
    maxCapsuleTokens: candidate.maxCapsuleTokens,
    maxCandidateItems: candidate.maxCandidateItems,
    maxCandidateTokens: candidate.maxCandidateTokens,
    maxSelectionLatencyMs: candidate.maxSelectionLatencyMs,
  };
}

function exactBaseline(result: TypedRefutationResult,
  baseline: LongMemEvalV2PremiseEvidenceBaselineCase): boolean {
  return result.contextSha256 === baseline.contextSha256
    && exactIds(result.items.map((item) => item.id), baseline.injectedIds)
    && result.items.every((item, index) => item.content === baseline.injected[index]?.content
      && item.tokenCount === baseline.injected[index]?.tokenCount);
}

function forcedFallbackAudit(params: {
  question: LongTaskQuestion;
  baseline: LongMemEvalV2PremiseEvidenceBaselineCase;
  index: ReturnType<typeof buildPremiseEvidenceIndex>;
}): Record<string, number> {
  const baseline = {
    items: params.baseline.injected,
    injectedTokens: params.baseline.injectedTokens,
    tokenViolation: params.baseline.tokenViolation,
  };
  const policy = activeTypedPolicy();
  const d14Policy = activeD14ContextPolicy();
  const run = (overrides: {
    policy?: TypedRefutationContextPolicy;
    index?: ReturnType<typeof buildPremiseEvidenceIndex>;
    testHooks?: Parameters<typeof selectTypedRefutationContext>[0]["testHooks"];
  }) => selectTypedRefutationContext({
    baseline,
    question: params.question,
    index: overrides.index ?? params.index,
    d14Policy,
    policy: overrides.policy ?? policy,
    testHooks: overrides.testHooks,
  });
  let tick = 0;
  const results = {
    disabled: run({ policy: { ...policy, enabled: false } }),
    d14_index_failure: run({ index: { ...params.index, available: false,
      failureReason: "corrupt_accessibility_tree" } }),
    renderer_failure: run({ testHooks: { forceRendererFailure: true } }),
    certificate_failure: run({ testHooks: { forceCertificateFailure: true } }),
    capsule_token_overflow: run({ testHooks: { countTokens: () => policy.maxCapsuleTokens + 1 } }),
    item_overflow: run({ policy: { ...policy, maxCandidateItems: baseline.items.length } }),
    token_overflow: run({ policy: { ...policy, maxCandidateTokens: baseline.injectedTokens } }),
    timeout: run({ testHooks: { now: () => (tick++ === 0 ? 0 : policy.maxSelectionLatencyMs + 1) } }),
  };
  return Object.fromEntries(Object.entries(results).map(([name, result]) =>
    [name, Number(!exactBaseline(result, params.baseline))]));
}

function aggregate(cases: TypedRefutationValidationCase[]): TypedRefutationValidationDirectMetrics {
  const premise = cases.filter((item) => item.label === "premise");
  const controls = cases.filter((item) => item.label === "control");
  const challengedPremise = premise.filter((item) => item.usedTypedRefutation);
  const valid = challengedPremise.filter((item) => item.d14ReferenceConclusionAgreement === true);
  const invalid = challengedPremise.length - valid.length;
  const controlChallenges = controls.filter((item) => item.usedTypedRefutation).length;
  const totalChallenges = challengedPremise.length + controlChallenges;
  const noops = cases.filter((item) => !item.usedTypedRefutation && !item.fallback);
  const exactBaseNoops = noops.filter((item) => item.contextSha256 === item.baseContextSha256).length;
  const baseMean = mean(cases.map((item) => item.baseInjectedTokens));
  const candidateMean = mean(cases.map((item) => item.injectedTokens));
  return {
    premiseQuestions: premise.length,
    controlQuestions: controls.length,
    premiseChallenges: challengedPremise.length,
    validPremiseChallenges: valid.length,
    invalidPremiseChallenges: invalid,
    controlChallenges,
    challengePrecision: totalChallenges === 0 ? 0 : valid.length / totalChallenges,
    premiseRecall: premise.length === 0 ? 0 : valid.length / premise.length,
    controlSpecificity: controls.length === 0 ? 0 : 1 - controlChallenges / controls.length,
    changedContexts: cases.filter((item) => item.contextChanged).length,
    exactBaseNoops,
    exactBaseNoopRate: noops.length === 0 ? 1 : exactBaseNoops / noops.length,
    meanBaseInjectedTokens: baseMean,
    meanInjectedTokens: candidateMean,
    meanInjectedTokenDelta: candidateMean - baseMean,
    meanInjectedTokenIncreaseFraction: baseMean === 0 ? 0 : (candidateMean - baseMean) / baseMean,
    meanTriggeredCapsuleTokens: challengedPremise.length === 0
      ? 0 : mean(challengedPremise.map((item) => item.typedCapsuleTokens)),
    selectionLatencyP50Ms: percentile(cases.map((item) => item.selectionLatencyMs), 0.5),
    selectionLatencyP95Ms: percentile(cases.map((item) => item.selectionLatencyMs), 0.95),
    fallbacks: cases.filter((item) => item.fallback).length,
    basePrefixViolations: cases.reduce((sum, item) => sum + item.basePrefixViolations, 0),
    capsuleCertificateViolations: cases.reduce((sum, item) =>
      sum + item.capsuleCertificateViolations, 0),
    tokenViolations: cases.filter((item) => item.tokenViolation).length,
  };
}

export function evaluateTypedRefutationValidationDirectGate(params: {
  metrics: TypedRefutationValidationDirectMetrics;
  indexBuildLatencyMs: number;
  forcedFallbackMismatches: Record<string, number>;
}): { passed: boolean; checks: Record<string, boolean>; failedChecks: string[] } {
  const gate = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.directGate;
  const checks = {
    validChallenges: params.metrics.validPremiseChallenges >= gate.minValidPremiseChallenges,
    noInvalidChallenges: params.metrics.invalidPremiseChallenges <= gate.maxInvalidPremiseChallenges,
    noControlChallenges: params.metrics.controlChallenges <= gate.maxControlChallenges,
    noFallbacks: params.metrics.fallbacks <= gate.maxFallbacks,
    certificates: params.metrics.capsuleCertificateViolations <= gate.maxCertificateViolations,
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

export async function runTypedRefutationValidation(params: {
  dataRoot: string;
  preScoreCommit: string;
  authorization: TypedRefutationValidationReadAdmission;
  authorizationSha256: string;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  d14CandidateCasesPath: string;
  d14CandidateSummaryPath: string;
  d14IndependentValidationPath: string;
}): Promise<{ cases: TypedRefutationValidationCase[];
  summary: TypedRefutationValidationSummary }> {
  if (!/^[0-9a-f]{7,40}$/u.test(params.preScoreCommit)
    || !/^[0-9a-f]{64}$/u.test(params.authorizationSha256)
    || !isTypedRefutationValidationReadAdmission(params.authorization)) {
    throw new Error("D15 validation requires a committed read admission and pre-score SHA");
  }
  const [baselineText, baselineSummaryText, d14CasesText, d14SummaryText, d14ValidationText]
    = await Promise.all([
      readFile(params.baselineCasesPath, "utf8"), readFile(params.baselineSummaryPath, "utf8"),
      readFile(params.d14CandidateCasesPath, "utf8"), readFile(params.d14CandidateSummaryPath, "utf8"),
      readFile(params.d14IndependentValidationPath, "utf8"),
    ]);
  const inputSha256 = {
    baselineCases: sha256(baselineText), baselineSummary: sha256(baselineSummaryText),
    d14CandidateCases: sha256(d14CasesText), d14CandidateSummary: sha256(d14SummaryText),
    d14IndependentValidation: sha256(d14ValidationText),
  };
  const baselineCases = baselineText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceBaselineCase);
  const baselineSummary = JSON.parse(baselineSummaryText) as LongMemEvalV2PremiseEvidenceBaselineSummary;
  const d14Cases = d14CasesText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceCase);
  const d14Summary = JSON.parse(d14SummaryText) as LongMemEvalV2PremiseEvidenceSummary;
  const d14Validation = JSON.parse(d14ValidationText) as
    LongMemEvalV2PremiseEvidenceIndependentValidation;
  if (baselineSummary.phase !== "validation" || d14Summary.phase !== "validation"
    || baselineSummary.authorizationSha256 !== params.authorizationSha256
    || d14Summary.authorizationSha256 !== params.authorizationSha256
    || baselineSummary.casesSha256 !== inputSha256.baselineCases
    || d14Summary.casesSha256 !== inputSha256.d14CandidateCases
    || d14Summary.baselineArtifact.casesSha256 !== inputSha256.baselineCases
    || d14Summary.baselineArtifact.summarySha256 !== inputSha256.baselineSummary
    || d14Summary.status !== "validation_direct_passed" || !d14Summary.gate.passed
    || d14Validation.phase !== "validation" || d14Validation.status !== "passed"
    || d14Validation.inputSha256.baselineCases !== inputSha256.baselineCases
    || d14Validation.inputSha256.baselineSummary !== inputSha256.baselineSummary
    || d14Validation.inputSha256.candidateCases !== inputSha256.d14CandidateCases
    || d14Validation.inputSha256.candidateSummary !== inputSha256.d14CandidateSummary) {
    throw new Error("D15 validation requires locked passed D14 structural artifacts");
  }
  const expected = premiseEvidenceQuestionIdsForPhase("validation");
  const baselineById = new Map(baselineCases.map((item) => [item.questionId, item]));
  const d14ById = new Map(d14Cases.map((item) => [item.questionId, item]));
  if (baselineById.size !== expected.length || d14ById.size !== expected.length
    || !exactIds([...baselineById.keys()].sort(), expected.map((item) => item.id).sort())
    || !exactIds([...d14ById.keys()].sort(), expected.map((item) => item.id).sort())) {
    throw new Error("D15 validation question grain or identity mismatch");
  }
  const dataset = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset;
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: dataset.benchmarkRepositoryRevision,
    tier: dataset.tier,
    expected: {
      questionsSha256: dataset.questionsSha256,
      haystackSha256: dataset.haystackSha256,
      trajectoriesSha256: dataset.trajectoriesSha256,
      questions: dataset.questions,
      trajectoryRows: dataset.trajectoryRows,
      haystackSize: 100,
      selectedTrajectories: dataset.selectedTrajectories,
    },
  });
  const questions = await adapter.loadQuestions();
  const questionById = new Map(questions.map((item) => [item.id, item]));
  const selectedQuestions = expected.map(({ id }) => questionById.get(id)!);
  const trajectories = await adapter.loadTrajectories([...new Set(selectedQuestions.flatMap((item) =>
    item.trajectoryIds))]);
  const indexStartedAt = performance.now();
  const index = buildPremiseEvidenceIndex({
    trajectories,
    config: activeD14IndexConfig(),
    scopeAdapter: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  });
  const indexBuildLatencyMs = performance.now() - indexStartedAt;
  const d14Policy = activeD14ContextPolicy();
  const typedPolicy = activeTypedPolicy();
  const cases = expected.map(({ id, label }): TypedRefutationValidationCase => {
    const question = questionById.get(id);
    const baseline = baselineById.get(id);
    const d14 = d14ById.get(id);
    if (!question || !baseline || !d14 || baseline.label !== label || d14.label !== label
      || baseline.questionSha256 !== sha256(question.prompt)
      || d14.questionSha256 !== sha256(question.prompt)
      || baseline.contextSha256 !== premiseEvidenceContextSha256(baseline.injected)) {
      throw new Error(`D15 validation locked case mismatch ${id}`);
    }
    const result = selectTypedRefutationContext({
      baseline: { items: baseline.injected, injectedTokens: baseline.injectedTokens,
        tokenViolation: baseline.tokenViolation },
      question,
      index,
      d14Policy,
      policy: typedPolicy,
    });
    if (result.usedTypedRefutation !== d14.usedPremiseEvidence
      || result.sourceObservationSha256 !== d14.sourceObservationSha256
      || (result.usedTypedRefutation && (!result.typedCapsule
        || !result.typedCapsule.includes("question_relation: REFUTES_PREMISE")
        || !result.typedCapsule.includes("evidence_sufficiency: SUFFICIENT_FOR_CORRECTION")
        || !result.typedCapsule.includes("answer_mode: CORRECT_FALSE_PREMISE")
        || !result.typedCapsule.includes("generation_contract:")))) {
      throw new Error(`D15 typed replay differs from D14 trigger ${id}`);
    }
    return {
      protocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion,
      mode: "typed_refutation_validation",
      phase: "validation",
      policyId: "typed-action-contract-v1",
      label,
      questionId: id,
      questionSha256: sha256(question.prompt),
      domain: question.domain,
      environment: question.environment,
      memoryAbility: question.memoryAbility,
      evaluator: question.evaluator,
      baseInjectedIds: baseline.injectedIds,
      baseInjectedItemSha256: baseline.injectedItemSha256,
      baseContextSha256: baseline.contextSha256,
      baseInjectedTokens: baseline.injectedTokens,
      d14ContextSha256: d14.contextSha256,
      d14UsedPremiseEvidence: d14.usedPremiseEvidence,
      d14ReferenceConclusionAgreement: d14.referenceConclusionAgreement,
      d14Operator: d14.operator,
      d14Anchors: d14.anchors,
      d14InventoryId: d14.inventoryId,
      d14SourceTrajectoryId: d14.sourceTrajectoryId,
      d14SourceStateIndex: d14.sourceStateIndex,
      d14SourceLines: d14.sourceLines,
      injected: result.items,
      injectedIds: result.items.map((item) => item.id),
      injectedItemSha256: result.items.map(itemSha256),
      contextSha256: result.contextSha256,
      injectedTokens: result.injectedTokens,
      tokenDeltaVsBase: result.injectedTokens - baseline.injectedTokens,
      contextChanged: result.contextSha256 !== baseline.contextSha256,
      usedTypedRefutation: result.usedTypedRefutation,
      typedCapsule: result.typedCapsule,
      typedCapsuleSha256: result.typedCapsule ? sha256(result.typedCapsule) : null,
      typedCapsuleTokens: result.typedCapsuleTokens,
      sourceObservationSha256: result.sourceObservationSha256,
      selectionLatencyMs: result.selectionLatencyMs,
      fallback: result.fallback,
      fallbackReason: result.fallbackReason,
      basePrefixViolations: result.basePrefixViolations,
      capsuleCertificateViolations: result.capsuleCertificateViolations,
      tokenViolation: result.tokenViolation,
    };
  }).sort((left, right) => left.questionId.localeCompare(right.questionId));
  const changed = cases.find((item) => item.usedTypedRefutation);
  const forcedFallbackMismatches = changed ? forcedFallbackAudit({
    question: questionById.get(changed.questionId)!,
    baseline: baselineById.get(changed.questionId)!,
    index,
  }) : { no_trigger_available: 0 };
  const metrics = aggregate(cases);
  const gate = evaluateTypedRefutationValidationDirectGate({
    metrics,
    indexBuildLatencyMs,
    forcedFallbackMismatches,
  });
  const casesText = cases.map((item) => `${JSON.stringify(item)}\n`).join("");
  return {
    cases,
    summary: {
      protocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion,
      mode: "typed_refutation_validation",
      phase: "validation",
      status: gate.passed ? "validation_direct_passed" : "validation_direct_failed",
      decision: gate.passed ? "admit_validation_answer_panel"
        : "reject_D15_and_keep_test_unread",
      preScoreCommit: params.preScoreCommit,
      authorizationSha256: params.authorizationSha256,
      inputSha256,
      splitCanonicalSha256: params.authorization.splitCanonicalSha256,
      cases: cases.length,
      index: {
        buildLatencyMs: indexBuildLatencyMs,
        trajectories: index.trajectories,
        states: index.states,
        inventories: index.inventories.length,
        available: index.available,
        failureReason: index.failureReason,
        scopeAdapterId: index.scopeAdapterId,
      },
      metrics,
      forcedFallbackMismatches,
      casesSha256: sha256(casesText),
      gate,
      answerLevelState: gate.passed ? "admitted_pending" : "not_admitted",
      testState: "unread",
      claimBoundary: gate.passed
        ? "Direct structural replication passed; answer-level replication is still pending."
        : "D15 validation failed under frozen direct gates; no answer-quality replication or test read is authorized.",
    },
  };
}
