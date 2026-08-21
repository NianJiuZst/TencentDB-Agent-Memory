import type { LongTaskState, LongTaskTrajectory } from "./long-task-adapter.js";
import { packLongTaskContext, type PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import type { MemoryUnit, RetrievedUnit } from "./types.js";

export interface TransitionIndexConfig {
  maxCharacters: number;
  maxChunksPerTransition: number;
  maxAuxiliaryUnits: number;
}

export interface TransitionIndexResult {
  units: MemoryUnit[];
  transitions: number;
  transitionsWithNoTextDelta: number;
  truncatedTransitions: number;
  addedLines: number;
  removedLines: number;
}

export interface TransitionPolicy {
  id: string;
  transitionCandidateLimit: number;
  transitionTokenFraction: number;
  maxTransitionItems: number;
}

export type TransitionFallbackReason =
  | "disabled"
  | "missing_auxiliary_index"
  | "sidecar_timeout"
  | "corrupt_auxiliary_unit"
  | "budget_overflow";

export interface TransitionSelectionResult extends PackedLongTaskContext {
  mode: "transition_augmented" | "baseline_noop" | "fallback_baseline";
  usedAuxiliary: boolean;
  transitionIds: string[];
  rawIds: string[];
  fallback: boolean;
  fallbackReason: TransitionFallbackReason | null;
  transitionBudget: number;
}

interface StateDelta {
  added: string[];
  removed: string[];
}

export function normalizeAxTreeLine(value: string): string {
  return value.trim()
    .replace(/\[([a-zA-Z]*?)\d+\]/g, (_match, prefix: string) => `[${prefix}#]`)
    .replace(/\s+/g, " ");
}

function normalizedLines(text: string): string[] {
  return text.split("\n").map(normalizeAxTreeLine).filter(Boolean);
}

function orderedMultisetDifference(left: string[], right: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const value of right) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  const result: string[] = [];
  for (const value of left) {
    const count = remaining.get(value) ?? 0;
    if (count > 0) {
      remaining.set(value, count - 1);
    } else {
      result.push(value);
    }
  }
  return result;
}

export function diffLongTaskStates(pre: LongTaskState, post: LongTaskState): StateDelta {
  const preLines = normalizedLines(pre.observation);
  const postLines = normalizedLines(post.observation);
  return {
    added: orderedMultisetDifference(postLines, preLines),
    removed: orderedMultisetDifference(preLines, postLines),
  };
}

function actionObjectLookup(state: LongTaskState): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const line of state.observation.split("\n")) {
    const match = /^\s*\[([^\]]+)\]\s+(.+)$/.exec(line);
    if (match) lookup.set(match[1], normalizeAxTreeLine(match[2]));
  }
  return lookup;
}

export function annotateTransitionAction(action: string | null, pre: LongTaskState): string {
  if (!action?.trim()) return "<none>";
  const lookup = actionObjectLookup(pre);
  const targets = [...action.matchAll(/["']([^"']+)["']/g)]
    .map((match) => lookup.get(match[1]))
    .filter((value): value is string => Boolean(value));
  return targets.length > 0
    ? `${action.trim()} | target: ${[...new Set(targets)].join(" | ")}`
    : action.trim();
}

function interleavedDeltaLines(delta: StateDelta): string[] {
  const lines: string[] = [];
  const length = Math.max(delta.added.length, delta.removed.length);
  for (let index = 0; index < length; index += 1) {
    if (index < delta.added.length) lines.push(`ADDED: ${delta.added[index]}`);
    if (index < delta.removed.length) lines.push(`REMOVED: ${delta.removed[index]}`);
  }
  return lines;
}

function lineBoundedChunks(lines: string[], maxCharacters: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const line of lines) {
    if (line.length > maxCharacters) {
      flush();
      for (let start = 0; start < line.length; start += maxCharacters) {
        chunks.push(line.slice(start, start + maxCharacters));
      }
      continue;
    }
    const combined = current ? `${current}\n${line}` : line;
    if (combined.length > maxCharacters) {
      flush();
      current = line;
    } else {
      current = combined;
    }
  }
  flush();
  return chunks;
}

function evenlyBoundedChunks(allChunks: string[], maxChunks: number): {
  chunks: string[];
  truncated: boolean;
} {
  if (allChunks.length <= maxChunks) return { chunks: allChunks, truncated: false };
  if (maxChunks === 1) return { chunks: [allChunks[0]], truncated: true };
  const indexes = Array.from({ length: maxChunks }, (_, index) =>
    Math.round(index * (allChunks.length - 1) / (maxChunks - 1))
  );
  return {
    chunks: indexes.map((index) => allChunks[index]),
    truncated: true,
  };
}

export function buildTransitionUnits(params: {
  trajectories: LongTaskTrajectory[];
  config: TransitionIndexConfig;
}): TransitionIndexResult {
  const trajectories = [...params.trajectories].sort((left, right) => left.id.localeCompare(right.id));
  const units: MemoryUnit[] = [];
  let transitions = 0;
  let transitionsWithNoTextDelta = 0;
  let truncatedTransitions = 0;
  let addedLines = 0;
  let removedLines = 0;
  for (let trajectoryIndex = 0; trajectoryIndex < trajectories.length; trajectoryIndex += 1) {
    const trajectory = trajectories[trajectoryIndex];
    for (let postIndex = 1; postIndex < trajectory.states.length; postIndex += 1) {
      transitions += 1;
      const pre = trajectory.states[postIndex - 1];
      const post = trajectory.states[postIndex];
      const delta = diffLongTaskStates(pre, post);
      addedLines += delta.added.length;
      removedLines += delta.removed.length;
      const lines = interleavedDeltaLines(delta);
      if (lines.length === 0) transitionsWithNoTextDelta += 1;
      const deltaLines = lines.length > 0
        ? lines
        : ["NO NORMALIZED ACCESSIBILITY-TREE TEXT CHANGE"];
      const bounded = evenlyBoundedChunks(
        lineBoundedChunks(deltaLines, params.config.maxCharacters),
        params.config.maxChunksPerTransition,
      );
      if (bounded.truncated) truncatedTransitions += 1;
      for (let chunkIndex = 0; chunkIndex < bounded.chunks.length; chunkIndex += 1) {
        if (units.length >= params.config.maxAuxiliaryUnits) {
          throw new Error(
            `LongMemEval-V2 transition index exceeded maxAuxiliaryUnits=${params.config.maxAuxiliaryUnits}`,
          );
        }
        const sequence = trajectoryIndex * 100_000
          + (postIndex - 1) * params.config.maxChunksPerTransition
          + chunkIndex;
        units.push({
          id: `lmev2:transition:${trajectory.id}:${pre.index}:${post.index}:${chunkIndex}`,
          sessionId: trajectory.id,
          role: "assistant",
          content: [
            `[state-transition trajectory=${trajectory.id} pre=${pre.index} post=${post.index} chunk=${chunkIndex}]`,
            `Goal: ${trajectory.goal}`,
            `Pre URL: ${pre.url}`,
            `Action: ${annotateTransitionAction(post.transitionAction, pre)}`,
            `Post URL: ${post.url}`,
            bounded.chunks[chunkIndex],
          ].join("\n"),
          timestampMs: Date.UTC(2025, 0, 1) + sequence * 1_000,
          sequence,
        });
      }
    }
  }
  return {
    units,
    transitions,
    transitionsWithNoTextDelta,
    truncatedTransitions,
    addedLines,
    removedLines,
  };
}

export function buildTransitionPolicyGrid(params: {
  candidateLimits: readonly number[];
  tokenFractions: readonly number[];
  maxItems: readonly number[];
}): TransitionPolicy[] {
  const policies = params.candidateLimits.flatMap((candidateLimit) =>
    params.tokenFractions.flatMap((tokenFraction) =>
      params.maxItems.map((maxItems): TransitionPolicy => ({
        id: `tc${candidateLimit}-tf${String(Math.round(tokenFraction * 100)).padStart(2, "0")}-mi${maxItems}`,
        transitionCandidateLimit: candidateLimit,
        transitionTokenFraction: tokenFraction,
        maxTransitionItems: maxItems,
      }))
    )
  );
  if (new Set(policies.map((policy) => policy.id)).size !== policies.length) {
    throw new Error("duplicate LongMemEval-V2 transition policy id");
  }
  return policies.sort((left, right) => left.id.localeCompare(right.id));
}

function exactBaseline(
  baseline: PackedLongTaskContext,
  reason: TransitionFallbackReason | null,
): TransitionSelectionResult {
  return {
    ...baseline,
    items: [...baseline.items],
    mode: reason ? "fallback_baseline" : "baseline_noop",
    usedAuxiliary: false,
    transitionIds: [],
    rawIds: baseline.items.map((item) => item.id),
    fallback: reason !== null,
    fallbackReason: reason,
    transitionBudget: 0,
  };
}

function corruptTransitionCandidate(candidate: RetrievedUnit): boolean {
  return !candidate.id.startsWith("lmev2:transition:")
    || !Number.isFinite(candidate.tokenCount)
    || candidate.tokenCount <= 0
    || typeof candidate.content !== "string"
    || candidate.content.length === 0;
}

export function selectTransitionAugmentedContext(params: {
  baseline: PackedLongTaskContext;
  rawCandidates: RetrievedUnit[];
  transitionCandidates: RetrievedUnit[];
  policy: TransitionPolicy;
  tokenBudget: number;
  resultLimit: number;
  enabled?: boolean;
  auxiliaryIndexAvailable?: boolean;
  timedOut?: boolean;
  forceCorrupt?: boolean;
}): TransitionSelectionResult {
  if (params.enabled === false) return exactBaseline(params.baseline, "disabled");
  if (params.auxiliaryIndexAvailable === false) {
    return exactBaseline(params.baseline, "missing_auxiliary_index");
  }
  if (params.timedOut) return exactBaseline(params.baseline, "sidecar_timeout");
  const transitionCandidates = params.transitionCandidates
    .slice(0, params.policy.transitionCandidateLimit);
  if (params.forceCorrupt || transitionCandidates.some(corruptTransitionCandidate)) {
    return exactBaseline(params.baseline, "corrupt_auxiliary_unit");
  }
  const transitionBudget = Math.floor(params.tokenBudget * params.policy.transitionTokenFraction);
  const transition = packLongTaskContext({
    candidates: transitionCandidates,
    tokenBudget: transitionBudget,
    resultLimit: Math.min(params.policy.maxTransitionItems, params.resultLimit),
  });
  if (transition.items.length === 0) return exactBaseline(params.baseline, null);
  const raw = packLongTaskContext({
    candidates: params.rawCandidates,
    tokenBudget: params.tokenBudget - transition.injectedTokens,
    resultLimit: params.resultLimit - transition.items.length,
  });
  const items = [...transition.items, ...raw.items];
  const injectedTokens = transition.injectedTokens + raw.injectedTokens;
  if (transition.tokenViolation
    || raw.tokenViolation
    || injectedTokens > params.tokenBudget
    || items.length > params.resultLimit) {
    return exactBaseline(params.baseline, "budget_overflow");
  }
  return {
    items,
    injectedTokens,
    tokenViolation: false,
    mode: "transition_augmented",
    usedAuxiliary: true,
    transitionIds: transition.items.map((item) => item.id),
    rawIds: raw.items.map((item) => item.id),
    fallback: false,
    fallbackReason: null,
    transitionBudget,
  };
}
