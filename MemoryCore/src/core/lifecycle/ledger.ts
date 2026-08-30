import { performance } from "node:perf_hooks";
import type {
  LifecycleApplyResult,
  LifecycleEvent,
  LifecycleLimits,
  LifecyclePolicy,
  LifecycleResolution,
  LifecycleResolver,
  LifecycleUnit,
} from "./types.js";

interface LifecycleEdge {
  eventId: string;
  sequence: number;
  confidence: number;
  successorUnitIds: string[];
}

export interface LifecycleLedgerStats {
  units: number;
  events: number;
  edges: number;
  invalidatedUnits: number;
}

export const DEFAULT_LIFECYCLE_LIMITS: LifecycleLimits = {
  maxUnits: 10_000,
  maxEvents: 5_000,
  maxEdges: 50_000,
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function containsValue(content: string, value: string): boolean {
  const expected = normalize(value);
  return expected.length >= 2 && normalize(content).includes(expected);
}

function validatePolicy(policy: LifecyclePolicy): void {
  if (policy.minConfidence < 0 || policy.minConfidence > 1) {
    throw new Error("lifecycle minConfidence must be in [0, 1]");
  }
  for (const [name, value] of [
    ["maxHops", policy.maxHops],
    ["maxExpansions", policy.maxExpansions],
    ["resultLimit", policy.resultLimit],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`lifecycle ${name} must be a positive integer`);
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new Error("lifecycle timeoutMs must be positive");
  }
}

export class LifecycleLedger implements LifecycleResolver {
  private readonly unitsById: Map<string, LifecycleUnit>;
  private readonly edgesByUnitId = new Map<string, LifecycleEdge[]>();
  readonly stats: LifecycleLedgerStats;

  constructor(
    units: LifecycleUnit[],
    events: LifecycleEvent[],
    limits: LifecycleLimits = DEFAULT_LIFECYCLE_LIMITS,
  ) {
    if (units.length > limits.maxUnits) throw new Error(`lifecycle unit capacity exceeded: ${units.length}`);
    if (events.length > limits.maxEvents) throw new Error(`lifecycle event capacity exceeded: ${events.length}`);
    this.unitsById = new Map();
    for (const unit of units) {
      if (!unit.id || !Number.isFinite(unit.sequence)) throw new Error("invalid lifecycle unit");
      if (this.unitsById.has(unit.id)) throw new Error(`duplicate lifecycle unit id: ${unit.id}`);
      this.unitsById.set(unit.id, unit);
    }

    let edgeCount = 0;
    const sortedEvents = [...events].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    for (const event of sortedEvents) {
      if (!event.id || !Number.isFinite(event.sequence)) throw new Error("invalid lifecycle event");
      if (event.confidence < 0 || event.confidence > 1) throw new Error(`invalid confidence for ${event.id}`);
      const successorIds = [...new Set(event.successorUnitIds)];
      for (const successorId of successorIds) {
        const successor = this.unitsById.get(successorId);
        if (!successor) throw new Error(`lifecycle event ${event.id} references missing successor ${successorId}`);
        if (successor.sequence < event.sequence) {
          throw new Error(`lifecycle event ${event.id} points backward to ${successorId}`);
        }
      }
      const obsoleteValues = [...new Set(event.obsoleteValues.map((value) => value.trim()).filter(Boolean))];
      const directPredecessorIds = [...new Set(event.predecessorUnitIds ?? [])].filter(Boolean);
      const predecessorIds = directPredecessorIds.length > 0
        ? directPredecessorIds
        : obsoleteValues.length > 0
          ? units
              .filter((unit) => unit.sequence < event.sequence && !successorIds.includes(unit.id))
              .filter((unit) => obsoleteValues.some((value) => containsValue(unit.content, value)))
              .map((unit) => unit.id)
          : [];
      for (const predecessorId of predecessorIds) {
        const entries = this.edgesByUnitId.get(predecessorId) ?? [];
        entries.push({
          eventId: event.id,
          sequence: event.sequence,
          confidence: event.confidence,
          successorUnitIds: successorIds,
        });
        this.edgesByUnitId.set(predecessorId, entries);
        edgeCount += 1;
        if (edgeCount > limits.maxEdges) throw new Error(`lifecycle edge capacity exceeded: ${edgeCount}`);
      }
    }
    this.stats = {
      units: units.length,
      events: events.length,
      edges: edgeCount,
      invalidatedUnits: this.edgesByUnitId.size,
    };
  }

  resolveIds(
    candidateIds: string[],
    policy: LifecyclePolicy,
    now: () => number = performance.now.bind(performance),
  ): LifecycleResolution {
    validatePolicy(policy);
    const startedAt = now();
    const output: string[] = [];
    const emitted = new Set<string>();
    let redirects = 0;
    let expansions = 0;
    let maxObservedHops = 0;

    const checkBudget = () => {
      if (now() - startedAt > policy.timeoutMs) throw new Error("lifecycle resolution timed out");
      if (expansions > policy.maxExpansions) throw new Error("lifecycle expansion capacity exceeded");
    };

    const resolve = (unitId: string, depth: number, path: Set<string>): string[] => {
      checkBudget();
      if (path.has(unitId)) throw new Error(`lifecycle cycle detected at ${unitId}`);
      const eligible = (this.edgesByUnitId.get(unitId) ?? [])
        .filter((edge) => edge.confidence >= policy.minConfidence);
      if (!eligible.length) return [unitId];
      if (depth >= policy.maxHops) return [];
      const latestSequence = Math.max(...eligible.map((edge) => edge.sequence));
      const latestEdges = eligible.filter((edge) => edge.sequence === latestSequence);
      const successors = [...new Set(latestEdges.flatMap((edge) => edge.successorUnitIds))];
      redirects += 1;
      maxObservedHops = Math.max(maxObservedHops, depth + 1);
      expansions += successors.length;
      checkBudget();
      const nextPath = new Set(path).add(unitId);
      return successors.flatMap((successorId) => resolve(successorId, depth + 1, nextPath));
    };

    for (const candidateId of candidateIds) {
      for (const resolvedId of resolve(candidateId, 0, new Set())) {
        if (!this.unitsById.has(resolvedId) && !candidateIds.includes(resolvedId)) {
          throw new Error(`lifecycle resolution returned unknown unit ${resolvedId}`);
        }
        if (emitted.has(resolvedId)) continue;
        emitted.add(resolvedId);
        output.push(resolvedId);
        if (output.length >= policy.resultLimit) break;
      }
      if (output.length >= policy.resultLimit) break;
    }
    return { ids: output, redirects, maxObservedHops, expansions };
  }
}

export function applyLifecyclePolicy<T extends { id: string }>(params: {
  candidates: T[];
  resolver?: LifecycleResolver;
  policy: LifecyclePolicy;
  materialize: (id: string) => T | undefined;
  now?: () => number;
}): LifecycleApplyResult<T> {
  const startedAt = performance.now();
  const baseline = params.candidates.slice(0, params.policy.resultLimit);
  if (!params.policy.enabled) {
    return {
      candidates: baseline,
      decision: {
        mode: "base",
        policy: params.policy,
        inputCandidates: params.candidates.length,
        outputCandidates: baseline.length,
        redirects: 0,
        maxObservedHops: 0,
        expansions: 0,
        elapsedMs: performance.now() - startedAt,
      },
    };
  }
  if (!params.resolver) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        policy: params.policy,
        inputCandidates: params.candidates.length,
        outputCandidates: baseline.length,
        redirects: 0,
        maxObservedHops: 0,
        expansions: 0,
        elapsedMs: performance.now() - startedAt,
        fallbackReason: "lifecycle ledger unavailable",
      },
    };
  }
  try {
    const resolution = params.resolver.resolveIds(
      params.candidates.map((candidate) => candidate.id),
      params.policy,
      params.now,
    );
    const materialized = resolution.ids.map((id) => {
      const candidate = params.materialize(id);
      if (!candidate) throw new Error(`lifecycle successor ${id} cannot be materialized`);
      return candidate;
    });
    return {
      candidates: materialized,
      decision: {
        mode: "adaptive",
        policy: params.policy,
        inputCandidates: params.candidates.length,
        outputCandidates: materialized.length,
        redirects: resolution.redirects,
        maxObservedHops: resolution.maxObservedHops,
        expansions: resolution.expansions,
        elapsedMs: performance.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        policy: params.policy,
        inputCandidates: params.candidates.length,
        outputCandidates: baseline.length,
        redirects: 0,
        maxObservedHops: 0,
        expansions: 0,
        elapsedMs: performance.now() - startedAt,
        fallbackReason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
