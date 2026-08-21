import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import {
  loadMemOpsInstance,
  type MemOpsInstance,
  type MemOpsMappedProbe,
} from "./memops-adapter.js";
import { MEMOPS_TARGET_STATE_PROTOCOL } from "./memops-target-state-protocol.js";

type Metric = "currentStateRecall" | "staleAbsence" | "staleAnyAbsence"
  | "stateFama" | "goldProvenanceRecall";
type Metrics = Record<Metric, number> & { injectedItems: number; injectedTokens: number };

interface ValidatorOptions {
  cases: string;
  dataRoot: string;
  output: string;
  phase: "validation" | "test";
  summary: string;
  bootstrapSamples?: number;
  seed?: number;
}

interface GoldState {
  activeByTarget: Map<string, Set<string>>;
  historyByTarget: Map<string, Set<string>>;
  targetsByUnit: Map<string, Set<string>>;
}

const METRICS: Metric[] = [
  "currentStateRecall",
  "staleAbsence",
  "staleAnyAbsence",
  "stateFama",
  "goldProvenanceRecall",
];
const encoding = getEncoding("cl100k_base");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-12;
}

function operationUnitIds(operation: MemOpsInstance["operations"][number]): string[] {
  return [...new Set([operation.triggerUnitId, ...operation.evidenceUnitIds])];
}

function buildGold(instance: MemOpsInstance): GoldState {
  const activeByTarget = new Map<string, Set<string>>();
  const historyByTarget = new Map<string, Set<string>>();
  const targetsByUnit = new Map<string, Set<string>>();
  const confirmed = new Map<string, MemOpsInstance["operations"]>();
  for (const operation of instance.operations) {
    const targetId = operation.target.target_id;
    const history = historyByTarget.get(targetId) ?? new Set<string>();
    for (const unitId of operationUnitIds(operation)) {
      history.add(unitId);
      const targets = targetsByUnit.get(unitId) ?? new Set<string>();
      targets.add(targetId);
      targetsByUnit.set(unitId, targets);
    }
    historyByTarget.set(targetId, history);
    if (operation.validity === "confirmed") {
      const operations = confirmed.get(targetId) ?? [];
      operations.push(operation);
      confirmed.set(targetId, operations);
    }
  }
  for (const [targetId, operations] of confirmed) {
    const latest = [...operations].sort((left, right) =>
      left.triggerSequence - right.triggerSequence
      || left.operation_id.localeCompare(right.operation_id)
    ).at(-1)!;
    activeByTarget.set(
      targetId,
      latest.type === "forget" ? new Set() : new Set(operationUnitIds(latest)),
    );
  }
  return { activeByTarget, historyByTarget, targetsByUnit };
}

function relevantTargets(probe: MemOpsMappedProbe, gold: GoldState): string[] {
  return [...new Set(probe.goldProvenanceUnitIds.flatMap((unitId) =>
    [...(gold.targetsByUnit.get(unitId) ?? [])]
  ))].sort();
}

function score(params: {
  candidateIds: string[];
  gold: GoldState;
  probe: MemOpsMappedProbe;
  tokenById: Map<string, number>;
}): { metrics: Metrics; relevantTargetIds: string[] } {
  const targetIds = relevantTargets(params.probe, params.gold);
  const active = new Set<string>();
  const stale = new Set<string>();
  for (const targetId of targetIds) {
    for (const unitId of params.gold.activeByTarget.get(targetId) ?? []) active.add(unitId);
    for (const unitId of params.gold.historyByTarget.get(targetId) ?? []) stale.add(unitId);
  }
  for (const unitId of active) stale.delete(unitId);
  const selected = new Set(params.candidateIds);
  const activeHits = [...active].filter((unitId) => selected.has(unitId)).length;
  const staleHits = [...stale].filter((unitId) => selected.has(unitId)).length;
  const currentStateRecall = active.size ? activeHits / active.size : 1;
  const staleAbsence = stale.size ? 1 - staleHits / stale.size : 1;
  const denominator = active.size + stale.size;
  const lambda = denominator ? stale.size / denominator : 0;
  const provenance = new Set(params.probe.goldProvenanceUnitIds);
  return {
    relevantTargetIds: targetIds,
    metrics: {
      currentStateRecall,
      staleAbsence,
      staleAnyAbsence: Number(staleHits === 0),
      stateFama: Math.max(0, currentStateRecall - lambda * (1 - staleAbsence)),
      goldProvenanceRecall: provenance.size
        ? [...provenance].filter((unitId) => selected.has(unitId)).length / provenance.size
        : 1,
      injectedItems: params.candidateIds.length,
      injectedTokens: params.candidateIds.reduce((sum, unitId) => sum + params.tokenById.get(unitId)!, 0),
    },
  };
}

function meanMetrics(rows: Array<Record<string, any>>): Record<Metric, number> {
  return Object.fromEntries(METRICS.map((metric) => [
    metric,
    mean(rows.map((item) => item.metrics[metric])),
  ])) as Record<Metric, number>;
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
  pairs: Array<Record<string, any>>;
  metric: Metric;
  samples: number;
  seed: number;
}) {
  const byProfile = new Map<string, Array<Record<string, any>>>();
  for (const item of params.pairs) {
    const cluster = byProfile.get(item.profileId) ?? [];
    cluster.push(item);
    byProfile.set(item.profileId, cluster);
  }
  const clusters = [...byProfile.values()];
  const delta = (item: Record<string, any>) =>
    item.candidate.metrics[params.metric] - item.v1.metrics[params.metric];
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
    mean: mean(params.pairs.map(delta)),
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}

export async function validateMemOpsTargetState(
  options: ValidatorOptions,
): Promise<Record<string, unknown>> {
  const [casesText, summaryText] = await Promise.all([
    readFile(options.cases, "utf8"),
    readFile(options.summary, "utf8"),
  ]);
  const rows = casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const summary = JSON.parse(summaryText);
  const instanceIds = [...new Set(rows.map((item) => item.instanceId as string))].sort();
  const instances = new Map<string, MemOpsInstance>();
  const probes = new Map<string, MemOpsMappedProbe>();
  const goldByInstance = new Map<string, GoldState>();
  const tokenById = new Map<string, number>();
  for (const instanceId of instanceIds) {
    const instance = await loadMemOpsInstance(options.dataRoot, instanceId);
    instances.set(instanceId, instance);
    goldByInstance.set(instanceId, buildGold(instance));
    for (const probe of instance.probes) probes.set(probe.id, probe);
    for (const unit of instance.units) tokenById.set(unit.id, encoding.encode(unit.content).length);
  }
  const keys = new Set<string>();
  let duplicateKeys = 0;
  let missingCases = 0;
  let unknownCandidateIds = 0;
  let relevantTargetMismatches = 0;
  let metricMismatches = 0;
  let nonFiniteValues = 0;
  for (const item of rows) {
    const key = `${item.caseId}\0${item.view}\0${item.arm}\0${item.policyId ?? ""}`;
    duplicateKeys += Number(keys.has(key));
    keys.add(key);
    const probe = probes.get(item.caseId);
    const gold = goldByInstance.get(item.instanceId);
    if (!probe || !gold) {
      missingCases += 1;
      continue;
    }
    const rowUnknownCandidateIds = item.candidateIds.filter(
      (unitId: string) => !tokenById.has(unitId),
    ).length;
    unknownCandidateIds += rowUnknownCandidateIds;
    if (rowUnknownCandidateIds) continue;
    const recomputed = score({
      candidateIds: item.candidateIds,
      probe,
      gold,
      tokenById,
    });
    relevantTargetMismatches += Number(
      recomputed.relevantTargetIds.join("\0") !== item.relevantTargetIds.join("\0"),
    );
    for (const metric of [...METRICS, "injectedItems", "injectedTokens"] as const) {
      const value = item.metrics[metric];
      nonFiniteValues += Number(!Number.isFinite(value));
      metricMismatches += Number(!close(recomputed.metrics[metric], value));
    }
  }

  const current = rows.filter((item) => item.view === "current");
  const history = rows.filter((item) => item.view === "history");
  const currentByKey = new Map(current.map((item) => [`${item.caseId}\0${item.arm}`, item]));
  const historyByKey = new Map(history.map((item) => [`${item.caseId}\0${item.arm}`, item]));
  const caseIds = [...new Set(current.filter((item) => item.arm === "v1").map((item) => item.caseId))];
  const pairs = caseIds.map((caseId) => {
    const v1 = currentByKey.get(`${caseId}\0v1`);
    const candidate = currentByKey.get(`${caseId}\0target_state`);
    if (!v1 || !candidate) throw new Error(`missing validator current pair ${caseId}`);
    return { caseId, profileId: v1.profileId, operationFamily: v1.operationFamily, v1, candidate };
  });
  const historyCaseIds = [...new Set(history.filter((item) => item.arm === "v1").map((item) => item.caseId))];
  let historyMismatches = 0;
  for (const caseId of historyCaseIds) {
    const v1 = historyByKey.get(`${caseId}\0v1`);
    const candidate = historyByKey.get(`${caseId}\0target_state`);
    historyMismatches += Number(!v1 || !candidate
      || v1.candidateIds.join("\0") !== candidate.candidateIds.join("\0")
      || v1.metrics.injectedTokens !== candidate.metrics.injectedTokens);
  }
  const recomputedArms = Object.fromEntries((["base", "v1", "target_state"] as const).map((arm) => {
    const selected = current.filter((item) => item.arm === arm);
    return [arm, {
      cases: selected.length,
      ...meanMetrics(selected),
      meanInjectedItems: mean(selected.map((item) => item.metrics.injectedItems)),
      meanInjectedTokens: mean(selected.map((item) => item.metrics.injectedTokens)),
    }];
  }));
  const exactBootstrap = Object.fromEntries(METRICS.map((metric, index) => [
    metric,
    bootstrap({
      pairs,
      metric,
      samples: MEMOPS_TARGET_STATE_PROTOCOL.aggregation.bootstrapSamples,
      seed: MEMOPS_TARGET_STATE_PROTOCOL.aggregation.bootstrapSeed + index,
    }),
  ]));
  const alternativeSamples = options.bootstrapSamples ?? 20_000;
  const alternativeSeed = options.seed ?? 20260826;
  const alternativeBootstrap = Object.fromEntries(METRICS.map((metric, index) => [
    metric,
    bootstrap({ pairs, metric, samples: alternativeSamples, seed: alternativeSeed + index }),
  ]));
  let summaryMismatches = 0;
  for (const [arm, summaryArm] of [
    ["base", "base"],
    ["v1", "v1"],
    ["target_state", "targetState"],
  ] as const) {
    for (const metric of METRICS) {
      summaryMismatches += Number(!close(
        recomputedArms[arm][metric],
        summary.primary.arms[summaryArm][metric],
      ));
    }
    summaryMismatches += Number(!close(
      recomputedArms[arm].meanInjectedTokens,
      summary.primary.arms[summaryArm].meanInjectedTokens,
    ));
  }
  for (const metric of METRICS) {
    for (const field of ["mean", "lower", "upper", "clusters"] as const) {
      summaryMismatches += Number(!close(
        exactBootstrap[metric][field],
        summary.primary.targetStateVsV1[metric][field],
      ));
    }
  }
  const tokenViolations = pairs.filter((item) =>
    item.candidate.metrics.injectedTokens > item.v1.metrics.injectedTokens
  ).length;
  const ordinaryFallbacks = pairs.filter((item) => item.candidate.decision.mode === "fallback").length;
  const checks = {
    protocol: summary.protocol.protocolVersion === MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion
      && summary.phase === options.phase,
    inputHash: sha256(casesText) === summary.input.casesSha256,
    uniqueKeys: duplicateKeys === 0,
    knownCases: missingCases === 0,
    knownCandidates: unknownCandidateIds === 0,
    relevantTargets: relevantTargetMismatches === 0,
    finiteMetrics: nonFiniteValues === 0,
    metricRecomputation: metricMismatches === 0,
    summaryRecomputation: summaryMismatches === 0,
    primaryCaseCount: pairs.length === (options.phase === "validation"
      ? MEMOPS_TARGET_STATE_PROTOCOL.split.validationPrimaryCases
      : MEMOPS_TARGET_STATE_PROTOCOL.split.testPrimaryCases),
    exactHistoryMode: historyMismatches === 0
      && history.length === summary.operationalIntegrity.historyModeRows,
    tokenBudget: tokenViolations === 0,
    ordinaryFallbacks: ordinaryFallbacks === 0,
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocolVersion: MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion,
    phase: options.phase,
    input: {
      casesSha256: sha256(casesText),
      summarySha256: sha256(summaryText),
    },
    integrity: {
      rows: rows.length,
      currentCases: pairs.length,
      historyCases: historyCaseIds.length,
      instances: instanceIds.length,
      uniqueKeys: keys.size,
      duplicateKeys,
      missingCases,
      unknownCandidateIds,
      relevantTargetMismatches,
      metricMismatches,
      summaryMismatches,
      nonFiniteValues,
      historyMismatches,
      tokenViolations,
      ordinaryFallbacks,
    },
    recomputedArms,
    exactBootstrap,
    alternativeBootstrap: {
      samples: alternativeSamples,
      seed: alternativeSeed,
      unit: "profile",
      targetStateVsV1: alternativeBootstrap,
    },
    checks,
    caveats: [
      "The validator confirms provenance alignment and arithmetic, not extraction quality.",
      "The alternative bootstrap changes only the random seed, not the panel or cluster unit.",
      "Operational forced-failure counts are checked by the runner and reported but not regenerated here.",
    ],
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
