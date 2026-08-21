import { packLongTaskContext, type PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import type { RetrievedUnit } from "./types.js";

export interface TransitionFeedback {
  questionId: string;
  transitionIds: string[];
  reward: number;
}

export interface TransitionUtilityEntry {
  memoryId: string;
  visits: number;
  rewardSum: number;
  meanUtility: number;
  minReward: number;
  negativeVisits: number;
  eligible: boolean;
}

export interface TransitionUtilityTable {
  entries: TransitionUtilityEntry[];
  sourceQuestions: number;
  feedbackEvents: number;
  capacity: number;
}

export type UtilityGateFallbackReason =
  | "disabled"
  | "missing_utility_table"
  | "utility_table_overflow"
  | "sidecar_timeout"
  | "corrupt_utility_or_transition"
  | "budget_overflow";

export type UtilityGateNullReason =
  | "no_positive_utility"
  | "no_trajectory_coherence"
  | "no_cost_certified_candidate";

export interface UtilityGateSelection extends PackedLongTaskContext {
  mode: "utility_gated" | "baseline_noop" | "fallback_baseline";
  usedAuxiliary: boolean;
  transitionIds: string[];
  rawIds: string[];
  consideredUtilityIds: string[];
  selectedUtility: number | null;
  fallback: boolean;
  fallbackReason: UtilityGateFallbackReason | null;
  nullReason: UtilityGateNullReason | null;
}

function exactBaseline(
  baseline: PackedLongTaskContext,
  fallbackReason: UtilityGateFallbackReason | null,
  nullReason: UtilityGateNullReason | null = null,
): UtilityGateSelection {
  return {
    ...baseline,
    items: [...baseline.items],
    mode: fallbackReason ? "fallback_baseline" : "baseline_noop",
    usedAuxiliary: false,
    transitionIds: [],
    rawIds: baseline.items.map((item) => item.id),
    consideredUtilityIds: [],
    selectedUtility: null,
    fallback: fallbackReason !== null,
    fallbackReason,
    nullReason,
  };
}

function trajectoryId(id: string, kind: "raw" | "transition"): string | null {
  const prefix = `lmev2:${kind}:`;
  if (!id.startsWith(prefix)) return null;
  const remainder = id.slice(prefix.length);
  const separator = remainder.indexOf(":");
  return separator > 0 ? remainder.slice(0, separator) : null;
}

function corruptEntry(entry: TransitionUtilityEntry): boolean {
  return !entry.memoryId.startsWith("lmev2:transition:")
    || !Number.isInteger(entry.visits)
    || entry.visits <= 0
    || !Number.isFinite(entry.rewardSum)
    || !Number.isFinite(entry.meanUtility)
    || !Number.isFinite(entry.minReward)
    || !Number.isInteger(entry.negativeVisits)
    || entry.negativeVisits < 0
    || Math.abs(entry.meanUtility - entry.rewardSum / entry.visits) > 1e-12
    || entry.eligible !== (
      entry.visits >= 1
      && entry.meanUtility > 0
      && entry.minReward >= 0
      && entry.negativeVisits === 0
    );
}

function corruptTransition(candidate: RetrievedUnit): boolean {
  return trajectoryId(candidate.id, "transition") === null
    || !Number.isFinite(candidate.tokenCount)
    || candidate.tokenCount <= 0
    || typeof candidate.content !== "string"
    || candidate.content.length === 0;
}

export function learnTransitionUtility(params: {
  feedback: TransitionFeedback[];
  capacity: number;
}): TransitionUtilityTable {
  if (!Number.isInteger(params.capacity) || params.capacity <= 0) {
    throw new Error("utility table capacity must be a positive integer");
  }
  const accumulators = new Map<string, {
    rewards: number[];
    questions: Set<string>;
  }>();
  let feedbackEvents = 0;
  for (const row of params.feedback) {
    if (!row.questionId || !Number.isFinite(row.reward) || row.reward < -1 || row.reward > 1) {
      throw new Error("invalid transition feedback row");
    }
    for (const memoryId of [...new Set(row.transitionIds)]) {
      if (!memoryId.startsWith("lmev2:transition:")) {
        throw new Error(`invalid transition feedback memory id ${memoryId}`);
      }
      const accumulator = accumulators.get(memoryId) ?? { rewards: [], questions: new Set<string>() };
      accumulator.rewards.push(row.reward);
      accumulator.questions.add(row.questionId);
      accumulators.set(memoryId, accumulator);
      feedbackEvents += 1;
    }
  }
  if (accumulators.size > params.capacity) {
    throw new Error(`transition utility table exceeds capacity=${params.capacity}`);
  }
  const entries = [...accumulators.entries()].map(([memoryId, accumulator]) => {
    const visits = accumulator.rewards.length;
    const rewardSum = accumulator.rewards.reduce((sum, reward) => sum + reward, 0);
    const minReward = Math.min(...accumulator.rewards);
    const negativeVisits = accumulator.rewards.filter((reward) => reward < 0).length;
    const meanUtility = rewardSum / visits;
    return {
      memoryId,
      visits,
      rewardSum,
      meanUtility,
      minReward,
      negativeVisits,
      eligible: visits >= 1 && meanUtility > 0 && minReward >= 0 && negativeVisits === 0,
    } satisfies TransitionUtilityEntry;
  }).sort((left, right) => left.memoryId.localeCompare(right.memoryId));
  return {
    entries,
    sourceQuestions: new Set(params.feedback.map((row) => row.questionId)).size,
    feedbackEvents,
    capacity: params.capacity,
  };
}

export function selectUtilityGatedContext(params: {
  baseline: PackedLongTaskContext;
  rawCandidates: RetrievedUnit[];
  transitionCandidates: RetrievedUnit[];
  utilityTable: TransitionUtilityTable | null;
  tokenBudget: number;
  resultLimit: number;
  candidateLimit: number;
  maxUtilityItems: number;
  enabled?: boolean;
  timedOut?: boolean;
  forceCorrupt?: boolean;
}): UtilityGateSelection {
  if (params.enabled === false) return exactBaseline(params.baseline, "disabled");
  if (!params.utilityTable) return exactBaseline(params.baseline, "missing_utility_table");
  if (params.utilityTable.entries.length > params.utilityTable.capacity) {
    return exactBaseline(params.baseline, "utility_table_overflow");
  }
  if (params.timedOut) return exactBaseline(params.baseline, "sidecar_timeout");
  const transitionCandidates = params.transitionCandidates.slice(0, params.candidateLimit);
  if (params.forceCorrupt
    || params.utilityTable.entries.some(corruptEntry)
    || transitionCandidates.some(corruptTransition)) {
    return exactBaseline(params.baseline, "corrupt_utility_or_transition");
  }
  const utilityById = new Map(params.utilityTable.entries.map((entry) => [entry.memoryId, entry]));
  const rankById = new Map(transitionCandidates.map((item, index) => [item.id, index]));
  const positive = transitionCandidates.filter((item) => utilityById.get(item.id)?.eligible)
    .sort((left, right) => {
      const leftUtility = utilityById.get(left.id)!;
      const rightUtility = utilityById.get(right.id)!;
      return rightUtility.meanUtility - leftUtility.meanUtility
        || rightUtility.visits - leftUtility.visits
        || rankById.get(left.id)! - rankById.get(right.id)!;
    });
  if (positive.length === 0) {
    return exactBaseline(params.baseline, null, "no_positive_utility");
  }
  const baselineTrajectories = new Set(params.baseline.items
    .map((item) => trajectoryId(item.id, "raw"))
    .filter((value): value is string => value !== null));
  const coherent = positive.filter((item) => {
    const id = trajectoryId(item.id, "transition");
    return id !== null && baselineTrajectories.has(id);
  });
  if (coherent.length === 0) {
    return exactBaseline(params.baseline, null, "no_trajectory_coherence");
  }
  const consideredUtilityIds: string[] = [];
  for (const candidate of coherent) {
    consideredUtilityIds.push(candidate.id);
    const transition = packLongTaskContext({
      candidates: [candidate],
      tokenBudget: params.tokenBudget,
      resultLimit: Math.min(params.maxUtilityItems, params.resultLimit),
    });
    if (transition.items.length === 0) continue;
    const raw = packLongTaskContext({
      candidates: params.rawCandidates,
      tokenBudget: params.tokenBudget - transition.injectedTokens,
      resultLimit: params.resultLimit - transition.items.length,
    });
    const items = [...transition.items, ...raw.items];
    const injectedTokens = transition.injectedTokens + raw.injectedTokens;
    if (transition.tokenViolation || raw.tokenViolation
      || injectedTokens > params.tokenBudget || items.length > params.resultLimit) {
      return exactBaseline(params.baseline, "budget_overflow");
    }
    if (injectedTokens > params.baseline.injectedTokens) continue;
    return {
      items,
      injectedTokens,
      tokenViolation: false,
      mode: "utility_gated",
      usedAuxiliary: true,
      transitionIds: transition.items.map((item) => item.id),
      rawIds: raw.items.map((item) => item.id),
      consideredUtilityIds,
      selectedUtility: utilityById.get(candidate.id)!.meanUtility,
      fallback: false,
      fallbackReason: null,
      nullReason: null,
    };
  }
  const baselineResult = exactBaseline(params.baseline, null, "no_cost_certified_candidate");
  baselineResult.consideredUtilityIds = consideredUtilityIds;
  return baselineResult;
}
