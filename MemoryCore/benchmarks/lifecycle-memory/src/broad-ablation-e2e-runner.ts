import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";
import { BROAD_ABLATION_E2E_PROTOCOL } from "./broad-ablation-e2e-protocol.js";
import type { BroadAblationArm } from "./broad-ablation-context-protocol.js";
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
import type {
  BootstrapInterval,
  LifecycleEvalQuestion,
  RetrievedUnit,
} from "./types.js";

type AnswerMetrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof AnswerMetrics;

interface ContextManifestCase {
  caseId: string;
  groupId: string;
  persona: string;
  period: string;
  task: string;
  queryIntent: string;
  forgettingBearing: boolean;
  baseStaleExposed: boolean;
  evaluationCriteria: number;
  arms: Record<BroadAblationArm, string>;
}

interface ContextManifestEntry {
  hash: string;
  caseId: string;
  candidateIds: string[];
  injectedTokens: number;
  candidates: RetrievedUnit[];
}

interface ContextManifest {
  protocolVersion: string;
  dataset: { revision: string };
  cases: ContextManifestCase[];
  contexts: ContextManifestEntry[];
  deduplication: { uniquePromptsPerReader: number };
  fallbackValidation: { passed: boolean };
}

interface FrozenCase {
  manifest: ContextManifestCase;
  question: LifecycleEvalQuestion;
}

interface CrossedEvaluation {
  protocolVersion: string;
  caseId: string;
  contextHash: string;
  readerId: string;
  judgeId: string;
  candidateIds: string[];
  injectedTokens: number;
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
  candidateIds: string[];
  injectedTokens: number;
}

interface PanelCase {
  caseId: string;
  persona: string;
  task: string;
  forgettingBearing: boolean;
  baseStaleExposed: boolean;
  arms: Record<BroadAblationArm, PanelArm>;
}

export interface BroadAblationE2EOptions {
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

export function crossedCaseMean(metrics: AnswerMetrics[]): AnswerMetrics {
  if (metrics.length !== 2) throw new Error(`D16 expected two crossed cells, found ${metrics.length}`);
  return {
    mpa: mean(metrics.map((item) => item.mpa)),
    faa: mean(metrics.map((item) => item.faa)),
    fama: mean(metrics.map((item) => item.fama)),
    criterionAccuracy: mean(metrics.map((item) => item.criterionAccuracy)),
  };
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

async function pacedDirectCall(params: Parameters<typeof callDirectJudge>[0]): Promise<DirectJudgeResponse> {
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
  question: LifecycleEvalQuestion;
  candidates: RetrievedUnit[];
}): Promise<{ response: DirectJudgeResponse; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BROAD_ABLATION_E2E_PROTOCOL.retries; attempt += 1) {
    try {
      return {
        response: await pacedDirectCall({
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
    if (attempt < BROAD_ABLATION_E2E_PROTOCOL.retries) await delay(retryDelay(lastError, attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callJudge(params: {
  spec: DirectJudgeSpec;
  apiKey: string;
  answer: string;
  question: LifecycleEvalQuestion;
}): Promise<{
  response: DirectJudgeResponse;
  attempts: number;
  verdicts: CriterionVerdict[];
  metrics: AnswerMetrics;
}> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BROAD_ABLATION_E2E_PROTOCOL.retries; attempt += 1) {
    try {
      const response = await pacedDirectCall({
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
    if (attempt < BROAD_ABLATION_E2E_PROTOCOL.retries) await delay(retryDelay(lastError, attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadFrozen(options: BroadAblationE2EOptions): Promise<{
  dataset: Awaited<ReturnType<typeof loadMemora>>["description"];
  manifest: ContextManifest;
  manifestSha256: string;
  cases: FrozenCase[];
  contexts: Map<string, ContextManifestEntry>;
}> {
  const [manifestText, loaded] = await Promise.all([
    readFile(options.contextManifest, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const manifestSha256 = sha256(manifestText);
  if (manifestSha256 !== BROAD_ABLATION_E2E_PROTOCOL.context.sha256) {
    throw new Error(`D16 context hash mismatch: ${manifestSha256}`);
  }
  const manifest = JSON.parse(manifestText) as ContextManifest;
  if (manifest.protocolVersion !== BROAD_ABLATION_E2E_PROTOCOL.context.protocolVersion) {
    throw new Error(`D16 context protocol mismatch: ${manifest.protocolVersion}`);
  }
  if (manifest.cases.length !== BROAD_ABLATION_E2E_PROTOCOL.context.cases) {
    throw new Error(`D16 frozen case count mismatch: ${manifest.cases.length}`);
  }
  if (manifest.contexts.length !== BROAD_ABLATION_E2E_PROTOCOL.context.uniquePromptsPerReader) {
    throw new Error(`D16 frozen prompt count mismatch: ${manifest.contexts.length}`);
  }
  if (!manifest.fallbackValidation.passed) throw new Error("D16 context fallback validation did not pass");
  if (loaded.description.revision !== manifest.dataset.revision) {
    throw new Error(`D16 dataset revision mismatch: ${loaded.description.revision}`);
  }
  const questions = new Map(loaded.groups.flatMap((group) => group.questions).map((item) => [item.id, item]));
  const cases = manifest.cases.map((item) => {
    const question = questions.get(item.caseId);
    if (!question) throw new Error(`D16 missing frozen question ${item.caseId}`);
    if (question.evaluationQuestions.length !== item.evaluationCriteria) {
      throw new Error(`D16 evaluation criteria drift for ${item.caseId}`);
    }
    return { manifest: item, question };
  });
  const contexts = new Map(manifest.contexts.map((item) => [item.hash, item]));
  if (contexts.size !== manifest.contexts.length) throw new Error("D16 duplicate context hashes");
  for (const item of manifest.cases) {
    for (const arm of BROAD_ABLATION_E2E_PROTOCOL.arms) {
      const context = contexts.get(item.arms[arm]);
      if (!context || context.caseId !== item.caseId) throw new Error(`D16 missing context ${item.caseId}/${arm}`);
    }
  }
  return { dataset: loaded.description, manifest, manifestSha256, cases, contexts };
}

function evaluationKey(item: Pick<CrossedEvaluation, "contextHash" | "readerId">): string {
  return `${item.contextHash}\0${item.readerId}`;
}

async function existing(file: string): Promise<CrossedEvaluation[]> {
  try {
    const entries = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as CrossedEvaluation);
    if (entries.some((item) => item.protocolVersion !== BROAD_ABLATION_E2E_PROTOCOL.protocolVersion)) {
      throw new Error("D16 output contains another protocol version");
    }
    if (new Set(entries.map(evaluationKey)).size !== entries.length) {
      throw new Error("D16 output contains duplicate crossed evaluations");
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
}): Promise<CrossedEvaluation> {
  const reader = await callReader({
    spec: params.reader,
    apiKey: params.apiKeys.get(params.reader.id)!,
    question: params.frozen.question,
    candidates: params.context.candidates,
  });
  const judgeId = BROAD_ABLATION_E2E_PROTOCOL.judgeAssignment[params.reader.id];
  const judgeSpec = BROAD_ABLATION_E2E_PROTOCOL.judges.find((item) => item.id === judgeId)!;
  const judge = await callJudge({
    spec: judgeSpec,
    apiKey: params.apiKeys.get(judgeSpec.id)!,
    answer: reader.response.content,
    question: params.frozen.question,
  });
  return {
    protocolVersion: BROAD_ABLATION_E2E_PROTOCOL.protocolVersion,
    caseId: params.frozen.question.id,
    contextHash: params.context.hash,
    readerId: params.reader.id,
    judgeId,
    candidateIds: params.context.candidateIds,
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

function buildPanelCases(
  frozenCases: FrozenCase[],
  contexts: Map<string, ContextManifestEntry>,
  evaluations: Map<string, CrossedEvaluation>,
): PanelCase[] {
  return frozenCases.map(({ manifest }) => ({
    caseId: manifest.caseId,
    persona: manifest.persona,
    task: manifest.task,
    forgettingBearing: manifest.forgettingBearing,
    baseStaleExposed: manifest.baseStaleExposed,
    arms: Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.arms.map((arm): [BroadAblationArm, PanelArm] => {
      const contextHash = manifest.arms[arm];
      const context = contexts.get(contextHash)!;
      const cells = BROAD_ABLATION_E2E_PROTOCOL.readers.map((reader) => {
        const evaluation = evaluations.get(`${contextHash}\0${reader.id}`);
        if (!evaluation) throw new Error(`D16 missing evaluation ${contextHash}/${reader.id}`);
        return evaluation;
      });
      return [arm, {
        metrics: crossedCaseMean(cells.map((item) => item.metrics)),
        cells: Object.fromEntries(cells.map((item) => [`${item.readerId}->${item.judgeId}`, item.metrics])),
        contextHash,
        candidateIds: context.candidateIds,
        injectedTokens: context.injectedTokens,
      }];
    })) as Record<BroadAblationArm, PanelArm>,
  }));
}

function aggregateArm(cases: PanelCase[], arm: BroadAblationArm) {
  return {
    cases: cases.length,
    mpa: mean(cases.map((item) => item.arms[arm].metrics.mpa)),
    faa: mean(cases.map((item) => item.arms[arm].metrics.faa)),
    fama: mean(cases.map((item) => item.arms[arm].metrics.fama)),
    criterionAccuracy: mean(cases.map((item) => item.arms[arm].metrics.criterionAccuracy)),
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

export function clusteredBootstrap(params: {
  cases: PanelCase[];
  left: BroadAblationArm;
  right: BroadAblationArm;
  metric: Metric;
  seed: number;
}): BootstrapInterval {
  if (!params.cases.length) return { mean: 0, lower: 0, upper: 0, clusters: 0 };
  const byPersona = new Map<string, PanelCase[]>();
  for (const item of params.cases) {
    const entries = byPersona.get(item.persona) ?? [];
    entries.push(item);
    byPersona.set(item.persona, entries);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: PanelCase) =>
    item.arms[params.left].metrics[params.metric] - item.arms[params.right].metrics[params.metric];
  const observed = mean(params.cases.map(delta));
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < BROAD_ABLATION_E2E_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: PanelCase[] = [];
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

function comparison(cases: PanelCase[], left: BroadAblationArm, right: BroadAblationArm, seedOffset: number) {
  return Object.fromEntries(((["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]).map((metric, index) => [
    metric,
    clusteredBootstrap({
      cases,
      left,
      right,
      metric,
      seed: BROAD_ABLATION_E2E_PROTOCOL.seed + seedOffset + index,
    }),
  ]))) as Record<Metric, BootstrapInterval>;
}

export function outcomeCounts(
  cases: PanelCase[],
  left: BroadAblationArm,
  right: BroadAblationArm,
) {
  const deltas = cases.map((item) => item.arms[left].metrics.fama - item.arms[right].metrics.fama);
  return {
    cases: cases.length,
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
  };
}

function subsetReport(cases: PanelCase[], seedOffset: number) {
  return {
    cases: cases.length,
    arms: Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.arms.map((arm) => [arm, aggregateArm(cases, arm)])),
    comparisonsVsV1: Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.arms
      .filter((arm) => arm !== "v1")
      .map((arm, index) => [arm, comparison(cases, arm, "v1", seedOffset + index * 10)])),
    comparisonsVsBase: Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.arms
      .filter((arm) => arm !== "base")
      .map((arm, index) => [arm, comparison(cases, arm, "base", seedOffset + 200 + index * 10)])),
  };
}

function usage(evaluations: CrossedEvaluation[]) {
  return {
    readers: Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.readers.map((spec) => {
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
    judges: Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.judges.map((spec) => {
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

function integrity(evaluations: CrossedEvaluation[], expected: number) {
  return {
    evaluations: evaluations.length,
    expectedEvaluations: expected,
    complete: evaluations.length === expected,
    readerCalls: evaluations.length,
    judgeCalls: evaluations.length,
    readerRetries: evaluations.reduce((sum, item) => sum + item.readerAttempts - 1, 0),
    judgeRetries: evaluations.reduce((sum, item) => sum + item.judgeAttempts - 1, 0),
    readerModelMismatches: evaluations.filter((item) => {
      const expectedSpec = BROAD_ABLATION_E2E_PROTOCOL.readers.find((spec) => spec.id === item.readerId)!;
      return item.reader.model !== expectedSpec.model;
    }).length,
    judgeModelMismatches: evaluations.filter((item) => {
      const expectedSpec = BROAD_ABLATION_E2E_PROTOCOL.judges.find((spec) => spec.id === item.judgeId)!;
      return item.judge.model !== expectedSpec.model;
    }).length,
    selfJudgments: evaluations.filter((item) => item.readerId === item.judgeId).length,
    unclearVerdicts: evaluations.reduce((sum, item) =>
      sum + item.verdicts.filter((verdict) => verdict.answer === "unclear").length, 0),
  };
}

export async function runBroadAblationE2E(
  options: BroadAblationE2EOptions,
): Promise<Record<string, any>> {
  const frozen = await loadFrozen(options);
  const apiKeys = new Map<string, string>();
  for (const spec of [...BROAD_ABLATION_E2E_PROTOCOL.readers, ...BROAD_ABLATION_E2E_PROTOCOL.judges]) {
    const value = process.env[spec.apiKeyEnv];
    if (!value) throw new Error(`${spec.apiKeyEnv} is required for D16 ${spec.id}`);
    apiKeys.set(spec.id, value);
  }
  await mkdir(options.outputDir, { recursive: true });
  const evaluationsPath = path.join(options.outputDir, "evaluations.jsonl");
  const completed = await existing(evaluationsPath);
  const completedByKey = new Map(completed.map((item) => [evaluationKey(item), item]));
  const frozenByCase = new Map(frozen.cases.map((item) => [item.question.id, item]));
  const tasks = frozen.manifest.contexts.flatMap((context) =>
    BROAD_ABLATION_E2E_PROTOCOL.readers.map((reader) => ({
      frozen: frozenByCase.get(context.caseId)!,
      context,
      reader,
    })));
  const allowed = new Set(tasks.map((item) => `${item.context.hash}\0${item.reader.id}`));
  if (completed.some((item) => !allowed.has(evaluationKey(item)))) {
    throw new Error("D16 output contains an evaluation outside the frozen task set");
  }
  const remaining = tasks.filter((item) => !completedByKey.has(`${item.context.hash}\0${item.reader.id}`));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const results = await Promise.all(batch.map((item) => evaluateContext({ ...item, apiKeys })));
    await appendFile(evaluationsPath, `${results.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    for (const result of results) completedByKey.set(evaluationKey(result), result);
    process.stdout.write(`D16 crossed evaluations ${completedByKey.size}/${tasks.length}\n`);
  }
  const evaluations = tasks.map((item) => {
    const result = completedByKey.get(`${item.context.hash}\0${item.reader.id}`);
    if (!result) throw new Error(`D16 incomplete evaluation ${item.context.hash}/${item.reader.id}`);
    return result;
  });
  const cases = buildPanelCases(frozen.cases, frozen.contexts, completedByKey);
  const reports = {
    fullPopulation: subsetReport(cases, 0),
    forgettingBearing: subsetReport(cases.filter((item) => item.forgettingBearing), 1000),
    baseStaleExposed: subsetReport(cases.filter((item) => item.baseStaleExposed), 2000),
    byTask: Object.fromEntries([...new Set(cases.map((item) => item.task))].sort().map((task, index) => [
      task,
      subsetReport(cases.filter((item) => item.task === task), 3000 + index * 500),
    ])),
    changedVsV1: Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.arms
      .filter((arm) => arm !== "v1")
      .map((arm, index) => {
        const selected = cases.filter((item) => item.arms[arm].contextHash !== item.arms.v1.contextHash);
        return [arm, {
          cases: selected.length,
          comparison: comparison(selected, arm, "v1", 5000 + index * 10),
          outcomes: outcomeCounts(selected, arm, "v1"),
        }];
      })),
  };
  const operationalIntegrity = integrity(evaluations, BROAD_ABLATION_E2E_PROTOCOL.reuse.expectedReaderCalls);
  const incumbent = reports.fullPopulation.arms.v1;
  const decisions = Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.arms
    .filter((arm) => arm !== "base" && arm !== "v1")
    .map((arm) => {
      const comparisonVsV1 = reports.fullPopulation.comparisonsVsV1[arm];
      const aggregate = reports.fullPopulation.arms[arm];
      const checks = {
        famaDelta: comparisonVsV1.fama.mean >= BROAD_ABLATION_E2E_PROTOCOL.promotionGate.minFullPopulationFamaDelta,
        famaCi: !BROAD_ABLATION_E2E_PROTOCOL.promotionGate.requireFamaCiLowerAboveZero
          || comparisonVsV1.fama.lower > 0,
        faaDelta: comparisonVsV1.faa.mean >= BROAD_ABLATION_E2E_PROTOCOL.promotionGate.minFullPopulationFaaDelta,
        mpaDelta: comparisonVsV1.mpa.mean >= BROAD_ABLATION_E2E_PROTOCOL.promotionGate.minFullPopulationMpaDelta,
        tokenBudget: aggregate.meanInjectedTokens <= incumbent.meanInjectedTokens
          * (1 + BROAD_ABLATION_E2E_PROTOCOL.promotionGate.maxMeanTokenIncreaseFraction),
        integrity: (!BROAD_ABLATION_E2E_PROTOCOL.promotionGate.requireZeroModelMismatches
          || operationalIntegrity.readerModelMismatches + operationalIntegrity.judgeModelMismatches === 0)
          && (!BROAD_ABLATION_E2E_PROTOCOL.promotionGate.requireCompleteFrozenTaskSet
            || operationalIntegrity.complete),
      };
      return [arm, {
        promoted: Object.values(checks).every(Boolean),
        checks,
        comparisonVsV1,
        outcomesVsV1: outcomeCounts(cases, arm, "v1"),
        meanTokenIncreaseFraction: aggregate.meanInjectedTokens / incumbent.meanInjectedTokens - 1,
      }];
    }));
  const promoted = Object.entries(decisions).filter(([, value]) => value.promoted).map(([arm]) => arm);
  const report = {
    status: operationalIntegrity.complete ? "completed" : "failed",
    protocol: BROAD_ABLATION_E2E_PROTOCOL,
    generatedAt: new Date().toISOString(),
    dataset: frozen.dataset,
    input: {
      contextManifestSha256: frozen.manifestSha256,
      cases: frozen.cases.length,
      uniquePromptsPerReader: frozen.contexts.size,
      caseArmCells: frozen.cases.length * BROAD_ABLATION_E2E_PROTOCOL.arms.length,
    },
    reports,
    v1ReplicationVsBase: reports.fullPopulation.comparisonsVsBase.v1,
    decisions,
    selectedPolicy: promoted.length ? promoted : ["v1"],
    usage: usage(evaluations),
    operationalIntegrity,
    artifactHashes: {
      evaluationsSha256: sha256(await readFile(evaluationsPath, "utf8")),
    },
    caveats: [
      BROAD_ABLATION_E2E_PROTOCOL.claimBoundary,
      "The 200 questions were not used by either prior answer-level panel, but quarterly Memora had already been observed during earlier proxy development.",
      "Only six cases expose obsolete evidence in Base top-5 under the released labels; full-population effects are therefore expected to be diluted and are the primary robustness estimate.",
      "Cross-model judging avoids self-judging, but it is not a substitute for blinded human correctness calibration.",
      "Simple baselines and ablations use the same frozen FTS candidate pool, prompt template, readers, crossed judges, criteria and case census.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
