import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";
import {
  judgeMessages,
  parseJudge,
  readerMessages,
  scoreAnswer,
  type CriterionVerdict,
} from "./e2e-runner.js";
import {
  callDirectJudge,
  isRetryableJudgeError,
  type DirectJudgeResponse,
  type DirectJudgeSpec,
} from "./judge-provider.js";
import type { BootstrapInterval, EvaluationCriterion, LifecycleEvalQuestion, RetrievedUnit } from "./types.js";
import { VALID_STATE_PACKING_E2E_PROTOCOL } from "./valid-state-packing-e2e-protocol.js";

type Arm = "v1" | "valid_state_packing";
type AnswerMetrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof AnswerMetrics;

interface FrozenSelection {
  protocolVersion: string;
  selected: Array<{
    caseId: string;
    groupId: string;
    persona: string;
    period: string;
    task: string;
    v1CandidateIds: string[];
    validStatePackingCandidateIds: string[];
  }>;
}

interface ContextManifest {
  protocolVersion: string;
  selectionSha256: string;
  datasetRevision: string;
  cases: Array<{
    caseId: string;
    groupId: string;
    arms: Record<Arm, RetrievedUnit[]>;
  }>;
}

interface SelectedCase {
  question: LifecycleEvalQuestion;
  arms: Record<Arm, RetrievedUnit[]>;
  unchanged: boolean;
}

interface JudgeEvaluation {
  response: DirectJudgeResponse;
  verdicts: CriterionVerdict[];
  metrics: AnswerMetrics;
  attempts: number;
}

interface SharedNoop {
  sourceArm: "v1";
  sourceKey: string;
}

interface ArmEvaluation {
  protocolVersion: string;
  caseId: string;
  groupId: string;
  persona: string;
  period: string;
  task: string;
  readerId: string;
  arm: Arm;
  candidateIds: string[];
  injectedTokens: number;
  answer: string;
  reader: DirectJudgeResponse;
  readerAttempts: number;
  judges: Record<string, JudgeEvaluation>;
  sharedNoop?: SharedNoop;
}

interface PanelArm {
  primary: AnswerMetrics;
  fullFactorial: AnswerMetrics;
  injectedTokens: number;
  cells: Record<string, AnswerMetrics>;
}

interface PanelCase {
  caseId: string;
  persona: string;
  task: string;
  unchanged: boolean;
  arms: Record<Arm, PanelArm>;
}

interface ActualTask {
  arm: Arm;
  reader: DirectJudgeSpec;
  selected: SelectedCase;
}

export interface ValidStatePackingE2ERunOptions {
  concurrency?: number;
  contextManifest: string;
  dataRoot: string;
  excludedSelection: string;
  outputDir: string;
  proxyCases: string;
  proxySummary: string;
  proxyValidation: string;
  selection: string;
  skipHashVerification?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function meanMetrics(metrics: AnswerMetrics[]): AnswerMetrics {
  return {
    mpa: mean(metrics.map((item) => item.mpa)),
    faa: mean(metrics.map((item) => item.faa)),
    fama: mean(metrics.map((item) => item.fama)),
    criterionAccuracy: mean(metrics.map((item) => item.criterionAccuracy)),
  };
}

function sameCandidates(left: RetrievedUnit[], right: RetrievedUnit[]): boolean {
  return JSON.stringify(left.map((item) => ({
    id: item.id,
    content: item.content,
    tokenCount: item.tokenCount,
  }))) === JSON.stringify(right.map((item) => ({
    id: item.id,
    content: item.content,
    tokenCount: item.tokenCount,
  })));
}

function crossModelMean(cells: Array<{
  readerId: string;
  judgeId: string;
  metrics: AnswerMetrics;
}>): AnswerMetrics {
  const cross = cells.filter((cell) => cell.readerId !== cell.judgeId);
  if (cross.length !== 2 || new Set(cross.map((cell) => cell.readerId)).size !== 2) {
    throw new Error("valid-state packing primary requires one crossed judgment per reader");
  }
  return meanMetrics(cross.map((cell) => cell.metrics));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callReader(params: {
  apiKey: string;
  candidates: RetrievedUnit[];
  question: LifecycleEvalQuestion;
  spec: DirectJudgeSpec;
}): Promise<{ response: DirectJudgeResponse; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= VALID_STATE_PACKING_E2E_PROTOCOL.execution.retries; attempt += 1) {
    try {
      return {
        response: await callDirectJudge({
          spec: params.spec,
          apiKey: params.apiKey,
          messages: readerMessages(params.question, params.candidates),
          responseFormat: "text",
        }),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableJudgeError(error)) throw error;
    }
    if (attempt < VALID_STATE_PACKING_E2E_PROTOCOL.execution.retries) {
      await delay(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callJudge(params: {
  answer: string;
  apiKey: string;
  criteria: EvaluationCriterion[];
  spec: DirectJudgeSpec;
}): Promise<JudgeEvaluation> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= VALID_STATE_PACKING_E2E_PROTOCOL.execution.retries; attempt += 1) {
    try {
      const response = await callDirectJudge({
        spec: params.spec,
        apiKey: params.apiKey,
        messages: judgeMessages(params.answer, params.criteria),
        responseFormat: "json",
      });
      try {
        const verdicts = parseJudge(response.content, params.criteria);
        return { response, verdicts, metrics: scoreAnswer(verdicts), attempts: attempt };
      } catch (error) {
        lastError = error;
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableJudgeError(error)) throw error;
    }
    if (attempt < VALID_STATE_PACKING_E2E_PROTOCOL.execution.retries) {
      await delay(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function evaluationKey(item: Pick<ArmEvaluation, "arm" | "caseId" | "readerId">): string {
  return `${item.caseId}\0${item.readerId}\0${item.arm}`;
}

async function loadSelected(options: ValidStatePackingE2ERunOptions) {
  const [
    selectionText,
    manifestText,
    proxyCasesText,
    proxySummaryText,
    proxyValidationText,
    excludedText,
    loaded,
  ] = await Promise.all([
    readFile(options.selection, "utf8"),
    readFile(options.contextManifest, "utf8"),
    readFile(options.proxyCases, "utf8"),
    readFile(options.proxySummary, "utf8"),
    readFile(options.proxyValidation, "utf8"),
    readFile(options.excludedSelection, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const hashes = {
    selection: sha256(selectionText),
    contextManifest: sha256(manifestText),
    proxyCases: sha256(proxyCasesText),
    proxySummary: sha256(proxySummaryText),
    proxyValidation: sha256(proxyValidationText),
    excludedSelection: sha256(excludedText),
  };
  const expected = VALID_STATE_PACKING_E2E_PROTOCOL.inputs;
  if (hashes.selection !== expected.selection.sha256
    || hashes.contextManifest !== expected.contextManifest.sha256
    || hashes.proxyCases !== expected.proxyRun.casesSha256
    || hashes.proxySummary !== expected.proxyRun.summarySha256
    || hashes.proxyValidation !== expected.proxyRun.validationSha256
    || hashes.excludedSelection !== expected.excludedPriorSelectionSha256) {
    throw new Error("valid-state packing answer input hash mismatch");
  }
  const proxySummary = JSON.parse(proxySummaryText);
  const proxyValidation = JSON.parse(proxyValidationText);
  if (proxySummary.status !== expected.proxyRun.requiredStatus
    || proxyValidation.status !== expected.proxyRun.requiredStatus) {
    throw new Error("valid-state packing answer requires a passed proxy and validation");
  }
  if (loaded.description.revision !== VALID_STATE_PACKING_E2E_PROTOCOL.dataset.revision
    || loaded.description.dataManifestSha256
      !== VALID_STATE_PACKING_E2E_PROTOCOL.dataset.dataManifestSha256) {
    throw new Error("valid-state packing answer dataset mismatch");
  }
  const selection = JSON.parse(selectionText) as FrozenSelection;
  const manifest = JSON.parse(manifestText) as ContextManifest;
  if (selection.protocolVersion !== VALID_STATE_PACKING_E2E_PROTOCOL.selectionProtocolVersion
    || manifest.protocolVersion !== VALID_STATE_PACKING_E2E_PROTOCOL.selectionProtocolVersion
    || manifest.selectionSha256 !== hashes.selection
    || manifest.datasetRevision !== loaded.description.revision) {
    throw new Error("valid-state packing answer selection provenance mismatch");
  }
  if (selection.selected.length !== expected.selection.cases
    || manifest.cases.length !== expected.selection.cases) {
    throw new Error("valid-state packing answer case count mismatch");
  }
  const excluded = new Set<string>(JSON.parse(excludedText).selected
    .map((item: Record<string, any>) => item.caseId));
  if (selection.selected.some((item) => excluded.has(item.caseId))) {
    throw new Error("valid-state packing answer selection overlaps the prior panel");
  }
  const manifestById = new Map(manifest.cases.map((item) => [item.caseId, item]));
  const groups = new Map(loaded.groups.map((group) => [group.id, group]));
  const selected = selection.selected.map((entry): SelectedCase => {
    const group = groups.get(entry.groupId);
    const question = group?.questions.find((item) => item.id === entry.caseId);
    const context = manifestById.get(entry.caseId);
    if (!question || !context || context.groupId !== entry.groupId) {
      throw new Error(`missing valid-state packing answer case ${entry.caseId}`);
    }
    if (context.arms.v1.map((item) => item.id).join("\0")
      !== entry.v1CandidateIds.join("\0")
      || context.arms.valid_state_packing.map((item) => item.id).join("\0")
        !== entry.validStatePackingCandidateIds.join("\0")) {
      throw new Error(`valid-state packing answer candidate mismatch ${entry.caseId}`);
    }
    return {
      question,
      arms: context.arms,
      unchanged: sameCandidates(context.arms.v1, context.arms.valid_state_packing),
    };
  });
  const changed = selected.filter((item) => !item.unchanged).length;
  if (changed !== expected.contextManifest.changedCases
    || selected.length - changed !== expected.contextManifest.unchangedCases) {
    throw new Error("valid-state packing answer changed-case count mismatch");
  }
  return { dataset: loaded.description, hashes, selected };
}

async function loadActual(file: string): Promise<ArmEvaluation[]> {
  try {
    const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as ArmEvaluation);
    if (rows.some((item) => item.protocolVersion
      !== VALID_STATE_PACKING_E2E_PROTOCOL.protocolVersion || item.sharedNoop)) {
      throw new Error("valid-state packing actual output contains incompatible rows");
    }
    if (new Set(rows.map(evaluationKey)).size !== rows.length) {
      throw new Error("valid-state packing actual output contains duplicate rows");
    }
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function evaluateActual(params: {
  apiKeys: Map<string, string>;
  task: ActualTask;
}): Promise<ArmEvaluation> {
  const candidates = params.task.selected.arms[params.task.arm];
  const readerCall = await callReader({
    spec: params.task.reader,
    apiKey: params.apiKeys.get(params.task.reader.id)!,
    candidates,
    question: params.task.selected.question,
  });
  const judges = await Promise.all(VALID_STATE_PACKING_E2E_PROTOCOL.judges.map(async (spec) => [
    spec.id,
    await callJudge({
      spec,
      apiKey: params.apiKeys.get(spec.id)!,
      answer: readerCall.response.content,
      criteria: params.task.selected.question.evaluationQuestions,
    }),
  ] as const));
  return {
    protocolVersion: VALID_STATE_PACKING_E2E_PROTOCOL.protocolVersion,
    caseId: params.task.selected.question.id,
    groupId: params.task.selected.question.groupId,
    persona: params.task.selected.question.persona,
    period: params.task.selected.question.period,
    task: params.task.selected.question.task,
    readerId: params.task.reader.id,
    arm: params.task.arm,
    candidateIds: candidates.map((item) => item.id),
    injectedTokens: candidates.reduce((sum, item) => sum + item.tokenCount, 0),
    answer: readerCall.response.content,
    reader: readerCall.response,
    readerAttempts: readerCall.attempts,
    judges: Object.fromEntries(judges),
  };
}

function cloneNoop(v1: ArmEvaluation): ArmEvaluation {
  return {
    ...v1,
    arm: "valid_state_packing",
    sharedNoop: {
      sourceArm: "v1",
      sourceKey: evaluationKey(v1),
    },
  };
}

function buildPanelCases(selected: SelectedCase[], rows: ArmEvaluation[]): PanelCase[] {
  const byKey = new Map(rows.map((item) => [evaluationKey(item), item]));
  return selected.map((item): PanelCase => ({
    caseId: item.question.id,
    persona: item.question.persona,
    task: item.question.task,
    unchanged: item.unchanged,
    arms: Object.fromEntries(VALID_STATE_PACKING_E2E_PROTOCOL.arms.map((arm): [Arm, PanelArm] => {
      const evaluations = VALID_STATE_PACKING_E2E_PROTOCOL.readers.map((reader) => {
        const evaluation = byKey.get(`${item.question.id}\0${reader.id}\0${arm}`);
        if (!evaluation) throw new Error(`missing packing panel cell ${item.question.id}/${reader.id}/${arm}`);
        return evaluation;
      });
      const cells = evaluations.flatMap((evaluation) =>
        VALID_STATE_PACKING_E2E_PROTOCOL.judges.map((judge) => ({
          readerId: evaluation.readerId,
          judgeId: judge.id,
          metrics: evaluation.judges[judge.id].metrics,
        }))
      );
      const tokenCounts = new Set(evaluations.map((evaluation) => evaluation.injectedTokens));
      if (tokenCounts.size !== 1) throw new Error("packing answer reader token mismatch");
      return [arm, {
        primary: crossModelMean(cells),
        fullFactorial: meanMetrics(cells.map((cell) => cell.metrics)),
        injectedTokens: evaluations[0].injectedTokens,
        cells: Object.fromEntries(cells.map((cell) => [
          `${cell.readerId}->${cell.judgeId}`,
          cell.metrics,
        ])),
      }];
    })) as Record<Arm, PanelArm>,
  }));
}

function aggregateArm(cases: PanelCase[], arm: Arm, mode: "primary" | "fullFactorial") {
  return {
    cases: cases.length,
    ...meanMetrics(cases.map((item) => item.arms[arm][mode])),
    meanInjectedTokens: mean(cases.map((item) => item.arms[arm].injectedTokens)),
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

function bootstrap(params: {
  cases: PanelCase[];
  metric: Metric;
  mode: "primary" | "fullFactorial";
  seed: number;
}): BootstrapInterval {
  const byPersona = new Map<string, PanelCase[]>();
  for (const item of params.cases) {
    const selected = byPersona.get(item.persona) ?? [];
    selected.push(item);
    byPersona.set(item.persona, selected);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: PanelCase) =>
    item.arms.valid_state_packing[params.mode][params.metric]
      - item.arms.v1[params.mode][params.metric];
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < VALID_STATE_PACKING_E2E_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const selected: PanelCase[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    draws.push(mean(selected.map(delta)));
  }
  draws.sort((left, right) => left - right);
  return {
    mean: mean(params.cases.map(delta)),
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}

function comparison(cases: PanelCase[], mode: "primary" | "fullFactorial", offset: number) {
  return Object.fromEntries(([
    "mpa",
    "faa",
    "fama",
    "criterionAccuracy",
  ] as Metric[]).map((metric, index) => [
    metric,
    bootstrap({
      cases,
      metric,
      mode,
      seed: VALID_STATE_PACKING_E2E_PROTOCOL.seed + offset + index,
    }),
  ])) as Record<Metric, BootstrapInterval>;
}

function perReaderFama(cases: PanelCase[]) {
  return Object.fromEntries(VALID_STATE_PACKING_E2E_PROTOCOL.readers.map((reader) => {
    const judge = VALID_STATE_PACKING_E2E_PROTOCOL.judges.find((item) => item.id !== reader.id)!;
    const key = `${reader.id}->${judge.id}`;
    return [reader.id, mean(cases.map((item) =>
      item.arms.valid_state_packing.cells[key].fama - item.arms.v1.cells[key].fama
    ))];
  }));
}

function integrity(actual: ArmEvaluation[]) {
  let readerRetries = 0;
  let judgeRetries = 0;
  let readerModelMismatches = 0;
  let judgeModelMismatches = 0;
  let unclearVerdicts = 0;
  for (const item of actual) {
    readerRetries += item.readerAttempts - 1;
    const reader = VALID_STATE_PACKING_E2E_PROTOCOL.readers.find((spec) => spec.id === item.readerId)!;
    readerModelMismatches += Number(item.reader.model !== reader.model);
    for (const judge of VALID_STATE_PACKING_E2E_PROTOCOL.judges) {
      const result = item.judges[judge.id];
      judgeRetries += result.attempts - 1;
      judgeModelMismatches += Number(result.response.model !== judge.model);
      unclearVerdicts += result.verdicts.filter((verdict) => verdict.answer === "unclear").length;
    }
  }
  return {
    readerCalls: actual.length,
    judgeCalls: actual.length * VALID_STATE_PACKING_E2E_PROTOCOL.judges.length,
    readerRetries,
    judgeRetries,
    readerModelMismatches,
    judgeModelMismatches,
    unclearVerdicts,
  };
}

function noopIntegrity(rows: ArmEvaluation[], selected: SelectedCase[]) {
  const byKey = new Map(rows.map((item) => [evaluationKey(item), item]));
  let clones = 0;
  let mismatches = 0;
  for (const item of selected.filter((entry) => entry.unchanged)) {
    for (const reader of VALID_STATE_PACKING_E2E_PROTOCOL.readers) {
      const v1 = byKey.get(`${item.question.id}\0${reader.id}\0v1`)!;
      const candidate = byKey.get(`${item.question.id}\0${reader.id}\0valid_state_packing`)!;
      clones += 1;
      mismatches += Number(!candidate.sharedNoop
        || candidate.sharedNoop.sourceKey !== evaluationKey(v1)
        || candidate.answer !== v1.answer
        || candidate.readerAttempts !== v1.readerAttempts
        || candidate.injectedTokens !== v1.injectedTokens
        || candidate.candidateIds.join("\0") !== v1.candidateIds.join("\0")
        || JSON.stringify(candidate.reader) !== JSON.stringify(v1.reader)
        || JSON.stringify(candidate.judges) !== JSON.stringify(v1.judges));
    }
  }
  return { clones, mismatches };
}

export function evaluateValidStatePackingAnswerGate(params: {
  callCounts: { reader: number; judge: number; finalRows: number };
  comparison: Record<Metric, BootstrapInterval>;
  modelMismatches: number;
  noopClones: number;
  noopMismatches: number;
  perReaderFamaDelta: Record<string, number>;
  tokens: { v1: number; candidate: number };
}) {
  const gate = VALID_STATE_PACKING_E2E_PROTOCOL.answerGate;
  const expectedNoopClones = VALID_STATE_PACKING_E2E_PROTOCOL.inputs.contextManifest.unchangedCases
    * VALID_STATE_PACKING_E2E_PROTOCOL.readers.length;
  const checks = {
    completeExecution: params.callCounts.reader
      === VALID_STATE_PACKING_E2E_PROTOCOL.execution.expectedReaderCalls
      && params.callCounts.judge
        === VALID_STATE_PACKING_E2E_PROTOCOL.execution.expectedJudgeCalls
      && params.callCounts.finalRows
        === VALID_STATE_PACKING_E2E_PROTOCOL.execution.expectedArmRows,
    famaDirection: !gate.requirePositiveFamaDelta || params.comparison.fama.mean > 0,
    famaUncertainty: params.comparison.fama.lower >= gate.minFamaPersonaBootstrapLower,
    mpaDirection: !gate.requirePositiveMpaDelta || params.comparison.mpa.mean > 0,
    faaNonInferiority: params.comparison.faa.mean >= gate.minFaaDelta,
    criterionAccuracyDirection: !gate.requireNonnegativeCriterionAccuracyDelta
      || params.comparison.criterionAccuracy.mean >= 0,
    perReaderFamaDirection: !gate.requireNonnegativeFamaDirectionForEachReader
      || Object.values(params.perReaderFamaDelta).every((value) => value >= 0),
    tokenBudget: params.tokens.candidate <= params.tokens.v1
      * (1 + gate.maxMeanInjectedTokenIncreaseFraction),
    exactNoopClones: !gate.requireExactNoopClones
      || (params.noopMismatches === 0 && params.noopClones === expectedNoopClones),
    returnedModels: !gate.requireZeroModelMismatches || params.modelMismatches === 0,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

export async function runValidStatePackingE2E(
  options: ValidStatePackingE2ERunOptions,
): Promise<Record<string, unknown>> {
  const loaded = await loadSelected(options);
  const apiKeys = new Map<string, string>();
  for (const spec of [
    ...VALID_STATE_PACKING_E2E_PROTOCOL.readers,
    ...VALID_STATE_PACKING_E2E_PROTOCOL.judges,
  ]) {
    const value = process.env[spec.apiKeyEnv];
    if (!value) throw new Error(`${spec.apiKeyEnv} is required for ${spec.id}`);
    apiKeys.set(spec.id, value);
  }
  await mkdir(options.outputDir, { recursive: true });
  const actualPath = path.join(options.outputDir, "actual-evaluations.jsonl");
  const completed = await loadActual(actualPath);
  const completedByKey = new Map(completed.map((item) => [evaluationKey(item), item]));
  const tasks: ActualTask[] = loaded.selected.flatMap((selected) =>
    VALID_STATE_PACKING_E2E_PROTOCOL.readers.flatMap((reader) => [
      { selected, reader, arm: "v1" as const },
      ...(selected.unchanged ? [] : [{ selected, reader, arm: "valid_state_packing" as const }]),
    ])
  ).sort((left, right) => {
    const leftKey = sha256(`${VALID_STATE_PACKING_E2E_PROTOCOL.seed}\0${left.selected.question.id}\0${left.reader.id}\0${left.arm}`);
    const rightKey = sha256(`${VALID_STATE_PACKING_E2E_PROTOCOL.seed}\0${right.selected.question.id}\0${right.reader.id}\0${right.arm}`);
    return leftKey.localeCompare(rightKey)
      || left.selected.question.id.localeCompare(right.selected.question.id)
      || left.reader.id.localeCompare(right.reader.id)
      || left.arm.localeCompare(right.arm);
  });
  if (tasks.length !== VALID_STATE_PACKING_E2E_PROTOCOL.execution.expectedReaderCalls) {
    throw new Error(`valid-state packing actual task count mismatch: ${tasks.length}`);
  }
  const allowed = new Set(tasks.map((task) =>
    `${task.selected.question.id}\0${task.reader.id}\0${task.arm}`
  ));
  if (completed.some((item) => !allowed.has(evaluationKey(item)))) {
    throw new Error("valid-state packing actual output contains a task outside the frozen panel");
  }
  const remaining = tasks.filter((task) => !completedByKey.has(
    `${task.selected.question.id}\0${task.reader.id}\0${task.arm}`,
  ));
  const concurrency = Math.max(1, Math.min(
    options.concurrency ?? 3,
    VALID_STATE_PACKING_E2E_PROTOCOL.execution.maxConcurrency,
  ));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const results = await Promise.all(batch.map((task) => evaluateActual({ task, apiKeys })));
    await appendFile(actualPath, `${results.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    for (const item of results) completedByKey.set(evaluationKey(item), item);
    process.stdout.write(`valid-state packing E2E actual ${completedByKey.size}/${tasks.length}\n`);
  }
  const actual = tasks.map((task) => {
    const item = completedByKey.get(`${task.selected.question.id}\0${task.reader.id}\0${task.arm}`);
    if (!item) throw new Error("incomplete valid-state packing actual result");
    return item;
  });
  const actualByKey = new Map(actual.map((item) => [evaluationKey(item), item]));
  const rows = loaded.selected.flatMap((selected) =>
    VALID_STATE_PACKING_E2E_PROTOCOL.readers.flatMap((reader) => {
      const v1 = actualByKey.get(`${selected.question.id}\0${reader.id}\0v1`)!;
      const candidate = selected.unchanged
        ? cloneNoop(v1)
        : actualByKey.get(`${selected.question.id}\0${reader.id}\0valid_state_packing`)!;
      return [v1, candidate];
    })
  );
  if (rows.length !== VALID_STATE_PACKING_E2E_PROTOCOL.execution.expectedArmRows) {
    throw new Error("valid-state packing final row count mismatch");
  }
  await writeFile(
    path.join(options.outputDir, "evaluations.jsonl"),
    `${rows.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  const cases = buildPanelCases(loaded.selected, rows);
  const changedCases = cases.filter((item) => !item.unchanged);
  const primaryComparison = comparison(cases, "primary", 0);
  const primary = {
    arms: {
      v1: aggregateArm(cases, "v1", "primary"),
      validStatePacking: aggregateArm(cases, "valid_state_packing", "primary"),
    },
    validStatePackingVsV1: primaryComparison,
  };
  const fullFactorialSensitivity = {
    arms: {
      v1: aggregateArm(cases, "v1", "fullFactorial"),
      validStatePacking: aggregateArm(cases, "valid_state_packing", "fullFactorial"),
    },
    validStatePackingVsV1: comparison(cases, "fullFactorial", 100),
  };
  const changedContextSensitivity = {
    cases: changedCases.length,
    arms: {
      v1: aggregateArm(changedCases, "v1", "primary"),
      validStatePacking: aggregateArm(changedCases, "valid_state_packing", "primary"),
    },
    validStatePackingVsV1: comparison(changedCases, "primary", 200),
  };
  const actualIntegrity = integrity(actual);
  const noops = noopIntegrity(rows, loaded.selected);
  const perReaderFamaDelta = perReaderFama(cases);
  const gate = evaluateValidStatePackingAnswerGate({
    callCounts: {
      reader: actualIntegrity.readerCalls,
      judge: actualIntegrity.judgeCalls,
      finalRows: rows.length,
    },
    comparison: primaryComparison,
    modelMismatches: actualIntegrity.readerModelMismatches
      + actualIntegrity.judgeModelMismatches,
    noopClones: noops.clones,
    noopMismatches: noops.mismatches,
    perReaderFamaDelta,
    tokens: {
      v1: primary.arms.v1.meanInjectedTokens,
      candidate: primary.arms.validStatePacking.meanInjectedTokens,
    },
  });
  const report = {
    status: gate.passed ? "passed" : "failed",
    nextAction: gate.passed
      ? "qualify_D4_for_external_dataset_confirmation_without_replacing_V1_yet"
      : "reject_D4_and_continue_to_D5",
    protocol: VALID_STATE_PACKING_E2E_PROTOCOL,
    generatedAt: new Date().toISOString(),
    dataset: loaded.dataset,
    input: loaded.hashes,
    primary,
    fullFactorialSensitivity,
    changedContextSensitivity,
    perReaderFamaDelta,
    operationalIntegrity: {
      ...actualIntegrity,
      expectedReaderCalls: VALID_STATE_PACKING_E2E_PROTOCOL.execution.expectedReaderCalls,
      expectedJudgeCalls: VALID_STATE_PACKING_E2E_PROTOCOL.execution.expectedJudgeCalls,
      finalArmRows: rows.length,
      noops,
    },
    answerGate: gate,
    caveats: [
      "The 50 answer cases are fresh relative to prior answer panels but come from the same Memora revision.",
      "Exact no-op contexts share one generated and judged cell, so only changed contexts contribute treatment variance.",
      "The primary crossed aggregation uses two fixed model families and cannot establish backbone-wide robustness.",
      "Even a pass requires external public data or internal programming-session confirmation before promotion over V1.",
    ],
  };
  await writeFile(
    path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}
