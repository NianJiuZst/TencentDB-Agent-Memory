import type { RecallCandidate, RecallProfile } from "./types.js";

const RRF_K = 60;

function lexicalTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length > 1),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/**
 * Relevance remains primary. Recency can change a rank score by at most 10%,
 * and diversity only breaks near-duplicate choices inside the candidate pool.
 */
export function rerankCandidates(candidates: RecallCandidate[], profile: RecallProfile): RecallCandidate[] {
  if (profile.recencyWeight === 0 && profile.diversityWeight === 0) return [...candidates];
  if (candidates.length < 2) return [...candidates];

  const timestamps = candidates.map((candidate) => candidate.timestampMs).filter((value): value is number => Number.isFinite(value));
  const minTs = timestamps.length ? Math.min(...timestamps) : 0;
  const maxTs = timestamps.length ? Math.max(...timestamps) : 0;
  const span = Math.max(1, maxTs - minTs);
  const tokens = candidates.map((candidate) => lexicalTokens(candidate.content));
  const hasPositiveScores = candidates.some((candidate) => Number.isFinite(candidate.score) && candidate.score > 0);
  const remaining = candidates.map((candidate, rank) => {
    const relevance = hasPositiveScores
      ? Math.max(Number.isFinite(candidate.score) ? candidate.score : 0, Number.EPSILON)
      : 1 / (RRF_K + rank + 1);
    const recency = candidate.timestampMs === undefined ? 0.5 : (candidate.timestampMs - minTs) / span;
    const multiplier = 1 + profile.recencyWeight * (2 * recency - 1);
    return { candidate, rank, relevance: relevance * multiplier };
  });

  const selected: typeof remaining = [];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const entry = remaining[i];
      const maxSimilarity = selected.reduce(
        (max, chosen) => Math.max(max, jaccard(tokens[entry.rank], tokens[chosen.rank])),
        0,
      );
      const score = entry.relevance * (1 - profile.diversityWeight * maxSimilarity);
      if (score > bestScore) {
        bestIndex = i;
        bestScore = score;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected.map(({ candidate }) => candidate);
}

export function defaultTokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function packCandidates(
  candidates: RecallCandidate[],
  profile: RecallProfile,
  estimateTokens: (text: string) => number = defaultTokenEstimate,
  baselineCandidates: RecallCandidate[] = [],
): { candidates: RecallCandidate[]; tokens: number; budget: number } {
  const baselineTokens = baselineCandidates.reduce(
    (sum, candidate) => sum + (candidate.tokenCount ?? estimateTokens(candidate.content)),
    0,
  );
  const ratioBudget = profile.baselineTokenRatio === undefined || baselineTokens <= 0
    ? profile.tokenBudget
    : Math.max(1, Math.floor(baselineTokens * profile.baselineTokenRatio));
  const effectiveBudget = Math.min(profile.tokenBudget, ratioBudget);
  const packed: RecallCandidate[] = [];
  let tokens = 0;
  for (const candidate of candidates) {
    if (packed.length >= profile.resultLimit) break;
    const candidateTokens = candidate.tokenCount ?? estimateTokens(candidate.content);
    if (!Number.isFinite(candidateTokens) || candidateTokens <= 0) continue;
    if (tokens + candidateTokens > effectiveBudget) continue;
    packed.push(candidate);
    tokens += candidateTokens;
  }
  return { candidates: packed, tokens, budget: effectiveBudget };
}
