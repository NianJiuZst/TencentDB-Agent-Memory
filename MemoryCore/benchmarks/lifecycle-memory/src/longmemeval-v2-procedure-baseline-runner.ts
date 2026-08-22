import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import {
  buildRawStateUnits,
  packLongTaskContext,
  sanitizeLongTaskQuery,
} from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  LONGMEMEVAL_V2_PROCEDURE_PROTOCOL,
  LONGMEMEVAL_V2_PROCEDURE_SPLIT,
  procedureQuestionIdsForPhase,
  type LongMemEvalV2ProcedurePhase,
} from "./longmemeval-v2-procedure-protocol.js";
import {
  scoreProcedureDirectSupport,
} from "./longmemeval-v2-procedure.js";
import {
  buildLongMemEvalV2ProcedureQuestionSplit,
  longMemEvalV2ProcedureEvaluatorFamily,
  type LongMemEvalV2ProcedureEvaluatorFamily,
} from "./longmemeval-v2-procedure-split.js";

export interface ProcedureTestReadAuthorization {
  admissionVersion: "lifecycle-longmemeval-v2-procedure-admission-v1.0";
  sourceProtocolVersion: string;
  protocolVersion: string;
  status: "validation_passed";
  decision: "authorize_locked_test_read";
  selectedPolicyId: string;
  validatorCommit: string;
  independentValidationSha256: string;
  testStateAtAdmission: "unread";
}

export interface LongMemEvalV2ProcedureBaselineCase {
  protocolVersion: string;
  mode: "base";
  phase: LongMemEvalV2ProcedurePhase;
  questionId: string;
  domain: string;
  environment: string;
  evaluatorFamily: LongMemEvalV2ProcedureEvaluatorFamily;
  directProxy: boolean;
  orderedQuestion: boolean;
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
  orderedSequenceSupported: number | null;
  fallback: false;
}

export interface ProcedureAggregateMetrics {
  answerAtomSupportRecall: number;
  anyAnswerAtomSupportedRate: number;
  allAnswerAtomsSupportedRate: number;
  orderedSequenceSupportedRate: number;
  meanInjectedTokens: number;
  meanInjectedItems: number;
  queryLatencyP50Ms: number;
  queryLatencyP95Ms: number;
  tokenViolations: number;
  fallbacks: number;
}

export interface LongMemEvalV2ProcedureBaselineSummary {
  protocolVersion: string;
  mode: "base";
  phase: LongMemEvalV2ProcedurePhase;
  status: "completed";
  dataset: {
    name: string;
    revision: string;
    tier: string;
    manifestSha256: string;
  };
  cases: number;
  directProxyCases: number;
  orderedProxyCases: number;
  metrics: ProcedureAggregateMetrics;
  byDomain: Record<string, {
    cases: number;
    directProxyCases: number;
    answerAtomSupportRecall: number;
    orderedSequenceSupportedRate: number;
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

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * probability) - 1))];
}

function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function aggregateProcedureCases(
  cases: readonly {
    directProxy: boolean;
    orderedQuestion: boolean;
    answerAtomSupportRecall: number | null;
    anyAnswerAtomSupported: number | null;
    allAnswerAtomsSupported: number | null;
    orderedSequenceSupported: number | null;
    injectedTokens: number;
    injectedIds: string[];
    queryLatencyMs: number;
    tokenViolation: boolean;
    fallback: boolean;
  }[],
): ProcedureAggregateMetrics {
  const direct = cases.filter((item) => item.directProxy);
  const ordered = direct.filter((item) => item.orderedQuestion);
  return {
    answerAtomSupportRecall: mean(direct.map((item) => item.answerAtomSupportRecall!)),
    anyAnswerAtomSupportedRate: mean(direct.map((item) => item.anyAnswerAtomSupported!)),
    allAnswerAtomsSupportedRate: mean(direct.map((item) => item.allAnswerAtomsSupported!)),
    orderedSequenceSupportedRate: mean(ordered.map((item) => item.orderedSequenceSupported!)),
    meanInjectedTokens: mean(cases.map((item) => item.injectedTokens)),
    meanInjectedItems: mean(cases.map((item) => item.injectedIds.length)),
    queryLatencyP50Ms: percentile(cases.map((item) => item.queryLatencyMs), 0.5),
    queryLatencyP95Ms: percentile(cases.map((item) => item.queryLatencyMs), 0.95),
    tokenViolations: cases.filter((item) => item.tokenViolation).length,
    fallbacks: cases.filter((item) => item.fallback).length,
  };
}

function assertFrozenProcedureSplit(questions: LongTaskQuestion[]): void {
  const generated = buildLongMemEvalV2ProcedureQuestionSplit({
    questions,
    revision: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.benchmarkRepositoryRevision,
    questionsSha256: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_PROCEDURE_SPLIT.seed,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_PROCEDURE_SPLIT)) {
    throw new Error("LongMemEval-V2 generated procedure split differs from the frozen split");
  }
}

function assertTestReadAuthorized(
  phase: LongMemEvalV2ProcedurePhase,
  authorization: ProcedureTestReadAuthorization | undefined,
): void {
  if (phase !== "test") return;
  if (!authorization
    || authorization.admissionVersion !== "lifecycle-longmemeval-v2-procedure-admission-v1.0"
    || authorization.sourceProtocolVersion !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion
    || authorization.protocolVersion !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion
    || authorization.status !== "validation_passed"
    || authorization.decision !== "authorize_locked_test_read"
    || !authorization.selectedPolicyId.trim()
    || !/^[0-9a-f]{7,40}$/i.test(authorization.validatorCommit)
    || !/^[0-9a-f]{64}$/i.test(authorization.independentValidationSha256)
    || authorization.testStateAtAdmission !== "unread") {
    throw new Error("D9 test read requires a committed validation-passed authorization artifact");
  }
}

export async function runLongMemEvalV2ProcedureBaseline(params: {
  dataRoot: string;
  phase: LongMemEvalV2ProcedurePhase;
  testReadAuthorization?: ProcedureTestReadAuthorization;
}): Promise<{
  cases: LongMemEvalV2ProcedureBaselineCase[];
  summary: LongMemEvalV2ProcedureBaselineSummary;
}> {
  assertTestReadAuthorized(params.phase, params.testReadAuthorization);
  const protocol = LONGMEMEVAL_V2_PROCEDURE_PROTOCOL;
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
  assertFrozenProcedureSplit(questions);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const selectedQuestions = procedureQuestionIdsForPhase(params.phase).map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing LongMemEval-V2 frozen procedure question ${id}`);
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
  const index: LongMemEvalV2ProcedureBaselineSummary["index"] = {};
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
      backends.set(domain, new MemoryCoreGroupBackend(materialized.units));
      index[domain] = {
        trajectories: domainTrajectories.length,
        states: domainTrajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0),
        units: materialized.units.length,
        truncatedStates: materialized.truncatedStates,
        buildLatencyMs: performance.now() - startedAt,
      };
    }
    const cases: LongMemEvalV2ProcedureBaselineCase[] = [];
    for (const question of selectedQuestions) {
      const backend = backends.get(question.domain);
      if (!backend) throw new Error(`no D9 baseline backend for ${question.domain}`);
      const query = sanitizeLongTaskQuery(question.prompt);
      const search = await backend.search(query, protocol.baseline.candidateLimit);
      const packed = packLongTaskContext({
        candidates: search.candidates,
        tokenBudget: protocol.baseline.injectionTokenBudget,
        resultLimit: protocol.baseline.resultLimit,
      });
      const support = scoreProcedureDirectSupport({ question, injected: packed.items });
      cases.push({
        protocolVersion: protocol.protocolVersion,
        mode: "base",
        phase: params.phase,
        questionId: question.id,
        domain: question.domain,
        environment: question.environment,
        evaluatorFamily: longMemEvalV2ProcedureEvaluatorFamily(question),
        directProxy: support !== null,
        orderedQuestion: support?.orderedQuestion ?? false,
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
        orderedSequenceSupported: support?.orderedSequenceSupported ?? null,
        fallback: false,
      });
    }
    cases.sort((left, right) => left.questionId.localeCompare(right.questionId));
    const casesText = cases.map(canonicalJsonLine).join("");
    const byDomain = Object.fromEntries([...new Set(cases.map((item) => item.domain))].sort()
      .map((domain) => {
        const domainCases = cases.filter((item) => item.domain === domain);
        const direct = domainCases.filter((item) => item.directProxy);
        const ordered = direct.filter((item) => item.orderedQuestion);
        return [domain, {
          cases: domainCases.length,
          directProxyCases: direct.length,
          answerAtomSupportRecall: mean(direct.map((item) => item.answerAtomSupportRecall!)),
          orderedSequenceSupportedRate: mean(ordered.map((item) => item.orderedSequenceSupported!)),
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
        orderedProxyCases: cases.filter((item) => item.orderedQuestion).length,
        metrics: aggregateProcedureCases(cases),
        byDomain,
        index,
        casesSha256: createHash("sha256").update(casesText).digest("hex"),
      },
    };
  } finally {
    for (const backend of backends.values()) backend.close();
  }
}
