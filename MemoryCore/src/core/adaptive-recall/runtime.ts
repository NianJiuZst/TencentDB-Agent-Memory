import { getEncoding } from "js-tiktoken";
import { executeAdaptiveRecall } from "./controller.js";
import { loadAdaptiveRecallPolicy } from "./policy-store.js";
import { validateAdaptiveRecallPolicy } from "./policy.js";
import type {
  AdaptiveRecallLogger,
  AdaptiveRecallPolicy,
  RecallCandidate,
  RecallDecisionLog,
  RecallProfile,
} from "./types.js";

const TAG = "[memory-tdai][adaptive-recall]";

export interface LineSearchResult<TTiming> {
  lines: string[];
  scores?: number[];
  timing: TTiming;
}

export interface ExecuteAdaptiveLineRecallParams<TTiming> {
  enabled: boolean;
  query: string;
  baselineMaxResults: number;
  timeoutMs: number;
  policyPath?: string;
  search: (maxResults: number) => Promise<LineSearchResult<TTiming>>;
  logger?: AdaptiveRecallLogger;
  /** Test seam; production reads the versioned policy from policyPath. */
  policyLoader?: () => Promise<unknown>;
}

export interface AdaptiveLineRecallResult<TTiming> {
  searchResult: LineSearchResult<TTiming>;
  decision: RecallDecisionLog;
}

let encoding: ReturnType<typeof getEncoding> | undefined;

function countTokens(text: string): number {
  encoding ??= getEncoding("cl100k_base");
  return encoding.encode(text).length;
}

function asCandidates(result: LineSearchResult<unknown>): RecallCandidate[] {
  return result.lines.map((content, index) => ({
    id: `base-rank-${index}`,
    content,
    score: result.scores?.[index] ?? 0,
    tokenCount: countTokens(content),
  }));
}

function baselineProfile(maxResults: number): RecallProfile {
  const bounded = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 5;
  return {
    name: "base",
    candidateLimit: bounded,
    resultLimit: bounded,
    tokenBudget: 4096,
    recencyWeight: 0,
    diversityWeight: 0,
  };
}

function assertBaselineCompatibility(policy: AdaptiveRecallPolicy, baseline: RecallProfile): AdaptiveRecallPolicy {
  const trainedBaseline = policy.profiles.find((profile) => profile.name === baseline.name);
  if (!trainedBaseline) throw new Error("policy does not declare the base profile");
  if (
    trainedBaseline.candidateLimit !== baseline.candidateLimit
    || trainedBaseline.resultLimit !== baseline.resultLimit
    || trainedBaseline.tokenBudget !== baseline.tokenBudget
    || trainedBaseline.baselineTokenRatio !== baseline.baselineTokenRatio
    || trainedBaseline.recencyWeight !== baseline.recencyWeight
    || trainedBaseline.diversityWeight !== baseline.diversityWeight
  ) {
    throw new Error("runtime base profile differs from the policy evaluation baseline");
  }
  return policy;
}

/**
 * Production sidepath over the existing search callback. Disabled and every
 * failure path execute the callback once with the original maxResults value.
 */
export async function executeAdaptiveLineRecall<TTiming>(
  params: ExecuteAdaptiveLineRecallParams<TTiming>,
): Promise<AdaptiveLineRecallResult<TTiming>> {
  const baseline = baselineProfile(params.baselineMaxResults);
  let selectedSearchResult: LineSearchResult<TTiming> | undefined;
  let latestSearchRequest = 0;

  const runSearch = async (maxResults: number): Promise<RecallCandidate[]> => {
    const requestId = ++latestSearchRequest;
    const result = await params.search(maxResults);
    // A timed-out retriever may still resolve because the base interface has
    // no abort signal. Never let that stale completion replace fallback data.
    if (requestId === latestSearchRequest) selectedSearchResult = result;
    return asCandidates(result);
  };

  const policyLoader = async () => {
    const untrusted = params.policyLoader
      ? await params.policyLoader()
      : params.policyPath
        ? await loadAdaptiveRecallPolicy(params.policyPath)
        : (() => { throw new Error("adaptive recall policyPath is required"); })();
    return assertBaselineCompatibility(validatePolicy(untrusted), baseline);
  };

  const adaptive = await executeAdaptiveRecall({
    enabled: params.enabled,
    query: params.query,
    timeoutMs: params.timeoutMs,
    baselineProfile: baseline,
    baselineSearch: () => runSearch(baseline.candidateLimit),
    candidateSearch: runSearch,
    policyLoader,
    estimateTokens: countTokens,
    logger: params.logger,
    onDecision: (decision) => {
      params.logger?.debug?.(`${TAG} decision=${JSON.stringify(decision)}`);
    },
  });

  if (!selectedSearchResult) {
    throw new Error("adaptive recall completed without executing the base retriever");
  }

  return {
    searchResult: {
      ...selectedSearchResult,
      lines: adaptive.candidates.map((candidate) => candidate.content),
      scores: adaptive.candidates.map((candidate) => candidate.score),
    },
    decision: adaptive.decision,
  };
}

function validatePolicy(untrusted: unknown): AdaptiveRecallPolicy {
  // loadAdaptiveRecallPolicy already validates production files; validating
  // again keeps injected loaders and future stores under the same contract.
  return validateAdaptiveRecallPolicy(untrusted);
}
