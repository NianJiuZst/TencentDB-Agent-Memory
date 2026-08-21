import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import {
  applyLifecycleDominanceGuard,
  LifecycleTargetState,
  type LifecycleDominanceDecision,
  type LifecycleTargetStateOperation,
  type LifecycleTargetStatePolicy,
} from "../../../src/core/lifecycle/index.js";
import { loadMemOpsInstance, type MemOpsInstance } from "./memops-adapter.js";
import {
  MEMOPS_DOMINANCE_PROTOCOL,
  type MemOpsDominanceSourcePhase,
} from "./memops-dominance-protocol.js";

type Metric = "currentStateRecall" | "staleAbsence" | "staleAnyAbsence"
  | "stateFama" | "goldProvenanceRecall";
type Metrics = Record<Metric, number> & { injectedItems: number; injectedTokens: number };

interface D5Row {
  arm: "base" | "v1" | "target_state";
  candidateIds: string[];
  caseId: string;
  instanceId: string;
  metrics: Metrics;
  operationFamily: string;
  phase: MemOpsDominanceSourcePhase;
  policyId?: string;
  profileId: string;
  protocolVersion: string;
  view: "current" | "history";
}

interface SourcePair {
  challenger: D5Row;
  phase: MemOpsDominanceSourcePhase;
  v1: D5Row;
}

interface GuardedRow {
  arms: {
    challenger: { candidateIds: string[]; metrics: Metrics };
    guarded: { candidateIds: string[]; metrics: Metrics };
    v1: { candidateIds: string[]; metrics: Metrics };
  };
  caseId: string;
  decision: LifecycleDominanceDecision;
  instanceId: string;
  operationFamily: string;
  phase: MemOpsDominanceSourcePhase;
  profileId: string;
  protocolVersion: string;
  sourceProtocolVersion: string;
}

export interface MemOpsDominanceRunOptions {
  dataRoot: string;
  developmentCases: string;
  outputDir: string;
  sourceResultCard: string;
  testCases: string;
  validationCases: string;
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

function sameIds(left: Array<{ id: string }>, right: Array<{ id: string }>): boolean {
  return left.map((item) => item.id).join("\0") === right.map((item) => item.id).join("\0");
}

function validateRow(row: D5Row, phase: MemOpsDominanceSourcePhase): void {
  if (row.protocolVersion !== MEMOPS_DOMINANCE_PROTOCOL.inputs.sourceProtocolVersion
    || row.phase !== phase || row.view !== "current" || !row.caseId || !row.instanceId
    || !row.profileId || !row.operationFamily || !Array.isArray(row.candidateIds)
    || row.candidateIds.length > MEMOPS_DOMINANCE_PROTOCOL.guard.resultLimit
    || new Set(row.candidateIds).size !== row.candidateIds.length) {
    throw new Error(`invalid D5 source row ${row.caseId ?? "unknown"}`);
  }
  for (const metric of [...METRICS, "injectedItems", "injectedTokens"] as const) {
    if (!Number.isFinite(row.metrics?.[metric])) {
      throw new Error(`non-finite D5 source metric ${row.caseId}/${metric}`);
    }
  }
}

async function loadPairs(params: {
  expectedCases: number;
  expectedSha256: string;
  file: string;
  phase: MemOpsDominanceSourcePhase;
}): Promise<{ pairs: SourcePair[]; sha256: string }> {
  const text = await readFile(params.file, "utf8");
  const digest = sha256(text);
  if (digest !== params.expectedSha256) {
    throw new Error(`D6 ${params.phase} source cases hash mismatch`);
  }
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as D5Row);
  const selectedPolicyId = MEMOPS_DOMINANCE_PROTOCOL.inputs.selectedPolicyId;
  const current = rows.filter((row) => row.view === "current"
    && (row.arm === "v1" || (row.arm === "target_state" && row.policyId === selectedPolicyId)));
  for (const row of current) validateRow(row, params.phase);
  const keys = new Set<string>();
  for (const row of current) {
    const key = `${row.caseId}\0${row.arm}`;
    if (keys.has(key)) throw new Error(`duplicate D5 source row ${key}`);
    keys.add(key);
  }
  const caseIds = [...new Set(current.filter((row) => row.arm === "v1").map((row) => row.caseId))]
    .sort();
  const byKey = new Map(current.map((row) => [`${row.caseId}\0${row.arm}`, row]));
  const pairs = caseIds.map((caseId): SourcePair => {
    const v1 = byKey.get(`${caseId}\0v1`);
    const challenger = byKey.get(`${caseId}\0target_state`);
    if (!v1 || !challenger || v1.instanceId !== challenger.instanceId
      || v1.profileId !== challenger.profileId
      || v1.operationFamily !== challenger.operationFamily) {
      throw new Error(`missing or incompatible D5 source pair ${caseId}`);
    }
    return { phase: params.phase, v1, challenger };
  });
  if (pairs.length !== params.expectedCases || current.length !== params.expectedCases * 2) {
    throw new Error(`D6 ${params.phase} primary case count mismatch`);
  }
  return { pairs, sha256: digest };
}

function operationSourceIds(operation: MemOpsInstance["operations"][number]): string[] {
  return [...new Set([operation.triggerUnitId, ...operation.evidenceUnitIds])];
}

function operationKind(
  type: MemOpsInstance["operations"][number]["type"],
): LifecycleTargetStateOperation["kind"] {
  return type === "forget" ? "delete" : type;
}

function buildInspector(instance: MemOpsInstance): LifecycleTargetState {
  return new LifecycleTargetState(
    instance.units.map((unit) => ({ id: unit.id, sequence: unit.sequence })),
    instance.operations.map((operation) => {
      const sourceUnitIds = operationSourceIds(operation);
      return {
        id: `${instance.id}:${operation.operation_id}`,
        targetId: operation.target.target_id,
        kind: operationKind(operation.type),
        validity: operation.validity,
        confidence: 1,
        sequence: operation.triggerSequence,
        sourceUnitIds,
        successorUnitIds: operation.type === "forget" ? [] : sourceUnitIds,
      };
    }),
  );
}

function guardPolicy(enabled = true): LifecycleTargetStatePolicy {
  const guard = MEMOPS_DOMINANCE_PROTOCOL.guard;
  return {
    enabled,
    minConfidence: guard.minConfidence,
    maxCandidates: guard.maxCandidates,
    maxExpansions: guard.maxExpansions,
    maxStateUnits: guard.maxStateUnits,
    maxTargets: guard.maxTargets,
    resultLimit: guard.resultLimit,
    timeoutMs: guard.timeoutMs,
  };
}

function aggregate(rows: GuardedRow[], arm: keyof GuardedRow["arms"]) {
  return {
    cases: rows.length,
    ...Object.fromEntries(METRICS.map((metric) => [
      metric,
      mean(rows.map((row) => row.arms[arm].metrics[metric])),
    ])),
    meanInjectedItems: mean(rows.map((row) => row.arms[arm].metrics.injectedItems)),
    meanInjectedTokens: mean(rows.map((row) => row.arms[arm].metrics.injectedTokens)),
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

function bootstrap(rows: GuardedRow[], metric: Metric, seed: number) {
  const byProfile = new Map<string, GuardedRow[]>();
  for (const row of rows) {
    const cluster = byProfile.get(row.profileId) ?? [];
    cluster.push(row);
    byProfile.set(row.profileId, cluster);
  }
  const clusters = [...byProfile.values()];
  const delta = (row: GuardedRow) =>
    row.arms.guarded.metrics[metric] - row.arms.v1.metrics[metric];
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < MEMOPS_DOMINANCE_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const selected: GuardedRow[] = [];
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

function summarize(rows: GuardedRow[]) {
  const delta = (row: GuardedRow, metric: Metric) =>
    row.arms.guarded.metrics[metric] - row.arms.v1.metrics[metric];
  const transitions = {
    improved: rows.filter((row) => delta(row, "stateFama") > 0).length,
    unchanged: rows.filter((row) => delta(row, "stateFama") === 0).length,
    harmed: rows.filter((row) => delta(row, "stateFama") < 0).length,
  };
  return {
    cases: rows.length,
    arms: {
      v1: aggregate(rows, "v1"),
      challenger: aggregate(rows, "challenger"),
      guarded: aggregate(rows, "guarded"),
    },
    guardedVsV1: Object.fromEntries(METRICS.map((metric, index) => [
      metric,
      bootstrap(rows, metric, MEMOPS_DOMINANCE_PROTOCOL.aggregation.bootstrapSeed + index),
    ])),
    challengerVsV1: Object.fromEntries(METRICS.map((metric) => [
      metric,
      mean(rows.map((row) => row.arms.challenger.metrics[metric] - row.arms.v1.metrics[metric])),
    ])),
    transitions,
    acceptedChangedContexts: rows.filter((row) =>
      row.decision.mode === "challenger"
      && row.arms.v1.candidateIds.join("\0") !== row.arms.challenger.candidateIds.join("\0")
    ).length,
    acceptedNoopContexts: rows.filter((row) =>
      row.decision.mode === "challenger"
      && row.arms.v1.candidateIds.join("\0") === row.arms.challenger.candidateIds.join("\0")
    ).length,
    incumbentContexts: rows.filter((row) => row.decision.mode === "incumbent").length,
    fallbackContexts: rows.filter((row) => row.decision.mode === "fallback").length,
  };
}

export async function runMemOpsDominance(
  options: MemOpsDominanceRunOptions,
): Promise<Record<string, unknown>> {
  const sourceResultCardText = await readFile(options.sourceResultCard, "utf8");
  if (sha256(sourceResultCardText) !== MEMOPS_DOMINANCE_PROTOCOL.inputs.sourceResultCardSha256) {
    throw new Error("D6 source result card hash mismatch");
  }
  const sourceResultCard = JSON.parse(sourceResultCardText);
  if (sourceResultCard.protocolVersion !== MEMOPS_DOMINANCE_PROTOCOL.inputs.sourceProtocolVersion
    || sourceResultCard.status !== "rejected_at_untouched_test_uncertainty_gate"
    || sourceResultCard.selectedPolicy?.id
      !== MEMOPS_DOMINANCE_PROTOCOL.inputs.selectedPolicyId) {
    throw new Error("D6 source result card is incompatible");
  }
  const expected = MEMOPS_DOMINANCE_PROTOCOL.inputs.expectedPrimaryCases;
  const [development, validation, test] = await Promise.all([
    loadPairs({
      file: options.developmentCases,
      phase: "development",
      expectedCases: expected.development,
      expectedSha256: MEMOPS_DOMINANCE_PROTOCOL.inputs.developmentCasesSha256,
    }),
    loadPairs({
      file: options.validationCases,
      phase: "validation",
      expectedCases: expected.validation,
      expectedSha256: MEMOPS_DOMINANCE_PROTOCOL.inputs.validationCasesSha256,
    }),
    loadPairs({
      file: options.testCases,
      phase: "test",
      expectedCases: expected.test,
      expectedSha256: MEMOPS_DOMINANCE_PROTOCOL.inputs.testCasesSha256,
    }),
  ]);
  const pairs = [...development.pairs, ...validation.pairs, ...test.pairs];
  if (pairs.length !== expected.all) throw new Error("D6 all-case count mismatch");
  const instanceIds = [...new Set(pairs.map((pair) => pair.v1.instanceId))].sort();
  const runtimes = new Map<string, {
    inspector: LifecycleTargetState;
    tokenById: Map<string, number>;
  }>();
  for (const instanceId of instanceIds) {
    const instance = await loadMemOpsInstance(options.dataRoot, instanceId);
    runtimes.set(instanceId, {
      inspector: buildInspector(instance),
      tokenById: new Map(instance.units.map((unit) => [
        unit.id,
        encoding.encode(unit.content).length,
      ])),
    });
  }
  const guardedRows: GuardedRow[] = [];
  const forcedChecked = new Set<string>();
  const operational = {
    instances: instanceIds.length,
    ordinaryFallbacks: 0,
    disabledMismatches: 0,
    missingInspectorMismatches: 0,
    timeoutMismatches: 0,
    invalidCostMismatches: 0,
  };
  const rejectionReasons: Record<string, number> = {};
  for (const pair of pairs) {
    const runtime = runtimes.get(pair.v1.instanceId)!;
    const materialize = (ids: string[]) => ids.map((id) => {
      const tokenCount = runtime.tokenById.get(id);
      if (tokenCount === undefined) throw new Error(`D6 cannot materialize ${id}`);
      return { id, tokenCount };
    });
    const incumbent = materialize(pair.v1.candidateIds);
    const challenger = materialize(pair.challenger.candidateIds);
    const incumbentTokens = incumbent.reduce((sum, item) => sum + item.tokenCount, 0);
    const challengerTokens = challenger.reduce((sum, item) => sum + item.tokenCount, 0);
    if (incumbentTokens !== pair.v1.metrics.injectedTokens
      || challengerTokens !== pair.challenger.metrics.injectedTokens) {
      throw new Error(`D6 source token mismatch ${pair.v1.caseId}`);
    }
    const guarded = applyLifecycleDominanceGuard({
      incumbent,
      challenger,
      cost: (item) => item.tokenCount,
      inspector: runtime.inspector,
      policy: guardPolicy(),
    });
    operational.ordinaryFallbacks += Number(guarded.decision.mode === "fallback");
    for (const reason of guarded.decision.rejectionReasons) {
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
    const choseChallenger = guarded.decision.mode === "challenger";
    const selectedSource = choseChallenger ? pair.challenger : pair.v1;
    if (!sameIds(guarded.candidates, choseChallenger ? challenger : incumbent)) {
      throw new Error(`D6 guard returned a non-source context ${pair.v1.caseId}`);
    }
    guardedRows.push({
      protocolVersion: MEMOPS_DOMINANCE_PROTOCOL.protocolVersion,
      sourceProtocolVersion: MEMOPS_DOMINANCE_PROTOCOL.inputs.sourceProtocolVersion,
      phase: pair.phase,
      caseId: pair.v1.caseId,
      instanceId: pair.v1.instanceId,
      profileId: pair.v1.profileId,
      operationFamily: pair.v1.operationFamily,
      arms: {
        v1: { candidateIds: pair.v1.candidateIds, metrics: pair.v1.metrics },
        challenger: {
          candidateIds: pair.challenger.candidateIds,
          metrics: pair.challenger.metrics,
        },
        guarded: {
          candidateIds: guarded.candidates.map((item) => item.id),
          metrics: selectedSource.metrics,
        },
      },
      decision: guarded.decision,
    });

    if (!forcedChecked.has(pair.v1.instanceId)) {
      forcedChecked.add(pair.v1.instanceId);
      const disabled = applyLifecycleDominanceGuard({
        incumbent,
        challenger,
        cost: (item) => item.tokenCount,
        inspector: runtime.inspector,
        policy: guardPolicy(false),
      });
      const missing = applyLifecycleDominanceGuard({
        incumbent,
        challenger,
        cost: (item) => item.tokenCount,
        policy: guardPolicy(),
      });
      let clock = 0;
      const timeout = applyLifecycleDominanceGuard({
        incumbent,
        challenger,
        cost: (item) => item.tokenCount,
        inspector: runtime.inspector,
        now: () => (clock += MEMOPS_DOMINANCE_PROTOCOL.guard.timeoutMs + 1),
        policy: guardPolicy(),
      });
      const invalidCost = applyLifecycleDominanceGuard({
        incumbent,
        challenger,
        cost: () => Number.NaN,
        inspector: runtime.inspector,
        policy: guardPolicy(),
      });
      operational.disabledMismatches += Number(
        disabled.decision.mode !== "incumbent" || !sameIds(disabled.candidates, incumbent),
      );
      operational.missingInspectorMismatches += Number(
        missing.decision.mode !== "fallback" || !sameIds(missing.candidates, incumbent),
      );
      operational.timeoutMismatches += Number(
        timeout.decision.mode !== "fallback" || !sameIds(timeout.candidates, incumbent),
      );
      operational.invalidCostMismatches += Number(
        invalidCost.decision.mode !== "fallback" || !sameIds(invalidCost.candidates, incumbent),
      );
    }
  }

  const metricHarms = Object.fromEntries(METRICS.map((metric) => [
    metric,
    guardedRows.filter((row) =>
      row.arms.guarded.metrics[metric] < row.arms.v1.metrics[metric]
    ).length,
  ])) as Record<Metric, number>;
  const tokenViolations = guardedRows.filter((row) =>
    row.arms.guarded.metrics.injectedTokens > row.arms.v1.metrics.injectedTokens
  ).length;
  const allSummary = summarize(guardedRows);
  const gate = MEMOPS_DOMINANCE_PROTOCOL.viabilityGate;
  const checks = {
    acceptedChangedContexts: allSummary.acceptedChangedContexts >= gate.minAcceptedChangedContexts,
    currentStateRecallNonHarm: metricHarms.currentStateRecall
      <= gate.maxCurrentStateRecallHarmedCases,
    staleAbsenceNonHarm: metricHarms.staleAbsence <= gate.maxStaleAbsenceHarmedCases,
    stateFamaNonHarm: metricHarms.stateFama <= gate.maxStateFamaHarmedCases,
    tokenBudget: tokenViolations <= gate.maxTokenViolations,
    ordinaryFallbacks: operational.ordinaryFallbacks <= gate.maxOrdinaryFallbacks,
    disabledV1: !gate.requireExactDisabledV1 || operational.disabledMismatches === 0,
    missingInspectorV1: !gate.requireExactMissingInspectorV1
      || operational.missingInspectorMismatches === 0,
    timeoutV1: !gate.requireExactTimeoutV1 || operational.timeoutMismatches === 0,
    invalidCostV1: !gate.requireExactInvalidCostV1 || operational.invalidCostMismatches === 0,
  };
  const passed = Object.values(checks).every(Boolean);
  await mkdir(options.outputDir, { recursive: true });
  const casesText = `${guardedRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(path.join(options.outputDir, "cases.jsonl"), casesText, "utf8");
  const report = {
    status: passed ? "passed" : "failed",
    nextAction: passed
      ? "seek_fresh_confirmation_for_D6_without_promoting_from_posthoc_MemOps"
      : "reject_D6_v1_and_retain_V1",
    protocol: MEMOPS_DOMINANCE_PROTOCOL,
    generatedAt: new Date().toISOString(),
    input: {
      sourceResultCardSha256: sha256(sourceResultCardText),
      developmentCasesSha256: development.sha256,
      validationCasesSha256: validation.sha256,
      testCasesSha256: test.sha256,
      casesSha256: sha256(casesText),
    },
    primary: allSummary,
    originalPhaseSlices: Object.fromEntries(
      (["development", "validation", "test"] as const).map((phase) => [
        phase,
        summarize(guardedRows.filter((row) => row.phase === phase)),
      ]),
    ),
    safety: {
      metricHarms,
      tokenViolations,
      rejectionReasons,
    },
    operational,
    gate: {
      passed,
      checks,
      failedChecks: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key),
    },
    caveats: [
      "D6 was designed after inspecting the D5 test failure, so every MemOps number is post-hoc mechanism evidence.",
      "The certificate depends on the shared gold operation graph and does not validate extraction.",
      "Identity preservation outside the graph is stronger than D5 but is not an answer-level guarantee.",
      "This protocol cannot promote D6 even if every viability check passes.",
    ],
  };
  await writeFile(
    path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}
