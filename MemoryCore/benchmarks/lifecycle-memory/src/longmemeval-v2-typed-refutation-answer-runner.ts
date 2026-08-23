import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  extractLongMemEvalBoxedAnswer,
  longMemEvalAbstentionJudgeMessages,
  longMemEvalReaderMessages,
  parseLongMemEvalBinaryJudgment,
  type LongMemEvalBinaryJudgment,
} from "./longmemeval-v2-premise-evidence-answer-runner.js";
import type { LongMemEvalV2PremiseEvidenceBaselineCase }
  from "./longmemeval-v2-premise-evidence-baseline-runner.js";
import { LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL, premiseEvidenceQuestionIdsForPhase }
  from "./longmemeval-v2-premise-evidence-protocol.js";
import {
  callDirectJudge,
  isRetryableJudgeError,
  type DirectJudgeResponse,
  type DirectJudgeSpec,
} from "./judge-provider.js";
import type {
  TypedRefutationValidationCase,
  TypedRefutationValidationSummary,
} from "./longmemeval-v2-typed-refutation-validation-runner.js";
import type { TypedRefutationIndependentValidation }
  from "./longmemeval-v2-typed-refutation-validation-validator.js";
import { LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL }
  from "./longmemeval-v2-typed-refutation-validation-protocol.js";
import type { RetrievedUnit } from "./types.js";

type TypedRefutationAnswerArm = "base" | "typed_action_contract";

export interface TypedRefutationAnswerEvaluation {
  protocolVersion: string;
  phase: "validation";
  questionId: string;
  readerId: string;
  arm: TypedRefutationAnswerArm;
  contextSha256: string;
  injectedTokens: number;
  answer: string;
  parsedFinalAnswer: string;
  isUnknown: boolean;
  reader: DirectJudgeResponse;
  readerAttempts: number;
  judges: Record<string, LongMemEvalBinaryJudgment>;
}

interface SelectedCase {
  question: LongTaskQuestion;
  baseline: LongMemEvalV2PremiseEvidenceBaselineCase;
  candidate: TypedRefutationValidationCase;
  arms: Record<TypedRefutationAnswerArm, RetrievedUnit[]>;
}

export interface TypedRefutationAnswerGateInput {
  changedQuestions: number;
  changedReaderPairs: number;
  actualReaderCalls: number;
  expectedReaderCalls: number;
  actualJudgeCalls: number;
  expectedJudgeCalls: number;
  primaryImprovedReaderPairs: number;
  primaryHarmedReaderPairs: number;
  unanimousImprovedReaderPairs: number;
  anyJudgeHarmedReaderPairs: number;
  readersWithAtLeastOnePrimaryImprovement: number;
  readersWithNegativeMeanDelta: number;
  primaryPopulationWeightedDelta: number;
  fullFactorialPopulationWeightedDelta: number;
  modelMismatches: number;
  exactUnchangedContexts: boolean;
}

export interface TypedRefutationAnswerSummary {
  protocolVersion: string;
  mode: "typed_refutation_answer_validation";
  phase: "validation";
  status: "validation_answer_passed" | "validation_answer_failed";
  decision: "authorize_frozen_test_read" | "reject_D15_and_keep_test_unread";
  generatedAt: string;
  inputSha256: {
    baselineCases: string;
    baselineSummary: string;
    directCases: string;
    directSummary: string;
    independentValidation: string;
  };
  evaluationsSha256: string;
  population: {
    totalQuestions: number;
    changedQuestions: number;
    unchangedQuestionsAssignedZeroDeltaWithoutCalls: number;
    readers: number;
    judges: number;
  };
  primaryCrossed: {
    improvedReaderPairs: number;
    equalReaderPairs: number;
    harmedReaderPairs: number;
    changedReaderPairs: number;
    improvementRate: number;
    changedPairMeanDelta: number;
    populationWeightedDelta: number;
    perReaderChangedMeanDelta: Record<string, number>;
    readersWithAtLeastOneImprovement: number;
    readersWithNegativeMeanDelta: number;
  };
  fullFactorialSensitivity: {
    unanimousImprovedReaderPairs: number;
    unanimousImprovementRate: number;
    anyJudgeHarmedReaderPairs: number;
    populationWeightedDelta: number;
    judgeAgreementRate: number;
  };
  changedRows: Array<Record<string, unknown>>;
  operationalIntegrity: {
    readerCalls: number;
    judgeCalls: number;
    expectedReaderCalls: number;
    expectedJudgeCalls: number;
    readerRetries: number;
    judgeRetries: number;
    modelMismatches: number;
  };
  answerGate: { passed: boolean; checks: Record<string, boolean>; failedChecks: string[] };
  testState: "authorized_unread" | "unread";
  claimBoundary: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exact<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function asSpec(value: (typeof LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.readers)[number]): DirectJudgeSpec {
  return { ...value, provider: value.provider as DirectJudgeSpec["provider"] };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRetries<T>(operation: () => Promise<T>): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;
  const retries = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.retries;
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

function evaluationKey(item: Pick<TypedRefutationAnswerEvaluation,
  "questionId" | "readerId" | "arm">): string {
  return `${item.questionId}\0${item.readerId}\0${item.arm}`;
}

async function evaluateTask(params: {
  selected: SelectedCase;
  arm: TypedRefutationAnswerArm;
  reader: DirectJudgeSpec;
  judges: DirectJudgeSpec[];
  apiKeys: ReadonlyMap<string, string>;
}): Promise<TypedRefutationAnswerEvaluation> {
  const context = params.selected.arms[params.arm];
  const reader = await withRetries(() => callDirectJudge({
    spec: params.reader,
    apiKey: params.apiKeys.get(params.reader.id)!,
    messages: longMemEvalReaderMessages(params.selected.question, context),
    responseFormat: "text",
  }));
  const parsedFinalAnswer = extractLongMemEvalBoxedAnswer(reader.value.content);
  const judges = await Promise.all(params.judges.map(async (judge) => {
    const result = await withRetries(async () => {
      const response = await callDirectJudge({
        spec: judge,
        apiKey: params.apiKeys.get(judge.id)!,
        messages: longMemEvalAbstentionJudgeMessages(
          params.selected.question,
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
  const source = params.arm === "base" ? params.selected.baseline : params.selected.candidate;
  return {
    protocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion,
    phase: "validation",
    questionId: params.selected.question.id,
    readerId: params.reader.id,
    arm: params.arm,
    contextSha256: source.contextSha256,
    injectedTokens: source.injectedTokens,
    answer: reader.value.content,
    parsedFinalAnswer,
    isUnknown: parsedFinalAnswer.trim().toLowerCase() === "unknown",
    reader: reader.value,
    readerAttempts: reader.attempts,
    judges: Object.fromEntries(judges),
  };
}

async function loadCompleted(file: string,
  allowed: ReadonlySet<string>): Promise<TypedRefutationAnswerEvaluation[]> {
  try {
    const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as TypedRefutationAnswerEvaluation);
    if (rows.some((item) => item.protocolVersion
      !== LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion
      || item.phase !== "validation" || !allowed.has(evaluationKey(item)))
      || new Set(rows.map(evaluationKey)).size !== rows.length) {
      throw new Error("D15 validation answer resume artifact identity mismatch");
    }
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function evaluateTypedRefutationAnswerGate(input: TypedRefutationAnswerGateInput): {
  passed: boolean;
  checks: Record<string, boolean>;
  failedChecks: string[];
} {
  const gate = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.gate;
  const checks = {
    changedQuestionCoverage: input.changedQuestions >= gate.minChangedQuestions,
    completeExecution: !gate.requireCompleteExecution
      || (input.actualReaderCalls === input.expectedReaderCalls
        && input.actualJudgeCalls === input.expectedJudgeCalls),
    primaryImprovementCount: input.primaryImprovedReaderPairs >= gate.minPrimaryImprovedReaderPairs,
    primaryImprovementRate: input.changedReaderPairs > 0
      && input.primaryImprovedReaderPairs / input.changedReaderPairs >= gate.minPrimaryImprovementRate,
    noPrimaryHarm: input.primaryHarmedReaderPairs <= gate.maxPrimaryHarmedReaderPairs,
    unanimousImprovementCount: input.unanimousImprovedReaderPairs
      >= gate.minUnanimousImprovedReaderPairs,
    unanimousImprovementRate: input.changedReaderPairs > 0
      && input.unanimousImprovedReaderPairs / input.changedReaderPairs
        >= gate.minUnanimousImprovementRate,
    noAnyJudgeHarm: input.anyJudgeHarmedReaderPairs <= gate.maxAnyJudgeHarmedReaderPairs,
    readerCoverage: input.readersWithAtLeastOnePrimaryImprovement
      >= gate.minReadersWithAtLeastOnePrimaryImprovement,
    perReaderNonInferiority: input.readersWithNegativeMeanDelta
      <= gate.maxReadersWithNegativeMeanDelta,
    positivePrimaryPopulationDelta: !gate.requirePositivePrimaryPopulationWeightedDelta
      || input.primaryPopulationWeightedDelta > 0,
    positiveFullFactorialPopulationDelta: !gate.requirePositiveFullFactorialPopulationWeightedDelta
      || input.fullFactorialPopulationWeightedDelta > 0,
    returnedModels: !gate.requireZeroModelMismatches || input.modelMismatches === 0,
    exactUnchangedContexts: !gate.requireExactUnchangedContexts || input.exactUnchangedContexts,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { passed: failedChecks.length === 0, checks, failedChecks };
}

export async function runTypedRefutationAnswerValidation(options: {
  dataRoot: string;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  directCasesPath: string;
  directSummaryPath: string;
  independentValidationPath: string;
  outputDir: string;
  concurrency?: number;
}): Promise<TypedRefutationAnswerSummary> {
  const [baselineText, baselineSummaryText, directText, directSummaryText, validationText]
    = await Promise.all([
      readFile(options.baselineCasesPath, "utf8"), readFile(options.baselineSummaryPath, "utf8"),
      readFile(options.directCasesPath, "utf8"), readFile(options.directSummaryPath, "utf8"),
      readFile(options.independentValidationPath, "utf8"),
    ]);
  const hashes = {
    baselineCases: sha256(baselineText), baselineSummary: sha256(baselineSummaryText),
    directCases: sha256(directText), directSummary: sha256(directSummaryText),
    independentValidation: sha256(validationText),
  };
  const baseline = baselineText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceBaselineCase);
  const direct = directText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as TypedRefutationValidationCase);
  const directSummary = JSON.parse(directSummaryText) as TypedRefutationValidationSummary;
  const validation = JSON.parse(validationText) as TypedRefutationIndependentValidation;
  if (directSummary.status !== "validation_direct_passed" || !directSummary.gate.passed
    || directSummary.answerLevelState !== "admitted_pending"
    || directSummary.casesSha256 !== hashes.directCases
    || directSummary.inputSha256.baselineCases !== hashes.baselineCases
    || directSummary.inputSha256.baselineSummary !== hashes.baselineSummary
    || validation.status !== "passed" || validation.answerLevelState !== "admitted_pending"
    || validation.inputSha256.baselineCases !== hashes.baselineCases
    || validation.inputSha256.baselineSummary !== hashes.baselineSummary
    || validation.inputSha256.candidateCases !== hashes.directCases
    || validation.inputSha256.candidateSummary !== hashes.directSummary) {
    throw new Error("D15 answer validation requires passed, independently validated direct artifacts");
  }
  const expected = premiseEvidenceQuestionIdsForPhase("validation");
  const expectedIds = new Set(expected.map((item) => item.id));
  const baseById = new Map(baseline.map((item) => [item.questionId, item]));
  const directById = new Map(direct.map((item) => [item.questionId, item]));
  if (baseById.size !== expected.length || directById.size !== expected.length
    || ![...directById.keys()].every((id) => expectedIds.has(id))) {
    throw new Error("D15 answer validation coverage mismatch");
  }
  const changed = direct.filter((item) => item.contextChanged);
  const minimum = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.gate
    .minChangedQuestions;
  if (changed.length < minimum || changed.some((item) => !item.usedTypedRefutation
    || item.label !== "premise" || item.fallback)) {
    throw new Error("D15 answer validation changed population is not admitted");
  }
  const unchanged = direct.filter((item) => !item.contextChanged);
  const exactUnchangedContexts = unchanged.every((item) => !item.usedTypedRefutation
    && !item.fallback && item.contextSha256 === item.baseContextSha256
    && exact(item.injectedIds, item.baseInjectedIds)
    && exact(item.injectedItemSha256, item.baseInjectedItemSha256));

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
  const selected = changed.map((candidate): SelectedCase => {
    const question = questionById.get(candidate.questionId);
    const base = baseById.get(candidate.questionId);
    if (!question || !base || directById.get(candidate.questionId) !== candidate
      || candidate.baseContextSha256 !== base.contextSha256 || question.imagePath !== null
      || !question.evaluator.startsWith("llm_abstention_checker")) {
      throw new Error(`D15 invalid answer case ${candidate.questionId}`);
    }
    return {
      question,
      baseline: base,
      candidate,
      arms: { base: base.injected, typed_action_contract: candidate.injected },
    };
  }).sort((left, right) => left.question.id.localeCompare(right.question.id));
  const readers = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.readers.map(asSpec);
  const judges = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.judges.map(asSpec);
  const apiKeys = new Map<string, string>();
  for (const spec of [...readers, ...judges]) {
    const key = process.env[spec.apiKeyEnv];
    if (!key) throw new Error(`${spec.apiKeyEnv} is required for D15 validation ${spec.id}`);
    apiKeys.set(spec.id, key);
  }
  const tasks = selected.flatMap((item) => readers.flatMap((reader) =>
    (["base", "typed_action_contract"] as TypedRefutationAnswerArm[])
      .map((arm) => ({ selected: item, reader, arm }))
  )).sort((left, right) => sha256(`d15-validation\0${left.selected.question.id}\0${left.reader.id}\0${left.arm}`)
    .localeCompare(sha256(`d15-validation\0${right.selected.question.id}\0${right.reader.id}\0${right.arm}`)));
  await mkdir(options.outputDir, { recursive: true });
  const actualPath = path.join(options.outputDir, "actual-evaluations.jsonl");
  const allowed = new Set(tasks.map((item) =>
    `${item.selected.question.id}\0${item.reader.id}\0${item.arm}`));
  const completed = await loadCompleted(actualPath, allowed);
  const completedByKey = new Map(completed.map((item) => [evaluationKey(item), item]));
  const remaining = tasks.filter((item) => !completedByKey.has(
    `${item.selected.question.id}\0${item.reader.id}\0${item.arm}`,
  ));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2,
    LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.maxConcurrency));
  for (let offset = 0; offset < remaining.length; offset += concurrency) {
    const batch = remaining.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(batch.map((task) => evaluateTask({
      ...task, judges, apiKeys,
    })));
    const successes = settled.filter((item): item is PromiseFulfilledResult<TypedRefutationAnswerEvaluation> =>
      item.status === "fulfilled").map((item) => item.value);
    if (successes.length) {
      await appendFile(actualPath, `${successes.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
      for (const item of successes) completedByKey.set(evaluationKey(item), item);
    }
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failure) throw failure.reason;
    process.stdout.write(`D15 validation answers ${completedByKey.size}/${tasks.length}\n`);
  }
  const rows = tasks.map((item) => completedByKey.get(
    `${item.selected.question.id}\0${item.reader.id}\0${item.arm}`,
  )!);
  const evaluationsText = rows.map((item) => `${JSON.stringify(item)}\n`).join("");
  await writeFile(path.join(options.outputDir, "evaluations.jsonl"), evaluationsText, "utf8");
  const byKey = new Map(rows.map((item) => [evaluationKey(item), item]));
  let primaryImproved = 0;
  let primaryEqual = 0;
  let primaryHarmed = 0;
  let unanimousImproved = 0;
  let anyJudgeHarmed = 0;
  let fullDelta = 0;
  let agreementCells = 0;
  let answerCells = 0;
  const perReader = Object.fromEntries(readers.map((reader) => [reader.id, [] as number[]]));
  const changedRows: Array<Record<string, unknown>> = [];
  for (const item of selected) {
    for (const reader of readers) {
      const base = byKey.get(`${item.question.id}\0${reader.id}\0base`)!;
      const candidate = byKey.get(`${item.question.id}\0${reader.id}\0typed_action_contract`)!;
      const crossJudge = judges.find((judge) => judge.id !== reader.id)!;
      const primaryDelta = candidate.judges[crossJudge.id].label - base.judges[crossJudge.id].label;
      primaryImproved += Number(primaryDelta > 0);
      primaryEqual += Number(primaryDelta === 0);
      primaryHarmed += Number(primaryDelta < 0);
      perReader[reader.id].push(primaryDelta);
      const judgeDeltas = judges.map((judge) =>
        candidate.judges[judge.id].label - base.judges[judge.id].label);
      unanimousImproved += Number(judgeDeltas.every((value) => value > 0));
      anyJudgeHarmed += Number(judgeDeltas.some((value) => value < 0));
      fullDelta += judgeDeltas.reduce((sum, value) => sum + value, 0);
      for (const cell of [base, candidate]) {
        const labels = judges.map((judge) => cell.judges[judge.id].label);
        agreementCells += Number(new Set(labels).size === 1);
        answerCells += 1;
      }
      changedRows.push({
        questionId: item.question.id,
        readerId: reader.id,
        crossJudgeId: crossJudge.id,
        basePrimary: base.judges[crossJudge.id].label,
        candidatePrimary: candidate.judges[crossJudge.id].label,
        primaryDelta,
        judgeDeltas: Object.fromEntries(judges.map((judge, index) => [judge.id, judgeDeltas[index]])),
      });
    }
  }
  const population = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL
    .dataBoundary.validationTotalQuestions;
  const changedPairs = selected.length * readers.length;
  const perReaderChangedMeanDelta = Object.fromEntries(readers.map((reader) => [
    reader.id,
    perReader[reader.id].reduce((sum, value) => sum + value, 0) / perReader[reader.id].length,
  ]));
  const readersWithAtLeastOnePrimaryImprovement = Object.values(perReader)
    .filter((values) => values.some((value) => value > 0)).length;
  const readersWithNegativeMeanDelta = Object.values(perReader)
    .filter((values) => values.reduce((sum, value) => sum + value, 0) / values.length < 0).length;
  const primaryPopulationWeightedDelta = (primaryImproved - primaryHarmed)
    / (population * readers.length);
  const fullFactorialPopulationWeightedDelta = fullDelta
    / (population * readers.length * judges.length);
  let readerRetries = 0;
  let judgeRetries = 0;
  let modelMismatches = 0;
  for (const row of rows) {
    readerRetries += row.readerAttempts - 1;
    const reader = readers.find((item) => item.id === row.readerId)!;
    modelMismatches += Number(row.reader.model !== reader.model);
    for (const judge of judges) {
      judgeRetries += row.judges[judge.id].attempts - 1;
      modelMismatches += Number(row.judges[judge.id].response.model !== judge.model);
    }
  }
  const expectedReaderCalls = changedPairs * 2;
  const expectedJudgeCalls = expectedReaderCalls * judges.length;
  const gate = evaluateTypedRefutationAnswerGate({
    changedQuestions: selected.length,
    changedReaderPairs: changedPairs,
    actualReaderCalls: rows.length,
    expectedReaderCalls,
    actualJudgeCalls: rows.length * judges.length,
    expectedJudgeCalls,
    primaryImprovedReaderPairs: primaryImproved,
    primaryHarmedReaderPairs: primaryHarmed,
    unanimousImprovedReaderPairs: unanimousImproved,
    anyJudgeHarmedReaderPairs: anyJudgeHarmed,
    readersWithAtLeastOnePrimaryImprovement,
    readersWithNegativeMeanDelta,
    primaryPopulationWeightedDelta,
    fullFactorialPopulationWeightedDelta,
    modelMismatches,
    exactUnchangedContexts,
  });
  const summary: TypedRefutationAnswerSummary = {
    protocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion,
    mode: "typed_refutation_answer_validation",
    phase: "validation",
    status: gate.passed ? "validation_answer_passed" : "validation_answer_failed",
    decision: gate.passed ? "authorize_frozen_test_read" : "reject_D15_and_keep_test_unread",
    generatedAt: new Date().toISOString(),
    inputSha256: hashes,
    evaluationsSha256: sha256(evaluationsText),
    population: {
      totalQuestions: population,
      changedQuestions: selected.length,
      unchangedQuestionsAssignedZeroDeltaWithoutCalls: population - selected.length,
      readers: readers.length,
      judges: judges.length,
    },
    primaryCrossed: {
      improvedReaderPairs: primaryImproved,
      equalReaderPairs: primaryEqual,
      harmedReaderPairs: primaryHarmed,
      changedReaderPairs: changedPairs,
      improvementRate: primaryImproved / changedPairs,
      changedPairMeanDelta: (primaryImproved - primaryHarmed) / changedPairs,
      populationWeightedDelta: primaryPopulationWeightedDelta,
      perReaderChangedMeanDelta,
      readersWithAtLeastOneImprovement: readersWithAtLeastOnePrimaryImprovement,
      readersWithNegativeMeanDelta,
    },
    fullFactorialSensitivity: {
      unanimousImprovedReaderPairs: unanimousImproved,
      unanimousImprovementRate: unanimousImproved / changedPairs,
      anyJudgeHarmedReaderPairs: anyJudgeHarmed,
      populationWeightedDelta: fullFactorialPopulationWeightedDelta,
      judgeAgreementRate: answerCells === 0 ? 0 : agreementCells / answerCells,
    },
    changedRows,
    operationalIntegrity: {
      readerCalls: rows.length,
      judgeCalls: rows.length * judges.length,
      expectedReaderCalls,
      expectedJudgeCalls,
      readerRetries,
      judgeRetries,
      modelMismatches,
    },
    answerGate: gate,
    testState: gate.passed ? "authorized_unread" : "unread",
    claimBoundary: gate.passed
      ? "Fresh validation replicated the answer-level effect; the untouched test remains unread."
      : "D15 failed its frozen fresh-validation answer gate; no test read or answer-quality claim is authorized.",
  };
  await writeFile(path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}
