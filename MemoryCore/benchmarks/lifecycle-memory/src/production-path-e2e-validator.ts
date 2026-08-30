import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProductionPathArm } from "./production-path-context-protocol.js";
import type { ProductionReaderMessage } from "./production-path-context.js";
import { PRODUCTION_PATH_E2E_PROTOCOL } from "./production-path-e2e-protocol.js";
import { scoreAnswer, type CriterionVerdict } from "./e2e-runner.js";
import type { DirectJudgeResponse } from "./judge-provider.js";
import type { BootstrapInterval } from "./types.js";

type Metrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof Metrics;
type PanelName = "natural_safety" | "temporal_capability";

interface ContextCase {
  caseId: string;
  panel: PanelName;
  persona: string;
  task: string;
  queryIntent: string;
  arms: Record<ProductionPathArm, string>;
}

interface ContextEntry {
  hash: string;
  caseId: string;
  messages: ProductionReaderMessage[];
  recalledMemoryIds: string[];
  injectedTokens: number;
  pairCount: number;
}

interface ContextManifest {
  protocolVersion: string;
  cases: ContextCase[];
  contexts: ContextEntry[];
  validation: { passed: boolean };
}

interface Evaluation {
  protocolVersion: string;
  caseId: string;
  panel: PanelName;
  contextHash: string;
  readerId: string;
  judgeId: string;
  recalledMemoryIds: string[];
  injectedTokens: number;
  pairCount: number;
  reader: DirectJudgeResponse;
  readerAttempts: number;
  judge: DirectJudgeResponse;
  judgeAttempts: number;
  verdicts: CriterionVerdict[];
  metrics: Metrics;
}

interface CaseArm {
  metrics: Metrics;
  cells: Record<string, Metrics>;
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
  arms: Record<ProductionPathArm, CaseArm>;
}

interface Summary {
  input: { contextManifestSha256: string };
  reports: any;
  decision: any;
  operationalIntegrity: any;
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

function aggregate(cases: RecomputedCase[], arm: ProductionPathArm) {
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

function bootstrap(cases: RecomputedCase[], metric: Metric, seed: number): BootstrapInterval {
  if (!cases.length) return { mean: 0, lower: 0, upper: 0, clusters: 0 };
  const personas = [...new Set(cases.map((item) => item.persona))].sort();
  const clusters = personas.map((persona) => cases.filter((item) => item.persona === persona));
  const delta = (item: RecomputedCase) =>
    item.arms.query_aware_dual.metrics[metric] - item.arms.current_only.metrics[metric];
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < PRODUCTION_PATH_E2E_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: RecomputedCase[] = [];
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

function comparison(cases: RecomputedCase[], seedOffset: number) {
  return Object.fromEntries((["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]).map((metric, index) => [
    metric,
    bootstrap(cases, metric, PRODUCTION_PATH_E2E_PROTOCOL.seed + seedOffset + index),
  ]));
}

function readerDirections(cases: RecomputedCase[], metric: Metric) {
  return Object.fromEntries(PRODUCTION_PATH_E2E_PROTOCOL.readers.map((reader) => [
    reader.id,
    mean(cases.map((item) => item.arms.query_aware_dual.cells[reader.id][metric]
      - item.arms.current_only.cells[reader.id][metric])),
  ]));
}

function outcomes(cases: RecomputedCase[], metric: Metric) {
  const deltas = cases.map((item) =>
    item.arms.query_aware_dual.metrics[metric] - item.arms.current_only.metrics[metric]);
  return {
    cases: cases.length,
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
  };
}

function subset(cases: RecomputedCase[], seedOffset: number) {
  return {
    cases: cases.length,
    arms: Object.fromEntries(PRODUCTION_PATH_E2E_PROTOCOL.arms.map((arm) => [arm, aggregate(cases, arm)])),
    comparison: comparison(cases, seedOffset),
    readerDirections: {
      fama: readerDirections(cases, "fama"),
      criterionAccuracy: readerDirections(cases, "criterionAccuracy"),
    },
    outcomes: {
      fama: outcomes(cases, "fama"),
      criterionAccuracy: outcomes(cases, "criterionAccuracy"),
    },
  };
}

function compareTree(
  actual: unknown,
  expected: unknown,
  key: string,
  mismatches: Array<{ kind: string; key: string }>,
) {
  if (typeof actual === "number" && typeof expected === "number") {
    if (!close(actual, expected)) mismatches.push({ kind: "numeric", key });
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) mismatches.push({ kind: "array_length", key });
    for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
      compareTree(actual[index], expected[index], `${key}[${index}]`, mismatches);
    }
    return;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(actualRecord), ...Object.keys(expectedRecord)]);
    for (const child of keys) {
      if (!(child in actualRecord) || !(child in expectedRecord)) {
        mismatches.push({ kind: "object_key", key: `${key}.${child}` });
      } else {
        compareTree(actualRecord[child], expectedRecord[child], `${key}.${child}`, mismatches);
      }
    }
    return;
  }
  if (actual !== expected) mismatches.push({ kind: "value", key });
}

function recomputeIntegrity(evaluations: Evaluation[]) {
  return {
    evaluations: evaluations.length,
    expectedEvaluations: PRODUCTION_PATH_E2E_PROTOCOL.reuse.expectedReaderCalls,
    complete: evaluations.length === PRODUCTION_PATH_E2E_PROTOCOL.reuse.expectedReaderCalls,
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

export async function validateProductionPathE2E(params: {
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
  const evaluations = evaluationsText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Evaluation);
  const summary = JSON.parse(summaryText) as Summary;
  const mismatches: Array<{ kind: string; key: string }> = [];
  const contextHash = sha256(contextText);
  const evaluationsHash = sha256(evaluationsText);
  if (contextHash !== PRODUCTION_PATH_E2E_PROTOCOL.context.sha256
    || contextHash !== summary.input.contextManifestSha256) {
    mismatches.push({ kind: "context_hash", key: contextHash });
  }
  if (evaluationsHash !== summary.artifactHashes.evaluationsSha256) {
    mismatches.push({ kind: "evaluations_hash", key: evaluationsHash });
  }
  if (context.protocolVersion !== PRODUCTION_PATH_E2E_PROTOCOL.context.protocolVersion
    || !context.validation.passed) {
    mismatches.push({ kind: "context_protocol_or_validation", key: context.protocolVersion });
  }

  const contexts = new Map(context.contexts.map((item) => [item.hash, item]));
  for (const item of context.contexts) {
    if (sha256(JSON.stringify(item.messages)) !== item.hash) {
      mismatches.push({ kind: "message_hash", key: item.hash });
    }
  }
  const byKey = new Map<string, Evaluation>();
  for (const evaluation of evaluations) {
    const key = `${evaluation.contextHash}\0${evaluation.readerId}`;
    if (byKey.has(key)) mismatches.push({ kind: "duplicate_evaluation", key });
    byKey.set(key, evaluation);
    if (evaluation.protocolVersion !== PRODUCTION_PATH_E2E_PROTOCOL.protocolVersion) {
      mismatches.push({ kind: "protocol", key });
    }
    if (PRODUCTION_PATH_E2E_PROTOCOL.judgeAssignment[evaluation.readerId] !== evaluation.judgeId) {
      mismatches.push({ kind: "cross_assignment", key });
    }
    const readerSpec = PRODUCTION_PATH_E2E_PROTOCOL.readers.find((item) => item.id === evaluation.readerId);
    const judgeSpec = PRODUCTION_PATH_E2E_PROTOCOL.judges.find((item) => item.id === evaluation.judgeId);
    if (!readerSpec || evaluation.reader.model !== readerSpec.model) {
      mismatches.push({ kind: "reader_model", key });
    }
    if (!judgeSpec || evaluation.judge.model !== judgeSpec.model) {
      mismatches.push({ kind: "judge_model", key });
    }
    const rescored = scoreAnswer(evaluation.verdicts);
    for (const metric of ["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]) {
      if (!close(rescored[metric], evaluation.metrics[metric])) {
        mismatches.push({ kind: `stored_${metric}`, key });
      }
    }
  }

  const expectedKeys = new Set(context.contexts.flatMap((entry) =>
    PRODUCTION_PATH_E2E_PROTOCOL.readers.map((reader) => `${entry.hash}\0${reader.id}`)));
  for (const key of expectedKeys) {
    if (!byKey.has(key)) mismatches.push({ kind: "missing_evaluation", key });
  }
  for (const key of byKey.keys()) {
    if (!expectedKeys.has(key)) mismatches.push({ kind: "unexpected_evaluation", key });
  }

  const cases: RecomputedCase[] = context.cases.map((item) => ({
    caseId: item.caseId,
    panel: item.panel,
    persona: item.persona,
    task: item.task,
    queryIntent: item.queryIntent,
    arms: Object.fromEntries(PRODUCTION_PATH_E2E_PROTOCOL.arms.map((arm): [ProductionPathArm, CaseArm] => {
      const entry = contexts.get(item.arms[arm]);
      if (!entry) throw new Error(`validator missing context ${item.caseId}/${arm}`);
      const cells = PRODUCTION_PATH_E2E_PROTOCOL.readers.map((reader) =>
        byKey.get(`${entry.hash}\0${reader.id}`));
      if (cells.some((cell) => !cell)) throw new Error(`validator missing evaluation ${item.caseId}/${arm}`);
      for (const cell of cells as Evaluation[]) {
        if (cell.caseId !== item.caseId || cell.panel !== item.panel) {
          mismatches.push({ kind: "case_link", key: `${item.caseId}/${arm}/${cell.readerId}` });
        }
        if (cell.recalledMemoryIds.join("\0") !== entry.recalledMemoryIds.join("\0")) {
          mismatches.push({ kind: "memory_ids", key: `${item.caseId}/${arm}/${cell.readerId}` });
        }
        if (cell.injectedTokens !== entry.injectedTokens || cell.pairCount !== entry.pairCount) {
          mismatches.push({ kind: "context_cost", key: `${item.caseId}/${arm}/${cell.readerId}` });
        }
      }
      const typed = cells as Evaluation[];
      return [arm, {
        metrics: crossed(typed.map((cell) => scoreAnswer(cell.verdicts))),
        cells: Object.fromEntries(typed.map((cell) => [cell.readerId, scoreAnswer(cell.verdicts)])),
        tokens: entry.injectedTokens,
        items: entry.recalledMemoryIds.length,
        pairs: entry.pairCount,
      }];
    })) as Record<ProductionPathArm, CaseArm>,
  }));
  const natural = cases.filter((item) => item.panel === "natural_safety");
  const temporal = cases.filter((item) => item.panel === "temporal_capability");
  const reports = {
    combined: subset(cases, 0),
    natural: {
      ...subset(natural, 1000),
      byTask: Object.fromEntries([...new Set(natural.map((item) => item.task))].sort()
        .map((task, index) => [task, subset(natural.filter((item) => item.task === task), 2000 + index * 200)])),
    },
    temporal: {
      ...subset(temporal, 4000),
      pairs: new Set(context.cases.filter((item) => item.panel === "temporal_capability")
        .map((item) => item.caseId.replace(/:(?:current_state|historical_state|state_change)$/, ""))).size,
      byTask: Object.fromEntries([...new Set(temporal.map((item) => item.task))].sort()
        .map((task, index) => [task, subset(temporal.filter((item) => item.task === task), 5000 + index * 200)])),
    },
  };
  compareTree(reports, summary.reports, "reports", mismatches);

  const operationalIntegrity = recomputeIntegrity(evaluations);
  compareTree(operationalIntegrity, summary.operationalIntegrity, "operationalIntegrity", mismatches);
  const combinedTokenIncreaseFraction = reports.combined.arms.query_aware_dual.meanInjectedTokens
    / reports.combined.arms.current_only.meanInjectedTokens - 1;
  const temporalComparison = reports.temporal.comparison as Record<Metric, BootstrapInterval>;
  const history = reports.temporal.byTask.temporal_history.comparison as Record<Metric, BootstrapInterval>;
  const change = reports.temporal.byTask.temporal_change.comparison as Record<Metric, BootstrapInterval>;
  const current = reports.temporal.byTask.temporal_current.comparison as Record<Metric, BootstrapInterval>;
  const naturalComparison = reports.natural.comparison as Record<Metric, BootstrapInterval>;
  const readerTemporalDirections = reports.temporal.readerDirections.criterionAccuracy;
  const gate = PRODUCTION_PATH_E2E_PROTOCOL.gates;
  const checks = {
    temporalAccuracy: temporalComparison.criterionAccuracy.mean >= gate.minTemporalCriterionAccuracyDelta,
    temporalAccuracyCi: !gate.requireTemporalCriterionAccuracyCiLowerAboveZero
      || temporalComparison.criterionAccuracy.lower > 0,
    historicalAccuracy: history.criterionAccuracy.mean >= gate.minHistoryCriterionAccuracyDelta,
    changeAccuracy: change.criterionAccuracy.mean >= gate.minChangeCriterionAccuracyDelta,
    currentNonInferiority: current.criterionAccuracy.mean >= gate.minCurrentCriterionAccuracyDelta,
    naturalNonInferiority: naturalComparison.fama.mean >= gate.minNaturalFamaDelta,
    combinedTokenBudget: combinedTokenIncreaseFraction <= gate.maxCombinedTokenIncreaseFraction,
    readerDirection: !gate.requireNonnegativeTemporalDirectionForBothReaders
      || Object.values(readerTemporalDirections).every((value) => value >= 0),
    contextIntegrity: !gate.requirePassedProductionContext || context.validation.passed,
    evaluationIntegrity: (!gate.requireCompleteFrozenTaskSet || operationalIntegrity.complete)
      && (!gate.requireZeroModelMismatches
        || operationalIntegrity.readerModelMismatches + operationalIntegrity.judgeModelMismatches === 0)
      && (!gate.requireZeroSelfJudgments || operationalIntegrity.selfJudgments === 0),
  };
  compareTree(checks, summary.decision.checks, "decision.checks", mismatches);
  if (summary.decision.recommended !== Object.values(checks).every(Boolean)) {
    mismatches.push({ kind: "decision", key: "recommended" });
  }
  if (!close(combinedTokenIncreaseFraction, summary.decision.combinedTokenIncreaseFraction)) {
    mismatches.push({ kind: "decision", key: "combinedTokenIncreaseFraction" });
  }

  const report = {
    validationVersion: "production-auto-recall-e2e-independent-validation-v1.0",
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
      arms: PRODUCTION_PATH_E2E_PROTOCOL.arms.length,
      caseArmContexts: cases.length * PRODUCTION_PATH_E2E_PROTOCOL.arms.length,
      evaluations: evaluations.length,
      uniqueEvaluationKeys: byKey.size,
      rawVerdictsRescored: evaluations.length,
    },
    primaryRecomputation: {
      naturalFamaDelta: naturalComparison.fama.mean,
      temporalCriterionAccuracyDelta: temporalComparison.criterionAccuracy.mean,
      temporalCriterionAccuracyInterval: temporalComparison.criterionAccuracy,
      historyCriterionAccuracyDelta: history.criterionAccuracy.mean,
      changeCriterionAccuracyDelta: change.criterionAccuracy.mean,
      currentCriterionAccuracyDelta: current.criterionAccuracy.mean,
      combinedTokenIncreaseFraction,
      readerTemporalDirections,
      checks,
    },
    mismatchCount: mismatches.length,
    mismatches,
  };
  await mkdir(path.dirname(params.output), { recursive: true });
  await writeFile(params.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
