import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import {
  loadMemOpsInstance,
  type MemOpsInstance,
  type MemOpsMappedProbe,
} from "./memops-adapter.js";
import { MEMOPS_DOMINANCE_PROTOCOL } from "./memops-dominance-protocol.js";

type Metric = "currentStateRecall" | "staleAbsence" | "staleAnyAbsence"
  | "stateFama" | "goldProvenanceRecall";
type Metrics = Record<Metric, number> & { injectedItems: number; injectedTokens: number };

interface ValidatorOptions {
  cases: string;
  dataRoot: string;
  output: string;
  summary: string;
  bootstrapSamples?: number;
  seed?: number;
}

interface InstanceState {
  activeByTarget: Map<string, Set<string>>;
  currentIds: Set<string>;
  historyByTarget: Map<string, Set<string>>;
  linkedIds: Set<string>;
  probeById: Map<string, MemOpsMappedProbe>;
  staleIds: Set<string>;
  targetsByUnit: Map<string, Set<string>>;
  tokenById: Map<string, number>;
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

function buildState(instance: MemOpsInstance): InstanceState {
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
  const currentIds = new Set<string>();
  const linkedIds = new Set<string>();
  for (const [targetId, operations] of confirmed) {
    for (const unitId of historyByTarget.get(targetId) ?? []) linkedIds.add(unitId);
    const latest = [...operations].sort((left, right) =>
      left.triggerSequence - right.triggerSequence
      || left.operation_id.localeCompare(right.operation_id)
    ).at(-1)!;
    const active = latest.type === "forget" ? new Set<string>() : new Set(operationUnitIds(latest));
    activeByTarget.set(targetId, active);
    for (const unitId of active) currentIds.add(unitId);
  }
  const staleIds = new Set([...linkedIds].filter((unitId) => !currentIds.has(unitId)));
  return {
    activeByTarget,
    currentIds,
    historyByTarget,
    linkedIds,
    probeById: new Map(instance.probes.map((probe) => [probe.id, probe])),
    staleIds,
    targetsByUnit,
    tokenById: new Map(instance.units.map((unit) => [
      unit.id,
      encoding.encode(unit.content).length,
    ])),
  };
}

function relevantTargets(probe: MemOpsMappedProbe, state: InstanceState): string[] {
  return [...new Set(probe.goldProvenanceUnitIds.flatMap((unitId) =>
    [...(state.targetsByUnit.get(unitId) ?? [])]
  ))].sort();
}

function score(candidateIds: string[], probe: MemOpsMappedProbe, state: InstanceState): Metrics {
  const targetIds = relevantTargets(probe, state);
  const active = new Set<string>();
  const stale = new Set<string>();
  for (const targetId of targetIds) {
    for (const unitId of state.activeByTarget.get(targetId) ?? []) active.add(unitId);
    for (const unitId of state.historyByTarget.get(targetId) ?? []) stale.add(unitId);
  }
  for (const unitId of active) stale.delete(unitId);
  const selected = new Set(candidateIds);
  const activeHits = [...active].filter((unitId) => selected.has(unitId)).length;
  const staleHits = [...stale].filter((unitId) => selected.has(unitId)).length;
  const currentStateRecall = active.size ? activeHits / active.size : 1;
  const staleAbsence = stale.size ? 1 - staleHits / stale.size : 1;
  const denominator = active.size + stale.size;
  const lambda = denominator ? stale.size / denominator : 0;
  const provenance = new Set(probe.goldProvenanceUnitIds);
  return {
    currentStateRecall,
    staleAbsence,
    staleAnyAbsence: Number(staleHits === 0),
    stateFama: Math.max(0, currentStateRecall - lambda * (1 - staleAbsence)),
    goldProvenanceRecall: provenance.size
      ? [...provenance].filter((unitId) => selected.has(unitId)).length / provenance.size
      : 1,
    injectedItems: candidateIds.length,
    injectedTokens: candidateIds.reduce((sum, unitId) => sum + state.tokenById.get(unitId)!, 0),
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

function bootstrap(rows: Array<Record<string, any>>, metric: Metric, samples: number, seed: number) {
  const byProfile = new Map<string, Array<Record<string, any>>>();
  for (const row of rows) {
    const cluster = byProfile.get(row.profileId) ?? [];
    cluster.push(row);
    byProfile.set(row.profileId, cluster);
  }
  const clusters = [...byProfile.values()];
  const delta = (row: Record<string, any>) =>
    row.arms.guarded.metrics[metric] - row.arms.v1.metrics[metric];
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const selected: Array<Record<string, any>> = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    draws.push(mean(selected.map(delta)));
  }
  draws.sort((left, right) => left - right);
  return {
    mean: mean(rows.map(delta)),
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}

function checkSlice(
  rows: Array<Record<string, any>>,
  summarySlice: Record<string, any>,
): number {
  let mismatches = 0;
  for (const [arm, summaryArm] of [
    ["v1", "v1"],
    ["challenger", "challenger"],
    ["guarded", "guarded"],
  ] as const) {
    mismatches += Number(summarySlice.arms[summaryArm].cases !== rows.length);
    for (const metric of METRICS) {
      mismatches += Number(!close(
        mean(rows.map((row) => row.arms[arm].metrics[metric])),
        summarySlice.arms[summaryArm][metric],
      ));
    }
    for (const [metric, field] of [
      ["injectedItems", "meanInjectedItems"],
      ["injectedTokens", "meanInjectedTokens"],
    ] as const) {
      mismatches += Number(!close(
        mean(rows.map((row) => row.arms[arm].metrics[metric])),
        summarySlice.arms[summaryArm][field],
      ));
    }
  }
  for (const [metric, interval] of Object.entries(summarySlice.guardedVsV1)) {
    const exact = bootstrap(
      rows,
      metric as Metric,
      MEMOPS_DOMINANCE_PROTOCOL.aggregation.bootstrapSamples,
      MEMOPS_DOMINANCE_PROTOCOL.aggregation.bootstrapSeed + METRICS.indexOf(metric as Metric),
    );
    for (const field of ["mean", "lower", "upper", "clusters"] as const) {
      mismatches += Number(!close(exact[field], (interval as Record<string, number>)[field]));
    }
  }
  for (const metric of METRICS) {
    mismatches += Number(!close(
      mean(rows.map((row) =>
        row.arms.challenger.metrics[metric] - row.arms.v1.metrics[metric]
      )),
      summarySlice.challengerVsV1[metric],
    ));
  }
  const stateDelta = (row: Record<string, any>) =>
    row.arms.guarded.metrics.stateFama - row.arms.v1.metrics.stateFama;
  const transitions = {
    improved: rows.filter((row) => stateDelta(row) > 0).length,
    unchanged: rows.filter((row) => stateDelta(row) === 0).length,
    harmed: rows.filter((row) => stateDelta(row) < 0).length,
  };
  mismatches += Number(JSON.stringify(transitions) !== JSON.stringify(summarySlice.transitions));
  const acceptedChangedContexts = rows.filter((row) =>
    row.decision.mode === "challenger"
    && row.arms.v1.candidateIds.join("\0") !== row.arms.challenger.candidateIds.join("\0")
  ).length;
  const acceptedNoopContexts = rows.filter((row) =>
    row.decision.mode === "challenger"
    && row.arms.v1.candidateIds.join("\0") === row.arms.challenger.candidateIds.join("\0")
  ).length;
  mismatches += Number(acceptedChangedContexts !== summarySlice.acceptedChangedContexts);
  mismatches += Number(acceptedNoopContexts !== summarySlice.acceptedNoopContexts);
  mismatches += Number(
    rows.filter((row) => row.decision.mode === "incumbent").length
      !== summarySlice.incumbentContexts,
  );
  mismatches += Number(
    rows.filter((row) => row.decision.mode === "fallback").length
      !== summarySlice.fallbackContexts,
  );
  return mismatches;
}

export async function validateMemOpsDominance(
  options: ValidatorOptions,
): Promise<Record<string, unknown>> {
  const [casesText, summaryText] = await Promise.all([
    readFile(options.cases, "utf8"),
    readFile(options.summary, "utf8"),
  ]);
  const rows = casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const summary = JSON.parse(summaryText);
  const instanceIds = [...new Set(rows.map((row) => row.instanceId as string))].sort();
  const states = new Map<string, InstanceState>();
  for (const instanceId of instanceIds) {
    states.set(instanceId, buildState(await loadMemOpsInstance(options.dataRoot, instanceId)));
  }
  const keys = new Set<string>();
  let duplicateRows = 0;
  let unknownCases = 0;
  let unknownCandidates = 0;
  let metricMismatches = 0;
  let decisionMismatches = 0;
  let selectedContextMismatches = 0;
  let nonFiniteValues = 0;
  for (const row of rows) {
    duplicateRows += Number(keys.has(row.caseId));
    keys.add(row.caseId);
    const state = states.get(row.instanceId);
    const probe = state?.probeById.get(row.caseId);
    if (!state || !probe) {
      unknownCases += 1;
      continue;
    }
    const candidateIds = [
      ...row.arms.v1.candidateIds,
      ...row.arms.challenger.candidateIds,
      ...row.arms.guarded.candidateIds,
    ];
    const rowUnknown = candidateIds.filter((unitId: string) => !state.tokenById.has(unitId)).length;
    unknownCandidates += rowUnknown;
    if (rowUnknown) continue;
    for (const arm of ["v1", "challenger", "guarded"] as const) {
      const recomputed = score(row.arms[arm].candidateIds, probe, state);
      for (const metric of [...METRICS, "injectedItems", "injectedTokens"] as const) {
        nonFiniteValues += Number(!Number.isFinite(row.arms[arm].metrics[metric]));
        metricMismatches += Number(!close(recomputed[metric], row.arms[arm].metrics[metric]));
      }
    }
    const unionIds = [...new Set([...row.arms.v1.candidateIds, ...row.arms.challenger.candidateIds])];
    const incumbent = new Set(row.arms.v1.candidateIds);
    const challenger = new Set(row.arms.challenger.candidateIds);
    const currentIds = unionIds.filter((unitId) => state.currentIds.has(unitId));
    const staleIds = unionIds.filter((unitId) => state.staleIds.has(unitId));
    const unknownIds = unionIds.filter((unitId) => !state.linkedIds.has(unitId));
    const checks = {
      budgetRespected: row.arms.challenger.metrics.injectedTokens
        <= row.arms.v1.metrics.injectedTokens,
      currentRetained: currentIds.filter((unitId) => incumbent.has(unitId))
        .every((unitId) => challenger.has(unitId)),
      staleNotIncreased: staleIds.filter((unitId) => challenger.has(unitId))
        .every((unitId) => incumbent.has(unitId)),
      unknownRetained: unknownIds.filter((unitId) => incumbent.has(unitId))
        .every((unitId) => challenger.has(unitId)),
    };
    const reasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    const expectedMode = reasons.length ? "incumbent" : "challenger";
    const expectedIds = expectedMode === "challenger"
      ? row.arms.challenger.candidateIds
      : row.arms.v1.candidateIds;
    decisionMismatches += Number(
      row.decision.mode !== expectedMode
      || JSON.stringify(row.decision.checks) !== JSON.stringify(checks)
      || row.decision.rejectionReasons.join("\0") !== reasons.join("\0")
      || row.decision.state.currentIds.join("\0") !== currentIds.join("\0")
      || row.decision.state.staleIds.join("\0") !== staleIds.join("\0")
      || row.decision.state.unknownIds.join("\0") !== unknownIds.join("\0")
      || row.decision.incumbentCost !== row.arms.v1.metrics.injectedTokens
      || row.decision.challengerCost !== row.arms.challenger.metrics.injectedTokens
    );
    selectedContextMismatches += Number(
      row.arms.guarded.candidateIds.join("\0") !== expectedIds.join("\0")
    );
  }

  let summaryMismatches = checkSlice(rows, summary.primary);
  for (const phase of ["development", "validation", "test"] as const) {
    summaryMismatches += checkSlice(
      rows.filter((row) => row.phase === phase),
      summary.originalPhaseSlices[phase],
    );
  }
  const expectedCounts = MEMOPS_DOMINANCE_PROTOCOL.inputs.expectedPrimaryCases;
  const metricHarms = Object.fromEntries(METRICS.map((metric) => [
    metric,
    rows.filter((row) => row.arms.guarded.metrics[metric] < row.arms.v1.metrics[metric]).length,
  ]));
  for (const metric of METRICS) {
    summaryMismatches += Number(metricHarms[metric] !== summary.safety.metricHarms[metric]);
  }
  const tokenViolations = rows.filter((row) =>
    row.arms.guarded.metrics.injectedTokens > row.arms.v1.metrics.injectedTokens
  ).length;
  summaryMismatches += Number(tokenViolations !== summary.safety.tokenViolations);
  const rejectionReasons: Record<string, number> = {};
  for (const row of rows) {
    for (const reason of row.decision.rejectionReasons) {
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
  }
  summaryMismatches += Number(
    JSON.stringify(rejectionReasons) !== JSON.stringify(summary.safety.rejectionReasons),
  );
  summaryMismatches += Number(
    rows.filter((row) => row.decision.mode === "fallback").length
      !== summary.operational.ordinaryFallbacks,
  );
  summaryMismatches += Number(summary.status !== "passed" || summary.gate.passed !== true);
  const alternativeSamples = options.bootstrapSamples ?? 20_000;
  const alternativeSeed = options.seed ?? 20260828;
  const alternativeBootstrap = Object.fromEntries(METRICS.map((metric, index) => [
    metric,
    bootstrap(rows, metric, alternativeSamples, alternativeSeed + index),
  ]));
  const checks = {
    protocol: summary.protocol.protocolVersion === MEMOPS_DOMINANCE_PROTOCOL.protocolVersion,
    inputHash: sha256(casesText) === summary.input.casesSha256,
    rowCount: rows.length === expectedCounts.all,
    phaseCounts: (["development", "validation", "test"] as const).every((phase) =>
      rows.filter((row) => row.phase === phase).length === expectedCounts[phase]
    ),
    uniqueRows: duplicateRows === 0,
    knownCases: unknownCases === 0,
    knownCandidates: unknownCandidates === 0,
    finiteMetrics: nonFiniteValues === 0,
    metricRecomputation: metricMismatches === 0,
    decisionRecomputation: decisionMismatches === 0,
    exactSelection: selectedContextMismatches === 0,
    summaryRecomputation: summaryMismatches === 0,
    noOrdinaryFallback: rows.every((row) => row.decision.mode !== "fallback"),
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocolVersion: MEMOPS_DOMINANCE_PROTOCOL.protocolVersion,
    input: {
      casesSha256: sha256(casesText),
      summarySha256: sha256(summaryText),
    },
    integrity: {
      rows: rows.length,
      instances: instanceIds.length,
      duplicateRows,
      unknownCases,
      unknownCandidates,
      nonFiniteValues,
      metricMismatches,
      decisionMismatches,
      selectedContextMismatches,
      summaryMismatches,
    },
    alternativeBootstrap: {
      samples: alternativeSamples,
      seed: alternativeSeed,
      unit: "profile",
      guardedVsV1: alternativeBootstrap,
    },
    checks,
    caveats: [
      "The validator independently reconstructs operation state, scores, dominance decisions, and aggregates.",
      "Forced disabled/missing/timeout/invalid-cost calls are reported by the runner but are not regenerated here.",
      "A passed validator does not change the post-hoc evidence role or permit promotion.",
    ],
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
