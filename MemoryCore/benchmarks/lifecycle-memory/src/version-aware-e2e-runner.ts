import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";
import { sourceRevision } from "./adaptive-runner.js";
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
import type {
  VersionAwareArm,
  VersionAwarePanel,
  VersionAwareSlice,
} from "./version-aware-context-protocol.js";
import type {
  VersionAwareContextEntry,
  VersionAwareManifestCase,
  VersionAwareReaderMessage,
} from "./version-aware-context.js";
import { VERSION_AWARE_E2E_PROTOCOL } from "./version-aware-e2e-protocol.js";

type AnswerMetrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof AnswerMetrics;
type BaselineArm = Exclude<VersionAwareArm, "version_aware_multistate">;

interface ContextManifest {
  protocolVersion: string;
  dataset: { revision: string };
  selection: {
    cases: number;
    naturalCases: number;
    capabilityCases: number;
    scenarios: number;
  };
  cases: VersionAwareManifestCase[];
  contexts: VersionAwareContextEntry[];
  deduplication: {
    caseArmContexts: number;
    uniquePromptsPerReader: number;
    exactPromptReuseOnly: boolean;
  };
  execution: Record<string, unknown>;
  validation: { passed: boolean } & Record<string, unknown>;
  productionPath: Record<string, unknown>;
  claimBoundary: string;
}

interface FrozenCase {
  manifest: VersionAwareManifestCase;
  question: LifecycleEvalQuestion;
}

export interface VersionAwareEvaluation {
  protocolVersion: string;
  caseId: string;
  panel: VersionAwarePanel;
  slice: VersionAwareSlice;
  contextHash: string;
  readerId: string;
  judgeId: string;
  recalledMemoryIds: string[];
  injectedTokens: number;
  answer: string;
  reader: DirectJudgeResponse;
  readerAttempts: number;
  judge: DirectJudgeResponse;
  judgeAttempts: number;
  verdicts: CriterionVerdict[];
  metrics: AnswerMetrics;
}

interface ContextMetrics {
  exactSelection: number;
  expectedStateRecall: number;
  contaminationRate: number;
}

interface PanelArm {
  metrics: AnswerMetrics;
  cells: Record<string, AnswerMetrics>;
  contextMetrics: ContextMetrics;
  contextHash: string;
  recalledMemoryIds: string[];
  injectedTokens: number;
  recallMs: number;
}

export interface VersionAwarePanelCase {
  caseId: string;
  panel: VersionAwarePanel;
  slice: VersionAwareSlice;
  groupId: string;
  persona: string;
  task: string;
  expectedMemoryIds: string[];
  arms: Record<VersionAwareArm, PanelArm>;
}

export interface VersionAwareE2EOptions {
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
  messages: VersionAwareReaderMessage[];
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= VERSION_AWARE_E2E_PROTOCOL.retries; attempt += 1) {
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
    if (attempt < VERSION_AWARE_E2E_PROTOCOL.retries) await delay(retryDelay(lastError, attempt));
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
  for (let attempt = 1; attempt <= VERSION_AWARE_E2E_PROTOCOL.retries; attempt += 1) {
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
    if (attempt < VERSION_AWARE_E2E_PROTOCOL.retries) await delay(retryDelay(lastError, attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadFrozen(options: VersionAwareE2EOptions) {
  const [manifestText, loaded] = await Promise.all([
    readFile(options.contextManifest, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const manifestSha256 = sha256(manifestText);
  if (manifestSha256 !== VERSION_AWARE_E2E_PROTOCOL.context.sha256) {
    throw new Error(`version-aware context hash mismatch: ${manifestSha256}`);
  }
  const manifest = JSON.parse(manifestText) as ContextManifest;
  const expected = VERSION_AWARE_E2E_PROTOCOL.context;
  if (manifest.protocolVersion !== expected.protocolVersion
    || manifest.cases.length !== expected.cases
    || manifest.contexts.length !== expected.uniquePromptsPerReader
    || manifest.selection.cases !== expected.cases
    || manifest.selection.naturalCases !== expected.naturalCases
    || manifest.selection.capabilityCases !== expected.capabilityCases
    || manifest.selection.scenarios !== expected.scenarios
    || manifest.deduplication.caseArmContexts !== expected.caseArmContexts
    || manifest.deduplication.uniquePromptsPerReader !== expected.uniquePromptsPerReader
    || !manifest.deduplication.exactPromptReuseOnly) {
    throw new Error("version-aware frozen context identity mismatch");
  }
  if (!manifest.validation.passed) throw new Error("version-aware context validation failed");
  if (loaded.description.revision !== manifest.dataset.revision) {
    throw new Error("version-aware dataset revision mismatch");
  }
  const publicQuestions = new Map(loaded.groups.flatMap((group) => group.questions)
    .map((question) => [question.id, question]));
  const cases: FrozenCase[] = manifest.cases.map((item) => {
    if (!item.question || item.question.id !== item.caseId) throw new Error(`missing frozen question ${item.caseId}`);
    if (item.panel === "natural_safety") {
      const publicQuestion = publicQuestions.get(item.caseId);
      if (!publicQuestion || JSON.stringify(publicQuestion) !== JSON.stringify(item.question)) {
        throw new Error(`public question drift for ${item.caseId}`);
      }
    }
    return { manifest: item, question: item.question };
  });
  const contexts = new Map(manifest.contexts.map((item) => [item.hash, item]));
  if (contexts.size !== manifest.contexts.length) throw new Error("duplicate version-aware context hash");
  for (const item of manifest.cases) {
    for (const arm of VERSION_AWARE_E2E_PROTOCOL.arms) {
      const context = contexts.get(item.arms[arm]);
      if (!context || context.caseId !== item.caseId) throw new Error(`missing context ${item.caseId}/${arm}`);
      if (sha256(JSON.stringify(context.messages)) !== context.hash) {
        throw new Error(`message hash mismatch ${item.caseId}/${arm}`);
      }
    }
  }
  return { dataset: loaded.description, manifest, manifestSha256, cases, contexts };
}

function evaluationKey(item: Pick<VersionAwareEvaluation, "contextHash" | "readerId">): string {
  return `${item.contextHash}\0${item.readerId}`;
}

async function existing(file: string): Promise<VersionAwareEvaluation[]> {
  try {
    const entries = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as VersionAwareEvaluation);
    if (entries.some((item) => item.protocolVersion !== VERSION_AWARE_E2E_PROTOCOL.protocolVersion)) {
      throw new Error("output contains another version-aware protocol");
    }
    if (new Set(entries.map(evaluationKey)).size !== entries.length) {
      throw new Error("output contains duplicate version-aware evaluations");
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function evaluateContext(params: {
  frozen: FrozenCase;
  context: VersionAwareContextEntry;
  reader: DirectJudgeSpec;
  apiKeys: Map<string, string>;
}): Promise<VersionAwareEvaluation> {
  const reader = await callReader({
    spec: params.reader,
    apiKey: params.apiKeys.get(params.reader.id)!,
    messages: params.context.messages,
  });
  const judgeId = VERSION_AWARE_E2E_PROTOCOL.judgeAssignment[params.reader.id];
  const judgeSpec = VERSION_AWARE_E2E_PROTOCOL.judges.find((item) => item.id === judgeId)!;
  const judge = await callJudge({
    spec: judgeSpec,
    apiKey: params.apiKeys.get(judgeId)!,
    answer: reader.response.content,
    question: params.frozen.question,
  });
  return {
    protocolVersion: VERSION_AWARE_E2E_PROTOCOL.protocolVersion,
    caseId: params.frozen.manifest.caseId,
    panel: params.frozen.manifest.panel,
    slice: params.frozen.manifest.slice,
    contextHash: params.context.hash,
    readerId: params.reader.id,
    judgeId,
    recalledMemoryIds: params.context.recalledMemoryIds,
    injectedTokens: params.context.injectedTokens,
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

function contextMetrics(actual: string[], expected: string[]): ContextMetrics {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const matches = expected.filter((id) => actualSet.has(id)).length;
  const foreign = actual.filter((id) => !expectedSet.has(id)).length;
  return {
    exactSelection: actualSet.size === expectedSet.size && matches === expectedSet.size ? 1 : 0,
    expectedStateRecall: expected.length ? matches / expected.length : (actual.length === 0 ? 1 : 0),
    contaminationRate: foreign > 0 ? 1 : 0,
  };
}

function buildPanelCases(
  frozen: FrozenCase[],
  contexts: Map<string, VersionAwareContextEntry>,
  evaluations: Map<string, VersionAwareEvaluation>,
): VersionAwarePanelCase[] {
  return frozen.map(({ manifest }) => ({
    caseId: manifest.caseId,
    panel: manifest.panel,
    slice: manifest.slice,
    groupId: manifest.groupId,
    persona: manifest.persona,
    task: manifest.task,
    expectedMemoryIds: manifest.expectedVersionAwareMemoryIds,
    arms: Object.fromEntries(VERSION_AWARE_E2E_PROTOCOL.arms.map((arm): [VersionAwareArm, PanelArm] => {
      const contextHash = manifest.arms[arm];
      const context = contexts.get(contextHash)!;
      const cells = VERSION_AWARE_E2E_PROTOCOL.readers.map((reader) => {
        const evaluation = evaluations.get(`${contextHash}\0${reader.id}`);
        if (!evaluation) throw new Error(`missing evaluation ${contextHash}/${reader.id}`);
        return evaluation;
      });
      return [arm, {
        metrics: crossedMean(cells.map((item) => item.metrics)),
        cells: Object.fromEntries(cells.map((item) => [item.readerId, item.metrics])),
        contextMetrics: contextMetrics(context.recalledMemoryIds, manifest.expectedVersionAwareMemoryIds),
        contextHash,
        recalledMemoryIds: context.recalledMemoryIds,
        injectedTokens: context.injectedTokens,
        recallMs: context.elapsedMs,
      }];
    })) as Record<VersionAwareArm, PanelArm>,
  }));
}

export function aggregateArm(cases: VersionAwarePanelCase[], arm: VersionAwareArm) {
  return {
    cases: cases.length,
    mpa: mean(cases.map((item) => item.arms[arm].metrics.mpa)),
    faa: mean(cases.map((item) => item.arms[arm].metrics.faa)),
    fama: mean(cases.map((item) => item.arms[arm].metrics.fama)),
    criterionAccuracy: mean(cases.map((item) => item.arms[arm].metrics.criterionAccuracy)),
    exactSelectionAccuracy: mean(cases.map((item) => item.arms[arm].contextMetrics.exactSelection)),
    expectedStateRecall: mean(cases.map((item) => item.arms[arm].contextMetrics.expectedStateRecall)),
    contaminationRate: mean(cases.map((item) => item.arms[arm].contextMetrics.contaminationRate)),
    meanInjectedTokens: mean(cases.map((item) => item.arms[arm].injectedTokens)),
    meanInjectedItems: mean(cases.map((item) => item.arms[arm].recalledMemoryIds.length)),
    meanRecallMs: mean(cases.map((item) => item.arms[arm].recallMs)),
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

export function clusteredBootstrap(params: {
  cases: VersionAwarePanelCase[];
  left: VersionAwareArm;
  right: VersionAwareArm;
  metric: Metric;
  seed: number;
}): BootstrapInterval {
  if (!params.cases.length) return { mean: 0, lower: 0, upper: 0, clusters: 0 };
  const groupIds = [...new Set(params.cases.map((item) => item.groupId))].sort();
  const clusters = groupIds.map((groupId) => params.cases.filter((item) => item.groupId === groupId));
  const delta = (item: VersionAwarePanelCase) =>
    item.arms[params.left].metrics[params.metric] - item.arms[params.right].metrics[params.metric];
  const observed = mean(params.cases.map(delta));
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < VERSION_AWARE_E2E_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: VersionAwarePanelCase[] = [];
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

function comparison(cases: VersionAwarePanelCase[], baseline: BaselineArm, seedOffset: number) {
  return Object.fromEntries(([
    "mpa",
    "faa",
    "fama",
    "criterionAccuracy",
  ] as Metric[]).map((metric, index) => [
    metric,
    clusteredBootstrap({
      cases,
      left: "version_aware_multistate",
      right: baseline,
      metric,
      seed: VERSION_AWARE_E2E_PROTOCOL.seed + seedOffset + index,
    }),
  ])) as Record<Metric, BootstrapInterval>;
}

function readerDirections(cases: VersionAwarePanelCase[], baseline: BaselineArm, metric: Metric) {
  return Object.fromEntries(VERSION_AWARE_E2E_PROTOCOL.readers.map((reader) => [
    reader.id,
    mean(cases.map((item) => item.arms.version_aware_multistate.cells[reader.id][metric]
      - item.arms[baseline].cells[reader.id][metric])),
  ]));
}

function outcomeCounts(cases: VersionAwarePanelCase[], baseline: BaselineArm, metric: Metric) {
  const deltas = cases.map((item) =>
    item.arms.version_aware_multistate.metrics[metric] - item.arms[baseline].metrics[metric]);
  return {
    cases: cases.length,
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
  };
}

function subsetReport(cases: VersionAwarePanelCase[], seedOffset: number) {
  const baselines: BaselineArm[] = ["global_latest", "old_current_dual"];
  return {
    cases: cases.length,
    arms: Object.fromEntries(VERSION_AWARE_E2E_PROTOCOL.arms.map((arm) => [arm, aggregateArm(cases, arm)])),
    comparisons: Object.fromEntries(baselines.map((baseline, index) => [
      `vs_${baseline}`,
      comparison(cases, baseline, seedOffset + index * 20),
    ])),
    readerDirections: Object.fromEntries(baselines.map((baseline) => [
      `vs_${baseline}`,
      {
        fama: readerDirections(cases, baseline, "fama"),
        criterionAccuracy: readerDirections(cases, baseline, "criterionAccuracy"),
      },
    ])),
    outcomes: Object.fromEntries(baselines.map((baseline) => [
      `vs_${baseline}`,
      {
        fama: outcomeCounts(cases, baseline, "fama"),
        criterionAccuracy: outcomeCounts(cases, baseline, "criterionAccuracy"),
      },
    ])),
  };
}

function usage(evaluations: VersionAwareEvaluation[]) {
  return {
    readers: Object.fromEntries(VERSION_AWARE_E2E_PROTOCOL.readers.map((spec) => {
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
    judges: Object.fromEntries(VERSION_AWARE_E2E_PROTOCOL.judges.map((spec) => {
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

function integrity(evaluations: VersionAwareEvaluation[], expected: number) {
  return {
    evaluations: evaluations.length,
    expectedEvaluations: expected,
    complete: evaluations.length === expected,
    readerCalls: evaluations.length,
    judgeCalls: evaluations.length,
    readerRetries: evaluations.reduce((sum, item) => sum + item.readerAttempts - 1, 0),
    judgeRetries: evaluations.reduce((sum, item) => sum + item.judgeAttempts - 1, 0),
    readerModelMismatches: evaluations.filter((item) =>
      item.reader.model !== VERSION_AWARE_E2E_PROTOCOL.readers.find((spec) => spec.id === item.readerId)!.model).length,
    judgeModelMismatches: evaluations.filter((item) =>
      item.judge.model !== VERSION_AWARE_E2E_PROTOCOL.judges.find((spec) => spec.id === item.judgeId)!.model).length,
    selfJudgments: evaluations.filter((item) => item.readerId === item.judgeId).length,
    unclearVerdicts: evaluations.reduce((sum, item) =>
      sum + item.verdicts.filter((verdict) => verdict.answer === "unclear").length, 0),
  };
}

function ratioIncrease(left: number, right: number): number {
  if (right === 0) return left === 0 ? 0 : Number.POSITIVE_INFINITY;
  return left / right - 1;
}

function interval(report: any, baseline: BaselineArm, metric: Metric): BootstrapInterval {
  return report.comparisons[`vs_${baseline}`][metric];
}

export async function runVersionAwareE2E(options: VersionAwareE2EOptions): Promise<Record<string, any>> {
  const frozen = await loadFrozen(options);
  const revision = await sourceRevision();
  const apiKeys = new Map<string, string>();
  for (const spec of [...VERSION_AWARE_E2E_PROTOCOL.readers, ...VERSION_AWARE_E2E_PROTOCOL.judges]) {
    const value = process.env[spec.apiKeyEnv];
    if (!value) throw new Error(`${spec.apiKeyEnv} is required for version-aware evaluation`);
    apiKeys.set(spec.id, value);
  }
  await mkdir(options.outputDir, { recursive: true });
  const evaluationsPath = path.join(options.outputDir, "evaluations.jsonl");
  const completed = await existing(evaluationsPath);
  const completedByKey = new Map(completed.map((item) => [evaluationKey(item), item]));
  const frozenByCase = new Map(frozen.cases.map((item) => [item.question.id, item]));
  const tasks = frozen.manifest.contexts.flatMap((context) =>
    VERSION_AWARE_E2E_PROTOCOL.readers.map((reader) => ({
      frozen: frozenByCase.get(context.caseId)!,
      context,
      reader,
    })));
  const allowed = new Set(tasks.map((item) => `${item.context.hash}\0${item.reader.id}`));
  if (completed.some((item) => !allowed.has(evaluationKey(item)))) {
    throw new Error("output contains an evaluation outside the frozen version-aware task set");
  }
  const remaining = tasks.filter((item) => !completedByKey.has(`${item.context.hash}\0${item.reader.id}`));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const results = await Promise.all(batch.map((item) => evaluateContext({ ...item, apiKeys })));
    await appendFile(evaluationsPath, `${results.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    for (const result of results) completedByKey.set(evaluationKey(result), result);
    process.stdout.write(`version-aware crossed evaluations ${completedByKey.size}/${tasks.length}\n`);
  }

  const evaluations = tasks.map((item) => {
    const result = completedByKey.get(`${item.context.hash}\0${item.reader.id}`);
    if (!result) throw new Error(`incomplete evaluation ${item.context.hash}/${item.reader.id}`);
    return result;
  });
  const cases = buildPanelCases(frozen.cases, frozen.contexts, completedByKey);
  const naturalCases = cases.filter((item) => item.panel === "natural_safety");
  const capabilityCases = cases.filter((item) => item.panel === "version_capability");
  const reports: Record<string, any> = {
    combined: subsetReport(cases, 0),
    natural: subsetReport(naturalCases, 1000),
    capability: {
      ...subsetReport(capabilityCases, 3000),
      bySlice: Object.fromEntries([...new Set(capabilityCases.map((item) => item.slice))].sort()
        .map((slice, index) => [
          slice,
          subsetReport(capabilityCases.filter((item) => item.slice === slice), 5000 + index * 200),
        ])),
    },
  };

  const operationalIntegrity = integrity(evaluations, VERSION_AWARE_E2E_PROTOCOL.reuse.expectedReaderCalls);
  const baselines: BaselineArm[] = ["global_latest", "old_current_dual"];
  const currentSlices: VersionAwareSlice[] = ["branch_current", "worktree_current", "parallel_task_current"];
  const crossStateSlices: VersionAwareSlice[] = ["branch_comparison", "migration", "regression"];
  const gate = VERSION_AWARE_E2E_PROTOCOL.gates;
  const candidateAggregate = reports.capability.arms.version_aware_multistate;
  const combinedTokenIncreases = Object.fromEntries(baselines.map((baseline) => [
    baseline,
    ratioIncrease(
      reports.combined.arms.version_aware_multistate.meanInjectedTokens,
      reports.combined.arms[baseline].meanInjectedTokens,
    ),
  ]));
  const capabilityDirections = Object.fromEntries(baselines.map((baseline) => [
    baseline,
    reports.capability.readerDirections[`vs_${baseline}`].criterionAccuracy,
  ]));
  const checks = {
    contextExactSelection: candidateAggregate.exactSelectionAccuracy >= gate.minVersionAwareContextExactSelection,
    contextContamination: candidateAggregate.contaminationRate <= gate.maxVersionAwareContextContaminationRate,
    capabilityVsGlobal: interval(reports.capability, "global_latest", "criterionAccuracy").mean
      >= gate.minCapabilityCriterionAccuracyDeltaVsGlobal,
    capabilityVsGlobalCi: !gate.requireCapabilityCiLowerAboveZero
      || interval(reports.capability, "global_latest", "criterionAccuracy").lower > 0,
    capabilityVsOldCurrentDual: interval(reports.capability, "old_current_dual", "criterionAccuracy").mean
      >= gate.minCapabilityCriterionAccuracyDeltaVsOldCurrentDual,
    capabilityVsOldCurrentDualCi: !gate.requireCapabilityCiLowerAboveZero
      || interval(reports.capability, "old_current_dual", "criterionAccuracy").lower > 0,
    currentSlices: currentSlices.every((slice) => baselines.every((baseline) =>
      interval(reports.capability.bySlice[slice], baseline, "criterionAccuracy").mean
        >= gate.minCurrentSliceCriterionAccuracyDelta)),
    crossStateSlices: crossStateSlices.every((slice) => baselines.every((baseline) =>
      interval(reports.capability.bySlice[slice], baseline, "criterionAccuracy").mean
        >= gate.minCrossStateSliceCriterionAccuracyDelta)),
    missingScope: baselines.every((baseline) =>
      interval(reports.capability.bySlice.missing_scope_abstention, baseline, "criterionAccuracy").mean
        >= gate.minMissingScopeCriterionAccuracyDelta),
    naturalNonInferiority: baselines.every((baseline) =>
      interval(reports.natural, baseline, "fama").mean >= gate.minNaturalFamaDelta),
    combinedTokenBudget: baselines.every((baseline) =>
      combinedTokenIncreases[baseline] <= gate.maxCombinedTokenIncreaseFraction),
    readerDirection: !gate.requireNonnegativeCapabilityDirectionForBothReaders
      || baselines.every((baseline) =>
        Object.values(capabilityDirections[baseline] as Record<string, number>).every((value) => value >= 0)),
    contextIntegrity: !gate.requirePassedProductionContext || frozen.manifest.validation.passed,
    evaluationIntegrity: (!gate.requireCompleteFrozenTaskSet || operationalIntegrity.complete)
      && (!gate.requireZeroModelMismatches
        || operationalIntegrity.readerModelMismatches + operationalIntegrity.judgeModelMismatches === 0)
      && (!gate.requireZeroSelfJudgments || operationalIntegrity.selfJudgments === 0),
  };
  const decision = {
    recommended: Object.values(checks).every(Boolean),
    checks,
    combinedTokenIncreases,
    capabilityDirections,
  };
  const report = {
    status: operationalIntegrity.complete ? "completed" : "failed",
    protocol: VERSION_AWARE_E2E_PROTOCOL,
    generatedAt: new Date().toISOString(),
    preScoreRevision: revision,
    dataset: frozen.dataset,
    productionPath: frozen.manifest.productionPath,
    input: {
      contextManifestSha256: frozen.manifestSha256,
      cases: frozen.cases.length,
      naturalCases: naturalCases.length,
      capabilityCases: capabilityCases.length,
      scenarios: frozen.manifest.selection.scenarios,
      uniquePromptsPerReader: frozen.contexts.size,
      caseArmContexts: frozen.manifest.deduplication.caseArmContexts,
      contextExecution: frozen.manifest.execution,
      contextValidation: frozen.manifest.validation,
    },
    reports,
    decision,
    recommendation: decision.recommended
      ? "Adopt version-aware multi-state recall for branch, worktree, and parallel-task execution, retaining labelled multi-state output only for explicit comparison/migration/regression/history queries."
      : "Do not promote version-aware multi-state recall because at least one frozen effectiveness or safety gate failed.",
    usage: usage(evaluations),
    operationalIntegrity,
    artifactHashes: {
      evaluationsSha256: sha256(await readFile(evaluationsPath, "utf8")),
    },
    caveats: [
      VERSION_AWARE_E2E_PROTOCOL.claimBoundary,
      "The 40 public Memora questions are a frozen reused safety panel, not a pristine holdout; capability claims come from the separately identified controlled programming-state panel.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
