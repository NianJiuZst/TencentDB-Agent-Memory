import { defaultTokenEstimate } from "./rerank.js";
import type { QueryFeatures, RecallCandidate } from "./types.js";

const TEMPORAL_CUES = new Set([
  "after", "before", "during", "earlier", "latest", "later", "newest", "oldest",
  "previous", "recent", "since", "then", "time", "today", "week", "when", "year",
  "之前", "之后", "最近", "最新", "当时", "何时", "时间", "今天", "上次",
]);

const UPDATE_CUES = new Set([
  "became", "change", "changed", "currently", "instead", "latest", "new", "now", "replaced",
  "switched", "updated", "use", "改成", "更换", "更新", "现在", "替代", "切换",
]);

const MULTI_HOP_CUES = new Set([
  "and", "between", "both", "compare", "difference", "from", "how many", "since",
  "together", "以及", "之间", "两个", "分别", "多少", "比较",
]);

function normalizedTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

function countCues(query: string, tokens: string[], cues: Set<string>): number {
  let count = 0;
  const normalized = query.toLowerCase();
  for (const cue of cues) {
    if (cue.includes(" ")) {
      if (normalized.includes(cue)) count += 1;
    } else if (tokens.includes(cue) || normalized.includes(cue)) {
      count += 1;
    }
  }
  return count;
}

/** Runtime-only features: no benchmark category or gold label is accepted. */
export function extractQueryFeatures(
  query: string,
  documentCount = 0,
  scoutCandidates: RecallCandidate[] = [],
): QueryFeatures {
  const tokens = normalizedTokens(query);
  const scout = scoutCandidates.slice(0, 5);
  const topScore = scout[0]?.score ?? 0;
  const secondScore = scout[1]?.score ?? topScore;
  const lastScore = scout.at(-1)?.score ?? topScore;
  const safeTopScore = Math.abs(topScore) > Number.EPSILON ? Math.abs(topScore) : 0;
  const uniqueSources = new Set(scout.map((candidate) => candidate.sourceId).filter(Boolean)).size;
  const meanCandidateTokens = scout.length
    ? scout.reduce((sum, candidate) => sum + (candidate.tokenCount ?? defaultTokenEstimate(candidate.content)), 0) / scout.length
    : 0;
  const entityLikeTokenCount = query
    .split(/\s+/u)
    .filter((token) => /^[A-Z][\p{L}\p{N}_-]+$/u.test(token)).length;

  return {
    queryChars: query.length,
    queryTokens: tokens.length,
    temporalCueCount: countCues(query, tokens, TEMPORAL_CUES),
    updateCueCount: countCues(query, tokens, UPDATE_CUES),
    multiHopCueCount: countCues(query, tokens, MULTI_HOP_CUES),
    digitCount: (query.match(/\d/g) ?? []).length,
    entityLikeTokenCount,
    documentCount: Math.max(0, Math.floor(documentCount)),
    scoutResultCount: scout.length,
    topScoreGap: safeTopScore ? Math.max(0, (topScore - secondScore) / safeTopScore) : 0,
    scoreDecay5: safeTopScore ? Math.max(0, (topScore - lastScore) / safeTopScore) : 0,
    uniqueSourceRatio5: scout.length ? uniqueSources / scout.length : 0,
    meanCandidateTokens5: meanCandidateTokens,
  };
}
