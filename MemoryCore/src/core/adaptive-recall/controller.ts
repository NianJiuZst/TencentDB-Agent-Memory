import { performance } from "node:perf_hooks";
import { extractQueryFeatures } from "./features.js";
import { selectRecallProfile, validateAdaptiveRecallPolicy } from "./policy.js";
import { packCandidates, rerankCandidates } from "./rerank.js";
import type {
  AdaptiveRecallLogger,
  AdaptiveRecallPolicy,
  AdaptiveRecallResult,
  RecallCandidate,
  RecallDecisionLog,
  RecallProfile,
  RouterNode,
} from "./types.js";

export interface ExecuteAdaptiveRecallParams {
  enabled: boolean;
  query: string;
  documentCount?: number;
  timeoutMs: number;
  baselineProfile: RecallProfile;
  /** Exact pre-existing path, used when disabled and for every fallback. */
  baselineSearch: () => Promise<RecallCandidate[]>;
  /** Optional cheap Top-k base read used to derive confidence features. */
  scoutSearch?: () => Promise<RecallCandidate[]>;
  /** Existing retriever with a bounded candidate limit selected by policy. */
  candidateSearch: (candidateLimit: number) => Promise<RecallCandidate[]>;
  policy?: unknown;
  /** Optional read-only loader used by production. It is never called while disabled. */
  policyLoader?: () => Promise<unknown>;
  estimateTokens?: (text: string) => number;
  logger?: AdaptiveRecallLogger;
  onDecision?: (decision: RecallDecisionLog) => void;
}

const TAG = "[memory-tdai][adaptive-recall]";

const SCOUT_FEATURES = new Set([
  "scoutResultCount",
  "topScoreGap",
  "scoreDecay5",
  "uniqueSourceRatio5",
  "meanCandidateTokens5",
]);

function routerNeedsScout(node: RouterNode): boolean {
  if ("profile" in node) return false;
  return SCOUT_FEATURES.has(node.feature)
    || routerNeedsScout(node.left)
    || routerNeedsScout(node.right);
}

function profilesEquivalent(left: RecallProfile, right: RecallProfile): boolean {
  return left.name === right.name
    && left.candidateLimit === right.candidateLimit
    && left.resultLimit === right.resultLimit
    && left.tokenBudget === right.tokenBudget
    && left.baselineTokenRatio === right.baselineTokenRatio
    && left.recencyWeight === right.recencyWeight
    && left.diversityWeight === right.diversityWeight;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("adaptive timeout must be positive");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`adaptive recall timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tokenTotal(candidates: RecallCandidate[], estimateTokens?: (text: string) => number): number {
  return candidates.reduce((sum, candidate) => sum + (candidate.tokenCount ?? estimateTokens?.(candidate.content) ?? 0), 0);
}

async function executeBase(
  params: ExecuteAdaptiveRecallParams,
  startedAt: number,
  fallbackReason?: string,
  policyRevision?: string,
): Promise<AdaptiveRecallResult> {
  const candidates = await params.baselineSearch();
  const decision: RecallDecisionLog = {
    mode: "base",
    policyRevision,
    selectedProfile: params.baselineProfile.name,
    candidateLimit: params.baselineProfile.candidateLimit,
    resultLimit: params.baselineProfile.resultLimit,
    tokenBudget: params.baselineProfile.tokenBudget,
    returnedItems: candidates.length,
    returnedTokens: tokenTotal(candidates, params.estimateTokens),
    fallback: fallbackReason !== undefined,
    fallbackReason,
    latencyMs: performance.now() - startedAt,
  };
  params.onDecision?.(decision);
  return { candidates, decision };
}

/** Execute an adaptive policy with exact-baseline disable and failure paths. */
export async function executeAdaptiveRecall(params: ExecuteAdaptiveRecallParams): Promise<AdaptiveRecallResult> {
  const startedAt = performance.now();
  if (!params.enabled) return executeBase(params, startedAt);

  let policy: AdaptiveRecallPolicy;
  try {
    const untrustedPolicy = params.policyLoader
      ? await withTimeout(params.policyLoader(), params.timeoutMs)
      : params.policy;
    policy = validateAdaptiveRecallPolicy(untrustedPolicy);
  } catch (error) {
    const reason = `policy-load-or-validation-failure: ${error instanceof Error ? error.message : String(error)}`;
    params.logger?.warn?.(`${TAG} ${reason}; falling back to base`);
    return executeBase(params, startedAt, reason);
  }

  let scoutCandidates: RecallCandidate[] = [];
  if (routerNeedsScout(policy.router)) {
    try {
      scoutCandidates = await withTimeout((params.scoutSearch ?? params.baselineSearch)(), params.timeoutMs);
    } catch (error) {
      const reason = `scout-failure: ${error instanceof Error ? error.message : String(error)}`;
      params.logger?.warn?.(`${TAG} ${reason}; falling back to base`);
      return executeBase(params, startedAt, reason, policy.revision);
    }
  }

  const profile = selectRecallProfile(
    policy,
    extractQueryFeatures(params.query, params.documentCount, scoutCandidates),
  );
  if (profilesEquivalent(profile, params.baselineProfile)) {
    params.logger?.debug?.(`${TAG} policy selected exact base profile`);
    const candidates = scoutCandidates.length > 0
      ? scoutCandidates
      : await params.baselineSearch();
    const decision: RecallDecisionLog = {
      mode: "base",
      policyRevision: policy.revision,
      selectedProfile: profile.name,
      candidateLimit: profile.candidateLimit,
      resultLimit: profile.resultLimit,
      tokenBudget: profile.tokenBudget,
      returnedItems: candidates.length,
      returnedTokens: tokenTotal(candidates, params.estimateTokens),
      fallback: false,
      latencyMs: performance.now() - startedAt,
    };
    params.onDecision?.(decision);
    return { candidates, decision };
  }

  try {
    const candidates = profile.candidateLimit <= scoutCandidates.length
      ? scoutCandidates.slice(0, profile.candidateLimit)
      : await withTimeout(params.candidateSearch(profile.candidateLimit), params.timeoutMs);
    const reranked = rerankCandidates(candidates.slice(0, profile.candidateLimit), profile);
    const packed = packCandidates(
      reranked,
      profile,
      params.estimateTokens,
      candidates.slice(0, params.baselineProfile.resultLimit),
    );
    const decision: RecallDecisionLog = {
      mode: "adaptive",
      policyRevision: policy.revision,
      selectedProfile: profile.name,
      candidateLimit: profile.candidateLimit,
      resultLimit: profile.resultLimit,
      tokenBudget: packed.budget,
      returnedItems: packed.candidates.length,
      returnedTokens: packed.tokens,
      fallback: false,
      latencyMs: performance.now() - startedAt,
    };
    params.onDecision?.(decision);
    return { candidates: packed.candidates, decision };
  } catch (error) {
    const reason = `adaptive-failure: ${error instanceof Error ? error.message : String(error)}`;
    params.logger?.warn?.(`${TAG} ${reason}; falling back to base`);
    return executeBase(params, startedAt, reason);
  }
}
