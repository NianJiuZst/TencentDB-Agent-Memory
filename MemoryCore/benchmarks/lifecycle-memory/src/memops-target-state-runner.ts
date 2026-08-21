import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import {
  applyLifecyclePolicy,
  applyLifecycleTargetState,
  LifecycleLedger,
  LifecycleTargetState,
  type LifecycleEvent,
  type LifecyclePolicy,
  type LifecycleTargetStateOperation,
  type LifecycleTargetStatePolicy,
  type LifecycleUnit,
} from "../../../src/core/lifecycle/index.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import {
  describeMemOpsDataset,
  listMemOpsInstanceIds,
  loadMemOpsInstance,
  type MemOpsInstance,
  type MemOpsMappedProbe,
} from "./memops-adapter.js";
import {
  MEMOPS_TARGET_STATE_PROTOCOL,
  MEMOPS_TARGET_STATE_SELECTION,
  MEMOPS_TARGET_STATE_VALIDATION,
  type MemOpsTargetStatePhase,
} from "./memops-target-state-protocol.js";
import { buildMemOpsProfileSplitFromData } from "./memops-split.js";
import type { BootstrapInterval, RetrievedUnit } from "./types.js";

type Arm = "base" | "v1" | "target_state";
type Metric = "currentStateRecall" | "staleAbsence" | "staleAnyAbsence"
  | "stateFama" | "goldProvenanceRecall";

interface CandidatePolicy {
  budgetFraction: number;
  id: string;
  maxStateUnits: number;
}

interface StateMetrics extends Record<Metric, number> {
  injectedItems: number;
  injectedTokens: number;
}

interface ContextDecision {
  mode: string;
  fallbackReason?: string;
  sidecarLatencyMs: number;
  tokenBudget?: number;
  itemsSkippedForBudget?: number;
  [key: string]: unknown;
}

interface CaseRow {
  protocolVersion: string;
  phase: MemOpsTargetStatePhase;
  caseId: string;
  instanceId: string;
  profileId: string;
  operationFamily: string;
  probeType: string;
  view: "current" | "history";
  arm: Arm;
  policyId?: string;
  relevantTargetIds: string[];
  candidateIds: string[];
  queryLatencyMs: number;
  metrics: StateMetrics;
  decision: ContextDecision;
}

interface InstanceGoldState {
  activeByTarget: Map<string, Set<string>>;
  historyByTarget: Map<string, Set<string>>;
  targetsByUnit: Map<string, Set<string>>;
}

interface InstanceRuntime {
  gold: InstanceGoldState;
  materialize: (id: string) => RetrievedUnit | undefined;
  targetSource: LifecycleTargetState;
  unitById: Map<string, RetrievedUnit>;
  v1Resolver: LifecycleLedger;
}

interface OperationalChecks {
  instances: number;
  disabledMismatches: number;
  missingSourceMismatches: number;
  timeoutMismatches: number;
}

interface DevelopmentSelection {
  protocolVersion: string;
  phase: "development";
  status: "selected";
  datasetManifestSha256: string;
  splitCanonicalSha256: string;
  developmentCasesSha256: string;
  selectedPolicy: CandidatePolicy;
  policyScores: Array<{
    policy: CandidatePolicy;
    cases: number;
    stateFamaDelta: number;
    currentStateRecallDelta: number;
    staleAbsenceDelta: number;
    meanInjectedTokenIncreaseFraction: number;
    harmedCaseRate: number;
    fallbackRate: number;
    utility: number;
  }>;
}

export interface MemOpsTargetStateRunOptions {
  dataRoot: string;
  developmentCases?: string;
  outputDir: string;
  phase: MemOpsTargetStatePhase;
  selection?: string;
  split: string;
  validationSummary?: string;
  validation?: string;
}

const encoding = getEncoding("cl100k_base");
const METRICS: Metric[] = [
  "currentStateRecall",
  "staleAbsence",
  "staleAnyAbsence",
  "stateFama",
  "goldProvenanceRecall",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * quantile)];
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-12;
}

function sameCandidates(left: RetrievedUnit[], right: RetrievedUnit[]): boolean {
  return JSON.stringify(left.map((item) => ({ id: item.id, tokenCount: item.tokenCount })))
    === JSON.stringify(right.map((item) => ({ id: item.id, tokenCount: item.tokenCount })));
}

function policyId(budgetFraction: number, maxStateUnits: number): string {
  return `budget-${String(budgetFraction).replace(".", "p")}-state-${maxStateUnits}`;
}

function policies(): CandidatePolicy[] {
  return MEMOPS_TARGET_STATE_PROTOCOL.policyGrid.budgetFractions.flatMap((budgetFraction) =>
    MEMOPS_TARGET_STATE_PROTOCOL.policyGrid.maxStateUnits.map((maxStateUnits) => ({
      id: policyId(budgetFraction, maxStateUnits),
      budgetFraction,
      maxStateUnits,
    }))
  );
}

function v1Policy(): LifecyclePolicy {
  return {
    enabled: true,
    ...MEMOPS_TARGET_STATE_PROTOCOL.arms.v1,
  };
}

function targetPolicy(policy: CandidatePolicy, enabled = true): LifecycleTargetStatePolicy {
  return {
    enabled,
    ...MEMOPS_TARGET_STATE_PROTOCOL.arms.targetState,
    maxStateUnits: policy.maxStateUnits,
  };
}

function operationSourceIds(operation: MemOpsInstance["operations"][number]): string[] {
  return [...new Set([operation.triggerUnitId, ...operation.evidenceUnitIds])];
}

function targetKind(type: MemOpsInstance["operations"][number]["type"]): LifecycleTargetStateOperation["kind"] {
  return type === "forget" ? "delete" : type;
}

function buildRuntime(instance: MemOpsInstance): InstanceRuntime {
  const lifecycleUnits: LifecycleUnit[] = instance.units.map((unit) => ({
    id: unit.id,
    content: unit.content,
    sequence: unit.sequence,
  }));
  const v1Events: LifecycleEvent[] = instance.operations.filter((operation) =>
    operation.validity === "confirmed"
    && (operation.type === "update" || operation.type === "forget")
    && operation.old_value
  ).map((operation) => ({
    id: `${instance.id}:${operation.operation_id}`,
    sequence: operation.triggerSequence,
    confidence: 1,
    kind: operation.type === "forget" ? "delete" : "update",
    source: "memops-gold-operation",
    obsoleteValues: [operation.old_value!],
    successorUnitIds: [operation.triggerUnitId],
  }));
  const targetOperations: LifecycleTargetStateOperation[] = instance.operations.map((operation) => ({
    id: `${instance.id}:${operation.operation_id}`,
    targetId: operation.target.target_id,
    kind: targetKind(operation.type),
    validity: operation.validity,
    confidence: 1,
    sequence: operation.triggerSequence,
    sourceUnitIds: operationSourceIds(operation),
    successorUnitIds: operation.type === "forget" ? [] : operationSourceIds(operation),
  }));
  const targetsByUnit = new Map<string, Set<string>>();
  const historyByTarget = new Map<string, Set<string>>();
  const confirmedByTarget = new Map<string, MemOpsInstance["operations"]>();
  for (const operation of instance.operations) {
    const targetId = operation.target.target_id;
    const sourceIds = operationSourceIds(operation);
    const history = historyByTarget.get(targetId) ?? new Set<string>();
    for (const unitId of sourceIds) {
      history.add(unitId);
      const targets = targetsByUnit.get(unitId) ?? new Set<string>();
      targets.add(targetId);
      targetsByUnit.set(unitId, targets);
    }
    historyByTarget.set(targetId, history);
    if (operation.validity === "confirmed") {
      const confirmed = confirmedByTarget.get(targetId) ?? [];
      confirmed.push(operation);
      confirmedByTarget.set(targetId, confirmed);
    }
  }
  const activeByTarget = new Map<string, Set<string>>();
  for (const [targetId, confirmed] of confirmedByTarget) {
    const latest = [...confirmed].sort((left, right) =>
      left.triggerSequence - right.triggerSequence
      || left.operation_id.localeCompare(right.operation_id)
    ).at(-1)!;
    activeByTarget.set(
      targetId,
      latest.type === "forget" ? new Set() : new Set(operationSourceIds(latest)),
    );
  }
  const rawById = new Map(instance.units.map((unit) => [unit.id, unit]));
  const unitById = new Map<string, RetrievedUnit>();
  const materialize = (id: string): RetrievedUnit | undefined => {
    const cached = unitById.get(id);
    if (cached) return cached;
    const unit = rawById.get(id);
    if (!unit) return undefined;
    const retrieved: RetrievedUnit = {
      ...unit,
      score: 0,
      tokenCount: encoding.encode(unit.content).length,
    };
    unitById.set(id, retrieved);
    return retrieved;
  };
  return {
    gold: { activeByTarget, historyByTarget, targetsByUnit },
    materialize,
    targetSource: new LifecycleTargetState(lifecycleUnits, targetOperations),
    unitById,
    v1Resolver: new LifecycleLedger(lifecycleUnits, v1Events),
  };
}

function relevantTargets(probe: MemOpsMappedProbe, gold: InstanceGoldState): string[] {
  return [...new Set(probe.goldProvenanceUnitIds.flatMap((unitId) =>
    [...(gold.targetsByUnit.get(unitId) ?? [])]
  ))].sort();
}

function scoreContext(params: {
  candidates: RetrievedUnit[];
  gold: InstanceGoldState;
  probe: MemOpsMappedProbe;
}): { metrics: StateMetrics; relevantTargetIds: string[] } | null {
  const targetIds = relevantTargets(params.probe, params.gold);
  if (!targetIds.length) return null;
  const active = new Set<string>();
  const stale = new Set<string>();
  for (const targetId of targetIds) {
    for (const unitId of params.gold.activeByTarget.get(targetId) ?? []) active.add(unitId);
    for (const unitId of params.gold.historyByTarget.get(targetId) ?? []) stale.add(unitId);
  }
  for (const unitId of active) stale.delete(unitId);
  const selected = new Set(params.candidates.map((item) => item.id));
  const activeHits = [...active].filter((unitId) => selected.has(unitId)).length;
  const staleHits = [...stale].filter((unitId) => selected.has(unitId)).length;
  const currentStateRecall = active.size ? activeHits / active.size : 1;
  const staleAbsence = stale.size ? 1 - staleHits / stale.size : 1;
  const staleAnyAbsence = Number(staleHits === 0);
  const denominator = active.size + stale.size;
  const lambda = denominator ? stale.size / denominator : 0;
  const goldProvenance = new Set(params.probe.goldProvenanceUnitIds);
  const goldProvenanceRecall = goldProvenance.size
    ? [...goldProvenance].filter((unitId) => selected.has(unitId)).length / goldProvenance.size
    : 1;
  return {
    relevantTargetIds: targetIds,
    metrics: {
      currentStateRecall,
      staleAbsence,
      staleAnyAbsence,
      stateFama: Math.max(0, currentStateRecall - lambda * (1 - staleAbsence)),
      goldProvenanceRecall,
      injectedItems: params.candidates.length,
      injectedTokens: params.candidates.reduce((sum, item) => sum + item.tokenCount, 0),
    },
  };
}

function packWholeItems(
  candidates: RetrievedUnit[],
  v1Tokens: number,
  policy: CandidatePolicy,
): { candidates: RetrievedUnit[]; tokenBudget: number; itemsSkippedForBudget: number } {
  const tokenBudget = Math.floor(v1Tokens * policy.budgetFraction);
  const packed: RetrievedUnit[] = [];
  let tokens = 0;
  let itemsSkippedForBudget = 0;
  for (const candidate of candidates) {
    if (packed.length >= MEMOPS_TARGET_STATE_PROTOCOL.retrieval.resultLimit) break;
    if (tokens + candidate.tokenCount > tokenBudget) {
      itemsSkippedForBudget += 1;
      continue;
    }
    packed.push(candidate);
    tokens += candidate.tokenCount;
  }
  return { candidates: packed, tokenBudget, itemsSkippedForBudget };
}

function row(params: {
  arm: Arm;
  candidates: RetrievedUnit[];
  decision: ContextDecision;
  instance: MemOpsInstance;
  phase: MemOpsTargetStatePhase;
  policyId?: string;
  probe: MemOpsMappedProbe;
  queryLatencyMs: number;
  runtime: InstanceRuntime;
  view: "current" | "history";
}): CaseRow | null {
  const scored = scoreContext({
    candidates: params.candidates,
    gold: params.runtime.gold,
    probe: params.probe,
  });
  if (!scored) return null;
  return {
    protocolVersion: MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion,
    phase: params.phase,
    caseId: params.probe.id,
    instanceId: params.instance.id,
    profileId: params.instance.profileId,
    operationFamily: params.instance.operationFamily,
    probeType: params.probe.evaluation_type,
    view: params.view,
    arm: params.arm,
    ...(params.policyId ? { policyId: params.policyId } : {}),
    relevantTargetIds: scored.relevantTargetIds,
    candidateIds: params.candidates.map((item) => item.id),
    queryLatencyMs: params.queryLatencyMs,
    metrics: scored.metrics,
    decision: params.decision,
  };
}

function meanMetrics(rows: CaseRow[]): Record<Metric, number> {
  return Object.fromEntries(METRICS.map((metric) => [
    metric,
    mean(rows.map((item) => item.metrics[metric])),
  ])) as Record<Metric, number>;
}

function aggregate(rows: CaseRow[]) {
  return {
    cases: rows.length,
    ...meanMetrics(rows),
    meanInjectedItems: mean(rows.map((item) => item.metrics.injectedItems)),
    meanInjectedTokens: mean(rows.map((item) => item.metrics.injectedTokens)),
    queryLatencyP50Ms: percentile(rows.map((item) => item.queryLatencyMs), 0.5),
    queryLatencyP95Ms: percentile(rows.map((item) => item.queryLatencyMs), 0.95),
    sidecarLatencyP50Ms: percentile(rows.map((item) => item.decision.sidecarLatencyMs), 0.5),
    sidecarLatencyP95Ms: percentile(rows.map((item) => item.decision.sidecarLatencyMs), 0.95),
  };
}

function paired(rows: CaseRow[], policyIdValue: string) {
  const primary = rows.filter((item) => item.view === "current");
  const byKey = new Map(primary.map((item) => [
    `${item.caseId}\0${item.arm}\0${item.policyId ?? ""}`,
    item,
  ]));
  const caseIds = [...new Set(primary.filter((item) => item.arm === "v1").map((item) => item.caseId))];
  return caseIds.map((caseId) => {
    const v1 = byKey.get(`${caseId}\0v1\0`);
    const candidate = byKey.get(`${caseId}\0target_state\0${policyIdValue}`);
    if (!v1 || !candidate) throw new Error(`missing paired MemOps row ${caseId}/${policyIdValue}`);
    return { caseId, profileId: v1.profileId, operationFamily: v1.operationFamily, v1, candidate };
  });
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
  pairs: ReturnType<typeof paired>,
  metric: Metric,
  seed: number,
): BootstrapInterval {
  const byProfile = new Map<string, typeof pairs>();
  for (const item of pairs) {
    const cluster = byProfile.get(item.profileId) ?? [];
    cluster.push(item);
    byProfile.set(item.profileId, cluster);
  }
  const clusters = [...byProfile.values()];
  const delta = (item: typeof pairs[number]) =>
    item.candidate.metrics[metric] - item.v1.metrics[metric];
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < MEMOPS_TARGET_STATE_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const selected: typeof pairs = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    draws.push(mean(selected.map(delta)));
  }
  draws.sort((left, right) => left - right);
  return {
    mean: mean(pairs.map(delta)),
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}

function compare(rows: CaseRow[], selectedPolicy: CandidatePolicy) {
  const pairs = paired(rows, selectedPolicy.id);
  return {
    pairs,
    intervals: Object.fromEntries(METRICS.map((metric, index) => [
      metric,
      bootstrap(
        pairs,
        metric,
        MEMOPS_TARGET_STATE_PROTOCOL.aggregation.bootstrapSeed + index,
      ),
    ])) as Record<Metric, BootstrapInterval>,
  };
}

export function selectMemOpsTargetStatePolicy(rows: CaseRow[]): DevelopmentSelection["policyScores"][number][] {
  return policies().map((policy) => {
    const pairs = paired(rows, policy.id);
    const delta = (metric: Metric) => mean(pairs.map((item) =>
      item.candidate.metrics[metric] - item.v1.metrics[metric]
    ));
    const v1Tokens = mean(pairs.map((item) => item.v1.metrics.injectedTokens));
    const candidateTokens = mean(pairs.map((item) => item.candidate.metrics.injectedTokens));
    const stateFamaDelta = delta("stateFama");
    const currentStateRecallDelta = delta("currentStateRecall");
    const staleAbsenceDelta = delta("staleAbsence");
    const meanInjectedTokenIncreaseFraction = v1Tokens
      ? candidateTokens / v1Tokens - 1
      : Number(candidateTokens > 0);
    const fallbackRate = mean(pairs.map((item) => Number(item.candidate.decision.mode === "fallback")));
    const harmedCaseRate = mean(pairs.map((item) => Number(
      item.candidate.metrics.stateFama < item.v1.metrics.stateFama,
    )));
    const utility = stateFamaDelta
      - 2 * Math.max(0, -currentStateRecallDelta)
      - 2 * Math.max(0, -staleAbsenceDelta)
      - 0.25 * Math.max(0, meanInjectedTokenIncreaseFraction)
      - fallbackRate;
    return {
      policy,
      cases: pairs.length,
      stateFamaDelta,
      currentStateRecallDelta,
      staleAbsenceDelta,
      meanInjectedTokenIncreaseFraction,
      harmedCaseRate,
      fallbackRate,
      utility,
    };
  }).sort((left, right) =>
    right.utility - left.utility
    || left.policy.budgetFraction - right.policy.budgetFraction
    || left.policy.maxStateUnits - right.policy.maxStateUnits
    || left.policy.id.localeCompare(right.policy.id)
  );
}

async function verifyFrozenInputs(options: MemOpsTargetStateRunOptions) {
  const splitText = await readFile(options.split, "utf8");
  if (sha256(splitText) !== MEMOPS_TARGET_STATE_PROTOCOL.split.fileSha256) {
    throw new Error("MemOps split file hash mismatch");
  }
  const split = JSON.parse(splitText) as Record<string, any>;
  const reconstructed = await buildMemOpsProfileSplitFromData(
    options.dataRoot,
    split.seed,
  );
  if (split.protocolVersion !== MEMOPS_TARGET_STATE_PROTOCOL.split.protocolVersion
    || reconstructed.canonicalSha256 !== MEMOPS_TARGET_STATE_PROTOCOL.split.canonicalSha256
    || reconstructed.canonicalSha256 !== split.canonicalSha256
    || JSON.stringify(reconstructed.development) !== JSON.stringify(split.development)
    || JSON.stringify(reconstructed.validation) !== JSON.stringify(split.validation)
    || JSON.stringify(reconstructed.test) !== JSON.stringify(split.test)) {
    throw new Error("MemOps reconstructed profile split mismatch");
  }
  const dataset = await describeMemOpsDataset({
    dataRoot: options.dataRoot,
    revision: MEMOPS_TARGET_STATE_PROTOCOL.dataset.revision,
  });
  const expected = MEMOPS_TARGET_STATE_PROTOCOL.dataset;
  if (dataset.manifestSha256 !== expected.manifestSha256
    || dataset.instances !== expected.instances
    || dataset.profiles !== expected.profiles
    || dataset.operations !== expected.operations
    || dataset.longitudinalProbes !== expected.longitudinalProbes) {
    throw new Error("MemOps dataset identity mismatch");
  }
  return { dataset, split, splitSha256: sha256(splitText) };
}

async function loadDevelopmentSelection(options: MemOpsTargetStateRunOptions) {
  if (!options.selection) throw new Error("MemOps validation/test requires --selection");
  const selectionText = await readFile(options.selection, "utf8");
  if (sha256(selectionText) !== MEMOPS_TARGET_STATE_SELECTION.developmentSelectionSha256) {
    throw new Error("MemOps frozen development selection hash mismatch");
  }
  const selection = JSON.parse(selectionText) as DevelopmentSelection;
  if (selection.protocolVersion !== MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion
    || selection.phase !== "development" || selection.status !== "selected") {
    throw new Error("incompatible MemOps development selection");
  }
  if (options.phase === "validation") {
    if (!options.developmentCases) throw new Error("MemOps validation requires --development-cases");
    const casesText = await readFile(options.developmentCases, "utf8");
    if (sha256(casesText) !== selection.developmentCasesSha256
      || sha256(casesText) !== MEMOPS_TARGET_STATE_SELECTION.developmentCasesSha256) {
      throw new Error("MemOps development cases hash mismatch");
    }
    const rows = casesText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CaseRow);
    const recomputed = selectMemOpsTargetStatePolicy(rows)[0];
    if (recomputed.policy.id !== selection.selectedPolicy.id
      || selection.selectedPolicy.id !== MEMOPS_TARGET_STATE_SELECTION.selectedPolicy.id
      || !close(recomputed.utility, selection.policyScores[0].utility)) {
      throw new Error("MemOps development policy selection did not replay");
    }
  }
  return { selection, selectionSha256: sha256(selectionText) };
}

function forcedChecks(
  instance: MemOpsInstance,
  runtime: InstanceRuntime,
  selectedPolicy: CandidatePolicy,
): Omit<OperationalChecks, "instances"> {
  const firstSource = operationSourceIds(instance.operations[0])[0];
  const orderedIds = [firstSource, ...instance.units.map((item) => item.id)]
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, MEMOPS_TARGET_STATE_PROTOCOL.retrieval.resultLimit + 2);
  const candidates = orderedIds.map((id) => runtime.materialize(id)!);
  const baseline = candidates.slice(0, MEMOPS_TARGET_STATE_PROTOCOL.retrieval.resultLimit);
  const disabled = applyLifecycleTargetState({
    candidates,
    source: runtime.targetSource,
    policy: targetPolicy(selectedPolicy, false),
    materialize: runtime.materialize,
  });
  const missingSource = applyLifecycleTargetState({
    candidates,
    policy: targetPolicy(selectedPolicy),
    materialize: runtime.materialize,
  });
  let clock = 0;
  const timeout = applyLifecycleTargetState({
    candidates,
    source: runtime.targetSource,
    policy: targetPolicy(selectedPolicy),
    materialize: runtime.materialize,
    now: () => (clock += MEMOPS_TARGET_STATE_PROTOCOL.arms.targetState.timeoutMs + 1),
  });
  return {
    disabledMismatches: Number(disabled.decision.mode !== "base"
      || !sameCandidates(disabled.candidates, baseline)),
    missingSourceMismatches: Number(missingSource.decision.mode !== "fallback"
      || !sameCandidates(missingSource.candidates, baseline)),
    timeoutMismatches: Number(timeout.decision.mode !== "fallback"
      || !sameCandidates(timeout.candidates, baseline)),
  };
}

async function runRows(params: {
  dataRoot: string;
  instanceIds: string[];
  phase: MemOpsTargetStatePhase;
  selectedPolicy?: CandidatePolicy;
}): Promise<{ rows: CaseRow[]; operational: OperationalChecks; historyModeMismatches: number }> {
  const rows: CaseRow[] = [];
  const operational: OperationalChecks = {
    instances: 0,
    disabledMismatches: 0,
    missingSourceMismatches: 0,
    timeoutMismatches: 0,
  };
  let historyModeMismatches = 0;
  const candidatePolicies = params.phase === "development"
    ? policies()
    : [params.selectedPolicy!];
  for (let instanceIndex = 0; instanceIndex < params.instanceIds.length; instanceIndex += 1) {
    const instance = await loadMemOpsInstance(params.dataRoot, params.instanceIds[instanceIndex]);
    const runtime = buildRuntime(instance);
    const backend = new MemoryCoreGroupBackend(instance.units);
    try {
      const primary = instance.probes.filter((probe) =>
        probe.evaluation_type === MEMOPS_TARGET_STATE_PROTOCOL.aggregation.primaryProbeType
        && relevantTargets(probe, runtime.gold).length > 0
      );
      for (const probe of primary) {
        const search = await backend.search(
          probe.question,
          MEMOPS_TARGET_STATE_PROTOCOL.retrieval.candidateLimit,
        );
        for (const candidate of search.candidates) runtime.unitById.set(candidate.id, candidate);
        const base = search.candidates.slice(0, MEMOPS_TARGET_STATE_PROTOCOL.retrieval.resultLimit);
        const v1Started = performance.now();
        const v1 = applyLifecyclePolicy({
          candidates: search.candidates,
          resolver: runtime.v1Resolver,
          policy: v1Policy(),
          materialize: runtime.materialize,
        });
        const v1Latency = performance.now() - v1Started;
        const baseRow = row({
          arm: "base",
          candidates: base,
          decision: { mode: "base", sidecarLatencyMs: 0 },
          instance,
          phase: params.phase,
          probe,
          queryLatencyMs: search.latencyMs,
          runtime,
          view: "current",
        });
        const v1Row = row({
          arm: "v1",
          candidates: v1.candidates,
          decision: {
            ...v1.decision,
            sidecarLatencyMs: v1Latency,
          },
          instance,
          phase: params.phase,
          probe,
          queryLatencyMs: search.latencyMs,
          runtime,
          view: "current",
        });
        if (!baseRow || !v1Row) throw new Error(`unexpected unaligned primary probe ${probe.id}`);
        rows.push(baseRow, v1Row);
        const v1Tokens = v1.candidates.reduce((sum, item) => sum + item.tokenCount, 0);
        for (const policy of candidatePolicies) {
          const projected = applyLifecycleTargetState({
            candidates: search.candidates,
            source: runtime.targetSource,
            policy: targetPolicy(policy),
            materialize: runtime.materialize,
          });
          const packed = projected.decision.mode === "adaptive"
            ? packWholeItems(projected.candidates, v1Tokens, policy)
            : { candidates: projected.candidates, tokenBudget: v1Tokens, itemsSkippedForBudget: 0 };
          const candidateRow = row({
            arm: "target_state",
            candidates: packed.candidates,
            decision: {
              ...projected.decision,
              sidecarLatencyMs: projected.decision.elapsedMs,
              tokenBudget: packed.tokenBudget,
              itemsSkippedForBudget: packed.itemsSkippedForBudget,
            },
            instance,
            phase: params.phase,
            policyId: policy.id,
            probe,
            queryLatencyMs: search.latencyMs,
            runtime,
            view: "current",
          });
          if (!candidateRow) throw new Error(`unexpected unaligned candidate probe ${probe.id}`);
          rows.push(candidateRow);
        }
      }
      if (params.phase !== "development") {
        const history = instance.probes.filter((probe) =>
          MEMOPS_TARGET_STATE_PROTOCOL.aggregation.historyModeProbeTypes.includes(probe.evaluation_type)
          && relevantTargets(probe, runtime.gold).length > 0
        );
        for (const probe of history) {
          const search = await backend.search(
            probe.question,
            MEMOPS_TARGET_STATE_PROTOCOL.retrieval.candidateLimit,
          );
          for (const candidate of search.candidates) runtime.unitById.set(candidate.id, candidate);
          const v1 = applyLifecyclePolicy({
            candidates: search.candidates,
            resolver: runtime.v1Resolver,
            policy: v1Policy(),
            materialize: runtime.materialize,
          });
          const candidate = v1.candidates;
          historyModeMismatches += Number(!sameCandidates(candidate, v1.candidates));
          const v1Row = row({
            arm: "v1",
            candidates: v1.candidates,
            decision: { ...v1.decision, sidecarLatencyMs: v1.decision.elapsedMs },
            instance,
            phase: params.phase,
            probe,
            queryLatencyMs: search.latencyMs,
            runtime,
            view: "history",
          });
          const candidateRow = row({
            arm: "target_state",
            candidates: candidate,
            decision: { mode: "history_v1", sidecarLatencyMs: v1.decision.elapsedMs },
            instance,
            phase: params.phase,
            policyId: params.selectedPolicy!.id,
            probe,
            queryLatencyMs: search.latencyMs,
            runtime,
            view: "history",
          });
          if (v1Row && candidateRow) rows.push(v1Row, candidateRow);
        }
        const checks = forcedChecks(instance, runtime, params.selectedPolicy!);
        operational.instances += 1;
        operational.disabledMismatches += checks.disabledMismatches;
        operational.missingSourceMismatches += checks.missingSourceMismatches;
        operational.timeoutMismatches += checks.timeoutMismatches;
      }
    } finally {
      backend.close();
    }
    if ((instanceIndex + 1) % 25 === 0 || instanceIndex + 1 === params.instanceIds.length) {
      process.stdout.write(`MemOps ${params.phase} instances ${instanceIndex + 1}/${params.instanceIds.length}\n`);
    }
  }
  return { rows, operational, historyModeMismatches };
}

function gateReport(params: {
  comparison: ReturnType<typeof compare>;
  historyModeMismatches: number;
  operational: OperationalChecks;
  phase: "validation" | "test";
}) {
  const { pairs, intervals } = params.comparison;
  const candidateRows = pairs.map((item) => item.candidate);
  const v1Rows = pairs.map((item) => item.v1);
  const v1Tokens = mean(v1Rows.map((item) => item.metrics.injectedTokens));
  const candidateTokens = mean(candidateRows.map((item) => item.metrics.injectedTokens));
  const tokenIncrease = v1Tokens ? candidateTokens / v1Tokens - 1 : Number(candidateTokens > 0);
  const tokenViolations = pairs.filter((item) =>
    item.candidate.metrics.injectedTokens > item.v1.metrics.injectedTokens
  ).length;
  const ordinaryFallbacks = candidateRows.filter((item) => item.decision.mode === "fallback").length;
  const harmedCaseRate = mean(pairs.map((item) => Number(
    item.candidate.metrics.stateFama < item.v1.metrics.stateFama,
  )));
  const perOperationFamily = Object.fromEntries([...new Set(pairs.map((item) => item.operationFamily))]
    .sort().map((family) => [
      family,
      mean(pairs.filter((item) => item.operationFamily === family).map((item) =>
        item.candidate.metrics.stateFama - item.v1.metrics.stateFama
      )),
    ]));
  const p95SidecarLatencyMs = percentile(candidateRows.map(
    (item) => item.decision.sidecarLatencyMs,
  ), 0.95);
  const gate = params.phase === "validation"
    ? MEMOPS_TARGET_STATE_PROTOCOL.validationGate
    : MEMOPS_TARGET_STATE_PROTOCOL.testGate;
  const checks: Record<string, boolean> = {
    stateFamaMagnitude: intervals.stateFama.mean >= gate.minStateFamaDelta,
    stateFamaUncertainty: intervals.stateFama.lower >= gate.minStateFamaBootstrapLower,
    currentStateRecallDirection: intervals.currentStateRecall.mean
      >= gate.minCurrentStateRecallDelta,
    staleAbsenceDirection: intervals.staleAbsence.mean >= gate.minStaleAbsenceDelta,
    tokenBudget: tokenIncrease <= gate.maxMeanInjectedTokenIncreaseFraction,
    perQueryTokenBudget: tokenViolations <= gate.maxPerQueryTokenViolations,
    ordinaryFallbacks: ordinaryFallbacks <= gate.maxOrdinaryFallbacks,
  };
  if (params.phase === "validation") {
    const validation = MEMOPS_TARGET_STATE_PROTOCOL.validationGate;
    Object.assign(checks, {
      harmedCaseRate: harmedCaseRate <= validation.maxPrimaryHarmedCaseRate,
      operationFamilyDirection: Object.values(perOperationFamily).every((value) =>
        value >= validation.minPerOperationFamilyStateFamaDelta
      ),
      sidecarLatency: p95SidecarLatencyMs <= validation.maxP95SidecarLatencyMs,
      disabledFallback: !validation.requireExactDisabledFallback
        || params.operational.disabledMismatches === 0,
      missingSourceFallback: !validation.requireExactMissingSourceFallback
        || params.operational.missingSourceMismatches === 0,
      timeoutFallback: !validation.requireExactTimeoutFallback
        || params.operational.timeoutMismatches === 0,
      historyModeV1: !validation.requireExactHistoryModeV1
        || params.historyModeMismatches === 0,
    });
  }
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
    diagnostics: {
      harmedCaseRate,
      perOperationFamily,
      v1MeanInjectedTokens: v1Tokens,
      candidateMeanInjectedTokens: candidateTokens,
      meanInjectedTokenIncreaseFraction: tokenIncrease,
      perQueryTokenViolations: tokenViolations,
      ordinaryFallbacks,
      p95SidecarLatencyMs,
    },
  };
}

export async function runMemOpsTargetState(
  options: MemOpsTargetStateRunOptions,
): Promise<Record<string, unknown>> {
  if (options.phase === "test") {
    if (!options.validationSummary) throw new Error("MemOps test requires --validation-summary");
    const validationText = await readFile(options.validationSummary, "utf8");
    const validationSummary = JSON.parse(validationText);
    if (MEMOPS_TARGET_STATE_PROTOCOL.testGate.requireValidationPassBeforeRead
      && validationSummary.status !== "passed") {
      throw new Error("MemOps test is locked until validation passes");
    }
    if (sha256(validationText) !== MEMOPS_TARGET_STATE_VALIDATION.validationSummarySha256) {
      throw new Error("MemOps test validation summary hash mismatch");
    }
    if (!options.validation) throw new Error("MemOps test requires --validation");
    const independentText = await readFile(options.validation, "utf8");
    const independentValidation = JSON.parse(independentText);
    if (sha256(independentText) !== MEMOPS_TARGET_STATE_VALIDATION.independentValidationSha256
      || independentValidation.status !== "passed"
      || independentValidation.phase !== "validation"
      || independentValidation.input.casesSha256
        !== MEMOPS_TARGET_STATE_VALIDATION.validationCasesSha256
      || independentValidation.input.summarySha256
        !== MEMOPS_TARGET_STATE_VALIDATION.validationSummarySha256) {
      throw new Error("MemOps test independent validation artifact mismatch");
    }
  }
  const frozen = await verifyFrozenInputs(options);
  const splitProfiles: string[] = frozen.split[options.phase];
  const profileSet = new Set(splitProfiles);
  const instanceIds = (await listMemOpsInstanceIds(options.dataRoot)).filter((instanceId) => {
    const profile = /^([A-Z]\d+)_/.exec(instanceId)?.[1];
    return profile ? profileSet.has(profile) : false;
  });
  let selectedPolicy: CandidatePolicy | undefined;
  let selectionSha256: string | undefined;
  if (options.phase !== "development") {
    const selected = await loadDevelopmentSelection(options);
    selectedPolicy = selected.selection.selectedPolicy;
    selectionSha256 = selected.selectionSha256;
    if (options.phase === "test") {
      const validationText = await readFile(options.validationSummary!, "utf8");
      const validation = JSON.parse(validationText);
      if (validation.input.selectionSha256 !== selectionSha256
        || selectionSha256 !== MEMOPS_TARGET_STATE_VALIDATION.developmentSelectionSha256) {
        throw new Error("MemOps test selection differs from passed validation");
      }
    }
  }
  const run = await runRows({
    dataRoot: options.dataRoot,
    instanceIds,
    phase: options.phase,
    selectedPolicy,
  });
  await mkdir(options.outputDir, { recursive: true });
  const casesText = `${run.rows.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const casesPath = path.join(options.outputDir, "cases.jsonl");
  await writeFile(casesPath, casesText, "utf8");
  const expectedPrimaryCases = options.phase === "development"
    ? MEMOPS_TARGET_STATE_PROTOCOL.split.developmentPrimaryCases
    : options.phase === "validation"
      ? MEMOPS_TARGET_STATE_PROTOCOL.split.validationPrimaryCases
      : MEMOPS_TARGET_STATE_PROTOCOL.split.testPrimaryCases;
  if (run.rows.filter((item) => item.view === "current" && item.arm === "v1").length
    !== expectedPrimaryCases) {
    throw new Error("MemOps primary case count mismatch");
  }
  if (options.phase === "development") {
    const policyScores = selectMemOpsTargetStatePolicy(run.rows);
    const selection: DevelopmentSelection = {
      protocolVersion: MEMOPS_TARGET_STATE_PROTOCOL.protocolVersion,
      phase: "development",
      status: "selected",
      datasetManifestSha256: frozen.dataset.manifestSha256,
      splitCanonicalSha256: frozen.split.canonicalSha256,
      developmentCasesSha256: sha256(casesText),
      selectedPolicy: policyScores[0].policy,
      policyScores,
    };
    await writeFile(
      path.join(options.outputDir, "selection.json"),
      `${JSON.stringify(selection, null, 2)}\n`,
      "utf8",
    );
    const report = {
      status: "selected",
      nextAction: "freeze_selection_hash_then_run_validation_profiles",
      protocol: MEMOPS_TARGET_STATE_PROTOCOL,
      phase: options.phase,
      generatedAt: new Date().toISOString(),
      dataset: frozen.dataset,
      input: { splitSha256: frozen.splitSha256, casesSha256: sha256(casesText) },
      instances: instanceIds.length,
      primaryCases: expectedPrimaryCases,
      selectedPolicy: selection.selectedPolicy,
      policyScores,
      arms: {
        base: aggregate(run.rows.filter((item) => item.view === "current" && item.arm === "base")),
        v1: aggregate(run.rows.filter((item) => item.view === "current" && item.arm === "v1")),
      },
      caveats: [
        "Development selects a policy and cannot confirm efficacy.",
        "Gold operation traces are shared oracle extraction inputs, not model-extracted memories.",
        "Only CandidateDisambiguation probes define the current-state optimization slice.",
      ],
    };
    await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  const comparison = compare(run.rows, selectedPolicy!);
  const gate = gateReport({
    comparison,
    historyModeMismatches: run.historyModeMismatches,
    operational: run.operational,
    phase: options.phase,
  });
  const currentRows = run.rows.filter((item) => item.view === "current");
  const report = {
    status: gate.passed ? "passed" : "failed",
    nextAction: options.phase === "validation"
      ? gate.passed
        ? "unlock_untouched_test_profiles"
        : "reject_D5_v1_without_reading_test_retrieval_outcomes"
      : gate.passed
        ? "qualify_D5_for_answer_level_MemOps_and_internal_adapter_testing"
        : "retain_V1_and_record_D5_boundary",
    protocol: MEMOPS_TARGET_STATE_PROTOCOL,
    phase: options.phase,
    generatedAt: new Date().toISOString(),
    dataset: frozen.dataset,
    input: {
      splitSha256: frozen.splitSha256,
      selectionSha256,
      casesSha256: sha256(casesText),
      ...(options.phase === "test" ? {
        validationSummarySha256: sha256(await readFile(options.validationSummary!, "utf8")),
        independentValidationSha256: sha256(await readFile(options.validation!, "utf8")),
      } : {}),
    },
    instances: instanceIds.length,
    primaryCases: expectedPrimaryCases,
    selectedPolicy,
    primary: {
      arms: {
        base: aggregate(currentRows.filter((item) => item.arm === "base")),
        v1: aggregate(currentRows.filter((item) => item.arm === "v1")),
        targetState: aggregate(currentRows.filter((item) => item.arm === "target_state")),
      },
      targetStateVsV1: comparison.intervals,
    },
    operationalIntegrity: {
      ...run.operational,
      historyModeRows: run.rows.filter((item) => item.view === "history").length,
      historyModeMismatches: run.historyModeMismatches,
    },
    gate,
    caveats: [
      "This is direct operation-state evidence on a public synthetic benchmark, not programming-task evidence.",
      "Gold operations are shared across arms, so the result isolates management and says nothing about extraction accuracy.",
      "The public artifact has target ids but no independent branch/environment scope field.",
      "Answer-level evaluation is deferred until the untouched direct test gate passes.",
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
