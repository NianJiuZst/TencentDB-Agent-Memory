import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";
import { EVIDENCE_SHIELD_E2E_PROTOCOL } from "./evidence-shield-e2e-protocol.js";
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

type Arm = "v1" | "shield";
type AnswerMetrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof AnswerMetrics;

interface FrozenSelection {
  protocolVersion: string;
  selected: Array<{
    caseId: string;
    groupId: string;
    persona: string;
    task: string;
    comparatorCandidateIds: string[];
  }>;
}

interface ShieldContextManifest {
  protocolVersion: string;
  selectionSha256: string;
  datasetRevision: string;
  cases: Array<{
    caseId: string;
    groupId: string;
    v1CandidateIds: string[];
    shieldCandidates: RetrievedUnit[];
  }>;
}

interface SelectedCase {
  question: LifecycleEvalQuestion;
  v1CandidateIds: string[];
  shieldCandidates: RetrievedUnit[];
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
  arm: string;
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
  cells: Record<string, AnswerMetrics>;
}

interface PanelCase {
  caseId: string;
  persona: string;
  task: string;
  arms: Record<Arm, PanelArm>;
}

export interface EvidenceShieldE2ERunOptions {
  dataRoot: string;
  selection: string;
  contextManifest: string;
  v1Evaluations: string;
  v1Validation: string;
  outputDir: string;
  concurrency?: number;
  skipHashVerification?: boolean;
  limit?: number;
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

function crossModelMean(cells: Array<{
  readerId: string;
  judgeId: string;
  metrics: AnswerMetrics;
}>): AnswerMetrics {
  const cross = cells.filter((cell) => cell.readerId !== cell.judgeId);
  if (cross.length !== 2 || new Set(cross.map((cell) => cell.readerId)).size !== 2) {
    throw new Error("evidence-shield primary requires one crossed judgment per reader");
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
  for (let attempt = 1; attempt <= EVIDENCE_SHIELD_E2E_PROTOCOL.retries; attempt += 1) {
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
    if (attempt < EVIDENCE_SHIELD_E2E_PROTOCOL.retries) await delay(500 * 2 ** (attempt - 1));
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
  for (let attempt = 1; attempt <= EVIDENCE_SHIELD_E2E_PROTOCOL.retries; attempt += 1) {
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
    if (attempt < EVIDENCE_SHIELD_E2E_PROTOCOL.retries) await delay(500 * 2 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function evaluationKey(item: Pick<ArmEvaluation, "caseId" | "readerId">): string {
  return `${item.caseId}\0${item.readerId}`;
}

async function loadSelected(options: EvidenceShieldE2ERunOptions): Promise<{
  dataset: Awaited<ReturnType<typeof loadMemora>>["description"];
  selected: SelectedCase[];
  input: Record<string, unknown>;
}> {
  const [selectionText, manifestText, v1Text, validationText, loaded] = await Promise.all([
    readFile(options.selection, "utf8"),
    readFile(options.contextManifest, "utf8"),
    readFile(options.v1Evaluations, "utf8"),
    readFile(options.v1Validation, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const selectionHash = sha256(selectionText);
  const manifestHash = sha256(manifestText);
  const v1Hash = sha256(v1Text);
  const validationHash = sha256(validationText);
  if (selectionHash !== EVIDENCE_SHIELD_E2E_PROTOCOL.selection.sha256) {
    throw new Error(`evidence-shield answer selection hash mismatch: ${selectionHash}`);
  }
  if (manifestHash !== EVIDENCE_SHIELD_E2E_PROTOCOL.contextManifest.sha256) {
    throw new Error(`evidence-shield context manifest hash mismatch: ${manifestHash}`);
  }
  if (v1Hash !== EVIDENCE_SHIELD_E2E_PROTOCOL.reusedV1Evaluations.sha256) {
    throw new Error(`evidence-shield reused V1 hash mismatch: ${v1Hash}`);
  }
  if (validationHash !== EVIDENCE_SHIELD_E2E_PROTOCOL.reusedV1Evaluations.validationSha256) {
    throw new Error(`evidence-shield reused V1 validation hash mismatch: ${validationHash}`);
  }
  const validation = JSON.parse(validationText) as { status?: string };
  if (validation.status !== EVIDENCE_SHIELD_E2E_PROTOCOL.reusedV1Evaluations.requiredValidationStatus) {
    throw new Error("evidence-shield reused V1 evaluations did not pass independent validation");
  }
  const selection = JSON.parse(selectionText) as FrozenSelection;
  const manifest = JSON.parse(manifestText) as ShieldContextManifest;
  if (selection.protocolVersion !== EVIDENCE_SHIELD_E2E_PROTOCOL.selection.protocolVersion) {
    throw new Error("evidence-shield answer selection protocol mismatch");
  }
  if (manifest.protocolVersion !== EVIDENCE_SHIELD_E2E_PROTOCOL.candidateProtocolVersion
    || manifest.selectionSha256 !== selectionHash
    || manifest.datasetRevision !== loaded.description.revision) {
    throw new Error("evidence-shield context manifest provenance mismatch");
  }
  if (selection.selected.length !== EVIDENCE_SHIELD_E2E_PROTOCOL.selection.cases
    || manifest.cases.length !== EVIDENCE_SHIELD_E2E_PROTOCOL.contextManifest.cases) {
    throw new Error("evidence-shield answer case count mismatch");
  }
  const manifestById = new Map(manifest.cases.map((item) => [item.caseId, item]));
  const groups = new Map(loaded.groups.map((group) => [group.id, group]));
  const selected = selection.selected.map((entry): SelectedCase => {
    const group = groups.get(entry.groupId);
    if (!group) throw new Error(`missing evidence-shield answer group ${entry.groupId}`);
    const question = group.questions.find((item) => item.id === entry.caseId);
    if (!question) throw new Error(`missing evidence-shield answer question ${entry.caseId}`);
    const context = manifestById.get(entry.caseId);
    if (!context || context.groupId !== entry.groupId) {
      throw new Error(`missing evidence-shield answer context ${entry.caseId}`);
    }
    if (context.v1CandidateIds.join("\0") !== entry.comparatorCandidateIds.join("\0")
      || context.shieldCandidates.map((item) => item.id).join("\0")
        !== entry.comparatorCandidateIds.join("\0")) {
      throw new Error(`evidence-shield answer candidate identity mismatch ${entry.caseId}`);
    }
    return {
      question,
      v1CandidateIds: entry.comparatorCandidateIds,
      shieldCandidates: context.shieldCandidates,
    };
  });
  const v1Rows = v1Text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ArmEvaluation);
  if (v1Rows.length !== EVIDENCE_SHIELD_E2E_PROTOCOL.reusedV1Evaluations.totalRows) {
    throw new Error("evidence-shield reused V1 total row mismatch");
  }
  return {
    dataset: loaded.description,
    selected: options.limit ? selected.slice(0, options.limit) : selected,
    input: {
      selectionSha256: selectionHash,
      contextManifestSha256: manifestHash,
      reusedV1EvaluationsSha256: v1Hash,
      reusedV1ValidationSha256: validationHash,
      reusedV1Rows: v1Rows.filter((item) => item.arm === "v1"),
    },
  };
}

async function existing(file: string): Promise<ArmEvaluation[]> {
  try {
    const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as ArmEvaluation);
    if (rows.some((item) => item.protocolVersion !== EVIDENCE_SHIELD_E2E_PROTOCOL.protocolVersion
      || item.arm !== "shield")) {
      throw new Error("evidence-shield output contains another protocol or arm");
    }
    if (new Set(rows.map(evaluationKey)).size !== rows.length) {
      throw new Error("evidence-shield output contains duplicate evaluations");
    }
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function evaluateShield(params: {
  selected: SelectedCase;
  reader: DirectJudgeSpec;
  apiKeys: Map<string, string>;
}): Promise<ArmEvaluation> {
  const readerCall = await callWithRetries({
    spec: params.reader,
    apiKey: params.apiKeys.get(params.reader.id)!,
    messages: readerMessages(params.selected.question, params.selected.shieldCandidates),
    responseFormat: "text",
  });
  const judges = await Promise.all(EVIDENCE_SHIELD_E2E_PROTOCOL.judges.map(async (spec) => [
    spec.id,
    await evaluateJudge({
      spec,
      apiKey: params.apiKeys.get(spec.id)!,
      answer: readerCall.response.content,
      criteria: params.selected.question.evaluationQuestions,
    }),
  ] as const));
  return {
    protocolVersion: EVIDENCE_SHIELD_E2E_PROTOCOL.protocolVersion,
    caseId: params.selected.question.id,
    groupId: params.selected.question.groupId,
    persona: params.selected.question.persona,
    period: params.selected.question.period,
    task: params.selected.question.task,
    readerId: params.reader.id,
    arm: "shield",
    candidateIds: params.selected.shieldCandidates.map((item) => item.id),
    injectedTokens: params.selected.shieldCandidates.reduce((sum, item) => sum + item.tokenCount, 0),
    answer: readerCall.response.content,
    reader: readerCall.response,
    readerAttempts: readerCall.attempts,
    judges: Object.fromEntries(judges),
  };
}

function buildPanelCases(
  selected: SelectedCase[],
  v1Evaluations: ArmEvaluation[],
  shieldEvaluations: ArmEvaluation[],
): PanelCase[] {
  const byArm = {
    v1: new Map(v1Evaluations.map((item) => [evaluationKey(item), item])),
    shield: new Map(shieldEvaluations.map((item) => [evaluationKey(item), item])),
  };
  return selected.map((item): PanelCase => ({
    caseId: item.question.id,
    persona: item.question.persona,
    task: item.question.task,
    arms: Object.fromEntries(EVIDENCE_SHIELD_E2E_PROTOCOL.arms.map((arm): [Arm, PanelArm] => {
      const evaluations = EVIDENCE_SHIELD_E2E_PROTOCOL.readers.map((reader) => {
        const evaluation = byArm[arm].get(`${item.question.id}\0${reader.id}`);
        if (!evaluation) throw new Error(`missing evidence-shield panel cell ${item.question.id}/${reader.id}/${arm}`);
        return evaluation;
      });
      const cells = evaluations.flatMap((evaluation) =>
        EVIDENCE_SHIELD_E2E_PROTOCOL.judges.map((judge) => ({
          readerId: evaluation.readerId,
          judgeId: judge.id,
          metrics: evaluation.judges[judge.id].metrics,
        }))
      );
      const tokenCounts = new Set(evaluations.map((evaluation) => evaluation.injectedTokens));
      if (tokenCounts.size !== 1) throw new Error("evidence-shield reader token mismatch");
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
    const values = byPersona.get(item.persona) ?? [];
    values.push(item);
    byPersona.set(item.persona, values);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: PanelCase) =>
    item.arms.shield[params.mode][params.metric] - item.arms.v1[params.mode][params.metric];
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < EVIDENCE_SHIELD_E2E_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
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

function comparison(cases: PanelCase[], mode: "primary" | "fullFactorial", seedOffset: number) {
  return Object.fromEntries((["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]).map(
    (metric, index) => [metric, bootstrap({
      cases,
      metric,
      mode,
      seed: EVIDENCE_SHIELD_E2E_PROTOCOL.seed + seedOffset + index,
    })],
  )) as Record<Metric, BootstrapInterval>;
}

function perReaderFama(cases: PanelCase[]) {
  return Object.fromEntries(EVIDENCE_SHIELD_E2E_PROTOCOL.readers.map((reader) => {
    const judge = EVIDENCE_SHIELD_E2E_PROTOCOL.judges.find((item) => item.id !== reader.id)!;
    const key = `${reader.id}->${judge.id}`;
    return [reader.id, mean(cases.map((item) =>
      item.arms.shield.cells[key].fama - item.arms.v1.cells[key].fama
    ))];
  }));
}

export function evaluateShieldAnswerGate(params: {
  shieldVsV1: Record<Metric, BootstrapInterval>;
  v1MeanInjectedTokens: number;
  shieldMeanInjectedTokens: number;
  perReaderFamaDelta: Record<string, number>;
}) {
  const gate = EVIDENCE_SHIELD_E2E_PROTOCOL.gate;
  const checks = {
    famaDirection: !gate.requirePositiveShieldVsV1FamaDelta || params.shieldVsV1.fama.mean > 0,
    faaMagnitude: params.shieldVsV1.faa.mean >= gate.minShieldVsV1FaaDelta,
    mpaNonInferiority: params.shieldVsV1.mpa.mean >= -gate.maxShieldVsV1MpaLoss,
    tokenBudget: params.shieldMeanInjectedTokens <= params.v1MeanInjectedTokens
      * (1 + gate.maxMeanInjectedTokenIncreaseFraction),
    perReaderFamaDirection: !gate.requireNonnegativeFamaDirectionForEachReader
      || Object.values(params.perReaderFamaDelta).every((value) => value >= 0),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

function integrity(evaluations: ArmEvaluation[]) {
  let readerRetries = 0;
  let judgeRetries = 0;
  let readerModelMismatches = 0;
  let judgeModelMismatches = 0;
  let unclearVerdicts = 0;
  for (const item of evaluations) {
    readerRetries += item.readerAttempts - 1;
    const reader = EVIDENCE_SHIELD_E2E_PROTOCOL.readers.find((spec) => spec.id === item.readerId)!;
    readerModelMismatches += Number(item.reader.model !== reader.model);
    for (const judge of EVIDENCE_SHIELD_E2E_PROTOCOL.judges) {
      const result = item.judges[judge.id];
      judgeRetries += result.attempts - 1;
      judgeModelMismatches += Number(result.response.model !== judge.model);
      unclearVerdicts += result.verdicts.filter((verdict) => verdict.answer === "unclear").length;
    }
  }
  return {
    readerArmEvaluations: evaluations.length,
    readerCalls: evaluations.length,
    judgeCalls: evaluations.length * EVIDENCE_SHIELD_E2E_PROTOCOL.judges.length,
    readerRetries,
    judgeRetries,
    readerModelMismatches,
    judgeModelMismatches,
    unclearVerdicts,
  };
}

export async function runEvidenceShieldE2E(
  options: EvidenceShieldE2ERunOptions,
): Promise<Record<string, unknown>> {
  const loaded = await loadSelected(options);
  const reusedV1 = (loaded.input.reusedV1Rows as ArmEvaluation[]).filter((item) =>
    loaded.selected.some((selected) => selected.question.id === item.caseId)
  );
  delete loaded.input.reusedV1Rows;
  if (reusedV1.length !== loaded.selected.length * EVIDENCE_SHIELD_E2E_PROTOCOL.readers.length
    || reusedV1.some((item) => item.protocolVersion
      !== EVIDENCE_SHIELD_E2E_PROTOCOL.reusedV1Evaluations.protocolVersion || item.arm !== "v1")) {
    throw new Error("evidence-shield reused V1 selected rows mismatch");
  }
  const selectedById = new Map(loaded.selected.map((item) => [item.question.id, item]));
  for (const item of reusedV1) {
    const selected = selectedById.get(item.caseId)!;
    if (item.candidateIds.join("\0") !== selected.v1CandidateIds.join("\0")) {
      throw new Error(`evidence-shield reused V1 candidate mismatch ${evaluationKey(item)}`);
    }
  }

  const apiKeys = new Map<string, string>();
  for (const spec of [...EVIDENCE_SHIELD_E2E_PROTOCOL.readers, ...EVIDENCE_SHIELD_E2E_PROTOCOL.judges]) {
    const value = process.env[spec.apiKeyEnv];
    if (!value) throw new Error(`${spec.apiKeyEnv} is required for ${spec.id}`);
    apiKeys.set(spec.id, value);
  }
  await mkdir(options.outputDir, { recursive: true });
  const evaluationsPath = path.join(options.outputDir, "evaluations.jsonl");
  const completed = await existing(evaluationsPath);
  const completedByKey = new Map(completed.map((item) => [evaluationKey(item), item]));
  const tasks = loaded.selected.flatMap((selected) =>
    EVIDENCE_SHIELD_E2E_PROTOCOL.readers.map((reader) => ({ selected, reader }))
  );
  const allowed = new Set(tasks.map((item) => `${item.selected.question.id}\0${item.reader.id}`));
  if (completed.some((item) => !allowed.has(evaluationKey(item)))) {
    throw new Error("evidence-shield output contains an evaluation outside the frozen task set");
  }
  const remaining = tasks.filter((item) => !completedByKey.has(
    `${item.selected.question.id}\0${item.reader.id}`,
  ));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 4));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const results = await Promise.all(batch.map((item) => evaluateShield({ ...item, apiKeys })));
    await appendFile(evaluationsPath, `${results.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    for (const result of results) completedByKey.set(evaluationKey(result), result);
    process.stdout.write(`evidence shield E2E ${completedByKey.size}/${tasks.length}\n`);
  }
  const shield = tasks.map((item) => {
    const result = completedByKey.get(`${item.selected.question.id}\0${item.reader.id}`);
    if (!result) throw new Error("incomplete evidence-shield answer result");
    return result;
  });
  const cases = buildPanelCases(loaded.selected, reusedV1, shield);
  const primary = {
    arms: {
      v1: aggregateArm(cases, "v1", "primary"),
      shield: aggregateArm(cases, "shield", "primary"),
    },
    shieldVsV1: comparison(cases, "primary", 0),
  };
  const fullFactorialSensitivity = {
    arms: {
      v1: aggregateArm(cases, "v1", "fullFactorial"),
      shield: aggregateArm(cases, "shield", "fullFactorial"),
    },
    shieldVsV1: comparison(cases, "fullFactorial", 100),
  };
  const perReaderFamaDelta = perReaderFama(cases);
  const gate = evaluateShieldAnswerGate({
    shieldVsV1: primary.shieldVsV1,
    v1MeanInjectedTokens: primary.arms.v1.meanInjectedTokens,
    shieldMeanInjectedTokens: primary.arms.shield.meanInjectedTokens,
    perReaderFamaDelta,
  });
  const report = {
    status: gate.passed ? "passed" : "failed",
    nextAction: gate.passed ? "qualify_for_new_data_confirmation" : "reject_candidate_and_continue_direction_search",
    protocol: EVIDENCE_SHIELD_E2E_PROTOCOL,
    generatedAt: new Date().toISOString(),
    dataset: loaded.dataset,
    input: { ...loaded.input, cases: loaded.selected.length },
    primary,
    fullFactorialSensitivity,
    perReaderFamaDelta,
    operationalIntegrity: {
      newShieldCalls: integrity(shield),
      reusedV1Evaluations: reusedV1.length,
      reusedV1Validation: "passed",
    },
    gate,
    caveats: [
      "This panel reuses the already validated V1 arm and generates only the shield arm under identical reader and judge specifications.",
      "The frozen 50 cases are now development data; a pass cannot establish a new confirmatory result or promote the candidate.",
      "The primary crossed aggregation reduces self-judging but uses only two fixed model families.",
      "Any candidate that passes still requires a new public update/abstention split before the paper can claim generalization.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
