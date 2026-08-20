import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  rerankCandidates,
  packCandidates,
  selectRecallProfile,
  validateAdaptiveRecallPolicy,
  type AdaptiveRecallPolicy,
  type RecallCandidate,
  type RecallDecisionLog,
  type RecallProfile,
} from "../../../src/core/adaptive-recall/index.js";
import { MemoryCoreL0FtsBackend } from "./backends/memorycore-l0.js";
import { LongMemEvalAdapter } from "./adapters/longmemeval.js";
import {
  aggregateResults,
  meanUtilityDelta,
  pairedBootstrapCi,
  scoreCandidates,
} from "./metrics.js";
import { PROTOCOL } from "./protocol.js";
import { trainDecisionTree, type TrainingExample } from "./tree.js";
import type {
  AdaptiveCaseResult,
  AggregateMetrics,
  ArmCaseResult,
  CachedCaseResult,
  DatasetDescription,
  EvalCase,
  SplitName,
  TrainedRouter,
} from "./types.js";

const EXPECTED_DATASET_SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";

export interface RunOptions {
  datasetPath: string;
  outputDir: string;
  maxCases?: number;
  allowDatasetMismatch?: boolean;
}

interface ExperimentReport {
  status: "passed" | "failed" | "exploratory";
  protocolVersion: string;
  generatedAt: string;
  dataset: DatasetDescription;
  source: { memoryCoreBaseRevision: string; branch: string };
  run: {
    casesLoaded: number;
    retrievalCases: number;
    abstentionCases: number;
    splitCounts: Record<SplitName, number>;
    exploratory: boolean;
  };
  selected: {
    bestStaticProfile: string;
    router: TrainedRouter;
    policyRevision: string;
  };
  dev: {
    arms: Record<string, AggregateMetrics>;
    adaptive: AggregateMetrics;
  };
  test: {
    arms: Record<string, AggregateMetrics>;
    base: AggregateMetrics;
    bestStatic: AggregateMetrics;
    adaptive: AggregateMetrics;
    deltasVsBestStatic: {
      macroSessionRecall: ReturnType<typeof pairedBootstrapCi>;
      injectedTokens: ReturnType<typeof pairedBootstrapCi>;
      utility: ReturnType<typeof pairedBootstrapCi>;
      tokenReduction: number;
    };
    deltasBestStaticVsBase: {
      macroSessionRecall: ReturnType<typeof pairedBootstrapCi>;
      injectedTokens: ReturnType<typeof pairedBootstrapCi>;
      utility: ReturnType<typeof pairedBootstrapCi>;
      tokenReduction: number;
    };
  };
  promotion: {
    evaluated: boolean;
    passed: boolean;
    checks: Record<string, boolean>;
    contextual: {
      passed: boolean;
      checks: Record<string, boolean>;
    };
  };
  abstention: {
    cases: number;
    baseMeanInjectedItems: number;
    adaptiveMeanInjectedItems: number;
  };
}

function stableHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function assignSplits(cases: EvalCase[]): Map<string, SplitName> {
  const assignments = new Map<string, SplitName>();
  const groups = new Map<string, EvalCase[]>();
  for (const evalCase of cases) {
    if (evalCase.abstention) {
      assignments.set(evalCase.id, "abstention");
      continue;
    }
    const group = groups.get(evalCase.category) ?? [];
    group.push(evalCase);
    groups.set(evalCase.category, group);
  }

  for (const group of groups.values()) {
    group.sort((left, right) => stableHash(`${PROTOCOL.seed}:${left.id}`).localeCompare(stableHash(`${PROTOCOL.seed}:${right.id}`)));
    const trainEnd = Math.floor(group.length * PROTOCOL.split.train);
    const devEnd = trainEnd + Math.floor(group.length * PROTOCOL.split.dev);
    group.forEach((evalCase, index) => {
      assignments.set(evalCase.id, index < trainEnd ? "train" : index < devEnd ? "dev" : "test");
    });
  }
  return assignments;
}

function chooseCases(cases: EvalCase[], maxCases?: number): EvalCase[] {
  if (!maxCases || maxCases >= cases.length) return cases;
  return [...cases]
    .sort((left, right) => stableHash(`smoke:${PROTOCOL.seed}:${left.id}`).localeCompare(stableHash(`smoke:${PROTOCOL.seed}:${right.id}`)))
    .slice(0, maxCases);
}

function profileCandidates(cache: CachedCaseResult, profile: RecallProfile): RecallCandidate[] {
  const pool = cache.candidates.slice(0, profile.candidateLimit);
  if (profile.name === PROTOCOL.baselineProfile.name) return pool.slice(0, profile.resultLimit);
  return packCandidates(
    rerankCandidates(pool, profile),
    profile,
    undefined,
    cache.candidates.slice(0, PROTOCOL.baselineProfile.resultLimit),
  ).candidates;
}

function effectiveTokenBudget(cache: CachedCaseResult, profile: RecallProfile): number {
  if (profile.baselineTokenRatio === undefined) return profile.tokenBudget;
  const baselineTokens = cache.candidates
    .slice(0, PROTOCOL.baselineProfile.resultLimit)
    .reduce((sum, candidate) => sum + (candidate.tokenCount ?? 0), 0);
  return Math.min(profile.tokenBudget, Math.max(1, Math.floor(baselineTokens * profile.baselineTokenRatio)));
}

function evaluateArm(cache: CachedCaseResult, profile: RecallProfile): ArmCaseResult {
  const candidates = profileCandidates(cache, profile);
  return {
    caseId: cache.caseId,
    category: cache.category,
    split: cache.split,
    profile: profile.name,
    candidateIds: candidates.map((candidate) => candidate.id),
    sourceSessionIds: candidates.map((candidate) => candidate.sourceId).filter((id): id is string => !!id),
    queryLatencyMs: cache.queryLatencyByLimit[String(profile.candidateLimit)] ?? cache.queryLatencyMs,
    metrics: scoreCandidates(candidates, cache.goldTurnIds, cache.goldSessionIds),
  };
}

function compareQuality(left: ArmCaseResult, right: ArmCaseResult): number {
  const fields: Array<keyof ArmCaseResult["metrics"]> = [
    "recallAllSessions", "macroSessionRecall", "recallAnySession", "ndcgSessions",
  ];
  for (const field of fields) {
    const delta = Number(left.metrics[field]) - Number(right.metrics[field]);
    if (Math.abs(delta) > 1e-12) return delta;
  }
  return right.metrics.injectedTokens - left.metrics.injectedTokens;
}

function labelFromArms(arms: ArmCaseResult[], profileOrder: string[]): string {
  const order = new Map(profileOrder.map((name, index) => [name, index]));
  return [...arms]
    .sort((left, right) => compareQuality(right, left) || (order.get(left.profile) ?? 999) - (order.get(right.profile) ?? 999))[0].profile;
}

function adaptiveResults(
  cases: CachedCaseResult[],
  policy: AdaptiveRecallPolicy,
): AdaptiveCaseResult[] {
  return cases.map((cache) => {
    const profile = selectRecallProfile(policy, cache.features);
    const arm = evaluateArm(cache, profile);
    const decision: RecallDecisionLog = {
      mode: profile.name === PROTOCOL.baselineProfile.name ? "base" : "adaptive",
      policyRevision: policy.revision,
      selectedProfile: profile.name,
      candidateLimit: profile.candidateLimit,
      resultLimit: profile.resultLimit,
      tokenBudget: effectiveTokenBudget(cache, profile),
      returnedItems: arm.metrics.injectedItems,
      returnedTokens: arm.metrics.injectedTokens,
      fallback: false,
      latencyMs: arm.queryLatencyMs,
    };
    return { ...arm, profile: "adaptive", selectedProfile: profile.name, decision };
  });
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pickBestStatic(devAggregates: Record<string, AggregateMetrics>): string {
  const entries = Object.entries(devAggregates);
  const maxRecall = Math.max(...entries.map(([, metrics]) => metrics.macroSessionRecall));
  return entries
    .filter(([, metrics]) => metrics.macroSessionRecall >= maxRecall - 0.005)
    .sort((left, right) => left[1].meanInjectedTokens - right[1].meanInjectedTokens
      || right[1].recallAllSessions - left[1].recallAllSessions
      || left[0].localeCompare(right[0]))[0][0];
}

function selectRouter(
  trainExamples: TrainingExample[],
  devCases: CachedCaseResult[],
  devBestStatic: ArmCaseResult[],
  cacheMap: Map<string, CachedCaseResult>,
  profileOrder: string[],
): { router: TrainedRouter; policy: AdaptiveRecallPolicy; results: AdaptiveCaseResult[] } {
  const baselineTokens = mean(devBestStatic.map((result) => result.metrics.injectedTokens));
  const fallbackProfile = devBestStatic[0].profile;
  const bestStaticAggregate = aggregateResults(devBestStatic, cacheMap);
  const candidates = PROTOCOL.routerGrid.map((params) => {
    const router = trainDecisionTree(
      trainExamples,
      profileOrder,
      params.maxDepth,
      params.minLeaf,
      fallbackProfile,
      params.minConfidence,
    );
    const revision = `candidate-${params.maxDepth}-${params.minLeaf}-${params.minConfidence}`;
    const policy = validateAdaptiveRecallPolicy({
      schemaVersion: 1,
      revision,
      createdAt: "2026-08-20T00:00:00.000Z",
      defaultProfile: PROTOCOL.baselineProfile.name,
      profiles: PROTOCOL.profiles,
      router: router.router,
    });
    const results = adaptiveResults(devCases, policy);
    const aggregate = aggregateResults(results, cacheMap);
    const utility = meanUtilityDelta(results, devBestStatic, baselineTokens, PROTOCOL.promotion.tokenPenalty);
    const eligible = aggregate.macroSessionRecall >= bestStaticAggregate.macroSessionRecall - PROTOCOL.promotion.maxMacroRecallRegression
      && aggregate.recallAnySession >= bestStaticAggregate.recallAnySession - PROTOCOL.promotion.maxMacroRecallRegression
      && aggregate.recallAllSessions >= bestStaticAggregate.recallAllSessions - PROTOCOL.promotion.maxMacroRecallRegression;
    return { router, policy, results, aggregate, utility, eligible };
  });

  const fallbackRouter: TrainedRouter = {
    router: { profile: fallbackProfile },
    maxDepth: 0,
    minLeaf: 0,
    minConfidence: 1,
    fallbackProfile,
    trainAccuracy: trainExamples.filter((example) => example.label === fallbackProfile).length / trainExamples.length,
  };
  const fallbackPolicy = validateAdaptiveRecallPolicy({
    schemaVersion: 1,
    revision: "candidate-safe-static",
    createdAt: "2026-08-20T00:00:00.000Z",
    defaultProfile: fallbackProfile,
    profiles: PROTOCOL.profiles,
    router: fallbackRouter.router,
  });
  candidates.push({
    router: fallbackRouter,
    policy: fallbackPolicy,
    results: adaptiveResults(devCases, fallbackPolicy),
    aggregate: bestStaticAggregate,
    utility: 0,
    eligible: true,
  });

  const pool = candidates.filter((candidate) => candidate.eligible);
  const best = pool.sort((left, right) => right.utility - left.utility
    || right.aggregate.macroSessionRecall - left.aggregate.macroSessionRecall
    || left.aggregate.meanInjectedTokens - right.aggregate.meanInjectedTokens)[0];
  return { router: best.router, policy: best.policy, results: best.results };
}

async function currentSource(): Promise<{ memoryCoreBaseRevision: string; branch: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const cwd = path.resolve(import.meta.dirname, "../../..");
  const [revision, branch] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd }),
    run("git", ["branch", "--show-current"], { cwd }),
  ]);
  return { memoryCoreBaseRevision: revision.stdout.trim(), branch: branch.stdout.trim() };
}

export async function runExperiment(options: RunOptions): Promise<ExperimentReport> {
  const adapter = new LongMemEvalAdapter();
  const backend = new MemoryCoreL0FtsBackend();
  const loaded = await adapter.load(options.datasetPath);
  if (!options.allowDatasetMismatch && loaded.description.sha256 !== EXPECTED_DATASET_SHA256) {
    throw new Error(`dataset checksum mismatch: expected ${EXPECTED_DATASET_SHA256}, got ${loaded.description.sha256}`);
  }
  const selectedCases = chooseCases(loaded.cases, options.maxCases);
  const exploratory = selectedCases.length !== loaded.cases.length;
  const splits = assignSplits(selectedCases);
  const candidateLimits = PROTOCOL.profiles.map((profile) => profile.candidateLimit);
  const cache = new Map<string, CachedCaseResult>();

  for (let index = 0; index < selectedCases.length; index += 1) {
    const evalCase = selectedCases[index];
    const backendResult = await backend.indexAndSearch(evalCase, candidateLimits);
    cache.set(evalCase.id, {
      caseId: evalCase.id,
      groupId: evalCase.groupId,
      category: evalCase.category,
      split: splits.get(evalCase.id)!,
      query: evalCase.query,
      documentCount: backendResult.indexedItems,
      features: (await import("../../../src/core/adaptive-recall/features.js")).extractQueryFeatures(
        evalCase.query,
        backendResult.indexedItems,
        backendResult.candidates.slice(0, 5),
      ),
      goldTurnIds: evalCase.goldTurnIds,
      goldSessionIds: evalCase.goldSessionIds,
      candidates: backendResult.candidates,
      indexLatencyMs: backendResult.indexLatencyMs,
      queryLatencyMs: backendResult.queryLatencyMs,
      queryLatencyByLimit: backendResult.queryLatencyByLimit,
      retrievalStrategy: backendResult.strategy,
    });
    if ((index + 1) % 25 === 0 || index + 1 === selectedCases.length) {
      process.stdout.write(`indexed and searched ${index + 1}/${selectedCases.length}\n`);
    }
  }

  const cacheMap = cache;
  const nonAbstention = [...cache.values()].filter((item) => item.split !== "abstention");
  const trainCases = nonAbstention.filter((item) => item.split === "train");
  const devCases = nonAbstention.filter((item) => item.split === "dev");
  const testCases = nonAbstention.filter((item) => item.split === "test");
  if (!trainCases.length || !devCases.length || !testCases.length) {
    throw new Error("selected data does not populate train/dev/test; increase --max-cases");
  }

  const resultsByProfile = new Map<string, Map<string, ArmCaseResult>>();
  for (const profile of PROTOCOL.profiles) {
    resultsByProfile.set(profile.name, new Map(nonAbstention.map((item) => [item.caseId, evaluateArm(item, profile)])));
  }
  const profileOrder = [...PROTOCOL.profiles]
    .sort((left, right) => left.tokenBudget - right.tokenBudget || left.resultLimit - right.resultLimit)
    .map((profile) => profile.name);
  const trainExamples: TrainingExample[] = trainCases.map((item) => ({
    features: item.features,
    label: labelFromArms(
      PROTOCOL.profiles.map((profile) => resultsByProfile.get(profile.name)!.get(item.caseId)!),
      profileOrder,
    ),
  }));

  const devArms: Record<string, ArmCaseResult[]> = {};
  const devAggregates: Record<string, AggregateMetrics> = {};
  for (const profile of PROTOCOL.profiles) {
    const results = devCases.map((item) => resultsByProfile.get(profile.name)!.get(item.caseId)!);
    devArms[profile.name] = results;
    devAggregates[profile.name] = aggregateResults(results, cacheMap);
  }
  const bestStaticProfile = pickBestStatic(devAggregates);
  const selectedRouter = selectRouter(
    trainExamples,
    devCases,
    devArms[bestStaticProfile],
    cacheMap,
    profileOrder,
  );
  const policyRevision = `easi-${stableHash(JSON.stringify({
    protocolVersion: PROTOCOL.protocolVersion,
    profiles: PROTOCOL.profiles,
    router: selectedRouter.router.router,
  })).slice(0, 12)}`;
  const policy = validateAdaptiveRecallPolicy({ ...selectedRouter.policy, revision: policyRevision });
  const devAdaptive = adaptiveResults(devCases, policy);

  const testBase = testCases.map((item) => resultsByProfile.get(PROTOCOL.baselineProfile.name)!.get(item.caseId)!);
  const testBestStatic = testCases.map((item) => resultsByProfile.get(bestStaticProfile)!.get(item.caseId)!);
  const testAdaptive = adaptiveResults(testCases, policy);
  const testArms: Record<string, AggregateMetrics> = {};
  for (const profile of PROTOCOL.profiles) {
    testArms[profile.name] = aggregateResults(
      testCases.map((item) => resultsByProfile.get(profile.name)!.get(item.caseId)!),
      cacheMap,
    );
  }
  const testBaseAggregate = aggregateResults(testBase, cacheMap);
  const testBestStaticAggregate = aggregateResults(testBestStatic, cacheMap);
  const testAdaptiveAggregate = aggregateResults(testAdaptive, cacheMap);
  const bestStaticMeanTokens = testBestStaticAggregate.meanInjectedTokens;
  const utilityMetric = (adaptive: ArmCaseResult, baseline: ArmCaseResult) => {
    const recallDelta = adaptive.metrics.macroSessionRecall - baseline.metrics.macroSessionRecall;
    const tokenDelta = baseline.metrics.injectedTokens - adaptive.metrics.injectedTokens;
    return recallDelta + PROTOCOL.promotion.tokenPenalty * (bestStaticMeanTokens > 0 ? tokenDelta / bestStaticMeanTokens : 0);
  };
  const recallCi = pairedBootstrapCi(
    testAdaptive, testBestStatic,
    (adaptive, baseline) => adaptive.metrics.macroSessionRecall - baseline.metrics.macroSessionRecall,
    PROTOCOL.bootstrapSamples, PROTOCOL.seed,
  );
  const tokenCi = pairedBootstrapCi(
    testAdaptive, testBestStatic,
    (adaptive, baseline) => adaptive.metrics.injectedTokens - baseline.metrics.injectedTokens,
    PROTOCOL.bootstrapSamples, PROTOCOL.seed + 1,
  );
  const utilityCi = pairedBootstrapCi(
    testAdaptive, testBestStatic, utilityMetric,
    PROTOCOL.bootstrapSamples, PROTOCOL.seed + 2,
  );
  const tokenReduction = bestStaticMeanTokens > 0
    ? (bestStaticMeanTokens - testAdaptiveAggregate.meanInjectedTokens) / bestStaticMeanTokens
    : 0;
  const checks = {
    macroRecallCiWithinGuard: recallCi.lower >= -PROTOCOL.promotion.maxMacroRecallRegression,
    recallAnyWithinGuard: testAdaptiveAggregate.recallAnySession
      >= testBestStaticAggregate.recallAnySession - PROTOCOL.promotion.maxMacroRecallRegression,
    recallAllWithinGuard: testAdaptiveAggregate.recallAllSessions
      >= testBestStaticAggregate.recallAllSessions - PROTOCOL.promotion.maxMacroRecallRegression,
    tokenReduction: tokenReduction >= PROTOCOL.promotion.minTokenReduction,
    tokenReductionConfidence: tokenCi.upper < 0,
    utilityConfidence: utilityCi.lower > PROTOCOL.promotion.minUtilityCiLowerBound,
  };
  const contextualPromotionPassed = Object.values(checks).every(Boolean);

  const baseMeanTokens = testBaseAggregate.meanInjectedTokens;
  const globalUtilityMetric = (optimized: ArmCaseResult, baseline: ArmCaseResult) => {
    const recallDelta = optimized.metrics.macroSessionRecall - baseline.metrics.macroSessionRecall;
    const tokenDelta = baseline.metrics.injectedTokens - optimized.metrics.injectedTokens;
    return recallDelta + PROTOCOL.promotion.tokenPenalty * (baseMeanTokens > 0 ? tokenDelta / baseMeanTokens : 0);
  };
  const globalRecallCi = pairedBootstrapCi(
    testBestStatic, testBase,
    (optimized, baseline) => optimized.metrics.macroSessionRecall - baseline.metrics.macroSessionRecall,
    PROTOCOL.bootstrapSamples, PROTOCOL.seed + 3,
  );
  const globalTokenCi = pairedBootstrapCi(
    testBestStatic, testBase,
    (optimized, baseline) => optimized.metrics.injectedTokens - baseline.metrics.injectedTokens,
    PROTOCOL.bootstrapSamples, PROTOCOL.seed + 4,
  );
  const globalUtilityCi = pairedBootstrapCi(
    testBestStatic, testBase, globalUtilityMetric,
    PROTOCOL.bootstrapSamples, PROTOCOL.seed + 5,
  );
  const globalTokenReduction = baseMeanTokens > 0
    ? (baseMeanTokens - testBestStaticAggregate.meanInjectedTokens) / baseMeanTokens
    : 0;
  const globalChecks = {
    macroRecallCiWithinGuard: globalRecallCi.lower >= -PROTOCOL.promotion.maxMacroRecallRegression,
    recallAnyWithinGuard: testBestStaticAggregate.recallAnySession
      >= testBaseAggregate.recallAnySession - PROTOCOL.promotion.maxMacroRecallRegression,
    recallAllWithinGuard: testBestStaticAggregate.recallAllSessions
      >= testBaseAggregate.recallAllSessions - PROTOCOL.promotion.maxMacroRecallRegression,
    tokenReduction: globalTokenReduction >= PROTOCOL.promotion.minTokenReduction,
    tokenReductionConfidence: globalTokenCi.upper < 0,
    utilityConfidence: globalUtilityCi.lower > PROTOCOL.promotion.minUtilityCiLowerBound,
  };
  const globalPromotionPassed = Object.values(globalChecks).every(Boolean);

  const abstentionCases = [...cache.values()].filter((item) => item.split === "abstention");
  const abstentionBase = abstentionCases.map((item) => evaluateArm(item, PROTOCOL.baselineProfile));
  const abstentionAdaptive = adaptiveResults(abstentionCases, policy);
  const report: ExperimentReport = {
    status: exploratory ? "exploratory" : globalPromotionPassed ? "passed" : "failed",
    protocolVersion: PROTOCOL.protocolVersion,
    generatedAt: new Date().toISOString(),
    dataset: loaded.description,
    source: await currentSource(),
    run: {
      casesLoaded: selectedCases.length,
      retrievalCases: nonAbstention.length,
      abstentionCases: abstentionCases.length,
      splitCounts: {
        train: trainCases.length,
        dev: devCases.length,
        test: testCases.length,
        abstention: abstentionCases.length,
      },
      exploratory,
    },
    selected: { bestStaticProfile, router: selectedRouter.router, policyRevision },
    dev: { arms: devAggregates, adaptive: aggregateResults(devAdaptive, cacheMap) },
    test: {
      arms: testArms,
      base: testBaseAggregate,
      bestStatic: testBestStaticAggregate,
      adaptive: testAdaptiveAggregate,
      deltasVsBestStatic: {
        macroSessionRecall: recallCi,
        injectedTokens: tokenCi,
        utility: utilityCi,
        tokenReduction,
      },
      deltasBestStaticVsBase: {
        macroSessionRecall: globalRecallCi,
        injectedTokens: globalTokenCi,
        utility: globalUtilityCi,
        tokenReduction: globalTokenReduction,
      },
    },
    promotion: {
      evaluated: !exploratory,
      passed: !exploratory && globalPromotionPassed,
      checks: globalChecks,
      contextual: {
        passed: !exploratory && contextualPromotionPassed,
        checks,
      },
    },
    abstention: {
      cases: abstentionCases.length,
      baseMeanInjectedItems: mean(abstentionBase.map((result) => result.metrics.injectedItems)),
      adaptiveMeanInjectedItems: mean(abstentionAdaptive.map((result) => result.metrics.injectedItems)),
    },
  };

  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(path.join(options.outputDir, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8"),
    writeFile(
      path.join(options.outputDir, "cases.jsonl"),
      `${[...testBase, ...testBestStatic, ...testAdaptive].map((result) => JSON.stringify(result)).join("\n")}\n`,
      "utf8",
    ),
  ]);
  return report;
}
