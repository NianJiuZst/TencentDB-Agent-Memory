import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  evaluateTypedRefutationAnswerGate,
  type TypedRefutationAnswerEvaluation,
  type TypedRefutationAnswerSummary,
} from "./longmemeval-v2-typed-refutation-answer-runner.js";
import type { TypedRefutationValidationCase }
  from "./longmemeval-v2-typed-refutation-validation-runner.js";
import type { TypedRefutationIndependentValidation }
  from "./longmemeval-v2-typed-refutation-validation-validator.js";
import { LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL }
  from "./longmemeval-v2-typed-refutation-validation-protocol.js";

interface AnswerValidationMismatches {
  inputIdentity: number;
  rowIdentity: number;
  contextIdentity: number;
  returnedModels: number;
  summaryMetrics: number;
  gateReplay: number;
}

export interface TypedRefutationAnswerIndependentValidation {
  validationVersion: "lifecycle-longmemeval-v2-typed-refutation-answer-independent-validation-v1.0";
  sourceProtocolVersion: string;
  phase: "validation";
  status: "passed" | "failed";
  validatorCommit: string;
  inputSha256: {
    directCases: string;
    directSummary: string;
    directIndependentValidation: string;
    evaluations: string;
    answerSummary: string;
  };
  rows: number;
  changedQuestions: number;
  mismatches: AnswerValidationMismatches;
  checks: Record<string, boolean>;
  failedChecks: string[];
  decision: "authorize_frozen_test_read" | "reject_D15_and_keep_test_unread";
  testState: "authorized_unread" | "unread";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function approx(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function key(item: Pick<TypedRefutationAnswerEvaluation,
  "questionId" | "readerId" | "arm">): string {
  return `${item.questionId}\0${item.readerId}\0${item.arm}`;
}

export async function validateTypedRefutationAnswerValidation(params: {
  validatorCommit: string;
  directCasesPath: string;
  directSummaryPath: string;
  directIndependentValidationPath: string;
  evaluationsPath: string;
  answerSummaryPath: string;
}): Promise<TypedRefutationAnswerIndependentValidation> {
  if (!/^[0-9a-f]{7,40}$/u.test(params.validatorCommit)) {
    throw new Error("D15 answer validatorCommit must be a git SHA");
  }
  const texts = await Promise.all([
    readFile(params.directCasesPath, "utf8"), readFile(params.directSummaryPath, "utf8"),
    readFile(params.directIndependentValidationPath, "utf8"), readFile(params.evaluationsPath, "utf8"),
    readFile(params.answerSummaryPath, "utf8"),
  ]);
  const inputSha256 = {
    directCases: sha256(texts[0]), directSummary: sha256(texts[1]),
    directIndependentValidation: sha256(texts[2]), evaluations: sha256(texts[3]),
    answerSummary: sha256(texts[4]),
  };
  const direct = texts[0].split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as TypedRefutationValidationCase);
  const directValidation = JSON.parse(texts[2]) as TypedRefutationIndependentValidation;
  const rows = texts[3].split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as TypedRefutationAnswerEvaluation);
  const summary = JSON.parse(texts[4]) as TypedRefutationAnswerSummary;
  const changed = direct.filter((item) => item.contextChanged);
  const unchanged = direct.filter((item) => !item.contextChanged);
  const readers = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.readers;
  const judges = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.answerPanel.judges;
  const allowed = new Set(changed.flatMap((item) => readers.flatMap((reader) =>
    ["base", "typed_action_contract"].map((arm) => `${item.questionId}\0${reader.id}\0${arm}`))));
  const byKey = new Map(rows.map((item) => [key(item), item]));
  const mismatches: AnswerValidationMismatches = {
    inputIdentity: 0, rowIdentity: 0, contextIdentity: 0, returnedModels: 0,
    summaryMetrics: 0, gateReplay: 0,
  };
  mismatches.inputIdentity += Number(
    summary.protocolVersion !== LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion
      || summary.evaluationsSha256 !== inputSha256.evaluations
      || summary.inputSha256.directCases !== inputSha256.directCases
      || summary.inputSha256.directSummary !== inputSha256.directSummary
      || summary.inputSha256.independentValidation !== inputSha256.directIndependentValidation
      || directValidation.status !== "passed" || directValidation.answerLevelState !== "admitted_pending",
  );
  mismatches.rowIdentity += Number(byKey.size !== allowed.size || rows.length !== allowed.size
    || [...byKey.keys()].some((item) => !allowed.has(item))
    || rows.some((item) => item.protocolVersion
      !== LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion
      || item.phase !== "validation"));
  const directById = new Map(direct.map((item) => [item.questionId, item]));
  for (const row of rows) {
    const item = directById.get(row.questionId);
    if (!item) {
      mismatches.contextIdentity += 1;
      continue;
    }
    const expectedContext = row.arm === "base" ? item.baseContextSha256 : item.contextSha256;
    const expectedTokens = row.arm === "base" ? item.baseInjectedTokens : item.injectedTokens;
    mismatches.contextIdentity += Number(row.contextSha256 !== expectedContext
      || row.injectedTokens !== expectedTokens);
    const reader = readers.find((spec) => spec.id === row.readerId);
    mismatches.returnedModels += Number(!reader || row.reader.model !== reader.model);
    for (const judge of judges) {
      mismatches.returnedModels += Number(!row.judges[judge.id]
        || row.judges[judge.id].response.model !== judge.model
        || (row.judges[judge.id].label !== 0 && row.judges[judge.id].label !== 1));
    }
  }
  let primaryImproved = 0;
  let primaryEqual = 0;
  let primaryHarmed = 0;
  let unanimousImproved = 0;
  let anyJudgeHarmed = 0;
  let fullDelta = 0;
  let agreementCells = 0;
  let answerCells = 0;
  const perReader = Object.fromEntries(readers.map((reader) => [reader.id, [] as number[]]));
  for (const item of changed) {
    for (const reader of readers) {
      const base = byKey.get(`${item.questionId}\0${reader.id}\0base`);
      const candidate = byKey.get(`${item.questionId}\0${reader.id}\0typed_action_contract`);
      if (!base || !candidate) continue;
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
    }
  }
  const population = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL
    .dataBoundary.validationTotalQuestions;
  const changedPairs = changed.length * readers.length;
  const readersWithAtLeastOnePrimaryImprovement = Object.values(perReader)
    .filter((values) => values.some((value) => value > 0)).length;
  const readersWithNegativeMeanDelta = Object.values(perReader)
    .filter((values) => values.length > 0
      && values.reduce((sum, value) => sum + value, 0) / values.length < 0).length;
  const primaryPopulationWeightedDelta = (primaryImproved - primaryHarmed)
    / (population * readers.length);
  const fullFactorialPopulationWeightedDelta = fullDelta
    / (population * readers.length * judges.length);
  let modelMismatches = 0;
  let readerRetries = 0;
  let judgeRetries = 0;
  for (const row of rows) {
    readerRetries += row.readerAttempts - 1;
    const reader = readers.find((item) => item.id === row.readerId);
    modelMismatches += Number(!reader || row.reader.model !== reader.model);
    for (const judge of judges) {
      judgeRetries += (row.judges[judge.id]?.attempts ?? 1) - 1;
      modelMismatches += Number(row.judges[judge.id]?.response.model !== judge.model);
    }
  }
  const exactUnchangedContexts = unchanged.every((item) => !item.usedTypedRefutation
    && !item.fallback && item.contextSha256 === item.baseContextSha256);
  const expectedReaderCalls = changedPairs * 2;
  const expectedJudgeCalls = expectedReaderCalls * judges.length;
  const gate = evaluateTypedRefutationAnswerGate({
    changedQuestions: changed.length,
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
  mismatches.summaryMetrics += Number(
    summary.population.changedQuestions !== changed.length
      || summary.population.unchangedQuestionsAssignedZeroDeltaWithoutCalls !== population - changed.length
      || summary.primaryCrossed.improvedReaderPairs !== primaryImproved
      || summary.primaryCrossed.equalReaderPairs !== primaryEqual
      || summary.primaryCrossed.harmedReaderPairs !== primaryHarmed
      || summary.primaryCrossed.changedReaderPairs !== changedPairs
      || !approx(summary.primaryCrossed.populationWeightedDelta, primaryPopulationWeightedDelta)
      || summary.primaryCrossed.readersWithAtLeastOneImprovement
        !== readersWithAtLeastOnePrimaryImprovement
      || summary.primaryCrossed.readersWithNegativeMeanDelta !== readersWithNegativeMeanDelta
      || summary.fullFactorialSensitivity.unanimousImprovedReaderPairs !== unanimousImproved
      || summary.fullFactorialSensitivity.anyJudgeHarmedReaderPairs !== anyJudgeHarmed
      || !approx(summary.fullFactorialSensitivity.populationWeightedDelta,
        fullFactorialPopulationWeightedDelta)
      || !approx(summary.fullFactorialSensitivity.judgeAgreementRate,
        answerCells === 0 ? 0 : agreementCells / answerCells)
      || summary.operationalIntegrity.readerCalls !== rows.length
      || summary.operationalIntegrity.judgeCalls !== rows.length * judges.length
      || summary.operationalIntegrity.readerRetries !== readerRetries
      || summary.operationalIntegrity.judgeRetries !== judgeRetries
      || summary.operationalIntegrity.modelMismatches !== modelMismatches,
  );
  mismatches.gateReplay += Number(summary.answerGate.passed !== gate.passed
    || JSON.stringify(summary.answerGate.failedChecks) !== JSON.stringify(gate.failedChecks)
    || summary.status !== (gate.passed ? "validation_answer_passed" : "validation_answer_failed"));
  const checks = Object.fromEntries(Object.entries(mismatches).map(([name, count]) =>
    [name, count === 0]));
  checks.runnerGatePassed = summary.answerGate.passed;
  checks.replayGatePassed = gate.passed;
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const passed = failedChecks.length === 0;
  return {
    validationVersion: "lifecycle-longmemeval-v2-typed-refutation-answer-independent-validation-v1.0",
    sourceProtocolVersion: LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL.protocolVersion,
    phase: "validation",
    status: passed ? "passed" : "failed",
    validatorCommit: params.validatorCommit,
    inputSha256,
    rows: rows.length,
    changedQuestions: changed.length,
    mismatches,
    checks,
    failedChecks,
    decision: passed ? "authorize_frozen_test_read" : "reject_D15_and_keep_test_unread",
    testState: passed ? "authorized_unread" : "unread",
  };
}
