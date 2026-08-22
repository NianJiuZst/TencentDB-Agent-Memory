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
import { scoreProcedureDirectSupport } from "./longmemeval-v2-procedure.js";
import {
  aggregateProcedureCases,
  mean,
  type ProcedureAggregateMetrics,
} from "./longmemeval-v2-procedure-baseline-runner.js";
import {
  buildLongMemEvalV2ResidualPatchSplit,
  type LongMemEvalV2ResidualPatchSplit,
} from "./longmemeval-v2-residual-patch-split.js";
import {
  longMemEvalV2StaticEvaluatorFamily,
  type LongMemEvalV2StaticEvaluatorFamily,
} from "./longmemeval-v2-static-split.js";
import {
  LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL,
  LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT,
  residualFeedbackPatchQuestionIdsForPhase,
  type LongMemEvalV2ResidualFeedbackPatchPhase,
} from "./longmemeval-v2-residual-feedback-patch-protocol.js";
import type { RetrievedUnit } from "./types.js";

export interface ResidualFeedbackPatchPhaseAdmission {
  admissionVersion: "lifecycle-longmemeval-v2-residual-feedback-patch-admission-v1.0";
  sourceProtocolVersion: string;
  completedPhase: "development" | "validation";
  status: "phase_passed";
  decision: "authorize_validation_read" | "authorize_test_read";
  candidatePolicyId: string;
  validatorCommit: string;
  independentValidationSha256: string;
  nextPhaseStateAtAdmission: "unread";
}

export interface LongMemEvalV2ResidualFeedbackPatchBaselineCase {
  protocolVersion: string;
  mode: "base";
  phase: LongMemEvalV2ResidualFeedbackPatchPhase;
  questionId: string;
  domain: string;
  environment: string;
  evaluatorFamily: LongMemEvalV2StaticEvaluatorFamily;
  directProxy: boolean;
  orderedQuestion: boolean;
  query: string;
  candidateIds: string[];
  injectedIds: string[];
  injectedItemSha256: string[];
  contextSha256: string;
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

export interface LongMemEvalV2ResidualFeedbackPatchBaselineSummary {
  protocolVersion: string;
  mode: "base";
  phase: LongMemEvalV2ResidualFeedbackPatchPhase;
  status: "completed";
  preScoreCommit: string;
  authorizationSha256: string | null;
  dataset: {
    name: string;
    revision: string;
    tier: string;
    manifestSha256: string;
  };
  splitCanonicalSha256: string;
  cases: number;
  directProxyCases: number;
  answerOnlyCases: number;
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
  laterPhaseState: "unread";
}

function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function itemSha256(item: Pick<RetrievedUnit, "id" | "content" | "tokenCount">): string {
  return createHash("sha256")
    .update(`${item.id}\0${item.tokenCount}\0${item.content}`)
    .digest("hex");
}

function contextSha256(
  items: readonly Pick<RetrievedUnit, "id" | "content" | "tokenCount">[],
): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(`${item.id}\0${item.tokenCount}\0${item.content}\n`);
  return hash.digest("hex");
}

function assertFrozenResidualSplit(questions: LongTaskQuestion[]): void {
  const protocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL;
  const generated = buildLongMemEvalV2ResidualPatchSplit({
    questions,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    questionsSha256: protocol.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.seed,
  });
  if (JSON.stringify(generated)
    !== JSON.stringify(LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT)) {
    throw new Error("D13 generated residual split differs from the frozen split");
  }
}

export function assertResidualFeedbackPatchPhaseReadAuthorized(params: {
  phase: LongMemEvalV2ResidualFeedbackPatchPhase;
  authorization?: ResidualFeedbackPatchPhaseAdmission;
}): void {
  if (params.phase === "development") {
    if (params.authorization) throw new Error("D13 development must not use an authorization");
    return;
  }
  const expectedCompleted = params.phase === "validation" ? "development" : "validation";
  const expectedDecision = params.phase === "validation"
    ? "authorize_validation_read" : "authorize_test_read";
  const authorization = params.authorization;
  const protocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL;
  if (!authorization
    || authorization.admissionVersion
      !== "lifecycle-longmemeval-v2-residual-feedback-patch-admission-v1.0"
    || authorization.sourceProtocolVersion !== protocol.protocolVersion
    || authorization.completedPhase !== expectedCompleted
    || authorization.status !== "phase_passed"
    || authorization.decision !== expectedDecision
    || authorization.candidatePolicyId !== protocol.candidate.policyId
    || !/^[0-9a-f]{7,40}$/iu.test(authorization.validatorCommit)
    || !/^[0-9a-f]{64}$/iu.test(authorization.independentValidationSha256)
    || authorization.nextPhaseStateAtAdmission !== "unread") {
    throw new Error(`D13 ${params.phase} read requires a committed ${expectedCompleted}-passed admission`);
  }
}

export async function runLongMemEvalV2ResidualFeedbackPatchBaseline(params: {
  dataRoot: string;
  phase: LongMemEvalV2ResidualFeedbackPatchPhase;
  preScoreCommit: string;
  authorization?: ResidualFeedbackPatchPhaseAdmission;
  authorizationSha256?: string;
}): Promise<{
  cases: LongMemEvalV2ResidualFeedbackPatchBaselineCase[];
  summary: LongMemEvalV2ResidualFeedbackPatchBaselineSummary;
}> {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.preScoreCommit)) {
    throw new Error("D13 baseline preScoreCommit must be a git SHA");
  }
  assertResidualFeedbackPatchPhaseReadAuthorized(params);
  if (params.phase !== "development"
    && (!params.authorizationSha256 || !/^[0-9a-f]{64}$/iu.test(params.authorizationSha256))) {
    throw new Error(`D13 ${params.phase} baseline requires the admission artifact SHA-256`);
  }
  const protocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL;
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
  assertFrozenResidualSplit(questions);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const selectedQuestions = residualFeedbackPatchQuestionIdsForPhase(params.phase).map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing D13 frozen question ${id}`);
    return question;
  });
  const trajectoryIds = [...new Set(selectedQuestions.flatMap((question) =>
    question.trajectoryIds))];
  const trajectories = await adapter.loadTrajectories(trajectoryIds);
  const trajectoriesByDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = trajectoriesByDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    trajectoriesByDomain.set(trajectory.domain, values);
  }
  const backends = new Map<string, MemoryCoreGroupBackend>();
  const index: LongMemEvalV2ResidualFeedbackPatchBaselineSummary["index"] = {};
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
        states: domainTrajectories.reduce((sum, trajectory) =>
          sum + trajectory.states.length, 0),
        units: materialized.units.length,
        truncatedStates: materialized.truncatedStates,
        buildLatencyMs: performance.now() - startedAt,
      };
    }
    const cases: LongMemEvalV2ResidualFeedbackPatchBaselineCase[] = [];
    for (const question of selectedQuestions) {
      const backend = backends.get(question.domain);
      if (!backend) throw new Error(`missing D13 Base backend ${question.domain}`);
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
        evaluatorFamily: longMemEvalV2StaticEvaluatorFamily(question),
        directProxy: support !== null,
        orderedQuestion: support?.orderedQuestion ?? false,
        query,
        candidateIds: search.candidates.map((item) => item.id),
        injectedIds: packed.items.map((item) => item.id),
        injectedItemSha256: packed.items.map(itemSha256),
        contextSha256: contextSha256(packed.items),
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
          orderedSequenceSupportedRate: mean(ordered.map((item) =>
            item.orderedSequenceSupported!)),
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
        preScoreCommit: params.preScoreCommit,
        authorizationSha256: params.authorizationSha256 ?? null,
        dataset: {
          name: adapter.name,
          revision: adapter.revision,
          tier: adapter.tier,
          manifestSha256: protocol.dataset.manifestSha256,
        },
        splitCanonicalSha256: LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_SPLIT.canonicalSha256,
        cases: cases.length,
        directProxyCases: cases.filter((item) => item.directProxy).length,
        answerOnlyCases: cases.filter((item) => !item.directProxy).length,
        orderedProxyCases: cases.filter((item) => item.orderedQuestion).length,
        metrics: aggregateProcedureCases(cases),
        byDomain,
        index,
        casesSha256: createHash("sha256").update(casesText).digest("hex"),
        laterPhaseState: "unread",
      },
    };
  } finally {
    for (const backend of backends.values()) backend.close();
  }
}
