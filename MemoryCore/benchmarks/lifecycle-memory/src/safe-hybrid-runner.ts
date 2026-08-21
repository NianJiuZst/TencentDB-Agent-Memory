import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LifecycleResolver } from "../../../src/core/lifecycle/index.js";
import {
  baseResult,
  prepareAdaptiveData,
  sourceRevision,
  type AdaptiveRunOptions,
  type PreparedCase,
} from "./adaptive-runner.js";
import {
  contextualCase,
  V1_POLICY,
  type ContextualCaseResult,
  type ContextualLifecyclePolicy,
} from "./contextual-runner.js";
import { aggregate, pairedPersonaBootstrap } from "./metrics.js";
import { classifyLifecycleQueryIntent, type LifecycleQueryIntent } from "./query-intent.js";
import { SAFE_HYBRID_PROTOCOL } from "./safe-hybrid-protocol.js";
import type { BootstrapInterval } from "./types.js";

type Arm = "base" | "v1" | "safeHybrid";
type Metric = "evidenceFamaProxy" | "forgettingAbsence" | "currentSessionRecall";

interface SafeHybridCase extends Omit<ContextualCaseResult, "arm"> {
  arm: Arm;
}

interface FrozenSelection {
  protocolVersion: string;
  selected: Array<{
    caseId: string;
    comparatorCandidateIds: string[];
  }>;
}

export interface SafeHybridRunOptions extends AdaptiveRunOptions {
  frozenSelection: string;
}

export const SAFE_HYBRID_POLICY: ContextualLifecyclePolicy = {
  ...SAFE_HYBRID_PROTOCOL.policy,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameIds(left: Pick<SafeHybridCase, "candidateIds">, right: Pick<SafeHybridCase, "candidateIds">) {
  return left.candidateIds.join("\0") === right.candidateIds.join("\0");
}

function asBaseCase(prepared: PreparedCase): SafeHybridCase {
  return {
    ...baseResult(prepared),
    arm: "base",
    queryIntent: classifyLifecycleQueryIntent(prepared.question.query),
    action: "keep",
  };
}

export function safeHybridCase(params: {
  prepared: PreparedCase;
  policy?: ContextualLifecyclePolicy;
  resolver?: LifecycleResolver;
  now?: () => number;
}): SafeHybridCase {
  return {
    ...contextualCase({
      prepared: params.prepared,
      policy: params.policy ?? SAFE_HYBRID_POLICY,
      resolver: params.resolver,
      now: params.now,
    }),
    arm: "safeHybrid",
  };
}

function compare(
  left: SafeHybridCase[],
  right: SafeHybridCase[],
  seedOffset: number,
): Record<Metric, BootstrapInterval> {
  const metric = (name: Metric) => pairedPersonaBootstrap(
    left,
    right,
    (a, b) => a.metrics[name] - b.metrics[name],
    SAFE_HYBRID_PROTOCOL.evaluation.uncertainty.bootstrapSamples,
    SAFE_HYBRID_PROTOCOL.seed + seedOffset,
  );
  return {
    evidenceFamaProxy: metric("evidenceFamaProxy"),
    forgettingAbsence: metric("forgettingAbsence"),
    currentSessionRecall: metric("currentSessionRecall"),
  };
}

function subsetReport(params: {
  base: SafeHybridCase[];
  v1: SafeHybridCase[];
  safeHybrid: SafeHybridCase[];
  predicate: (item: SafeHybridCase) => boolean;
  seedOffset: number;
}) {
  const base = params.base.filter(params.predicate);
  const ids = new Set(base.map((item) => item.caseId));
  const v1 = params.v1.filter((item) => ids.has(item.caseId));
  const safeHybrid = params.safeHybrid.filter((item) => ids.has(item.caseId));
  return {
    base: aggregate(base),
    v1: aggregate(v1),
    safeHybrid: aggregate(safeHybrid),
    safeHybridVsBase: compare(safeHybrid, base, params.seedOffset),
    safeHybridVsV1: compare(safeHybrid, v1, params.seedOffset + 10),
  };
}

function routingEquivalence(
  base: SafeHybridCase[],
  v1: SafeHybridCase[],
  safeHybrid: SafeHybridCase[],
) {
  const baseById = new Map(base.map((item) => [item.caseId, item]));
  const v1ById = new Map(v1.map((item) => [item.caseId, item]));
  let historicalAggregateCases = 0;
  let historicalAggregateMismatches = 0;
  let otherCases = 0;
  let otherMismatches = 0;
  for (const item of safeHybrid) {
    if (item.queryIntent === "historical_aggregate") {
      historicalAggregateCases += 1;
      historicalAggregateMismatches += Number(!sameIds(item, baseById.get(item.caseId)!));
    } else {
      otherCases += 1;
      otherMismatches += Number(!sameIds(item, v1ById.get(item.caseId)!));
    }
  }
  return {
    historicalAggregateCases,
    historicalAggregateMismatches,
    otherCases,
    otherMismatches,
  };
}

function fallbackChecks(prepared: PreparedCase[]) {
  const disabled = { ...SAFE_HYBRID_POLICY, enabled: false };
  const damaged: LifecycleResolver = {
    resolveIds: () => {
      throw new Error("forced safe-hybrid resolver failure");
    },
  };
  let disabledMismatches = 0;
  let damagedMismatches = 0;
  let timeoutMismatches = 0;
  for (const entry of prepared) {
    const expected = baseResult(entry).candidateIds.join("\0");
    disabledMismatches += Number(
      safeHybridCase({ prepared: entry, policy: disabled }).candidateIds.join("\0") !== expected,
    );
    damagedMismatches += Number(
      safeHybridCase({ prepared: entry, resolver: damaged }).candidateIds.join("\0") !== expected,
    );
    let clock = 0;
    timeoutMismatches += Number(safeHybridCase({
      prepared: entry,
      policy: { ...SAFE_HYBRID_POLICY, timeoutMs: 1 },
      now: () => {
        clock += 2;
        return clock;
      },
    }).candidateIds.join("\0") !== expected);
  }
  return {
    cases: prepared.length,
    disabledMismatches,
    damagedMismatches,
    timeoutMismatches,
  };
}

async function frozenEquivalence(file: string, safeHybrid: SafeHybridCase[]) {
  const text = await readFile(file, "utf8");
  const hash = sha256(text);
  if (hash !== SAFE_HYBRID_PROTOCOL.frozenAnswerLevelSelection.selectionSha256) {
    throw new Error(`safe-hybrid frozen selection hash mismatch: ${hash}`);
  }
  const selection = JSON.parse(text) as FrozenSelection;
  if (selection.protocolVersion !== SAFE_HYBRID_PROTOCOL.frozenAnswerLevelSelection.protocolVersion) {
    throw new Error(`safe-hybrid frozen selection protocol mismatch: ${selection.protocolVersion}`);
  }
  if (selection.selected.length !== SAFE_HYBRID_PROTOCOL.frozenAnswerLevelSelection.cases) {
    throw new Error(`safe-hybrid frozen selection case count mismatch: ${selection.selected.length}`);
  }
  const safeById = new Map(safeHybrid.map((item) => [item.caseId, item]));
  const mismatchCaseIds = selection.selected.flatMap((entry) => {
    const current = safeById.get(entry.caseId);
    return current && current.candidateIds.join("\0") === entry.comparatorCandidateIds.join("\0")
      ? []
      : [entry.caseId];
  });
  const intents = selection.selected.map((entry) => safeById.get(entry.caseId)?.queryIntent ?? "missing");
  return {
    path: path.resolve(file),
    sha256: hash,
    cases: selection.selected.length,
    candidateMismatches: mismatchCaseIds.length,
    mismatchCaseIds,
    queryIntentCounts: Object.fromEntries([...new Set(intents)].sort().map((intent) => [
      intent,
      intents.filter((value) => value === intent).length,
    ])),
    priorV1AnswersReusable: mismatchCaseIds.length === 0,
  };
}

export async function runSafeHybrid(options: SafeHybridRunOptions): Promise<Record<string, any>> {
  const prepared = await prepareAdaptiveData(options);
  const base = prepared.cases.map(asBaseCase);
  const v1 = prepared.cases.map((entry): SafeHybridCase => ({
    ...contextualCase({ prepared: entry, policy: V1_POLICY, arm: "v1" }),
    arm: "v1",
  }));
  const safeHybrid = prepared.cases.map((entry) => safeHybridCase({ prepared: entry }));
  const routing = routingEquivalence(base, v1, safeHybrid);
  const fallback = fallbackChecks(prepared.cases);
  const frozen = await frozenEquivalence(options.frozenSelection, safeHybrid);
  const reports = {
    all: subsetReport({ base, v1, safeHybrid, predicate: () => true, seedOffset: 0 }),
    historicalAggregate: subsetReport({
      base,
      v1,
      safeHybrid,
      predicate: (item) => item.queryIntent === "historical_aggregate",
      seedOffset: 100,
    }),
    otherQueries: subsetReport({
      base,
      v1,
      safeHybrid,
      predicate: (item) => item.queryIntent !== "historical_aggregate",
      seedOffset: 200,
    }),
    byPeriod: Object.fromEntries(SAFE_HYBRID_PROTOCOL.evaluation.periods.map((period, index) => [
      period,
      subsetReport({
        base,
        v1,
        safeHybrid,
        predicate: (item) => item.period === period,
        seedOffset: 300 + index * 20,
      }),
    ])),
  };
  const v1Tokens = reports.all.v1.meanInjectedTokens;
  const safeTokens = reports.all.safeHybrid.meanInjectedTokens;
  const checks = {
    historicalAggregateExactBase: !SAFE_HYBRID_PROTOCOL.gate.requireHistoricalAggregateExactBase
      || routing.historicalAggregateMismatches === 0,
    otherQueriesExactV1: !SAFE_HYBRID_PROTOCOL.gate.requireOtherQueriesExactV1
      || routing.otherMismatches === 0,
    frozenSelectionExactV1: !SAFE_HYBRID_PROTOCOL.gate.requireFrozenSelectionExactV1
      || frozen.candidateMismatches === 0,
    allQuestionFamaNotBelowV1: !SAFE_HYBRID_PROTOCOL.gate.requireAllQuestionFamaNotBelowV1
      || reports.all.safeHybrid.evidenceFamaProxy >= reports.all.v1.evidenceFamaProxy,
    tokenBudget: safeTokens <= v1Tokens
      * (1 + SAFE_HYBRID_PROTOCOL.gate.maxMeanTokenIncreaseOverV1Fraction),
    disabledEquivalence: !SAFE_HYBRID_PROTOCOL.gate.requireDisabledEquivalence
      || fallback.disabledMismatches === 0,
    forcedFailureFallback: !SAFE_HYBRID_PROTOCOL.gate.requireForcedFailureFallback
      || (fallback.damagedMismatches === 0 && fallback.timeoutMismatches === 0),
  };
  const manifest = {
    protocolVersion: SAFE_HYBRID_PROTOCOL.protocolVersion,
    policy: SAFE_HYBRID_POLICY,
    cases: safeHybrid.map((item) => ({
      caseId: item.caseId,
      groupId: item.groupId,
      persona: item.persona,
      period: item.period,
      task: item.task,
      queryIntent: item.queryIntent,
      candidateIds: item.candidateIds,
    })),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: SAFE_HYBRID_PROTOCOL,
    generatedAt: new Date().toISOString(),
    source: await sourceRevision(),
    dataset: prepared.dataset,
    policy: SAFE_HYBRID_POLICY,
    reports,
    routingEquivalence: routing,
    frozenAnswerLevelEquivalence: frozen,
    fallbackValidation: fallback,
    contextManifest: { cases: manifest.cases.length, sha256: sha256(manifestJson) },
    diagnosticGate: { passed: Object.values(checks).every(Boolean), checks },
    caveats: [
      SAFE_HYBRID_PROTOCOL.developmentStatus,
      "The frozen 50-case answer-level sample contains no historical-aggregate query, so byte-equivalence transfers V1 scores but cannot validate the guard's answer-level behavior.",
      "Memora has no repository, branch, environment, or component scope labels; scope-aware behavior remains outside this public-data claim.",
    ],
  };
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "context-manifest.json"), manifestJson, "utf8");
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(options.outputDir, "cases.jsonl"),
    `${[...base, ...v1, ...safeHybrid].map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  return report;
}
