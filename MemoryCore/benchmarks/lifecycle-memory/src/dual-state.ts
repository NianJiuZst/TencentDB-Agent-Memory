import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import type { LifecycleResolver } from "../../../src/core/lifecycle/index.js";
import { classifyLifecycleQueryIntent } from "./query-intent.js";
import { contextualCase, V1_POLICY } from "./contextual-runner.js";
import type { PreparedCase } from "./adaptive-runner.js";
import {
  DUAL_STATE_CONTEXT_PROTOCOL,
  type DualStateIntent,
} from "./dual-state-context-protocol.js";
import type { RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

const CHANGE_PATTERNS = [
  /\bhow (?:did|has|have).+chang(?:e|ed)\b/i,
  /\bwhat changed\b/i,
  /\bfrom .+ to\b/i,
  /\bcompare (?:the )?(?:old|previous|former).+(?:new|current)\b/i,
];

const HISTORICAL_PATTERNS = [
  /\bprevious(?:ly)?\b/i,
  /\bformer(?:ly)?\b/i,
  /\bbefore .+ chang(?:e|ed)\b/i,
  /\bwhat (?:did|was|were).+used to\b/i,
  /\bat that time\b/i,
];

export function classifyDualStateIntent(query: string): DualStateIntent {
  if (CHANGE_PATTERNS.some((pattern) => pattern.test(query))) return "state_change";
  if (HISTORICAL_PATTERNS.some((pattern) => pattern.test(query))) return "historical_state";
  return classifyLifecycleQueryIntent(query) === "historical_aggregate"
    ? "historical_aggregate"
    : "current_state";
}

export function shouldReturnDualState(intent: DualStateIntent): boolean {
  return DUAL_STATE_CONTEXT_PROTOCOL.intent.dualEligible.includes(intent);
}

function virtualId(historical: RetrievedUnit, current: RetrievedUnit): string {
  const digest = createHash("sha256")
    .update(`${historical.id}\0${current.id}\0${historical.content}\0${current.content}`)
    .digest("hex")
    .slice(0, 20);
  return `dual-state:${digest}`;
}

export function renderDualStateTransition(
  historical: RetrievedUnit,
  current: RetrievedUnit,
): RetrievedUnit {
  const labels = DUAL_STATE_CONTEXT_PROTOCOL.rendering;
  const content = [
    `[${labels.updateLabel} — use CURRENT for present-state answers]`,
    `${labels.historicalLabel}: ${historical.content}`,
    `${labels.currentLabel}: ${current.content}`,
  ].join("\n");
  return {
    ...current,
    id: virtualId(historical, current),
    content,
    tokenCount: encoding.encode(content).length,
  };
}

export interface DualStateCandidateResult {
  candidates: RetrievedUnit[];
  pairCount: number;
  fallback: boolean;
}

function materializeV1(prepared: PreparedCase, resolver?: LifecycleResolver, now?: () => number) {
  const result = contextualCase({
    prepared,
    policy: V1_POLICY,
    arm: "v1",
    ...(resolver ? { resolver } : {}),
    ...(now ? { now } : {}),
  });
  return {
    result,
    candidates: result.candidateIds.map((id) => {
      const candidate = prepared.materialize(id)
        ?? prepared.candidates.find((item) => item.id === id);
      if (!candidate) throw new Error(`D19 cannot materialize V1 candidate ${id}`);
      return candidate;
    }),
  };
}

export function dualStateCandidates(params: {
  prepared: PreparedCase;
  resolver?: LifecycleResolver;
  now?: () => number;
}): DualStateCandidateResult {
  const effectiveResolver = params.resolver ?? params.prepared.resolver;
  const v1 = materializeV1(params.prepared, params.resolver, params.now);
  if (v1.result.action === "fallback" || !effectiveResolver) {
    return { candidates: v1.candidates, pairCount: 0, fallback: true };
  }

  try {
    const predecessorByCurrent = new Map<string, RetrievedUnit>();
    const selectedCurrent = new Set(v1.candidates.map((item) => item.id));
    const pool = params.prepared.candidates.slice(0, DUAL_STATE_CONTEXT_PROTOCOL.rendering.candidatePool);
    for (const predecessor of pool) {
      const resolution = effectiveResolver.resolveIds(
        [predecessor.id],
        { ...V1_POLICY, resultLimit: 64 },
        params.now,
      );
      if (resolution.ids.length === 0
        || (resolution.ids.length === 1 && resolution.ids[0] === predecessor.id)) continue;
      for (const currentId of resolution.ids) {
        if (selectedCurrent.has(currentId) && !predecessorByCurrent.has(currentId)) {
          predecessorByCurrent.set(currentId, predecessor);
        }
      }
    }

    let pairCount = 0;
    const candidates = v1.candidates.map((current) => {
      const historical = predecessorByCurrent.get(current.id);
      if (!historical) return current;
      pairCount += 1;
      return renderDualStateTransition(historical, current);
    });
    return { candidates, pairCount, fallback: false };
  } catch {
    return { candidates: v1.candidates, pairCount: 0, fallback: true };
  }
}

export function dualStateArms(prepared: PreparedCase): {
  intent: DualStateIntent;
  v1: RetrievedUnit[];
  dualAll: DualStateCandidateResult;
  dualQueryAware: DualStateCandidateResult;
} {
  const intent = classifyDualStateIntent(prepared.question.query);
  const v1 = materializeV1(prepared).candidates;
  const dualAll = dualStateCandidates({ prepared });
  return {
    intent,
    v1,
    dualAll,
    dualQueryAware: shouldReturnDualState(intent)
      ? dualAll
      : { candidates: v1, pairCount: 0, fallback: false },
  };
}
