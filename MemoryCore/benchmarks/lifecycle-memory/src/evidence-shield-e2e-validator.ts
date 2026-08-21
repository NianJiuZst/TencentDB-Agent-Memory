import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";
import { normalizeEvidence } from "./semantics.js";

type Metric = "mpa" | "faa" | "fama" | "criterionAccuracy";
type Metrics = Record<Metric, number>;
type Arm = "v1" | "shield";

interface ValidatorOptions {
  dataRoot: string;
  v1Evaluations: string;
  shieldEvaluations: string;
  summary: string;
  output: string;
  bootstrapSamples?: number;
  seed?: number;
  skipHashVerification?: boolean;
}

interface CriterionTransition {
  total: number;
  sameCorrect: number;
  sameWrong: number;
  v1CorrectShieldWrong: number;
  v1WrongShieldCorrect: number;
  netCorrectDelta: number;
}

const METRICS: Metric[] = ["mpa", "faa", "fama", "criterionAccuracy"];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-12;
}

function score(verdicts: Array<Record<string, any>>): Metrics {
  const presence = verdicts.filter((item) => item.type === "memory_presence");
  const forgetting = verdicts.filter((item) => item.type === "forgetting_absence");
  const mpa = presence.length ? presence.filter((item) => item.correct).length / presence.length : 0;
  const faa = forgetting.length ? forgetting.filter((item) => item.correct).length / forgetting.length : 1;
  const lambda = verdicts.length ? forgetting.length / verdicts.length : 0;
  return {
    mpa,
    faa,
    fama: Math.max(0, mpa - lambda * (1 - faa)),
    criterionAccuracy: verdicts.length
      ? verdicts.filter((item) => item.correct).length / verdicts.length
      : 0,
  };
}

function meanMetrics(values: Metrics[]): Metrics {
  return Object.fromEntries(METRICS.map((metric) => [
    metric,
    mean(values.map((item) => item[metric])),
  ])) as Metrics;
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

function clusteredBootstrap(params: {
  cases: Array<Record<string, any>>;
  metric: Metric;
  samples: number;
  seed: number;
}) {
  const byPersona = new Map<string, Array<Record<string, any>>>();
  for (const item of params.cases) {
    const selected = byPersona.get(item.persona) ?? [];
    selected.push(item);
    byPersona.set(item.persona, selected);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: Record<string, any>) => item.arms.shield[params.metric] - item.arms.v1[params.metric];
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < params.samples; sample += 1) {
    const selected: Array<Record<string, any>> = [];
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

function emptyTransition(): CriterionTransition {
  return {
    total: 0,
    sameCorrect: 0,
    sameWrong: 0,
    v1CorrectShieldWrong: 0,
    v1WrongShieldCorrect: 0,
    netCorrectDelta: 0,
  };
}

function addTransitions(
  output: CriterionTransition,
  v1: Array<Record<string, any>>,
  shield: Array<Record<string, any>>,
): void {
  const v1ById = new Map(v1.map((item) => [item.id, item]));
  for (const current of shield) {
    const previous = v1ById.get(current.id);
    if (!previous) throw new Error(`missing V1 criterion ${current.id}`);
    output.total += 1;
    if (previous.correct && current.correct) output.sameCorrect += 1;
    else if (!previous.correct && !current.correct) output.sameWrong += 1;
    else if (previous.correct) output.v1CorrectShieldWrong += 1;
    else output.v1WrongShieldCorrect += 1;
  }
  if (v1ById.size !== shield.length) throw new Error("criterion transition count mismatch");
  output.netCorrectDelta = output.v1WrongShieldCorrect - output.v1CorrectShieldWrong;
}

function exactAnswerExposure(answer: string, values: string[]): number {
  const normalized = normalizeEvidence(answer);
  return Number(values.some((value) => {
    const expected = normalizeEvidence(value);
    return expected.length >= 2 && normalized.includes(expected);
  }));
}

export async function validateEvidenceShieldE2E(
  options: ValidatorOptions,
): Promise<Record<string, unknown>> {
  const [v1Text, shieldText, summaryText, loaded] = await Promise.all([
    readFile(options.v1Evaluations, "utf8"),
    readFile(options.shieldEvaluations, "utf8"),
    readFile(options.summary, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const summary = JSON.parse(summaryText);
  const v1All = v1Text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const shield = shieldText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const caseIds = new Set(shield.map((item) => item.caseId));
  const v1 = v1All.filter((item) => item.arm === "v1" && caseIds.has(item.caseId));
  const rows: Record<Arm, Array<Record<string, any>>> = { v1, shield };
  const readers: string[] = summary.protocol.readers.map((item: Record<string, any>) => item.id);
  const judges: string[] = summary.protocol.judges.map((item: Record<string, any>) => item.id);
  const readerModels = new Map(summary.protocol.readers.map((item: Record<string, any>) => [item.id, item.model]));
  const judgeModels = new Map(summary.protocol.judges.map((item: Record<string, any>) => [item.id, item.model]));
  const keys = new Set<string>();
  let duplicateKeys = 0;
  let verdictConsistencyMismatches = 0;
  let metricMismatches = 0;
  let readerModelMismatches = 0;
  let judgeModelMismatches = 0;
  let readerRetries = 0;
  let judgeRetries = 0;
  let unclearVerdicts = 0;
  for (const arm of ["v1", "shield"] as Arm[]) {
    for (const row of rows[arm]) {
      const key = `${row.caseId}\0${row.readerId}\0${arm}`;
      duplicateKeys += Number(keys.has(key));
      keys.add(key);
      readerRetries += row.readerAttempts - 1;
      readerModelMismatches += Number(row.reader.model !== readerModels.get(row.readerId));
      for (const judge of judges) {
        const judged = row.judges[judge];
        judgeRetries += judged.attempts - 1;
        judgeModelMismatches += Number(judged.response.model !== judgeModels.get(judge));
        for (const verdict of judged.verdicts) {
          verdictConsistencyMismatches += Number(
            verdict.correct !== (verdict.answer === verdict.expectedAnswer),
          );
          unclearVerdicts += Number(verdict.answer === "unclear");
        }
        const recomputed = score(judged.verdicts);
        for (const metric of METRICS) {
          metricMismatches += Number(!close(recomputed[metric], judged.metrics[metric]));
        }
      }
    }
  }
  const byKey = new Map([...v1.map((item) => [`${item.caseId}\0${item.readerId}\0v1`, item] as const),
    ...shield.map((item) => [`${item.caseId}\0${item.readerId}\0shield`, item] as const)]);
  const cases = [...caseIds].map((caseId) => {
    const first = shield.find((item) => item.caseId === caseId)!;
    return {
      caseId,
      persona: first.persona,
      task: first.task,
      arms: Object.fromEntries((["v1", "shield"] as Arm[]).map((arm) => {
        const crossed = readers.map((reader) => {
          const otherJudge = judges.find((judge) => judge !== reader)!;
          const row = byKey.get(`${caseId}\0${reader}\0${arm}`);
          if (!row) throw new Error(`missing validator row ${caseId}/${reader}/${arm}`);
          return row.judges[otherJudge].metrics as Metrics;
        });
        return [arm, meanMetrics(crossed)];
      })) as Record<Arm, Metrics>,
    };
  });
  const recomputedArms = Object.fromEntries((["v1", "shield"] as Arm[]).map((arm) => [
    arm,
    meanMetrics(cases.map((item) => item.arms[arm])),
  ])) as Record<Arm, Metrics>;
  let summaryMismatches = 0;
  for (const arm of ["v1", "shield"] as Arm[]) {
    for (const metric of METRICS) {
      summaryMismatches += Number(!close(recomputedArms[arm][metric], summary.primary.arms[arm][metric]));
    }
  }
  const recomputedDelta = Object.fromEntries(METRICS.map((metric) => [
    metric,
    mean(cases.map((item) => item.arms.shield[metric] - item.arms.v1[metric])),
  ])) as Metrics;
  for (const metric of METRICS) {
    summaryMismatches += Number(!close(recomputedDelta[metric], summary.primary.shieldVsV1[metric].mean));
  }

  const groups = new Map(loaded.groups.map((group) => [group.id, group]));
  const exposure = { v1: 0, shield: 0 };
  const presenceTransitions = emptyTransition();
  const forgettingTransitions = emptyTransition();
  for (const shieldRow of shield) {
    const v1Row = byKey.get(`${shieldRow.caseId}\0${shieldRow.readerId}\0v1`)!;
    const group = groups.get(shieldRow.groupId);
    const question = group?.questions.find((item) => item.id === shieldRow.caseId);
    if (!question) throw new Error(`missing validator question ${shieldRow.caseId}`);
    const values = question.obsoleteAtoms.map((atom) => atom.value);
    exposure.v1 += exactAnswerExposure(v1Row.answer, values);
    exposure.shield += exactAnswerExposure(shieldRow.answer, values);
    const judgeId = judges.find((judge) => judge !== shieldRow.readerId)!;
    const v1Verdicts = v1Row.judges[judgeId].verdicts;
    const shieldVerdicts = shieldRow.judges[judgeId].verdicts;
    addTransitions(
      presenceTransitions,
      v1Verdicts.filter((item: Record<string, any>) => item.type === "memory_presence"),
      shieldVerdicts.filter((item: Record<string, any>) => item.type === "memory_presence"),
    );
    addTransitions(
      forgettingTransitions,
      v1Verdicts.filter((item: Record<string, any>) => item.type === "forgetting_absence"),
      shieldVerdicts.filter((item: Record<string, any>) => item.type === "forgetting_absence"),
    );
  }
  const samples = options.bootstrapSamples ?? 20_000;
  const seed = options.seed ?? 827_364;
  const alternativeBootstrap = Object.fromEntries((["mpa", "faa", "fama"] as Metric[]).map(
    (metric, index) => [metric, clusteredBootstrap({
      cases,
      metric,
      samples,
      seed: seed + index,
    })],
  ));
  const expectedRows = summary.protocol.selection.cases * readers.length;
  const checks = {
    shieldRowCount: shield.length === expectedRows,
    reusedV1RowCount: v1.length === expectedRows,
    uniqueKeys: keys.size === expectedRows * 2 && duplicateKeys === 0,
    caseCount: cases.length === summary.protocol.selection.cases,
    verdictConsistency: verdictConsistencyMismatches === 0,
    metricRecomputation: metricMismatches === 0,
    summaryRecomputation: summaryMismatches === 0,
    returnedModels: readerModelMismatches === 0 && judgeModelMismatches === 0,
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocolVersion: summary.protocol.protocolVersion,
    input: {
      v1Evaluations: path.resolve(options.v1Evaluations),
      v1EvaluationsSha256: sha256(v1Text),
      shieldEvaluations: path.resolve(options.shieldEvaluations),
      shieldEvaluationsSha256: sha256(shieldText),
      summary: path.resolve(options.summary),
      summarySha256: sha256(summaryText),
    },
    integrity: {
      shieldRows: shield.length,
      reusedV1Rows: v1.length,
      cases: cases.length,
      uniqueKeys: keys.size,
      duplicateKeys,
      verdictConsistencyMismatches,
      metricMismatches,
      summaryMismatches,
      readerRetries,
      judgeRetries,
      readerModelMismatches,
      judgeModelMismatches,
      unclearVerdicts,
    },
    recomputedArms,
    recomputedShieldVsV1: recomputedDelta,
    exactObsoleteAnswerExposure: {
      pairedReaderAnswers: shield.length,
      v1Rate: exposure.v1 / shield.length,
      shieldRate: exposure.shield / shield.length,
      rateReduction: (exposure.v1 - exposure.shield) / shield.length,
    },
    criterionTransitions: {
      memoryPresence: presenceTransitions,
      forgettingAbsence: forgettingTransitions,
    },
    alternativeBootstrap: {
      samples,
      seed,
      unit: "persona",
      shieldVsV1: alternativeBootstrap,
    },
    checks,
    caveats: [
      "Exact answer exposure is descriptive and cannot distinguish negation from affirmation.",
      "Criterion transitions within an answer are correlated and are not independent trials.",
    ],
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
