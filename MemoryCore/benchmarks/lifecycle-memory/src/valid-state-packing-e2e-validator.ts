import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";

type Arm = "v1" | "valid_state_packing";
type Metric = "mpa" | "faa" | "fama" | "criterionAccuracy";
type Metrics = Record<Metric, number>;

interface ValidatorOptions {
  actualEvaluations: string;
  contextManifest: string;
  dataRoot: string;
  evaluations: string;
  output: string;
  selection: string;
  summary: string;
  bootstrapSamples?: number;
  seed?: number;
  skipHashVerification?: boolean;
}

interface CriterionTransition {
  total: number;
  sameCorrect: number;
  sameWrong: number;
  v1CorrectCandidateWrong: number;
  v1WrongCandidateCorrect: number;
  netCorrectDelta: number;
}

const METRICS: Metric[] = ["mpa", "faa", "fama", "criterionAccuracy"];
const ARMS: Arm[] = ["v1", "valid_state_packing"];

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

function evaluationKey(item: Record<string, any>): string {
  return `${item.caseId}\0${item.readerId}\0${item.arm}`;
}

function sameContexts(left: Array<Record<string, any>>, right: Array<Record<string, any>>): boolean {
  return JSON.stringify(left.map((item) => ({
    id: item.id,
    content: item.content,
    tokenCount: item.tokenCount,
  }))) === JSON.stringify(right.map((item) => ({
    id: item.id,
    content: item.content,
    tokenCount: item.tokenCount,
  })));
}

function stripCloneProvenance(item: Record<string, any>): Record<string, any> {
  const { arm: _arm, sharedNoop: _sharedNoop, ...rest } = item;
  return rest;
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
  cases: Array<Record<string, any>>;
  metric: Metric;
  samples: number;
  seed: number;
}) {
  const byPersona = new Map<string, Array<Record<string, any>>>();
  for (const item of params.cases) {
    const cluster = byPersona.get(item.persona) ?? [];
    cluster.push(item);
    byPersona.set(item.persona, cluster);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: Record<string, any>) =>
    item.arms.valid_state_packing.primary[params.metric]
      - item.arms.v1.primary[params.metric];
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
    v1CorrectCandidateWrong: 0,
    v1WrongCandidateCorrect: 0,
    netCorrectDelta: 0,
  };
}

function addTransitions(
  output: CriterionTransition,
  v1: Array<Record<string, any>>,
  candidate: Array<Record<string, any>>,
): void {
  const v1ById = new Map(v1.map((item) => [item.id, item]));
  for (const current of candidate) {
    const previous = v1ById.get(current.id);
    if (!previous) throw new Error(`missing V1 criterion ${current.id}`);
    output.total += 1;
    if (previous.correct && current.correct) output.sameCorrect += 1;
    else if (!previous.correct && !current.correct) output.sameWrong += 1;
    else if (previous.correct) output.v1CorrectCandidateWrong += 1;
    else output.v1WrongCandidateCorrect += 1;
  }
  if (v1ById.size !== candidate.length) throw new Error("criterion transition count mismatch");
  output.netCorrectDelta = output.v1WrongCandidateCorrect - output.v1CorrectCandidateWrong;
}

function compareMetricObject(
  actual: Record<string, any>,
  expected: Record<string, any>,
): number {
  return METRICS.reduce((count, metric) =>
    count + Number(!close(actual[metric], expected[metric])), 0);
}

export async function validateValidStatePackingE2E(
  options: ValidatorOptions,
): Promise<Record<string, unknown>> {
  const [
    actualText,
    evaluationsText,
    summaryText,
    selectionText,
    manifestText,
    loaded,
  ] = await Promise.all([
    readFile(options.actualEvaluations, "utf8"),
    readFile(options.evaluations, "utf8"),
    readFile(options.summary, "utf8"),
    readFile(options.selection, "utf8"),
    readFile(options.contextManifest, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const actual = actualText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const rows = evaluationsText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const summary = JSON.parse(summaryText);
  const selection = JSON.parse(selectionText);
  const manifest = JSON.parse(manifestText);
  const readers: string[] = summary.protocol.readers.map((item: Record<string, any>) => item.id);
  const judges: string[] = summary.protocol.judges.map((item: Record<string, any>) => item.id);
  const readerModels = new Map(summary.protocol.readers.map(
    (item: Record<string, any>) => [item.id, item.model],
  ));
  const judgeModels = new Map(summary.protocol.judges.map(
    (item: Record<string, any>) => [item.id, item.model],
  ));
  const manifestById = new Map(manifest.cases.map(
    (item: Record<string, any>) => [item.caseId, item],
  ));
  const questions = new Map(loaded.groups.flatMap((group) =>
    group.questions.map((question) => [question.id, question] as const)
  ));

  const expectedFinalKeys = new Set<string>();
  const expectedActualKeys = new Set<string>();
  let unchangedCases = 0;
  for (const selected of selection.selected as Array<Record<string, any>>) {
    const context = manifestById.get(selected.caseId) as Record<string, any> | undefined;
    if (!context) throw new Error(`missing validator context ${selected.caseId}`);
    const unchanged = sameContexts(context.arms.v1, context.arms.valid_state_packing);
    unchangedCases += Number(unchanged);
    for (const reader of readers) {
      expectedFinalKeys.add(`${selected.caseId}\0${reader}\0v1`);
      expectedFinalKeys.add(`${selected.caseId}\0${reader}\0valid_state_packing`);
      expectedActualKeys.add(`${selected.caseId}\0${reader}\0v1`);
      if (!unchanged) expectedActualKeys.add(`${selected.caseId}\0${reader}\0valid_state_packing`);
    }
  }

  const finalKeys = new Set<string>();
  const actualKeys = new Set<string>();
  let duplicateFinalKeys = 0;
  let duplicateActualKeys = 0;
  for (const row of rows) {
    const key = evaluationKey(row);
    duplicateFinalKeys += Number(finalKeys.has(key));
    finalKeys.add(key);
  }
  for (const row of actual) {
    const key = evaluationKey(row);
    duplicateActualKeys += Number(actualKeys.has(key));
    actualKeys.add(key);
  }

  const finalByKey = new Map(rows.map((item) => [evaluationKey(item), item]));
  const actualByKey = new Map(actual.map((item) => [evaluationKey(item), item]));
  let candidateContextMismatches = 0;
  let actualProjectionMismatches = 0;
  let cloneMismatches = 0;
  let cloneRows = 0;
  let verdictConsistencyMismatches = 0;
  let criterionSchemaMismatches = 0;
  let metricMismatches = 0;
  let readerModelMismatches = 0;
  let judgeModelMismatches = 0;
  let readerRetries = 0;
  let judgeRetries = 0;
  let unclearVerdicts = 0;
  for (const row of rows) {
    const context = manifestById.get(row.caseId) as Record<string, any> | undefined;
    const question = questions.get(row.caseId);
    if (!context || !question) throw new Error(`missing validator case ${row.caseId}`);
    const expectedContext = context.arms[row.arm as Arm] as Array<Record<string, any>>;
    candidateContextMismatches += Number(
      row.candidateIds.join("\0") !== expectedContext.map((item) => item.id).join("\0")
      || row.injectedTokens !== expectedContext.reduce(
        (sum: number, item: Record<string, any>) => sum + item.tokenCount,
        0,
      ),
    );
    const actualRow = actualByKey.get(evaluationKey(row));
    if (row.sharedNoop) {
      cloneRows += 1;
      const v1 = finalByKey.get(`${row.caseId}\0${row.readerId}\0v1`);
      cloneMismatches += Number(
        !v1
        || row.sharedNoop.sourceArm !== "v1"
        || row.sharedNoop.sourceKey !== evaluationKey(v1)
        || JSON.stringify(stripCloneProvenance(row)) !== JSON.stringify(stripCloneProvenance(v1)),
      );
    } else {
      actualProjectionMismatches += Number(
        !actualRow || JSON.stringify(row) !== JSON.stringify(actualRow),
      );
    }
    readerRetries += row.sharedNoop ? 0 : row.readerAttempts - 1;
    readerModelMismatches += Number(row.reader.model !== readerModels.get(row.readerId));
    for (const judge of judges) {
      const judged = row.judges[judge];
      judgeRetries += row.sharedNoop ? 0 : judged.attempts - 1;
      judgeModelMismatches += Number(judged.response.model !== judgeModels.get(judge));
      const criteria = question.evaluationQuestions;
      const criteriaById = new Map(criteria.map((item) => [item.id, item]));
      criterionSchemaMismatches += Number(
        judged.verdicts.length !== criteria.length
        || new Set(judged.verdicts.map((item: Record<string, any>) => item.id)).size
          !== criteria.length,
      );
      for (const verdict of judged.verdicts) {
        const criterion = criteriaById.get(verdict.id);
        criterionSchemaMismatches += Number(
          !criterion
          || verdict.type !== criterion.type
          || verdict.expectedAnswer !== criterion.expectedAnswer,
        );
        verdictConsistencyMismatches += Number(
          verdict.correct !== (verdict.answer === verdict.expectedAnswer),
        );
        unclearVerdicts += Number(verdict.answer === "unclear");
      }
      metricMismatches += compareMetricObject(score(judged.verdicts), judged.metrics);
    }
  }

  const panelCases = (selection.selected as Array<Record<string, any>>).map((selected) => {
    const context = manifestById.get(selected.caseId) as Record<string, any>;
    const unchanged = sameContexts(context.arms.v1, context.arms.valid_state_packing);
    return {
      caseId: selected.caseId,
      persona: selected.persona,
      unchanged,
      arms: Object.fromEntries(ARMS.map((arm) => {
        const crossed = readers.map((reader) => {
          const judge = judges.find((item) => item !== reader)!;
          return finalByKey.get(`${selected.caseId}\0${reader}\0${arm}`).judges[judge].metrics;
        });
        const full = readers.flatMap((reader) => judges.map((judge) =>
          finalByKey.get(`${selected.caseId}\0${reader}\0${arm}`).judges[judge].metrics
        ));
        const first = finalByKey.get(`${selected.caseId}\0${readers[0]}\0${arm}`);
        return [arm, {
          primary: meanMetrics(crossed),
          fullFactorial: meanMetrics(full),
          injectedTokens: first.injectedTokens,
        }];
      })),
    };
  });
  const changedCases = panelCases.filter((item) => !item.unchanged);
  const aggregate = (cases: Array<Record<string, any>>, arm: Arm, mode: string) => ({
    ...meanMetrics(cases.map((item) => item.arms[arm][mode])),
    meanInjectedTokens: mean(cases.map((item) => item.arms[arm].injectedTokens)),
  });
  const recomputedPrimary = Object.fromEntries(ARMS.map((arm) => [
    arm,
    aggregate(panelCases, arm, "primary"),
  ]));
  const recomputedFull = Object.fromEntries(ARMS.map((arm) => [
    arm,
    aggregate(panelCases, arm, "fullFactorial"),
  ]));
  const recomputedChanged = Object.fromEntries(ARMS.map((arm) => [
    arm,
    aggregate(changedCases, arm, "primary"),
  ]));
  const delta = (cases: Array<Record<string, any>>, metric: Metric, mode: string) =>
    mean(cases.map((item) =>
      item.arms.valid_state_packing[mode][metric] - item.arms.v1[mode][metric]
    ));
  const recomputedDelta = Object.fromEntries(METRICS.map((metric) => [
    metric,
    delta(panelCases, metric, "primary"),
  ])) as Metrics;
  let summaryMismatches = 0;
  for (const arm of ARMS) {
    const summaryArm = arm === "v1" ? "v1" : "validStatePacking";
    summaryMismatches += compareMetricObject(
      recomputedPrimary[arm],
      summary.primary.arms[summaryArm],
    );
    summaryMismatches += Number(!close(
      recomputedPrimary[arm].meanInjectedTokens,
      summary.primary.arms[summaryArm].meanInjectedTokens,
    ));
    summaryMismatches += compareMetricObject(
      recomputedFull[arm],
      summary.fullFactorialSensitivity.arms[summaryArm],
    );
    summaryMismatches += compareMetricObject(
      recomputedChanged[arm],
      summary.changedContextSensitivity.arms[summaryArm],
    );
  }
  for (const metric of METRICS) {
    summaryMismatches += Number(!close(
      recomputedDelta[metric],
      summary.primary.validStatePackingVsV1[metric].mean,
    ));
  }

  const presenceTransitions = emptyTransition();
  const forgettingTransitions = emptyTransition();
  for (const item of panelCases) {
    for (const reader of readers) {
      const judge = judges.find((value) => value !== reader)!;
      const v1 = finalByKey.get(`${item.caseId}\0${reader}\0v1`).judges[judge].verdicts;
      const candidate = finalByKey.get(
        `${item.caseId}\0${reader}\0valid_state_packing`,
      ).judges[judge].verdicts;
      addTransitions(
        presenceTransitions,
        v1.filter((criterion: Record<string, any>) => criterion.type === "memory_presence"),
        candidate.filter((criterion: Record<string, any>) => criterion.type === "memory_presence"),
      );
      addTransitions(
        forgettingTransitions,
        v1.filter((criterion: Record<string, any>) => criterion.type === "forgetting_absence"),
        candidate.filter((criterion: Record<string, any>) => criterion.type === "forgetting_absence"),
      );
    }
  }

  const samples = options.bootstrapSamples ?? 20_000;
  const seed = options.seed ?? 938_475;
  const alternativeBootstrap = Object.fromEntries(METRICS.map((metric, index) => [
    metric,
    bootstrap({ cases: panelCases, metric, samples, seed: seed + index }),
  ]));
  const changedFamaDeltas = changedCases.map((item) =>
    item.arms.valid_state_packing.primary.fama - item.arms.v1.primary.fama
  );
  const checks = {
    inputHashes: sha256(selectionText) === summary.input.selection
      && sha256(manifestText) === summary.input.contextManifest,
    datasetRevision: loaded.description.revision === summary.dataset.revision,
    finalRowCount: rows.length === summary.protocol.execution.expectedArmRows,
    actualRowCount: actual.length === summary.protocol.execution.expectedReaderCalls,
    expectedFinalKeys: finalKeys.size === expectedFinalKeys.size
      && [...finalKeys].every((key) => expectedFinalKeys.has(key)),
    expectedActualKeys: actualKeys.size === expectedActualKeys.size
      && [...actualKeys].every((key) => expectedActualKeys.has(key)),
    uniqueKeys: duplicateFinalKeys === 0 && duplicateActualKeys === 0,
    candidateContexts: candidateContextMismatches === 0,
    actualProjection: actualProjectionMismatches === 0,
    exactNoopClones: cloneRows === unchangedCases * readers.length && cloneMismatches === 0,
    verdictConsistency: verdictConsistencyMismatches === 0,
    criterionSchema: criterionSchemaMismatches === 0,
    metricRecomputation: metricMismatches === 0,
    summaryRecomputation: summaryMismatches === 0,
    alternativeBootstrapFinite: Object.values(alternativeBootstrap).every(
      (interval: any) => [interval.mean, interval.lower, interval.upper].every(Number.isFinite),
    ),
    returnedModels: readerModelMismatches === 0 && judgeModelMismatches === 0,
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocolVersion: summary.protocol.protocolVersion,
    input: {
      actualEvaluationsSha256: sha256(actualText),
      evaluationsSha256: sha256(evaluationsText),
      summarySha256: sha256(summaryText),
      selectionSha256: sha256(selectionText),
      contextManifestSha256: sha256(manifestText),
    },
    integrity: {
      actualRows: actual.length,
      finalRows: rows.length,
      cases: panelCases.length,
      changedCases: changedCases.length,
      unchangedCases,
      duplicateFinalKeys,
      duplicateActualKeys,
      candidateContextMismatches,
      actualProjectionMismatches,
      cloneRows,
      cloneMismatches,
      verdictConsistencyMismatches,
      criterionSchemaMismatches,
      metricMismatches,
      summaryMismatches,
      readerRetries,
      judgeRetries,
      readerModelMismatches,
      judgeModelMismatches,
      unclearVerdicts,
    },
    recomputedPrimary,
    recomputedValidStatePackingVsV1: recomputedDelta,
    changedContextFama: {
      cases: changedCases.length,
      improved: changedFamaDeltas.filter((value) => value > 0).length,
      unchanged: changedFamaDeltas.filter((value) => value === 0).length,
      harmed: changedFamaDeltas.filter((value) => value < 0).length,
      meanDelta: mean(changedFamaDeltas),
    },
    criterionTransitions: {
      memoryPresence: presenceTransitions,
      forgettingAbsence: forgettingTransitions,
    },
    alternativeBootstrap: {
      samples,
      seed,
      unit: "persona",
      validStatePackingVsV1: alternativeBootstrap,
    },
    checks,
    caveats: [
      "The alternative bootstrap changes the random seed, not the sampling unit or panel.",
      "Criterion transitions are descriptive because criteria within a case are correlated.",
      "A validator pass confirms arithmetic and provenance, not the candidate efficacy gate.",
    ],
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
