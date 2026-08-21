import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import { promoteLifecyclePolicy } from "../../../src/core/lifecycle/index.js";
import { loadMemora } from "./adapter.js";
import { CONTEXTUAL_E2E_PROTOCOL } from "./contextual-e2e-protocol.js";
import {
  judgeMessages,
  parseJudge,
  readerMessages,
  scoreAnswer,
  type CriterionVerdict,
} from "./e2e-runner.js";
import { V1_POLICY, type ContextualLifecyclePolicy } from "./contextual-runner.js";
import {
  callDirectJudge,
  isRetryableJudgeError,
  type DirectJudgeResponse,
  type DirectJudgeSpec,
} from "./judge-provider.js";
import type { BootstrapInterval, EvaluationCriterion, LifecycleEvalQuestion, RetrievedUnit } from "./types.js";

type Arm = "base" | "v1" | "contextual";
type AnswerMetrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof AnswerMetrics;

interface FrozenSelection {
  protocolVersion: string;
  selected: Array<{
    caseId: string;
    groupId: string;
    persona: string;
    task: string;
    baseCandidateIds: string[];
    comparatorCandidateIds: string[];
  }>;
}

interface ContextManifest {
  protocolVersion: string;
  selectedPolicy: ContextualLifecyclePolicy;
  cases: Array<{
    caseId: string;
    groupId: string;
    persona: string;
    period: string;
    task: string;
    baseCandidateIds: string[];
    v1CandidateIds: string[];
    contextualCandidateIds: string[];
  }>;
}

interface SelectedCase {
  question: LifecycleEvalQuestion;
  arms: Record<Arm, RetrievedUnit[]>;
}

interface JudgeEvaluation {
  response: DirectJudgeResponse;
  verdicts: CriterionVerdict[];
  metrics: AnswerMetrics;
  attempts: number;
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
}

interface PanelArm {
  primary: AnswerMetrics;
  fullFactorial: AnswerMetrics;
  injectedTokens: number;
  candidateIds: string[];
  cells: Record<string, AnswerMetrics>;
}

interface PanelCase {
  caseId: string;
  persona: string;
  task: string;
  arms: Record<Arm, PanelArm>;
}

export interface ContextualE2ERunOptions {
  dataRoot: string;
  selection: string;
  contextManifest: string;
  outputDir: string;
  concurrency?: number;
  skipHashVerification?: boolean;
  limit?: number;
}

const encoding = getEncoding("cl100k_base");

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

export function crossModelMean(cells: Array<{
  readerId: string;
  judgeId: string;
  metrics: AnswerMetrics;
}>): AnswerMetrics {
  const cross = cells.filter((cell) => cell.readerId !== cell.judgeId);
  if (cross.length !== 2 || new Set(cross.map((cell) => cell.readerId)).size !== 2) {
    throw new Error("cross-model primary requires one non-self judge per reader");
  }
  return meanMetrics(cross.map((cell) => cell.metrics));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callWithRetries(params: {
  spec: DirectJudgeSpec;
  apiKey: string;
  messages: Parameters<typeof callDirectJudge>[0]["messages"];
  responseFormat: "json" | "text";
}): Promise<{ response: DirectJudgeResponse; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONTEXTUAL_E2E_PROTOCOL.retries; attempt += 1) {
    try {
      return {
        response: await callDirectJudge({
          spec: params.spec,
          apiKey: params.apiKey,
          messages: params.messages,
          responseFormat: params.responseFormat,
        }),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableJudgeError(error)) throw error;
    }
    if (attempt < CONTEXTUAL_E2E_PROTOCOL.retries) await delay(500 * 2 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function evaluateJudge(params: {
  spec: DirectJudgeSpec;
  apiKey: string;
  answer: string;
  criteria: EvaluationCriterion[];
}): Promise<JudgeEvaluation> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONTEXTUAL_E2E_PROTOCOL.retries; attempt += 1) {
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
    if (attempt < CONTEXTUAL_E2E_PROTOCOL.retries) await delay(500 * 2 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadSelected(options: ContextualE2ERunOptions): Promise<{
  dataset: Awaited<ReturnType<typeof loadMemora>>["description"];
  selected: SelectedCase[];
  selectedPolicy: ContextualLifecyclePolicy;
  input: { selectionSha256: string; contextManifestSha256: string };
}> {
  const [selectionText, manifestText, loaded] = await Promise.all([
    readFile(options.selection, "utf8"),
    readFile(options.contextManifest, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const selectionHash = sha256(selectionText);
  const manifestHash = sha256(manifestText);
  if (selectionHash !== CONTEXTUAL_E2E_PROTOCOL.selection.sha256) {
    throw new Error(`selection hash mismatch: ${selectionHash}`);
  }
  if (manifestHash !== CONTEXTUAL_E2E_PROTOCOL.contextManifest.sha256) {
    throw new Error(`context manifest hash mismatch: ${manifestHash}`);
  }
  const selection = JSON.parse(selectionText) as FrozenSelection;
  const manifest = JSON.parse(manifestText) as ContextManifest;
  if (selection.protocolVersion !== CONTEXTUAL_E2E_PROTOCOL.selection.protocolVersion) {
    throw new Error(`selection protocol mismatch: ${selection.protocolVersion}`);
  }
  if (manifest.protocolVersion !== CONTEXTUAL_E2E_PROTOCOL.contextualProtocolVersion) {
    throw new Error(`context protocol mismatch: ${manifest.protocolVersion}`);
  }
  if (selection.selected.length !== CONTEXTUAL_E2E_PROTOCOL.selection.cases) {
    throw new Error(`selection case count mismatch: ${selection.selected.length}`);
  }
  if (manifest.cases.length !== CONTEXTUAL_E2E_PROTOCOL.contextManifest.cases) {
    throw new Error(`context manifest case count mismatch: ${manifest.cases.length}`);
  }
  const manifestById = new Map(manifest.cases.map((item) => [item.caseId, item]));
  const groups = new Map(loaded.groups.map((group) => [group.id, group]));
  const selected = selection.selected.map((entry): SelectedCase => {
    const group = groups.get(entry.groupId);
    if (!group) throw new Error(`missing group ${entry.groupId}`);
    const question = group.questions.find((item) => item.id === entry.caseId);
    if (!question) throw new Error(`missing question ${entry.caseId}`);
    const context = manifestById.get(entry.caseId);
    if (!context) throw new Error(`missing manifest context ${entry.caseId}`);
    if (context.baseCandidateIds.join("\0") !== entry.baseCandidateIds.join("\0")) {
      throw new Error(`base context mismatch for ${entry.caseId}`);
    }
    if (context.v1CandidateIds.join("\0") !== entry.comparatorCandidateIds.join("\0")) {
      throw new Error(`v1 context mismatch for ${entry.caseId}`);
    }
    const units = new Map(group.units.map((unit) => [unit.id, unit]));
    const materialize = (ids: string[]): RetrievedUnit[] => ids.map((id) => {
      const unit = units.get(id);
      if (!unit) throw new Error(`missing candidate ${id} for ${entry.caseId}`);
      return { ...unit, score: 0, tokenCount: encoding.encode(unit.content).length };
    });
    return {
      question,
      arms: {
        base: materialize(context.baseCandidateIds),
        v1: materialize(context.v1CandidateIds),
        contextual: materialize(context.contextualCandidateIds),
      },
    };
  });
  return {
    dataset: loaded.description,
    selected: options.limit ? selected.slice(0, options.limit) : selected,
    selectedPolicy: manifest.selectedPolicy,
    input: { selectionSha256: selectionHash, contextManifestSha256: manifestHash },
  };
}

function evaluationKey(item: Pick<ArmEvaluation, "caseId" | "readerId" | "arm">): string {
  return `${item.caseId}\0${item.readerId}\0${item.arm}`;
}

async function existing(file: string): Promise<ArmEvaluation[]> {
  try {
    const parsed = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as ArmEvaluation);
    if (parsed.some((item) => item.protocolVersion !== CONTEXTUAL_E2E_PROTOCOL.protocolVersion)) {
      throw new Error("output contains another contextual E2E protocol");
    }
    if (new Set(parsed.map(evaluationKey)).size !== parsed.length) {
      throw new Error("output contains duplicate reader-arm evaluations");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function evaluateArm(params: {
  selected: SelectedCase;
  arm: Arm;
  reader: DirectJudgeSpec;
  apiKeys: Map<string, string>;
}): Promise<ArmEvaluation> {
  const candidates = params.selected.arms[params.arm];
  const readerCall = await callWithRetries({
    spec: params.reader,
    apiKey: params.apiKeys.get(params.reader.id)!,
    messages: readerMessages(params.selected.question, candidates),
    responseFormat: "text",
  });
  const judges = await Promise.all(CONTEXTUAL_E2E_PROTOCOL.judges.map(async (spec) => [
    spec.id,
    await evaluateJudge({
      spec,
      apiKey: params.apiKeys.get(spec.id)!,
      answer: readerCall.response.content,
      criteria: params.selected.question.evaluationQuestions,
    }),
  ] as const));
  return {
    protocolVersion: CONTEXTUAL_E2E_PROTOCOL.protocolVersion,
    caseId: params.selected.question.id,
    groupId: params.selected.question.groupId,
    persona: params.selected.question.persona,
    period: params.selected.question.period,
    task: params.selected.question.task,
    readerId: params.reader.id,
    arm: params.arm,
    candidateIds: candidates.map((item) => item.id),
    injectedTokens: candidates.reduce((sum, item) => sum + item.tokenCount, 0),
    answer: readerCall.response.content,
    reader: readerCall.response,
    readerAttempts: readerCall.attempts,
    judges: Object.fromEntries(judges),
  };
}

function buildPanelCases(selected: SelectedCase[], evaluations: ArmEvaluation[]): PanelCase[] {
  const byKey = new Map(evaluations.map((item) => [evaluationKey(item), item]));
  return selected.map((item): PanelCase => ({
    caseId: item.question.id,
    persona: item.question.persona,
    task: item.question.task,
    arms: Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.arms.map((arm): [Arm, PanelArm] => {
      const readerEvaluations = CONTEXTUAL_E2E_PROTOCOL.readers.map((reader) => {
        const evaluation = byKey.get(`${item.question.id}\0${reader.id}\0${arm}`);
        if (!evaluation) throw new Error(`missing evaluation ${item.question.id}/${reader.id}/${arm}`);
        return evaluation;
      });
      const cells = readerEvaluations.flatMap((evaluation) =>
        CONTEXTUAL_E2E_PROTOCOL.judges.map((judge) => ({
          readerId: evaluation.readerId,
          judgeId: judge.id,
          metrics: evaluation.judges[judge.id].metrics,
        }))
      );
      const tokenCounts = new Set(readerEvaluations.map((evaluation) => evaluation.injectedTokens));
      const candidateLists = new Set(readerEvaluations.map((evaluation) => evaluation.candidateIds.join("\0")));
      if (tokenCounts.size !== 1 || candidateLists.size !== 1) {
        throw new Error(`reader context mismatch for ${item.question.id}/${arm}`);
      }
      return [arm, {
        primary: crossModelMean(cells),
        fullFactorial: meanMetrics(cells.map((cell) => cell.metrics)),
        injectedTokens: readerEvaluations[0].injectedTokens,
        candidateIds: readerEvaluations[0].candidateIds,
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
    meanInjectedItems: mean(cases.map((item) => item.arms[arm].candidateIds.length)),
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
  left: Arm;
  right: Arm;
  metric: Metric;
  mode: "primary" | "fullFactorial";
  seed: number;
}): BootstrapInterval {
  const byPersona = new Map<string, PanelCase[]>();
  for (const item of params.cases) {
    const entries = byPersona.get(item.persona) ?? [];
    entries.push(item);
    byPersona.set(item.persona, entries);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: PanelCase) =>
    item.arms[params.left][params.mode][params.metric]
    - item.arms[params.right][params.mode][params.metric];
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < CONTEXTUAL_E2E_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: PanelCase[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    draws.push(mean(selected.map(delta)));
  }
  draws.sort((a, b) => a - b);
  return {
    mean: mean(params.cases.map(delta)),
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}

function comparison(
  cases: PanelCase[],
  left: Arm,
  right: Arm,
  mode: "primary" | "fullFactorial",
  seedOffset: number,
) {
  return Object.fromEntries(((["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]).map((metric, index) => [
    metric,
    bootstrap({
      cases,
      left,
      right,
      metric,
      mode,
      seed: CONTEXTUAL_E2E_PROTOCOL.seed + seedOffset + index,
    }),
  ]))) as Record<Metric, BootstrapInterval>;
}

function agreement(evaluations: ArmEvaluation[]) {
  const [leftId, rightId] = CONTEXTUAL_E2E_PROTOCOL.judges.map((item) => item.id);
  const categories = ["yes", "no", "unclear"] as const;
  const leftCounts = new Map(categories.map((answer) => [answer, 0]));
  const rightCounts = new Map(categories.map((answer) => [answer, 0]));
  let votes = 0;
  let exact = 0;
  for (const item of evaluations) {
    const left = item.judges[leftId].verdicts;
    const right = item.judges[rightId].verdicts;
    if (left.length !== right.length) throw new Error(`judge verdict length mismatch for ${evaluationKey(item)}`);
    for (let index = 0; index < left.length; index += 1) {
      votes += 1;
      exact += Number(left[index].answer === right[index].answer);
      leftCounts.set(left[index].answer, (leftCounts.get(left[index].answer) ?? 0) + 1);
      rightCounts.set(right[index].answer, (rightCounts.get(right[index].answer) ?? 0) + 1);
    }
  }
  const rate = votes ? exact / votes : 0;
  const chance = votes ? categories.reduce((sum, answer) =>
    sum + ((leftCounts.get(answer) ?? 0) / votes) * ((rightCounts.get(answer) ?? 0) / votes), 0) : 0;
  return {
    pairedCriteria: votes,
    exact,
    rate,
    cohensKappa: chance < 1 ? (rate - chance) / (1 - chance) : 1,
    unclear: {
      [leftId]: leftCounts.get("unclear") ?? 0,
      [rightId]: rightCounts.get("unclear") ?? 0,
    },
  };
}

function usage(evaluations: ArmEvaluation[]) {
  const readers = Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.readers.map((spec) => {
    const selected = evaluations.filter((item) => item.readerId === spec.id);
    return [spec.id, {
      calls: selected.length,
      promptTokens: selected.reduce((sum, item) => sum + item.reader.usage.promptTokens, 0),
      completionTokens: selected.reduce((sum, item) => sum + item.reader.usage.completionTokens, 0),
      totalTokens: selected.reduce((sum, item) => sum + item.reader.usage.totalTokens, 0),
      retries: selected.reduce((sum, item) => sum + item.readerAttempts - 1, 0),
      meanLatencyMs: mean(selected.map((item) => item.reader.latencyMs)),
    }];
  }));
  const judges = Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.judges.map((spec) => {
    const selected = evaluations.map((item) => item.judges[spec.id]);
    return [spec.id, {
      calls: selected.length,
      promptTokens: selected.reduce((sum, item) => sum + item.response.usage.promptTokens, 0),
      completionTokens: selected.reduce((sum, item) => sum + item.response.usage.completionTokens, 0),
      totalTokens: selected.reduce((sum, item) => sum + item.response.usage.totalTokens, 0),
      retries: selected.reduce((sum, item) => sum + item.attempts - 1, 0),
      meanLatencyMs: mean(selected.map((item) => item.response.latencyMs)),
    }];
  }));
  return { readers, judges };
}

function operationalIntegrity(evaluations: ArmEvaluation[], selectedCases: number) {
  let readerRetries = 0;
  let judgeRetries = 0;
  let readerModelMismatches = 0;
  let judgeModelMismatches = 0;
  let unclearVerdicts = 0;
  for (const item of evaluations) {
    readerRetries += item.readerAttempts - 1;
    const readerSpec = CONTEXTUAL_E2E_PROTOCOL.readers.find((spec) => spec.id === item.readerId)!;
    readerModelMismatches += Number(item.reader.model !== readerSpec.model);
    for (const judgeSpec of CONTEXTUAL_E2E_PROTOCOL.judges) {
      const judged = item.judges[judgeSpec.id];
      judgeRetries += judged.attempts - 1;
      judgeModelMismatches += Number(judged.response.model !== judgeSpec.model);
      unclearVerdicts += judged.verdicts.filter((verdict) => verdict.answer === "unclear").length;
    }
  }
  return {
    readerArmEvaluations: evaluations.length,
    expectedReaderArmEvaluations: selectedCases
      * CONTEXTUAL_E2E_PROTOCOL.readers.length
      * CONTEXTUAL_E2E_PROTOCOL.arms.length,
    readerCalls: evaluations.length,
    judgeCalls: evaluations.length * CONTEXTUAL_E2E_PROTOCOL.judges.length,
    readerRetries,
    judgeRetries,
    readerModelMismatches,
    judgeModelMismatches,
    unclearVerdicts,
  };
}

function cellReport(cases: PanelCase[]) {
  const keys = Object.keys(cases[0]?.arms.base.cells ?? {}).sort();
  return Object.fromEntries(keys.map((key) => [key, {
    arms: Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.arms.map((arm) => [arm, {
      ...meanMetrics(cases.map((item) => item.arms[arm].cells[key])),
    }])),
    contextualVsBaseFama: mean(cases.map((item) =>
      item.arms.contextual.cells[key].fama - item.arms.base.cells[key].fama)),
    contextualVsV1Fama: mean(cases.map((item) =>
      item.arms.contextual.cells[key].fama - item.arms.v1.cells[key].fama)),
  }]));
}

export async function runContextualE2E(options: ContextualE2ERunOptions): Promise<Record<string, any>> {
  const { dataset, selected, selectedPolicy, input } = await loadSelected(options);
  const apiKeys = new Map<string, string>();
  for (const spec of [...CONTEXTUAL_E2E_PROTOCOL.readers, ...CONTEXTUAL_E2E_PROTOCOL.judges]) {
    const value = process.env[spec.apiKeyEnv];
    if (!value) throw new Error(`${spec.apiKeyEnv} is required for ${spec.id}`);
    apiKeys.set(spec.id, value);
  }
  await mkdir(options.outputDir, { recursive: true });
  const evaluationsPath = path.join(options.outputDir, "evaluations.jsonl");
  const completed = await existing(evaluationsPath);
  const completedByKey = new Map(completed.map((item) => [evaluationKey(item), item]));
  const tasks = selected.flatMap((item) => CONTEXTUAL_E2E_PROTOCOL.readers.flatMap((reader) =>
    CONTEXTUAL_E2E_PROTOCOL.arms.map((arm) => ({ selected: item, reader, arm }))));
  const allowedKeys = new Set(tasks.map((item) => `${item.selected.question.id}\0${item.reader.id}\0${item.arm}`));
  if (completed.some((item) => !allowedKeys.has(evaluationKey(item)))) {
    throw new Error("output contains an evaluation outside the frozen task set");
  }
  const remaining = tasks.filter((item) => !completedByKey.has(
    `${item.selected.question.id}\0${item.reader.id}\0${item.arm}`,
  ));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 4));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const results = await Promise.all(batch.map((item) => evaluateArm({ ...item, apiKeys })));
    await appendFile(evaluationsPath, `${results.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    for (const result of results) completedByKey.set(evaluationKey(result), result);
    process.stdout.write(`contextual E2E ${completedByKey.size}/${tasks.length} reader-arm evaluations\n`);
  }
  const evaluations = tasks.map((item) => {
    const key = `${item.selected.question.id}\0${item.reader.id}\0${item.arm}`;
    const result = completedByKey.get(key);
    if (!result) throw new Error(`incomplete contextual E2E result ${key}`);
    return result;
  });
  const cases = buildPanelCases(selected, evaluations);
  const primary = {
    arms: Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.arms.map((arm) => [arm, aggregateArm(cases, arm, "primary")])),
    contextualVsBase: comparison(cases, "contextual", "base", "primary", 0),
    v1VsBase: comparison(cases, "v1", "base", "primary", 10),
    contextualVsV1: comparison(cases, "contextual", "v1", "primary", 20),
  };
  const sensitivity = {
    arms: Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.arms.map((arm) => [
      arm,
      aggregateArm(cases, arm, "fullFactorial"),
    ])),
    contextualVsBase: comparison(cases, "contextual", "base", "fullFactorial", 100),
    v1VsBase: comparison(cases, "v1", "base", "fullFactorial", 110),
    contextualVsV1: comparison(cases, "contextual", "v1", "fullFactorial", 120),
  };
  const baseTokens = primary.arms.base.meanInjectedTokens;
  const contextualTokens = primary.arms.contextual.meanInjectedTokens;
  const checks = {
    contextualVsBaseFama: primary.contextualVsBase.fama.mean
      >= CONTEXTUAL_E2E_PROTOCOL.gate.minContextualVsBaseFamaDelta,
    contextualVsBaseFaa: primary.contextualVsBase.faa.mean
      >= CONTEXTUAL_E2E_PROTOCOL.gate.minContextualVsBaseFaaDelta,
    contextualVsBaseFamaCi: !CONTEXTUAL_E2E_PROTOCOL.gate.requireContextualVsBaseFamaCiLowerAboveZero
      || primary.contextualVsBase.fama.lower > 0,
    contextualVsV1Fama: !CONTEXTUAL_E2E_PROTOCOL.gate.requirePositiveContextualVsV1FamaDelta
      || primary.contextualVsV1.fama.mean > 0,
    tokenBudget: contextualTokens <= baseTokens
      * (1 + CONTEXTUAL_E2E_PROTOCOL.gate.maxContextualInjectedTokenIncreaseFraction),
  };
  const promotion = promoteLifecyclePolicy({
    incumbent: V1_POLICY,
    challenger: selectedPolicy,
    checks: [
      {
        name: "contextualVsBaseFama",
        passed: checks.contextualVsBaseFama,
        observed: primary.contextualVsBase.fama.mean,
        threshold: `>= ${CONTEXTUAL_E2E_PROTOCOL.gate.minContextualVsBaseFamaDelta}`,
      },
      {
        name: "contextualVsBaseFaa",
        passed: checks.contextualVsBaseFaa,
        observed: primary.contextualVsBase.faa.mean,
        threshold: `>= ${CONTEXTUAL_E2E_PROTOCOL.gate.minContextualVsBaseFaaDelta}`,
      },
      {
        name: "contextualVsBaseFamaCi",
        passed: checks.contextualVsBaseFamaCi,
        observed: primary.contextualVsBase.fama.lower,
        threshold: "> 0",
      },
      {
        name: "contextualVsV1Fama",
        passed: checks.contextualVsV1Fama,
        observed: primary.contextualVsV1.fama.mean,
        threshold: "> 0",
      },
      {
        name: "tokenBudget",
        passed: checks.tokenBudget,
        observed: contextualTokens / baseTokens - 1,
        threshold: `<= ${CONTEXTUAL_E2E_PROTOCOL.gate.maxContextualInjectedTokenIncreaseFraction}`,
      },
    ],
  });
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: CONTEXTUAL_E2E_PROTOCOL,
    generatedAt: new Date().toISOString(),
    dataset,
    input: { ...input, cases: selected.length },
    primary,
    fullFactorialSensitivity: sensitivity,
    cells: cellReport(cases),
    agreement: {
      overall: agreement(evaluations),
      byArm: Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.arms.map((arm) => [
        arm,
        agreement(evaluations.filter((item) => item.arm === arm)),
      ])),
    },
    usage: usage(evaluations),
    operationalIntegrity: operationalIntegrity(evaluations, selected.length),
    subgroupByTask: Object.fromEntries([...new Set(cases.map((item) => item.task))].sort().map((task, index) => {
      const subset = cases.filter((item) => item.task === task);
      return [task, {
        cases: subset.length,
        arms: Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.arms.map((arm) => [arm, aggregateArm(subset, arm, "primary")])),
        contextualVsBase: comparison(subset, "contextual", "base", "primary", 200 + index * 30),
        contextualVsV1: comparison(subset, "contextual", "v1", "primary", 210 + index * 30),
      }];
    })),
    gate: { passed: Object.values(checks).every(Boolean), checks },
    promotion,
    caveats: [
      "The primary crossed aggregation excludes self-judging, but readers and judges still come from the same fixed two-model pool.",
      "This frozen sample is conditional on Base stale exposure and is not an estimate over all Memora questions.",
      "Quarterly Memora was observed during earlier development; this is a fixed-sample confirmation, not a pristine external test.",
      "Evaluation criteria are batched per answer and are not directly comparable to Memora Table 3.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
