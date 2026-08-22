import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { getEncoding } from "js-tiktoken";
import controlSourceJson from "../protocol.longmemeval-v2-residual-patch-split.v1.json" with { type: "json" };
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type {
  LongMemEvalV2PremiseEvidenceBaselineCase,
  LongMemEvalV2PremiseEvidenceBaselineSummary,
} from "./longmemeval-v2-premise-evidence-baseline-runner.js";
import {
  premiseEvidenceContextSha256,
  selectPremiseEvidenceContext,
} from "./longmemeval-v2-premise-evidence-context.js";
import {
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT,
  premiseEvidenceQuestionIdsForPhase,
  type LongMemEvalV2PremiseEvidencePhase,
} from "./longmemeval-v2-premise-evidence-protocol.js";
import {
  evaluatePremiseEvidenceDirectGate,
  type LongMemEvalV2PremiseEvidenceCase,
  type LongMemEvalV2PremiseEvidenceSummary,
} from "./longmemeval-v2-premise-evidence-runner.js";
import { buildLongMemEvalV2PremiseEvidenceSplit } from "./longmemeval-v2-premise-evidence-split.js";
import {
  buildPremiseEvidenceIndex,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  selectPremiseEvidence,
  type PremiseEvidenceConfig,
  type PremiseEvidenceInventoryKind,
} from "./longmemeval-v2-premise-evidence.js";
import { normalizeLongTaskSupportText } from "./longmemeval-v2-baseline.js";
import { mean, percentile } from "./longmemeval-v2-procedure-baseline-runner.js";

const encoding = getEncoding("cl100k_base");

interface ValidationMismatchCounts {
  baselineIdentity: number;
  candidateIdentity: number;
  questionIdentity: number;
  decisionReplay: number;
  contextReplay: number;
  basePrefix: number;
  exactNoop: number;
  tokenAccounting: number;
  sourceObservation: number;
  sourceWitness: number;
  referenceBoundary: number;
  summaryMetrics: number;
  forcedFallback: number;
  gateReplay: number;
}

export interface LongMemEvalV2PremiseEvidenceIndependentValidation {
  validationVersion: "lifecycle-longmemeval-v2-premise-evidence-independent-validation-v1.0";
  sourceProtocolVersion: string;
  phase: LongMemEvalV2PremiseEvidencePhase;
  status: "passed" | "failed";
  validatorCommit: string;
  inputSha256: {
    baselineCases: string;
    baselineSummary: string;
    candidateCases: string;
    candidateSummary: string;
  };
  replayIndex: {
    buildLatencyMs: number;
    inventories: number;
    available: boolean;
    failureReason: string | null;
  };
  cases: number;
  changedContexts: number;
  independentlyCertifiedWitnesses: number;
  mismatches: ValidationMismatchCounts;
  checks: Record<string, boolean>;
  failedChecks: string[];
  nextPhaseState: "unread";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactIds<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function approx(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function firstQuoted(value: string): string {
  const match = /['"]([^'"]+)['"]/u.exec(value);
  return match?.[1]?.trim() ?? "";
}

function capsuleInventory(capsule: string): {
  kind: PremiseEvidenceInventoryKind;
  labels: string[];
} | null {
  const match = /Observed ordered (tabs|list|columns) in "[^"]*": ([^\n]+)\.\n/u.exec(capsule);
  if (!match) return null;
  const labels = [...match[2].matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
  return labels.length ? { kind: match[1] as PremiseEvidenceInventoryKind, labels } : null;
}

function independentSourceLabels(params: {
  observation: string;
  sourceLines: number[];
  kind: PremiseEvidenceInventoryKind;
}): string[] {
  const start = Math.min(...params.sourceLines);
  const end = Math.max(...params.sourceLines);
  const parsed = params.observation.split("\n").slice(start, end + 1).map((line) => {
    const withoutId = line.trim().replace(/^\[[^\]]+\]\s*/u, "");
    const match = /^([A-Za-z][A-Za-z0-9]*)\b(.*)$/u.exec(withoutId);
    return { role: match?.[1]?.toLowerCase() ?? "", label: firstQuoted(match?.[2] ?? "") };
  }).filter((item) => item.label);
  if (params.kind === "tabs") return parsed.filter((item) => item.role === "tab").map((item) => item.label);
  if (params.kind === "columns") {
    const headers = parsed.filter((item) => item.role === "columnheader").map((item) => item.label);
    return headers.length >= 2 ? headers
      : parsed.filter((item) => item.role === "gridcell").map((item) => item.label);
  }
  const semanticRoles = new Set(["button", "link", "tab", "textbox", "searchbox", "combobox", "checkbox"]);
  const semantic = parsed.filter((item) => semanticRoles.has(item.role)).map((item) => item.label);
  return semantic.length ? semantic : parsed.filter((item) => item.role === "statictext").map((item) => item.label);
}

function independentWitness(params: {
  item: LongMemEvalV2PremiseEvidenceCase;
  observation: string;
}): boolean {
  if (!params.item.capsule || !params.item.operator || params.item.anchors.length === 0
    || params.item.sourceLines.length === 0) return false;
  const parsed = capsuleInventory(params.item.capsule);
  if (!parsed) return false;
  const source = independentSourceLabels({
    observation: params.observation,
    sourceLines: params.item.sourceLines,
    kind: parsed.kind,
  }).map(normalizeLongTaskSupportText);
  const capsule = parsed.labels.map(normalizeLongTaskSupportText);
  if (!exactIds(source, capsule)) return false;
  const anchors = params.item.anchors.map(normalizeLongTaskSupportText);
  if (params.item.operator === "between_adjacent") {
    const left = source.indexOf(anchors[0]);
    const right = source.indexOf(anchors[1]);
    return left >= 0 && right >= 0 && Math.abs(left - right) === 1
      && /are adjacent; no recorded item is between them\./u.test(params.item.capsule);
  }
  if (params.item.operator === "boundary_after") {
    return source.at(-1) === anchors[0]
      && /no recorded item follows it\./u.test(params.item.capsule);
  }
  return source[0] === anchors[0]
    && /no recorded item precedes it\./u.test(params.item.capsule);
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
    throw new Error("D14 validator generated split differs from frozen split");
  }
}

export async function validateLongMemEvalV2PremiseEvidence(params: {
  dataRoot: string;
  phase: LongMemEvalV2PremiseEvidencePhase;
  validatorCommit: string;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  candidateCasesPath: string;
  candidateSummaryPath: string;
}): Promise<LongMemEvalV2PremiseEvidenceIndependentValidation> {
  if (!/^[0-9a-f]{7,40}$/u.test(params.validatorCommit)) {
    throw new Error("D14 validatorCommit must be a git SHA");
  }
  const [baselineCasesText, baselineSummaryText, candidateCasesText, candidateSummaryText] = await Promise.all([
    readFile(params.baselineCasesPath, "utf8"), readFile(params.baselineSummaryPath, "utf8"),
    readFile(params.candidateCasesPath, "utf8"), readFile(params.candidateSummaryPath, "utf8"),
  ]);
  const baselineCases = baselineCasesText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceBaselineCase);
  const baselineSummary = JSON.parse(baselineSummaryText) as LongMemEvalV2PremiseEvidenceBaselineSummary;
  const candidateCases = candidateCasesText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceCase);
  const candidateSummary = JSON.parse(candidateSummaryText) as LongMemEvalV2PremiseEvidenceSummary;
  const hashes = {
    baselineCases: sha256(baselineCasesText), baselineSummary: sha256(baselineSummaryText),
    candidateCases: sha256(candidateCasesText), candidateSummary: sha256(candidateSummaryText),
  };
  const expected = premiseEvidenceQuestionIdsForPhase(params.phase);
  const baselineById = new Map(baselineCases.map((item) => [item.questionId, item]));
  const candidateById = new Map(candidateCases.map((item) => [item.questionId, item]));
  const mismatches: ValidationMismatchCounts = {
    baselineIdentity: 0, candidateIdentity: 0, questionIdentity: 0, decisionReplay: 0,
    contextReplay: 0, basePrefix: 0, exactNoop: 0, tokenAccounting: 0,
    sourceObservation: 0, sourceWitness: 0, referenceBoundary: 0, summaryMetrics: 0,
    forcedFallback: 0, gateReplay: 0,
  };
  mismatches.baselineIdentity += Number(
    baselineSummary.protocolVersion !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.protocolVersion
      || baselineSummary.phase !== params.phase || baselineSummary.casesSha256 !== hashes.baselineCases
      || baselineSummary.cases !== baselineCases.length,
  );
  mismatches.candidateIdentity += Number(
    candidateSummary.protocolVersion !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.protocolVersion
      || candidateSummary.phase !== params.phase || candidateSummary.casesSha256 !== hashes.candidateCases
      || candidateSummary.cases !== candidateCases.length
      || candidateSummary.baselineArtifact.casesSha256 !== hashes.baselineCases
      || candidateSummary.baselineArtifact.summarySha256 !== hashes.baselineSummary,
  );
  mismatches.questionIdentity += Number(
    !exactIds([...baselineById.keys()].sort(), expected.map((item) => item.id).sort())
      || !exactIds([...candidateById.keys()].sort(), expected.map((item) => item.id).sort()),
  );

  const protocol = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL;
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
  const questionById = new Map(questions.map((item) => [item.id, item]));
  const selectedQuestions = expected.map(({ id }) => questionById.get(id)!);
  const trajectories = await adapter.loadTrajectories([...new Set(selectedQuestions.flatMap((item) =>
    item.trajectoryIds))]);
  const trajectoryById = new Map(trajectories.map((item) => [item.id, item]));
  const indexStartedAt = performance.now();
  const index = buildPremiseEvidenceIndex({
    trajectories,
    config: activeIndexConfig(),
    scopeAdapter: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  });
  const replayIndexBuildLatencyMs = performance.now() - indexStartedAt;
  let certified = 0;
  for (const { id, label } of expected) {
    const question = questionById.get(id);
    const baseline = baselineById.get(id);
    const candidate = candidateById.get(id);
    if (!question || !baseline || !candidate || baseline.label !== label || candidate.label !== label
      || baseline.questionSha256 !== sha256(question.prompt)
      || candidate.questionSha256 !== sha256(question.prompt)) {
      mismatches.questionIdentity += 1;
      continue;
    }
    const decision = selectPremiseEvidence({ question, index });
    if (candidate.usedPremiseEvidence !== decision.usedPremiseEvidence
      || candidate.inventoryId !== decision.inventoryId
      || candidate.operator !== decision.operator
      || !exactIds(candidate.anchors, decision.anchors)
      || candidate.capsule !== decision.capsule
      || !exactIds(candidate.sourceLines, decision.sourceLines)) {
      mismatches.decisionReplay += 1;
    }
    const replay = selectPremiseEvidenceContext({
      baseline: {
        items: baseline.injected,
        injectedTokens: baseline.injectedTokens,
        tokenViolation: baseline.tokenViolation,
      },
      question,
      index,
      policy: {
        enabled: true,
        maxCapsuleTokens: protocol.candidate.maxCapsuleTokens,
        maxCandidateItems: protocol.candidate.maxCandidateItems,
        maxCandidateTokens: protocol.candidate.maxCandidateTokens,
        maxSelectionLatencyMs: protocol.candidate.maxSelectionLatencyMs,
      },
      testHooks: { now: () => 0 },
    });
    if (replay.contextSha256 !== candidate.contextSha256
      || !exactIds(replay.items.map((item) => item.id), candidate.injectedIds)) {
      mismatches.contextReplay += 1;
    }
    mismatches.basePrefix += candidate.baseInjectedIds.filter((baseId, indexPosition) =>
      baseId !== candidate.injected[indexPosition]?.id
      || baseline.injected[indexPosition]?.content !== candidate.injected[indexPosition]?.content
      || baseline.injected[indexPosition]?.tokenCount !== candidate.injected[indexPosition]?.tokenCount).length;
    if (!candidate.contextChanged && candidate.contextSha256 !== candidate.baseContextSha256) {
      mismatches.exactNoop += 1;
    }
    const independentlyCountedTokens = candidate.injected.reduce((sum, item) =>
      sum + encoding.encode(item.content).length, 0);
    if (independentlyCountedTokens !== candidate.injectedTokens
      || candidate.contextSha256 !== premiseEvidenceContextSha256(candidate.injected)) {
      mismatches.tokenAccounting += 1;
    }
    if (candidate.usedPremiseEvidence) {
      const trajectory = candidate.sourceTrajectoryId
        ? trajectoryById.get(candidate.sourceTrajectoryId) : undefined;
      const state = trajectory?.states.find((item) => item.index === candidate.sourceStateIndex);
      if (!state || sha256(state.observation) !== candidate.sourceObservationSha256) {
        mismatches.sourceObservation += 1;
      } else if (!independentWitness({ item: candidate, observation: state.observation })) {
        mismatches.sourceWitness += 1;
      } else certified += 1;
      if (label !== "premise" || candidate.referenceConclusionAgreement !== true) {
        mismatches.referenceBoundary += 1;
      }
    } else if (candidate.referenceConclusionAgreement !== null) {
      mismatches.referenceBoundary += 1;
    }
  }

  const premise = candidateCases.filter((item) => item.label === "premise");
  const controls = candidateCases.filter((item) => item.label === "control");
  const challenged = premise.filter((item) => item.usedPremiseEvidence);
  const valid = challenged.filter((item) => item.referenceConclusionAgreement === true);
  const controlChallenges = controls.filter((item) => item.usedPremiseEvidence).length;
  const baseMean = mean(candidateCases.map((item) => item.baseInjectedTokens));
  const candidateMean = mean(candidateCases.map((item) => item.injectedTokens));
  const summaryMetricChecks = [
    candidateSummary.metrics.premiseQuestions === premise.length,
    candidateSummary.metrics.controlQuestions === controls.length,
    candidateSummary.metrics.premiseChallenges === challenged.length,
    candidateSummary.metrics.validPremiseChallenges === valid.length,
    candidateSummary.metrics.invalidPremiseChallenges === challenged.length - valid.length,
    candidateSummary.metrics.controlChallenges === controlChallenges,
    candidateSummary.metrics.changedContexts === candidateCases.filter((item) => item.contextChanged).length,
    approx(candidateSummary.metrics.meanBaseInjectedTokens, baseMean),
    approx(candidateSummary.metrics.meanInjectedTokens, candidateMean),
    approx(candidateSummary.metrics.selectionLatencyP95Ms,
      percentile(candidateCases.map((item) => item.selectionLatencyMs), 0.95)),
  ];
  mismatches.summaryMetrics += summaryMetricChecks.filter((value) => !value).length;
  mismatches.forcedFallback += Object.values(candidateSummary.forcedFallbackMismatches)
    .reduce((sum, value) => sum + value, 0);
  const replayedGate = evaluatePremiseEvidenceDirectGate({
    metrics: candidateSummary.metrics,
    indexBuildLatencyMs: candidateSummary.index.buildLatencyMs,
    forcedFallbackMismatches: candidateSummary.forcedFallbackMismatches,
  });
  mismatches.gateReplay += Number(replayedGate.passed !== candidateSummary.gate.passed
    || !exactIds(replayedGate.failedChecks, candidateSummary.gate.failedChecks));
  const checks = Object.fromEntries(Object.entries(mismatches).map(([name, value]) => [name, value === 0]));
  checks.protocolStatus = candidateSummary.gate.passed
    && candidateSummary.status === `${params.phase}_direct_passed`;
  checks.indexAvailable = index.available;
  checks.witnessCoverage = certified === candidateSummary.metrics.validPremiseChallenges;
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    validationVersion: "lifecycle-longmemeval-v2-premise-evidence-independent-validation-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    phase: params.phase,
    status: failedChecks.length === 0 ? "passed" : "failed",
    validatorCommit: params.validatorCommit,
    inputSha256: hashes,
    replayIndex: {
      buildLatencyMs: replayIndexBuildLatencyMs,
      inventories: index.inventories.length,
      available: index.available,
      failureReason: index.failureReason,
    },
    cases: candidateCases.length,
    changedContexts: candidateCases.filter((item) => item.contextChanged).length,
    independentlyCertifiedWitnesses: certified,
    mismatches,
    checks,
    failedChecks,
    nextPhaseState: "unread",
  };
}
