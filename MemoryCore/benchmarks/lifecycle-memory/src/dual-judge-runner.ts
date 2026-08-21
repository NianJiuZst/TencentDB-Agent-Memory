import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import protocolJson from "../protocol.dual-judge.v2.1.json" with { type: "json" };
import { loadMemora } from "./adapter.js";
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
import type { BootstrapInterval, EvaluationCriterion } from "./types.js";

type AnswerMetrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof AnswerMetrics;
type Arm = "base" | "adaptive";

interface DualJudgeProtocol {
  protocolVersion: string;
  supersedes: string;
  changeReason: string;
  sourceProtocolVersion: string;
  sourceCasesSha256: string;
  seed: number;
  judges: DirectJudgeSpec[];
  retries: number;
  reuseFrozenReaderAnswers: boolean;
  aggregation: {
    primary: string;
    twoJudgeDisagreement: string;
    sensitivity: string;
  };
  uncertainty: { unit: "persona"; bootstrapSamples: number };
  gate: {
    minFamaDelta: number;
    minFaaDelta: number;
    requireFamaCiLowerAboveZero: boolean;
    requirePositiveFamaDeltaForEveryJudge: boolean;
  };
}

const DUAL_PROTOCOL = protocolJson as DualJudgeProtocol;

interface SourceCase {
  caseId: string;
  persona: string;
  period: string;
  task: string;
  arms: Record<Arm, { answer: string }>;
}

interface JudgeEvaluation {
  response: DirectJudgeResponse;
  verdicts: CriterionVerdict[];
  metrics: AnswerMetrics;
  attempts: number;
}

interface PanelEvaluation {
  metrics: AnswerMetrics;
  unanimousVerdicts: CriterionVerdict[];
  unanimousMetrics: AnswerMetrics;
  agreementCount: number;
  criterionCount: number;
}

interface DualJudgedArm {
  arm: Arm;
  panel: PanelEvaluation;
  judges: Record<string, JudgeEvaluation>;
}

interface DualJudgedCase {
  protocolVersion: string;
  caseId: string;
  persona: string;
  period: string;
  task: string;
  arms: Record<Arm, DualJudgedArm>;
}

export interface DualJudgeOptions {
  dataRoot: string;
  inputCases: string;
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

function meanMetrics(metrics: AnswerMetrics[]): AnswerMetrics {
  return {
    mpa: mean(metrics.map((item) => item.mpa)),
    faa: mean(metrics.map((item) => item.faa)),
    fama: mean(metrics.map((item) => item.fama)),
    criterionAccuracy: mean(metrics.map((item) => item.criterionAccuracy)),
  };
}

export function buildTwoJudgePanel(
  criteria: EvaluationCriterion[],
  judgeVerdicts: CriterionVerdict[][],
): PanelEvaluation {
  if (judgeVerdicts.length !== 2) throw new Error("two-judge panel requires exactly two verdict lists");
  const unanimousVerdicts = criteria.map((criterion, index): CriterionVerdict => {
    const votes = judgeVerdicts.map((verdicts) => verdicts[index]);
    const agreed = votes[0]?.answer === votes[1]?.answer
      && (votes[0]?.answer === "yes" || votes[0]?.answer === "no");
    const answer = agreed ? votes[0].answer : "unclear";
    return {
      id: criterion.id,
      answer,
      confidence: mean(votes.map((vote) => vote?.confidence ?? 0)),
      expectedAnswer: criterion.expectedAnswer,
      type: criterion.type,
      correct: answer === criterion.expectedAnswer,
    };
  });
  const agreementCount = criteria.reduce((count, _criterion, index) =>
    count + Number(judgeVerdicts[0]?.[index]?.answer === judgeVerdicts[1]?.[index]?.answer), 0);
  return {
    metrics: meanMetrics(judgeVerdicts.map((verdicts) => scoreAnswer(verdicts))),
    unanimousVerdicts,
    unanimousMetrics: scoreAnswer(unanimousVerdicts),
    agreementCount,
    criterionCount: criteria.length,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function evaluateJudge(
  spec: DirectJudgeSpec,
  apiKey: string,
  answer: string,
  criteria: EvaluationCriterion[],
): Promise<JudgeEvaluation> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DUAL_PROTOCOL.retries; attempt += 1) {
    try {
      const response = await callDirectJudge({
        spec,
        apiKey,
        messages: judgeMessages(answer, criteria),
      });
      try {
        const verdicts = parseJudge(response.content, criteria);
        return { response, verdicts, metrics: scoreAnswer(verdicts), attempts: attempt };
      } catch (error) {
        lastError = error;
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableJudgeError(error)) throw error;
    }
    if (attempt < DUAL_PROTOCOL.retries) await delay(500 * 2 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function evaluateArm(
  apiKeys: Map<string, string>,
  answer: string,
  criteria: EvaluationCriterion[],
  arm: Arm,
): Promise<DualJudgedArm> {
  const evaluations = await Promise.all(DUAL_PROTOCOL.judges.map(async (spec) => {
    const apiKey = apiKeys.get(spec.id);
    if (!apiKey) throw new Error(`missing API key for judge ${spec.id}`);
    return { spec, evaluation: await evaluateJudge(spec, apiKey, answer, criteria) };
  }));
  return {
    arm,
    panel: buildTwoJudgePanel(criteria, evaluations.map((item) => item.evaluation.verdicts)),
    judges: Object.fromEntries(evaluations.map((item) => [item.spec.id, item.evaluation])),
  };
}

async function existing(file: string): Promise<DualJudgedCase[]> {
  try {
    const parsed = (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as DualJudgedCase);
    if (parsed.some((item) => item.protocolVersion !== DUAL_PROTOCOL.protocolVersion)) {
      throw new Error("output directory contains results from a different protocol version");
    }
    if (new Set(parsed.map((item) => item.caseId)).size !== parsed.length) {
      throw new Error("output directory contains duplicate case ids");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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

function bootstrap(
  cases: DualJudgedCase[],
  value: (item: DualJudgedCase, arm: Arm) => number,
  seed: number,
): BootstrapInterval {
  const byPersona = new Map<string, DualJudgedCase[]>();
  for (const item of cases) {
    const entries = byPersona.get(item.persona) ?? [];
    entries.push(item);
    byPersona.set(item.persona, entries);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: DualJudgedCase) => value(item, "adaptive") - value(item, "base");
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < DUAL_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: DualJudgedCase[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    draws.push(mean(selected.map(delta)));
  }
  draws.sort((left, right) => left - right);
  return {
    mean: mean(cases.map(delta)),
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}

function aggregateArm(
  cases: DualJudgedCase[],
  arm: Arm,
  value: (item: DualJudgedCase, arm: Arm, metric: Metric) => number,
): Record<Metric | "cases", number> {
  return {
    cases: cases.length,
    mpa: mean(cases.map((item) => value(item, arm, "mpa"))),
    faa: mean(cases.map((item) => value(item, arm, "faa"))),
    fama: mean(cases.map((item) => value(item, arm, "fama"))),
    criterionAccuracy: mean(cases.map((item) => value(item, arm, "criterionAccuracy"))),
  };
}

function compare(
  cases: DualJudgedCase[],
  value: (item: DualJudgedCase, arm: Arm, metric: Metric) => number,
  seedOffset: number,
): Record<Metric, BootstrapInterval> {
  return {
    mpa: bootstrap(cases, (item, arm) => value(item, arm, "mpa"), DUAL_PROTOCOL.seed + seedOffset),
    faa: bootstrap(cases, (item, arm) => value(item, arm, "faa"), DUAL_PROTOCOL.seed + seedOffset + 1),
    fama: bootstrap(cases, (item, arm) => value(item, arm, "fama"), DUAL_PROTOCOL.seed + seedOffset + 2),
    criterionAccuracy: bootstrap(
      cases,
      (item, arm) => value(item, arm, "criterionAccuracy"),
      DUAL_PROTOCOL.seed + seedOffset + 3,
    ),
  };
}

function agreement(cases: DualJudgedCase[], arm?: Arm) {
  const arms: Arm[] = arm ? [arm] : ["base", "adaptive"];
  const [leftJudge, rightJudge] = DUAL_PROTOCOL.judges.map((spec) => spec.id);
  const categories = ["yes", "no", "unclear"] as const;
  const leftCounts = new Map(categories.map((answer) => [answer, 0]));
  const rightCounts = new Map(categories.map((answer) => [answer, 0]));
  let votes = 0;
  let exact = 0;
  for (const item of cases) {
    for (const selectedArm of arms) {
      const left = item.arms[selectedArm].judges[leftJudge].verdicts;
      const right = item.arms[selectedArm].judges[rightJudge].verdicts;
      if (left.length !== right.length) throw new Error(`judge verdict length mismatch for ${item.caseId}`);
      for (let index = 0; index < left.length; index += 1) {
        votes += 1;
        exact += Number(left[index].answer === right[index].answer);
        leftCounts.set(left[index].answer, (leftCounts.get(left[index].answer) ?? 0) + 1);
        rightCounts.set(right[index].answer, (rightCounts.get(right[index].answer) ?? 0) + 1);
      }
    }
  }
  const rate = votes ? exact / votes : 0;
  const chanceAgreement = votes
    ? categories.reduce((sum, answer) =>
      sum + ((leftCounts.get(answer) ?? 0) / votes) * ((rightCounts.get(answer) ?? 0) / votes), 0)
    : 0;
  const cohensKappa = chanceAgreement < 1 ? (rate - chanceAgreement) / (1 - chanceAgreement) : 1;
  return {
    votes,
    exact,
    rate,
    cohensKappa,
    marginals: {
      [leftJudge]: Object.fromEntries(categories.map((answer) => [answer, leftCounts.get(answer) ?? 0])),
      [rightJudge]: Object.fromEntries(categories.map((answer) => [answer, rightCounts.get(answer) ?? 0])),
    },
  };
}

function usage(cases: DualJudgedCase[], judgeId: string) {
  const evaluations = cases.flatMap((item) => [
    item.arms.base.judges[judgeId],
    item.arms.adaptive.judges[judgeId],
  ]);
  return {
    calls: evaluations.length,
    promptTokens: evaluations.reduce((sum, item) => sum + item.response.usage.promptTokens, 0),
    completionTokens: evaluations.reduce((sum, item) => sum + item.response.usage.completionTokens, 0),
    totalTokens: evaluations.reduce((sum, item) => sum + item.response.usage.totalTokens, 0),
    retries: evaluations.reduce((sum, item) => sum + item.attempts - 1, 0),
    meanLatencyMs: mean(evaluations.map((item) => item.response.latencyMs)),
  };
}

function subgroupReport(
  cases: DualJudgedCase[],
  value: (item: DualJudgedCase, arm: Arm, metric: Metric) => number,
) {
  return Object.fromEntries([...new Set(cases.map((item) => item.task))].sort().map((task) => {
    const selected = cases.filter((item) => item.task === task);
    const base = aggregateArm(selected, "base", value);
    const adaptive = aggregateArm(selected, "adaptive", value);
    return [task, {
      cases: selected.length,
      base,
      adaptive,
      delta: Object.fromEntries((["mpa", "faa", "fama", "criterionAccuracy"] as Metric[])
        .map((metric) => [metric, adaptive[metric] - base[metric]])),
    }];
  }));
}

function personaHeterogeneity(
  cases: DualJudgedCase[],
  value: (item: DualJudgedCase, arm: Arm, metric: Metric) => number,
) {
  const effects = [...new Set(cases.map((item) => item.persona))].sort().map((persona) => {
    const selected = cases.filter((item) => item.persona === persona);
    return {
      persona,
      cases: selected.length,
      famaDelta: mean(selected.map((item) => value(item, "adaptive", "fama") - value(item, "base", "fama"))),
    };
  });
  const sorted = effects.map((item) => item.famaDelta).sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[midpoint] : mean([sorted[midpoint - 1], sorted[midpoint]]);
  const leaveOneOut = effects.map((excluded) => ({
    excludedPersona: excluded.persona,
    famaDelta: mean(effects.filter((item) => item.persona !== excluded.persona).map((item) => item.famaDelta)),
  }));
  return {
    positivePersonas: effects.filter((item) => item.famaDelta > 0).length,
    negativePersonas: effects.filter((item) => item.famaDelta < 0).length,
    medianPersonaFamaDelta: median,
    minLeaveOnePersonaOutFamaDelta: Math.min(...leaveOneOut.map((item) => item.famaDelta)),
    maxLeaveOnePersonaOutFamaDelta: Math.max(...leaveOneOut.map((item) => item.famaDelta)),
    effects,
    leaveOneOut,
  };
}

export async function runDualJudge(options: DualJudgeOptions): Promise<Record<string, any>> {
  const inputText = await readFile(options.inputCases, "utf8");
  const inputHash = sha256(inputText);
  if (inputHash !== DUAL_PROTOCOL.sourceCasesSha256) {
    throw new Error(`source cases hash mismatch: expected ${DUAL_PROTOCOL.sourceCasesSha256}, got ${inputHash}`);
  }
  const sourceCases = inputText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SourceCase);
  if (new Set(sourceCases.map((item) => item.caseId)).size !== sourceCases.length) {
    throw new Error("source cases contain duplicate ids");
  }
  const loaded = await loadMemora(options.dataRoot, !options.skipHashVerification);
  const questions = new Map(loaded.groups.flatMap((group) => group.questions).map((question) => [question.id, question]));
  const apiKeys = new Map<string, string>();
  for (const spec of DUAL_PROTOCOL.judges) {
    const apiKey = process.env[spec.apiKeyEnv];
    if (!apiKey) throw new Error(`${spec.apiKeyEnv} is required for judge ${spec.id}`);
    apiKeys.set(spec.id, apiKey);
  }

  await mkdir(options.outputDir, { recursive: true });
  const casesPath = path.join(options.outputDir, "cases.jsonl");
  const completed = await existing(casesPath);
  const sourceIds = new Set(sourceCases.map((item) => item.caseId));
  if (completed.some((item) => !sourceIds.has(item.caseId))) {
    throw new Error("output directory contains a case outside the frozen source set");
  }
  const completedIds = new Set(completed.map((item) => item.caseId));
  const remaining = sourceCases.filter((item) => !completedIds.has(item.caseId));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (item): Promise<DualJudgedCase> => {
      const question = questions.get(item.caseId);
      if (!question) throw new Error(`missing evaluation question ${item.caseId}`);
      const [base, adaptive] = await Promise.all([
        evaluateArm(apiKeys, item.arms.base.answer, question.evaluationQuestions, "base"),
        evaluateArm(apiKeys, item.arms.adaptive.answer, question.evaluationQuestions, "adaptive"),
      ]);
      return {
        protocolVersion: DUAL_PROTOCOL.protocolVersion,
        caseId: item.caseId,
        persona: item.persona,
        period: item.period,
        task: item.task,
        arms: { base, adaptive },
      };
    }));
    await appendFile(casesPath, `${results.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    completed.push(...results);
    process.stdout.write(`dual-judged ${completed.length}/${sourceCases.length} cases\n`);
  }

  const cases = completed.filter((item) => sourceIds.has(item.caseId));
  if (cases.length !== sourceCases.length) throw new Error("incomplete dual-judge results");
  const panelValue = (item: DualJudgedCase, arm: Arm, metric: Metric) => item.arms[arm].panel.metrics[metric];
  const unanimousValue = (item: DualJudgedCase, arm: Arm, metric: Metric) =>
    item.arms[arm].panel.unanimousMetrics[metric];
  const panelComparison = compare(cases, panelValue, 1);
  const individual = Object.fromEntries(DUAL_PROTOCOL.judges.map((spec, index) => {
    const judgeValue = (item: DualJudgedCase, arm: Arm, metric: Metric) =>
      item.arms[arm].judges[spec.id].metrics[metric];
    return [spec.id, {
      base: aggregateArm(cases, "base", judgeValue),
      adaptive: aggregateArm(cases, "adaptive", judgeValue),
      comparisonVsBase: compare(cases, judgeValue, 20 + index * 10),
      usage: usage(cases, spec.id),
    }];
  }));
  const individualFamaPositive = DUAL_PROTOCOL.judges.every((spec) =>
    individual[spec.id].comparisonVsBase.fama.mean > 0);
  const checks = {
    famaDelta: panelComparison.fama.mean >= DUAL_PROTOCOL.gate.minFamaDelta,
    faaDelta: panelComparison.faa.mean >= DUAL_PROTOCOL.gate.minFaaDelta,
    famaCi: !DUAL_PROTOCOL.gate.requireFamaCiLowerAboveZero || panelComparison.fama.lower > 0,
    individualJudgeFamaDirection: !DUAL_PROTOCOL.gate.requirePositiveFamaDeltaForEveryJudge
      || individualFamaPositive,
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: DUAL_PROTOCOL,
    generatedAt: new Date().toISOString(),
    dataset: loaded.description,
    sourceCases: { path: options.inputCases, sha256: inputHash, cases: sourceCases.length },
    primaryPanel: {
      base: aggregateArm(cases, "base", panelValue),
      adaptive: aggregateArm(cases, "adaptive", panelValue),
      comparisonVsBase: panelComparison,
    },
    subgroupByTask: subgroupReport(cases, panelValue),
    personaHeterogeneity: personaHeterogeneity(cases, panelValue),
    individualJudges: individual,
    agreement: {
      overall: agreement(cases),
      base: agreement(cases, "base"),
      adaptive: agreement(cases, "adaptive"),
    },
    unanimousSensitivity: {
      base: aggregateArm(cases, "base", unanimousValue),
      adaptive: aggregateArm(cases, "adaptive", unanimousValue),
      comparisonVsBase: compare(cases, unanimousValue, 100),
    },
    gate: { passed: Object.values(checks).every(Boolean), checks },
    caveats: [
      "Reader answers and the frozen 50-case sample are reused exactly from lifecycle-adaptive-e2e-v1.1; only judges change.",
      "The two-judge panel is fixed rather than sampled from a population of judges; confidence intervals cluster personas, not judge identities.",
      "Evaluation criteria are batched per answer, so this is not identical to Memora Table 3 evaluation.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
