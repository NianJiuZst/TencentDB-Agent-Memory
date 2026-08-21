import { performance } from "node:perf_hooks";
import { applyLifecycleDeleteVacancy } from "./delete-vacancy.js";
import { applyLifecyclePolicy } from "./ledger.js";
import type {
  LifecycleDeleteVacancyPolicy,
  LifecycleDeleteVacancySource,
} from "./delete-vacancy.js";
import type { LifecyclePolicy, LifecycleResolver } from "./types.js";

export interface LifecycleValidStatePackingPolicy {
  budgetFraction: number;
  enabled: boolean;
  maxCandidates: number;
  maxItems: number;
  resultLimit: number;
  timeoutMs: number;
}

export interface LifecycleValidStatePackingDecision {
  elapsedMs: number;
  fallbackReason?: string;
  inputCandidates: number;
  itemsSkippedForBudget: number;
  mode: "base" | "adaptive" | "fallback";
  outputCandidates: number;
  outputTokens: number;
  tokenBudget: number;
  v1Tokens: number;
  validPoolCandidates: number;
}

export interface LifecycleValidStatePackingResult<T> {
  candidates: T[];
  decision: LifecycleValidStatePackingDecision;
}

function validatePolicy(policy: LifecycleValidStatePackingPolicy): void {
  if (!Number.isFinite(policy.budgetFraction)
    || policy.budgetFraction <= 0 || policy.budgetFraction > 1) {
    throw new Error("valid-state budgetFraction must be in (0, 1]");
  }
  for (const [name, value] of [
    ["maxCandidates", policy.maxCandidates],
    ["maxItems", policy.maxItems],
    ["resultLimit", policy.resultLimit],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`valid-state ${name} must be a positive integer`);
    }
  }
  if (policy.maxItems > policy.resultLimit || policy.resultLimit > policy.maxCandidates) {
    throw new Error("valid-state item limits are inconsistent");
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new Error("valid-state timeoutMs must be positive");
  }
}

export function applyLifecycleValidStatePacking<T extends { id: string; tokenCount: number }>(params: {
  candidates: T[];
  incumbentPolicy: LifecyclePolicy;
  incumbentResolver?: LifecycleResolver;
  materialize: (id: string) => T | undefined;
  now?: () => number;
  policy: LifecycleValidStatePackingPolicy;
  validityPolicy: LifecycleDeleteVacancyPolicy;
  validitySource?: LifecycleDeleteVacancySource;
}): LifecycleValidStatePackingResult<T> {
  const wallStartedAt = performance.now();
  const baseline = params.candidates.slice(0, params.policy.resultLimit);
  const baselineTokens = baseline.reduce((sum, item) => sum + item.tokenCount, 0);
  const baseDecision = {
    inputCandidates: params.candidates.length,
    outputCandidates: baseline.length,
    validPoolCandidates: 0,
    v1Tokens: 0,
    tokenBudget: 0,
    outputTokens: baselineTokens,
    itemsSkippedForBudget: 0,
  };
  if (!params.policy.enabled) {
    return {
      candidates: baseline,
      decision: {
        mode: "base",
        ...baseDecision,
        elapsedMs: performance.now() - wallStartedAt,
      },
    };
  }
  try {
    validatePolicy(params.policy);
    if (params.candidates.length > params.policy.maxCandidates) {
      throw new Error(`valid-state candidate capacity exceeded: ${params.candidates.length}`);
    }
    if (!params.incumbentResolver || !params.validitySource) {
      throw new Error("valid-state dependency unavailable");
    }
    const incumbent = applyLifecyclePolicy({
      candidates: params.candidates,
      resolver: params.incumbentResolver,
      policy: params.incumbentPolicy,
      materialize: params.materialize,
      now: params.now,
    });
    if (incumbent.decision.mode === "fallback") {
      throw new Error(`valid-state incumbent failed: ${incumbent.decision.fallbackReason}`);
    }
    const valid = applyLifecycleDeleteVacancy({
      candidates: params.candidates,
      source: params.validitySource,
      policy: params.validityPolicy,
      materialize: params.materialize,
      now: params.now,
    });
    if (valid.decision.mode === "fallback") {
      throw new Error(`valid-state stream failed: ${valid.decision.fallbackReason}`);
    }
    const v1Tokens = incumbent.candidates.reduce((sum, item) => sum + item.tokenCount, 0);
    const tokenBudget = Math.floor(v1Tokens * params.policy.budgetFraction);
    const candidates: T[] = [];
    let outputTokens = 0;
    let itemsSkippedForBudget = 0;
    const packStartedAt = params.now?.() ?? performance.now();
    for (const item of valid.candidates) {
      const current = params.now?.() ?? performance.now();
      if (current - packStartedAt > params.policy.timeoutMs) {
        throw new Error("valid-state packing timed out");
      }
      if (candidates.length >= params.policy.maxItems) break;
      if (!Number.isInteger(item.tokenCount) || item.tokenCount < 0) {
        throw new Error(`valid-state invalid token count for ${item.id}`);
      }
      if (outputTokens + item.tokenCount > tokenBudget) {
        itemsSkippedForBudget += 1;
        continue;
      }
      candidates.push(item);
      outputTokens += item.tokenCount;
    }
    return {
      candidates,
      decision: {
        mode: "adaptive",
        inputCandidates: params.candidates.length,
        outputCandidates: candidates.length,
        validPoolCandidates: valid.candidates.length,
        v1Tokens,
        tokenBudget,
        outputTokens,
        itemsSkippedForBudget,
        elapsedMs: performance.now() - wallStartedAt,
      },
    };
  } catch (error) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        ...baseDecision,
        elapsedMs: performance.now() - wallStartedAt,
        fallbackReason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
