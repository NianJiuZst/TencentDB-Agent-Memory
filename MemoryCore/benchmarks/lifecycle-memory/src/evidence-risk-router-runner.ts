import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EVIDENCE_RISK_ROUTER_PROTOCOL,
  type RiskFeatureId,
} from "./evidence-risk-router-protocol.js";

type Action = "v1" | "shield";
type Metric = "mpa" | "faa" | "fama" | "criterionAccuracy";
type Metrics = Record<Metric, number>;
type Comparator = "gte" | "lte";

interface EvaluationRow {
  protocolVersion: string;
  caseId: string;
  persona: string;
  readerId: string;
  arm: string;
  injectedTokens: number;
  judges: Record<string, { metrics: Metrics }>;
}

interface ManifestCase {
  caseId: string;
  changedCandidates: number;
  redactions: number;
  v1CandidateIds: string[];
}

interface ContextManifest {
  protocolVersion: string;
  cases: ManifestCase[];
}

export interface RiskPolicy {
  id: string;
  feature: RiskFeatureId;
  comparator: Comparator;
  threshold: number;
}

export interface RiskRouterCase {
  caseId: string;
  persona: string;
  features: Record<RiskFeatureId, number>;
  tokens: Record<Action, number>;
  primary: Record<Action, Metrics>;
  readerMetrics: Record<string, Record<Action, Metrics>>;
}

interface PolicyScore {
  policyId: string;
  cases: number;
  shieldCases: number;
  shieldActionRate: number;
  arms: {
    v1: Metrics & { meanInjectedTokens: number };
    routed: Metrics & { meanInjectedTokens: number };
  };
  routedVsV1: Metrics & { meanInjectedTokenIncreaseFraction: number };
  perReaderFamaDelta: Record<string, number>;
}

interface FoldResult {
  heldOutPersona: string;
  trainingPersonas: string[];
  selectedPolicyId: string;
  selectionFallback: boolean;
  eligiblePolicies: number;
  trainingScore: PolicyScore;
  heldOutCaseIds: string[];
  heldOutActions: Record<string, Action>;
}

export interface EvidenceRiskRouterRunOptions {
  contextManifest: string;
  v1Evaluations: string;
  shieldEvaluations: string;
  validation: string;
  output: string;
}

const METRICS: Metric[] = ["mpa", "faa", "fama", "criterionAccuracy"];
const EPSILON = 1e-12;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function meanMetrics(values: Metrics[]): Metrics {
  return Object.fromEntries(METRICS.map((metric) => [
    metric,
    mean(values.map((item) => item[metric])),
  ])) as Metrics;
}

function thresholdId(value: number): string {
  return String(value).replace("-", "neg").replace(".", "p");
}

export function enumerateRiskPolicies(): RiskPolicy[] {
  return EVIDENCE_RISK_ROUTER_PROTOCOL.features.allowed.flatMap((feature) =>
    EVIDENCE_RISK_ROUTER_PROTOCOL.policyClass.comparators.flatMap((comparator) =>
      feature.thresholds.map((threshold) => ({
        id: `${feature.id}.${comparator}.${thresholdId(threshold)}`,
        feature: feature.id,
        comparator,
        threshold,
      }))
    )
  );
}

export function routeRiskCase(item: RiskRouterCase, policy?: RiskPolicy): Action {
  if (!policy) return "v1";
  const value = item.features[policy.feature];
  if (!Number.isFinite(value)) return "v1";
  const matches = policy.comparator === "gte"
    ? value >= policy.threshold
    : value <= policy.threshold;
  return matches ? "shield" : "v1";
}

function aggregate(cases: RiskRouterCase[], actions: Map<string, Action>, arm: "v1" | "routed") {
  const selected = cases.map((item) => arm === "v1" ? "v1" : actions.get(item.caseId) ?? "v1");
  return {
    ...meanMetrics(cases.map((item, index) => item.primary[selected[index]])),
    meanInjectedTokens: mean(cases.map((item, index) => item.tokens[selected[index]])),
  };
}

function scorePolicy(cases: RiskRouterCase[], policy: RiskPolicy | undefined): PolicyScore {
  const actions = new Map(cases.map((item) => [item.caseId, routeRiskCase(item, policy)]));
  const v1 = aggregate(cases, actions, "v1");
  const routed = aggregate(cases, actions, "routed");
  const readers = [...new Set(cases.flatMap((item) => Object.keys(item.readerMetrics)))].sort();
  const shieldCases = [...actions.values()].filter((action) => action === "shield").length;
  return {
    policyId: policy?.id ?? "always-v1",
    cases: cases.length,
    shieldCases,
    shieldActionRate: shieldCases / cases.length,
    arms: { v1, routed },
    routedVsV1: {
      ...Object.fromEntries(METRICS.map((metric) => [metric, routed[metric] - v1[metric]])) as Metrics,
      meanInjectedTokenIncreaseFraction: v1.meanInjectedTokens
        ? routed.meanInjectedTokens / v1.meanInjectedTokens - 1
        : 0,
    },
    perReaderFamaDelta: Object.fromEntries(readers.map((reader) => [
      reader,
      mean(cases.map((item) => {
        const action = actions.get(item.caseId) ?? "v1";
        return item.readerMetrics[reader][action].fama - item.readerMetrics[reader].v1.fama;
      })),
    ])),
  };
}

function isEligible(score: PolicyScore): boolean {
  const constraints = EVIDENCE_RISK_ROUTER_PROTOCOL.crossFitting.trainingConstraintsVsV1;
  return score.routedVsV1.fama >= constraints.minFamaDelta - EPSILON
    && score.routedVsV1.faa >= constraints.minFaaDelta - EPSILON
    && score.routedVsV1.mpa >= -constraints.maxMpaLoss - EPSILON
    && score.routedVsV1.meanInjectedTokenIncreaseFraction
      <= constraints.maxMeanInjectedTokenIncreaseFraction + EPSILON
    && (!constraints.requireNonnegativeFamaDirectionForEachReader
      || Object.values(score.perReaderFamaDelta).every((value) => value >= -EPSILON))
    && score.shieldActionRate >= constraints.minShieldActionRate - EPSILON
    && score.shieldActionRate <= constraints.maxShieldActionRate + EPSILON;
}

function compareScores(left: PolicyScore, right: PolicyScore): number {
  const tolerance = EVIDENCE_RISK_ROUTER_PROTOCOL.crossFitting.selectionTolerance;
  const numeric = [
    left.routedVsV1.fama - right.routedVsV1.fama,
    left.routedVsV1.criterionAccuracy - right.routedVsV1.criterionAccuracy,
    left.routedVsV1.faa - right.routedVsV1.faa,
    right.routedVsV1.meanInjectedTokenIncreaseFraction
      - left.routedVsV1.meanInjectedTokenIncreaseFraction,
  ];
  for (const delta of numeric) {
    if (Math.abs(delta) > tolerance) return delta > 0 ? -1 : 1;
  }
  return left.policyId.localeCompare(right.policyId);
}

export function fitCrossFittedRouter(cases: RiskRouterCase[]): FoldResult[] {
  const policies = enumerateRiskPolicies();
  const personas = [...new Set(cases.map((item) => item.persona))].sort();
  return personas.map((heldOutPersona): FoldResult => {
    const training = cases.filter((item) => item.persona !== heldOutPersona);
    const heldOut = cases.filter((item) => item.persona === heldOutPersona);
    const eligible = policies.map((policy) => ({ policy, score: scorePolicy(training, policy) }))
      .filter((item) => isEligible(item.score))
      .sort((left, right) => compareScores(left.score, right.score));
    const selected = eligible[0]?.policy;
    const trainingScore = eligible[0]?.score ?? scorePolicy(training, undefined);
    return {
      heldOutPersona,
      trainingPersonas: [...new Set(training.map((item) => item.persona))].sort(),
      selectedPolicyId: selected?.id ?? "always-v1",
      selectionFallback: !selected,
      eligiblePolicies: eligible.length,
      trainingScore,
      heldOutCaseIds: heldOut.map((item) => item.caseId),
      heldOutActions: Object.fromEntries(heldOut.map((item) => [
        item.caseId,
        routeRiskCase(item, selected),
      ])),
    };
  });
}

function crossFittedScore(cases: RiskRouterCase[], folds: FoldResult[]): PolicyScore {
  const actions = new Map(folds.flatMap((fold) => Object.entries(fold.heldOutActions)));
  const v1 = aggregate(cases, actions, "v1");
  const routed = aggregate(cases, actions, "routed");
  const readers = [...new Set(cases.flatMap((item) => Object.keys(item.readerMetrics)))].sort();
  const shieldCases = [...actions.values()].filter((action) => action === "shield").length;
  return {
    policyId: "cross-fitted",
    cases: cases.length,
    shieldCases,
    shieldActionRate: shieldCases / cases.length,
    arms: { v1, routed },
    routedVsV1: {
      ...Object.fromEntries(METRICS.map((metric) => [metric, routed[metric] - v1[metric]])) as Metrics,
      meanInjectedTokenIncreaseFraction: v1.meanInjectedTokens
        ? routed.meanInjectedTokens / v1.meanInjectedTokens - 1
        : 0,
    },
    perReaderFamaDelta: Object.fromEntries(readers.map((reader) => [
      reader,
      mean(cases.map((item) => {
        const action = actions.get(item.caseId) ?? "v1";
        return item.readerMetrics[reader][action].fama - item.readerMetrics[reader].v1.fama;
      })),
    ])),
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

function bootstrap(
  cases: RiskRouterCase[],
  actions: Map<string, Action>,
  metric: Metric,
  seed: number,
) {
  const byPersona = new Map<string, RiskRouterCase[]>();
  for (const item of cases) {
    const selected = byPersona.get(item.persona) ?? [];
    selected.push(item);
    byPersona.set(item.persona, selected);
  }
  const clusters = [...byPersona.values()];
  const delta = (item: RiskRouterCase) => {
    const action = actions.get(item.caseId) ?? "v1";
    return item.primary[action][metric] - item.primary.v1[metric];
  };
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < EVIDENCE_RISK_ROUTER_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const selected: RiskRouterCase[] = [];
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

function evaluateGate(params: {
  score: PolicyScore;
  personaCoverage: boolean;
  deterministicReplay: boolean;
}) {
  const gate = EVIDENCE_RISK_ROUTER_PROTOCOL.gate;
  const checks = {
    famaDirection: !gate.requirePositiveCrossFittedFamaDelta
      || params.score.routedVsV1.fama > 0,
    faaMagnitude: params.score.routedVsV1.faa >= gate.minCrossFittedFaaDelta,
    mpaNonInferiority: params.score.routedVsV1.mpa >= -gate.maxCrossFittedMpaLoss,
    tokenBudget: params.score.routedVsV1.meanInjectedTokenIncreaseFraction
      <= gate.maxMeanInjectedTokenIncreaseFraction + EPSILON,
    perReaderFamaDirection: !gate.requireNonnegativeFamaDirectionForEachReader
      || Object.values(params.score.perReaderFamaDelta).every((value) => value >= -EPSILON),
    nontrivialActionRate: params.score.shieldActionRate >= gate.minOverallShieldActionRate,
    personaCoverage: !gate.requireEveryPersonaHeldOutExactlyOnce || params.personaCoverage,
    deterministicReplay: !gate.requireDeterministicReplay || params.deterministicReplay,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

function rowKey(row: EvaluationRow): string {
  return `${row.caseId}\0${row.readerId}`;
}

function parseRows(text: string, arm: Action): EvaluationRow[] {
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvaluationRow)
    .filter((row) => row.arm === arm);
  if (new Set(rows.map(rowKey)).size !== rows.length) {
    throw new Error(`duplicate evidence-risk ${arm} evaluation cell`);
  }
  return rows;
}

function buildCases(params: {
  manifest: ContextManifest;
  v1: EvaluationRow[];
  shield: EvaluationRow[];
}): RiskRouterCase[] {
  const readers = [...new Set(params.shield.map((row) => row.readerId))].sort();
  if (readers.length !== 2) throw new Error("evidence-risk router requires two readers");
  const v1ByKey = new Map(params.v1.map((row) => [rowKey(row), row]));
  const shieldByKey = new Map(params.shield.map((row) => [rowKey(row), row]));
  return params.manifest.cases.map((manifestCase): RiskRouterCase => {
    const v1Rows = readers.map((reader) => v1ByKey.get(`${manifestCase.caseId}\0${reader}`));
    const shieldRows = readers.map((reader) => shieldByKey.get(`${manifestCase.caseId}\0${reader}`));
    if (v1Rows.some((row) => !row) || shieldRows.some((row) => !row)) {
      throw new Error(`missing evidence-risk paired cell ${manifestCase.caseId}`);
    }
    const paired = { v1: v1Rows as EvaluationRow[], shield: shieldRows as EvaluationRow[] };
    const persona = paired.shield[0].persona;
    if ([...paired.v1, ...paired.shield].some((row) => row.persona !== persona)) {
      throw new Error(`evidence-risk persona mismatch ${manifestCase.caseId}`);
    }
    const tokens = Object.fromEntries((["v1", "shield"] as Action[]).map((arm) => {
      const values = new Set(paired[arm].map((row) => row.injectedTokens));
      if (values.size !== 1) throw new Error(`evidence-risk token mismatch ${manifestCase.caseId}/${arm}`);
      return [arm, paired[arm][0].injectedTokens];
    })) as Record<Action, number>;
    const readerMetrics = Object.fromEntries(readers.map((reader) => [
      reader,
      Object.fromEntries((["v1", "shield"] as Action[]).map((arm) => {
        const row = paired[arm].find((item) => item.readerId === reader)!;
        const judge = readers.find((candidate) => candidate !== reader)!;
        const judged = row.judges[judge];
        if (!judged) throw new Error(`missing cross-judge cell ${manifestCase.caseId}/${reader}/${arm}`);
        return [arm, judged.metrics];
      })) as Record<Action, Metrics>,
    ])) as Record<string, Record<Action, Metrics>>;
    const primary = Object.fromEntries((["v1", "shield"] as Action[]).map((arm) => [
      arm,
      meanMetrics(readers.map((reader) => readerMetrics[reader][arm])),
    ])) as Record<Action, Metrics>;
    return {
      caseId: manifestCase.caseId,
      persona,
      features: {
        redactionCount: manifestCase.redactions,
        changedCandidateCount: manifestCase.changedCandidates,
        redactionDensity: manifestCase.redactions / Math.max(1, manifestCase.v1CandidateIds.length),
        tokenSavingsFraction: (tokens.v1 - tokens.shield) / Math.max(1, tokens.v1),
      },
      tokens,
      primary,
      readerMetrics,
    };
  });
}

export async function runEvidenceRiskRouter(
  options: EvidenceRiskRouterRunOptions,
): Promise<Record<string, unknown>> {
  const [manifestText, v1Text, shieldText, validationText] = await Promise.all([
    readFile(options.contextManifest, "utf8"),
    readFile(options.v1Evaluations, "utf8"),
    readFile(options.shieldEvaluations, "utf8"),
    readFile(options.validation, "utf8"),
  ]);
  const hashes = {
    contextManifest: sha256(manifestText),
    v1Evaluations: sha256(v1Text),
    shieldEvaluations: sha256(shieldText),
    validation: sha256(validationText),
  };
  const expected = EVIDENCE_RISK_ROUTER_PROTOCOL.inputs;
  if (hashes.contextManifest !== expected.contextManifest.sha256
    || hashes.v1Evaluations !== expected.v1Evaluations.sha256
    || hashes.shieldEvaluations !== expected.shieldEvaluations.sha256
    || hashes.validation !== expected.independentValidation.sha256) {
    throw new Error("evidence-risk router input hash mismatch");
  }
  const validation = JSON.parse(validationText) as { status?: string };
  if (validation.status !== expected.independentValidation.requiredStatus) {
    throw new Error("evidence-risk router requires passed independent validation");
  }
  const manifest = JSON.parse(manifestText) as ContextManifest;
  if (manifest.protocolVersion !== expected.contextManifest.protocolVersion
    || manifest.cases.length !== expected.contextManifest.cases) {
    throw new Error("evidence-risk router context manifest mismatch");
  }
  const v1 = parseRows(v1Text, "v1");
  const shield = parseRows(shieldText, "shield");
  if (v1.length !== expected.v1Evaluations.selectedRows
    || shield.length !== expected.shieldEvaluations.selectedRows) {
    throw new Error("evidence-risk router evaluation row count mismatch");
  }
  const cases = buildCases({ manifest, v1, shield });
  const folds = fitCrossFittedRouter(cases);
  const replay = fitCrossFittedRouter(cases);
  const deterministicReplay = JSON.stringify(folds) === JSON.stringify(replay);
  const heldOutPersonas = folds.map((fold) => fold.heldOutPersona);
  const personaSet = new Set(cases.map((item) => item.persona));
  const personaCoverage = folds.length === EVIDENCE_RISK_ROUTER_PROTOCOL.crossFitting.folds
    && new Set(heldOutPersonas).size === personaSet.size
    && heldOutPersonas.every((persona) => personaSet.has(persona))
    && folds.every((fold) => !fold.trainingPersonas.includes(fold.heldOutPersona));
  const score = crossFittedScore(cases, folds);
  const actions = new Map(folds.flatMap((fold) => Object.entries(fold.heldOutActions)));
  const intervals = Object.fromEntries(METRICS.map((metric, index) => [
    metric,
    bootstrap(cases, actions, metric, EVIDENCE_RISK_ROUTER_PROTOCOL.seed + index),
  ]));
  const gate = evaluateGate({ score, personaCoverage, deterministicReplay });
  const report = {
    status: gate.passed ? "passed" : "failed",
    nextAction: gate.passed
      ? "implement_bounded_sidecar_then_seek_untouched_confirmation"
      : "reject_candidate_and_continue_to_D3",
    protocol: EVIDENCE_RISK_ROUTER_PROTOCOL,
    generatedAt: new Date().toISOString(),
    input: {
      contextManifest: path.resolve(options.contextManifest),
      v1Evaluations: path.resolve(options.v1Evaluations),
      shieldEvaluations: path.resolve(options.shieldEvaluations),
      validation: path.resolve(options.validation),
      hashes,
    },
    integrity: {
      cases: cases.length,
      personas: personaSet.size,
      v1Rows: v1.length,
      shieldRows: shield.length,
      policies: enumerateRiskPolicies().length,
      personaCoverage,
      deterministicReplay,
    },
    crossFitted: {
      ...score,
      personaBootstrap95: intervals,
      policySelectionCounts: Object.fromEntries([...new Set(folds.map((fold) => fold.selectedPolicyId))]
        .sort().map((policyId) => [
          policyId,
          folds.filter((fold) => fold.selectedPolicyId === policyId).length,
        ])),
      folds,
    },
    gate,
    caveats: [
      "Both potential actions were already observed, so routing is evaluated without response imputation.",
      "Cross-fitting prevents a persona's own outcomes from selecting its rule, but the full panel remains reused development data.",
      "The policy class excludes persona, task, model, answer, and gold-label features and cannot add post-score thresholds.",
      "A pass requires a bounded runtime sidecar and untouched public or internal confirmation before promotion.",
    ],
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
