import { performance } from "node:perf_hooks";
import type { LifecycleEvent, LifecycleUnit } from "./types.js";

interface VacancyEdge {
  confidence: number;
  eventId: string;
  kind: "update" | "delete";
  sequence: number;
  successorUnitIds: string[];
}

interface TombstoneAnnotation {
  confidence: number;
  eventId: string;
  sequence: number;
}

export interface LifecycleDeleteVacancyLimits {
  maxEdges: number;
  maxEvents: number;
  maxTombstones: number;
  maxUnits: number;
}

export interface LifecycleDeleteVacancyPolicy {
  enabled: boolean;
  maxCandidates: number;
  maxExpansions: number;
  maxHops: number;
  minConfidence: number;
  resultLimit: number;
  timeoutMs: number;
}

export interface LifecycleDeleteVacancyResolution {
  backfilled: number;
  deletePredecessorsSkipped: number;
  deleteTombstonesSkipped: number;
  expansions: number;
  ids: string[];
  maxObservedHops: number;
  redirects: number;
}

export interface LifecycleDeleteVacancySource {
  resolveIds(
    candidateIds: string[],
    policy: LifecycleDeleteVacancyPolicy,
    now?: () => number,
  ): LifecycleDeleteVacancyResolution;
}

export interface LifecycleDeleteVacancyDecision {
  backfilled: number;
  deletePredecessorsSkipped: number;
  deleteTombstonesSkipped: number;
  elapsedMs: number;
  expansions: number;
  fallbackReason?: string;
  inputCandidates: number;
  maxObservedHops: number;
  mode: "base" | "adaptive" | "fallback";
  outputCandidates: number;
  redirects: number;
}

export interface LifecycleDeleteVacancyResult<T> {
  candidates: T[];
  decision: LifecycleDeleteVacancyDecision;
}

export const DEFAULT_DELETE_VACANCY_LIMITS: LifecycleDeleteVacancyLimits = {
  maxUnits: 10_000,
  maxEvents: 5_000,
  maxEdges: 50_000,
  maxTombstones: 5_000,
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function containsValue(content: string, value: string): boolean {
  const expected = normalize(value);
  return expected.length >= 2 && normalize(content).includes(expected);
}

function validatePolicy(policy: LifecycleDeleteVacancyPolicy): void {
  if (policy.minConfidence < 0 || policy.minConfidence > 1) {
    throw new Error("delete-vacancy minConfidence must be in [0, 1]");
  }
  for (const [name, value] of [
    ["maxCandidates", policy.maxCandidates],
    ["maxExpansions", policy.maxExpansions],
    ["maxHops", policy.maxHops],
    ["resultLimit", policy.resultLimit],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`delete-vacancy ${name} must be a positive integer`);
    }
  }
  if (policy.resultLimit > policy.maxCandidates) {
    throw new Error("delete-vacancy resultLimit cannot exceed maxCandidates");
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new Error("delete-vacancy timeoutMs must be positive");
  }
}

export class LifecycleDeleteVacancy implements LifecycleDeleteVacancySource {
  private readonly edgesByUnitId = new Map<string, VacancyEdge[]>();
  private readonly tombstonesByUnitId = new Map<string, TombstoneAnnotation[]>();
  private readonly unitsById: Map<string, LifecycleUnit>;

  constructor(
    units: LifecycleUnit[],
    events: LifecycleEvent[],
    limits: LifecycleDeleteVacancyLimits = DEFAULT_DELETE_VACANCY_LIMITS,
  ) {
    if (units.length > limits.maxUnits) {
      throw new Error(`delete-vacancy unit capacity exceeded: ${units.length}`);
    }
    if (events.length > limits.maxEvents) {
      throw new Error(`delete-vacancy event capacity exceeded: ${events.length}`);
    }
    this.unitsById = new Map();
    for (const unit of units) {
      if (!unit.id || !Number.isFinite(unit.sequence)) throw new Error("invalid delete-vacancy unit");
      if (this.unitsById.has(unit.id)) throw new Error(`duplicate delete-vacancy unit id: ${unit.id}`);
      this.unitsById.set(unit.id, unit);
    }

    let edges = 0;
    let tombstones = 0;
    const sorted = [...events].sort((left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id)
    );
    for (const event of sorted) {
      if (!event.id || !Number.isFinite(event.sequence)) throw new Error("invalid delete-vacancy event");
      if (event.confidence < 0 || event.confidence > 1) {
        throw new Error(`invalid delete-vacancy confidence for ${event.id}`);
      }
      const successorUnitIds = [...new Set(event.successorUnitIds)];
      for (const successorUnitId of successorUnitIds) {
        const successor = this.unitsById.get(successorUnitId);
        if (!successor) throw new Error(`delete-vacancy event ${event.id} has a missing successor`);
        if (successor.sequence < event.sequence) {
          throw new Error(`delete-vacancy event ${event.id} points backward`);
        }
        if (event.kind === "delete") {
          const annotations = this.tombstonesByUnitId.get(successorUnitId) ?? [];
          annotations.push({
            confidence: event.confidence,
            eventId: event.id,
            sequence: event.sequence,
          });
          this.tombstonesByUnitId.set(successorUnitId, annotations);
          tombstones += 1;
          if (tombstones > limits.maxTombstones) {
            throw new Error(`delete-vacancy tombstone capacity exceeded: ${tombstones}`);
          }
        }
      }
      const obsoleteValues = [...new Set(event.obsoleteValues.map((value) => value.trim()).filter(Boolean))];
      if (!obsoleteValues.length) continue;
      for (const unit of units) {
        if (unit.sequence >= event.sequence || successorUnitIds.includes(unit.id)) continue;
        if (!obsoleteValues.some((value) => containsValue(unit.content, value))) continue;
        const entries = this.edgesByUnitId.get(unit.id) ?? [];
        entries.push({
          confidence: event.confidence,
          eventId: event.id,
          kind: event.kind,
          sequence: event.sequence,
          successorUnitIds,
        });
        this.edgesByUnitId.set(unit.id, entries);
        edges += 1;
        if (edges > limits.maxEdges) {
          throw new Error(`delete-vacancy edge capacity exceeded: ${edges}`);
        }
      }
    }
  }

  resolveIds(
    candidateIds: string[],
    policy: LifecycleDeleteVacancyPolicy,
    now: () => number = performance.now.bind(performance),
  ): LifecycleDeleteVacancyResolution {
    validatePolicy(policy);
    if (candidateIds.length > policy.maxCandidates) {
      throw new Error(`delete-vacancy candidate capacity exceeded: ${candidateIds.length}`);
    }
    const startedAt = now();
    const output: string[] = [];
    const emitted = new Set<string>();
    let redirects = 0;
    let expansions = 0;
    let maxObservedHops = 0;
    let deletePredecessorsSkipped = 0;
    let deleteTombstonesSkipped = 0;
    let backfilled = 0;

    const checkBudget = () => {
      if (now() - startedAt > policy.timeoutMs) throw new Error("delete-vacancy timed out");
      if (expansions > policy.maxExpansions) {
        throw new Error("delete-vacancy expansion capacity exceeded");
      }
    };
    const isDeleteTombstone = (unitId: string) =>
      (this.tombstonesByUnitId.get(unitId) ?? [])
        .some((entry) => entry.confidence >= policy.minConfidence);
    const resolve = (unitId: string, depth: number, path: Set<string>): string[] => {
      checkBudget();
      if (path.has(unitId)) throw new Error(`delete-vacancy cycle detected at ${unitId}`);
      if (isDeleteTombstone(unitId)) {
        deleteTombstonesSkipped += 1;
        return [];
      }
      const eligible = (this.edgesByUnitId.get(unitId) ?? [])
        .filter((edge) => edge.confidence >= policy.minConfidence);
      if (!eligible.length) return [unitId];
      if (depth >= policy.maxHops) return [];
      const latestSequence = Math.max(...eligible.map((edge) => edge.sequence));
      const latest = eligible.filter((edge) => edge.sequence === latestSequence);
      const kinds = new Set(latest.map((edge) => edge.kind));
      if (kinds.size !== 1) throw new Error(`delete-vacancy mixed latest event kinds at ${unitId}`);
      redirects += 1;
      maxObservedHops = Math.max(maxObservedHops, depth + 1);
      if (latest[0].kind === "delete") {
        deletePredecessorsSkipped += 1;
        return [];
      }
      const successors = [...new Set(latest.flatMap((edge) => edge.successorUnitIds))];
      expansions += successors.length;
      checkBudget();
      const nextPath = new Set(path).add(unitId);
      return successors.flatMap((successorId) => resolve(successorId, depth + 1, nextPath));
    };

    candidateIds.forEach((candidateId, candidateIndex) => {
      if (output.length >= policy.resultLimit) return;
      if (!this.unitsById.has(candidateId)) {
        throw new Error(`delete-vacancy received unknown candidate ${candidateId}`);
      }
      for (const resolvedId of resolve(candidateId, 0, new Set())) {
        if (!this.unitsById.has(resolvedId)) {
          throw new Error(`delete-vacancy returned unknown unit ${resolvedId}`);
        }
        if (emitted.has(resolvedId)) continue;
        emitted.add(resolvedId);
        output.push(resolvedId);
        if (candidateIndex >= policy.resultLimit) backfilled += 1;
        if (output.length >= policy.resultLimit) break;
      }
    });
    checkBudget();
    return {
      ids: output,
      redirects,
      expansions,
      maxObservedHops,
      deletePredecessorsSkipped,
      deleteTombstonesSkipped,
      backfilled,
    };
  }
}

export function applyLifecycleDeleteVacancy<T extends { id: string }>(params: {
  candidates: T[];
  materialize: (id: string) => T | undefined;
  now?: () => number;
  policy: LifecycleDeleteVacancyPolicy;
  source?: LifecycleDeleteVacancySource;
}): LifecycleDeleteVacancyResult<T> {
  const startedAt = performance.now();
  const baseline = params.candidates.slice(0, params.policy.resultLimit);
  const emptyDecision = {
    inputCandidates: params.candidates.length,
    outputCandidates: baseline.length,
    redirects: 0,
    expansions: 0,
    maxObservedHops: 0,
    deletePredecessorsSkipped: 0,
    deleteTombstonesSkipped: 0,
    backfilled: 0,
  };
  if (!params.policy.enabled) {
    return {
      candidates: baseline,
      decision: {
        mode: "base",
        ...emptyDecision,
        elapsedMs: performance.now() - startedAt,
      },
    };
  }
  if (!params.source) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        ...emptyDecision,
        elapsedMs: performance.now() - startedAt,
        fallbackReason: "delete-vacancy source unavailable",
      },
    };
  }
  try {
    const resolution = params.source.resolveIds(
      params.candidates.map((candidate) => candidate.id),
      params.policy,
      params.now,
    );
    if (resolution.ids.length > params.policy.resultLimit) {
      throw new Error("delete-vacancy returned too many candidates");
    }
    const candidates = resolution.ids.map((id) => {
      const candidate = params.materialize(id);
      if (!candidate) throw new Error(`delete-vacancy candidate ${id} cannot be materialized`);
      return candidate;
    });
    return {
      candidates,
      decision: {
        mode: "adaptive",
        inputCandidates: params.candidates.length,
        outputCandidates: candidates.length,
        redirects: resolution.redirects,
        expansions: resolution.expansions,
        maxObservedHops: resolution.maxObservedHops,
        deletePredecessorsSkipped: resolution.deletePredecessorsSkipped,
        deleteTombstonesSkipped: resolution.deleteTombstonesSkipped,
        backfilled: resolution.backfilled,
        elapsedMs: performance.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        ...emptyDecision,
        elapsedMs: performance.now() - startedAt,
        fallbackReason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
