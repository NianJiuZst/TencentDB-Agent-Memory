import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import {
  applyLifecycleDeleteVacancy,
  applyLifecyclePolicy,
  LifecycleDeleteVacancy,
  LifecycleLedger,
  type LifecycleDeleteVacancyDecision,
  type LifecycleDeleteVacancySource,
  type LifecycleDecisionLog,
} from "../../../src/core/lifecycle/index.js";
import { loadMemora } from "./adapter.js";
import { sourceRevision } from "./adaptive-runner.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import { DELETE_VACANCY_PROTOCOL } from "./delete-vacancy-protocol.js";
import { aggregate, pairedPersonaBootstrap, scoreRetrieved } from "./metrics.js";
import { extractMemoraLifecycleEvents } from "./memora-events.js";
import type { BootstrapInterval, CaseMetrics, LifecycleEvalQuestion, RetrievedUnit } from "./types.js";

type Arm = "v1" | "delete_vacancy";
type DirectMetric = "evidenceFamaProxy" | "currentSessionRecall" | "forgettingAbsence";

interface PreparedCase {
  question: LifecycleEvalQuestion;
  candidates: RetrievedUnit[];
  queryLatencyMs: number;
  ledger?: LifecycleLedger;
  vacancy?: LifecycleDeleteVacancy;
  materialize: (id: string) => RetrievedUnit | undefined;
}

interface DeleteVacancyCaseResult {
  arm: Arm;
  candidateIds: string[];
  caseId: string;
  decision: LifecycleDecisionLog | LifecycleDeleteVacancyDecision;
  forgettingBearing: boolean;
  groupId: string;
  metrics: CaseMetrics;
  period: string;
  persona: string;
  queryLatencyMs: number;
  task: string;
}

export interface DeleteVacancyRunOptions {
  dataRoot: string;
  outputDir: string;
  skipHashVerification?: boolean;
}

const encoding = getEncoding("cl100k_base");
const DIRECT_METRICS: DirectMetric[] = [
  "evidenceFamaProxy",
  "currentSessionRecall",
  "forgettingAbsence",
];

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function prepareResult(params: {
  arm: Arm;
  candidates: RetrievedUnit[];
  decision: LifecycleDecisionLog | LifecycleDeleteVacancyDecision;
  prepared: PreparedCase;
}): DeleteVacancyCaseResult {
  return {
    arm: params.arm,
    caseId: params.prepared.question.id,
    groupId: params.prepared.question.groupId,
    persona: params.prepared.question.persona,
    period: params.prepared.question.period,
    task: params.prepared.question.task,
    forgettingBearing: params.prepared.question.obsoleteAtoms.length > 0,
    candidateIds: params.candidates.map((candidate) => candidate.id),
    queryLatencyMs: params.prepared.queryLatencyMs + params.decision.elapsedMs,
    metrics: scoreRetrieved(params.prepared.question, params.candidates),
    decision: params.decision,
  };
}

function v1Result(prepared: PreparedCase): DeleteVacancyCaseResult {
  const applied = applyLifecyclePolicy({
    candidates: prepared.candidates,
    resolver: prepared.ledger,
    policy: DELETE_VACANCY_PROTOCOL.incumbent,
    materialize: prepared.materialize,
  });
  return prepareResult({
    arm: "v1",
    prepared,
    candidates: applied.candidates,
    decision: applied.decision,
  });
}

function candidateResult(prepared: PreparedCase): DeleteVacancyCaseResult {
  const applied = applyLifecycleDeleteVacancy({
    candidates: prepared.candidates,
    source: prepared.vacancy,
    policy: DELETE_VACANCY_PROTOCOL.candidate,
    materialize: prepared.materialize,
  });
  return prepareResult({
    arm: "delete_vacancy",
    prepared,
    candidates: applied.candidates,
    decision: applied.decision,
  });
}

async function prepare(options: DeleteVacancyRunOptions) {
  const loaded = await loadMemora(options.dataRoot, !options.skipHashVerification);
  if (loaded.description.revision !== DELETE_VACANCY_PROTOCOL.dataset.revision
    || loaded.description.dataManifestSha256 !== DELETE_VACANCY_PROTOCOL.dataset.dataManifestSha256) {
    throw new Error("delete-vacancy dataset provenance mismatch");
  }
  const cases: PreparedCase[] = [];
  const groups: Array<Record<string, unknown>> = [];
  for (let index = 0; index < loaded.groups.length; index += 1) {
    const group = loaded.groups[index];
    const extracted = extractMemoraLifecycleEvents(group.sessions, group.units);
    const lifecycleUnits = group.units.map((unit) => ({
      id: unit.id,
      content: unit.content,
      sequence: unit.sequence,
    }));
    let ledger: LifecycleLedger | undefined;
    let vacancy: LifecycleDeleteVacancy | undefined;
    let ledgerError: string | undefined;
    let vacancyError: string | undefined;
    try {
      ledger = new LifecycleLedger(lifecycleUnits, extracted.events, {
        maxUnits: DELETE_VACANCY_PROTOCOL.capacity.maxUnitsPerGroup,
        maxEvents: DELETE_VACANCY_PROTOCOL.capacity.maxEventsPerGroup,
        maxEdges: DELETE_VACANCY_PROTOCOL.capacity.maxEdgesPerGroup,
      });
    } catch (error) {
      ledgerError = error instanceof Error ? error.message : String(error);
    }
    try {
      vacancy = new LifecycleDeleteVacancy(lifecycleUnits, extracted.events, {
        maxUnits: DELETE_VACANCY_PROTOCOL.capacity.maxUnitsPerGroup,
        maxEvents: DELETE_VACANCY_PROTOCOL.capacity.maxEventsPerGroup,
        maxEdges: DELETE_VACANCY_PROTOCOL.capacity.maxEdgesPerGroup,
        maxTombstones: DELETE_VACANCY_PROTOCOL.capacity.maxTombstonesPerGroup,
      });
    } catch (error) {
      vacancyError = error instanceof Error ? error.message : String(error);
    }
    groups.push({
      groupId: group.id,
      events: extracted.events.length,
      sourceCounts: extracted.sourceCounts,
      ledgerStats: ledger?.stats,
      ...(ledgerError ? { ledgerError } : {}),
      ...(vacancyError ? { vacancyError } : {}),
    });

    const materialized = new Map<string, RetrievedUnit>();
    for (const unit of group.units) {
      materialized.set(unit.id, {
        ...unit,
        score: 0,
        tokenCount: encoding.encode(unit.content).length,
      });
    }
    const backend = new MemoryCoreGroupBackend(group.units);
    try {
      for (const question of group.questions) {
        const search = await backend.search(
          question.query,
          DELETE_VACANCY_PROTOCOL.candidate.candidateLimit,
        );
        for (const candidate of search.candidates) materialized.set(candidate.id, candidate);
        cases.push({
          question,
          candidates: search.candidates,
          queryLatencyMs: search.latencyMs,
          ledger,
          vacancy,
          materialize: (id) => materialized.get(id),
        });
      }
    } finally {
      backend.close();
    }
    process.stdout.write(`delete-vacancy prepared ${index + 1}/${loaded.groups.length} (${group.id})\n`);
  }
  return { cases, dataset: loaded.description, groups };
}

function comparison(
  candidate: DeleteVacancyCaseResult[],
  v1: DeleteVacancyCaseResult[],
  seedOffset: number,
): Record<DirectMetric, BootstrapInterval> {
  return Object.fromEntries(DIRECT_METRICS.map((metric, index) => [
    metric,
    pairedPersonaBootstrap(
      candidate,
      v1,
      (left, right) => left.metrics[metric] - right.metrics[metric],
      DELETE_VACANCY_PROTOCOL.evaluation.bootstrapSamples,
      DELETE_VACANCY_PROTOCOL.seed + seedOffset + index,
    ),
  ])) as Record<DirectMetric, BootstrapInterval>;
}

function subsetReport(params: {
  candidate: DeleteVacancyCaseResult[];
  predicate: (result: DeleteVacancyCaseResult) => boolean;
  seedOffset: number;
  v1: DeleteVacancyCaseResult[];
}) {
  const selectedV1 = params.v1.filter(params.predicate);
  const ids = new Set(selectedV1.map((item) => item.caseId));
  const selectedCandidate = params.candidate.filter((item) => ids.has(item.caseId));
  const v1Aggregate = aggregate(selectedV1);
  const candidateAggregate = aggregate(selectedCandidate);
  const v1ById = new Map(selectedV1.map((item) => [item.caseId, item]));
  const harmedCases = selectedCandidate.filter((item) =>
    item.metrics.evidenceFamaProxy
      < (v1ById.get(item.caseId)?.metrics.evidenceFamaProxy ?? 0) - 1e-12
  ).length;
  return {
    v1: v1Aggregate,
    deleteVacancy: candidateAggregate,
    deleteVacancyVsV1: comparison(selectedCandidate, selectedV1, params.seedOffset),
    harmedCases,
    meanInjectedTokenIncreaseFraction: v1Aggregate.meanInjectedTokens
      ? candidateAggregate.meanInjectedTokens / v1Aggregate.meanInjectedTokens - 1
      : 0,
  };
}

function fallbackChecks(prepared: PreparedCase[]) {
  const disabledPolicy = { ...DELETE_VACANCY_PROTOCOL.candidate, enabled: false };
  const damaged: LifecycleDeleteVacancySource = {
    resolveIds: () => {
      throw new Error("forced delete-vacancy damage");
    },
  };
  let disabledMismatches = 0;
  let damagedMismatches = 0;
  let timeoutMismatches = 0;
  for (const item of prepared) {
    const expected = item.candidates.slice(0, DELETE_VACANCY_PROTOCOL.candidate.resultLimit)
      .map((candidate) => candidate.id).join("\0");
    const disabled = applyLifecycleDeleteVacancy({
      candidates: item.candidates,
      materialize: item.materialize,
      policy: disabledPolicy,
      source: item.vacancy,
    });
    disabledMismatches += Number(disabled.candidates.map((candidate) => candidate.id).join("\0") !== expected);
    const damagedResult = applyLifecycleDeleteVacancy({
      candidates: item.candidates,
      materialize: item.materialize,
      policy: DELETE_VACANCY_PROTOCOL.candidate,
      source: damaged,
    });
    damagedMismatches += Number(
      damagedResult.candidates.map((candidate) => candidate.id).join("\0") !== expected,
    );
    let clock = 0;
    const timeout = applyLifecycleDeleteVacancy({
      candidates: item.candidates,
      materialize: item.materialize,
      policy: { ...DELETE_VACANCY_PROTOCOL.candidate, timeoutMs: 1 },
      source: item.vacancy,
      now: () => {
        clock += 2;
        return clock;
      },
    });
    timeoutMismatches += Number(timeout.candidates.map((candidate) => candidate.id).join("\0") !== expected);
  }
  return {
    cases: prepared.length,
    disabledMismatches,
    damagedMismatches,
    timeoutMismatches,
  };
}

export function evaluateDeleteVacancyGate(params: {
  fallback: ReturnType<typeof fallbackChecks>;
  maxOutputCandidates: number;
  nonForgettingHarmedCases: number;
  ordinaryFallbacks: number;
  primary: ReturnType<typeof subsetReport>;
}) {
  const gate = DELETE_VACANCY_PROTOCOL.proxyGate;
  const direct = params.primary.deleteVacancyVsV1;
  const checks = {
    evidenceFamaMagnitude:
      direct.evidenceFamaProxy.mean >= gate.minPrimaryEvidenceFamaProxyDelta,
    evidenceFamaUncertainty: !gate.requirePrimaryEvidenceFamaProxyCiLowerAboveZero
      || direct.evidenceFamaProxy.lower > 0,
    currentRecallDirection:
      direct.currentSessionRecall.mean >= gate.minPrimaryCurrentSessionRecallDelta,
    forgettingDirection:
      direct.forgettingAbsence.mean >= gate.minPrimaryForgettingAbsenceDelta,
    nonForgettingHarm:
      params.nonForgettingHarmedCases
        <= gate.maxQuarterlyCurrentStateNonForgettingHarmedCasesVsV1,
    tokenBudget:
      params.primary.meanInjectedTokenIncreaseFraction
        <= gate.maxMeanInjectedTokenIncreaseFractionVsV1 + 1e-12,
    candidateBudget: !gate.requireAtMostFiveCandidates
      || params.maxOutputCandidates <= DELETE_VACANCY_PROTOCOL.candidate.resultLimit,
    zeroOrdinaryFallbacks: !gate.requireZeroOrdinaryFallbacks || params.ordinaryFallbacks === 0,
    disabledBaseEquivalence: !gate.requireDisabledBaseEquivalence
      || params.fallback.disabledMismatches === 0,
    forcedFailureBaseFallback: !gate.requireForcedFailureBaseFallback
      || params.fallback.damagedMismatches + params.fallback.timeoutMismatches === 0,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

export async function runDeleteVacancy(
  options: DeleteVacancyRunOptions,
): Promise<Record<string, unknown>> {
  const prepared = await prepare(options);
  const v1 = prepared.cases.map(v1Result);
  const candidate = prepared.cases.map(candidateResult);
  const currentState = (item: DeleteVacancyCaseResult) => item.task !== "reasoning";
  const quarterly = (item: DeleteVacancyCaseResult) =>
    item.period === DELETE_VACANCY_PROTOCOL.split.heldOutProxyPeriod;
  const primaryPredicate = (item: DeleteVacancyCaseResult) =>
    quarterly(item) && currentState(item) && item.forgettingBearing;
  const nonForgettingPredicate = (item: DeleteVacancyCaseResult) =>
    quarterly(item) && currentState(item) && !item.forgettingBearing;
  const reports = {
    all: subsetReport({ candidate, v1, predicate: () => true, seedOffset: 0 }),
    developmentCurrentStateForgetting: subsetReport({
      candidate,
      v1,
      predicate: (item) => DELETE_VACANCY_PROTOCOL.split.developmentPeriods.includes(item.period)
        && currentState(item) && item.forgettingBearing,
      seedOffset: 100,
    }),
    primaryQuarterlyCurrentStateForgetting: subsetReport({
      candidate,
      v1,
      predicate: primaryPredicate,
      seedOffset: 200,
    }),
    quarterlyAll: subsetReport({ candidate, v1, predicate: quarterly, seedOffset: 300 }),
    quarterlyCurrentStateNonForgetting: subsetReport({
      candidate,
      v1,
      predicate: nonForgettingPredicate,
      seedOffset: 400,
    }),
    quarterlyReasoning: subsetReport({
      candidate,
      v1,
      predicate: (item) => quarterly(item) && !currentState(item),
      seedOffset: 500,
    }),
  };
  const fallback = fallbackChecks(prepared.cases);
  const ordinaryFallbacks = candidate.filter((item) => item.decision.mode === "fallback").length;
  const maxOutputCandidates = Math.max(...candidate.map((item) => item.candidateIds.length));
  const gate = evaluateDeleteVacancyGate({
    fallback,
    maxOutputCandidates,
    nonForgettingHarmedCases: reports.quarterlyCurrentStateNonForgetting.harmedCases,
    ordinaryFallbacks,
    primary: reports.primaryQuarterlyCurrentStateForgetting,
  });
  const decisions = {
    ordinaryFallbacks,
    maxOutputCandidates,
    meanOutputCandidates: mean(candidate.map((item) => item.candidateIds.length)),
    callsWithBackfill: candidate.filter((item) =>
      "backfilled" in item.decision && item.decision.backfilled > 0
    ).length,
    meanBackfilled: mean(candidate.map((item) =>
      "backfilled" in item.decision ? item.decision.backfilled : 0
    )),
    deletePredecessorsSkipped: candidate.reduce((sum, item) =>
      sum + ("deletePredecessorsSkipped" in item.decision
        ? item.decision.deletePredecessorsSkipped
        : 0), 0),
    deleteTombstonesSkipped: candidate.reduce((sum, item) =>
      sum + ("deleteTombstonesSkipped" in item.decision
        ? item.decision.deleteTombstonesSkipped
        : 0), 0),
  };
  const report = {
    status: gate.passed ? "passed" : "failed",
    nextAction: gate.passed ? "freeze_new_answer_panel" : "reject_candidate_and_continue_to_D4",
    protocol: DELETE_VACANCY_PROTOCOL,
    generatedAt: new Date().toISOString(),
    source: await sourceRevision(),
    dataset: prepared.dataset,
    integrity: {
      cases: prepared.cases.length,
      groups: prepared.groups.length,
      ledgerBuildFailures: prepared.groups.filter((item) => item.ledgerError).length,
      vacancyBuildFailures: prepared.groups.filter((item) => item.vacancyError).length,
    },
    reports,
    decisions,
    fallbackValidation: fallback,
    proxyGate: gate,
    caveats: [
      "The primary result is a direct evidence proxy, not answer-level FAMA.",
      "Event kinds come from released write-time operation metadata and never from evaluation labels.",
      "Quarterly is untouched by D3 policy fitting, but it belongs to the same public dataset used in earlier studies.",
      "A pass only permits a newly frozen answer panel that excludes prior answer-development cases.",
    ],
  };
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(
    path.join(options.outputDir, "cases.jsonl"),
    `${[...v1, ...candidate].map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}
