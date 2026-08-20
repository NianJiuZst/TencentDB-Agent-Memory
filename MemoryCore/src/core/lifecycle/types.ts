export type LifecycleEventKind = "update" | "delete";

export interface LifecycleUnit {
  id: string;
  content: string;
  sequence: number;
}

export interface LifecycleEvent {
  id: string;
  kind: LifecycleEventKind;
  sequence: number;
  confidence: number;
  obsoleteValues: string[];
  successorUnitIds: string[];
  source: string;
}

export interface LifecycleLimits {
  maxUnits: number;
  maxEvents: number;
  maxEdges: number;
}

export interface LifecyclePolicy {
  enabled: boolean;
  minConfidence: number;
  maxHops: number;
  maxExpansions: number;
  resultLimit: number;
  timeoutMs: number;
}

export interface LifecycleResolution {
  ids: string[];
  redirects: number;
  maxObservedHops: number;
  expansions: number;
}

export interface LifecycleDecisionLog {
  mode: "base" | "adaptive" | "fallback";
  policy: LifecyclePolicy;
  inputCandidates: number;
  outputCandidates: number;
  redirects: number;
  maxObservedHops: number;
  expansions: number;
  elapsedMs: number;
  fallbackReason?: string;
}

export interface LifecycleApplyResult<T> {
  candidates: T[];
  decision: LifecycleDecisionLog;
}

export interface LifecycleResolver {
  resolveIds(
    candidateIds: string[],
    policy: LifecyclePolicy,
    now?: () => number,
  ): LifecycleResolution;
}

export interface LifecyclePolicyFeedback {
  quality: number;
  meanCost: number;
  fallbackRate: number;
}

export interface LifecyclePolicyTrial {
  policy: LifecyclePolicy;
  feedback: LifecyclePolicyFeedback;
  utility: number;
}

export interface LifecycleOptimizerWeights {
  costPenalty: number;
  fallbackPenalty: number;
}
