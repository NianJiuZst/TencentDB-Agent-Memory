import type {
  AggregateMetrics,
  BootstrapInterval,
  CaseMetrics,
  CaseResult,
  EvidenceAtom,
  LifecycleEvalQuestion,
  RetrievedUnit,
} from "./types.js";

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1))];
}

export function scoreRetrieved(question: LifecycleEvalQuestion, candidates: RetrievedUnit[]): CaseMetrics {
  const normalize = (value: string) => value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const normalizedCandidates = candidates.map((candidate) => ({
    candidate,
    content: normalize(candidate.content),
  }));
  const matches = (atom: EvidenceAtom) => {
    const expected = normalize(atom.value);
    if (!expected) return false;
    const sources = new Set(atom.sourceSessionIds);
    return normalizedCandidates.some(({ candidate, content }) =>
      sources.has(candidate.sessionId) && content.includes(expected)
    );
  };
  const currentMatches = question.currentAtoms.filter(matches).length;
  const obsoleteMatches = question.obsoleteAtoms.filter(matches).length;
  const currentSessionRecall = question.currentAtoms.length
    ? currentMatches / question.currentAtoms.length
    : 1;
  const forgettingAbsence = question.obsoleteAtoms.length
    ? 1 - obsoleteMatches / question.obsoleteAtoms.length
    : 1;
  const officialDenominator = question.memoryPresenceQuestions + question.forgettingAbsenceQuestions;
  const lambda = officialDenominator > 0 ? question.forgettingAbsenceQuestions / officialDenominator : 0;

  return {
    currentSessionRecall,
    currentAny: question.currentAtoms.length === 0 || currentMatches > 0 ? 1 : 0,
    currentAll: question.currentAtoms.length === 0 || currentMatches === question.currentAtoms.length ? 1 : 0,
    forgettingAbsence,
    obsoleteAny: obsoleteMatches > 0 ? 1 : 0,
    obsoleteSessionRate: question.obsoleteAtoms.length ? obsoleteMatches / question.obsoleteAtoms.length : 0,
    staleInjectionRate: currentMatches + obsoleteMatches > 0 ? obsoleteMatches / (currentMatches + obsoleteMatches) : 0,
    evidenceFamaProxy: Math.max(0, currentSessionRecall - lambda * (1 - forgettingAbsence)),
    injectedItems: candidates.length,
    injectedTokens: candidates.reduce((sum, candidate) => sum + candidate.tokenCount, 0),
  };
}

export function aggregate(results: CaseResult[]): AggregateMetrics {
  return {
    cases: results.length,
    currentSessionRecall: mean(results.map((result) => result.metrics.currentSessionRecall)),
    currentAnyRate: mean(results.map((result) => result.metrics.currentAny)),
    currentAllRate: mean(results.map((result) => result.metrics.currentAll)),
    forgettingAbsence: mean(results.map((result) => result.metrics.forgettingAbsence)),
    obsoleteAnyRate: mean(results.map((result) => result.metrics.obsoleteAny)),
    obsoleteSessionRate: mean(results.map((result) => result.metrics.obsoleteSessionRate)),
    staleInjectionRate: mean(results.map((result) => result.metrics.staleInjectionRate)),
    evidenceFamaProxy: mean(results.map((result) => result.metrics.evidenceFamaProxy)),
    meanInjectedItems: mean(results.map((result) => result.metrics.injectedItems)),
    meanInjectedTokens: mean(results.map((result) => result.metrics.injectedTokens)),
    queryLatencyP50Ms: percentile(results.map((result) => result.queryLatencyMs), 0.5),
    queryLatencyP95Ms: percentile(results.map((result) => result.queryLatencyMs), 0.95),
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairedPersonaBootstrap(
  adaptive: CaseResult[],
  baseline: CaseResult[],
  metric: (adaptiveResult: CaseResult, baselineResult: CaseResult) => number,
  samples: number,
  seed: number,
): BootstrapInterval {
  const baselineById = new Map(baseline.map((result) => [result.caseId, result]));
  const byPersona = new Map<string, Array<readonly [CaseResult, CaseResult]>>();
  for (const result of adaptive) {
    const reference = baselineById.get(result.caseId);
    if (!reference) continue;
    const pairs = byPersona.get(result.persona) ?? [];
    pairs.push([result, reference] as const);
    byPersona.set(result.persona, pairs);
  }
  const clusters = [...byPersona.values()];
  const allPairs = clusters.flat();
  if (!clusters.length || !allPairs.length) return { mean: 0, lower: 0, upper: 0, clusters: 0 };
  const random = mulberry32(seed);
  const observed = mean(allPairs.map(([left, right]) => metric(left, right)));
  const draws: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      const selected = clusters[Math.floor(random() * clusters.length)];
      for (const [left, right] of selected) {
        total += metric(left, right);
        count += 1;
      }
    }
    draws.push(total / count);
  }
  draws.sort((left, right) => left - right);
  return {
    mean: observed,
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}
