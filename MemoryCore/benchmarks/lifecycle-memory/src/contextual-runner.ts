import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyLifecyclePolicy,
  optimizeLifecyclePolicy,
  type LifecycleDecisionLog,
  type LifecyclePolicy,
  type LifecycleResolver,
} from "../../../src/core/lifecycle/index.js";
import {
  baseResult,
  prepareAdaptiveData,
  sourceRevision,
  type AdaptiveRunOptions,
  type PreparedCase,
} from "./adaptive-runner.js";
import { CONTEXTUAL_PROTOCOL } from "./contextual-protocol.js";
import { aggregate, pairedPersonaBootstrap, scoreRetrieved } from "./metrics.js";
import { classifyLifecycleQueryIntent, type LifecycleQueryIntent } from "./query-intent.js";
import type { BootstrapInterval, CaseMetrics } from "./types.js";

type Arm = "base" | "v1" | "contextual";

export interface ContextualLifecyclePolicy extends LifecyclePolicy {
  baseResultLimit: number;
  maxExtraSlots: number;
  protectHistoricalAggregate: boolean;
}

export interface ContextualCaseResult {
  caseId: string;
  groupId: string;
  persona: string;
  period: string;
  task: string;
  queryIntent: LifecycleQueryIntent;
  forgettingBearing: boolean;
  staleExposed: boolean;
  arm: Arm;
  candidateIds: string[];
  sourceSessionIds: string[];
  queryLatencyMs: number;
  metrics: CaseMetrics;
  action: "keep" | "redirect" | "fallback";
  decision?: LifecycleDecisionLog;
}

export interface ContextualRunOptions extends AdaptiveRunOptions {
  frozenSelection: string;
}

interface FrozenSelection {
  protocolVersion: string;
  selected: Array<{
    caseId: string;
    comparatorCandidateIds: string[];
  }>;
}

export const V1_POLICY: ContextualLifecyclePolicy = {
  enabled: true,
  minConfidence: 0.85,
  maxHops: 1,
  maxExpansions: 64,
  resultLimit: 5,
  timeoutMs: 10,
  baseResultLimit: 5,
  maxExtraSlots: 0,
  protectHistoricalAggregate: false,
};

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contextualTargetLimit(baseLimit: number, maxExtraSlots: number, redirects: number): number {
  return baseLimit + Math.min(maxExtraSlots, redirects);
}

export function contextualPolicies(): ContextualLifecyclePolicy[] {
  const grid = CONTEXTUAL_PROTOCOL.candidateGrid;
  return grid.minConfidence.flatMap((minConfidence) =>
    grid.maxHops.flatMap((maxHops) =>
      grid.maxExtraSlots.flatMap((maxExtraSlots) =>
        grid.protectHistoricalAggregate.map((protectHistoricalAggregate) => ({
          enabled: true,
          minConfidence,
          maxHops,
          maxExpansions: grid.maxExpansions,
          resultLimit: grid.baseResultLimit + maxExtraSlots,
          timeoutMs: grid.timeoutMs,
          baseResultLimit: grid.baseResultLimit,
          maxExtraSlots,
          protectHistoricalAggregate,
        }))
      )
    )
  );
}

function baseCase(prepared: PreparedCase): ContextualCaseResult {
  const result = baseResult(prepared);
  return {
    ...result,
    arm: "base",
    queryIntent: classifyLifecycleQueryIntent(prepared.question.query),
    action: "keep",
  };
}

export function contextualCase(params: {
  prepared: PreparedCase;
  policy: ContextualLifecyclePolicy;
  arm?: "v1" | "contextual";
  resolver?: LifecycleResolver;
  now?: () => number;
}): ContextualCaseResult {
  const { prepared, policy } = params;
  const queryIntent = classifyLifecycleQueryIntent(prepared.question.query);
  const protectedIntent = policy.protectHistoricalAggregate && queryIntent === "historical_aggregate";
  const applied = applyLifecyclePolicy({
    candidates: prepared.candidates,
    resolver: params.resolver ?? prepared.resolver,
    policy: {
      ...policy,
      enabled: policy.enabled && !protectedIntent,
      resultLimit: protectedIntent ? policy.baseResultLimit : policy.resultLimit,
    },
    materialize: prepared.materialize,
    now: params.now,
  });
  const targetLimit = applied.decision.mode === "adaptive"
    ? contextualTargetLimit(policy.baseResultLimit, policy.maxExtraSlots, applied.decision.redirects)
    : policy.baseResultLimit;
  const candidates = applied.candidates.slice(0, targetLimit);
  const decision = {
    ...applied.decision,
    outputCandidates: candidates.length,
  };
  const action = decision.mode === "fallback"
    ? "fallback" as const
    : decision.redirects > 0
      ? "redirect" as const
      : "keep" as const;
  return {
    caseId: prepared.question.id,
    groupId: prepared.question.groupId,
    persona: prepared.question.persona,
    period: prepared.question.period,
    task: prepared.question.task,
    queryIntent,
    forgettingBearing: prepared.question.obsoleteAtoms.length > 0,
    staleExposed: scoreRetrieved(
      prepared.question,
      prepared.candidates.slice(0, policy.baseResultLimit),
    ).obsoleteAny === 1,
    arm: params.arm ?? "contextual",
    candidateIds: candidates.map((candidate) => candidate.id),
    sourceSessionIds: candidates.map((candidate) => candidate.sessionId),
    queryLatencyMs: prepared.queryLatencyMs + decision.elapsedMs,
    metrics: scoreRetrieved(prepared.question, candidates),
    action,
    decision,
  };
}

function metricComparison(
  left: ContextualCaseResult[],
  right: ContextualCaseResult[],
  seedOffset: number,
): Record<"evidenceFamaProxy" | "forgettingAbsence" | "currentSessionRecall", BootstrapInterval> {
  return {
    evidenceFamaProxy: pairedPersonaBootstrap(
      left,
      right,
      (a, b) => a.metrics.evidenceFamaProxy - b.metrics.evidenceFamaProxy,
      CONTEXTUAL_PROTOCOL.uncertainty.bootstrapSamples,
      CONTEXTUAL_PROTOCOL.seed + seedOffset,
    ),
    forgettingAbsence: pairedPersonaBootstrap(
      left,
      right,
      (a, b) => a.metrics.forgettingAbsence - b.metrics.forgettingAbsence,
      CONTEXTUAL_PROTOCOL.uncertainty.bootstrapSamples,
      CONTEXTUAL_PROTOCOL.seed + seedOffset + 1,
    ),
    currentSessionRecall: pairedPersonaBootstrap(
      left,
      right,
      (a, b) => a.metrics.currentSessionRecall - b.metrics.currentSessionRecall,
      CONTEXTUAL_PROTOCOL.uncertainty.bootstrapSamples,
      CONTEXTUAL_PROTOCOL.seed + seedOffset + 2,
    ),
  };
}

function harm(left: ContextualCaseResult[], right: ContextualCaseResult[]) {
  const rightById = new Map(right.map((item) => [item.caseId, item]));
  const losses = left.flatMap((item) => {
    const reference = rightById.get(item.caseId);
    if (!reference) return [];
    return [Math.max(0, reference.metrics.evidenceFamaProxy - item.metrics.evidenceFamaProxy)];
  });
  return {
    cases: losses.length,
    harmedCases: losses.filter((loss) => loss > 0).length,
    meanPositiveLoss: mean(losses),
    maxLoss: Math.max(0, ...losses),
  };
}

function actionSummary(cases: ContextualCaseResult[]) {
  return {
    keep: cases.filter((item) => item.action === "keep").length,
    redirect: cases.filter((item) => item.action === "redirect").length,
    fallback: cases.filter((item) => item.action === "fallback").length,
    meanRedirects: mean(cases.map((item) => item.decision?.redirects ?? 0)),
    meanDecisionLatencyMs: mean(cases.map((item) => item.decision?.elapsedMs ?? 0)),
  };
}

function subsetReport(params: {
  base: ContextualCaseResult[];
  v1: ContextualCaseResult[];
  contextual: ContextualCaseResult[];
  predicate: (item: ContextualCaseResult) => boolean;
  seedOffset: number;
}) {
  const selectedBase = params.base.filter(params.predicate);
  const ids = new Set(selectedBase.map((item) => item.caseId));
  const selectedV1 = params.v1.filter((item) => ids.has(item.caseId));
  const selectedContextual = params.contextual.filter((item) => ids.has(item.caseId));
  return {
    base: aggregate(selectedBase),
    v1: aggregate(selectedV1),
    contextual: aggregate(selectedContextual),
    contextualVsBase: metricComparison(selectedContextual, selectedBase, params.seedOffset),
    contextualVsV1: metricComparison(selectedContextual, selectedV1, params.seedOffset + 10),
    harmVsBase: harm(selectedContextual, selectedBase),
    harmVsV1: harm(selectedContextual, selectedV1),
    actions: actionSummary(selectedContextual),
  };
}

function intentValidation(cases: PreparedCase[]) {
  const byPeriod = Object.fromEntries([...new Set(cases.map((item) => item.question.period))].sort()
    .map((period) => {
      const selected = cases.filter((item) => item.question.period === period);
      const trueAggregate = (item: PreparedCase) => item.question.task === "reasoning";
      const predictedAggregate = (item: PreparedCase) =>
        classifyLifecycleQueryIntent(item.question.query) === "historical_aggregate";
      return [period, {
        cases: selected.length,
        truePositive: selected.filter((item) => trueAggregate(item) && predictedAggregate(item)).length,
        falsePositive: selected.filter((item) => !trueAggregate(item) && predictedAggregate(item)).length,
        falseNegative: selected.filter((item) => trueAggregate(item) && !predictedAggregate(item)).length,
        trueNegative: selected.filter((item) => !trueAggregate(item) && !predictedAggregate(item)).length,
      }];
    }));
  return {
    taskLabelsUsedAtInference: false,
    labelRole: "validation only",
    byPeriod,
  };
}

function fallbackChecks(prepared: PreparedCase[], selected: ContextualLifecyclePolicy) {
  const disabled = { ...selected, enabled: false };
  const damaged: LifecycleResolver = { resolveIds: () => { throw new Error("forced checksum mismatch"); } };
  let disabledMismatches = 0;
  let damagedMismatches = 0;
  let timeoutMismatches = 0;
  let protectedIntentMismatches = 0;
  for (const entry of prepared) {
    const expected = entry.candidates.slice(0, selected.baseResultLimit).map((item) => item.id).join("\0");
    const disabledResult = contextualCase({ prepared: entry, policy: disabled });
    if (disabledResult.candidateIds.join("\0") !== expected) disabledMismatches += 1;
    const damagedResult = contextualCase({ prepared: entry, policy: selected, resolver: damaged });
    if (damagedResult.candidateIds.join("\0") !== expected) damagedMismatches += 1;
    let clock = 0;
    const timeoutResult = contextualCase({
      prepared: entry,
      policy: { ...selected, timeoutMs: 1 },
      now: () => { clock += 2; return clock; },
    });
    if (timeoutResult.candidateIds.join("\0") !== expected) timeoutMismatches += 1;
    if (
      selected.protectHistoricalAggregate
      && classifyLifecycleQueryIntent(entry.question.query) === "historical_aggregate"
    ) {
      const result = contextualCase({ prepared: entry, policy: selected });
      if (result.candidateIds.join("\0") !== expected) protectedIntentMismatches += 1;
    }
  }
  return {
    cases: prepared.length,
    disabledMismatches,
    damagedMismatches,
    timeoutMismatches,
    protectedIntentMismatches,
  };
}

async function frozenSelectionEquivalence(
  file: string,
  contextual: ContextualCaseResult[],
) {
  const content = await readFile(file, "utf8");
  const contentHash = sha256(content);
  if (contentHash !== CONTEXTUAL_PROTOCOL.frozenAnswerLevelSelection.selectionSha256) {
    throw new Error(`frozen selection hash mismatch: ${contentHash}`);
  }
  const selection = JSON.parse(content) as FrozenSelection;
  if (selection.protocolVersion !== CONTEXTUAL_PROTOCOL.frozenAnswerLevelSelection.protocolVersion) {
    throw new Error(`frozen selection protocol mismatch: ${selection.protocolVersion}`);
  }
  if (selection.selected.length !== CONTEXTUAL_PROTOCOL.frozenAnswerLevelSelection.cases) {
    throw new Error(`frozen selection case count mismatch: ${selection.selected.length}`);
  }
  const byId = new Map(contextual.map((item) => [item.caseId, item]));
  const mismatches = selection.selected.flatMap((frozen) => {
    const current = byId.get(frozen.caseId);
    if (!current) return [{ caseId: frozen.caseId, reason: "missing contextual case" }];
    return current.candidateIds.join("\0") === frozen.comparatorCandidateIds.join("\0")
      ? []
      : [{ caseId: frozen.caseId, reason: "candidate ids differ" }];
  });
  return {
    path: path.resolve(file),
    sha256: contentHash,
    cases: selection.selected.length,
    candidateMismatches: mismatches.length,
    mismatchCaseIds: mismatches.map((item) => item.caseId),
    priorAnswersReusable: mismatches.length === 0,
  };
}

export async function runContextual(options: ContextualRunOptions): Promise<Record<string, unknown>> {
  const prepared = await prepareAdaptiveData(options);
  const base = prepared.cases.map(baseCase);
  const baseById = new Map(base.map((item) => [item.caseId, item]));
  const optimizationCases = prepared.cases.filter((item) =>
    CONTEXTUAL_PROTOCOL.split.optimizationPeriods.includes(item.question.period));
  const optimizationForgetting = optimizationCases.filter((item) => item.question.obsoleteAtoms.length > 0);
  const optimizationNonForgetting = optimizationCases.filter((item) => item.question.obsoleteAtoms.length === 0);
  const optimized = await optimizeLifecyclePolicy({
    policies: contextualPolicies(),
    evaluate: (policy) => {
      const results = optimizationCases.map((entry) => contextualCase({ prepared: entry, policy }));
      const resultsById = new Map(results.map((item) => [item.caseId, item]));
      const forgettingResults = optimizationForgetting.map((item) => resultsById.get(item.question.id)!);
      const nonForgettingResults = optimizationNonForgetting.map((item) => resultsById.get(item.question.id)!);
      return {
        quality: mean(forgettingResults.map((item) => item.metrics.evidenceFamaProxy)),
        harm: mean(nonForgettingResults.map((item) => Math.max(
          0,
          baseById.get(item.caseId)!.metrics.evidenceFamaProxy - item.metrics.evidenceFamaProxy,
        ))),
        meanCost: mean(results.map((item) => Math.max(
          0,
          item.metrics.injectedTokens - baseById.get(item.caseId)!.metrics.injectedTokens,
        ))) / 1000,
        fallbackRate: mean(results.map((item) => item.action === "fallback" ? 1 : 0)),
      };
    },
    weights: {
      harmPenalty: CONTEXTUAL_PROTOCOL.optimizer.harmPenalty,
      costPenalty: CONTEXTUAL_PROTOCOL.optimizer.costPenalty,
      fallbackPenalty: CONTEXTUAL_PROTOCOL.optimizer.fallbackPenalty,
    },
    maxPolicies: CONTEXTUAL_PROTOCOL.candidateGrid.maxPolicies,
  });

  const v1 = prepared.cases.map((entry) => contextualCase({ prepared: entry, policy: V1_POLICY, arm: "v1" }));
  const contextual = prepared.cases.map((entry) => contextualCase({
    prepared: entry,
    policy: optimized.selected,
    arm: "contextual",
  }));
  const confirmation = (item: ContextualCaseResult) =>
    CONTEXTUAL_PROTOCOL.split.confirmationPeriods.includes(item.period);
  const forgetting = (item: ContextualCaseResult) => confirmation(item) && item.forgettingBearing;
  const staleExposed = (item: ContextualCaseResult) => forgetting(item) && item.staleExposed;
  const nonForgetting = (item: ContextualCaseResult) => confirmation(item) && !item.forgettingBearing;
  const reports = {
    all: subsetReport({ base, v1, contextual, predicate: () => true, seedOffset: 0 }),
    optimizationAll: subsetReport({
      base, v1, contextual,
      predicate: (item) => CONTEXTUAL_PROTOCOL.split.optimizationPeriods.includes(item.period),
      seedOffset: 100,
    }),
    optimizationForgettingBearing: subsetReport({
      base, v1, contextual,
      predicate: (item) => CONTEXTUAL_PROTOCOL.split.optimizationPeriods.includes(item.period)
        && item.forgettingBearing,
      seedOffset: 200,
    }),
    confirmationAll: subsetReport({ base, v1, contextual, predicate: confirmation, seedOffset: 300 }),
    confirmationForgettingBearing: subsetReport({ base, v1, contextual, predicate: forgetting, seedOffset: 400 }),
    confirmationStaleExposed: subsetReport({ base, v1, contextual, predicate: staleExposed, seedOffset: 500 }),
    confirmationNonForgetting: subsetReport({ base, v1, contextual, predicate: nonForgetting, seedOffset: 600 }),
    confirmationByTask: Object.fromEntries([...new Set(base.map((item) => item.task))].sort().map((task, index) => [
      task,
      subsetReport({
        base, v1, contextual,
        predicate: (item) => confirmation(item) && item.task === task,
        seedOffset: 700 + index * 20,
      }),
    ])),
  };
  const fallback = fallbackChecks(prepared.cases, optimized.selected);
  const frozenEquivalence = await frozenSelectionEquivalence(options.frozenSelection, contextual);
  const contextManifest = {
    protocolVersion: CONTEXTUAL_PROTOCOL.protocolVersion,
    selectedPolicy: optimized.selected,
    cases: base.map((baseCase) => ({
      caseId: baseCase.caseId,
      groupId: baseCase.groupId,
      persona: baseCase.persona,
      period: baseCase.period,
      task: baseCase.task,
      queryIntent: baseCase.queryIntent,
      baseCandidateIds: baseCase.candidateIds,
      v1CandidateIds: v1.find((item) => item.caseId === baseCase.caseId)!.candidateIds,
      contextualCandidateIds: contextual.find((item) => item.caseId === baseCase.caseId)!.candidateIds,
    })),
  };
  const contextManifestJson = `${JSON.stringify(contextManifest, null, 2)}\n`;
  const contextManifestSha256 = sha256(contextManifestJson);
  const confirmationFama = reports.confirmationForgettingBearing.contextualVsBase.evidenceFamaProxy;
  const baseConfirmationTokens = reports.confirmationAll.base.meanInjectedTokens;
  const contextualConfirmationTokens = reports.confirmationAll.contextual.meanInjectedTokens;
  const v1NonForgettingHarm = reports.confirmationNonForgetting.harmVsBase.harmedCases;
  const contextualNonForgettingHarm = reports.confirmationNonForgetting.harmVsBase.harmedCases;
  const checks = {
    forgettingFamaDelta: confirmationFama.mean
      >= CONTEXTUAL_PROTOCOL.confirmationGate.minForgettingFamaDelta,
    forgettingFamaCi: !CONTEXTUAL_PROTOCOL.confirmationGate.requireForgettingFamaCiLowerAboveZero
      || confirmationFama.lower > 0,
    protectedIntentEquivalence: !CONTEXTUAL_PROTOCOL.confirmationGate.requireZeroProtectedIntentMismatches
      || fallback.protectedIntentMismatches === 0,
    nonForgettingHarm: !CONTEXTUAL_PROTOCOL.confirmationGate.requireNoMoreHarmedNonForgettingCasesThanV1
      || contextualNonForgettingHarm <= v1NonForgettingHarm,
    tokenBudget: contextualConfirmationTokens
      <= baseConfirmationTokens * (1 + CONTEXTUAL_PROTOCOL.confirmationGate.maxMeanTokenIncreaseFraction),
    disabledEquivalence: !CONTEXTUAL_PROTOCOL.confirmationGate.requireDisabledEquivalence
      || fallback.disabledMismatches === 0,
    forcedFailureFallback: !CONTEXTUAL_PROTOCOL.confirmationGate.requireForcedFailureFallback
      || (fallback.damagedMismatches === 0 && fallback.timeoutMismatches === 0),
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: CONTEXTUAL_PROTOCOL,
    generatedAt: new Date().toISOString(),
    source: await sourceRevision(),
    dataset: prepared.dataset,
    dataSupport: {
      intentClassifier: intentValidation(prepared.cases),
      nativeProgrammingScopeFields: false,
      scopeFieldCaveat: "Memora has no repository, branch, environment, or component scope labels; branch-aware graph behavior is not a primary claim of this experiment.",
    },
    optimization: {
      cases: optimizationCases.length,
      forgettingCases: optimizationForgetting.length,
      nonForgettingCases: optimizationNonForgetting.length,
      selectedPolicy: optimized.selected,
      trials: optimized.trials,
    },
    reports,
    fallbackValidation: fallback,
    contextManifest: {
      cases: contextManifest.cases.length,
      sha256: contextManifestSha256,
    },
    frozenAnswerLevelEquivalence: frozenEquivalence,
    confirmationGate: { passed: Object.values(checks).every(Boolean), checks },
    caveats: [
      "Quarterly Memora results were observed during v1 development, so v2 treats them as confirmation rather than a pristine holdout.",
      "The query-intent classifier is replaceable and uses query text only, but Memora repeats a small set of question templates.",
      "Memora cannot validate repository/branch/environment coexistence; those require a programming-data adapter or bounded smoke tests.",
      frozenEquivalence.priorAnswersReusable
        ? "The selected policy produces byte-identical candidate ID sequences on the frozen 50-case answer-level sample, so prior answers and dual-judge verdicts remain applicable."
        : "The selected policy changes the frozen 50-case candidate sequences; a fresh answer-level run is required before updating the paper claim.",
    ],
  };
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "context-manifest.json"), contextManifestJson, "utf8");
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(options.outputDir, "cases.jsonl"),
    `${[...base, ...v1, ...contextual].map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  return report;
}
