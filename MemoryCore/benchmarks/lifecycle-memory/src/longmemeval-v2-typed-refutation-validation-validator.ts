import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type { LongMemEvalV2PremiseEvidenceBaselineCase }
  from "./longmemeval-v2-premise-evidence-baseline-runner.js";
import {
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL,
  premiseEvidenceQuestionIdsForPhase,
} from "./longmemeval-v2-premise-evidence-protocol.js";
import type { LongMemEvalV2PremiseEvidenceCase }
  from "./longmemeval-v2-premise-evidence-runner.js";
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
  evaluateTypedRefutationValidationDirectGate,
  type TypedRefutationValidationCase,
  type TypedRefutationValidationDirectMetrics,
  type TypedRefutationValidationSummary,
} from "./longmemeval-v2-typed-refutation-validation-runner.js";
import { LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL }
  from "./longmemeval-v2-typed-refutation-validation-protocol.js";
import {
  selectTypedRefutationContext,
  type TypedRefutationContextPolicy,
} from "./longmemeval-v2-typed-refutation.js";
import type { RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

interface ValidationMismatches {
  inputIdentity: number;
  questionIdentity: number;
  d14Inheritance: number;
  decisionReplay: number;
  contextReplay: number;
  basePrefix: number;
  capsuleCertificate: number;
  tokenAccounting: number;
  summaryMetrics: number;
  forcedFallback: number;
  gateReplay: number;
}

export interface TypedRefutationIndependentValidation {
  validationVersion: "lifecycle-longmemeval-v2-typed-refutation-independent-validation-v1.0";
  sourceProtocolVersion: string;
  phase: "validation";
  status: "passed" | "failed";
  validatorCommit: string;
  inputSha256: {
    baselineCases: string;
    baselineSummary: string;
    d14CandidateCases: string;
    d14CandidateSummary: string;
    d14IndependentValidation: string;
    candidateCases: string;
    candidateSummary: string;
  };
  replayIndex: {
    inventories: number;
    available: boolean;
    failureReason: string | null;
  };
  cases: number;
  changedContexts: number;
  mismatches: ValidationMismatches;
  checks: Record<string, boolean>;
  failedChecks: string[];
  answerLevelState: "admitted_pending" | "not_admitted";
  testState: "unread";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exact<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function approx(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function itemSha256(item: Pick<RetrievedUnit, "id" | "content" | "tokenCount">): string {
  return sha256(`${item.id}\0${item.tokenCount}\0${item.content}`);
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

function d14Policy() {
  const candidate = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.candidate;
  return {
    enabled: true,
    maxCapsuleTokens: candidate.maxCapsuleTokens,
    maxCandidateItems: candidate.maxCandidateItems,
    maxCandidateTokens: candidate.maxCandidateTokens,
    maxSelectionLatencyMs: candidate.maxSelectionLatencyMs,
  };
}

function typedPolicy(): TypedRefutationContextPolicy {
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

function aggregate(cases: TypedRefutationValidationCase[]): TypedRefutationValidationDirectMetrics {
  const premise = cases.filter((item) => item.label === "premise");
  const controls = cases.filter((item) => item.label === "control");
  const challenged = premise.filter((item) => item.usedTypedRefutation);
  const valid = challenged.filter((item) => item.d14ReferenceConclusionAgreement === true);
  const controlChallenges = controls.filter((item) => item.usedTypedRefutation).length;
  const noops = cases.filter((item) => !item.usedTypedRefutation && !item.fallback);
  const exactNoops = noops.filter((item) => item.contextSha256 === item.baseContextSha256).length;
  const baseMean = mean(cases.map((item) => item.baseInjectedTokens));
  const candidateMean = mean(cases.map((item) => item.injectedTokens));
  return {
    premiseQuestions: premise.length,
    controlQuestions: controls.length,
    premiseChallenges: challenged.length,
    validPremiseChallenges: valid.length,
    invalidPremiseChallenges: challenged.length - valid.length,
    controlChallenges,
    challengePrecision: challenged.length + controlChallenges === 0 ? 0
      : valid.length / (challenged.length + controlChallenges),
    premiseRecall: premise.length === 0 ? 0 : valid.length / premise.length,
    controlSpecificity: controls.length === 0 ? 0 : 1 - controlChallenges / controls.length,
    changedContexts: cases.filter((item) => item.contextChanged).length,
    exactBaseNoops: exactNoops,
    exactBaseNoopRate: noops.length === 0 ? 1 : exactNoops / noops.length,
    meanBaseInjectedTokens: baseMean,
    meanInjectedTokens: candidateMean,
    meanInjectedTokenDelta: candidateMean - baseMean,
    meanInjectedTokenIncreaseFraction: baseMean === 0 ? 0 : (candidateMean - baseMean) / baseMean,
    meanTriggeredCapsuleTokens: challenged.length === 0 ? 0
      : mean(challenged.map((item) => item.typedCapsuleTokens)),
    selectionLatencyP50Ms: percentile(cases.map((item) => item.selectionLatencyMs), 0.5),
    selectionLatencyP95Ms: percentile(cases.map((item) => item.selectionLatencyMs), 0.95),
    fallbacks: cases.filter((item) => item.fallback).length,
    basePrefixViolations: cases.reduce((sum, item) => sum + item.basePrefixViolations, 0),
    capsuleCertificateViolations: cases.reduce((sum, item) =>
      sum + item.capsuleCertificateViolations, 0),
    tokenViolations: cases.filter((item) => item.tokenViolation).length,
  };
}

function sameMetrics(left: TypedRefutationValidationDirectMetrics,
  right: TypedRefutationValidationDirectMetrics): boolean {
  return Object.keys(left).every((key) => {
    const field = key as keyof TypedRefutationValidationDirectMetrics;
    return typeof left[field] === "number" && typeof right[field] === "number"
      && approx(left[field], right[field]);
  });
}

export async function validateTypedRefutationValidation(params: {
  dataRoot: string;
  validatorCommit: string;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  d14CandidateCasesPath: string;
  d14CandidateSummaryPath: string;
  d14IndependentValidationPath: string;
  candidateCasesPath: string;
  candidateSummaryPath: string;
}): Promise<TypedRefutationIndependentValidation> {
  if (!/^[0-9a-f]{7,40}$/u.test(params.validatorCommit)) {
    throw new Error("D15 validatorCommit must be a git SHA");
  }
  const texts = await Promise.all([
    readFile(params.baselineCasesPath, "utf8"), readFile(params.baselineSummaryPath, "utf8"),
    readFile(params.d14CandidateCasesPath, "utf8"), readFile(params.d14CandidateSummaryPath, "utf8"),
    readFile(params.d14IndependentValidationPath, "utf8"), readFile(params.candidateCasesPath, "utf8"),
    readFile(params.candidateSummaryPath, "utf8"),
  ]);
  const inputSha256 = {
    baselineCases: sha256(texts[0]), baselineSummary: sha256(texts[1]),
    d14CandidateCases: sha256(texts[2]), d14CandidateSummary: sha256(texts[3]),
    d14IndependentValidation: sha256(texts[4]), candidateCases: sha256(texts[5]),
    candidateSummary: sha256(texts[6]),
  };
  const baseline = texts[0].split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceBaselineCase);
  const d14Cases = texts[2].split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceCase);
  const d14Validation = JSON.parse(texts[4]) as LongMemEvalV2PremiseEvidenceIndependentValidation;
  const cases = texts[5].split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as TypedRefutationValidationCase);
  const summary = JSON.parse(texts[6]) as TypedRefutationValidationSummary;
  const expected = premiseEvidenceQuestionIdsForPhase("validation");
  const baselineById = new Map(baseline.map((item) => [item.questionId, item]));
  const d14ById = new Map(d14Cases.map((item) => [item.questionId, item]));
  const caseById = new Map(cases.map((item) => [item.questionId, item]));
  const mismatches: ValidationMismatches = {
    inputIdentity: 0, questionIdentity: 0, d14Inheritance: 0, decisionReplay: 0,
    contextReplay: 0, basePrefix: 0, capsuleCertificate: 0, tokenAccounting: 0,
    summaryMetrics: 0, forcedFallback: 0, gateReplay: 0,
  };
  mismatches.inputIdentity += Number(
    summary.protocolVersion !== LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion
      || summary.casesSha256 !== inputSha256.candidateCases
      || summary.inputSha256.baselineCases !== inputSha256.baselineCases
      || summary.inputSha256.baselineSummary !== inputSha256.baselineSummary
      || summary.inputSha256.d14CandidateCases !== inputSha256.d14CandidateCases
      || summary.inputSha256.d14CandidateSummary !== inputSha256.d14CandidateSummary
      || summary.inputSha256.d14IndependentValidation !== inputSha256.d14IndependentValidation
      || d14Validation.status !== "passed" || d14Validation.phase !== "validation",
  );
  mismatches.questionIdentity += Number(caseById.size !== expected.length
    || baselineById.size !== expected.length || d14ById.size !== expected.length
    || !exact([...caseById.keys()].sort(), expected.map((item) => item.id).sort()));

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
  const selectedQuestions = expected.map((item) => questionById.get(item.id)!);
  const trajectories = await adapter.loadTrajectories([...new Set(selectedQuestions.flatMap((item) =>
    item.trajectoryIds))]);
  const index = buildPremiseEvidenceIndex({
    trajectories,
    config: activeIndexConfig(),
    scopeAdapter: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  });
  for (const { id, label } of expected) {
    const question = questionById.get(id);
    const base = baselineById.get(id);
    const d14 = d14ById.get(id);
    const item = caseById.get(id);
    if (!question || !base || !d14 || !item || item.label !== label
      || item.questionSha256 !== sha256(question.prompt)) {
      mismatches.questionIdentity += 1;
      continue;
    }
    mismatches.d14Inheritance += Number(item.d14ContextSha256 !== d14.contextSha256
      || item.d14UsedPremiseEvidence !== d14.usedPremiseEvidence
      || item.d14ReferenceConclusionAgreement !== d14.referenceConclusionAgreement
      || item.d14Operator !== d14.operator || !exact(item.d14Anchors, d14.anchors)
      || item.d14InventoryId !== d14.inventoryId
      || item.d14SourceTrajectoryId !== d14.sourceTrajectoryId
      || item.d14SourceStateIndex !== d14.sourceStateIndex
      || !exact(item.d14SourceLines, d14.sourceLines));
    const replay = selectTypedRefutationContext({
      baseline: { items: base.injected, injectedTokens: base.injectedTokens,
        tokenViolation: base.tokenViolation },
      question,
      index,
      d14Policy: d14Policy(),
      policy: typedPolicy(),
      testHooks: { now: () => 0 },
    });
    mismatches.decisionReplay += Number(replay.usedTypedRefutation !== item.usedTypedRefutation
      || replay.sourceObservationSha256 !== item.sourceObservationSha256
      || replay.fallback !== item.fallback || replay.fallbackReason !== item.fallbackReason);
    mismatches.contextReplay += Number(replay.contextSha256 !== item.contextSha256
      || !exact(replay.items.map((entry) => entry.id), item.injectedIds)
      || !exact(replay.items.map(itemSha256), item.injectedItemSha256)
      || replay.typedCapsule !== item.typedCapsule
      || (replay.typedCapsule ? sha256(replay.typedCapsule) : null) !== item.typedCapsuleSha256);
    mismatches.basePrefix += item.injected.slice(0, base.injected.length).reduce((sum, entry, indexAt) =>
      sum + Number(entry.id !== base.injected[indexAt]?.id
        || entry.content !== base.injected[indexAt]?.content
        || entry.tokenCount !== base.injected[indexAt]?.tokenCount), 0);
    mismatches.capsuleCertificate += Number(item.usedTypedRefutation && (!item.typedCapsule
      || !item.typedCapsule.includes("question_relation: REFUTES_PREMISE")
      || !item.typedCapsule.includes("evidence_sufficiency: SUFFICIENT_FOR_CORRECTION")
      || !item.typedCapsule.includes("answer_mode: CORRECT_FALSE_PREMISE")
      || !item.typedCapsule.includes("generation_contract:")));
    mismatches.tokenAccounting += Number(item.injectedTokens
        !== item.injected.reduce((sum, entry) => sum + entry.tokenCount, 0)
      || item.typedCapsuleTokens !== (item.typedCapsule ? encoding.encode(item.typedCapsule).length : 0)
      || item.tokenDeltaVsBase !== item.injectedTokens - item.baseInjectedTokens);
  }
  const verifiedMetrics = aggregate(cases);
  mismatches.summaryMetrics += Number(!sameMetrics(verifiedMetrics, summary.metrics)
    || summary.cases !== cases.length || summary.index.available !== index.available
    || summary.index.inventories !== index.inventories.length);
  mismatches.forcedFallback += Object.values(summary.forcedFallbackMismatches)
    .reduce((sum, value) => sum + Number(value !== 0), 0);
  const replayedGate = evaluateTypedRefutationValidationDirectGate({
    metrics: verifiedMetrics,
    indexBuildLatencyMs: summary.index.buildLatencyMs,
    forcedFallbackMismatches: summary.forcedFallbackMismatches,
  });
  mismatches.gateReplay += Number(replayedGate.passed !== summary.gate.passed
    || !exact(replayedGate.failedChecks, summary.gate.failedChecks));
  const checks = Object.fromEntries(Object.entries(mismatches).map(([name, count]) =>
    [name, count === 0]));
  checks.runnerGatePassed = summary.gate.passed;
  checks.replayGatePassed = replayedGate.passed;
  checks.d14IndependentValidationPassed = d14Validation.status === "passed";
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const passed = failedChecks.length === 0;
  return {
    validationVersion: "lifecycle-longmemeval-v2-typed-refutation-independent-validation-v1.0",
    sourceProtocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion,
    phase: "validation",
    status: passed ? "passed" : "failed",
    validatorCommit: params.validatorCommit,
    inputSha256,
    replayIndex: {
      inventories: index.inventories.length,
      available: index.available,
      failureReason: index.failureReason,
    },
    cases: cases.length,
    changedContexts: cases.filter((item) => item.contextChanged).length,
    mismatches,
    checks,
    failedChecks,
    answerLevelState: passed ? "admitted_pending" : "not_admitted",
    testState: "unread",
  };
}
