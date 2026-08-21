import { performance } from "node:perf_hooks";

export type LifecycleTargetStateKind = "remember" | "update" | "delete" | "reflect";
export type LifecycleTargetStateValidity = "confirmed" | "tentative" | "retracted";

export interface LifecycleTargetStateOperation {
  confidence: number;
  id: string;
  kind: LifecycleTargetStateKind;
  sequence: number;
  sourceUnitIds: string[];
  successorUnitIds: string[];
  targetId: string;
  validity: LifecycleTargetStateValidity;
}

export interface LifecycleTargetStatePolicy {
  enabled: boolean;
  maxCandidates: number;
  maxExpansions: number;
  maxStateUnits: number;
  maxTargets: number;
  minConfidence: number;
  resultLimit: number;
  timeoutMs: number;
}

export interface LifecycleTargetStateLimits {
  maxLinks: number;
  maxOperations: number;
  maxTargets: number;
  maxUnits: number;
}

export interface LifecycleTargetStateResolution {
  backfilled: number;
  expansions: number;
  ids: string[];
  inactiveCandidatesSkipped: number;
  maxProjectedStateUnits: number;
  projectedCandidates: number;
  projectedTargets: number;
}

export interface LifecycleTargetStateClassification {
  currentIds: string[];
  staleIds: string[];
  targetLinksVisited: number;
  targets: number;
  unknownIds: string[];
}

export interface LifecycleTargetStateSource {
  resolveIds(
    candidateIds: string[],
    policy: LifecycleTargetStatePolicy,
    now?: () => number,
  ): LifecycleTargetStateResolution;
}

export interface LifecycleTargetStateInspector {
  classifyIds(
    candidateIds: string[],
    policy: LifecycleTargetStatePolicy,
    now?: () => number,
  ): LifecycleTargetStateClassification;
}

export interface LifecycleTargetStateDecision extends LifecycleTargetStateResolution {
  elapsedMs: number;
  fallbackReason?: string;
  inputCandidates: number;
  mode: "base" | "adaptive" | "fallback";
  outputCandidates: number;
}

export interface LifecycleTargetStateResult<T> {
  candidates: T[];
  decision: LifecycleTargetStateDecision;
}

export interface LifecycleDominanceDecision {
  challengerCost: number;
  checks: {
    budgetRespected: boolean;
    currentRetained: boolean;
    staleNotIncreased: boolean;
    unknownRetained: boolean;
  };
  elapsedMs: number;
  fallbackReason?: string;
  incumbentCost: number;
  mode: "incumbent" | "challenger" | "fallback";
  rejectionReasons: string[];
  state: LifecycleTargetStateClassification;
}

export interface LifecycleDominanceResult<T> {
  candidates: T[];
  decision: LifecycleDominanceDecision;
}

interface TargetState {
  available: boolean;
  ids: string[];
}

export const DEFAULT_TARGET_STATE_LIMITS: LifecycleTargetStateLimits = {
  maxUnits: 10_000,
  maxOperations: 5_000,
  maxTargets: 5_000,
  maxLinks: 50_000,
};

function validatePolicy(policy: LifecycleTargetStatePolicy): void {
  if (!Number.isFinite(policy.minConfidence)
    || policy.minConfidence < 0 || policy.minConfidence > 1) {
    throw new Error("target-state minConfidence must be in [0, 1]");
  }
  for (const [name, value] of [
    ["maxCandidates", policy.maxCandidates],
    ["maxExpansions", policy.maxExpansions],
    ["maxStateUnits", policy.maxStateUnits],
    ["maxTargets", policy.maxTargets],
    ["resultLimit", policy.resultLimit],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`target-state ${name} must be a positive integer`);
    }
  }
  if (policy.resultLimit > policy.maxCandidates) {
    throw new Error("target-state resultLimit cannot exceed maxCandidates");
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new Error("target-state timeoutMs must be positive");
  }
}

export class LifecycleTargetState implements LifecycleTargetStateSource, LifecycleTargetStateInspector {
  private readonly operationsByTarget = new Map<string, LifecycleTargetStateOperation[]>();
  private readonly targetsByUnitId = new Map<string, string[]>();
  private readonly unitIds: Set<string>;

  constructor(
    units: Array<{ id: string; sequence: number }>,
    operations: LifecycleTargetStateOperation[],
    limits: LifecycleTargetStateLimits = DEFAULT_TARGET_STATE_LIMITS,
  ) {
    if (units.length > limits.maxUnits) {
      throw new Error(`target-state unit capacity exceeded: ${units.length}`);
    }
    if (operations.length > limits.maxOperations) {
      throw new Error(`target-state operation capacity exceeded: ${operations.length}`);
    }
    this.unitIds = new Set();
    const sequenceById = new Map<string, number>();
    for (const unit of units) {
      if (!unit.id || !Number.isFinite(unit.sequence)) throw new Error("invalid target-state unit");
      if (this.unitIds.has(unit.id)) throw new Error(`duplicate target-state unit ${unit.id}`);
      this.unitIds.add(unit.id);
      sequenceById.set(unit.id, unit.sequence);
    }
    let links = 0;
    const operationIds = new Set<string>();
    for (const operation of operations) {
      if (!operation.id || operationIds.has(operation.id)) {
        throw new Error(`invalid or duplicate target-state operation ${operation.id}`);
      }
      operationIds.add(operation.id);
      if (!operation.targetId || !Number.isFinite(operation.sequence)) {
        throw new Error(`invalid target-state operation ${operation.id}`);
      }
      if (!Number.isFinite(operation.confidence)
        || operation.confidence < 0 || operation.confidence > 1) {
        throw new Error(`invalid target-state confidence ${operation.id}`);
      }
      const sourceUnitIds = [...new Set(operation.sourceUnitIds)];
      const successorUnitIds = [...new Set(operation.successorUnitIds)];
      if (!sourceUnitIds.length) {
        throw new Error(`target-state operation ${operation.id} has no source units`);
      }
      for (const unitId of [...sourceUnitIds, ...successorUnitIds]) {
        const sequence = sequenceById.get(unitId);
        if (sequence === undefined) {
          throw new Error(`target-state operation ${operation.id} references missing unit ${unitId}`);
        }
        if (successorUnitIds.includes(unitId) && sequence > operation.sequence) {
          throw new Error(`target-state operation ${operation.id} points forward to ${unitId}`);
        }
      }
      if (operation.kind === "delete" && successorUnitIds.length) {
        throw new Error(`target-state delete ${operation.id} cannot have successors`);
      }
      const normalized: LifecycleTargetStateOperation = {
        ...operation,
        sourceUnitIds,
        successorUnitIds,
      };
      const targetOperations = this.operationsByTarget.get(operation.targetId) ?? [];
      targetOperations.push(normalized);
      this.operationsByTarget.set(operation.targetId, targetOperations);
      for (const unitId of new Set([...sourceUnitIds, ...successorUnitIds])) {
        const targets = new Set(this.targetsByUnitId.get(unitId) ?? []);
        targets.add(operation.targetId);
        this.targetsByUnitId.set(unitId, [...targets].sort());
        links += 1;
        if (links > limits.maxLinks) throw new Error("target-state link capacity exceeded");
      }
    }
    if (this.operationsByTarget.size > limits.maxTargets) {
      throw new Error("target-state target capacity exceeded");
    }
    for (const operationsForTarget of this.operationsByTarget.values()) {
      operationsForTarget.sort((left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id)
      );
    }
  }

  resolveIds(
    candidateIds: string[],
    policy: LifecycleTargetStatePolicy,
    now: () => number = performance.now.bind(performance),
  ): LifecycleTargetStateResolution {
    validatePolicy(policy);
    if (candidateIds.length > policy.maxCandidates) {
      throw new Error(`target-state candidate capacity exceeded: ${candidateIds.length}`);
    }
    const startedAt = now();
    const output: string[] = [];
    const emitted = new Set<string>();
    const projectedTargetIds = new Set<string>();
    const stateCache = new Map<string, TargetState>();
    let projectedCandidates = 0;
    let inactiveCandidatesSkipped = 0;
    let expansions = 0;
    let backfilled = 0;
    let maxProjectedStateUnits = 0;
    const checkBudget = () => {
      if (now() - startedAt > policy.timeoutMs) throw new Error("target-state resolution timed out");
      if (expansions > policy.maxExpansions) {
        throw new Error("target-state expansion capacity exceeded");
      }
      if (projectedTargetIds.size > policy.maxTargets) {
        throw new Error("target-state projected-target capacity exceeded");
      }
    };
    const stateFor = (targetId: string): TargetState => {
      const cached = stateCache.get(targetId);
      if (cached) return cached;
      const eligible = (this.operationsByTarget.get(targetId) ?? []).filter((operation) =>
        operation.validity === "confirmed" && operation.confidence >= policy.minConfidence
      );
      const latest = eligible.at(-1);
      const state = latest
        ? {
            available: true,
            ids: latest.kind === "delete"
              ? []
              : latest.successorUnitIds.slice(0, policy.maxStateUnits),
          }
        : { available: false, ids: [] };
      stateCache.set(targetId, state);
      return state;
    };
    const emit = (id: string, candidateIndex: number) => {
      if (!this.unitIds.has(id)) throw new Error(`target-state returned unknown unit ${id}`);
      if (emitted.has(id) || output.length >= policy.resultLimit) return;
      emitted.add(id);
      output.push(id);
      if (candidateIndex >= policy.resultLimit) backfilled += 1;
    };
    for (let candidateIndex = 0; candidateIndex < candidateIds.length; candidateIndex += 1) {
      checkBudget();
      const candidateId = candidateIds[candidateIndex];
      const targetIds = this.targetsByUnitId.get(candidateId) ?? [];
      const states = targetIds.map((targetId) => ({ targetId, state: stateFor(targetId) }));
      const available = states.filter((item) => item.state.available);
      if (!available.length) {
        emit(candidateId, candidateIndex);
      } else {
        projectedCandidates += 1;
        let emittedForCandidate = 0;
        for (const { targetId, state } of available) {
          projectedTargetIds.add(targetId);
          maxProjectedStateUnits = Math.max(maxProjectedStateUnits, state.ids.length);
          expansions += state.ids.length;
          checkBudget();
          for (const id of state.ids) {
            const before = output.length;
            emit(id, candidateIndex);
            emittedForCandidate += output.length - before;
          }
        }
        if (emittedForCandidate === 0 && available.every((item) => item.state.ids.length === 0)) {
          inactiveCandidatesSkipped += 1;
        }
      }
      if (output.length >= policy.resultLimit) break;
    }
    return {
      ids: output,
      projectedCandidates,
      projectedTargets: projectedTargetIds.size,
      inactiveCandidatesSkipped,
      expansions,
      backfilled,
      maxProjectedStateUnits,
    };
  }

  classifyIds(
    candidateIds: string[],
    policy: LifecycleTargetStatePolicy,
    now: () => number = performance.now.bind(performance),
  ): LifecycleTargetStateClassification {
    validatePolicy(policy);
    const ids = [...new Set(candidateIds)];
    if (ids.length > policy.maxCandidates) {
      throw new Error(`target-state classification capacity exceeded: ${ids.length}`);
    }
    const startedAt = now();
    const current = new Set<string>();
    const linked = new Set<string>();
    const targets = new Set<string>();
    const stateCache = new Map<string, TargetState>();
    let targetLinksVisited = 0;
    const checkBudget = () => {
      if (now() - startedAt > policy.timeoutMs) {
        throw new Error("target-state classification timed out");
      }
      if (targetLinksVisited > policy.maxExpansions) {
        throw new Error("target-state classification expansion capacity exceeded");
      }
      if (targets.size > policy.maxTargets) {
        throw new Error("target-state classification target capacity exceeded");
      }
    };
    const stateFor = (targetId: string): TargetState => {
      const cached = stateCache.get(targetId);
      if (cached) return cached;
      const latest = (this.operationsByTarget.get(targetId) ?? []).filter((operation) =>
        operation.validity === "confirmed" && operation.confidence >= policy.minConfidence
      ).at(-1);
      const state = latest
        ? {
            available: true,
            ids: latest.kind === "delete"
              ? []
              : latest.successorUnitIds,
          }
        : { available: false, ids: [] };
      stateCache.set(targetId, state);
      return state;
    };
    for (const id of ids) {
      checkBudget();
      for (const targetId of this.targetsByUnitId.get(id) ?? []) {
        targets.add(targetId);
        targetLinksVisited += 1;
        checkBudget();
        const state = stateFor(targetId);
        if (!state.available) continue;
        linked.add(id);
        if (state.ids.includes(id)) current.add(id);
      }
    }
    const stale = new Set([...linked].filter((id) => !current.has(id)));
    return {
      currentIds: ids.filter((id) => current.has(id)),
      staleIds: ids.filter((id) => stale.has(id)),
      targetLinksVisited,
      targets: targets.size,
      unknownIds: ids.filter((id) => !linked.has(id)),
    };
  }
}

function emptyResolution(ids: string[]): LifecycleTargetStateResolution {
  return {
    ids,
    projectedCandidates: 0,
    projectedTargets: 0,
    inactiveCandidatesSkipped: 0,
    expansions: 0,
    backfilled: 0,
    maxProjectedStateUnits: 0,
  };
}

export function applyLifecycleTargetState<T extends { id: string }>(params: {
  candidates: T[];
  materialize: (id: string) => T | undefined;
  now?: () => number;
  policy: LifecycleTargetStatePolicy;
  source?: LifecycleTargetStateSource;
}): LifecycleTargetStateResult<T> {
  const startedAt = performance.now();
  const baseline = params.candidates.slice(0, params.policy.resultLimit);
  if (!params.policy.enabled) {
    return {
      candidates: baseline,
      decision: {
        mode: "base",
        inputCandidates: params.candidates.length,
        outputCandidates: baseline.length,
        elapsedMs: performance.now() - startedAt,
        ...emptyResolution(baseline.map((item) => item.id)),
      },
    };
  }
  if (!params.source) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        fallbackReason: "target-state source unavailable",
        inputCandidates: params.candidates.length,
        outputCandidates: baseline.length,
        elapsedMs: performance.now() - startedAt,
        ...emptyResolution(baseline.map((item) => item.id)),
      },
    };
  }
  try {
    const resolution = params.source.resolveIds(
      params.candidates.map((candidate) => candidate.id),
      params.policy,
      params.now,
    );
    const candidates = resolution.ids.map((id) => {
      const materialized = params.materialize(id);
      if (!materialized) throw new Error(`target-state unit ${id} cannot be materialized`);
      return materialized;
    });
    return {
      candidates,
      decision: {
        mode: "adaptive",
        inputCandidates: params.candidates.length,
        outputCandidates: candidates.length,
        elapsedMs: performance.now() - startedAt,
        ...resolution,
      },
    };
  } catch (error) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        fallbackReason: error instanceof Error ? error.message : String(error),
        inputCandidates: params.candidates.length,
        outputCandidates: baseline.length,
        elapsedMs: performance.now() - startedAt,
        ...emptyResolution(baseline.map((item) => item.id)),
      },
    };
  }
}

function emptyClassification(ids: string[]): LifecycleTargetStateClassification {
  return {
    currentIds: [],
    staleIds: [],
    targetLinksVisited: 0,
    targets: 0,
    unknownIds: ids,
  };
}

export function applyLifecycleDominanceGuard<T extends { id: string }>(params: {
  challenger: T[];
  cost: (candidate: T) => number;
  incumbent: T[];
  inspector?: LifecycleTargetStateInspector;
  now?: () => number;
  policy: LifecycleTargetStatePolicy;
}): LifecycleDominanceResult<T> {
  const startedAt = performance.now();
  const incumbent = params.incumbent.slice(0, params.policy.resultLimit);
  const incumbentIds = incumbent.map((item) => item.id);
  const fallback = (
    reason: string,
    incumbentCost = 0,
    challengerCost = 0,
  ): LifecycleDominanceResult<T> => ({
    candidates: incumbent,
    decision: {
      challengerCost,
      checks: {
        budgetRespected: false,
        currentRetained: false,
        staleNotIncreased: false,
        unknownRetained: false,
      },
      elapsedMs: performance.now() - startedAt,
      fallbackReason: reason,
      incumbentCost,
      mode: "fallback",
      rejectionReasons: [reason],
      state: emptyClassification(incumbentIds),
    },
  });
  if (!params.policy.enabled) {
    return {
      candidates: incumbent,
      decision: {
        challengerCost: 0,
        checks: {
          budgetRespected: true,
          currentRetained: true,
          staleNotIncreased: true,
          unknownRetained: true,
        },
        elapsedMs: performance.now() - startedAt,
        incumbentCost: 0,
        mode: "incumbent",
        rejectionReasons: ["dominance guard disabled"],
        state: emptyClassification(incumbentIds),
      },
    };
  }
  if (!params.inspector) return fallback("target-state inspector unavailable");
  try {
    if (params.incumbent.length > params.policy.resultLimit
      || params.challenger.length > params.policy.resultLimit) {
      throw new Error("dominance guard context capacity exceeded");
    }
    const incumbentCost = incumbent.reduce((sum, item) => sum + params.cost(item), 0);
    const challengerCost = params.challenger.reduce((sum, item) => sum + params.cost(item), 0);
    if (!Number.isFinite(incumbentCost) || incumbentCost < 0
      || !Number.isFinite(challengerCost) || challengerCost < 0) {
      throw new Error("dominance guard received invalid cost");
    }
    const unionIds = [...new Set([
      ...incumbentIds,
      ...params.challenger.map((item) => item.id),
    ])];
    const state = params.inspector.classifyIds(unionIds, params.policy, params.now);
    const incumbentSet = new Set(incumbentIds);
    const challengerSet = new Set(params.challenger.map((item) => item.id));
    const currentRetained = state.currentIds
      .filter((id) => incumbentSet.has(id))
      .every((id) => challengerSet.has(id));
    const unknownRetained = state.unknownIds
      .filter((id) => incumbentSet.has(id))
      .every((id) => challengerSet.has(id));
    const staleNotIncreased = state.staleIds
      .filter((id) => challengerSet.has(id))
      .every((id) => incumbentSet.has(id));
    const budgetRespected = challengerCost <= incumbentCost;
    const checks = {
      budgetRespected,
      currentRetained,
      staleNotIncreased,
      unknownRetained,
    };
    const rejectionReasons = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    return {
      candidates: rejectionReasons.length ? incumbent : params.challenger,
      decision: {
        challengerCost,
        checks,
        elapsedMs: performance.now() - startedAt,
        incumbentCost,
        mode: rejectionReasons.length ? "incumbent" : "challenger",
        rejectionReasons,
        state,
      },
    };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}
