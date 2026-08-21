import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyLifecyclePolicy,
  applyLifecycleValidStatePacking,
  type LifecycleDeleteVacancyPolicy,
  type LifecycleDeleteVacancySource,
  type LifecycleDecisionLog,
  type LifecycleValidStatePackingDecision,
  type LifecycleValidStatePackingPolicy,
} from "../../../src/core/lifecycle/index.js";
import { sourceRevision } from "./adaptive-runner.js";
import {
  prepareDeleteVacancyData,
  type DeleteVacancyPreparedCase,
  type DeleteVacancyRunOptions,
} from "./delete-vacancy-runner.js";
import { aggregate, pairedPersonaBootstrap, scoreRetrieved } from "./metrics.js";
import type { BootstrapInterval, CaseMetrics, RetrievedUnit } from "./types.js";
import { VALID_STATE_PACKING_PROTOCOL } from "./valid-state-packing-protocol.js";

type Arm = "v1" | "valid_state_packing";
type DirectMetric = "evidenceFamaProxy" | "currentSessionRecall" | "forgettingAbsence";

interface PackingPolicy extends LifecycleValidStatePackingPolicy {
  id: string;
}

interface PackingCaseResult {
  arm: Arm;
  candidateIds: string[];
  caseId: string;
  decision: LifecycleDecisionLog | LifecycleValidStatePackingDecision;
  forgettingBearing: boolean;
  groupId: string;
  metrics: CaseMetrics;
  period: string;
  persona: string;
  queryLatencyMs: number;
  task: string;
}

interface OptimizationTrial {
  cost: number;
  fallbackRate: number;
  harm: number;
  policy: PackingPolicy;
  quality: number;
  utility: number;
}

export interface ValidStatePackingRunOptions extends DeleteVacancyRunOptions {}

const DIRECT_METRICS: DirectMetric[] = [
  "evidenceFamaProxy",
  "currentSessionRecall",
  "forgettingAbsence",
];

const validityPolicy: LifecycleDeleteVacancyPolicy = {
  enabled: true,
  maxCandidates: VALID_STATE_PACKING_PROTOCOL.validityStream.maxCandidates,
  maxExpansions: VALID_STATE_PACKING_PROTOCOL.validityStream.maxExpansions,
  maxHops: VALID_STATE_PACKING_PROTOCOL.validityStream.maxHops,
  minConfidence: VALID_STATE_PACKING_PROTOCOL.validityStream.minConfidence,
  resultLimit: VALID_STATE_PACKING_PROTOCOL.validityStream.validityPoolLimit,
  timeoutMs: VALID_STATE_PACKING_PROTOCOL.validityStream.timeoutMs,
};

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function policies(): PackingPolicy[] {
  return VALID_STATE_PACKING_PROTOCOL.policyGrid.budgetFractionOfPerQueryV1Tokens.flatMap(
    (budgetFraction) => VALID_STATE_PACKING_PROTOCOL.policyGrid.maxItems.map((maxItems) => ({
      id: `budget-${String(budgetFraction).replace(".", "p")}-items-${maxItems}`,
      enabled: true,
      budgetFraction,
      maxCandidates: VALID_STATE_PACKING_PROTOCOL.validityStream.maxCandidates,
      maxItems,
      resultLimit: VALID_STATE_PACKING_PROTOCOL.incumbent.resultLimit,
      timeoutMs: VALID_STATE_PACKING_PROTOCOL.validityStream.timeoutMs,
    })),
  );
}

function result(params: {
  arm: Arm;
  candidates: RetrievedUnit[];
  decision: LifecycleDecisionLog | LifecycleValidStatePackingDecision;
  prepared: DeleteVacancyPreparedCase;
}): PackingCaseResult {
  return {
    arm: params.arm,
    caseId: params.prepared.question.id,
    groupId: params.prepared.question.groupId,
    persona: params.prepared.question.persona,
    period: params.prepared.question.period,
    task: params.prepared.question.task,
    forgettingBearing: params.prepared.question.obsoleteAtoms.length > 0,
    candidateIds: params.candidates.map((candidate) => candidate.id),
    metrics: scoreRetrieved(params.prepared.question, params.candidates),
    queryLatencyMs: params.prepared.queryLatencyMs + params.decision.elapsedMs,
    decision: params.decision,
  };
}

function v1Result(prepared: DeleteVacancyPreparedCase): PackingCaseResult {
  const applied = applyLifecyclePolicy({
    candidates: prepared.candidates,
    resolver: prepared.ledger,
    policy: VALID_STATE_PACKING_PROTOCOL.incumbent,
    materialize: prepared.materialize,
  });
  return result({ arm: "v1", prepared, candidates: applied.candidates, decision: applied.decision });
}

function packingResult(
  prepared: DeleteVacancyPreparedCase,
  policy: PackingPolicy,
  overrides: {
    now?: () => number;
    validitySource?: LifecycleDeleteVacancySource;
  } = {},
): PackingCaseResult {
  const applied = applyLifecycleValidStatePacking({
    candidates: prepared.candidates,
    incumbentResolver: prepared.ledger,
    incumbentPolicy: VALID_STATE_PACKING_PROTOCOL.incumbent,
    validitySource: overrides.validitySource ?? prepared.vacancy,
    validityPolicy,
    policy,
    materialize: prepared.materialize,
    now: overrides.now,
  });
  return result({
    arm: "valid_state_packing",
    prepared,
    candidates: applied.candidates,
    decision: applied.decision,
  });
}

function comparison(
  candidate: PackingCaseResult[],
  v1: PackingCaseResult[],
  seedOffset: number,
): Record<DirectMetric, BootstrapInterval> {
  return Object.fromEntries(DIRECT_METRICS.map((metric, index) => [
    metric,
    pairedPersonaBootstrap(
      candidate,
      v1,
      (left, right) => left.metrics[metric] - right.metrics[metric],
      VALID_STATE_PACKING_PROTOCOL.evaluation.bootstrapSamples,
      VALID_STATE_PACKING_PROTOCOL.seed + seedOffset + index,
    ),
  ])) as Record<DirectMetric, BootstrapInterval>;
}

function subsetReport(params: {
  candidate: PackingCaseResult[];
  predicate: (result: PackingCaseResult) => boolean;
  seedOffset: number;
  v1: PackingCaseResult[];
}) {
  const selectedV1 = params.v1.filter(params.predicate);
  const ids = new Set(selectedV1.map((item) => item.caseId));
  const selectedCandidate = params.candidate.filter((item) => ids.has(item.caseId));
  const v1Aggregate = aggregate(selectedV1);
  const candidateAggregate = aggregate(selectedCandidate);
  const v1ById = new Map(selectedV1.map((item) => [item.caseId, item]));
  return {
    v1: v1Aggregate,
    validStatePacking: candidateAggregate,
    validStatePackingVsV1: comparison(selectedCandidate, selectedV1, params.seedOffset),
    harmedCases: selectedCandidate.filter((item) =>
      item.metrics.evidenceFamaProxy
        < (v1ById.get(item.caseId)?.metrics.evidenceFamaProxy ?? 0) - 1e-12
    ).length,
    meanInjectedTokenIncreaseFraction: v1Aggregate.meanInjectedTokens
      ? candidateAggregate.meanInjectedTokens / v1Aggregate.meanInjectedTokens - 1
      : 0,
  };
}

function optimize(
  prepared: DeleteVacancyPreparedCase[],
  v1: PackingCaseResult[],
): { selected: PackingPolicy; trials: OptimizationTrial[] } {
  const optimizationPeriods = new Set(VALID_STATE_PACKING_PROTOCOL.split.optimizationPeriods);
  const development = prepared.filter((item) => optimizationPeriods.has(item.question.period));
  const developmentIds = new Set(development.map((item) => item.question.id));
  const developmentV1 = v1.filter((item) => developmentIds.has(item.caseId));
  const v1ById = new Map(developmentV1.map((item) => [item.caseId, item]));
  const primary = (item: PackingCaseResult) => item.task !== "reasoning" && item.forgettingBearing;
  const weights = VALID_STATE_PACKING_PROTOCOL.optimizer;
  const trials = policies().map((policy): OptimizationTrial => {
    const candidate = development.map((item) => packingResult(item, policy));
    const quality = mean(candidate.filter(primary).map((item) =>
      item.metrics.evidenceFamaProxy - v1ById.get(item.caseId)!.metrics.evidenceFamaProxy
    ));
    const protectedItems = candidate.filter((item) => !primary(item));
    const harm = mean(protectedItems.map((item) => Math.max(
      0,
      v1ById.get(item.caseId)!.metrics.evidenceFamaProxy - item.metrics.evidenceFamaProxy,
    )));
    const cost = mean(candidate.map((item) => {
      const reference = v1ById.get(item.caseId)!.metrics.injectedTokens;
      return reference ? item.metrics.injectedTokens / reference : 0;
    }));
    const fallbackRate = mean(candidate.map((item) => item.decision.mode === "fallback" ? 1 : 0));
    return {
      policy,
      quality,
      harm,
      cost,
      fallbackRate,
      utility: quality - weights.harmPenalty * harm - weights.costPenalty * cost
        - weights.fallbackPenalty * fallbackRate,
    };
  });
  trials.sort((left, right) =>
    right.utility - left.utility
      || right.quality - left.quality
      || left.harm - right.harm
      || left.cost - right.cost
      || left.policy.maxItems - right.policy.maxItems
      || left.policy.budgetFraction - right.policy.budgetFraction
      || left.policy.id.localeCompare(right.policy.id)
  );
  return { selected: trials[0].policy, trials };
}

function fallbackChecks(prepared: DeleteVacancyPreparedCase[], selected: PackingPolicy) {
  const disabled = { ...selected, enabled: false };
  const damaged: LifecycleDeleteVacancySource = {
    resolveIds: () => {
      throw new Error("forced valid-state damage");
    },
  };
  let disabledMismatches = 0;
  let damagedMismatches = 0;
  let timeoutMismatches = 0;
  for (const item of prepared) {
    const expected = item.candidates.slice(0, selected.resultLimit)
      .map((candidate) => candidate.id).join("\0");
    disabledMismatches += Number(
      packingResult(item, disabled).candidateIds.join("\0") !== expected,
    );
    damagedMismatches += Number(
      packingResult(item, selected, { validitySource: damaged }).candidateIds.join("\0") !== expected,
    );
    let clock = 0;
    timeoutMismatches += Number(packingResult(item, selected, {
      now: () => {
        clock += 20;
        return clock;
      },
    }).candidateIds.join("\0") !== expected);
  }
  return { cases: prepared.length, disabledMismatches, damagedMismatches, timeoutMismatches };
}

function evaluateGate(params: {
  fallback: ReturnType<typeof fallbackChecks>;
  maxOutputCandidates: number;
  nonForgettingHarmedCases: number;
  ordinaryFallbacks: number;
  perQueryTokenViolations: number;
  primary: ReturnType<typeof subsetReport>;
}) {
  const gate = VALID_STATE_PACKING_PROTOCOL.proxyGate;
  const direct = params.primary.validStatePackingVsV1;
  const checks = {
    evidenceFamaDirection: !gate.requirePositivePrimaryEvidenceFamaProxyDelta
      || direct.evidenceFamaProxy.mean > 0,
    evidenceFamaUncertainty: !gate.requirePrimaryEvidenceFamaProxyCiLowerAboveZero
      || direct.evidenceFamaProxy.lower > 0,
    currentRecallDirection:
      direct.currentSessionRecall.mean >= gate.minPrimaryCurrentSessionRecallDelta,
    forgettingDirection:
      direct.forgettingAbsence.mean >= gate.minPrimaryForgettingAbsenceDelta,
    nonForgettingHarm: params.nonForgettingHarmedCases
      <= gate.maxQuarterlyCurrentStateNonForgettingHarmedCasesVsV1,
    meanTokenBudget: params.primary.meanInjectedTokenIncreaseFraction
      <= gate.maxMeanInjectedTokenIncreaseFractionVsV1 + 1e-12,
    perQueryTokenBudget: params.perQueryTokenViolations === 0,
    candidateBudget: !gate.requireAtMostFiveCandidates
      || params.maxOutputCandidates <= VALID_STATE_PACKING_PROTOCOL.incumbent.resultLimit,
    zeroOrdinaryFallbacks: !gate.requireZeroOrdinaryFallbacks || params.ordinaryFallbacks === 0,
    disabledBaseEquivalence: !gate.requireDisabledBaseEquivalence
      || params.fallback.disabledMismatches === 0,
    forcedFailureBaseFallback: !gate.requireForcedFailureBaseFallback
      || params.fallback.damagedMismatches + params.fallback.timeoutMismatches === 0,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

export async function runValidStatePacking(
  options: ValidStatePackingRunOptions,
): Promise<Record<string, unknown>> {
  const prepared = await prepareDeleteVacancyData(options);
  const v1 = prepared.cases.map(v1Result);
  const optimization = optimize(prepared.cases, v1);
  const candidate = prepared.cases.map((item) => packingResult(item, optimization.selected));
  const heldOut = (item: PackingCaseResult) =>
    item.period === VALID_STATE_PACKING_PROTOCOL.split.heldOutProxyPeriod;
  const currentState = (item: PackingCaseResult) => item.task !== "reasoning";
  const primaryPredicate = (item: PackingCaseResult) =>
    heldOut(item) && currentState(item) && item.forgettingBearing;
  const nonForgettingPredicate = (item: PackingCaseResult) =>
    heldOut(item) && currentState(item) && !item.forgettingBearing;
  const reports = {
    all: subsetReport({ candidate, v1, predicate: () => true, seedOffset: 0 }),
    optimizationPrimary: subsetReport({
      candidate,
      v1,
      predicate: (item) => VALID_STATE_PACKING_PROTOCOL.split.optimizationPeriods.includes(item.period)
        && currentState(item) && item.forgettingBearing,
      seedOffset: 100,
    }),
    primaryQuarterlyCurrentStateForgetting: subsetReport({
      candidate,
      v1,
      predicate: primaryPredicate,
      seedOffset: 200,
    }),
    quarterlyAll: subsetReport({ candidate, v1, predicate: heldOut, seedOffset: 300 }),
    quarterlyCurrentStateNonForgetting: subsetReport({
      candidate,
      v1,
      predicate: nonForgettingPredicate,
      seedOffset: 400,
    }),
    quarterlyReasoning: subsetReport({
      candidate,
      v1,
      predicate: (item) => heldOut(item) && !currentState(item),
      seedOffset: 500,
    }),
  };
  const v1ById = new Map(v1.map((item) => [item.caseId, item]));
  const perQueryTokenViolations = candidate.filter((item) =>
    item.metrics.injectedTokens > v1ById.get(item.caseId)!.metrics.injectedTokens
  ).length;
  const ordinaryFallbacks = candidate.filter((item) => item.decision.mode === "fallback").length;
  const maxOutputCandidates = Math.max(...candidate.map((item) => item.candidateIds.length));
  const fallback = fallbackChecks(prepared.cases, optimization.selected);
  const gate = evaluateGate({
    fallback,
    maxOutputCandidates,
    nonForgettingHarmedCases: reports.quarterlyCurrentStateNonForgetting.harmedCases,
    ordinaryFallbacks,
    perQueryTokenViolations,
    primary: reports.primaryQuarterlyCurrentStateForgetting,
  });
  const report = {
    status: gate.passed ? "passed" : "failed",
    nextAction: gate.passed ? "freeze_new_answer_panel" : "reject_candidate_and_continue_to_D5",
    protocol: VALID_STATE_PACKING_PROTOCOL,
    generatedAt: new Date().toISOString(),
    source: await sourceRevision(),
    dataset: prepared.dataset,
    integrity: {
      cases: prepared.cases.length,
      groups: prepared.groups.length,
      policies: policies().length,
      ledgerBuildFailures: prepared.groups.filter((item) => item.ledgerError).length,
      vacancyBuildFailures: prepared.groups.filter((item) => item.vacancyError).length,
    },
    optimization,
    reports,
    decisions: {
      ordinaryFallbacks,
      maxOutputCandidates,
      perQueryTokenViolations,
      meanOutputCandidates: mean(candidate.map((item) => item.candidateIds.length)),
      meanItemsSkippedForBudget: mean(candidate.map((item) =>
        "itemsSkippedForBudget" in item.decision ? item.decision.itemsSkippedForBudget : 0
      )),
    },
    fallbackValidation: fallback,
    proxyGate: gate,
    caveats: [
      "The selected policy uses weekly/monthly direct-proxy feedback only; quarterly is policy-blind.",
      "The primary result remains a direct evidence proxy rather than answer-level FAMA.",
      "Per-query token budgets are derived from the actual V1 context and cannot exceed V1 by construction.",
      "A pass permits a new answer panel only and does not promote the candidate.",
    ],
  };
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(
    path.join(options.outputDir, "cases.jsonl"),
    `${[...v1, ...candidate].map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}
