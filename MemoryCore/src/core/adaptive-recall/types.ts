/**
 * Bounded, versioned policy types for adaptive recall.
 *
 * The adaptive layer is intentionally agnostic to FTS/vector internals. It
 * only chooses among reviewed profiles and post-processes candidates returned
 * by the existing MemoryCore search path.
 */

export type AdaptiveRecallMode = "base" | "adaptive";

export interface RecallCandidate {
  id: string;
  content: string;
  /** Base retriever score. The adaptive layer never replaces the retriever. */
  score: number;
  /** Provenance unit used by evaluators and diversity controls. */
  sourceId?: string;
  /** Event time used by bounded recency reranking. */
  timestampMs?: number;
  /** Exact token count when supplied by the caller. */
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface RecallProfile {
  name: string;
  /** Maximum number of candidates requested from the base retriever. */
  candidateLimit: number;
  /** Maximum number of items exposed to the injector. */
  resultLimit: number;
  /** Hard injection budget. */
  tokenBudget: number;
  /** Optional fraction of the base Top-k token load, capped by tokenBudget. */
  baselineTokenRatio?: number;
  /** Multiplicative relevance modulation in [0, 0.1]. */
  recencyWeight: number;
  /** Greedy near-duplicate penalty in [0, 0.25]. */
  diversityWeight: number;
}

export type QueryFeatureName =
  | "queryChars"
  | "queryTokens"
  | "temporalCueCount"
  | "updateCueCount"
  | "multiHopCueCount"
  | "digitCount"
  | "entityLikeTokenCount"
  | "documentCount"
  | "scoutResultCount"
  | "topScoreGap"
  | "scoreDecay5"
  | "uniqueSourceRatio5"
  | "meanCandidateTokens5";

export type QueryFeatures = Record<QueryFeatureName, number>;

export interface RouterLeaf {
  profile: string;
}

export interface RouterBranch {
  feature: QueryFeatureName;
  threshold: number;
  left: RouterNode;
  right: RouterNode;
}

export type RouterNode = RouterLeaf | RouterBranch;

export interface AdaptiveRecallPolicy {
  schemaVersion: 1;
  revision: string;
  createdAt: string;
  defaultProfile: string;
  profiles: RecallProfile[];
  router: RouterNode;
}

export interface AdaptivePolicyLimits {
  maxProfiles: number;
  maxCandidateLimit: number;
  maxResultLimit: number;
  maxTokenBudget: number;
  maxRouterDepth: number;
}

export interface RecallDecisionLog {
  mode: AdaptiveRecallMode;
  policyRevision?: string;
  selectedProfile: string;
  candidateLimit: number;
  resultLimit: number;
  /** Effective token budget after applying any base-relative cap. */
  tokenBudget: number;
  returnedItems: number;
  returnedTokens: number;
  fallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
}

export interface AdaptiveRecallResult {
  candidates: RecallCandidate[];
  decision: RecallDecisionLog;
}

export interface AdaptiveRecallLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}
