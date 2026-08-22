import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type {
  LongMemEvalV2PremiseEvidenceBaselineCase,
  LongMemEvalV2PremiseEvidenceBaselineSummary,
} from "./longmemeval-v2-premise-evidence-baseline-runner.js";
import {
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT,
  premiseEvidenceQuestionIdsForPhase,
} from "./longmemeval-v2-premise-evidence-protocol.js";
import type {
  LongMemEvalV2PremiseEvidenceCase,
  LongMemEvalV2PremiseEvidenceSummary,
} from "./longmemeval-v2-premise-evidence-runner.js";
import type { LongMemEvalV2PremiseEvidenceIndependentValidation } from "./longmemeval-v2-premise-evidence-validator.js";
import {
  callDirectJudge,
  isRetryableJudgeError,
  type DirectJudgeResponse,
  type DirectJudgeSpec,
} from "./judge-provider.js";
import type { RetrievedUnit } from "./types.js";

type AnswerArm = "base" | "premise_evidence";

const ABSTENTION_JUDGE_SYSTEM_PROMPT = [
  "You are a strict grader for flawed-premise (abstention) questions.",
  "Judge whether a model answer correctly identifies that the question premise is wrong, consistent with the reference answer.",
  "If the model follows the flawed premise and gives a concrete answer under that premise, it must be graded 0.",
  "If the model's final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0.",
  "If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0.",
  "Paraphrases are allowed when they preserve the same core flaw described by the reference answer.",
].join(" ");

const DOMAIN_SYSTEM_PROMPTS = {
  web: "You are an experienced colleague in a web browsing environment that has a customized magento-based shopping website, a customized magento-based shopping admin cms website, as well as a customized forum website based on reddit/postmill. Answer based on your memory of the environment. If you do not know the answer, output exactly \\boxed{UNKNOWN}. Do not guess. Never attempt to guess an answer if you are not sure. If you believe the question's construction/premise is wrong, provide an explanation in \\boxed{} explaining why the question is flawed.",
  enterprise: "You are an experienced colleague working in a customized ServiceNow environment. Answer based on your memory of the environment. If you do not know the answer, output exactly \\boxed{UNKNOWN}. Do not guess. Never attempt to guess an answer if you are not sure. If you believe the question's construction/premise is wrong, provide an explanation in \\boxed{} explaining why the question is flawed.",
} as const;

export interface LongMemEvalBinaryJudgment {
  response: DirectJudgeResponse;
  label: 0 | 1;
  reason: string;
  attempts: number;
}

export interface LongMemEvalAnswerEvaluation {
  protocolVersion: string;
  questionId: string;
  readerId: string;
  arm: AnswerArm;
  contextSha256: string;
  injectedTokens: number;
  answer: string;
  parsedFinalAnswer: string;
  isUnknown: boolean;
  reader: DirectJudgeResponse;
  readerAttempts: number;
  judges: Record<string, LongMemEvalBinaryJudgment>;
}

interface SelectedAnswerCase {
  question: LongTaskQuestion;
  baseline: LongMemEvalV2PremiseEvidenceBaselineCase;
  candidate: LongMemEvalV2PremiseEvidenceCase;
  arms: Record<AnswerArm, RetrievedUnit[]>;
}

interface AnswerTask {
  arm: AnswerArm;
  reader: DirectJudgeSpec;
  selected: SelectedAnswerCase;
}

export interface PremiseEvidenceAnswerGateInput {
  actualReaderCalls: number;
  actualJudgeCalls: number;
  modelMismatches: number;
  primaryImprovedReaderPairs: number;
  primaryHarmedReaderPairs: number;
  unanimousImprovedReaderPairs: number;
  anyJudgeHarmedReaderPairs: number;
  perReaderPopulationWeightedDelta: Record<string, number>;
  fullFactorialPopulationWeightedDelta: number;
}

export interface PremiseEvidenceAnswerRunOptions {
  dataRoot: string;
  baselineCases: string;
  baselineSummary: string;
  candidateCases: string;
  candidateSummary: string;
  independentValidation: string;
  outputDir: string;
  concurrency?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function asSpec(value: (typeof LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.readers)[number]): DirectJudgeSpec {
  return {
    ...value,
    provider: value.provider as DirectJudgeSpec["provider"],
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function extractLongMemEvalBoxedAnswer(text: string): string {
  const marker = "\\boxed{";
  const start = text.lastIndexOf(marker);
  if (start < 0) return text.trim();
  let cursor = start + marker.length;
  let depth = 1;
  let output = "";
  while (cursor < text.length && depth > 0) {
    const character = text[cursor];
    if (character === "{") {
      depth += 1;
      output += character;
    } else if (character === "}") {
      depth -= 1;
      if (depth > 0) output += character;
    } else output += character;
    cursor += 1;
  }
  return output.trim() || text.trim();
}

export function parseLongMemEvalBinaryJudgment(text: string): { label: 0 | 1; reason: string } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const jsonMatch = /\{[\s\S]*\}/u.exec(cleaned);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { label?: unknown; reason?: unknown };
      if (parsed.label === 0 || parsed.label === 1 || parsed.label === "0" || parsed.label === "1") {
        return { label: Number(parsed.label) as 0 | 1, reason: String(parsed.reason ?? "").trim() };
      }
    } catch {
      // Fall through to the official regex-compatible parser.
    }
  }
  const match = /["']?label["']?\s*[:=]\s*([01])/iu.exec(cleaned);
  if (!match) throw new Error(`could not parse abstention judgment: ${cleaned.slice(0, 200)}`);
  return { label: Number(match[1]) as 0 | 1, reason: cleaned };
}

export function longMemEvalReaderMessages(question: LongTaskQuestion, context: RetrievedUnit[]) {
  if (question.domain !== "web" && question.domain !== "enterprise") {
    throw new Error(`unsupported LongMemEval-V2 answer domain ${question.domain}`);
  }
  const memory = context.length ? context.map((item) => item.content).join("\n") : "(empty)";
  return [
    { role: "system" as const, content: DOMAIN_SYSTEM_PROMPTS[question.domain] },
    {
      role: "user" as const,
      content: `### Memory context:\n${memory}\n\n### Question to answer:\n${question.prompt}`,
    },
  ];
}

export function longMemEvalAbstentionJudgeMessages(
  question: LongTaskQuestion,
  fullResponse: string,
  finalAnswer: string,
) {
  const user = [
    "Evaluate whether the model correctly handled a flawed-premise question.",
    "",
    "Question:",
    question.prompt,
    "",
    "Reference answer (the expected flaw-aware conclusion):",
    question.referenceAnswer,
    "",
    "Model full response:",
    fullResponse,
    "",
    "Model extracted final answer:",
    finalAnswer,
    "",
    "Scoring rubric:",
    "- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion equivalent to the reference answer.",
    "- Label 1 also if the model explicitly says it lacks access to the user's specific live environment/instance/configuration and therefore cannot verify, provided it does not give a concrete premise-following answer.",
    "- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.",
    "- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not make the explicit environment-access limitation clear.",
    "- Label 0 if contradictory.",
    "",
    "Output JSON only:",
    '{"label": 0 or 1, "reason": "short rationale"}',
  ].join("\n");
  return [
    { role: "system" as const, content: ABSTENTION_JUDGE_SYSTEM_PROMPT },
    { role: "user" as const, content: user },
  ];
}

async function withRetries<T>(operation: () => Promise<T>): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;
  const retries = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.retries;
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

async function evaluateTask(params: {
  task: AnswerTask;
  apiKeys: ReadonlyMap<string, string>;
  judges: DirectJudgeSpec[];
}): Promise<LongMemEvalAnswerEvaluation> {
  const context = params.task.selected.arms[params.task.arm];
  const reader = await withRetries(() => callDirectJudge({
    spec: params.task.reader,
    apiKey: params.apiKeys.get(params.task.reader.id)!,
    messages: longMemEvalReaderMessages(params.task.selected.question, context),
    responseFormat: "text",
  }));
  const parsedFinalAnswer = extractLongMemEvalBoxedAnswer(reader.value.content);
  const judges = await Promise.all(params.judges.map(async (spec) => {
    const judged = await withRetries(async () => {
      const response = await callDirectJudge({
        spec,
        apiKey: params.apiKeys.get(spec.id)!,
        messages: longMemEvalAbstentionJudgeMessages(
          params.task.selected.question,
          reader.value.content,
          parsedFinalAnswer,
        ),
        responseFormat: "json",
      });
      return { response, parsed: parseLongMemEvalBinaryJudgment(response.content) };
    });
    return [spec.id, {
      response: judged.value.response,
      label: judged.value.parsed.label,
      reason: judged.value.parsed.reason,
      attempts: judged.attempts,
    }] as const;
  }));
  const source = params.task.arm === "base"
    ? params.task.selected.baseline : params.task.selected.candidate;
  return {
    protocolVersion: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.protocolVersion,
    questionId: params.task.selected.question.id,
    readerId: params.task.reader.id,
    arm: params.task.arm,
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

function evaluationKey(item: Pick<LongMemEvalAnswerEvaluation, "questionId" | "readerId" | "arm">): string {
  return `${item.questionId}\0${item.readerId}\0${item.arm}`;
}

async function loadCompleted(file: string, allowed: ReadonlySet<string>): Promise<LongMemEvalAnswerEvaluation[]> {
  try {
    const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as LongMemEvalAnswerEvaluation);
    if (rows.some((item) => item.protocolVersion
      !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.protocolVersion
      || !allowed.has(evaluationKey(item)))
      || new Set(rows.map(evaluationKey)).size !== rows.length) {
      throw new Error("D14 answer resume artifact identity mismatch");
    }
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function loadSelected(options: PremiseEvidenceAnswerRunOptions) {
  const [baselineCasesText, baselineSummaryText, candidateCasesText, candidateSummaryText,
    validationText] = await Promise.all([
    readFile(options.baselineCases, "utf8"), readFile(options.baselineSummary, "utf8"),
    readFile(options.candidateCases, "utf8"), readFile(options.candidateSummary, "utf8"),
    readFile(options.independentValidation, "utf8"),
  ]);
  const hashes = {
    baselineCases: sha256(baselineCasesText), baselineSummary: sha256(baselineSummaryText),
    candidateCases: sha256(candidateCasesText), candidateSummary: sha256(candidateSummaryText),
    independentValidation: sha256(validationText),
  };
  const baselineCases = baselineCasesText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceBaselineCase);
  const baselineSummary = JSON.parse(baselineSummaryText) as LongMemEvalV2PremiseEvidenceBaselineSummary;
  const candidateCases = candidateCasesText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2PremiseEvidenceCase);
  const candidateSummary = JSON.parse(candidateSummaryText) as LongMemEvalV2PremiseEvidenceSummary;
  const validation = JSON.parse(validationText) as LongMemEvalV2PremiseEvidenceIndependentValidation;
  if (baselineSummary.casesSha256 !== hashes.baselineCases
    || candidateSummary.casesSha256 !== hashes.candidateCases
    || candidateSummary.baselineArtifact.casesSha256 !== hashes.baselineCases
    || candidateSummary.baselineArtifact.summarySha256 !== hashes.baselineSummary
    || candidateSummary.status !== "development_direct_passed"
    || !candidateSummary.gate.passed || candidateSummary.answerLevelState !== "admitted_pending"
    || validation.status !== "passed" || validation.phase !== "development"
    || validation.inputSha256.baselineCases !== hashes.baselineCases
    || validation.inputSha256.baselineSummary !== hashes.baselineSummary
    || validation.inputSha256.candidateCases !== hashes.candidateCases
    || validation.inputSha256.candidateSummary !== hashes.candidateSummary) {
    throw new Error("D14 answer panel requires locked passed direct artifacts");
  }
  const baselineById = new Map(baselineCases.map((item) => [item.questionId, item]));
  const candidateById = new Map(candidateCases.map((item) => [item.questionId, item]));
  const changed = candidateCases.filter((item) => item.contextChanged);
  if (changed.length !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.expectedChangedQuestions
    || changed.some((item) => !item.usedPremiseEvidence || item.label !== "premise")) {
    throw new Error("D14 changed answer population differs from the frozen panel");
  }
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: options.dataRoot,
    revision: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.benchmarkRepositoryRevision,
    tier: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.tier,
    expected: {
      questionsSha256: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.questionsSha256,
      haystackSha256: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.haystackSha256,
      trajectoriesSha256: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.trajectoriesSha256,
      questions: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.questions,
      trajectoryRows: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.trajectoryRows,
      haystackSize: 100,
      selectedTrajectories: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.selectedTrajectories,
    },
  });
  const questions = await adapter.loadQuestions();
  const byId = new Map(questions.map((item) => [item.id, item]));
  const expectedDevelopment = new Set(premiseEvidenceQuestionIdsForPhase("development")
    .map((item) => item.id));
  const selected = changed.map((candidate): SelectedAnswerCase => {
    const baseline = baselineById.get(candidate.questionId);
    const question = byId.get(candidate.questionId);
    if (!baseline || !question || !expectedDevelopment.has(question.id)
      || candidateById.get(question.id) !== candidate
      || baseline.contextSha256 !== candidate.baseContextSha256
      || question.imagePath !== null || !question.evaluator.startsWith("llm_abstention_checker")) {
      throw new Error(`D14 invalid changed answer case ${candidate.questionId}`);
    }
    return {
      question,
      baseline,
      candidate,
      arms: { base: baseline.injected, premise_evidence: candidate.injected },
    };
  }).sort((left, right) => left.question.id.localeCompare(right.question.id));
  return { selected, hashes };
}

export function evaluatePremiseEvidenceAnswerGate(
  input: PremiseEvidenceAnswerGateInput,
): { passed: boolean; checks: Record<string, boolean>; failedChecks: string[] } {
  const protocol = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel;
  const gate = protocol.gate;
  const checks = {
    completeExecution: !gate.requireCompleteExecution
      || (input.actualReaderCalls === protocol.expectedReaderCalls
        && input.actualJudgeCalls === protocol.expectedJudgeCalls),
    primaryImprovement: input.primaryImprovedReaderPairs >= gate.minPrimaryImprovedReaderPairs,
    noPrimaryHarm: input.primaryHarmedReaderPairs <= gate.maxPrimaryHarmedReaderPairs,
    unanimousImprovement: input.unanimousImprovedReaderPairs
      >= gate.minUnanimousImprovedReaderPairs,
    noAnyJudgeHarm: input.anyJudgeHarmedReaderPairs <= gate.maxAnyJudgeHarmedReaderPairs,
    perReaderNonInferiority: Object.values(input.perReaderPopulationWeightedDelta)
      .every((value) => value >= gate.minPerReaderPopulationWeightedDelta),
    fullFactorialNonInferiority: input.fullFactorialPopulationWeightedDelta
      >= gate.minFullFactorialPopulationWeightedDelta,
    returnedModels: !gate.requireZeroModelMismatches || input.modelMismatches === 0,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

export async function runLongMemEvalV2PremiseEvidenceAnswerPanel(
  options: PremiseEvidenceAnswerRunOptions,
): Promise<Record<string, unknown>> {
  const loaded = await loadSelected(options);
  const readers = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.readers.map(asSpec);
  const judges = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.judges.map(asSpec);
  const apiKeys = new Map<string, string>();
  for (const spec of [...readers, ...judges]) {
    const key = process.env[spec.apiKeyEnv];
    if (!key) throw new Error(`${spec.apiKeyEnv} is required for D14 ${spec.id}`);
    apiKeys.set(spec.id, key);
  }
  const tasks = loaded.selected.flatMap((selected) => readers.flatMap((reader) =>
    (["base", "premise_evidence"] as AnswerArm[]).map((arm) => ({ selected, reader, arm }))
  )).sort((left, right) => sha256(`20260823\0${left.selected.question.id}\0${left.reader.id}\0${left.arm}`)
    .localeCompare(sha256(`20260823\0${right.selected.question.id}\0${right.reader.id}\0${right.arm}`)));
  if (tasks.length !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.expectedReaderCalls) {
    throw new Error("D14 answer task count mismatch");
  }
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
    LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.maxConcurrency));
  for (let offset = 0; offset < remaining.length; offset += concurrency) {
    const batch = remaining.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(batch.map((task) => evaluateTask({ task, apiKeys, judges })));
    const successes = settled.filter((item): item is PromiseFulfilledResult<LongMemEvalAnswerEvaluation> =>
      item.status === "fulfilled").map((item) => item.value);
    if (successes.length) {
      await appendFile(actualPath, `${successes.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
      for (const item of successes) completedByKey.set(evaluationKey(item), item);
    }
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failure) throw failure.reason;
    process.stdout.write(`D14 answer actual ${completedByKey.size}/${tasks.length}\n`);
  }
  const rows = tasks.map((task) => completedByKey.get(
    `${task.selected.question.id}\0${task.reader.id}\0${task.arm}`,
  )!);
  await writeFile(path.join(options.outputDir, "evaluations.jsonl"),
    `${rows.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  const rowByKey = new Map(rows.map((item) => [evaluationKey(item), item]));
  let primaryImprovedReaderPairs = 0;
  let primaryEqualReaderPairs = 0;
  let primaryHarmedReaderPairs = 0;
  let unanimousImprovedReaderPairs = 0;
  let anyJudgeHarmedReaderPairs = 0;
  let judgeAgreementCells = 0;
  let answerCells = 0;
  const population = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.population.development.total;
  const perReaderSum = Object.fromEntries(readers.map((reader) => [reader.id, 0]));
  let fullFactorialDeltaSum = 0;
  const changedRows: Array<Record<string, unknown>> = [];
  for (const selected of loaded.selected) {
    for (const reader of readers) {
      const base = rowByKey.get(`${selected.question.id}\0${reader.id}\0base`)!;
      const candidate = rowByKey.get(`${selected.question.id}\0${reader.id}\0premise_evidence`)!;
      const crossJudge = judges.find((judge) => judge.id !== reader.id)!;
      const basePrimary = base.judges[crossJudge.id].label;
      const candidatePrimary = candidate.judges[crossJudge.id].label;
      const primaryDelta = candidatePrimary - basePrimary;
      primaryImprovedReaderPairs += Number(primaryDelta > 0);
      primaryEqualReaderPairs += Number(primaryDelta === 0);
      primaryHarmedReaderPairs += Number(primaryDelta < 0);
      perReaderSum[reader.id] += primaryDelta;
      const judgeDeltas = judges.map((judge) =>
        candidate.judges[judge.id].label - base.judges[judge.id].label);
      unanimousImprovedReaderPairs += Number(judgeDeltas.every((value) => value > 0));
      anyJudgeHarmedReaderPairs += Number(judgeDeltas.some((value) => value < 0));
      fullFactorialDeltaSum += judgeDeltas.reduce((sum, value) => sum + value, 0);
      for (const arm of [base, candidate]) {
        const labels = judges.map((judge) => arm.judges[judge.id].label);
        judgeAgreementCells += Number(new Set(labels).size === 1);
        answerCells += 1;
      }
      changedRows.push({
        questionId: selected.question.id,
        readerId: reader.id,
        crossJudgeId: crossJudge.id,
        basePrimary,
        candidatePrimary,
        primaryDelta,
        judgeDeltas: Object.fromEntries(judges.map((judge, index) => [judge.id, judgeDeltas[index]])),
      });
    }
  }
  const perReaderPopulationWeightedDelta = Object.fromEntries(readers.map((reader) => [
    reader.id, perReaderSum[reader.id] / population,
  ]));
  const primaryPopulationWeightedDelta = (primaryImprovedReaderPairs - primaryHarmedReaderPairs)
    / (population * readers.length);
  const fullFactorialPopulationWeightedDelta = fullFactorialDeltaSum
    / (population * readers.length * judges.length);
  let modelMismatches = 0;
  let readerRetries = 0;
  let judgeRetries = 0;
  for (const row of rows) {
    readerRetries += row.readerAttempts - 1;
    const reader = readers.find((item) => item.id === row.readerId)!;
    modelMismatches += Number(row.reader.model !== reader.model);
    for (const judge of judges) {
      judgeRetries += row.judges[judge.id].attempts - 1;
      modelMismatches += Number(row.judges[judge.id].response.model !== judge.model);
    }
  }
  const gate = evaluatePremiseEvidenceAnswerGate({
    actualReaderCalls: rows.length,
    actualJudgeCalls: rows.length * judges.length,
    modelMismatches,
    primaryImprovedReaderPairs,
    primaryHarmedReaderPairs,
    unanimousImprovedReaderPairs,
    anyJudgeHarmedReaderPairs,
    perReaderPopulationWeightedDelta,
    fullFactorialPopulationWeightedDelta,
  });
  const report = {
    protocolVersion: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.protocolVersion,
    phase: "development",
    status: gate.passed ? "development_answer_passed" : "development_answer_failed",
    nextAction: gate.passed ? "authorize_development_admission_then_read_validation"
      : "reject_D14_and_keep_validation_unread",
    generatedAt: new Date().toISOString(),
    inputSha256: loaded.hashes,
    population: {
      totalQuestions: population,
      changedQuestions: loaded.selected.length,
      unchangedQuestionsAssignedZeroDeltaWithoutCalls: population - loaded.selected.length,
      readers: readers.length,
      judges: judges.length,
    },
    primaryCrossed: {
      improvedReaderPairs: primaryImprovedReaderPairs,
      equalReaderPairs: primaryEqualReaderPairs,
      harmedReaderPairs: primaryHarmedReaderPairs,
      changedReaderPairs: loaded.selected.length * readers.length,
      changedPairMeanDelta: (primaryImprovedReaderPairs - primaryHarmedReaderPairs)
        / (loaded.selected.length * readers.length),
      populationWeightedDelta: primaryPopulationWeightedDelta,
      perReaderPopulationWeightedDelta,
    },
    fullFactorialSensitivity: {
      unanimousImprovedReaderPairs,
      anyJudgeHarmedReaderPairs,
      populationWeightedDelta: fullFactorialPopulationWeightedDelta,
      judgeAgreementRate: answerCells === 0 ? 0 : judgeAgreementCells / answerCells,
    },
    changedRows,
    operationalIntegrity: {
      readerCalls: rows.length,
      judgeCalls: rows.length * judges.length,
      readerRetries,
      judgeRetries,
      modelMismatches,
      expectedReaderCalls: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.expectedReaderCalls,
      expectedJudgeCalls: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.answerLevelPanel.expectedJudgeCalls,
    },
    answerGate: gate,
    caveats: [
      "Only two development questions changed, so this is a causal smoke test with high precision but very low coverage and no narrow confidence interval.",
      "Unchanged contexts contribute an exact paired delta of zero; no reader output is generated for those cells.",
      "The primary crossed panel reduces self-judging but uses only the two user-specified model families.",
      "The official LongMemEval-V2 prompt and grading rubric are retained, but the requested judges replace the official default judge, so this is not a leaderboard score.",
      "A development pass permits validation; it does not establish programming-agent effectiveness.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
