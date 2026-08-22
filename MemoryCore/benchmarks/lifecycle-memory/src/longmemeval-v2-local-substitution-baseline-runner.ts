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
  LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL,
  LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT,
  localSubstitutionQuestionIdsForPhase,
} from "./longmemeval-v2-local-substitution-protocol.js";
import { scoreProcedureDirectSupport } from "./longmemeval-v2-procedure.js";
import {
  aggregateProcedureCases,
  mean,
  type ProcedureAggregateMetrics,
} from "./longmemeval-v2-procedure-baseline-runner.js";
import {
  buildLongMemEvalV2ProcedureQuestionSplit,
  longMemEvalV2ProcedureEvaluatorFamily,
  type LongMemEvalV2ProcedureEvaluatorFamily,
} from "./longmemeval-v2-procedure-split.js";

export interface LocalSubstitutionTestReadAuthorization {
  admissionVersion: "lifecycle-longmemeval-v2-local-substitution-admission-v1.0";
  sourceProtocolVersion: string;
  status: "consumed_audit_passed";
  decision: "authorize_locked_test_read";
  candidatePolicyId: string;
  validatorCommit: string;
  independentValidationSha256: string;
  testStateAtAdmission: "unread";
}

export interface LongMemEvalV2LocalSubstitutionBaselineCase {
  protocolVersion: string;
  mode: "base";
  phase: "test";
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

export interface LongMemEvalV2LocalSubstitutionBaselineSummary {
  protocolVersion: string;
  mode: "base";
  phase: "test";
  status: "completed";
  authorizationSha256: string;
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

function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function assertFrozenSplit(questions: LongTaskQuestion[]): void {
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
  const generated = buildLongMemEvalV2ProcedureQuestionSplit({
    questions,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    questionsSha256: protocol.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT.seed,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_SPLIT)) {
    throw new Error("D10 generated procedure split differs from the frozen split");
  }
}

export function assertLocalSubstitutionTestReadAuthorized(
  authorization: LocalSubstitutionTestReadAuthorization | undefined,
): void {
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
  if (!authorization
    || authorization.admissionVersion !== "lifecycle-longmemeval-v2-local-substitution-admission-v1.0"
    || authorization.sourceProtocolVersion !== protocol.protocolVersion
    || authorization.status !== "consumed_audit_passed"
    || authorization.decision !== "authorize_locked_test_read"
    || authorization.candidatePolicyId !== protocol.candidate.policyId
    || !/^[0-9a-f]{7,40}$/iu.test(authorization.validatorCommit)
    || !/^[0-9a-f]{64}$/iu.test(authorization.independentValidationSha256)
    || authorization.testStateAtAdmission !== "unread") {
    throw new Error("D10 test read requires a committed consumed-audit-passed authorization artifact");
  }
}

export async function runLongMemEvalV2LocalSubstitutionTestBaseline(params: {
  dataRoot: string;
  testReadAuthorization: LocalSubstitutionTestReadAuthorization;
  authorizationSha256: string;
}): Promise<{
  cases: LongMemEvalV2LocalSubstitutionBaselineCase[];
  summary: LongMemEvalV2LocalSubstitutionBaselineSummary;
}> {
  assertLocalSubstitutionTestReadAuthorized(params.testReadAuthorization);
  if (!/^[0-9a-f]{64}$/iu.test(params.authorizationSha256)) {
    throw new Error("invalid D10 authorization SHA-256");
  }
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
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
  const selectedQuestions = localSubstitutionQuestionIdsForPhase("test").map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing D10 test question ${id}`);
    return question;
  });
  const trajectoryIds = [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))];
  const trajectories = await adapter.loadTrajectories(trajectoryIds);
  const byDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = byDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    byDomain.set(trajectory.domain, values);
  }
  const backends = new Map<string, MemoryCoreGroupBackend>();
  const index: LongMemEvalV2LocalSubstitutionBaselineSummary["index"] = {};
  try {
    for (const [domain, domainTrajectories] of [...byDomain.entries()].sort()) {
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
    const cases: LongMemEvalV2LocalSubstitutionBaselineCase[] = [];
    for (const question of selectedQuestions) {
      const backend = backends.get(question.domain);
      if (!backend) throw new Error(`no D10 test baseline backend for ${question.domain}`);
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
        phase: "test",
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
    const domainSummary = Object.fromEntries([...new Set(cases.map((item) => item.domain))].sort()
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
        phase: "test",
        status: "completed",
        authorizationSha256: params.authorizationSha256,
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
        byDomain: domainSummary,
        index,
        casesSha256: createHash("sha256").update(casesText).digest("hex"),
      },
    };
  } finally {
    for (const backend of backends.values()) backend.close();
  }
}
