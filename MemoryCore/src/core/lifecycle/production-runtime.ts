import { performance } from "node:perf_hooks";
import type { StorageAdapter } from "../storage/adapter.js";
import { applyLifecyclePolicy, LifecycleLedger } from "./ledger.js";
import { loadLifecycleFeedbackEvents, type LifecycleFeedbackScope } from "./feedback-store.js";
import type { LifecycleApplyResult, LifecycleEvent, LifecyclePolicy, LifecycleUnit } from "./types.js";

export interface LifecycleRuntimeCandidate {
  id: string;
  content: string;
  /** Optional retriever score; direct successors inherit their predecessor's score. */
  score?: number;
}

/**
 * Apply the persisted correction ledger to real, id-bearing recall candidates.
 * Every failure returns the exact Base prefix supplied by the retriever.
 */
export async function applyPersistedLifecycle<T extends LifecycleRuntimeCandidate>(params: {
  candidates: T[];
  policy: LifecyclePolicy;
  maxEvents: number;
  baseDir: string;
  storage?: StorageAdapter;
  scope: LifecycleFeedbackScope;
  materialize: (ids: string[]) => Promise<T[]>;
}): Promise<LifecycleApplyResult<T>> {
  const startedAt = performance.now();
  const baseline = params.candidates.slice(0, params.policy.resultLimit);
  if (!params.policy.enabled) {
    return applyLifecyclePolicy({
      candidates: params.candidates,
      policy: params.policy,
      materialize: () => undefined,
    });
  }

  let deadline: NodeJS.Timeout | undefined;
  try {
    const run = async (): Promise<LifecycleApplyResult<T>> => {
      const loaded = await loadLifecycleFeedbackEvents({
        baseDir: params.baseDir,
        storage: params.storage,
        scope: params.scope,
        maxEvents: params.maxEvents,
      });
      const releasedEvents = loaded.events.filter((event) => event.confidence >= params.policy.minConfidence);
      if (releasedEvents.length === 0) {
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
      const successorIds = [...new Set(releasedEvents.flatMap((event) => event.successorMemoryIds))];
      const candidateIds = new Set(params.candidates.map((candidate) => candidate.id));
      const missingSuccessorIds = successorIds.filter((id) => !candidateIds.has(id));
      const loadedSuccessors = missingSuccessorIds.length > 0
        ? await params.materialize(missingSuccessorIds)
        : [];
      const candidateScoreById = new Map(
        params.candidates
          .filter((candidate) => Number.isFinite(candidate.score))
          .map((candidate) => [candidate.id, candidate.score as number]),
      );
      const inheritedScoreBySuccessor = new Map<string, number>();
      for (const event of releasedEvents) {
        const predecessorScores = event.predecessorMemoryIds
          .map((id) => candidateScoreById.get(id))
          .filter((score): score is number => score !== undefined);
        if (predecessorScores.length === 0) continue;
        const inherited = Math.max(...predecessorScores);
        for (const successorId of event.successorMemoryIds) {
          inheritedScoreBySuccessor.set(
            successorId,
            Math.max(inheritedScoreBySuccessor.get(successorId) ?? Number.NEGATIVE_INFINITY, inherited),
          );
        }
      }
      const successors = loadedSuccessors.map((candidate) => {
        const inheritedScore = inheritedScoreBySuccessor.get(candidate.id);
        return inheritedScore === undefined ? candidate : { ...candidate, score: inheritedScore };
      });
      const materializedById = new Map<string, T>();
      for (const candidate of [...params.candidates, ...successors]) materializedById.set(candidate.id, candidate);

      const successorSequence = new Map<string, number>();
      for (const event of releasedEvents) {
        for (const successorId of event.successorMemoryIds) {
          successorSequence.set(successorId, Math.max(successorSequence.get(successorId) ?? 0, event.occurredAtMs));
        }
      }
      const units: LifecycleUnit[] = [...materializedById.values()].map((candidate) => ({
        id: candidate.id,
        content: candidate.content,
        sequence: successorSequence.get(candidate.id) ?? 0,
      }));
      const events: LifecycleEvent[] = releasedEvents.map((event) => ({
        id: event.eventId,
        kind: event.kind,
        sequence: event.occurredAtMs,
        confidence: event.confidence,
        obsoleteValues: [],
        predecessorUnitIds: event.predecessorMemoryIds,
        successorUnitIds: event.successorMemoryIds,
        source: event.source,
      }));
      const resolver = new LifecycleLedger(units, events);
      const applied = applyLifecyclePolicy({
        candidates: params.candidates,
        resolver,
        policy: params.policy,
        materialize: (id) => materializedById.get(id),
      });
      return {
        candidates: applied.candidates,
        decision: { ...applied.decision, elapsedMs: performance.now() - startedAt },
      };
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error("lifecycle sidecar timed out")),
        params.policy.timeoutMs,
      );
    });
    return await Promise.race([run(), timeout]);
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
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
