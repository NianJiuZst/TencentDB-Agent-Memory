import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import protocolJson from "../protocol.rejudge.v1.json" with { type: "json" };
import { loadMemora } from "./adapter.js";
import {
  judgeMessages,
  parseJudge,
  scoreAnswer,
  type CriterionVerdict,
} from "./e2e-runner.js";
import { callOpenRouter, type ModelResponse } from "./openrouter.js";
import type { BootstrapInterval, EvaluationCriterion } from "./types.js";

interface RejudgeProtocol {
  protocolVersion: string;
  sourceProtocolVersion: string;
  sourceCasesSha256: string;
  seed: number;
  judges: string[];
  judgeTemperature: number;
  judgeMaxTokens: number;
  retries: number;
  consensus: string;
  reuseFrozenReaderAnswers: boolean;
  uncertainty: { unit: "persona"; bootstrapSamples: number };
  gate: { minFamaDelta: number; minFaaDelta: number; requireFamaCiLowerAboveZero: boolean };
}

const REJUDGE_PROTOCOL = protocolJson as RejudgeProtocol;
type Arm = "base" | "adaptive";

interface SourceCase {
  caseId: string;
  persona: string;
  period: string;
  task: string;
  arms: Record<Arm, { answer: string }>;
}

interface RejudgedArm {
  arm: Arm;
  verdicts: CriterionVerdict[];
  metrics: ReturnType<typeof scoreAnswer>;
  judges: Record<string, { response: ModelResponse; verdicts: CriterionVerdict[] }>;
}

interface RejudgedCase {
  caseId: string;
  persona: string;
  period: string;
  task: string;
  arms: Record<Arm, RejudgedArm>;
}

export interface RejudgeOptions {
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

function bootstrap(cases: RejudgedCase[], metric: keyof ReturnType<typeof scoreAnswer>, seed: number): BootstrapInterval {
  const byPersona = new Map<string, RejudgedCase[]>();
  for (const item of cases) {
    const entries = byPersona.get(item.persona) ?? [];
    entries.push(item);
    byPersona.set(item.persona, entries);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: RejudgedCase) => item.arms.adaptive.metrics[metric] - item.arms.base.metrics[metric];
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < REJUDGE_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: RejudgedCase[] = [];
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

function consensus(
  criteria: EvaluationCriterion[],
  judgeVerdicts: CriterionVerdict[][],
): CriterionVerdict[] {
  return criteria.map((criterion, index) => {
    const votes = judgeVerdicts.map((verdicts) => verdicts[index]);
    const yes = votes.filter((vote) => vote.answer === "yes").length;
    const no = votes.filter((vote) => vote.answer === "no").length;
    const answer = yes > judgeVerdicts.length / 2 ? "yes"
      : no > judgeVerdicts.length / 2 ? "no"
      : "unclear";
    return {
      id: criterion.id,
      answer,
      confidence: mean(votes.map((vote) => vote.confidence)),
      expectedAnswer: criterion.expectedAnswer,
      type: criterion.type,
      correct: answer === criterion.expectedAnswer,
    };
  });
}

async function evaluateArm(
  apiKey: string,
  answer: string,
  criteria: EvaluationCriterion[],
  arm: Arm,
): Promise<RejudgedArm> {
  const evaluated = await Promise.all(REJUDGE_PROTOCOL.judges.map(async (model, index) => {
    const response = await callOpenRouter({
      apiKey,
      model,
      messages: judgeMessages(answer, criteria),
      temperature: REJUDGE_PROTOCOL.judgeTemperature,
      maxTokens: REJUDGE_PROTOCOL.judgeMaxTokens,
      seed: REJUDGE_PROTOCOL.seed + index,
      retries: REJUDGE_PROTOCOL.retries,
      json: true,
    });
    return { model, response, verdicts: parseJudge(response.content, criteria) };
  }));
  const verdicts = consensus(criteria, evaluated.map((item) => item.verdicts));
  return {
    arm,
    verdicts,
    metrics: scoreAnswer(verdicts),
    judges: Object.fromEntries(evaluated.map((item) => [item.model, {
      response: item.response,
      verdicts: item.verdicts,
    }])),
  };
}

async function existing(file: string): Promise<RejudgedCase[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as RejudgedCase);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function runRejudge(options: RejudgeOptions): Promise<Record<string, unknown>> {
  const inputText = await readFile(options.inputCases, "utf8");
  const inputHash = sha256(inputText);
  if (inputHash !== REJUDGE_PROTOCOL.sourceCasesSha256) {
    throw new Error(`source cases hash mismatch: expected ${REJUDGE_PROTOCOL.sourceCasesSha256}, got ${inputHash}`);
  }
  const sourceCases = inputText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SourceCase);
  const loaded = await loadMemora(options.dataRoot, !options.skipHashVerification);
  const questions = new Map(loaded.groups.flatMap((group) => group.questions).map((question) => [question.id, question]));
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for rejudging");
  await mkdir(options.outputDir, { recursive: true });
  const casesPath = path.join(options.outputDir, "cases.jsonl");
  const completed = await existing(casesPath);
  const completedIds = new Set(completed.map((item) => item.caseId));
  const remaining = sourceCases.filter((item) => !completedIds.has(item.caseId));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (item): Promise<RejudgedCase> => {
      const question = questions.get(item.caseId);
      if (!question) throw new Error(`missing evaluation question ${item.caseId}`);
      const [base, adaptive] = await Promise.all([
        evaluateArm(apiKey, item.arms.base.answer, question.evaluationQuestions, "base"),
        evaluateArm(apiKey, item.arms.adaptive.answer, question.evaluationQuestions, "adaptive"),
      ]);
      return {
        caseId: item.caseId,
        persona: item.persona,
        period: item.period,
        task: item.task,
        arms: { base, adaptive },
      };
    }));
    await appendFile(casesPath, `${results.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    completed.push(...results);
    process.stdout.write(`rejudged ${completed.length}/${sourceCases.length} cases\n`);
  }
  const selectedIds = new Set(sourceCases.map((item) => item.caseId));
  const cases = completed.filter((item) => selectedIds.has(item.caseId));
  if (cases.length !== sourceCases.length) throw new Error("incomplete rejudge results");
  const aggregateArm = (arm: Arm) => ({
    cases: cases.length,
    mpa: mean(cases.map((item) => item.arms[arm].metrics.mpa)),
    faa: mean(cases.map((item) => item.arms[arm].metrics.faa)),
    fama: mean(cases.map((item) => item.arms[arm].metrics.fama)),
    criterionAccuracy: mean(cases.map((item) => item.arms[arm].metrics.criterionAccuracy)),
  });
  const comparison = {
    mpa: bootstrap(cases, "mpa", REJUDGE_PROTOCOL.seed + 1),
    faa: bootstrap(cases, "faa", REJUDGE_PROTOCOL.seed + 2),
    fama: bootstrap(cases, "fama", REJUDGE_PROTOCOL.seed + 3),
    criterionAccuracy: bootstrap(cases, "criterionAccuracy", REJUDGE_PROTOCOL.seed + 4),
  };
  const checks = {
    famaDelta: comparison.fama.mean >= REJUDGE_PROTOCOL.gate.minFamaDelta,
    faaDelta: comparison.faa.mean >= REJUDGE_PROTOCOL.gate.minFaaDelta,
    famaCi: !REJUDGE_PROTOCOL.gate.requireFamaCiLowerAboveZero || comparison.fama.lower > 0,
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: REJUDGE_PROTOCOL,
    generatedAt: new Date().toISOString(),
    dataset: loaded.description,
    sourceCases: { path: options.inputCases, sha256: inputHash, cases: sourceCases.length },
    aggregates: { base: aggregateArm("base"), adaptive: aggregateArm("adaptive") },
    comparisonVsBase: comparison,
    gate: { passed: Object.values(checks).every(Boolean), checks },
    caveats: [
      "Reader answers are reused exactly from lifecycle-adaptive-e2e-v1.1; only judges change.",
      "Judges are batched per answer, so this remains cheaper than and not identical to Memora Table 3 evaluation.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
