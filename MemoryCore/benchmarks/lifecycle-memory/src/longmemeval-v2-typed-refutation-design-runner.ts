import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type { LongMemEvalV2PremiseEvidenceBaselineCase } from "./longmemeval-v2-premise-evidence-baseline-runner.js";
import {
  extractLongMemEvalBoxedAnswer,
  longMemEvalAbstentionJudgeMessages,
  longMemEvalReaderMessages,
  parseLongMemEvalBinaryJudgment,
  type LongMemEvalAnswerEvaluation,
  type LongMemEvalBinaryJudgment,
} from "./longmemeval-v2-premise-evidence-answer-runner.js";
import type { PremiseEvidenceContextPolicy } from "./longmemeval-v2-premise-evidence-context.js";
import { LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL } from "./longmemeval-v2-premise-evidence-protocol.js";
import type {
  LongMemEvalV2PremiseEvidenceCase,
  LongMemEvalV2PremiseEvidenceSummary,
} from "./longmemeval-v2-premise-evidence-runner.js";
import {
  buildPremiseEvidenceIndex,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  type PremiseEvidenceConfig,
  type PremiseEvidenceInventoryKind,
} from "./longmemeval-v2-premise-evidence.js";
import {
  LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL,
  typedRefutationPolicyIds,
  type TypedRefutationPolicyId,
} from "./longmemeval-v2-typed-refutation-protocol.js";
import {
  selectTypedRefutationContext,
  type TypedRefutationContextPolicy,
  type TypedRefutationResult,
} from "./longmemeval-v2-typed-refutation.js";
import {
  callDirectJudge,
  isRetryableJudgeError,
  type DirectJudgeResponse,
  type DirectJudgeSpec,
} from "./judge-provider.js";
import type { RetrievedUnit } from "./types.js";

interface D14DevelopmentDecision {
  decisionVersion: string;
  status: string;
  decision: string;
}

interface TypedRefutationDesignContext {
  protocolVersion: string;
  policyId: TypedRefutationPolicyId;
  questionId: string;
  baseContextSha256: string;
  contextSha256: string;
  baseInjectedTokens: number;
  injectedTokens: number;
  typedCapsuleTokens: number;
  selectionLatencyMs: number;
  typedCapsule: string | null;
  injected: RetrievedUnit[];
  fallback: boolean;
  fallbackReason: string | null;
  basePrefixViolations: number;
  capsuleCertificateViolations: number;
  tokenViolation: boolean;
}

interface TypedRefutationDesignEvaluation {
  protocolVersion: string;
  policyId: TypedRefutationPolicyId;
  questionId: string;
  readerId: string;
  contextSha256: string;
  injectedTokens: number;
  answer: string;
  parsedFinalAnswer: string;
  isUnknown: boolean;
  reader: DirectJudgeResponse;
  readerAttempts: number;
  judges: Record<string, LongMemEvalBinaryJudgment>;
}

interface PolicyScore {
  policyId: TypedRefutationPolicyId;
  eligible: boolean;
  primaryImprovedReaderPairs: number;
  primaryEqualReaderPairs: number;
  primaryHarmedReaderPairs: number;
  unanimousImprovedReaderPairs: number;
  anyJudgeHarmedReaderPairs: number;
  readersWithAtLeastOnePrimaryImprovement: number;
  readersWithNegativeMeanDelta: number;
  primaryChangedPairMeanDelta: number;
  fullFactorialChangedCellMeanDelta: number;
  candidateUnknownAnswers: number;
  meanCapsuleTokens: number;
  meanCandidateTokenDelta: number;
  directCertificateViolations: number;
  fallbackCount: number;
  readerCalls: number;
  judgeCalls: number;
  readerRetries: number;
  judgeRetries: number;
  modelMismatches: number;
  checks: Record<string, boolean>;
  failedChecks: string[];
  changedRows: Array<Record<string, unknown>>;
}

export interface TypedRefutationPolicyGateInput {
  primaryImprovedReaderPairs: number;
  primaryHarmedReaderPairs: number;
  unanimousImprovedReaderPairs: number;
  anyJudgeHarmedReaderPairs: number;
  readersWithAtLeastOnePrimaryImprovement: number;
  readersWithNegativeMeanDelta: number;
  modelMismatches: number;
  directCertificateViolations: number;
  fallbackCount: number;
}

export interface TypedRefutationDesignOptions {
  dataRoot: string;
  baselineCases: string;
  d14CandidateCases: string;
  d14CandidateSummary: string;
  d14AnswerEvaluations: string;
  d14AnswerSummary: string;
  d14Decision: string;
  outputDir: string;
  preScoreCommit: string;
  concurrency?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contextSha256(items: readonly Pick<RetrievedUnit, "id" | "content" | "tokenCount">[]): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(`${item.id}\0${item.tokenCount}\0${item.content}\n`);
  return hash.digest("hex");
}

function asSpec(value: (typeof LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.answerPanel.readers)[number]): DirectJudgeSpec {
  return { ...value, provider: value.provider as DirectJudgeSpec["provider"] };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function evaluateTypedRefutationPolicyGate(input: TypedRefutationPolicyGateInput): {
  eligible: boolean;
  checks: Record<string, boolean>;
  failedChecks: string[];
} {
  const gate = LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.selectionRule.eligible;
  const checks = {
    primaryImprovement: input.primaryImprovedReaderPairs >= gate.minPrimaryImprovedReaderPairs,
    noPrimaryHarm: input.primaryHarmedReaderPairs <= gate.maxPrimaryHarmedReaderPairs,
    unanimousImprovement: input.unanimousImprovedReaderPairs
      >= gate.minUnanimousImprovedReaderPairs,
    noAnyJudgeHarm: input.anyJudgeHarmedReaderPairs <= gate.maxAnyJudgeHarmedReaderPairs,
    readerCoverage: input.readersWithAtLeastOnePrimaryImprovement
      >= gate.minReadersWithAtLeastOnePrimaryImprovement,
    perReaderNonInferiority: input.readersWithNegativeMeanDelta
      <= gate.maxReaderWithNegativeMeanDelta,
    returnedModels: !gate.requireZeroModelMismatches || input.modelMismatches === 0,
    directCertificates: !gate.requireAllCapsuleAndFallbackCertificates
      || (input.directCertificateViolations === 0 && input.fallbackCount === 0),
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { eligible: failedChecks.length === 0, checks, failedChecks };
}

async function withRetries<T>(operation: () => Promise<T>): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;
  const retries = LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.answerPanel.retries;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return { value: await operation(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableJudgeError(error)) throw error;
    }
    if (attempt < retries) await delay(500 * 2 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function activeD14IndexConfig(): PremiseEvidenceConfig {
  const candidate = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.candidate;
  return {
    maxTrajectories: candidate.maxTrajectories,
    maxStates: candidate.maxStates,
    maxInventories: candidate.maxInventories,
    maxItemsPerInventory: candidate.maxItemsPerInventory,
    maxIndexKeys: candidate.maxIndexKeys,
    maxSupportsPerKey: candidate.maxSupportsPerKey,
    maxCapsuleCharacters: candidate.maxCapsuleCharacters,
    minContextOverlap: candidate.minContextOverlap,
    minDistinctTrajectories: candidate.minDistinctTrajectories,
    allowedInventoryKinds: [...candidate.allowedInventoryKinds] as PremiseEvidenceInventoryKind[],
  };
}

function activeD14ContextPolicy(): PremiseEvidenceContextPolicy {
  const candidate = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.candidate;
  return {
    enabled: true,
    maxCapsuleTokens: candidate.maxCapsuleTokens,
    maxCandidateItems: candidate.maxCandidateItems,
    maxCandidateTokens: candidate.maxCandidateTokens,
    maxSelectionLatencyMs: candidate.maxSelectionLatencyMs,
  };
}

function typedPolicy(policyId: TypedRefutationPolicyId): TypedRefutationContextPolicy {
  const candidate = LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.candidate;
  return {
    policyId,
    enabled: true,
    maxCapsuleTokens: candidate.maxCapsuleTokens,
    maxCandidateItems: candidate.maxCandidateItems,
    maxCandidateTokens: candidate.maxCandidateTokens,
    maxSelectionLatencyMs: candidate.maxSelectionLatencyMs,
  };
}

function resultToContext(params: {
  policyId: TypedRefutationPolicyId;
  questionId: string;
  baseline: LongMemEvalV2PremiseEvidenceBaselineCase;
  result: TypedRefutationResult;
}): TypedRefutationDesignContext {
  return {
    protocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.protocolVersion,
    policyId: params.policyId,
    questionId: params.questionId,
    baseContextSha256: params.baseline.contextSha256,
    contextSha256: params.result.contextSha256,
    baseInjectedTokens: params.baseline.injectedTokens,
    injectedTokens: params.result.injectedTokens,
    typedCapsuleTokens: params.result.typedCapsuleTokens,
    selectionLatencyMs: params.result.selectionLatencyMs,
    typedCapsule: params.result.typedCapsule,
    injected: params.result.items,
    fallback: params.result.fallback,
    fallbackReason: params.result.fallbackReason,
    basePrefixViolations: params.result.basePrefixViolations,
    capsuleCertificateViolations: params.result.capsuleCertificateViolations,
    tokenViolation: params.result.tokenViolation,
  };
}

function evaluationKey(item: Pick<TypedRefutationDesignEvaluation,
  "policyId" | "questionId" | "readerId">): string {
  return `${item.policyId}\0${item.questionId}\0${item.readerId}`;
}

async function loadCompleted(file: string): Promise<TypedRefutationDesignEvaluation[]> {
  try {
    const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as TypedRefutationDesignEvaluation);
    const allowedPolicies = new Set(typedRefutationPolicyIds());
    if (rows.some((item) => item.protocolVersion
      !== LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.protocolVersion
      || !allowedPolicies.has(item.policyId))
      || new Set(rows.map(evaluationKey)).size !== rows.length) {
      throw new Error("D15 resume artifact identity mismatch");
    }
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function evaluateCandidate(params: {
  context: TypedRefutationDesignContext;
  question: LongTaskQuestion;
  reader: DirectJudgeSpec;
  judges: DirectJudgeSpec[];
  apiKeys: ReadonlyMap<string, string>;
}): Promise<TypedRefutationDesignEvaluation> {
  const reader = await withRetries(() => callDirectJudge({
    spec: params.reader,
    apiKey: params.apiKeys.get(params.reader.id)!,
    messages: longMemEvalReaderMessages(params.question, params.context.injected),
    responseFormat: "text",
  }));
  const parsedFinalAnswer = extractLongMemEvalBoxedAnswer(reader.value.content);
  const judgments = await Promise.all(params.judges.map(async (judge) => {
    const result = await withRetries(async () => {
      const response = await callDirectJudge({
        spec: judge,
        apiKey: params.apiKeys.get(judge.id)!,
        messages: longMemEvalAbstentionJudgeMessages(
          params.question,
          reader.value.content,
          parsedFinalAnswer,
        ),
        responseFormat: "json",
      });
      return { response, parsed: parseLongMemEvalBinaryJudgment(response.content) };
    });
    return [judge.id, {
      response: result.value.response,
      label: result.value.parsed.label,
      reason: result.value.parsed.reason,
      attempts: result.attempts,
    }] as const;
  }));
  return {
    protocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.protocolVersion,
    policyId: params.context.policyId,
    questionId: params.question.id,
    readerId: params.reader.id,
    contextSha256: params.context.contextSha256,
    injectedTokens: params.context.injectedTokens,
    answer: reader.value.content,
    parsedFinalAnswer,
    isUnknown: parsedFinalAnswer.trim().toLowerCase() === "unknown",
    reader: reader.value,
    readerAttempts: reader.attempts,
    judges: Object.fromEntries(judgments),
  };
}

function scorePolicy(params: {
  policyId: TypedRefutationPolicyId;
  contexts: TypedRefutationDesignContext[];
  candidate: TypedRefutationDesignEvaluation[];
  baseByKey: ReadonlyMap<string, LongMemEvalAnswerEvaluation>;
  readers: DirectJudgeSpec[];
  judges: DirectJudgeSpec[];
}): PolicyScore {
  const candidateByKey = new Map(params.candidate.map((item) =>
    [`${item.questionId}\0${item.readerId}`, item]));
  let primaryImprovedReaderPairs = 0;
  let primaryEqualReaderPairs = 0;
  let primaryHarmedReaderPairs = 0;
  let unanimousImprovedReaderPairs = 0;
  let anyJudgeHarmedReaderPairs = 0;
  let fullDelta = 0;
  const perReader = Object.fromEntries(params.readers.map((reader) => [reader.id, [] as number[]]));
  const changedRows: Array<Record<string, unknown>> = [];
  for (const context of params.contexts) {
    for (const reader of params.readers) {
      const base = params.baseByKey.get(`${context.questionId}\0${reader.id}`)!;
      const candidate = candidateByKey.get(`${context.questionId}\0${reader.id}`)!;
      const crossJudge = params.judges.find((judge) => judge.id !== reader.id)!;
      const primaryDelta = candidate.judges[crossJudge.id].label - base.judges[crossJudge.id].label;
      primaryImprovedReaderPairs += Number(primaryDelta > 0);
      primaryEqualReaderPairs += Number(primaryDelta === 0);
      primaryHarmedReaderPairs += Number(primaryDelta < 0);
      perReader[reader.id].push(primaryDelta);
      const judgeDeltas = params.judges.map((judge) =>
        candidate.judges[judge.id].label - base.judges[judge.id].label);
      fullDelta += judgeDeltas.reduce((sum, value) => sum + value, 0);
      unanimousImprovedReaderPairs += Number(judgeDeltas.every((value) => value > 0));
      anyJudgeHarmedReaderPairs += Number(judgeDeltas.some((value) => value < 0));
      changedRows.push({
        questionId: context.questionId,
        readerId: reader.id,
        crossJudgeId: crossJudge.id,
        basePrimary: base.judges[crossJudge.id].label,
        candidatePrimary: candidate.judges[crossJudge.id].label,
        primaryDelta,
        judgeDeltas: Object.fromEntries(params.judges.map((judge, index) =>
          [judge.id, judgeDeltas[index]])),
      });
    }
  }
  let readerRetries = 0;
  let judgeRetries = 0;
  let modelMismatches = 0;
  for (const row of params.candidate) {
    readerRetries += row.readerAttempts - 1;
    const reader = params.readers.find((item) => item.id === row.readerId)!;
    modelMismatches += Number(row.reader.model !== reader.model);
    for (const judge of params.judges) {
      judgeRetries += row.judges[judge.id].attempts - 1;
      modelMismatches += Number(row.judges[judge.id].response.model !== judge.model);
    }
  }
  const directCertificateViolations = params.contexts.reduce((sum, item) => sum
    + item.basePrefixViolations + item.capsuleCertificateViolations + Number(item.tokenViolation)
    + Number(item.selectionLatencyMs
      > LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.candidate.maxSelectionLatencyMs), 0);
  const fallbackCount = params.contexts.filter((item) => item.fallback).length;
  const readersWithAtLeastOnePrimaryImprovement = Object.values(perReader)
    .filter((values) => values.some((value) => value > 0)).length;
  const readersWithNegativeMeanDelta = Object.values(perReader)
    .filter((values) => values.reduce((sum, value) => sum + value, 0) / values.length < 0).length;
  const gate = evaluateTypedRefutationPolicyGate({
    primaryImprovedReaderPairs,
    primaryHarmedReaderPairs,
    unanimousImprovedReaderPairs,
    anyJudgeHarmedReaderPairs,
    readersWithAtLeastOnePrimaryImprovement,
    readersWithNegativeMeanDelta,
    modelMismatches,
    directCertificateViolations,
    fallbackCount,
  });
  return {
    policyId: params.policyId,
    eligible: gate.eligible,
    primaryImprovedReaderPairs,
    primaryEqualReaderPairs,
    primaryHarmedReaderPairs,
    unanimousImprovedReaderPairs,
    anyJudgeHarmedReaderPairs,
    readersWithAtLeastOnePrimaryImprovement,
    readersWithNegativeMeanDelta,
    primaryChangedPairMeanDelta: (primaryImprovedReaderPairs - primaryHarmedReaderPairs)
      / (params.contexts.length * params.readers.length),
    fullFactorialChangedCellMeanDelta: fullDelta
      / (params.contexts.length * params.readers.length * params.judges.length),
    candidateUnknownAnswers: params.candidate.filter((item) => item.isUnknown).length,
    meanCapsuleTokens: params.contexts.reduce((sum, item) => sum + item.typedCapsuleTokens, 0)
      / params.contexts.length,
    meanCandidateTokenDelta: params.contexts.reduce((sum, item) =>
      sum + item.injectedTokens - item.baseInjectedTokens, 0) / params.contexts.length,
    directCertificateViolations,
    fallbackCount,
    readerCalls: params.candidate.length,
    judgeCalls: params.candidate.length * params.judges.length,
    readerRetries,
    judgeRetries,
    modelMismatches,
    checks: gate.checks,
    failedChecks: gate.failedChecks,
    changedRows,
  };
}

export async function runTypedRefutationDesign(options: TypedRefutationDesignOptions) {
  if (!/^[0-9a-f]{7,40}$/u.test(options.preScoreCommit)) {
    throw new Error("D15 design preScoreCommit must be a git SHA");
  }
  const [baselineText, candidateText, candidateSummaryText, d14EvaluationsText,
    d14AnswerSummaryText, d14DecisionText] = await Promise.all([
    readFile(options.baselineCases, "utf8"), readFile(options.d14CandidateCases, "utf8"),
    readFile(options.d14CandidateSummary, "utf8"), readFile(options.d14AnswerEvaluations, "utf8"),
    readFile(options.d14AnswerSummary, "utf8"), readFile(options.d14Decision, "utf8"),
  ]);
  const locks = LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.designBoundary;
  if (sha256(candidateText) !== locks.d14CandidateCasesSha256
    || sha256(candidateSummaryText) !== locks.d14CandidateSummarySha256
    || sha256(d14EvaluationsText) !== locks.d14AnswerEvaluationsSha256
    || sha256(d14AnswerSummaryText) !== locks.d14AnswerSummarySha256
    || sha256(d14DecisionText) !== locks.d14DecisionSha256) {
    throw new Error("D15 frozen D14 design input hash mismatch");
  }
  const baselineCases = baselineText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceBaselineCase);
  const d14Cases = candidateText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceCase);
  const d14Summary = JSON.parse(candidateSummaryText) as LongMemEvalV2PremiseEvidenceSummary;
  const d14Evaluations = d14EvaluationsText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalAnswerEvaluation);
  const d14AnswerSummary = JSON.parse(d14AnswerSummaryText) as { status?: string };
  const d14Decision = JSON.parse(d14DecisionText) as D14DevelopmentDecision;
  if (d14Summary.status !== "development_direct_passed" || !d14Summary.gate.passed
    || d14AnswerSummary.status !== "development_answer_failed"
    || d14Decision.status !== "rejected_no_answer_level_gain") {
    throw new Error("D15 requires the sealed D14 direct pass and answer failure");
  }
  const changed = d14Cases.filter((item) => item.contextChanged);
  if (changed.length !== 2 || changed.some((item) => !item.usedPremiseEvidence)) {
    throw new Error("D15 expected exactly two D14 changed design cases");
  }
  const baselineById = new Map(baselineCases.map((item) => [item.questionId, item]));
  const baseEvaluations = d14Evaluations.filter((item) => item.arm === "base");
  const baseByKey = new Map(baseEvaluations.map((item) =>
    [`${item.questionId}\0${item.readerId}`, item]));
  if (baseByKey.size !== 4) throw new Error("D15 requires four sealed D14 Base reader cells");

  const dataset = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset;
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: options.dataRoot,
    revision: dataset.benchmarkRepositoryRevision,
    tier: dataset.tier,
    expected: {
      questionsSha256: dataset.questionsSha256,
      haystackSha256: dataset.haystackSha256,
      trajectoriesSha256: dataset.trajectoriesSha256,
      questions: dataset.questions,
      trajectoryRows: dataset.trajectoryRows,
      haystackSize: 100,
      selectedTrajectories: dataset.selectedTrajectories,
    },
  });
  const questions = await adapter.loadQuestions();
  const questionById = new Map(questions.map((item) => [item.id, item]));
  const allDevelopment = d14Cases.map((item) => questionById.get(item.questionId)!);
  const trajectories = await adapter.loadTrajectories([...new Set(allDevelopment.flatMap((item) =>
    item.trajectoryIds))]);
  const index = buildPremiseEvidenceIndex({
    trajectories,
    config: activeD14IndexConfig(),
    scopeAdapter: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  });
  if (!index.available) throw new Error(`D15 structural replay unavailable: ${index.failureReason}`);
  const readers = LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.answerPanel.readers.map(asSpec);
  const judges = LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.answerPanel.judges.map(asSpec);
  const apiKeys = new Map<string, string>();
  for (const spec of [...readers, ...judges]) {
    const key = process.env[spec.apiKeyEnv];
    if (!key) throw new Error(`${spec.apiKeyEnv} is required for D15 ${spec.id}`);
    apiKeys.set(spec.id, key);
  }
  await mkdir(options.outputDir, { recursive: true });
  const actualPath = path.join(options.outputDir, "actual-evaluations.jsonl");
  const completed = await loadCompleted(actualPath);
  const completedByKey = new Map(completed.map((item) => [evaluationKey(item), item]));
  const executedContexts: TypedRefutationDesignContext[] = [];
  const policyScores: PolicyScore[] = [];
  let selectedPolicyId: TypedRefutationPolicyId | null = null;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2,
    LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.answerPanel.maxConcurrency));
  for (const policyId of typedRefutationPolicyIds()) {
    const contexts = changed.map((d14): TypedRefutationDesignContext => {
      const baseline = baselineById.get(d14.questionId);
      const question = questionById.get(d14.questionId);
      if (!baseline || !question || baseline.contextSha256 !== d14.baseContextSha256) {
        throw new Error(`D15 missing locked case ${d14.questionId}`);
      }
      const result = selectTypedRefutationContext({
        baseline: {
          items: baseline.injected,
          injectedTokens: baseline.injectedTokens,
          tokenViolation: baseline.tokenViolation,
        },
        question,
        index,
        d14Policy: activeD14ContextPolicy(),
        policy: typedPolicy(policyId),
      });
      return resultToContext({ policyId, questionId: d14.questionId, baseline, result });
    }).sort((left, right) => left.questionId.localeCompare(right.questionId));
    if (contexts.some((item) => item.fallback || !item.typedCapsule
      || item.contextSha256 === item.baseContextSha256)) {
      throw new Error(`D15 ${policyId} cannot enter answer design due to direct failure`);
    }
    executedContexts.push(...contexts);
    const tasks = contexts.flatMap((context) => readers.map((reader) => ({ context, reader })))
      .sort((left, right) => sha256(`d15\0${policyId}\0${left.context.questionId}\0${left.reader.id}`)
        .localeCompare(sha256(`d15\0${policyId}\0${right.context.questionId}\0${right.reader.id}`)));
    const remaining = tasks.filter(({ context, reader }) =>
      !completedByKey.has(`${policyId}\0${context.questionId}\0${reader.id}`));
    for (let offset = 0; offset < remaining.length; offset += concurrency) {
      const batch = remaining.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(batch.map(({ context, reader }) => {
        const question = questionById.get(context.questionId)!;
        return evaluateCandidate({ context, question, reader, judges, apiKeys });
      }));
      const successes = settled.filter((item): item is PromiseFulfilledResult<TypedRefutationDesignEvaluation> =>
        item.status === "fulfilled").map((item) => item.value);
      if (successes.length) {
        await appendFile(actualPath, `${successes.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
        for (const item of successes) completedByKey.set(evaluationKey(item), item);
      }
      const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failure) throw failure.reason;
      process.stdout.write(`D15 ${policyId} actual ${tasks.length - remaining.length + Math.min(offset + concurrency, remaining.length)}/${tasks.length}\n`);
    }
    const candidate = tasks.map(({ context, reader }) =>
      completedByKey.get(`${policyId}\0${context.questionId}\0${reader.id}`)!);
    const score = scorePolicy({ policyId, contexts, candidate, baseByKey, readers, judges });
    policyScores.push(score);
    if (score.eligible) {
      selectedPolicyId = policyId;
      break;
    }
  }
  const evaluations = [...completedByKey.values()].filter((item) =>
    policyScores.some((score) => score.policyId === item.policyId));
  await writeFile(path.join(options.outputDir, "evaluations.jsonl"),
    `${evaluations.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  const contextsText = executedContexts.map((item) => `${JSON.stringify(item)}\n`).join("");
  await writeFile(path.join(options.outputDir, "contexts.jsonl"), contextsText, "utf8");
  const summary = {
    protocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.protocolVersion,
    mode: "typed_refutation_design",
    phase: "development",
    status: selectedPolicyId ? "renderer_selected" : "no_eligible_renderer",
    decision: selectedPolicyId ? "freeze_renderer_before_validation"
      : "reject_D15_and_keep_validation_unread",
    preScoreCommit: options.preScoreCommit,
    inputSha256: {
      baselineCases: sha256(baselineText),
      d14CandidateCases: sha256(candidateText),
      d14CandidateSummary: sha256(candidateSummaryText),
      d14AnswerEvaluations: sha256(d14EvaluationsText),
      d14AnswerSummary: sha256(d14AnswerSummaryText),
      d14Decision: sha256(d14DecisionText),
    },
    runtimeBoundary: "Only D14 development questions and source-certified decisions are used. References are available to judges only; renderer and reader never receive them outside the official judge call.",
    structuralReplay: {
      trajectories: index.trajectories,
      states: index.states,
      inventories: index.inventories.length,
      available: index.available,
      scopeAdapterId: index.scopeAdapterId,
    },
    executedPolicies: policyScores.map((item) => item.policyId),
    unexecutedPolicies: typedRefutationPolicyIds().filter((id) =>
      !policyScores.some((item) => item.policyId === id)),
    selectedPolicyId,
    policyScores,
    contextsSha256: sha256(contextsText),
    operationalIntegrity: {
      candidateReaderCalls: policyScores.reduce((sum, item) => sum + item.readerCalls, 0),
      candidateJudgeCalls: policyScores.reduce((sum, item) => sum + item.judgeCalls, 0),
      readerRetries: policyScores.reduce((sum, item) => sum + item.readerRetries, 0),
      judgeRetries: policyScores.reduce((sum, item) => sum + item.judgeRetries, 0),
      modelMismatches: policyScores.reduce((sum, item) => sum + item.modelMismatches, 0),
      reusedD14BaseReaderCells: baseByKey.size,
    },
    laterPhaseState: "unread",
    claimBoundary: selectedPolicyId
      ? "The selected renderer is a development-tuned candidate only; answer-quality replication requires fresh validation."
      : "No answer-quality claim is supported and validation remains unread.",
  };
  await writeFile(path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { contexts: executedContexts, evaluations, summary };
}
