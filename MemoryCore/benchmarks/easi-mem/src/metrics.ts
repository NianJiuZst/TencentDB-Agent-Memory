import type { RecallCandidate } from "../../../src/core/adaptive-recall/index.js";
import type { AggregateMetrics, ArmCaseResult, CaseMetrics, CachedCaseResult } from "./types.js";

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function uniqueInOrder(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function ndcgSession(candidates: RecallCandidate[], goldSessionIds: Set<string>): number {
  const ranked = uniqueInOrder(candidates.map((candidate) => candidate.sourceId));
  let dcg = 0;
  for (let index = 0; index < ranked.length; index += 1) {
    if (!goldSessionIds.has(ranked[index])) continue;
    dcg += index === 0 ? 1 : 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  const idealCount = Math.min(goldSessionIds.size, ranked.length);
  for (let index = 0; index < idealCount; index += 1) ideal += index === 0 ? 1 : 1 / Math.log2(index + 2);
  return safeRatio(dcg, ideal);
}

export function scoreCandidates(
  candidates: RecallCandidate[],
  goldTurnIds: string[],
  goldSessionIds: string[],
): CaseMetrics {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const candidateSessions = new Set(candidates.map((candidate) => candidate.sourceId).filter((id): id is string => !!id));
  const goldTurns = new Set(goldTurnIds);
  const goldSessions = new Set(goldSessionIds);
  const matchedTurns = [...goldTurns].filter((id) => candidateIds.has(id)).length;
  const matchedSessions = [...goldSessions].filter((id) => candidateSessions.has(id)).length;
  const injectedTokens = candidates.reduce((sum, candidate) => sum + (candidate.tokenCount ?? 0), 0);
  const alignedTokens = candidates.reduce(
    (sum, candidate) => sum + (goldTurns.has(candidate.id) ? candidate.tokenCount ?? 0 : 0),
    0,
  );

  return {
    recallAnySession: matchedSessions > 0 ? 1 : 0,
    recallAllSessions: goldSessions.size > 0 && matchedSessions === goldSessions.size ? 1 : 0,
    macroSessionRecall: safeRatio(matchedSessions, goldSessions.size),
    recallAnyTurn: matchedTurns > 0 ? 1 : 0,
    recallAllTurns: goldTurns.size > 0 && matchedTurns === goldTurns.size ? 1 : 0,
    macroTurnRecall: safeRatio(matchedTurns, goldTurns.size),
    ndcgSessions: ndcgSession(candidates, goldSessions),
    injectedItems: candidates.length,
    injectedTokens,
    alignedTokens,
    alignedTokenRate: safeRatio(alignedTokens, injectedTokens),
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

export function aggregateResults(results: ArmCaseResult[], _cache: Map<string, CachedCaseResult>): AggregateMetrics {
  return {
    cases: results.length,
    recallAnySession: mean(results.map((result) => result.metrics.recallAnySession)),
    recallAllSessions: mean(results.map((result) => result.metrics.recallAllSessions)),
    macroSessionRecall: mean(results.map((result) => result.metrics.macroSessionRecall)),
    recallAnyTurn: mean(results.map((result) => result.metrics.recallAnyTurn)),
    recallAllTurns: mean(results.map((result) => result.metrics.recallAllTurns)),
    macroTurnRecall: mean(results.map((result) => result.metrics.macroTurnRecall)),
    ndcgSessions: mean(results.map((result) => result.metrics.ndcgSessions)),
    meanInjectedItems: mean(results.map((result) => result.metrics.injectedItems)),
    meanInjectedTokens: mean(results.map((result) => result.metrics.injectedTokens)),
    meanAlignedTokenRate: mean(results.map((result) => result.metrics.alignedTokenRate)),
    queryLatencyP50Ms: percentile(results.map((result) => result.queryLatencyMs), 0.5),
    queryLatencyP95Ms: percentile(results.map((result) => result.queryLatencyMs), 0.95),
  };
}

export function meanUtilityDelta(
  adaptive: ArmCaseResult[],
  baseline: ArmCaseResult[],
  baselineMeanTokens: number,
  tokenPenalty: number,
): number {
  const baselineById = new Map(baseline.map((result) => [result.caseId, result]));
  return mean(adaptive.map((result) => {
    const reference = baselineById.get(result.caseId);
    if (!reference) return 0;
    const recallDelta = result.metrics.macroSessionRecall - reference.metrics.macroSessionRecall;
    const tokenDelta = reference.metrics.injectedTokens - result.metrics.injectedTokens;
    return recallDelta + tokenPenalty * safeRatio(tokenDelta, baselineMeanTokens);
  }));
}

export function pairedBootstrapCi(
  adaptive: ArmCaseResult[],
  baseline: ArmCaseResult[],
  metric: (adaptiveResult: ArmCaseResult, baselineResult: ArmCaseResult) => number,
  samples: number,
  seed: number,
): { mean: number; lower: number; upper: number } {
  const baselineById = new Map(baseline.map((result) => [result.caseId, result]));
  const pairs = adaptive.flatMap((result) => {
    const reference = baselineById.get(result.caseId);
    return reference ? [[result, reference] as const] : [];
  });
  if (pairs.length === 0) return { mean: 0, lower: 0, upper: 0 };

  let state = seed >>> 0;
  const random = () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const observed = mean(pairs.map(([left, right]) => metric(left, right)));
  const bootstrapped: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[Math.floor(random() * pairs.length)];
      total += metric(pair[0], pair[1]);
    }
    bootstrapped.push(total / pairs.length);
  }
  bootstrapped.sort((a, b) => a - b);
  return {
    mean: observed,
    lower: bootstrapped[Math.floor(0.025 * (bootstrapped.length - 1))],
    upper: bootstrapped[Math.floor(0.975 * (bootstrapped.length - 1))],
  };
}

/** Resample dependency clusters, then aggregate all paired case deltas in each draw. */
export function pairedClusterBootstrapCi(
  adaptive: ArmCaseResult[],
  baseline: ArmCaseResult[],
  groupByCaseId: Map<string, string>,
  metric: (adaptiveResult: ArmCaseResult, baselineResult: ArmCaseResult) => number,
  samples: number,
  seed: number,
): { mean: number; lower: number; upper: number; clusters: number } {
  const baselineById = new Map(baseline.map((result) => [result.caseId, result]));
  const grouped = new Map<string, Array<readonly [ArmCaseResult, ArmCaseResult]>>();
  for (const result of adaptive) {
    const reference = baselineById.get(result.caseId);
    const group = groupByCaseId.get(result.caseId);
    if (!reference || !group) continue;
    const pairs = grouped.get(group) ?? [];
    pairs.push([result, reference] as const);
    grouped.set(group, pairs);
  }
  const clusters = [...grouped.values()];
  const allPairs = clusters.flat();
  if (clusters.length === 0 || allPairs.length === 0) {
    return { mean: 0, lower: 0, upper: 0, clusters: 0 };
  }

  let state = seed >>> 0;
  const random = () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const observed = mean(allPairs.map(([left, right]) => metric(left, right)));
  const bootstrapped: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      const selected = clusters[Math.floor(random() * clusters.length)];
      for (const [left, right] of selected) {
        total += metric(left, right);
        count += 1;
      }
    }
    bootstrapped.push(count > 0 ? total / count : 0);
  }
  bootstrapped.sort((a, b) => a - b);
  return {
    mean: observed,
    lower: bootstrapped[Math.floor(0.025 * (bootstrapped.length - 1))],
    upper: bootstrapped[Math.floor(0.975 * (bootstrapped.length - 1))],
    clusters: clusters.length,
  };
}
