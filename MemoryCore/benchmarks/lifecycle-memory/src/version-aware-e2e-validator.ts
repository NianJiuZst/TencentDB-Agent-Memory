import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreAnswer, type CriterionVerdict } from "./e2e-runner.js";
import type { BootstrapInterval } from "./types.js";
import type {
  VersionAwareArm,
  VersionAwarePanel,
  VersionAwareSlice,
} from "./version-aware-context-protocol.js";
import type {
  VersionAwareContextEntry,
  VersionAwareManifestCase,
} from "./version-aware-context.js";
import { VERSION_AWARE_E2E_PROTOCOL } from "./version-aware-e2e-protocol.js";

type AnswerMetrics = ReturnType<typeof scoreAnswer>;
type Metric = keyof AnswerMetrics;
type BaselineArm = Exclude<VersionAwareArm, "version_aware_multistate">;

interface ContextManifest {
  protocolVersion: string;
  selection: { cases: number; naturalCases: number; capabilityCases: number; scenarios: number };
  cases: VersionAwareManifestCase[];
  contexts: VersionAwareContextEntry[];
  deduplication: { caseArmContexts: number; uniquePromptsPerReader: number; exactPromptReuseOnly: boolean };
  validation: { passed: boolean } & Record<string, unknown>;
}

interface Evaluation {
  protocolVersion: string;
  caseId: string;
  panel: VersionAwarePanel;
  slice: VersionAwareSlice;
  contextHash: string;
  readerId: string;
  judgeId: string;
  recalledMemoryIds: string[];
  injectedTokens: number;
  reader: { model: string };
  readerAttempts: number;
  judge: { model: string };
  judgeAttempts: number;
  verdicts: CriterionVerdict[];
  metrics: AnswerMetrics;
}

interface CaseArm {
  metrics: AnswerMetrics;
  readerMetrics: Record<string, AnswerMetrics>;
  exactSelection: number;
  expectedStateRecall: number;
  contaminationRate: number;
  tokens: number;
  items: number;
  recallMs: number;
}

interface RecomputedCase {
  caseId: string;
  panel: VersionAwarePanel;
  slice: VersionAwareSlice;
  groupId: string;
  persona: string;
  task: string;
  arms: Record<VersionAwareArm, CaseArm>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function close(left: number, right: number, epsilon = 1e-12): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return left === right;
  return Math.abs(left - right) <= epsilon;
}

function crossed(metrics: AnswerMetrics[]): AnswerMetrics {
  if (metrics.length !== 2) throw new Error(`validator expected two crossed cells, found ${metrics.length}`);
  return {
    mpa: mean(metrics.map((item) => item.mpa)),
    faa: mean(metrics.map((item) => item.faa)),
    fama: mean(metrics.map((item) => item.fama)),
    criterionAccuracy: mean(metrics.map((item) => item.criterionAccuracy)),
  };
}

function contextMetrics(actual: string[], expected: string[]) {
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

function aggregate(cases: RecomputedCase[], arm: VersionAwareArm) {
  return {
    cases: cases.length,
    mpa: mean(cases.map((item) => item.arms[arm].metrics.mpa)),
    faa: mean(cases.map((item) => item.arms[arm].metrics.faa)),
    fama: mean(cases.map((item) => item.arms[arm].metrics.fama)),
    criterionAccuracy: mean(cases.map((item) => item.arms[arm].metrics.criterionAccuracy)),
    exactSelectionAccuracy: mean(cases.map((item) => item.arms[arm].exactSelection)),
    expectedStateRecall: mean(cases.map((item) => item.arms[arm].expectedStateRecall)),
    contaminationRate: mean(cases.map((item) => item.arms[arm].contaminationRate)),
    meanInjectedTokens: mean(cases.map((item) => item.arms[arm].tokens)),
    meanInjectedItems: mean(cases.map((item) => item.arms[arm].items)),
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

function bootstrap(params: {
  cases: RecomputedCase[];
  baseline: BaselineArm;
  metric: Metric;
  seed: number;
}): BootstrapInterval {
  if (!params.cases.length) return { mean: 0, lower: 0, upper: 0, clusters: 0 };
  const groupIds = [...new Set(params.cases.map((item) => item.groupId))].sort();
  const clusters = groupIds.map((groupId) => params.cases.filter((item) => item.groupId === groupId));
  const delta = (item: RecomputedCase) =>
    item.arms.version_aware_multistate.metrics[params.metric] - item.arms[params.baseline].metrics[params.metric];
  const random = mulberry32(params.seed);
  const draws: number[] = [];
  for (let sample = 0; sample < VERSION_AWARE_E2E_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
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

function comparison(cases: RecomputedCase[], baseline: BaselineArm, seedOffset: number) {
  return Object.fromEntries(([
    "mpa",
    "faa",
    "fama",
    "criterionAccuracy",
  ] as Metric[]).map((metric, index) => [
    metric,
    bootstrap({
      cases,
      baseline,
      metric,
      seed: VERSION_AWARE_E2E_PROTOCOL.seed + seedOffset + index,
    }),
  ]));
}

function readerDirections(cases: RecomputedCase[], baseline: BaselineArm, metric: Metric) {
  return Object.fromEntries(VERSION_AWARE_E2E_PROTOCOL.readers.map((reader) => [
    reader.id,
    mean(cases.map((item) => item.arms.version_aware_multistate.readerMetrics[reader.id][metric]
      - item.arms[baseline].readerMetrics[reader.id][metric])),
  ]));
}

function outcomes(cases: RecomputedCase[], baseline: BaselineArm, metric: Metric) {
  const deltas = cases.map((item) =>
    item.arms.version_aware_multistate.metrics[metric] - item.arms[baseline].metrics[metric]);
  return {
    cases: cases.length,
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
  };
}

function subset(cases: RecomputedCase[], seedOffset: number) {
  const baselines: BaselineArm[] = ["global_latest", "old_current_dual"];
  return {
    cases: cases.length,
    arms: Object.fromEntries(VERSION_AWARE_E2E_PROTOCOL.arms.map((arm) => [arm, aggregate(cases, arm)])),
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
        fama: outcomes(cases, baseline, "fama"),
        criterionAccuracy: outcomes(cases, baseline, "criterionAccuracy"),
      },
    ])),
  };
}

function compareDeep(
  actual: unknown,
  expected: unknown,
  key: string,
  mismatches: Array<{ kind: string; key: string; actual?: unknown; expected?: unknown }>,
): void {
  if (typeof actual === "number" && typeof expected === "number") {
    if (!close(actual, expected)) mismatches.push({ kind: "number", key, actual, expected });
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      mismatches.push({ kind: "array_length", key, actual: actual.length, expected: expected.length });
      return;
    }
    actual.forEach((value, index) => compareDeep(value, expected[index], `${key}[${index}]`, mismatches));
    return;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    for (const child of Object.keys(actual as Record<string, unknown>)) {
      if (!(child in (expected as Record<string, unknown>))) {
        mismatches.push({ kind: "missing_key", key: `${key}.${child}` });
      } else {
        compareDeep(
          (actual as Record<string, unknown>)[child],
          (expected as Record<string, unknown>)[child],
          `${key}.${child}`,
          mismatches,
        );
      }
    }
    return;
  }
  if (actual !== expected) mismatches.push({ kind: "value", key, actual, expected });
}

function ratioIncrease(left: number, right: number): number {
  if (right === 0) return left === 0 ? 0 : Number.POSITIVE_INFINITY;
  return left / right - 1;
}

function interval(report: any, baseline: BaselineArm, metric: Metric): BootstrapInterval {
  return report.comparisons[`vs_${baseline}`][metric];
}

export async function validateVersionAwareE2E(params: {
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
  const summary = JSON.parse(summaryText) as Record<string, any>;
  const mismatches: Array<{ kind: string; key: string; actual?: unknown; expected?: unknown }> = [];
  const contextHash = sha256(contextText);
  const evaluationsHash = sha256(evaluationsText);
  if (contextHash !== VERSION_AWARE_E2E_PROTOCOL.context.sha256
    || contextHash !== summary.input.contextManifestSha256) {
    mismatches.push({ kind: "context_hash", key: contextHash });
  }
  if (evaluationsHash !== summary.artifactHashes.evaluationsSha256) {
    mismatches.push({ kind: "evaluations_hash", key: evaluationsHash });
  }
  if (!context.validation.passed) mismatches.push({ kind: "context_validation", key: "failed" });

  const caseById = new Map(context.cases.map((item) => [item.caseId, item]));
  const contextByHash = new Map(context.contexts.map((item) => [item.hash, item]));
  const evaluationByKey = new Map<string, Evaluation>();
  for (const evaluation of evaluations) {
    const key = `${evaluation.contextHash}\0${evaluation.readerId}`;
    if (evaluationByKey.has(key)) mismatches.push({ kind: "duplicate_evaluation", key });
    evaluationByKey.set(key, evaluation);
    if (evaluation.protocolVersion !== VERSION_AWARE_E2E_PROTOCOL.protocolVersion) {
      mismatches.push({ kind: "protocol", key });
    }
    const manifestCase = caseById.get(evaluation.caseId);
    const contextEntry = contextByHash.get(evaluation.contextHash);
    if (!manifestCase || !contextEntry || contextEntry.caseId !== evaluation.caseId) {
      mismatches.push({ kind: "case_context_link", key });
      continue;
    }
    if (VERSION_AWARE_E2E_PROTOCOL.judgeAssignment[evaluation.readerId] !== evaluation.judgeId) {
      mismatches.push({ kind: "cross_assignment", key });
    }
    const readerSpec = VERSION_AWARE_E2E_PROTOCOL.readers.find((item) => item.id === evaluation.readerId);
    const judgeSpec = VERSION_AWARE_E2E_PROTOCOL.judges.find((item) => item.id === evaluation.judgeId);
    if (!readerSpec || evaluation.reader.model !== readerSpec.model) mismatches.push({ kind: "reader_model", key });
    if (!judgeSpec || evaluation.judge.model !== judgeSpec.model) mismatches.push({ kind: "judge_model", key });
    if (evaluation.readerId === evaluation.judgeId) mismatches.push({ kind: "self_judgment", key });
    if (evaluation.panel !== manifestCase.panel || evaluation.slice !== manifestCase.slice) {
      mismatches.push({ kind: "panel_slice", key });
    }
    if (evaluation.recalledMemoryIds.join("\0") !== contextEntry.recalledMemoryIds.join("\0")
      || evaluation.injectedTokens !== contextEntry.injectedTokens) {
      mismatches.push({ kind: "context_payload", key });
    }
    const criteria = manifestCase.question.evaluationQuestions;
    if (evaluation.verdicts.length !== criteria.length) mismatches.push({ kind: "verdict_count", key });
    for (let index = 0; index < criteria.length; index += 1) {
      const verdict = evaluation.verdicts[index];
      const criterion = criteria[index];
      if (!verdict || verdict.id !== criterion.id || verdict.expectedAnswer !== criterion.expectedAnswer
        || verdict.type !== criterion.type || verdict.correct !== (verdict.answer === criterion.expectedAnswer)) {
        mismatches.push({ kind: "verdict_identity", key: `${key}/${criterion.id}` });
      }
    }
    const rescored = scoreAnswer(evaluation.verdicts);
    for (const metric of ["mpa", "faa", "fama", "criterionAccuracy"] as Metric[]) {
      if (!close(rescored[metric], evaluation.metrics[metric])) {
        mismatches.push({ kind: `stored_${metric}`, key });
      }
    }
  }

  const cases: RecomputedCase[] = context.cases.map((manifestCase) => ({
    caseId: manifestCase.caseId,
    panel: manifestCase.panel,
    slice: manifestCase.slice,
    groupId: manifestCase.groupId,
    persona: manifestCase.persona,
    task: manifestCase.task,
    arms: Object.fromEntries(VERSION_AWARE_E2E_PROTOCOL.arms.map((arm): [VersionAwareArm, CaseArm] => {
      const contextEntry = contextByHash.get(manifestCase.arms[arm]);
      if (!contextEntry) throw new Error(`validator missing context ${manifestCase.caseId}/${arm}`);
      const cells = VERSION_AWARE_E2E_PROTOCOL.readers.map((reader) =>
        evaluationByKey.get(`${contextEntry.hash}\0${reader.id}`));
      if (cells.some((cell) => !cell)) throw new Error(`validator missing evaluation ${manifestCase.caseId}/${arm}`);
      const typed = cells as Evaluation[];
      const contextScore = contextMetrics(contextEntry.recalledMemoryIds, manifestCase.expectedVersionAwareMemoryIds);
      return [arm, {
        metrics: crossed(typed.map((cell) => scoreAnswer(cell.verdicts))),
        readerMetrics: Object.fromEntries(typed.map((cell) => [cell.readerId, scoreAnswer(cell.verdicts)])),
        ...contextScore,
        tokens: contextEntry.injectedTokens,
        items: contextEntry.recalledMemoryIds.length,
        recallMs: contextEntry.elapsedMs,
      }];
    })) as Record<VersionAwareArm, CaseArm>,
  }));

  const natural = cases.filter((item) => item.panel === "natural_safety");
  const capability = cases.filter((item) => item.panel === "version_capability");
  const recomputedReports: Record<string, any> = {
    combined: subset(cases, 0),
    natural: subset(natural, 1000),
    capability: {
      ...subset(capability, 3000),
      bySlice: Object.fromEntries([...new Set(capability.map((item) => item.slice))].sort()
        .map((slice, index) => [
          slice,
          subset(capability.filter((item) => item.slice === slice), 5000 + index * 200),
        ])),
    },
  };
  compareDeep(recomputedReports, summary.reports, "reports", mismatches);

  const baselines: BaselineArm[] = ["global_latest", "old_current_dual"];
  const currentSlices: VersionAwareSlice[] = ["branch_current", "worktree_current", "parallel_task_current"];
  const crossStateSlices: VersionAwareSlice[] = ["branch_comparison", "migration", "regression"];
  const gate = VERSION_AWARE_E2E_PROTOCOL.gates;
  const candidateAggregate = recomputedReports.capability.arms.version_aware_multistate;
  const combinedTokenIncreases = Object.fromEntries(baselines.map((baseline) => [
    baseline,
    ratioIncrease(
      recomputedReports.combined.arms.version_aware_multistate.meanInjectedTokens,
      recomputedReports.combined.arms[baseline].meanInjectedTokens,
    ),
  ]));
  const capabilityDirections = Object.fromEntries(baselines.map((baseline) => [
    baseline,
    recomputedReports.capability.readerDirections[`vs_${baseline}`].criterionAccuracy,
  ]));
  const integrity = {
    evaluations: evaluations.length,
    expectedEvaluations: VERSION_AWARE_E2E_PROTOCOL.reuse.expectedReaderCalls,
    complete: evaluations.length === VERSION_AWARE_E2E_PROTOCOL.reuse.expectedReaderCalls,
    readerModelMismatches: evaluations.filter((item) =>
      item.reader.model !== VERSION_AWARE_E2E_PROTOCOL.readers.find((spec) => spec.id === item.readerId)?.model).length,
    judgeModelMismatches: evaluations.filter((item) =>
      item.judge.model !== VERSION_AWARE_E2E_PROTOCOL.judges.find((spec) => spec.id === item.judgeId)?.model).length,
    selfJudgments: evaluations.filter((item) => item.readerId === item.judgeId).length,
  };
  const checks = {
    contextExactSelection: candidateAggregate.exactSelectionAccuracy >= gate.minVersionAwareContextExactSelection,
    contextContamination: candidateAggregate.contaminationRate <= gate.maxVersionAwareContextContaminationRate,
    capabilityVsGlobal: interval(recomputedReports.capability, "global_latest", "criterionAccuracy").mean
      >= gate.minCapabilityCriterionAccuracyDeltaVsGlobal,
    capabilityVsGlobalCi: !gate.requireCapabilityCiLowerAboveZero
      || interval(recomputedReports.capability, "global_latest", "criterionAccuracy").lower > 0,
    capabilityVsOldCurrentDual: interval(recomputedReports.capability, "old_current_dual", "criterionAccuracy").mean
      >= gate.minCapabilityCriterionAccuracyDeltaVsOldCurrentDual,
    capabilityVsOldCurrentDualCi: !gate.requireCapabilityCiLowerAboveZero
      || interval(recomputedReports.capability, "old_current_dual", "criterionAccuracy").lower > 0,
    currentSlices: currentSlices.every((slice) => baselines.every((baseline) =>
      interval(recomputedReports.capability.bySlice[slice], baseline, "criterionAccuracy").mean
        >= gate.minCurrentSliceCriterionAccuracyDelta)),
    crossStateSlices: crossStateSlices.every((slice) => baselines.every((baseline) =>
      interval(recomputedReports.capability.bySlice[slice], baseline, "criterionAccuracy").mean
        >= gate.minCrossStateSliceCriterionAccuracyDelta)),
    missingScope: baselines.every((baseline) =>
      interval(recomputedReports.capability.bySlice.missing_scope_abstention, baseline, "criterionAccuracy").mean
        >= gate.minMissingScopeCriterionAccuracyDelta),
    naturalNonInferiority: baselines.every((baseline) =>
      interval(recomputedReports.natural, baseline, "fama").mean >= gate.minNaturalFamaDelta),
    combinedTokenBudget: baselines.every((baseline) =>
      combinedTokenIncreases[baseline] <= gate.maxCombinedTokenIncreaseFraction),
    readerDirection: !gate.requireNonnegativeCapabilityDirectionForBothReaders
      || baselines.every((baseline) =>
        Object.values(capabilityDirections[baseline] as Record<string, number>).every((value) => value >= 0)),
    contextIntegrity: !gate.requirePassedProductionContext || context.validation.passed,
    evaluationIntegrity: (!gate.requireCompleteFrozenTaskSet || integrity.complete)
      && (!gate.requireZeroModelMismatches
        || integrity.readerModelMismatches + integrity.judgeModelMismatches === 0)
      && (!gate.requireZeroSelfJudgments || integrity.selfJudgments === 0),
  };
  compareDeep(checks, summary.decision.checks, "decision.checks", mismatches);
  compareDeep(combinedTokenIncreases, summary.decision.combinedTokenIncreases, "decision.tokens", mismatches);
  compareDeep(capabilityDirections, summary.decision.capabilityDirections, "decision.directions", mismatches);
  const recommended = Object.values(checks).every(Boolean);
  if (summary.decision.recommended !== recommended) {
    mismatches.push({ kind: "recommendation", key: String(summary.decision.recommended) });
  }
  if (!summary.operationalIntegrity.complete || summary.operationalIntegrity.evaluations !== evaluations.length) {
    mismatches.push({ kind: "summary_integrity", key: String(summary.operationalIntegrity.evaluations) });
  }

  const report = {
    validationVersion: "version-aware-production-e2e-independent-validation-v1.0",
    status: mismatches.length ? "failed" : "passed",
    inputs: {
      contextSha256: contextHash,
      evaluationsSha256: evaluationsHash,
      summarySha256: sha256(summaryText),
    },
    counts: {
      cases: cases.length,
      naturalCases: natural.length,
      capabilityCases: capability.length,
      arms: VERSION_AWARE_E2E_PROTOCOL.arms.length,
      evaluations: evaluations.length,
      uniqueEvaluationKeys: evaluationByKey.size,
      rawVerdictsRescored: evaluations.length,
    },
    primaryRecomputation: {
      capabilityCriterionAccuracyDeltaVsGlobal:
        interval(recomputedReports.capability, "global_latest", "criterionAccuracy"),
      capabilityCriterionAccuracyDeltaVsOldCurrentDual:
        interval(recomputedReports.capability, "old_current_dual", "criterionAccuracy"),
      naturalFamaDeltaVsGlobal: interval(recomputedReports.natural, "global_latest", "fama"),
      naturalFamaDeltaVsOldCurrentDual: interval(recomputedReports.natural, "old_current_dual", "fama"),
      versionAwareContext: candidateAggregate,
      combinedTokenIncreases,
      capabilityDirections,
      checks,
      recommended,
    },
    mismatchCount: mismatches.length,
    mismatches,
  };
  await mkdir(path.dirname(params.output), { recursive: true });
  await writeFile(params.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
