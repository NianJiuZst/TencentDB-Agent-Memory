import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DualStateArm } from "./dual-state-context-protocol.js";
import { DUAL_STATE_E2E_PROTOCOL } from "./dual-state-e2e-protocol.js";
import { scoreAnswer, type CriterionVerdict } from "./e2e-runner.js";
import type { DirectJudgeResponse } from "./judge-provider.js";
import type { BootstrapInterval, RetrievedUnit } from "./types.js";

type Metrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof Metrics;
type PanelName = "natural_safety" | "temporal_capability";

interface ContextCase {
  caseId: string;
  panel: PanelName;
  persona: string;
  task: string;
  queryIntent: string;
  arms: Record<DualStateArm, string>;
}

interface ContextEntry {
  hash: string;
  caseId: string;
  candidateIds: string[];
  injectedTokens: number;
  pairCount: number;
  candidates: RetrievedUnit[];
}

interface ContextManifest {
  cases: ContextCase[];
  contexts: ContextEntry[];
}

interface Evaluation {
  protocolVersion: string;
  caseId: string;
  panel: PanelName;
  contextHash: string;
  readerId: string;
  judgeId: string;
  candidateIds: string[];
  injectedTokens: number;
  pairCount: number;
  reader: DirectJudgeResponse;
  judge: DirectJudgeResponse;
  verdicts: CriterionVerdict[];
  metrics: Metrics;
}

interface CaseArm {
  metrics: Metrics;
  readerMetrics: Record<string, Metrics>;
  tokens: number;
  items: number;
  pairs: number;
}

interface RecomputedCase {
  caseId: string;
  panel: PanelName;
  persona: string;
  task: string;
  queryIntent: string;
  arms: Record<DualStateArm, CaseArm>;
}

interface Summary {
  input: { contextManifestSha256: string };
  reports: any;
  decisions: any;
  operationalIntegrity: { evaluations: number; complete: boolean };
  artifactHashes: { evaluationsSha256: string };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12;
}

function crossed(cells: Metrics[]): Metrics {
  return {
    mpa: mean(cells.map((item) => item.mpa)),
    faa: mean(cells.map((item) => item.faa)),
    fama: mean(cells.map((item) => item.fama)),
    criterionAccuracy: mean(cells.map((item) => item.criterionAccuracy)),
  };
}

function aggregate(cases: RecomputedCase[], arm: DualStateArm) {
  return {
    cases: cases.length,
    mpa: mean(cases.map((item) => item.arms[arm].metrics.mpa)),
    faa: mean(cases.map((item) => item.arms[arm].metrics.faa)),
    fama: mean(cases.map((item) => item.arms[arm].metrics.fama)),
    criterionAccuracy: mean(cases.map((item) => item.arms[arm].metrics.criterionAccuracy)),
    meanInjectedTokens: mean(cases.map((item) => item.arms[arm].tokens)),
    meanInjectedItems: mean(cases.map((item) => item.arms[arm].items)),
    meanRenderedPairs: mean(cases.map((item) => item.arms[arm].pairs)),
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
  cases: RecomputedCase[];
  left: DualStateArm;
  metric: Metric;
  seed: number;
}): BootstrapInterval {
  if (!params.cases.length) return { mean: 0, lower: 0, upper: 0, clusters: 0 };
  const personas = [...new Set(params.cases.map((item) => item.persona))].sort();
  const clusters = personas.map((persona) => params.cases.filter((item) => item.persona === persona));
  const delta = (item: RecomputedCase) =>
    item.arms[params.left].metrics[params.metric] - item.arms.v1.metrics[params.metric];
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < DUAL_STATE_E2E_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: RecomputedCase[] = [];
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

function compareAggregate(
  mismatches: Array<{ kind: string; key: string }>,
  actual: ReturnType<typeof aggregate>,
  expected: any,
  key: string,
) {
  for (const metric of [
    "cases",
    "mpa",
    "faa",
    "fama",
    "criterionAccuracy",
    "meanInjectedTokens",
    "meanInjectedItems",
    "meanRenderedPairs",
  ] as const) {
    if (!close(actual[metric], expected[metric])) mismatches.push({ kind: `aggregate_${metric}`, key });
  }
}

function meanDelta(cases: RecomputedCase[], arm: DualStateArm, metric: Metric): number {
  return mean(cases.map((item) => item.arms[arm].metrics[metric] - item.arms.v1.metrics[metric]));
}

function readerDirections(cases: RecomputedCase[], arm: DualStateArm, metric: Metric) {
  return Object.fromEntries(DUAL_STATE_E2E_PROTOCOL.readers.map((reader) => [
    reader.id,
    mean(cases.map((item) => item.arms[arm].readerMetrics[reader.id][metric]
      - item.arms.v1.readerMetrics[reader.id][metric])),
  ]));
}

export async function validateDualStateE2E(params: {
  contextManifest: string;
  evaluations: string;
  summary: string;
  output: string;
}) {
  const [contextText, evaluationsText, summaryText] = await Promise.all([
    readFile(params.contextManifest, "utf8"),
    readFile(params.evaluations, "utf8"),
    readFile(params.summary, "utf8"),
  ]);
  const context = JSON.parse(contextText) as ContextManifest;
  const evaluations = evaluationsText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Evaluation);
  const summary = JSON.parse(summaryText) as Summary;
  const mismatches: Array<{ kind: string; key: string }> = [];
  const contextHash = sha256(contextText);
  const evaluationsHash = sha256(evaluationsText);
  if (contextHash !== summary.input.contextManifestSha256) mismatches.push({ kind: "context_hash", key: contextHash });
  if (evaluationsHash !== summary.artifactHashes.evaluationsSha256) {
    mismatches.push({ kind: "evaluations_hash", key: evaluationsHash });
  }

  const byKey = new Map<string, Evaluation>();
  for (const evaluation of evaluations) {
    const key = `${evaluation.contextHash}\0${evaluation.readerId}`;
    if (byKey.has(key)) mismatches.push({ kind: "duplicate_evaluation", key });
    byKey.set(key, evaluation);
    if (evaluation.protocolVersion !== DUAL_STATE_E2E_PROTOCOL.protocolVersion) {
      mismatches.push({ kind: "protocol", key });
    }
    if (DUAL_STATE_E2E_PROTOCOL.judgeAssignment[evaluation.readerId] !== evaluation.judgeId) {
      mismatches.push({ kind: "cross_assignment", key });
    }
    const readerSpec = DUAL_STATE_E2E_PROTOCOL.readers.find((item) => item.id === evaluation.readerId)!;
    const judgeSpec = DUAL_STATE_E2E_PROTOCOL.judges.find((item) => item.id === evaluation.judgeId)!;
    if (evaluation.reader.model !== readerSpec.model) mismatches.push({ kind: "reader_model", key });
    if (evaluation.judge.model !== judgeSpec.model) mismatches.push({ kind: "judge_model", key });
    const rescored = scoreAnswer(evaluation.verdicts);
    for (const metric of ["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]) {
      if (!close(rescored[metric], evaluation.metrics[metric])) mismatches.push({ kind: `stored_${metric}`, key });
    }
  }

  const contexts = new Map(context.contexts.map((item) => [item.hash, item]));
  const cases: RecomputedCase[] = context.cases.map((item) => ({
    caseId: item.caseId,
    panel: item.panel,
    persona: item.persona,
    task: item.task,
    queryIntent: item.queryIntent,
    arms: Object.fromEntries(DUAL_STATE_E2E_PROTOCOL.arms.map((arm): [DualStateArm, CaseArm] => {
      const contextEntry = contexts.get(item.arms[arm]);
      if (!contextEntry) throw new Error(`D19 validator missing context ${item.caseId}/${arm}`);
      const cells = DUAL_STATE_E2E_PROTOCOL.readers.map((reader) =>
        byKey.get(`${contextEntry.hash}\0${reader.id}`));
      if (cells.some((cell) => !cell)) {
        mismatches.push({ kind: "missing_cell", key: `${item.caseId}/${arm}` });
        throw new Error(`D19 validator missing evaluation ${item.caseId}/${arm}`);
      }
      for (const cell of cells as Evaluation[]) {
        if (cell.caseId !== item.caseId || cell.panel !== item.panel) {
          mismatches.push({ kind: "case_link", key: `${item.caseId}/${arm}/${cell.readerId}` });
        }
        if (cell.candidateIds.join("\0") !== contextEntry.candidateIds.join("\0")) {
          mismatches.push({ kind: "candidate_ids", key: `${item.caseId}/${arm}/${cell.readerId}` });
        }
        if (cell.injectedTokens !== contextEntry.injectedTokens || cell.pairCount !== contextEntry.pairCount) {
          mismatches.push({ kind: "context_cost", key: `${item.caseId}/${arm}/${cell.readerId}` });
        }
      }
      const typedCells = cells as Evaluation[];
      return [arm, {
        metrics: crossed(typedCells.map((cell) => scoreAnswer(cell.verdicts))),
        readerMetrics: Object.fromEntries(typedCells.map((cell) => [cell.readerId, scoreAnswer(cell.verdicts)])),
        tokens: contextEntry.injectedTokens,
        items: contextEntry.candidateIds.length,
        pairs: contextEntry.pairCount,
      }];
    })) as Record<DualStateArm, CaseArm>,
  }));

  const natural = cases.filter((item) => item.panel === "natural_safety");
  const temporal = cases.filter((item) => item.panel === "temporal_capability");
  const panels = { combined: cases, natural, temporal };
  for (const [panelName, panelCases] of Object.entries(panels)) {
    for (const arm of DUAL_STATE_E2E_PROTOCOL.arms) {
      compareAggregate(
        mismatches,
        aggregate(panelCases, arm),
        summary.reports[panelName].arms[arm],
        `${panelName}/${arm}`,
      );
      if (arm === "v1") continue;
      for (const metric of ["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]) {
        const actual = meanDelta(panelCases, arm, metric);
        const expected = summary.reports[panelName].comparisonsVsV1[arm][metric].mean;
        if (!close(actual, expected)) mismatches.push({ kind: `delta_${metric}`, key: `${panelName}/${arm}` });
      }
    }
  }
  for (const [task, taskReport] of Object.entries(summary.reports.temporal.byTask) as Array<[string, any]>) {
    const selected = temporal.filter((item) => item.task === task);
    for (const arm of DUAL_STATE_E2E_PROTOCOL.arms) {
      compareAggregate(mismatches, aggregate(selected, arm), taskReport.arms[arm], `temporal/${task}/${arm}`);
    }
  }

  const primaryIntervals = {
    naturalDualAllFama: bootstrap({
      cases: natural,
      left: "dual_all",
      metric: "fama",
      seed: DUAL_STATE_E2E_PROTOCOL.seed + 1000 + 2,
    }),
    naturalQueryAwareFama: bootstrap({
      cases: natural,
      left: "dual_query_aware",
      metric: "fama",
      seed: DUAL_STATE_E2E_PROTOCOL.seed + 1000 + 20 + 2,
    }),
    temporalQueryAwareAccuracy: bootstrap({
      cases: temporal,
      left: "dual_query_aware",
      metric: "criterionAccuracy",
      seed: DUAL_STATE_E2E_PROTOCOL.seed + 4000 + 20 + 3,
    }),
  };
  const storedIntervals = {
    naturalDualAllFama: summary.reports.natural.comparisonsVsV1.dual_all.fama,
    naturalQueryAwareFama: summary.reports.natural.comparisonsVsV1.dual_query_aware.fama,
    temporalQueryAwareAccuracy: summary.reports.temporal.comparisonsVsV1.dual_query_aware.criterionAccuracy,
  };
  for (const key of Object.keys(primaryIntervals) as Array<keyof typeof primaryIntervals>) {
    for (const field of ["mean", "lower", "upper", "clusters"] as const) {
      if (!close(primaryIntervals[key][field], storedIntervals[key][field])) {
        mismatches.push({ kind: `bootstrap_${field}`, key });
      }
    }
  }

  const temporalHistory = temporal.filter((item) => item.task === "temporal_history");
  const temporalChange = temporal.filter((item) => item.task === "temporal_change");
  const temporalCurrent = temporal.filter((item) => item.task === "temporal_current");
  const naturalAllTokens = aggregate(natural, "dual_all").meanInjectedTokens
    / aggregate(natural, "v1").meanInjectedTokens - 1;
  const combinedQueryTokens = aggregate(cases, "dual_query_aware").meanInjectedTokens
    / aggregate(cases, "v1").meanInjectedTokens - 1;
  const readerTemporalDirections = readerDirections(temporal, "dual_query_aware", "criterionAccuracy");
  const integrityPassed = evaluations.length === DUAL_STATE_E2E_PROTOCOL.reuse.expectedReaderCalls
    && evaluations.every((item) => item.readerId !== item.judgeId)
    && evaluations.every((item) =>
      item.reader.model === DUAL_STATE_E2E_PROTOCOL.readers.find((spec) => spec.id === item.readerId)!.model
      && item.judge.model === DUAL_STATE_E2E_PROTOCOL.judges.find((spec) => spec.id === item.judgeId)!.model);
  const recomputedChecks = {
    unconditionalDual: {
      naturalFama: meanDelta(natural, "dual_all", "fama")
        >= DUAL_STATE_E2E_PROTOCOL.gates.unconditionalDual.minNaturalFamaDelta,
      naturalFamaCi: primaryIntervals.naturalDualAllFama.lower
        >= DUAL_STATE_E2E_PROTOCOL.gates.unconditionalDual.minNaturalFamaCiLower,
      naturalFaa: meanDelta(natural, "dual_all", "faa")
        >= DUAL_STATE_E2E_PROTOCOL.gates.unconditionalDual.minNaturalFaaDelta,
      naturalMpa: meanDelta(natural, "dual_all", "mpa")
        >= DUAL_STATE_E2E_PROTOCOL.gates.unconditionalDual.minNaturalMpaDelta,
      naturalTokenBudget: naturalAllTokens
        <= DUAL_STATE_E2E_PROTOCOL.gates.unconditionalDual.maxNaturalTokenIncreaseFraction,
    },
    queryAwareValue: {
      temporalAccuracy: meanDelta(temporal, "dual_query_aware", "criterionAccuracy")
        >= DUAL_STATE_E2E_PROTOCOL.gates.queryAwareValue.minTemporalCriterionAccuracyDelta,
      temporalAccuracyCi: primaryIntervals.temporalQueryAwareAccuracy.lower > 0,
      historicalAccuracy: meanDelta(temporalHistory, "dual_query_aware", "criterionAccuracy")
        >= DUAL_STATE_E2E_PROTOCOL.gates.queryAwareValue.minHistoryCriterionAccuracyDelta,
      changeAccuracy: meanDelta(temporalChange, "dual_query_aware", "criterionAccuracy")
        >= DUAL_STATE_E2E_PROTOCOL.gates.queryAwareValue.minChangeCriterionAccuracyDelta,
      currentNonInferiority: meanDelta(temporalCurrent, "dual_query_aware", "criterionAccuracy")
        >= DUAL_STATE_E2E_PROTOCOL.gates.queryAwareValue.minCurrentCriterionAccuracyDelta,
      naturalNonInferiority: meanDelta(natural, "dual_query_aware", "fama")
        >= DUAL_STATE_E2E_PROTOCOL.gates.queryAwareValue.minNaturalFamaDelta,
      combinedTokenBudget: combinedQueryTokens
        <= DUAL_STATE_E2E_PROTOCOL.gates.queryAwareValue.maxCombinedTokenIncreaseFraction,
      readerDirection: Object.values(readerTemporalDirections).every((value) => value >= 0),
      integrity: integrityPassed,
    },
    defaultReplacement: {
      naturalTemporalCoverage: natural.filter((item) =>
        item.queryIntent === "historical_state" || item.queryIntent === "state_change").length
        >= DUAL_STATE_E2E_PROTOCOL.gates.defaultReplacement.minNaturalExplicitTemporalCases,
      naturalFama: meanDelta(natural, "dual_query_aware", "fama")
        >= DUAL_STATE_E2E_PROTOCOL.gates.defaultReplacement.minNaturalFamaDelta,
      naturalFamaCi: primaryIntervals.naturalQueryAwareFama.lower > 0,
    },
  };
  for (const [decision, checks] of Object.entries(recomputedChecks)) {
    for (const [check, value] of Object.entries(checks)) {
      if (summary.decisions[decision].checks[check] !== value) {
        mismatches.push({ kind: "decision_check", key: `${decision}/${check}` });
      }
    }
  }

  if (evaluations.length !== DUAL_STATE_E2E_PROTOCOL.reuse.expectedReaderCalls) {
    mismatches.push({ kind: "evaluation_count", key: String(evaluations.length) });
  }
  if (!summary.operationalIntegrity.complete || summary.operationalIntegrity.evaluations !== evaluations.length) {
    mismatches.push({ kind: "summary_integrity", key: String(summary.operationalIntegrity.evaluations) });
  }
  const report = {
    validationVersion: "lifecycle-dual-state-e2e-independent-validation-v1.0",
    status: mismatches.length ? "failed" : "passed",
    inputs: {
      contextSha256: contextHash,
      evaluationsSha256: evaluationsHash,
      summarySha256: sha256(summaryText),
    },
    counts: {
      cases: cases.length,
      naturalCases: natural.length,
      temporalCases: temporal.length,
      arms: DUAL_STATE_E2E_PROTOCOL.arms.length,
      evaluations: evaluations.length,
      uniqueEvaluationKeys: byKey.size,
      rawVerdictsRescored: evaluations.length,
    },
    primaryRecomputation: {
      naturalDualAllFamaDelta: meanDelta(natural, "dual_all", "fama"),
      naturalDualAllTokenIncreaseFraction: naturalAllTokens,
      temporalQueryAwareCriterionAccuracyDelta: meanDelta(temporal, "dual_query_aware", "criterionAccuracy"),
      temporalHistoryCriterionAccuracyDelta: meanDelta(temporalHistory, "dual_query_aware", "criterionAccuracy"),
      temporalChangeCriterionAccuracyDelta: meanDelta(temporalChange, "dual_query_aware", "criterionAccuracy"),
      temporalCurrentCriterionAccuracyDelta: meanDelta(temporalCurrent, "dual_query_aware", "criterionAccuracy"),
      combinedQueryAwareTokenIncreaseFraction: combinedQueryTokens,
      readerTemporalDirections,
      primaryIntervals,
      checks: recomputedChecks,
    },
    mismatchCount: mismatches.length,
    mismatches,
  };
  await mkdir(path.dirname(params.output), { recursive: true });
  await writeFile(params.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
