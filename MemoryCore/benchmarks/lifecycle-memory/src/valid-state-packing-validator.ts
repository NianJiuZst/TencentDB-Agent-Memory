import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import { loadMemora } from "./adapter.js";
import { scoreRetrieved } from "./metrics.js";
import type { CaseMetrics, RetrievedUnit } from "./types.js";

type Arm = "v1" | "valid_state_packing";
type Metric = "evidenceFamaProxy" | "currentSessionRecall" | "forgettingAbsence";

interface ValidatorOptions {
  cases: string;
  dataRoot: string;
  output: string;
  samples?: number;
  seed?: number;
  skipHashVerification?: boolean;
  summary: string;
}

const encoding = getEncoding("cl100k_base");
const METRIC_KEYS: Array<keyof CaseMetrics> = [
  "currentSessionRecall",
  "currentAny",
  "currentAll",
  "forgettingAbsence",
  "obsoleteAny",
  "obsoleteSessionRate",
  "staleInjectionRate",
  "evidenceFamaProxy",
  "injectedItems",
  "injectedTokens",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-12;
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
  const delta = (item: Record<string, any>) =>
    item.arms.valid_state_packing.metrics[params.metric] - item.arms.v1.metrics[params.metric];
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

export async function validateValidStatePacking(
  options: ValidatorOptions,
): Promise<Record<string, unknown>> {
  const [casesText, summaryText, loaded] = await Promise.all([
    readFile(options.cases, "utf8"),
    readFile(options.summary, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const summary = JSON.parse(summaryText);
  const rows = casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const keys = new Set<string>();
  let duplicateKeys = 0;
  for (const row of rows) {
    const key = `${row.caseId}\0${row.arm}`;
    duplicateKeys += Number(keys.has(key));
    keys.add(key);
  }
  const groups = new Map(loaded.groups.map((group) => [group.id, group]));
  const materialized = new Map<string, RetrievedUnit>();
  for (const group of loaded.groups) {
    for (const unit of group.units) {
      materialized.set(`${group.id}\0${unit.id}`, {
        ...unit,
        score: 0,
        tokenCount: encoding.encode(unit.content).length,
      });
    }
  }
  let missingCandidateIds = 0;
  let metricMismatches = 0;
  let outputCandidateViolations = 0;
  for (const row of rows) {
    const group = groups.get(row.groupId);
    const question = group?.questions.find((item) => item.id === row.caseId);
    if (!question) throw new Error(`missing valid-state validation question ${row.caseId}`);
    const candidates = row.candidateIds.flatMap((id: string) => {
      const item = materialized.get(`${row.groupId}\0${id}`);
      if (!item) missingCandidateIds += 1;
      return item ? [item] : [];
    });
    outputCandidateViolations += Number(row.candidateIds.length > 5);
    const recomputed = scoreRetrieved(question, candidates);
    for (const metric of METRIC_KEYS) {
      metricMismatches += Number(!close(recomputed[metric], row.metrics[metric]));
    }
  }
  const byKey = new Map(rows.map((row) => [`${row.caseId}\0${row.arm}`, row]));
  const caseIds = [...new Set(rows.map((row) => row.caseId))];
  const cases = caseIds.map((caseId) => {
    const v1 = byKey.get(`${caseId}\0v1`);
    const candidate = byKey.get(`${caseId}\0valid_state_packing`);
    if (!v1 || !candidate) throw new Error(`missing paired valid-state row ${caseId}`);
    return {
      caseId,
      persona: v1.persona,
      period: v1.period,
      task: v1.task,
      forgettingBearing: v1.forgettingBearing,
      arms: { v1, valid_state_packing: candidate },
    };
  });
  const primary = cases.filter((item) =>
    item.period === "quarterly" && item.task !== "reasoning" && item.forgettingBearing
  );
  const samples = options.samples ?? 20_000;
  const seed = options.seed ?? 584_291;
  const bootstrap = Object.fromEntries(([
    "evidenceFamaProxy",
    "currentSessionRecall",
    "forgettingAbsence",
  ] as Metric[]).map((metric, index) => [
    metric,
    clusteredBootstrap({ cases: primary, metric, samples, seed: seed + index }),
  ]));
  let summaryMismatches = 0;
  for (const metric of ["evidenceFamaProxy", "currentSessionRecall", "forgettingAbsence"] as Metric[]) {
    summaryMismatches += Number(!close(
      bootstrap[metric].mean,
      summary.reports.primaryQuarterlyCurrentStateForgetting
        .validStatePackingVsV1[metric].mean,
    ));
  }
  const tokenViolations = cases.filter((item) =>
    item.arms.valid_state_packing.metrics.injectedTokens > item.arms.v1.metrics.injectedTokens
  ).length;
  const trials = summary.optimization.trials as Array<Record<string, any>>;
  let utilityMismatches = 0;
  for (const trial of trials) {
    const expected = trial.quality
      - summary.protocol.optimizer.harmPenalty * trial.harm
      - summary.protocol.optimizer.costPenalty * trial.cost
      - summary.protocol.optimizer.fallbackPenalty * trial.fallbackRate;
    utilityMismatches += Number(!close(expected, trial.utility));
  }
  const selectedPolicyMatches = trials[0]?.policy.id === summary.optimization.selected.id;
  const expectedRows = summary.integrity.cases * 2;
  const checks = {
    rowCount: rows.length === expectedRows,
    uniqueKeys: keys.size === expectedRows && duplicateKeys === 0,
    pairedCases: cases.length === summary.integrity.cases,
    primaryCaseCount: primary.length
      === summary.reports.primaryQuarterlyCurrentStateForgetting.v1.cases,
    candidateIdentity: missingCandidateIds === 0,
    candidateBudget: outputCandidateViolations === 0,
    metricRecomputation: metricMismatches === 0,
    summaryRecomputation: summaryMismatches === 0,
    perQueryTokenBudget: tokenViolations === 0,
    optimizerUtility: utilityMismatches === 0 && selectedPolicyMatches,
    reportedGate: summary.status === "passed" && summary.proxyGate.passed === true,
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocolVersion: summary.protocol.protocolVersion,
    input: {
      cases: path.resolve(options.cases),
      casesSha256: sha256(casesText),
      summary: path.resolve(options.summary),
      summarySha256: sha256(summaryText),
    },
    integrity: {
      rows: rows.length,
      cases: cases.length,
      primaryCases: primary.length,
      uniqueKeys: keys.size,
      duplicateKeys,
      missingCandidateIds,
      outputCandidateViolations,
      metricMismatches,
      summaryMismatches,
      tokenViolations,
      utilityMismatches,
      selectedPolicyMatches,
    },
    alternativePersonaBootstrap: {
      samples,
      seed,
      primaryValidStatePackingVsV1: bootstrap,
    },
    checks,
    caveats: [
      "This validator independently reconstructs evidence metrics from dataset turns and candidate ids.",
      "It validates the recorded optimizer arithmetic but does not independently rerun all nine mechanisms.",
      "The primary measures remain retrieval proxies, not answer-level outcomes.",
    ],
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
