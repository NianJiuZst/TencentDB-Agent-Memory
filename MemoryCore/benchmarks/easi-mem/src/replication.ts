import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  packCandidates,
  rerankCandidates,
  selectRecallProfile,
  validateAdaptiveRecallPolicy,
  type RecallCandidate,
  type RecallProfile,
} from "../../../src/core/adaptive-recall/index.js";
import { LoCoMoAdapter } from "./adapters/locomo.js";
import { MemoryCoreL0FtsBackend } from "./backends/memorycore-l0.js";
import {
  aggregateResults,
  pairedClusterBootstrapCi,
  scoreCandidates,
} from "./metrics.js";
import { PROTOCOL } from "./protocol.js";
import type { AggregateMetrics, ArmCaseResult, EvalCase } from "./types.js";

const EXPECTED_DATASET_SHA256 = "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4";
const EXPECTED_FROZEN_POLICY_SHA256 = "75f707baee0d23aa38746c183b1ef88f613e358d22a15a0d78f79d46fc38429f";

export interface ReplicationOptions {
  datasetPath: string;
  policyPath: string;
  outputDir: string;
  allowChecksumMismatch?: boolean;
}

function candidatesForProfile(
  candidates: RecallCandidate[],
  profile: RecallProfile,
  baseline: RecallProfile,
): RecallCandidate[] {
  const pool = candidates.slice(0, profile.candidateLimit);
  if (profile.name === baseline.name) return pool.slice(0, profile.resultLimit);
  return packCandidates(
    rerankCandidates(pool, profile),
    profile,
    undefined,
    candidates.slice(0, baseline.resultLimit),
  ).candidates;
}

function armResult(
  evalCase: EvalCase,
  profile: RecallProfile,
  candidates: RecallCandidate[],
  queryLatencyMs: number,
): ArmCaseResult {
  return {
    caseId: evalCase.id,
    category: evalCase.category,
    split: evalCase.abstention ? "abstention" : "test",
    profile: profile.name,
    candidateIds: candidates.map((candidate) => candidate.id),
    sourceSessionIds: candidates.map((candidate) => candidate.sourceId).filter((id): id is string => !!id),
    queryLatencyMs,
    metrics: scoreCandidates(candidates, evalCase.goldTurnIds, evalCase.goldSessionIds),
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function aggregateByCategory(results: ArmCaseResult[]): Record<string, AggregateMetrics> {
  const categories = [...new Set(results.map((result) => result.category))].sort();
  return Object.fromEntries(categories.map((category) => [
    category,
    aggregateResults(results.filter((result) => result.category === category), new Map()),
  ]));
}

function comparisonSummary(
  adaptive: ArmCaseResult[],
  baseline: ArmCaseResult[],
  groupByCaseId: Map<string, string>,
  seedOffset: number,
) {
  const baseAggregate = aggregateResults(baseline, new Map());
  const adaptiveAggregate = aggregateResults(adaptive, new Map());
  const baseMeanTokens = baseAggregate.meanInjectedTokens;
  const recallCi = pairedClusterBootstrapCi(
    adaptive,
    baseline,
    groupByCaseId,
    (left, right) => left.metrics.macroSessionRecall - right.metrics.macroSessionRecall,
    PROTOCOL.bootstrapSamples,
    PROTOCOL.seed + seedOffset,
  );
  const tokenCi = pairedClusterBootstrapCi(
    adaptive,
    baseline,
    groupByCaseId,
    (left, right) => left.metrics.injectedTokens - right.metrics.injectedTokens,
    PROTOCOL.bootstrapSamples,
    PROTOCOL.seed + seedOffset + 1,
  );
  const utilityCi = pairedClusterBootstrapCi(
    adaptive,
    baseline,
    groupByCaseId,
    (left, right) => {
      const recallDelta = left.metrics.macroSessionRecall - right.metrics.macroSessionRecall;
      const tokenSaving = right.metrics.injectedTokens - left.metrics.injectedTokens;
      return recallDelta + PROTOCOL.promotion.tokenPenalty * (baseMeanTokens > 0 ? tokenSaving / baseMeanTokens : 0);
    },
    PROTOCOL.bootstrapSamples,
    PROTOCOL.seed + seedOffset + 2,
  );
  const tokenReduction = baseMeanTokens > 0
    ? (baseMeanTokens - adaptiveAggregate.meanInjectedTokens) / baseMeanTokens
    : 0;
  const checks = {
    macroRecallCiWithinGuard: recallCi.lower >= -PROTOCOL.promotion.maxMacroRecallRegression,
    recallAnyWithinGuard: adaptiveAggregate.recallAnySession
      >= baseAggregate.recallAnySession - PROTOCOL.promotion.maxMacroRecallRegression,
    recallAllWithinGuard: adaptiveAggregate.recallAllSessions
      >= baseAggregate.recallAllSessions - PROTOCOL.promotion.maxMacroRecallRegression,
    tokenReduction: tokenReduction >= PROTOCOL.promotion.minTokenReduction,
    tokenReductionConfidence: tokenCi.upper < 0,
    utilityConfidence: utilityCi.lower > PROTOCOL.promotion.minUtilityCiLowerBound,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    base: baseAggregate,
    adaptive: adaptiveAggregate,
    deltas: {
      macroSessionRecall: recallCi,
      injectedTokens: tokenCi,
      utility: utilityCi,
      tokenReduction,
    },
    checks,
  };
}

function empiricalUtility(adaptive: ArmCaseResult[], baseline: ArmCaseResult[]): number {
  const baselineById = new Map(baseline.map((result) => [result.caseId, result]));
  const baselineTokens = mean(baseline.map((result) => result.metrics.injectedTokens));
  return mean(adaptive.map((result) => {
    const reference = baselineById.get(result.caseId);
    if (!reference) return 0;
    const recallDelta = result.metrics.macroSessionRecall - reference.metrics.macroSessionRecall;
    const tokenSaving = reference.metrics.injectedTokens - result.metrics.injectedTokens;
    return recallDelta + PROTOCOL.promotion.tokenPenalty * (baselineTokens > 0 ? tokenSaving / baselineTokens : 0);
  }));
}

function selectCrossFittedResults(
  resultsByProfile: Map<string, ArmCaseResult[]>,
  groupByCaseId: Map<string, string>,
): { results: ArmCaseResult[]; selectedByGroup: Record<string, string>; trainingDiagnostics: Record<string, unknown> } {
  const baselineResults = resultsByProfile.get(PROTOCOL.baselineProfile.name)!;
  const groups = [...new Set(groupByCaseId.values())].sort();
  const selectedByGroup: Record<string, string> = {};
  const trainingDiagnostics: Record<string, unknown> = {};
  const heldOutResults: ArmCaseResult[] = [];

  for (const heldOutGroup of groups) {
    const trainBase = baselineResults.filter((result) => groupByCaseId.get(result.caseId) !== heldOutGroup);
    const baseAggregate = aggregateResults(trainBase, new Map());
    const candidates = PROTOCOL.profiles.flatMap((profile) => {
      if (profile.name === PROTOCOL.baselineProfile.name) return [];
      const trainResults = resultsByProfile.get(profile.name)!
        .filter((result) => groupByCaseId.get(result.caseId) !== heldOutGroup);
      const aggregate = aggregateResults(trainResults, new Map());
      const tokenReduction = baseAggregate.meanInjectedTokens > 0
        ? (baseAggregate.meanInjectedTokens - aggregate.meanInjectedTokens) / baseAggregate.meanInjectedTokens
        : 0;
      const utility = empiricalUtility(trainResults, trainBase);
      const eligible = aggregate.macroSessionRecall
          >= baseAggregate.macroSessionRecall - PROTOCOL.promotion.maxMacroRecallRegression
        && aggregate.recallAnySession
          >= baseAggregate.recallAnySession - PROTOCOL.promotion.maxMacroRecallRegression
        && aggregate.recallAllSessions
          >= baseAggregate.recallAllSessions - PROTOCOL.promotion.maxMacroRecallRegression
        && tokenReduction >= PROTOCOL.promotion.minTokenReduction
        && utility > 0;
      return [{ profile: profile.name, aggregate, tokenReduction, utility, eligible }];
    });
    const selected = candidates
      .filter((candidate) => candidate.eligible)
      .sort((left, right) => right.utility - left.utility
        || right.aggregate.macroSessionRecall - left.aggregate.macroSessionRecall
        || left.aggregate.meanInjectedTokens - right.aggregate.meanInjectedTokens)[0];
    const selectedName = selected?.profile ?? PROTOCOL.baselineProfile.name;
    selectedByGroup[heldOutGroup] = selectedName;
    trainingDiagnostics[heldOutGroup] = {
      selectedProfile: selectedName,
      eligibleProfiles: candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.profile),
    };
    heldOutResults.push(
      ...resultsByProfile.get(selectedName)!
        .filter((result) => groupByCaseId.get(result.caseId) === heldOutGroup),
    );
  }
  return { results: heldOutResults, selectedByGroup, trainingDiagnostics };
}

export async function runLoCoMoReplication(options: ReplicationOptions) {
  const adapter = new LoCoMoAdapter();
  const loaded = await adapter.load(options.datasetPath);
  const policyRaw = await readFile(options.policyPath);
  const policySha256 = createHash("sha256").update(policyRaw).digest("hex");
  if (!options.allowChecksumMismatch) {
    if (loaded.description.sha256 !== EXPECTED_DATASET_SHA256) {
      throw new Error(`LoCoMo checksum mismatch: ${loaded.description.sha256}`);
    }
    if (policySha256 !== EXPECTED_FROZEN_POLICY_SHA256) {
      throw new Error(`frozen policy checksum mismatch: ${policySha256}`);
    }
  }
  const policy = validateAdaptiveRecallPolicy(JSON.parse(policyRaw.toString("utf8")));
  if (!("profile" in policy.router)) throw new Error("external replication requires a frozen global policy leaf");
  const selectedProfile = selectRecallProfile(policy, {
    queryChars: 0, queryTokens: 0, temporalCueCount: 0, updateCueCount: 0,
    multiHopCueCount: 0, digitCount: 0, entityLikeTokenCount: 0,
    documentCount: 0, scoutResultCount: 0, topScoreGap: 0, scoreDecay5: 0,
    uniqueSourceRatio5: 0, meanCandidateTokens5: 0,
  });
  const baseline = PROTOCOL.baselineProfile;
  const backend = new MemoryCoreL0FtsBackend();
  const resultsByProfile = new Map(PROTOCOL.profiles.map((profile) => [profile.name, [] as ArmCaseResult[]]));
  const negativeByProfile = new Map(PROTOCOL.profiles.map((profile) => [profile.name, [] as ArmCaseResult[]]));
  const groupByCaseId = new Map<string, string>();
  const allGroupByCaseId = new Map<string, string>();

  for (let index = 0; index < loaded.cases.length; index += 1) {
    const evalCase = loaded.cases[index];
    const backendResult = await backend.indexAndSearch(
      evalCase,
      PROTOCOL.profiles.map((profile) => profile.candidateLimit),
    );
    allGroupByCaseId.set(evalCase.id, evalCase.groupId);
    for (const profile of PROTOCOL.profiles) {
      const candidates = candidatesForProfile(backendResult.candidates, profile, baseline);
      const result = armResult(
        evalCase,
        profile,
        candidates,
        backendResult.queryLatencyByLimit[String(profile.candidateLimit)] ?? backendResult.queryLatencyMs,
      );
      (evalCase.abstention ? negativeByProfile : resultsByProfile).get(profile.name)!.push(result);
    }
    if (!evalCase.abstention) groupByCaseId.set(evalCase.id, evalCase.groupId);
    if ((index + 1) % 100 === 0 || index + 1 === loaded.cases.length) {
      process.stdout.write(`LoCoMo indexed and searched ${index + 1}/${loaded.cases.length}\n`);
    }
  }

  const baseResults = resultsByProfile.get(baseline.name)!;
  const frozenResults = resultsByProfile.get(selectedProfile.name)!;
  const frozenComparison = comparisonSummary(frozenResults, baseResults, groupByCaseId, 101);
  const crossFitted = selectCrossFittedResults(resultsByProfile, groupByCaseId);
  const crossFittedComparison = comparisonSummary(crossFitted.results, baseResults, groupByCaseId, 201);
  const negativeBase = negativeByProfile.get(baseline.name)!;
  const negativeFrozen = negativeByProfile.get(selectedProfile.name)!;
  const negativeCrossFitted = [...allGroupByCaseId.values()].length === 0
    ? []
    : [...negativeBase].flatMap((baseResult) => {
      const group = allGroupByCaseId.get(baseResult.caseId)!;
      const selectedName = crossFitted.selectedByGroup[group];
      return negativeByProfile.get(selectedName)?.filter((result) => result.caseId === baseResult.caseId) ?? [];
    });
  const overallStatus = frozenComparison.passed && crossFittedComparison.passed
    ? "passed"
    : crossFittedComparison.passed ? "mixed" : "failed";
  const report = {
    status: overallStatus,
    protocolVersion: `${PROTOCOL.protocolVersion}-locomo-external`,
    generatedAt: new Date().toISOString(),
    dataset: loaded.description,
    frozenPolicy: {
      revision: policy.revision,
      sha256: policySha256,
      selectedProfile: selectedProfile.name,
    },
    run: {
      totalCases: loaded.cases.length,
      evidenceCases: baseResults.length,
      negativeLoadCases: negativeBase.length,
      dependencyClusters: new Set(loaded.cases.map((evalCase) => evalCase.groupId)).size,
    },
    frozenTransfer: {
      ...frozenComparison,
      byCategory: {
        base: aggregateByCategory(baseResults),
        adaptive: aggregateByCategory(frozenResults),
      },
    },
    crossFittedCalibration: {
      ...crossFittedComparison,
      selectedByGroup: crossFitted.selectedByGroup,
      trainingDiagnostics: crossFitted.trainingDiagnostics,
      validityNote: "Exploratory leave-one-conversation-out calibration designed after observing the frozen-transfer failure; each held-out prediction uses labels from the other nine conversations only.",
    },
    arms: Object.fromEntries(PROTOCOL.profiles.map((profile) => [
      profile.name,
      aggregateResults(resultsByProfile.get(profile.name)!, new Map()),
    ])),
    negativeLoad: {
      cases: negativeBase.length,
      baseMeanInjectedItems: mean(negativeBase.map((result) => result.metrics.injectedItems)),
      frozenMeanInjectedItems: mean(negativeFrozen.map((result) => result.metrics.injectedItems)),
      crossFittedMeanInjectedItems: mean(negativeCrossFitted.map((result) => result.metrics.injectedItems)),
      baseMeanInjectedTokens: mean(negativeBase.map((result) => result.metrics.injectedTokens)),
      frozenMeanInjectedTokens: mean(negativeFrozen.map((result) => result.metrics.injectedTokens)),
      crossFittedMeanInjectedTokens: mean(negativeCrossFitted.map((result) => result.metrics.injectedTokens)),
    },
  };

  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(
      path.join(options.outputDir, "cases.jsonl"),
      `${[
        ...[...resultsByProfile.values()].flat(),
        ...[...negativeByProfile.values()].flat(),
      ].map((result) => JSON.stringify(result)).join("\n")}\n`,
      "utf8",
    ),
  ]);
  return report;
}
