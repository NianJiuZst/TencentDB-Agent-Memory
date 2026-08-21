import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Metric = "mpa" | "faa" | "fama" | "criterionAccuracy";
type Metrics = Record<Metric, number>;

interface ValidatorOptions {
  evaluations: string;
  summary: string;
  output: string;
  bootstrapSamples?: number;
  seed?: number;
}

const METRICS: Metric[] = ["mpa", "faa", "fama", "criterionAccuracy"];

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
  left: string;
  right: string;
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
  const delta = (item: Record<string, any>) =>
    item.arms[params.left][params.metric] - item.arms[params.right][params.metric];
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

export async function validateContextualE2E(options: ValidatorOptions): Promise<Record<string, any>> {
  const [evaluationsText, summaryText] = await Promise.all([
    readFile(options.evaluations, "utf8"),
    readFile(options.summary, "utf8"),
  ]);
  const rows = evaluationsText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const summary = JSON.parse(summaryText);
  const arms: string[] = summary.protocol.arms;
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
  for (const row of rows) {
    const key = `${row.caseId}\0${row.readerId}\0${row.arm}`;
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
  const rowsByKey = new Map(rows.map((row) => [
    `${row.caseId}\0${row.readerId}\0${row.arm}`,
    row,
  ]));
  const caseIds = [...new Set(rows.map((row) => row.caseId))];
  const cases = caseIds.map((caseId) => {
    const first = rows.find((row) => row.caseId === caseId)!;
    return {
      caseId,
      persona: first.persona,
      arms: Object.fromEntries(arms.map((arm) => {
        const crossed = readers.map((reader) => {
          const otherJudge = judges.find((judge) => judge !== reader);
          if (!otherJudge) throw new Error(`missing cross judge for ${reader}`);
          const row = rowsByKey.get(`${caseId}\0${reader}\0${arm}`);
          if (!row) throw new Error(`missing evaluation ${caseId}/${reader}/${arm}`);
          return row.judges[otherJudge].metrics as Metrics;
        });
        return [arm, meanMetrics(crossed)];
      })),
    };
  });
  const recomputedArms = Object.fromEntries(arms.map((arm) => [
    arm,
    meanMetrics(cases.map((item) => item.arms[arm])),
  ]));
  let summaryMismatches = 0;
  for (const arm of arms) {
    for (const metric of METRICS) {
      summaryMismatches += Number(!close(
        recomputedArms[arm][metric],
        summary.primary.arms[arm][metric],
      ));
    }
  }
  const comparisons = [
    ["v1VsBase", "v1", "base"],
    ["contextualVsBase", "contextual", "base"],
    ["contextualVsV1", "contextual", "v1"],
  ] as const;
  for (const [name, left, right] of comparisons) {
    for (const metric of METRICS) {
      const observed = mean(cases.map((item) => item.arms[left][metric] - item.arms[right][metric]));
      summaryMismatches += Number(!close(observed, summary.primary[name][metric].mean));
    }
  }
  const samples = options.bootstrapSamples ?? 20_000;
  const seed = options.seed ?? 918_273;
  const alternativeBootstrap = Object.fromEntries(comparisons.map(([name, left, right], index) => [
    name,
    Object.fromEntries((["fama", "faa"] as Metric[]).map((metric, metricIndex) => [
      metric,
      clusteredBootstrap({
        cases,
        left,
        right,
        metric,
        samples,
        seed: seed + index * 10 + metricIndex,
      }),
    ])),
  ]));
  const expectedRows = summary.protocol.selection.cases * arms.length * readers.length;
  const checks = {
    rowCount: rows.length === expectedRows,
    uniqueKeys: keys.size === expectedRows && duplicateKeys === 0,
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
      evaluations: path.resolve(options.evaluations),
      summary: path.resolve(options.summary),
    },
    integrity: {
      rows: rows.length,
      expectedRows,
      uniqueKeys: keys.size,
      cases: cases.length,
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
    alternativeBootstrap: { samples, seed, unit: "persona", comparisons: alternativeBootstrap },
    checks,
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
