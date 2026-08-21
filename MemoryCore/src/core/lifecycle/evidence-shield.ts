import { performance } from "node:perf_hooks";
import type { LifecycleEvent } from "./types.js";

interface RedactionValue {
  key: string;
  pattern: RegExp;
  value: string;
}

interface EvidenceAnnotation {
  confidence: number;
  eventId: string;
  obsoleteValues: RedactionValue[];
  sequence: number;
}

export interface LifecycleEvidenceShieldLimits {
  maxAnnotations: number;
  maxEvents: number;
}

export interface LifecycleEvidenceShieldPolicy {
  enabled: boolean;
  maxCandidates: number;
  maxRedactions: number;
  minConfidence: number;
  replacement: string;
  timeoutMs: number;
}

export interface LifecycleEvidenceShieldResolution {
  changedCandidates: number;
  contents: string[];
  redactions: number;
}

export interface LifecycleEvidenceShieldSource {
  shield(
    candidates: Array<{ id: string; content: string }>,
    policy: LifecycleEvidenceShieldPolicy,
    now?: () => number,
  ): LifecycleEvidenceShieldResolution;
}

export interface LifecycleEvidenceShieldDecision {
  mode: "base" | "shielded" | "fallback";
  inputCandidates: number;
  outputCandidates: number;
  changedCandidates: number;
  redactions: number;
  elapsedMs: number;
  fallbackReason?: string;
}

export interface LifecycleEvidenceShieldResult<T> {
  candidates: T[];
  decision: LifecycleEvidenceShieldDecision;
}

export const DEFAULT_EVIDENCE_SHIELD_LIMITS: LifecycleEvidenceShieldLimits = {
  maxEvents: 5_000,
  maxAnnotations: 50_000,
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valuePattern(value: string): RegExp | null {
  const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length || normalize(value).length < 2) return null;
  return new RegExp(tokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+"), "giu");
}

function validatePolicy(policy: LifecycleEvidenceShieldPolicy): void {
  if (policy.minConfidence < 0 || policy.minConfidence > 1) {
    throw new Error("evidence shield minConfidence must be in [0, 1]");
  }
  for (const [name, value] of [
    ["maxCandidates", policy.maxCandidates],
    ["maxRedactions", policy.maxRedactions],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`evidence shield ${name} must be a positive integer`);
    }
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new Error("evidence shield timeoutMs must be positive");
  }
  if (!policy.replacement.trim() || policy.replacement.length > 64) {
    throw new Error("evidence shield replacement must contain 1-64 characters");
  }
}

export class LifecycleEvidenceShield implements LifecycleEvidenceShieldSource {
  private readonly annotationsByUnitId = new Map<string, EvidenceAnnotation[]>();

  constructor(
    events: LifecycleEvent[],
    limits: LifecycleEvidenceShieldLimits = DEFAULT_EVIDENCE_SHIELD_LIMITS,
  ) {
    if (events.length > limits.maxEvents) {
      throw new Error(`evidence shield event capacity exceeded: ${events.length}`);
    }
    let annotations = 0;
    for (const event of events) {
      if (!event.id || !Number.isFinite(event.sequence)) {
        throw new Error("invalid evidence shield event");
      }
      if (event.confidence < 0 || event.confidence > 1) {
        throw new Error(`invalid confidence for ${event.id}`);
      }
      const obsoleteValues = [...new Map(event.obsoleteValues.flatMap((rawValue) => {
        const value = rawValue.trim();
        const key = normalize(value);
        const pattern = valuePattern(value);
        return key.length >= 2 && pattern ? [[key, { key, pattern, value }] as const] : [];
      })).values()];
      if (!obsoleteValues.length) continue;
      for (const unitId of new Set(event.successorUnitIds)) {
        if (!unitId) throw new Error(`evidence shield event ${event.id} has an empty successor`);
        const entries = this.annotationsByUnitId.get(unitId) ?? [];
        entries.push({
          confidence: event.confidence,
          eventId: event.id,
          obsoleteValues,
          sequence: event.sequence,
        });
        this.annotationsByUnitId.set(unitId, entries);
        annotations += 1;
        if (annotations > limits.maxAnnotations) {
          throw new Error(`evidence shield annotation capacity exceeded: ${annotations}`);
        }
      }
    }
  }

  shield(
    candidates: Array<{ id: string; content: string }>,
    policy: LifecycleEvidenceShieldPolicy,
    now: () => number = performance.now.bind(performance),
  ): LifecycleEvidenceShieldResolution {
    validatePolicy(policy);
    if (candidates.length > policy.maxCandidates) {
      throw new Error(`evidence shield candidate capacity exceeded: ${candidates.length}`);
    }
    const startedAt = now();
    let redactions = 0;
    let changedCandidates = 0;
    const checkBudget = () => {
      if (now() - startedAt > policy.timeoutMs) throw new Error("evidence shield timed out");
      if (redactions > policy.maxRedactions) {
        throw new Error(`evidence shield redaction capacity exceeded: ${redactions}`);
      }
    };
    const contents = candidates.map((candidate) => {
      checkBudget();
      const annotations = (this.annotationsByUnitId.get(candidate.id) ?? [])
        .filter((entry) => entry.confidence >= policy.minConfidence)
        .sort((left, right) => right.sequence - left.sequence || left.eventId.localeCompare(right.eventId));
      const values = [...new Map(annotations.flatMap((entry) => entry.obsoleteValues)
        .map((value) => [value.key, value] as const)).values()]
        .sort((left, right) => right.key.length - left.key.length);
      let content = candidate.content;
      for (const value of values) {
        value.pattern.lastIndex = 0;
        content = content.replace(value.pattern, () => {
          redactions += 1;
          checkBudget();
          return policy.replacement;
        });
      }
      if (content !== candidate.content) changedCandidates += 1;
      return content;
    });
    checkBudget();
    return { contents, changedCandidates, redactions };
  }
}

export function applyLifecycleEvidenceShield<T extends { id: string; content: string }>(params: {
  candidates: T[];
  policy: LifecycleEvidenceShieldPolicy;
  source?: LifecycleEvidenceShieldSource;
  now?: () => number;
}): LifecycleEvidenceShieldResult<T> {
  const startedAt = performance.now();
  const baseline = params.candidates.slice();
  if (!params.policy.enabled) {
    return {
      candidates: baseline,
      decision: {
        mode: "base",
        inputCandidates: baseline.length,
        outputCandidates: baseline.length,
        changedCandidates: 0,
        redactions: 0,
        elapsedMs: performance.now() - startedAt,
      },
    };
  }
  if (!params.source) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        inputCandidates: baseline.length,
        outputCandidates: baseline.length,
        changedCandidates: 0,
        redactions: 0,
        elapsedMs: performance.now() - startedAt,
        fallbackReason: "evidence shield unavailable",
      },
    };
  }
  try {
    const resolution = params.source.shield(baseline, params.policy, params.now);
    if (resolution.contents.length !== baseline.length) {
      throw new Error("evidence shield returned another candidate count");
    }
    const candidates = baseline.map((candidate, index) => ({
      ...candidate,
      content: resolution.contents[index],
    }));
    return {
      candidates,
      decision: {
        mode: "shielded",
        inputCandidates: baseline.length,
        outputCandidates: candidates.length,
        changedCandidates: resolution.changedCandidates,
        redactions: resolution.redactions,
        elapsedMs: performance.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      candidates: baseline,
      decision: {
        mode: "fallback",
        inputCandidates: baseline.length,
        outputCandidates: baseline.length,
        changedCandidates: 0,
        redactions: 0,
        elapsedMs: performance.now() - startedAt,
        fallbackReason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
