import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import {
  buildRawStateUnits,
  packLongTaskContext,
  sanitizeLongTaskQuery,
  scoreDirectAnswerSupport,
} from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import { buildLongMemEvalV2QuestionSplit } from "./longmemeval-v2-split.js";
import {
  LONGMEMEVAL_V2_QUESTION_SPLIT,
  LONGMEMEVAL_V2_TRANSITION_PROTOCOL,
  questionIdsForLongMemEvalV2Phase,
  type LongMemEvalV2Phase,
} from "./longmemeval-v2-transition-protocol.js";

export interface LongMemEvalV2BaselineCase {
  protocolVersion: string;
  mode: "base";
  phase: LongMemEvalV2Phase;
  questionId: string;
  domain: string;
  environment: string;
  evaluatorFamily: "phrase" | "multiple_choice";
  directProxy: boolean;
  query: string;
  candidateIds: string[];
  injectedIds: string[];
  injectedTokens: number;
  tokenViolation: boolean;
  queryLatencyMs: number;
  answerAtomCount: number | null;
  supportedAtomCount: number | null;
  answerAtomSupportRecall: number | null;
  anyAnswerAtomSupported: number | null;
  allAnswerAtomsSupported: number | null;
  fallback: false;
}

export interface LongMemEvalV2BaselineSummary {
  protocolVersion: string;
  mode: "base";
  phase: LongMemEvalV2Phase;
  status: "completed";
  dataset: {
    name: string;
    revision: string;
    tier: string;
    manifestSha256: string;
  };
  cases: number;
  directProxyCases: number;
  metrics: {
    answerAtomSupportRecall: number;
    anyAnswerAtomSupportedRate: number;
    allAnswerAtomsSupportedRate: number;
    meanInjectedTokens: number;
    meanInjectedItems: number;
    queryLatencyP50Ms: number;
    queryLatencyP95Ms: number;
    tokenViolations: number;
    fallbacks: number;
  };
  byDomain: Record<string, {
    cases: number;
    directProxyCases: number;
    answerAtomSupportRecall: number;
    allAnswerAtomsSupportedRate: number;
    meanInjectedTokens: number;
  }>;
  index: Record<string, {
    trajectories: number;
    states: number;
    units: number;
    truncatedStates: number;
    buildLatencyMs: number;
  }>;
  casesSha256: string;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * probability) - 1))];
}

function evaluatorFamily(question: LongTaskQuestion): "phrase" | "multiple_choice" {
  return question.evaluator.startsWith("mc_choice_match|") ? "multiple_choice" : "phrase";
}

function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function aggregateCases(cases: LongMemEvalV2BaselineCase[]): LongMemEvalV2BaselineSummary["metrics"] {
  const direct = cases.filter((item) => item.directProxy);
  return {
    answerAtomSupportRecall: mean(direct.map((item) => item.answerAtomSupportRecall!)),
    anyAnswerAtomSupportedRate: mean(direct.map((item) => item.anyAnswerAtomSupported!)),
    allAnswerAtomsSupportedRate: mean(direct.map((item) => item.allAnswerAtomsSupported!)),
    meanInjectedTokens: mean(cases.map((item) => item.injectedTokens)),
    meanInjectedItems: mean(cases.map((item) => item.injectedIds.length)),
    queryLatencyP50Ms: percentile(cases.map((item) => item.queryLatencyMs), 0.5),
    queryLatencyP95Ms: percentile(cases.map((item) => item.queryLatencyMs), 0.95),
    tokenViolations: cases.filter((item) => item.tokenViolation).length,
    fallbacks: cases.filter((item) => item.fallback).length,
  };
}

function assertFrozenSplit(questions: LongTaskQuestion[]): void {
  const generated = buildLongMemEvalV2QuestionSplit({
    questions,
    seed: LONGMEMEVAL_V2_QUESTION_SPLIT.seed,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_QUESTION_SPLIT)) {
    throw new Error("LongMemEval-V2 generated split differs from the frozen split");
  }
}

export async function runLongMemEvalV2Baseline(params: {
  dataRoot: string;
  phase: LongMemEvalV2Phase;
}): Promise<{ cases: LongMemEvalV2BaselineCase[]; summary: LongMemEvalV2BaselineSummary }> {
  const protocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    tier: protocol.dataset.tier,
    expected: {
      questionsSha256: protocol.dataset.questionsSha256,
      haystackSha256: protocol.dataset.haystackSha256,
      trajectoriesSha256: protocol.dataset.trajectoriesSha256,
      questions: protocol.dataset.questions,
      trajectoryRows: protocol.dataset.trajectoryRows,
      haystackSize: 100,
      selectedTrajectories: protocol.dataset.selectedTrajectories,
    },
  });
  const questions = await adapter.loadQuestions();
  assertFrozenSplit(questions);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const selectedQuestions = questionIdsForLongMemEvalV2Phase(params.phase).map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing LongMemEval-V2 frozen question ${id}`);
    return question;
  });
  const trajectoryIds = [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))];
  const trajectories = await adapter.loadTrajectories(trajectoryIds);
  const trajectoriesByDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = trajectoriesByDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    trajectoriesByDomain.set(trajectory.domain, values);
  }

  const backends = new Map<string, MemoryCoreGroupBackend>();
  const index: LongMemEvalV2BaselineSummary["index"] = {};
  try {
    for (const [domain, domainTrajectories] of [...trajectoriesByDomain.entries()].sort()) {
      const startedAt = performance.now();
      const materialized = buildRawStateUnits({
        trajectories: domainTrajectories,
        config: {
          maxCharacters: protocol.baseline.rawChunkMaxCharacters,
          overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
          maxChunksPerState: protocol.baseline.maxRawChunksPerState,
        },
      });
      const backend = new MemoryCoreGroupBackend(materialized.units);
      backends.set(domain, backend);
      index[domain] = {
        trajectories: domainTrajectories.length,
        states: domainTrajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0),
        units: materialized.units.length,
        truncatedStates: materialized.truncatedStates,
        buildLatencyMs: performance.now() - startedAt,
      };
    }
    const cases: LongMemEvalV2BaselineCase[] = [];
    for (const question of selectedQuestions) {
      const backend = backends.get(question.domain);
      if (!backend) throw new Error(`no LongMemEval-V2 baseline backend for ${question.domain}`);
      const query = sanitizeLongTaskQuery(question.prompt);
      const search = await backend.search(query, protocol.baseline.candidateLimit);
      const packed = packLongTaskContext({
        candidates: search.candidates,
        tokenBudget: protocol.baseline.injectionTokenBudget,
        resultLimit: protocol.baseline.resultLimit,
      });
      const support = scoreDirectAnswerSupport(question, packed.items);
      cases.push({
        protocolVersion: protocol.protocolVersion,
        mode: "base",
        phase: params.phase,
        questionId: question.id,
        domain: question.domain,
        environment: question.environment,
        evaluatorFamily: evaluatorFamily(question),
        directProxy: support !== null,
        query,
        candidateIds: search.candidates.map((item) => item.id),
        injectedIds: packed.items.map((item) => item.id),
        injectedTokens: packed.injectedTokens,
        tokenViolation: packed.tokenViolation,
        queryLatencyMs: search.latencyMs,
        answerAtomCount: support?.answerAtoms.length ?? null,
        supportedAtomCount: support?.supportedAtomCount ?? null,
        answerAtomSupportRecall: support?.answerAtomSupportRecall ?? null,
        anyAnswerAtomSupported: support?.anyAnswerAtomSupported ?? null,
        allAnswerAtomsSupported: support?.allAnswerAtomsSupported ?? null,
        fallback: false,
      });
    }
    cases.sort((left, right) => left.questionId.localeCompare(right.questionId));
    const casesText = cases.map(canonicalJsonLine).join("");
    const byDomain = Object.fromEntries([...new Set(cases.map((item) => item.domain))].sort().map((domain) => {
      const domainCases = cases.filter((item) => item.domain === domain);
      const direct = domainCases.filter((item) => item.directProxy);
      return [domain, {
        cases: domainCases.length,
        directProxyCases: direct.length,
        answerAtomSupportRecall: mean(direct.map((item) => item.answerAtomSupportRecall!)),
        allAnswerAtomsSupportedRate: mean(direct.map((item) => item.allAnswerAtomsSupported!)),
        meanInjectedTokens: mean(domainCases.map((item) => item.injectedTokens)),
      }];
    }));
    return {
      cases,
      summary: {
        protocolVersion: protocol.protocolVersion,
        mode: "base",
        phase: params.phase,
        status: "completed",
        dataset: {
          name: adapter.name,
          revision: adapter.revision,
          tier: adapter.tier,
          manifestSha256: protocol.dataset.manifestSha256,
        },
        cases: cases.length,
        directProxyCases: cases.filter((item) => item.directProxy).length,
        metrics: aggregateCases(cases),
        byDomain,
        index,
        casesSha256: createHash("sha256").update(casesText).digest("hex"),
      },
    };
  } finally {
    for (const backend of backends.values()) backend.close();
  }
}
