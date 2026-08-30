import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";
import { sourceRevision } from "./adaptive-runner.js";
import type { ProductionPathArm, ProductionPathIntent } from "./production-path-context-protocol.js";
import type { ProductionReaderMessage } from "./production-path-context.js";
import { PRODUCTION_PATH_E2E_PROTOCOL } from "./production-path-e2e-protocol.js";
import {
  judgeMessages,
  parseJudge,
  scoreAnswer,
  type CriterionVerdict,
} from "./e2e-runner.js";
import {
  callDirectJudge,
  isRetryableJudgeError,
  type DirectJudgeResponse,
  type DirectJudgeSpec,
} from "./judge-provider.js";
import type { BootstrapInterval, LifecycleEvalQuestion } from "./types.js";

type AnswerMetrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof AnswerMetrics;
type PanelName = "natural_safety" | "temporal_capability";

interface ContextManifestCase {
  caseId: string;
  panel: PanelName;
  pairId?: string;
  groupId: string;
  persona: string;
  period: string;
  task: string;
  queryIntent: ProductionPathIntent;
  evaluationCriteria: number;
  generatedQuestion?: LifecycleEvalQuestion;
  arms: Record<ProductionPathArm, string>;
}

interface ContextManifestEntry {
  hash: string;
  caseId: string;
  messages: ProductionReaderMessage[];
  injectedTokens: number;
  recalledMemoryIds: string[];
  pairCount: number;
}

interface ContextManifest {
  protocolVersion: string;
  dataset: { revision: string };
  selection: {
    cases: number;
    naturalCases: number;
    temporalCases: number;
    temporalPairs: number;
  };
  cases: ContextManifestCase[];
  contexts: ContextManifestEntry[];
  deduplication: {
    caseArmContexts: number;
    uniquePromptsPerReader: number;
  };
  validation: {
    recallErrors: number;
    lifecycleFallbacks: number;
    unexpectedPairCounts: number;
    nonEligiblePromptMismatches: number;
    passed: boolean;
  };
  productionPath: Record<string, unknown>;
  claimBoundary: string;
}

interface FrozenCase {
  manifest: ContextManifestCase;
  question: LifecycleEvalQuestion;
}

export interface ProductionPathEvaluation {
  protocolVersion: string;
  caseId: string;
  panel: PanelName;
  contextHash: string;
  readerId: string;
  judgeId: string;
  recalledMemoryIds: string[];
  injectedTokens: number;
  pairCount: number;
  answer: string;
  reader: DirectJudgeResponse;
  readerAttempts: number;
  judge: DirectJudgeResponse;
  judgeAttempts: number;
  verdicts: CriterionVerdict[];
  metrics: AnswerMetrics;
}

interface PanelArm {
  metrics: AnswerMetrics;
  cells: Record<string, AnswerMetrics>;
  contextHash: string;
  recalledMemoryIds: string[];
  injectedTokens: number;
  pairCount: number;
}

export interface ProductionPathPanelCase {
  caseId: string;
  panel: PanelName;
  pairId?: string;
  persona: string;
  task: string;
  queryIntent: ProductionPathIntent;
  arms: Record<ProductionPathArm, PanelArm>;
}

export interface ProductionPathE2EOptions {
  dataRoot: string;
  contextManifest: string;
  outputDir: string;
  concurrency?: number;
  skipHashVerification?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const providerIntervalsMs = { minimax: 1_350, deepseek: 100 } as const;
const providerGates = new Map<string, Promise<void>>();
const providerLastStart = new Map<string, number>();

async function waitForProviderSlot(spec: DirectJudgeSpec): Promise<void> {
  const previous = providerGates.get(spec.provider) ?? Promise.resolve();
  const gate = previous.catch(() => undefined).then(async () => {
    const elapsed = Date.now() - (providerLastStart.get(spec.provider) ?? 0);
    const remaining = providerIntervalsMs[spec.provider] - elapsed;
    if (remaining > 0) await delay(remaining);
    providerLastStart.set(spec.provider, Date.now());
  });
  providerGates.set(spec.provider, gate);
  await gate;
}

async function pacedCall(params: Parameters<typeof callDirectJudge>[0]) {
  await waitForProviderSlot(params.spec);
  return callDirectJudge(params);
}

function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof Error && error.message.includes("HTTP 429")) return 30_000 * attempt;
  return 500 * 2 ** (attempt - 1);
}

async function callReader(params: {
  spec: DirectJudgeSpec;
  apiKey: string;
  messages: ProductionReaderMessage[];
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PRODUCTION_PATH_E2E_PROTOCOL.retries; attempt += 1) {
    try {
      return {
        response: await pacedCall({
          spec: params.spec,
          apiKey: params.apiKey,
          messages: params.messages,
          responseFormat: "text",
        }),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableJudgeError(error)) throw error;
    }
    if (attempt < PRODUCTION_PATH_E2E_PROTOCOL.retries) await delay(retryDelay(lastError, attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callJudge(params: {
  spec: DirectJudgeSpec;
  apiKey: string;
  answer: string;
  question: LifecycleEvalQuestion;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PRODUCTION_PATH_E2E_PROTOCOL.retries; attempt += 1) {
    try {
      const response = await pacedCall({
        spec: params.spec,
        apiKey: params.apiKey,
        messages: judgeMessages(params.answer, params.question.evaluationQuestions),
        responseFormat: "json",
      });
      try {
        const verdicts = parseJudge(response.content, params.question.evaluationQuestions);
        return { response, attempts: attempt, verdicts, metrics: scoreAnswer(verdicts) };
      } catch (error) {
        lastError = error;
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableJudgeError(error)) throw error;
    }
    if (attempt < PRODUCTION_PATH_E2E_PROTOCOL.retries) await delay(retryDelay(lastError, attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadFrozen(options: ProductionPathE2EOptions) {
  const [manifestText, loaded] = await Promise.all([
    readFile(options.contextManifest, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const manifestSha256 = sha256(manifestText);
  if (manifestSha256 !== PRODUCTION_PATH_E2E_PROTOCOL.context.sha256) {
    throw new Error(`production context hash mismatch: ${manifestSha256}`);
  }
  const manifest = JSON.parse(manifestText) as ContextManifest;
  const expected = PRODUCTION_PATH_E2E_PROTOCOL.context;
  if (manifest.protocolVersion !== expected.protocolVersion
    || manifest.cases.length !== expected.cases
    || manifest.contexts.length !== expected.uniquePromptsPerReader
    || manifest.selection.cases !== expected.cases
    || manifest.selection.naturalCases !== expected.naturalCases
    || manifest.selection.temporalCases !== expected.temporalCases
    || manifest.selection.temporalPairs !== expected.temporalPairs
    || manifest.deduplication.caseArmContexts !== expected.caseArmContexts
    || manifest.deduplication.uniquePromptsPerReader !== expected.uniquePromptsPerReader) {
    throw new Error("production context identity mismatch");
  }
  if (!manifest.validation.passed) throw new Error("production context validation failed");
  if (loaded.description.revision !== manifest.dataset.revision) {
    throw new Error("production context dataset revision mismatch");
  }
  const naturalQuestions = new Map(loaded.groups.flatMap((group) => group.questions)
    .map((item) => [item.id, item]));
  const cases: FrozenCase[] = manifest.cases.map((item) => {
    const question = item.panel === "temporal_capability"
      ? item.generatedQuestion
      : naturalQuestions.get(item.caseId);
    if (!question || question.id !== item.caseId) throw new Error(`missing frozen question ${item.caseId}`);
    if (question.evaluationQuestions.length !== item.evaluationCriteria) {
      throw new Error(`criterion drift for ${item.caseId}`);
    }
    return { manifest: item, question };
  });
  const contexts = new Map(manifest.contexts.map((item) => [item.hash, item]));
  if (contexts.size !== manifest.contexts.length) throw new Error("duplicate production context hash");
  for (const item of manifest.cases) {
    for (const arm of PRODUCTION_PATH_E2E_PROTOCOL.arms) {
      const context = contexts.get(item.arms[arm]);
      if (!context || context.caseId !== item.caseId) {
        throw new Error(`missing production context ${item.caseId}/${arm}`);
      }
      if (sha256(JSON.stringify(context.messages)) !== context.hash) {
        throw new Error(`production message hash mismatch ${item.caseId}/${arm}`);
      }
    }
  }
  return { dataset: loaded.description, manifest, manifestSha256, cases, contexts };
}

function evaluationKey(item: Pick<ProductionPathEvaluation, "contextHash" | "readerId">): string {
  return `${item.contextHash}\0${item.readerId}`;
}

async function existing(file: string): Promise<ProductionPathEvaluation[]> {
  try {
    const entries = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as ProductionPathEvaluation);
    if (entries.some((item) => item.protocolVersion !== PRODUCTION_PATH_E2E_PROTOCOL.protocolVersion)) {
      throw new Error("output contains another production-path protocol version");
    }
    if (new Set(entries.map(evaluationKey)).size !== entries.length) {
      throw new Error("output contains duplicate production-path evaluations");
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function evaluateContext(params: {
  frozen: FrozenCase;
  context: ContextManifestEntry;
  reader: DirectJudgeSpec;
  apiKeys: Map<string, string>;
}): Promise<ProductionPathEvaluation> {
  const reader = await callReader({
    spec: params.reader,
    apiKey: params.apiKeys.get(params.reader.id)!,
    messages: params.context.messages,
  });
  const judgeId = PRODUCTION_PATH_E2E_PROTOCOL.judgeAssignment[params.reader.id];
  const judgeSpec = PRODUCTION_PATH_E2E_PROTOCOL.judges.find((item) => item.id === judgeId)!;
  const judge = await callJudge({
    spec: judgeSpec,
    apiKey: params.apiKeys.get(judgeId)!,
    answer: reader.response.content,
    question: params.frozen.question,
  });
  return {
    protocolVersion: PRODUCTION_PATH_E2E_PROTOCOL.protocolVersion,
    caseId: params.frozen.question.id,
    panel: params.frozen.manifest.panel,
    contextHash: params.context.hash,
    readerId: params.reader.id,
    judgeId,
    recalledMemoryIds: params.context.recalledMemoryIds,
    injectedTokens: params.context.injectedTokens,
    pairCount: params.context.pairCount,
    answer: reader.response.content,
    reader: reader.response,
    readerAttempts: reader.attempts,
    judge: judge.response,
    judgeAttempts: judge.attempts,
    verdicts: judge.verdicts,
    metrics: judge.metrics,
  };
}

export function crossedMean(metrics: AnswerMetrics[]): AnswerMetrics {
  if (metrics.length !== 2) throw new Error(`expected two crossed cells, found ${metrics.length}`);
  return {
    mpa: mean(metrics.map((item) => item.mpa)),
    faa: mean(metrics.map((item) => item.faa)),
    fama: mean(metrics.map((item) => item.fama)),
    criterionAccuracy: mean(metrics.map((item) => item.criterionAccuracy)),
  };
}

function buildPanelCases(
  frozen: FrozenCase[],
  contexts: Map<string, ContextManifestEntry>,
  evaluations: Map<string, ProductionPathEvaluation>,
): ProductionPathPanelCase[] {
  return frozen.map(({ manifest }) => ({
    caseId: manifest.caseId,
    panel: manifest.panel,
    ...(manifest.pairId ? { pairId: manifest.pairId } : {}),
    persona: manifest.persona,
    task: manifest.task,
    queryIntent: manifest.queryIntent,
    arms: Object.fromEntries(PRODUCTION_PATH_E2E_PROTOCOL.arms.map((arm): [ProductionPathArm, PanelArm] => {
      const contextHash = manifest.arms[arm];
      const context = contexts.get(contextHash)!;
      const cells = PRODUCTION_PATH_E2E_PROTOCOL.readers.map((reader) => {
        const evaluation = evaluations.get(`${contextHash}\0${reader.id}`);
        if (!evaluation) throw new Error(`missing evaluation ${contextHash}/${reader.id}`);
        return evaluation;
      });
      return [arm, {
        metrics: crossedMean(cells.map((item) => item.metrics)),
        cells: Object.fromEntries(cells.map((item) => [item.readerId, item.metrics])),
        contextHash,
        recalledMemoryIds: context.recalledMemoryIds,
        injectedTokens: context.injectedTokens,
        pairCount: context.pairCount,
      }];
    })) as Record<ProductionPathArm, PanelArm>,
  }));
}

export function aggregateArm(cases: ProductionPathPanelCase[], arm: ProductionPathArm) {
  return {
    cases: cases.length,
    mpa: mean(cases.map((item) => item.arms[arm].metrics.mpa)),
    faa: mean(cases.map((item) => item.arms[arm].metrics.faa)),
    fama: mean(cases.map((item) => item.arms[arm].metrics.fama)),
    criterionAccuracy: mean(cases.map((item) => item.arms[arm].metrics.criterionAccuracy)),
    meanInjectedTokens: mean(cases.map((item) => item.arms[arm].injectedTokens)),
    meanInjectedItems: mean(cases.map((item) => item.arms[arm].recalledMemoryIds.length)),
    meanRenderedPairs: mean(cases.map((item) => item.arms[arm].pairCount)),
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

export function personaBootstrap(params: {
  cases: ProductionPathPanelCase[];
  metric: Metric;
  seed: number;
}): BootstrapInterval {
  if (!params.cases.length) return { mean: 0, lower: 0, upper: 0, clusters: 0 };
  const personas = [...new Set(params.cases.map((item) => item.persona))].sort();
  const clusters = personas.map((persona) => params.cases.filter((item) => item.persona === persona));
  const delta = (item: ProductionPathPanelCase) =>
    item.arms.query_aware_dual.metrics[params.metric] - item.arms.current_only.metrics[params.metric];
  const observed = mean(params.cases.map(delta));
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < PRODUCTION_PATH_E2E_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: ProductionPathPanelCase[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    draws.push(mean(selected.map(delta)));
  }
  draws.sort((left, right) => left - right);
  return {
    mean: observed,
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}

function comparison(cases: ProductionPathPanelCase[], seedOffset: number) {
  return Object.fromEntries((["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]).map((metric, index) => [
    metric,
    personaBootstrap({
      cases,
      metric,
      seed: PRODUCTION_PATH_E2E_PROTOCOL.seed + seedOffset + index,
    }),
  ])) as Record<Metric, BootstrapInterval>;
}

function readerDirections(cases: ProductionPathPanelCase[], metric: Metric) {
  return Object.fromEntries(PRODUCTION_PATH_E2E_PROTOCOL.readers.map((reader) => [
    reader.id,
    mean(cases.map((item) => item.arms.query_aware_dual.cells[reader.id][metric]
      - item.arms.current_only.cells[reader.id][metric])),
  ]));
}

function outcomeCounts(cases: ProductionPathPanelCase[], metric: Metric) {
  const deltas = cases.map((item) =>
    item.arms.query_aware_dual.metrics[metric] - item.arms.current_only.metrics[metric]);
  return {
    cases: cases.length,
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
  };
}

function subsetReport(cases: ProductionPathPanelCase[], seedOffset: number) {
  return {
    cases: cases.length,
    arms: Object.fromEntries(PRODUCTION_PATH_E2E_PROTOCOL.arms.map((arm) => [arm, aggregateArm(cases, arm)])),
    comparison: comparison(cases, seedOffset),
    readerDirections: {
      fama: readerDirections(cases, "fama"),
      criterionAccuracy: readerDirections(cases, "criterionAccuracy"),
    },
    outcomes: {
      fama: outcomeCounts(cases, "fama"),
      criterionAccuracy: outcomeCounts(cases, "criterionAccuracy"),
    },
  };
}

function usage(evaluations: ProductionPathEvaluation[]) {
  return {
    readers: Object.fromEntries(PRODUCTION_PATH_E2E_PROTOCOL.readers.map((spec) => {
      const selected = evaluations.filter((item) => item.readerId === spec.id);
      return [spec.id, {
        calls: selected.length,
        promptTokens: selected.reduce((sum, item) => sum + item.reader.usage.promptTokens, 0),
        completionTokens: selected.reduce((sum, item) => sum + item.reader.usage.completionTokens, 0),
        totalTokens: selected.reduce((sum, item) => sum + item.reader.usage.totalTokens, 0),
        retries: selected.reduce((sum, item) => sum + item.readerAttempts - 1, 0),
        meanLatencyMs: mean(selected.map((item) => item.reader.latencyMs)),
      }];
    })),
    judges: Object.fromEntries(PRODUCTION_PATH_E2E_PROTOCOL.judges.map((spec) => {
      const selected = evaluations.filter((item) => item.judgeId === spec.id);
      return [spec.id, {
        calls: selected.length,
        promptTokens: selected.reduce((sum, item) => sum + item.judge.usage.promptTokens, 0),
        completionTokens: selected.reduce((sum, item) => sum + item.judge.usage.completionTokens, 0),
        totalTokens: selected.reduce((sum, item) => sum + item.judge.usage.totalTokens, 0),
        retries: selected.reduce((sum, item) => sum + item.judgeAttempts - 1, 0),
        meanLatencyMs: mean(selected.map((item) => item.judge.latencyMs)),
      }];
    })),
  };
}

function integrity(evaluations: ProductionPathEvaluation[], expected: number) {
  return {
    evaluations: evaluations.length,
    expectedEvaluations: expected,
    complete: evaluations.length === expected,
    readerCalls: evaluations.length,
    judgeCalls: evaluations.length,
    readerRetries: evaluations.reduce((sum, item) => sum + item.readerAttempts - 1, 0),
    judgeRetries: evaluations.reduce((sum, item) => sum + item.judgeAttempts - 1, 0),
    readerModelMismatches: evaluations.filter((item) =>
      item.reader.model !== PRODUCTION_PATH_E2E_PROTOCOL.readers
        .find((spec) => spec.id === item.readerId)!.model).length,
    judgeModelMismatches: evaluations.filter((item) =>
      item.judge.model !== PRODUCTION_PATH_E2E_PROTOCOL.judges
        .find((spec) => spec.id === item.judgeId)!.model).length,
    selfJudgments: evaluations.filter((item) => item.readerId === item.judgeId).length,
    unclearVerdicts: evaluations.reduce((sum, item) =>
      sum + item.verdicts.filter((verdict) => verdict.answer === "unclear").length, 0),
  };
}

export async function runProductionPathE2E(options: ProductionPathE2EOptions): Promise<Record<string, any>> {
  const frozen = await loadFrozen(options);
  const revision = await sourceRevision();
  const apiKeys = new Map<string, string>();
  for (const spec of [...PRODUCTION_PATH_E2E_PROTOCOL.readers, ...PRODUCTION_PATH_E2E_PROTOCOL.judges]) {
    const value = process.env[spec.apiKeyEnv];
    if (!value) throw new Error(`${spec.apiKeyEnv} is required for production-path evaluation`);
    apiKeys.set(spec.id, value);
  }
  await mkdir(options.outputDir, { recursive: true });
  const evaluationsPath = path.join(options.outputDir, "evaluations.jsonl");
  const completed = await existing(evaluationsPath);
  const completedByKey = new Map(completed.map((item) => [evaluationKey(item), item]));
  const frozenByCase = new Map(frozen.cases.map((item) => [item.question.id, item]));
  const tasks = frozen.manifest.contexts.flatMap((context) =>
    PRODUCTION_PATH_E2E_PROTOCOL.readers.map((reader) => ({
      frozen: frozenByCase.get(context.caseId)!,
      context,
      reader,
    })));
  const allowed = new Set(tasks.map((item) => `${item.context.hash}\0${item.reader.id}`));
  if (completed.some((item) => !allowed.has(evaluationKey(item)))) {
    throw new Error("output contains an evaluation outside the frozen production task set");
  }
  const remaining = tasks.filter((item) => !completedByKey.has(`${item.context.hash}\0${item.reader.id}`));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const results = await Promise.all(batch.map((item) => evaluateContext({ ...item, apiKeys })));
    await appendFile(evaluationsPath, `${results.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    for (const result of results) completedByKey.set(evaluationKey(result), result);
    process.stdout.write(`production-path crossed evaluations ${completedByKey.size}/${tasks.length}\n`);
  }

  const evaluations = tasks.map((item) => {
    const result = completedByKey.get(`${item.context.hash}\0${item.reader.id}`);
    if (!result) throw new Error(`incomplete evaluation ${item.context.hash}/${item.reader.id}`);
    return result;
  });
  const cases = buildPanelCases(frozen.cases, frozen.contexts, completedByKey);
  const naturalCases = cases.filter((item) => item.panel === "natural_safety");
  const temporalCases = cases.filter((item) => item.panel === "temporal_capability");
  const reports = {
    combined: subsetReport(cases, 0),
    natural: {
      ...subsetReport(naturalCases, 1000),
      byTask: Object.fromEntries([...new Set(naturalCases.map((item) => item.task))].sort()
        .map((task, index) => [
          task,
          subsetReport(naturalCases.filter((item) => item.task === task), 2000 + index * 200),
        ])),
    },
    temporal: {
      ...subsetReport(temporalCases, 4000),
      pairs: new Set(temporalCases.map((item) => item.pairId)).size,
      byTask: Object.fromEntries([...new Set(temporalCases.map((item) => item.task))].sort()
        .map((task, index) => [
          task,
          subsetReport(temporalCases.filter((item) => item.task === task), 5000 + index * 200),
        ])),
    },
  };

  const operationalIntegrity = integrity(evaluations, PRODUCTION_PATH_E2E_PROTOCOL.reuse.expectedReaderCalls);
  const temporal = reports.temporal.comparison;
  const history = reports.temporal.byTask.temporal_history.comparison;
  const change = reports.temporal.byTask.temporal_change.comparison;
  const current = reports.temporal.byTask.temporal_current.comparison;
  const natural = reports.natural.comparison;
  const combinedTokenIncreaseFraction = reports.combined.arms.query_aware_dual.meanInjectedTokens
    / reports.combined.arms.current_only.meanInjectedTokens - 1;
  const readerTemporalDirections = reports.temporal.readerDirections.criterionAccuracy;
  const gate = PRODUCTION_PATH_E2E_PROTOCOL.gates;
  const checks = {
    temporalAccuracy: temporal.criterionAccuracy.mean >= gate.minTemporalCriterionAccuracyDelta,
    temporalAccuracyCi: !gate.requireTemporalCriterionAccuracyCiLowerAboveZero
      || temporal.criterionAccuracy.lower > 0,
    historicalAccuracy: history.criterionAccuracy.mean >= gate.minHistoryCriterionAccuracyDelta,
    changeAccuracy: change.criterionAccuracy.mean >= gate.minChangeCriterionAccuracyDelta,
    currentNonInferiority: current.criterionAccuracy.mean >= gate.minCurrentCriterionAccuracyDelta,
    naturalNonInferiority: natural.fama.mean >= gate.minNaturalFamaDelta,
    combinedTokenBudget: combinedTokenIncreaseFraction <= gate.maxCombinedTokenIncreaseFraction,
    readerDirection: !gate.requireNonnegativeTemporalDirectionForBothReaders
      || Object.values(readerTemporalDirections).every((value) => value >= 0),
    contextIntegrity: !gate.requirePassedProductionContext || frozen.manifest.validation.passed,
    evaluationIntegrity: (!gate.requireCompleteFrozenTaskSet || operationalIntegrity.complete)
      && (!gate.requireZeroModelMismatches
        || operationalIntegrity.readerModelMismatches + operationalIntegrity.judgeModelMismatches === 0)
      && (!gate.requireZeroSelfJudgments || operationalIntegrity.selfJudgments === 0),
  };
  const decision = {
    recommended: Object.values(checks).every(Boolean),
    checks,
    combinedTokenIncreaseFraction,
    readerTemporalDirections,
  };
  const report = {
    status: operationalIntegrity.complete ? "completed" : "failed",
    protocol: PRODUCTION_PATH_E2E_PROTOCOL,
    generatedAt: new Date().toISOString(),
    preScoreRevision: revision,
    dataset: frozen.dataset,
    productionPath: frozen.manifest.productionPath,
    input: {
      contextManifestSha256: frozen.manifestSha256,
      cases: frozen.cases.length,
      naturalCases: naturalCases.length,
      temporalCases: temporalCases.length,
      temporalPairs: reports.temporal.pairs,
      uniquePromptsPerReader: frozen.contexts.size,
      caseArmContexts: frozen.cases.length * PRODUCTION_PATH_E2E_PROTOCOL.arms.length,
      contextValidation: frozen.manifest.validation,
    },
    reports,
    decision,
    recommendation: decision.recommended
      ? "Adopt query-aware dual-state recall for explicit historical and state-change questions while retaining current-only output elsewhere."
      : "Do not adopt the query-aware dual-state path because at least one frozen gate failed.",
    usage: usage(evaluations),
    operationalIntegrity,
    artifactHashes: {
      evaluationsSha256: sha256(await readFile(evaluationsPath, "utf8")),
    },
    caveats: [
      PRODUCTION_PATH_E2E_PROTOCOL.claimBoundary,
      "The weekly Memora panel has been used in prior development, so this is fresh answer evidence over frozen inputs rather than a pristine dataset holdout.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
